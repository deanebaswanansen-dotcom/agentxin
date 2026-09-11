import { randomUUID } from 'node:crypto';

import type { ModelConfig } from '../../../types/index.js';
import type {
  AgentProgressEvent,
  AgentRunExecutionContext,
  AgentRunRequest,
  AgentRunResult,
} from '../../../types/index.js';
import { runWithClientId } from '../../client/clientScope.js';
import { runWithRequestModelConfig } from '../../modelConfig/requestModelConfig.js';
import {
  AgentRunConflictError,
  conflictMessage,
  requestsConflict,
  type AgentRunError,
  type AgentRunStore,
  type StoredAgentRun,
} from './AgentRunStore.js';

interface AgentExecutor {
  run(
    request: AgentRunRequest,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
    context?: AgentRunExecutionContext,
  ): Promise<AgentRunResult>;
}

interface AgentJobRunnerOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  idleTimeoutMs?: number;
  maxAttemptDurationMs?: number;
  storageWriteTimeoutMs?: number;
}

const DEFAULT_JOB_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_JOB_MAX_ATTEMPT_DURATION_MS = 4 * 60 * 60 * 1000;
const DEFAULT_JOB_STORAGE_WRITE_TIMEOUT_MS = 5_000;

function boundedTimeout(value: number | undefined, environmentValue: string | undefined, fallback: number): number {
  const configured = value ?? Number(environmentValue);
  if (!Number.isFinite(configured) || configured <= 0) return fallback;
  return Math.min(24 * 60 * 60 * 1000, Math.max(1, Math.round(configured)));
}

function jobTimeoutError(kind: 'idle' | 'total', milliseconds: number): Error & { code: string; status: number } {
  const error = Object.assign(new Error(
    kind === 'total'
      ? `任务单次执行已达到最长 ${Math.ceil(milliseconds / 60_000)} 分钟，已安全停止，可继续任务。`
      : `任务超过 ${Math.ceil(milliseconds / 60_000)} 分钟没有进度，已安全停止，可继续任务。`,
  ), { code: 'RUN_TIMEOUT', status: 408 });
  error.name = 'AgentJobTimeoutError';
  return error;
}

function storageTimeoutError(operation: string, milliseconds: number): Error & { code: string; status: number } {
  const error = Object.assign(new Error(
    `${operation}超过 ${Math.ceil(milliseconds / 1_000)} 秒未保存，已停止本次操作，请重试。`,
  ), { code: 'RUN_STORAGE_TIMEOUT', status: 503 });
  error.name = 'AgentJobStorageTimeoutError';
  return error;
}

