import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ServiceError } from '../../ServiceError.js';
import type { AgentProgressEvent, AgentRunRequest, AgentRunResult } from '../../../types/index.js';

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentRunError {
  code?: string;
  message: string;
}

export interface StoredAgentRun {
  id: string;
  clientId: string;
  request: AgentRunRequest;
  status: AgentRunStatus;
  events: AgentProgressEvent[];
  result?: AgentRunResult;
  error?: AgentRunError;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

interface AgentRunFile {
  version: 1;
  runs: Record<string, StoredAgentRun>;
}

const INTERRUPTED_MESSAGE = '服务已重启，请重新连接以继续任务。';
const DEDUPLICATED_SCRIPT_TASKS = new Set<AgentRunRequest['task']>([
  'script_series_outline',
  'script_bible',
  'script_episode_batch',
]);
const LONG_FORM_NOVEL_TASKS = new Set<AgentRunRequest['task']>(['full_novel', 'long_novel']);
const ACTIVE_STATUSES = new Set<AgentRunStatus>([
  'queued',
  'running',
  'retrying',
  'waiting_user',
]);
const TERMINAL_STATUSES = new Set<AgentRunStatus>(['completed', 'failed', 'cancelled']);

export class AgentRunConflictError extends ServiceError {
  constructor(
    readonly existingJobId: string,
    message: string,
  ) {
    super('CONFLICT', message);
    this.name = 'AgentRunConflictError';
    Object.setPrototypeOf(this, AgentRunConflictError.prototype);
  }
}

function batchRange(request: AgentRunRequest): { start: number; end: number } | undefined {
  const options = request.scriptBatchOptions;
  if (request.task !== 'script_episode_batch' || !options) return undefined;
  return {
    start: options.startEpisode,
    end: options.startEpisode + options.episodeCount - 1,
  };
}

export function requestsConflict(existing: AgentRunRequest, candidate: AgentRunRequest): boolean {
  if (existing.projectId !== candidate.projectId) return false;
  if (LONG_FORM_NOVEL_TASKS.has(candidate.task)) {
    return LONG_FORM_NOVEL_TASKS.has(existing.task);
  }
  if (!DEDUPLICATED_SCRIPT_TASKS.has(candidate.task) || existing.task !== candidate.task) {
    return false;
  }
  if (candidate.task !== 'script_episode_batch') return true;
  const existingRange = batchRange(existing);
  const candidateRange = batchRange(candidate);
  return Boolean(
    existingRange &&
    candidateRange &&
    existingRange.start <= candidateRange.end &&
    candidateRange.start <= existingRange.end,
  );
}

export function conflictMessage(request: AgentRunRequest): string {
  if (request.task === 'script_episode_batch') {
    return '同一项目已有集数范围重叠的短剧批次正在执行或等待恢复。';
  }
  if (LONG_FORM_NOVEL_TASKS.has(request.task)) {
    return '同一项目已有整本或长篇任务正在执行或等待恢复。';
  }
  return '同一项目已有相同短剧任务正在执行或等待恢复。';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class AgentRunStore {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly data: AgentRunFile,
  ) {}

  static async create(filePath: string): Promise<AgentRunStore> {
    let data: AgentRunFile = { version: 1, runs: {} };
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<AgentRunFile>;
      if (parsed.version === 1 && parsed.runs && typeof parsed.runs === 'object') {
        data = { version: 1, runs: parsed.runs };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }

    const store = new AgentRunStore(filePath, data);
    let recovered = false;
    const now = new Date().toISOString();
    for (const run of Object.values(data.runs)) {
      if (run.status === 'queued' || run.status === 'running' || run.status === 'retrying') {
        run.status = 'waiting_user';
        run.error = { code: 'RUN_INTERRUPTED', message: INTERRUPTED_MESSAGE };
        run.updatedAt = now;
        recovered = true;
      }
    }
    if (recovered) await store.persist();
    return store;
  }

  async create(
    clientId: string,
    request: AgentRunRequest,
    requestedId = randomUUID(),
  ): Promise<StoredAgentRun> {
    const conflict = Object.values(this.data.runs).find((run) =>
      run.clientId === clientId &&
      ACTIVE_STATUSES.has(run.status) &&
      requestsConflict(run.request, request),
    );
    if (conflict) {
      throw new AgentRunConflictError(conflict.id, conflictMessage(request));
    }

    const now = new Date().toISOString();
    if (this.data.runs[requestedId]) {
      throw new Error(`Agent run already exists: ${requestedId}`);
    }
    const run: StoredAgentRun = {
      id: requestedId,
      clientId,
      request: clone(request),
      status: 'queued',
      events: [],
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.data.runs[run.id] = run;
    await this.persist();
    return clone(run);
  }

  get(id: string): StoredAgentRun | undefined {
    const run = this.data.runs[id];
    return run ? clone(run) : undefined;
  }

  getForClient(clientId: string, id: string): StoredAgentRun | undefined {
    const run = this.data.runs[id];
    return run?.clientId === clientId ? clone(run) : undefined;
  }

  listForClient(clientId: string, projectId?: string): StoredAgentRun[] {
    return Object.values(this.data.runs)
      .filter((run) => run.clientId === clientId && (!projectId || run.request.projectId === projectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async deleteForProject(clientId: string, projectId: string): Promise<void> {
    for (const [id, run] of Object.entries(this.data.runs)) {
      if (run.clientId === clientId && run.request.projectId === projectId) {
        delete this.data.runs[id];
      }
    }
    await this.persist();
  }

  async appendEvent(id: string, event: AgentProgressEvent): Promise<StoredAgentRun> {
    return this.update(id, (run) => {
      run.events.push(clone(event));
    });
  }

  async markRunning(id: string): Promise<StoredAgentRun> {
    return this.update(id, (run) => {
      run.status = 'running';
      run.attempts += 1;
      delete run.error;
    });
  }

  async markQueued(id: string): Promise<StoredAgentRun> {
    return this.update(id, (run) => {
      run.status = 'queued';
      delete run.error;
    });
  }

  async markRetrying(id: string, error: AgentRunError): Promise<StoredAgentRun> {
    return this.update(id, (run) => {
      run.status = 'retrying';
      run.error = clone(error);
    });
  }

  async markWaiting(id: string, error: AgentRunError): Promise<StoredAgentRun> {
    return this.update(id, (run) => {
      run.status = 'waiting_user';
      run.error = clone(error);
    });
  }

  async bindRequestProjectId(id: string, projectId: string): Promise<StoredAgentRun> {
    const trimmed = projectId.trim();
    return this.update(id, (run) => {
      if (!trimmed || run.request.projectId === trimmed) return;
      run.request = { ...run.request, projectId: trimmed };
    });
  }

  async complete(id: string, result: AgentRunResult): Promise<StoredAgentRun> {
    return this.update(id, (run) => {
      if (run.status === 'cancelled') return;
      run.status = 'completed';
      run.result = clone(result);
      delete run.error;
    });
  }

  async fail(id: string, error: AgentRunError): Promise<StoredAgentRun> {
    return this.update(id, (run) => {
      if (TERMINAL_STATUSES.has(run.status)) return;
      run.status = 'failed';
      run.error = clone(error);
    });
  }

  async cancel(id: string): Promise<StoredAgentRun> {
    return this.update(id, (run) => {
      if (TERMINAL_STATUSES.has(run.status)) return;
      run.status = 'cancelled';
      run.error = { code: 'RUN_CANCELLED', message: '任务已停止。' };
    });
  }

  private async update(id: string, mutate: (run: StoredAgentRun) => void): Promise<StoredAgentRun> {
    const run = this.data.runs[id];
    if (!run) throw new Error(`Agent run not found: ${id}`);
    mutate(run);
    run.updatedAt = new Date().toISOString();
    await this.persist();
    return clone(run);
  }

  private async persist(): Promise<void> {
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, JSON.stringify(this.data, null, 2), 'utf8');
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }
}
