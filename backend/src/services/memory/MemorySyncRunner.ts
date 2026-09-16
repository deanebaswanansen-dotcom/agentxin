import { randomUUID } from 'node:crypto';
import type { DataStore } from '../../store/DataStore.js';
import type { FrozenMemoryProjection, MemorySyncClaim, MemorySyncIntent, MemorySyncStatusView, MemorySyncTarget, SourceMemoryMode, SourceMemoryView } from '../../types/SourceMemory.js';
import { getCurrentClientId, isValidClientId, runWithStoredClientId } from '../client/clientScope.js';
import { ServiceError } from '../ServiceError.js';

export interface MemorySyncStorePort {
  listMemorySyncTargets?(): Promise<MemorySyncTarget[]>;
  getMemorySync?(projectId: string): Promise<MemorySyncIntent | undefined>;
  claimMemorySync?(projectId: string, options: { owner: string; now: string; leaseMs: number; retryFailed?: boolean }): Promise<MemorySyncClaim | undefined>;
  applyMemorySync?(projectId: string, claim: MemorySyncClaim, write: (projection: FrozenMemoryProjection) => Promise<void>): Promise<MemorySyncIntent | undefined>;
}

export interface SourceMemoryServicePort {
  applySourceProjection(projection: FrozenMemoryProjection): Promise<void>;
  querySourceMemory(projection: FrozenMemoryProjection, beforeUnit: number): SourceMemoryView;
}

export interface MemorySyncRunnerOptions {
  /** Novel and screenplay intents live with their own atomic accepted documents. */
  novelSource?: MemorySyncStorePort;
  /** Server-selected scope for a concrete single-library store; never inferred from an intent. */
  fixedClientId?: string;
  intervalMs?: number;
  leaseMs?: number;
  owner?: string;
  now?: () => Date;
  onBackgroundError?: () => void;
}

export type SourceMemoryQueryResult = SourceMemoryView & { memorySync: MemorySyncStatusView };

const targetKey = ({ clientId, projectId }: MemorySyncTarget) => JSON.stringify([clientId, projectId]);

/**
 * Replays accepted projections without a model or captured BYOK configuration.
 * The store's durable lease is authoritative; these maps only coalesce local work.
 * File stores serialize one process. Shared-directory multi-process writers require an external lock.
 */
export class MemorySyncRunner {
  private readonly active = new Map<string, Promise<MemorySyncIntent | undefined>>();
  private readonly blocked = new Set<string>();
  private readonly owner: string;
  private timer?: ReturnType<typeof setInterval>;
  private scanning?: Promise<void>;
  private started = false;
  private closed = false;

  constructor(
    private readonly projects: Pick<DataStore, 'getProject'>,
    private readonly source: MemorySyncStorePort,
    private readonly memory: SourceMemoryServicePort,
    private readonly options: MemorySyncRunnerOptions = {},
  ) { this.owner = options.owner ?? randomUUID(); }