async function boundedStoreWrite<T>(
  write: Promise<T>,
  operation: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      write,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(storageTimeoutError(operation, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

function isRejectedCandidateCode(code: string | undefined): boolean {
  return code === 'SCRIPT_STRUCTURED_NEEDS_REVIEW' ||
    code === 'SCRIPT_MODEL_OUTPUT_INVALID' ||
    (typeof code === 'string' && code.endsWith('_NEEDS_REVIEW'));
}

function isRecoverableNeedsReview(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; recoverable?: unknown };
  if (typeof candidate.code !== 'string') return false;
  if (isRejectedCandidateCode(candidate.code)) return true;
  return candidate.recoverable === true && candidate.code.endsWith('_NEEDS_REVIEW');
}

function shouldResumeRejectedCandidates(run: StoredAgentRun): boolean {
  if (run.error?.code === 'RUN_INTERRUPTED') return false;
  if (!isRejectedCandidateCode(run.error?.code)) return false;
  if (run.status === 'waiting_user') return true;
  return run.request.task.startsWith('script_') &&
    (run.status === 'failed' || run.status === 'cancelled');
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

async function settleWrite<T>(
  write: Promise<T>,
  id: string,
  operation: string,
  timeoutMs = DEFAULT_JOB_STORAGE_WRITE_TIMEOUT_MS,
): Promise<void> {
  try {
    await boundedStoreWrite(write, operation, timeoutMs);
  } catch (error) {
    // The store has already updated its recoverable in-memory state. A
    // secondary persistence failure must not reject an unobserved background
    // task, and must not be reported as a successful durable write either.
    console.error('[AgentJobRunner] Job state was not durably saved', {
      jobId: id,
      operation,
      error: safeError(error),
    });
  }
}

export class AgentJobRunner {
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly resuming = new Map<string, {
    cancelled: boolean;
    promise: Promise<StoredAgentRun | undefined>;
  }>();

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
    const effectiveRequest: AgentRunRequest = request.regenerate
      ? { ...request, regenerationRunId: request.regenerationRunId ?? randomUUID() }
      : request;
    for (const [id] of this.active) {
      const existing = this.store.get(id);
      if (!existing || existing.clientId !== clientId) continue;
      if (requestsConflict(existing.request, effectiveRequest)) {
        throw new AgentRunConflictError(id, conflictMessage(effectiveRequest));
      }
    }
    const id = randomUUID();
    const storageWriteTimeoutMs = this.storageWriteTimeoutMs();
    let run: StoredAgentRun;
    try {
      run = await boundedStoreWrite(
        this.store.create(clientId, effectiveRequest, id),
        '创建任务',
        storageWriteTimeoutMs,
      );
    } catch (error) {
      // AgentRunStore mutates memory before persistence. If that first write
      // stalls or fails, make the reserved run terminal immediately so it
      // cannot become an invisible queued job that blocks every retry.
      if (this.store.get(id)) {
        await settleWrite(this.store.fail(id, safeError(error)), id, '保存创建失败状态', storageWriteTimeoutMs);
      }
      throw error;
    }
    this.launch(run.id, clientId, effectiveRequest, modelConfig);
    return run;
  }

  async resume(
    clientId: string,
    id: string,
    modelConfig: ModelConfig | undefined,
  ): Promise<StoredAgentRun | undefined> {
    const run = this.store.getForClient(clientId, id);
    if (!run) return undefined;
    const pending = this.resuming.get(id);
    if (pending) return pending.promise;
    const resumableScriptFailure =
      run.request.task.startsWith('script_') &&
      (run.status === 'failed' || run.status === 'cancelled');
    if (
      run.status === 'waiting_user' ||
      run.status === 'queued' ||
      run.status === 'retrying' ||
      resumableScriptFailure
    ) {
      if (!this.active.has(id)) {
        const context = shouldResumeRejectedCandidates(run)
          ? { resumeRejectedCandidates: true }
          : undefined;
        const reservation = {
          cancelled: false,
          promise: Promise.resolve<StoredAgentRun | undefined>(undefined),
        };
        this.resuming.set(id, reservation);
        // Persist the hand-off before launching. The HTTP resume response must
        // be pollable even though markRunning happens in the background task's
        // next microtask.
        const storageWriteTimeoutMs = this.storageWriteTimeoutMs();
        reservation.promise = (async () => {
          try {
            await boundedStoreWrite(
              this.store.markQueued(id),
              '恢复任务',
              storageWriteTimeoutMs,
            );
          } catch (error) {
            // A conflict never acquired the queued reservation. Cancellation
            // invalidates it too; neither may be overwritten by recovery.
            if (!(error instanceof AgentRunConflictError) && !reservation.cancelled) {
              await settleWrite(
                this.store.markWaiting(id, safeError(error)),
                id,
                '保存恢复失败状态',
                storageWriteTimeoutMs,
              );
            }
            throw error;
          }
          if (!reservation.cancelled) {
            this.launch(id, clientId, run.request, modelConfig, context);
          }
          return this.store.getForClient(clientId, id);
        })().finally(() => {
          if (this.resuming.get(id) === reservation) this.resuming.delete(id);
        });
        return reservation.promise;
      }
    }
    return this.store.getForClient(clientId, id);
  }

  async cancel(clientId: string, id: string): Promise<StoredAgentRun | undefined> {
    const run = this.store.getForClient(clientId, id);
    if (!run) return undefined;
    const pending = this.resuming.get(id);
    if (pending) pending.cancelled = true;
    const active = this.active.get(id);
    active?.controller.abort();
    // `cancel()` mutates the in-memory terminal state before persistence. Do
    // not let a broken filesystem keep the HTTP request or active slot open.
    await settleWrite(this.store.cancel(id), id, '保存取消状态', this.storageWriteTimeoutMs());
    await active?.promise;
    return this.store.getForClient(clientId, id);
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

  private storageWriteTimeoutMs(): number {
    return boundedTimeout(
      this.options.storageWriteTimeoutMs,
      process.env.AGENT_JOB_STORAGE_TIMEOUT_MS,
      DEFAULT_JOB_STORAGE_WRITE_TIMEOUT_MS,
    );
  }

  private launch(
    id: string,
    clientId: string,
    request: AgentRunRequest,
    modelConfig: ModelConfig | undefined,
    context?: AgentRunExecutionContext,
  ): void {
    if (this.active.has(id) || this.store.get(id)?.status !== 'queued') return;
    const controller = new AbortController();
    const ownsExecution = (): boolean => this.active.get(id)?.controller === controller;
    const promise = Promise.resolve()
      .then(async () => {
        const maxAttempts = this.options.maxAttempts ?? 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (!ownsExecution() || controller.signal.aborted) return;
          let progressWrites: Promise<void> = Promise.resolve();
          const attemptController = new AbortController();
          const idleTimeoutMs = boundedTimeout(
            this.options.idleTimeoutMs,
            process.env.AGENT_JOB_IDLE_TIMEOUT_MS,
            DEFAULT_JOB_IDLE_TIMEOUT_MS,
          );
          const maxAttemptDurationMs = boundedTimeout(
            this.options.maxAttemptDurationMs,
            process.env.AGENT_JOB_MAX_ATTEMPT_DURATION_MS,
            DEFAULT_JOB_MAX_ATTEMPT_DURATION_MS,
          );
          let acceptProgress = true;
          const canWriteAttempt = (): boolean => acceptProgress &&
            ownsExecution() && !controller.signal.aborted && !attemptController.signal.aborted;
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          let totalTimer: ReturnType<typeof setTimeout> | undefined;
          let rejectWatchdog!: (error: unknown) => void;
          const watchdog = new Promise<never>((_resolve, reject) => {
            rejectWatchdog = reject;
          });
          const forwardAbort = (): void => {
            const reason = controller.signal.reason ?? new DOMException('Aborted', 'AbortError');
            attemptController.abort(reason);
            if (!acceptProgress) return;
            acceptProgress = false;
            rejectWatchdog(reason);
          };
          if (controller.signal.aborted) forwardAbort();
          else controller.signal.addEventListener('abort', forwardAbort, { once: true });
          const stopForTimeout = (kind: 'idle' | 'total', milliseconds: number): void => {
            if (!acceptProgress) return;
            acceptProgress = false;
            const error = jobTimeoutError(kind, milliseconds);
            attemptController.abort(error);
            rejectWatchdog(error);
          };
          const touchWatchdog = (): void => {
            if (!acceptProgress || attemptController.signal.aborted) return;
            if (idleTimer !== undefined) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => stopForTimeout('idle', idleTimeoutMs), idleTimeoutMs);
            idleTimer.unref?.();
          };
          touchWatchdog();
          totalTimer = setTimeout(
            () => stopForTimeout('total', maxAttemptDurationMs),
            maxAttemptDurationMs,
          );
          totalTimer.unref?.();
          try {
            // Include the first durable running write in the watchdog. A
            // stalled write queue is still a stalled task from the user's
            // perspective and must release its active slot.
            await Promise.race([this.store.markRunning(id), watchdog]);
            if (!canWriteAttempt()) return;
            const latestRequest = this.store.get(id)?.request ?? request;
            const execution = runWithClientId(clientId, () =>
              runWithRequestModelConfig(modelConfig, () =>
                this.executor.run(latestRequest, attemptController.signal, (event) => {
                  if (!canWriteAttempt()) return;
                  touchWatchdog();
                  progressWrites = progressWrites.then(async () => {
                    if (!canWriteAttempt()) return;
                    if (typeof event.projectId === 'string' && event.projectId.trim().length > 0) {
                      await this.store.bindRequestProjectId(id, event.projectId);
                    }
                    if (!canWriteAttempt()) return;
                    await this.store.appendEvent(id, event);
                  });
                  // Observe rejected progress writes immediately, even while
                  // the executor remains pending or ignores its abort signal.
                  void progressWrites.catch((error: unknown) => {
                    if (!canWriteAttempt()) return;
                    acceptProgress = false;
                    attemptController.abort(error);
                    rejectWatchdog(error);
                  });
                }, context),
              ),
            ).then(async (result) => {
              // The watchdog also covers durable progress and completion
              // writes. A stuck storage promise must not leave the in-memory
              // run state reported as `running` forever.
              await progressWrites;
              if (!canWriteAttempt()) return result;
              if (result.projectId) await this.store.bindRequestProjectId(id, result.projectId);
              if (!canWriteAttempt()) return result;
              await this.store.complete(id, result);
              return result;
            });
            await Promise.race([execution, watchdog]);
            // Completion must never overtake a checkpoint/progress write. Apart
            // from preserving event order, this makes the latest resumable
            // script node durable before the job becomes completed.
            return;
          } catch (error) {
            let effectiveError = error;
            try {
              await Promise.race([progressWrites, watchdog]);
            } catch (progressError) {
              effectiveError = progressError;
            }
            // Cancellation wins over every recoverable/error classification.
            // Otherwise a late structured-output error can resurrect a job
            // that the user already cancelled as `waiting_user`.
            if (
              !ownsExecution() ||
              controller.signal.aborted ||
              this.store.get(id)?.status === 'cancelled'
            ) {
              throw effectiveError;
            }
            // A structured-contract mismatch is a resumable workflow state,
            // not a provider failure. Persist the checkpoint-facing pause and
            // let a later resume run the same request; the Director owns which
            // node can be reused or must be regenerated.
            if (isRecoverableNeedsReview(effectiveError)) {
              await Promise.race([
                this.store.markWaiting(id, safeError(effectiveError)),
                watchdog,
              ]);
              return;
            }
            if (
              controller.signal.aborted ||
              attempt >= maxAttempts ||
              !isRetryable(effectiveError)
            ) throw effectiveError;
            await Promise.race([
              this.store.markRetrying(id, safeError(effectiveError)),
              watchdog,
            ]);
            await delay(this.options.retryDelayMs ?? 1_000 * attempt, controller.signal);
          } finally {
            acceptProgress = false;
            if (idleTimer !== undefined) clearTimeout(idleTimer);
            if (totalTimer !== undefined) clearTimeout(totalTimer);
            controller.signal.removeEventListener('abort', forwardAbort);
          }
        }
      })
      .catch(async (error: unknown) => {
        if (!ownsExecution()) return;
        const current = this.store.get(id);
        if (!current || current.status === 'cancelled') return;
        if (controller.signal.aborted) {
          await settleWrite(this.store.cancel(id), id, '保存取消状态', this.storageWriteTimeoutMs());
          return;
        }
        await settleWrite(this.store.fail(id, safeError(error)), id, '保存执行失败状态', this.storageWriteTimeoutMs());
      })
      .finally(() => {
        if (ownsExecution()) this.active.delete(id);
      });
    this.active.set(id, { controller, promise });
  }
}
