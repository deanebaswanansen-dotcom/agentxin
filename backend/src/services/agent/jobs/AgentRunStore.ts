import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

  async create(clientId: string, request: AgentRunRequest): Promise<StoredAgentRun> {
    const now = new Date().toISOString();
    const run: StoredAgentRun = {
      id: randomUUID(),
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
      run.status = 'failed';
      run.error = clone(error);
    });
  }

  async cancel(id: string): Promise<StoredAgentRun> {
    return this.update(id, (run) => {
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
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(this.data, null, 2), 'utf8');
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }
}
