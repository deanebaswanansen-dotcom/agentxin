import type { ModelConfig } from '../../../types/index.js';
import type { AgentProgressEvent, AgentRunRequest, AgentRunResult } from '../../../types/index.js';
import { runWithClientId } from '../../client/clientScope.js';
import { runWithRequestModelConfig } from '../../modelConfig/requestModelConfig.js';
import type { AgentRunError, AgentRunStore, StoredAgentRun } from './AgentRunStore.js';

interface AgentExecutor {
  run(
    request: AgentRunRequest,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult>;
}

interface AgentJobRunnerOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

function safeError(error: unknown): AgentRunError {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : 'RUN_FAILED',
      message: typeof candidate.message === 'string'
        ? candidate.message
            .replace(/sk-[a-zA-Z0-9_-]{8,}/g, '[API_KEY]')
            .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [API_KEY]')
            .slice(0, 300)
        : '任务执行失败。',
    };
  }
  return { code: 'RUN_FAILED', message: '任务执行失败。' };
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; status?: unknown };
  if (typeof candidate.status === 'number') {
    return candidate.status === 429 || candidate.status === 500 || candidate.status === 502 ||
      candidate.status === 503 || candidate.status === 504;
  }
  return candidate.code === 'PROVIDER_ERROR';
}

function isRecoverableNeedsReview(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; recoverable?: unknown };
  if (candidate.code === 'SCRIPT_STRUCTURED_NEEDS_REVIEW') return true;
  return candidate.recoverable === true &&
    typeof candidate.code === 'string' &&
    candidate.code.endsWith('_NEEDS_REVIEW');
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class AgentJobRunner {
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  constructor(
    private readonly store: AgentRunStore,
    private readonly executor: AgentExecutor,
    private readonly options: AgentJobRunnerOptions = {},
  ) {}

  async start(
    clientId: string,
    request: AgentRunRequest,
    modelConfig: ModelConfig | undefined,
  ): Promise<StoredAgentRun> {
    const run = await this.store.create(clientId, request);
    this.launch(run.id, clientId, request, modelConfig);
    return run;
  }

  async resume(
    clientId: string,
    id: string,
    modelConfig: ModelConfig | undefined,
  ): Promise<StoredAgentRun | undefined> {
    const run = this.store.getForClient(clientId, id);
    if (!run) return undefined;
    const resumableScriptFailure =
      run.request.task.startsWith('script_') &&
      (run.status === 'failed' || run.status === 'cancelled');
    if (
      run.status === 'waiting_user' ||
      run.status === 'queued' ||
      run.status === 'retrying' ||
      resumableScriptFailure
    ) {
      this.launch(id, clientId, run.request, modelConfig);
    }
    return this.store.getForClient(clientId, id);
  }

  async cancel(clientId: string, id: string): Promise<StoredAgentRun | undefined> {
    const run = this.store.getForClient(clientId, id);
    if (!run) return undefined;
    this.active.get(id)?.controller.abort();
    return this.store.cancel(id);
  }

  async waitUntilIdle(id: string): Promise<void> {
    await this.active.get(id)?.promise;
  }

  async cancelForProject(clientId: string, projectId: string): Promise<void> {
    const activeIds = this.store
      .listForClient(clientId, projectId)
      .map((run) => run.id)
      .filter((id) => this.active.has(id));
    await Promise.all(activeIds.map((id) => this.cancel(clientId, id)));
    await Promise.all(activeIds.map((id) => this.waitUntilIdle(id)));
  }

  private launch(
    id: string,
    clientId: string,
    request: AgentRunRequest,
    modelConfig: ModelConfig | undefined,
  ): void {
    if (this.active.has(id)) return;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(async () => {
        const maxAttempts = this.options.maxAttempts ?? 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          await this.store.markRunning(id);
          let progressWrites: Promise<void> = Promise.resolve();
          try {
            const result = await runWithClientId(clientId, () =>
              runWithRequestModelConfig(modelConfig, () =>
                this.executor.run(request, controller.signal, (event) => {
                  progressWrites = progressWrites.then(async () => {
                    await this.store.appendEvent(id, event);
                  });
                }),
              ),
            );
            // Completion must never overtake a checkpoint/progress write. Apart
            // from preserving event order, this makes the latest resumable
            // script node durable before the job becomes completed.
            await progressWrites;
            await this.store.complete(id, result);
            return;
          } catch (error) {
            let effectiveError = error;
            try {
              await progressWrites;
            } catch (progressError) {
              effectiveError = progressError;
            }
            // A structured-contract mismatch is a resumable workflow state,
            // not a provider failure. Persist the checkpoint-facing pause and
            // let a later resume run the same request; the Director owns which
            // node can be reused or must be regenerated.
            if (isRecoverableNeedsReview(effectiveError)) {
              await this.store.markWaiting(id, safeError(effectiveError));
              return;
            }
            if (
              controller.signal.aborted ||
              attempt >= maxAttempts ||
              !isRetryable(effectiveError)
            ) throw effectiveError;
            await this.store.markRetrying(id, safeError(effectiveError));
            await delay(this.options.retryDelayMs ?? 1_000 * attempt, controller.signal);
          }
        }
      })
      .catch(async (error: unknown) => {
        const current = this.store.get(id);
        if (!current || current.status === 'cancelled') return;
        if (controller.signal.aborted) {
          await this.store.cancel(id);
          return;
        }
        await this.store.fail(id, safeError(error));
      })
      .finally(() => {
        this.active.delete(id);
      });
    this.active.set(id, { controller, promise });
  }
}
