import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemorySyncIntent, MemorySyncTarget } from '../../types/SourceMemory.js';
import { getCurrentClientId, runWithStoredClientId } from '../client/clientScope.js';
import { MemorySyncRunner, type MemorySyncStorePort, type SourceMemoryServicePort } from './MemorySyncRunner.js';
import { createFrozenMemoryProjection, projectSourceMemory } from './sourceMemoryContract.js';

const CLIENT_A = 'a'.repeat(64);
const CLIENT_B = 'b'.repeat(64);
const NOW = '2026-09-15T00:00:00.000Z';
const key = (clientId: string, projectId: string) => `${clientId}:${projectId}`;

function fixture() {
  const intents = new Map<string, MemorySyncIntent>();
  const projects = new Map<string, 'short_drama' | 'novel'>();
  const add = (clientId: string, projectId: string, status: MemorySyncIntent['status'] = 'pending', expiresAt?: string) => {
    const intent: MemorySyncIntent = {
      projection: createFrozenMemoryProjection({ clientId, projectId, mode: 'short_drama', revision: 1, acceptances: [] }),
      status, attempts: 0, createdAt: NOW, updatedAt: NOW,
      ...(expiresAt ? { lease: { token: 'old', owner: 'old', expiresAt } } : {}),
    };
    intents.set(key(clientId, projectId), intent);
    projects.set(key(clientId, projectId), 'short_drama');
    return intent;
  };
  const projectStore = {
    getProject: vi.fn(async (projectId: string) => {
      const kind = projects.get(key(getCurrentClientId(), projectId));
      return kind ? { id: projectId, name: projectId, kind, createdAt: NOW, updatedAt: NOW } : undefined;
    }),
  };
  const source: Required<MemorySyncStorePort> = {
    listMemorySyncTargets: vi.fn(async () => [...intents.values()].map(({ projection }): MemorySyncTarget => ({ clientId: projection.clientId, projectId: projection.projectId }))),
    getMemorySync: vi.fn(async (projectId) => structuredClone(intents.get(key(getCurrentClientId(), projectId)))),
    claimMemorySync: vi.fn(async (projectId, options) => {
      const intent = intents.get(key(getCurrentClientId(), projectId));
      if (!intent || intent.status === 'succeeded' || intent.status === 'stale' || (intent.status === 'failed' && !options.retryFailed) || (intent.status === 'running' && intent.lease && intent.lease.expiresAt > options.now)) return undefined;
      intent.status = 'running';
      intent.attempts += 1;
      intent.lease = { token: `${options.owner}:${intent.attempts}`, owner: options.owner, expiresAt: new Date(Date.parse(options.now) + options.leaseMs).toISOString() };
      return { clientId: getCurrentClientId(), projectId, revision: intent.projection.revision, idempotencyKey: intent.projection.idempotencyKey, lease: { ...intent.lease } };
    }),
    applyMemorySync: vi.fn(async (projectId, claim, write) => {
      const intent = intents.get(key(getCurrentClientId(), projectId));
      if (!intent || intent.lease?.token !== claim.lease.token) return undefined;
      try { await write(structuredClone(intent.projection)); intent.status = 'succeeded'; }
      catch { intent.status = 'failed'; intent.error = { code: 'SOURCE_MEMORY_SYNC_FAILED', message: '记忆同步失败，可重试。' }; }
      delete intent.lease;
      return structuredClone(intent);
    }),
  };
  const appliedScopes: string[] = [];
  const memory: SourceMemoryServicePort = {
    applySourceProjection: vi.fn(async () => { appliedScopes.push(getCurrentClientId()); }),
    querySourceMemory: vi.fn((projection, beforeUnit) => projectSourceMemory(projection, beforeUnit)),
  };
  const runner = (options = {}) => new MemorySyncRunner(projectStore, source, memory, { now: () => new Date(NOW), onBackgroundError: vi.fn(), ...options });
  return { add, intents, projects, projectStore, source, memory, appliedScopes, runner };
}

afterEach(() => vi.useRealTimers());