  private reportBackgroundError(): void {
    // A reporting callback must not interrupt recovery of the next project.
    try {
      if (this.options.onBackgroundError) this.options.onBackgroundError();
      else console.error('[MemorySyncRunner] Source memory synchronization could not finish.');
    } catch { /* Recovery remains independent of the diagnostic sink. */ }
  }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    await this.scan();
    if (this.closed) return;
    this.timer = setInterval(() => { void this.scan(); }, Math.max(1, this.options.intervalMs ?? 30_000));
    this.timer.unref?.();
  }

  scan(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.scanning) return this.scanning;
    const scan = (async () => {
      try {
        const targets = new Map<string, MemorySyncTarget>();
        for (const source of [this.source, this.options.novelSource]) {
          try {
            for (const target of await source?.listMemorySyncTargets?.() ?? []) targets.set(targetKey(target), target);
          } catch { this.reportBackgroundError(); }
        }
        for (const target of targets.values()) {
          if (this.closed) break;
          if (target.clientId !== 'local' && !isValidClientId(target.clientId)) continue;
          try { await this.runTarget(target); }
          catch { this.reportBackgroundError(); }
        }
      } catch { this.reportBackgroundError(); }
    })();
    this.scanning = scan;
    void scan.then(() => { if (this.scanning === scan) this.scanning = undefined; });
    return scan;
  }

  private sourceFor(mode: SourceMemoryMode): MemorySyncStorePort | undefined {
    return mode === 'short_drama' ? this.source : this.options.novelSource;
  }

  private assertScope(intent: MemorySyncIntent, target: MemorySyncTarget, mode: SourceMemoryMode): void {
    const projection = intent.projection;
    if (projection.clientId !== target.clientId || projection.projectId !== target.projectId || projection.mode !== mode) {
      throw ServiceError.conflict('记忆同步来源与当前项目不匹配。');
    }
  }

  private runTarget(target: MemorySyncTarget, retryFailed = false): Promise<MemorySyncIntent | undefined> {
    if (this.options.fixedClientId !== undefined && target.clientId !== this.options.fixedClientId) return Promise.resolve(undefined);
    const key = targetKey(target);
    if (this.closed || this.blocked.has(key)) return Promise.resolve(undefined);
    const existing = this.active.get(key);
    if (existing) return existing;
    const execution = runWithStoredClientId(target.clientId, async () => {
      const project = await this.projects.getProject(target.projectId);
      if (!project || this.blocked.has(key) || this.closed) return undefined;
      const mode = project.kind === 'short_drama' ? 'short_drama' : 'novel';
      const source = this.sourceFor(mode);
      const intent = await source?.getMemorySync?.(target.projectId);
      if (!intent) return undefined;
      this.assertScope(intent, target, mode);
      if (this.blocked.has(key) || this.closed) return undefined;
      const claim = await source?.claimMemorySync?.(target.projectId, {
        owner: this.owner,
        now: (this.options.now?.() ?? new Date()).toISOString(),
        leaseMs: Math.max(1, this.options.leaseMs ?? 60_000),
        retryFailed,
      });
      if (!claim) return undefined;
      if (claim.clientId !== target.clientId || claim.projectId !== target.projectId) throw ServiceError.conflict('记忆同步租约与当前项目不匹配。');
      return source?.applyMemorySync?.(target.projectId, claim, async (projection) => {
        if (this.blocked.has(key)) throw ServiceError.conflict('项目正在删除，记忆同步已停止。');
        const currentProject = await this.projects.getProject(target.projectId);
        if (!currentProject || (currentProject.kind === 'short_drama' ? 'short_drama' : 'novel') !== mode) throw ServiceError.notFound('记忆同步项目不存在。');
        if (projection.clientId !== target.clientId || projection.projectId !== target.projectId || projection.mode !== mode || projection.revision !== claim.revision || projection.idempotencyKey !== claim.idempotencyKey) {
          throw ServiceError.conflict('记忆同步投影与租约不匹配。');
        }
        await this.memory.applySourceProjection(projection);
      });
    });
    this.active.set(key, execution);
    const cleanup = () => { if (this.active.get(key) === execution) this.active.delete(key); };
    void execution.then(cleanup, cleanup);
    return execution;
  }

  /** Called before deleting auxiliary data: prevent new claims, then drain the current write. */
  async blockAndDrainProject(clientId: string, projectId: string): Promise<void> {
    const key = targetKey({ clientId: this.options.fixedClientId ?? clientId, projectId });
    this.blocked.add(key);
    await this.active.get(key)?.catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.scanning;
    await Promise.allSettled([...this.active.values()]);
  }

  private async readCurrent(projectId: string): Promise<{ mode: SourceMemoryMode; intent?: MemorySyncIntent }> {
    const project = await this.projects.getProject(projectId);
    if (!project) throw ServiceError.notFound('项目不存在。');
    const mode: SourceMemoryMode = project.kind === 'short_drama' ? 'short_drama' : 'novel';
    const intent = await this.sourceFor(mode)?.getMemorySync?.(projectId);
    if (intent) this.assertScope(intent, { clientId: getCurrentClientId(), projectId }, mode);
    return { mode, intent };
  }

  async getStatus(projectId: string): Promise<MemorySyncStatusView> {
    return this.inRequestScope(async () => {
      const { mode, intent } = await this.readCurrent(projectId);
      return this.statusView(mode, intent);
    });
  }

  private inRequestScope<T>(operation: () => Promise<T>): Promise<T> {
    return runWithStoredClientId(this.options.fixedClientId ?? getCurrentClientId(), operation);
  }

  private statusView(mode: SourceMemoryMode, intent?: MemorySyncIntent): MemorySyncStatusView {
    return {
      mode, status: intent?.status ?? 'legacy_untracked', revision: intent?.projection.revision ?? 0,
      attempts: intent?.attempts ?? 0, acceptedSources: intent?.projection.acceptances.length ?? 0,
      ...(intent?.error ? { error: { code: 'SOURCE_MEMORY_SYNC_FAILED', message: '记忆同步失败，可重试。' } as const } : {}),
    };
  }

  async retry(projectId: string): Promise<MemorySyncStatusView> {
    return this.inRequestScope(async () => {
      const { mode } = await this.readCurrent(projectId);
      if (!this.sourceFor(mode)?.applyMemorySync) throw ServiceError.validation('当前存储不支持接受来源记忆同步。');
      await this.runTarget({ clientId: getCurrentClientId(), projectId }, true);
      return this.getStatus(projectId);
    });
  }

  async query(projectId: string, beforeUnit: number): Promise<SourceMemoryQueryResult> {
    const { projection: _projection, ...view } = await this.queryContext(projectId, beforeUnit);
    return view;
  }

  /** Internal workbench/retrieval snapshot. Routes never expose every frozen body. */
  async queryContext(projectId: string, beforeUnit: number): Promise<SourceMemoryQueryResult & { projection?: FrozenMemoryProjection }> {
    if (!Number.isSafeInteger(beforeUnit) || beforeUnit < 1) throw ServiceError.validation('beforeUnit必须是大于0的整数。');
    return this.inRequestScope(async () => {
      const { mode, intent } = await this.readCurrent(projectId);
      const memorySync = this.statusView(mode, intent);
      if (!intent) return { mode, projectId, beforeUnit, projectionRevision: 0, origin: 'accepted_sources', memorySync, entries: [], unverifiedReferences: [] };
      return { ...this.memory.querySourceMemory(intent.projection, beforeUnit), memorySync, projection: intent.projection };
    });
  }
}