describe('MemorySyncRunner', () => {
  it('recovers pending and abandoned work for all stored clients without a model context', async () => {
    const f = fixture();
    const pending = f.add(CLIENT_A, 'pending');
    const abandoned = f.add(CLIENT_B, 'abandoned', 'running', '2026-09-14T00:00:00.000Z');
    f.add('local', 'local');
    f.add(CLIENT_A, 'live', 'running', '2026-09-16T00:00:00.000Z');
    f.add(CLIENT_A, 'failed', 'failed');
    f.add(CLIENT_A, 'deleted');
    f.projects.delete(key(CLIENT_A, 'deleted'));
    f.add(CLIENT_A, 'novel');
    f.projects.set(key(CLIENT_A, 'novel'), 'novel');
    await f.runner().scan();
    expect(f.appliedScopes).toEqual([CLIENT_A, CLIENT_B, 'local']);
    expect(pending.status).toBe('succeeded');
    expect(abandoned.status).toBe('succeeded');
  });

  it('uses the shared lease even when two independent runners race', async () => {
    const f = fixture();
    f.add(CLIENT_A, 'p');
    let release!: () => void;
    vi.mocked(f.memory.applySourceProjection).mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = f.runner({ owner: 'one' }).scan();
    await vi.waitFor(() => expect(f.memory.applySourceProjection).toHaveBeenCalledOnce());
    await f.runner({ owner: 'two' }).scan();
    expect(f.memory.applySourceProjection).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it('continues recovery after a damaged project even if its diagnostic callback fails', async () => {
    const f = fixture();
    f.add(CLIENT_A, 'damaged');
    const healthy = f.add(CLIENT_B, 'healthy');
    vi.mocked(f.source.getMemorySync).mockRejectedValueOnce(new Error('invalid project JSON'));
    const onBackgroundError = vi.fn(() => { throw new Error('diagnostic sink unavailable'); });
    const runner = f.runner({ onBackgroundError });
    await runner.scan();
    expect(onBackgroundError).toHaveBeenCalledOnce();
    expect(healthy.status).toBe('succeeded');
    expect(f.appliedScopes).toEqual([CLIENT_B]);
    await runner.scan();
    expect(f.intents.get(key(CLIENT_A, 'damaged'))!.status).toBe('succeeded');
  });

  it('leaves failed jobs stopped until an explicit scoped retry', async () => {
    const f = fixture();
    const intent = f.add(CLIENT_A, 'p');
    vi.mocked(f.memory.applySourceProjection).mockRejectedValueOnce(new Error('sensitive provider details'));
    const runner = f.runner();
    await runner.scan();
    await runner.scan();
    expect(intent.status).toBe('failed');
    expect(f.memory.applySourceProjection).toHaveBeenCalledOnce();
    const result = await runWithStoredClientId(CLIENT_A, () => runner.retry('p'));
    expect(result).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('blocks new claims and drains an already writing projection before project cleanup', async () => {
    const f = fixture();
    f.add(CLIENT_A, 'p');
    let release!: () => void;
    vi.mocked(f.memory.applySourceProjection).mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const runner = f.runner();
    const scan = runner.scan();
    await vi.waitFor(() => expect(f.memory.applySourceProjection).toHaveBeenCalledOnce());
    let drained = false;
    const deletion = runner.blockAndDrainProject(CLIENT_A, 'p').then(() => { drained = true; f.projects.delete(key(CLIENT_A, 'p')); });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([scan, deletion]);
    f.intents.get(key(CLIENT_A, 'p'))!.status = 'pending';
    await runner.scan();
    expect(f.memory.applySourceProjection).toHaveBeenCalledOnce();
    await expect(runWithStoredClientId(CLIENT_A, () => runner.retry('p'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('runs its startup pass and closes the timer without starting further work', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const runner = f.runner({ intervalMs: 100 });
    await runner.start();
    f.add('local', 'later');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.memory.applySourceProjection).toHaveBeenCalledOnce();
    await runner.close();
    f.add('local', 'after-close');
    await vi.advanceTimersByTimeAsync(500);
    expect(f.memory.applySourceProjection).toHaveBeenCalledOnce();
  });

  it('drains the fixed library when a deletion arrives with a browser client id', async () => {
    const f = fixture();
    f.add('local', 'p');
    let release!: () => void;
    vi.mocked(f.memory.applySourceProjection).mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const runner = f.runner({ fixedClientId: 'local' });
    const scan = runner.scan();
    await vi.waitFor(() => expect(f.memory.applySourceProjection).toHaveBeenCalledOnce());
    let drained = false;
    const deletion = runner.blockAndDrainProject(CLIENT_A, 'p').then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([scan, deletion]);
    f.intents.get(key('local', 'p'))!.status = 'pending';
    await runWithStoredClientId(CLIENT_A, () => runner.retry('p'));
    expect(f.memory.applySourceProjection).toHaveBeenCalledOnce();
  });

  it('queries the current frozen input while sync is pending and exposes legacy data honestly', async () => {
    const f = fixture();
    const intent = f.add(CLIENT_A, 'p');
    f.projects.set(key(CLIENT_A, 'legacy'), 'novel');
    const runner = f.runner();
    const result = await runWithStoredClientId(CLIENT_A, () => runner.query('p', 3));
    expect(f.memory.querySourceMemory).toHaveBeenCalledWith(intent.projection, 3);
    expect(result.memorySync.status).toBe('pending');
    expect(await runWithStoredClientId(CLIENT_A, () => runner.query('legacy', 2))).toMatchObject({ mode: 'novel', entries: [], memorySync: { status: 'legacy_untracked' } });
    await expect(runWithStoredClientId(CLIENT_A, () => runner.retry('legacy'))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(runWithStoredClientId(CLIENT_B, () => runner.getStatus('p'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an intent bound to another client even if the project id matches', async () => {
    const f = fixture();
    f.add(CLIENT_A, 'p');
    f.intents.get(key(CLIENT_A, 'p'))!.projection.clientId = CLIENT_B;
    await expect(runWithStoredClientId(CLIENT_A, () => f.runner().getStatus('p'))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.memory.applySourceProjection).not.toHaveBeenCalled();
  });
});
