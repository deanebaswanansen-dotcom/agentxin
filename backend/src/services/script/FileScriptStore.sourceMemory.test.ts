import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithClientId } from '../client/clientScope.js';
import { createFrozenMemoryProjection, hashSourceMemoryBlocks, projectSourceMemory } from '../memory/sourceMemoryContract.js';
import type { FrozenMemoryProjection } from '../../types/SourceMemory.js';
import type { ScriptEpisode, ScriptProjectState } from './domain.js';
import { FileScriptStore, createClientScopedScriptStore } from './FileScriptStore.js';
import { buildScriptAtomicCommitInput, buildScriptContinuityCandidate } from './ScriptContinuityCommit.js';
import type { ScriptStore } from './ScriptStore.js';

const projectId = 'memory-project';
function episode(unit = 1): ScriptEpisode {
  return {
    id: `episode-${unit}`, projectId, episodeNumber: unit, title: `第${unit}集`, outlineId: `outline-${unit}`,
    status: 'reviewing', targetChars: 100, revision: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    scenes: [{ id: `scene-${unit}`, ordinal: 1, location: '老宅', timeOfDay: 'day', interiorExterior: 'interior', characterIds: [],
      blocks: [{ id: `block-${unit}`, type: 'action', text: '😀沈清推开门。钥匙在盒子里。' },
        { id: `tail-${unit}`, type: 'action', text: '灯熄灭了。' }] }],
    summary: '沈清推开门。', newFacts: ['钥匙在盒子里', '国王已经死亡'], openedThreads: [], closedThreads: [],
  };
}
async function accept(store: ScriptStore, unit = 1) {
  let state = await store.getProjectState(projectId);
  if (!state) {
    await store.saveEpisode(episode(unit), 0);
    state = (await store.getProjectState(projectId))!;
  }
  const value = state.episodes.find((item) => item.episodeNumber === unit) ?? episode(unit);
  const input = buildScriptAtomicCommitInput(state, value, buildScriptContinuityCandidate(state, value), {
    promptVersion: 'source-memory-test', modelConfigFingerprint: 'deterministic',
  });
  return store.commitEpisodeWithContinuity!(input);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const claimOptions = () => ({ owner: 'test-worker', now: new Date().toISOString(), leaseMs: 60_000 });

describe('FileScriptStore accepted-source memory', () => {
  let root: string;
  let store: FileScriptStore;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'script-source-memory-')); store = await FileScriptStore.create(root); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  it('atomically freezes final blocks, exact UTF-16 citations, and a pending replacement with the existing commit id', async () => {
    const committed = await accept(store);
    const disk = JSON.parse(await readFile(join(root, `${projectId}.json`), 'utf8')) as ScriptProjectState;
    const frozen = disk.continuityCommits![0]!.memoryInput!;
    expect(frozen.source).toMatchObject({ acceptanceId: committed.continuity.id, revision: committed.episode.revision, clientId: 'local' });
    expect(frozen.source.contentHash).toBe(hashSourceMemoryBlocks(frozen.blocks));
    expect(committed.continuity.factsAdded[0]!.evidenceBlockIds).toEqual(['tail-1']);
    expect(frozen.entries.find((item) => item.text === '钥匙在盒子里')!.evidence).toEqual([
      { blockId: 'block-1', start: '😀沈清推开门。'.length, end: '😀沈清推开门。钥匙在盒子里'.length, quote: '钥匙在盒子里' },
    ]);
    expect(frozen.entries.find((item) => item.text === '国王已经死亡')!.evidence).toEqual([]);
    expect(disk.memorySync).toMatchObject({ status: 'pending', attempts: 0, projection: { revision: 1, acceptances: [frozen] } });
    const view = projectSourceMemory(disk.memorySync!.projection, 2);
    expect(view.entries.some((item) => item.text === '钥匙在盒子里')).toBe(true);
    expect(view.unverifiedReferences.some((item) => item.text === '国王已经死亡')).toBe(true);
    expect(projectSourceMemory(disk.memorySync!.projection, 1).entries).toEqual([]);
  });

  it('leaves no acceptance or outbox when the atomic rename fails', async () => {
    await store.saveEpisode(episode(), 0);
    const before = await readFile(join(root, `${projectId}.json`), 'utf8');
    vi.spyOn(store as unknown as { persist(state: ScriptProjectState): Promise<void> }, 'persist').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(accept(store)).rejects.toThrow('disk unavailable');
    expect(await readFile(join(root, `${projectId}.json`), 'utf8')).toBe(before);
    expect((await store.getProjectState(projectId))!.continuityCommits).toEqual([]);
    expect(await store.getMemorySync(projectId)).toBeUndefined();
  });

  it('withdraws the complete successor source chain in the same transaction as an earlier manual draft edit', async () => {
    await accept(store); await accept(store, 2);
    const old = (await store.getMemorySync(projectId))!;
    expect(old.projection.acceptances).toHaveLength(2);
    const first = (await store.getProjectState(projectId))!.episodes[0]!;
    await store.saveEpisode({ ...first, title: '手改中' }, first.revision);
    const next = (await store.getMemorySync(projectId))!;
    expect(next).toMatchObject({ status: 'pending', attempts: 0, projection: { revision: old.projection.revision + 1, acceptances: [] } });
    const disk = JSON.parse(await readFile(join(root, `${projectId}.json`), 'utf8')) as ScriptProjectState;
    expect(disk.episodes[0]!.status).toBe('reviewing');
    expect(disk.memorySync).toEqual(next);
    // The immutable historical source survives; only the effective replacement changes.
    expect(disk.continuityCommits![0]!.memoryInput).toEqual(old.projection.acceptances[0]);
    await accept(store);
    expect((await store.getMemorySync(projectId))!.projection.acceptances).toHaveLength(1);
  });

  it('replays the same frozen input after restart and never reads subsequently mutated caller objects', async () => {
    const committed = await accept(store);
    const original = (await store.getMemorySync(projectId))!.projection;
    committed.episode.scenes[0]!.blocks[0]!.text = 'caller mutation';
    committed.continuity.memoryInput!.entries[0]!.text = 'caller mutation';
    const restarted = await FileScriptStore.create(root);
    const claim = (await restarted.claimMemorySync(projectId, claimOptions()))!;
    let written: FrozenMemoryProjection | undefined;
    await restarted.applyMemorySync(projectId, claim, async (projection) => { written = projection; });
    expect(written).toEqual(original);
    expect((await restarted.getMemorySync(projectId))!.status).toBe('succeeded');
    expect(await restarted.claimMemorySync(projectId, claimOptions())).toBeUndefined();
  });

  it('claims once, reclaims an expired lease, and rejects the old owner without writing', async () => {
    await accept(store);
    const old = (await store.claimMemorySync(projectId, { ...claimOptions(), now: new Date(Date.now() - 2000).toISOString(), leaseMs: 1000 }))!;
    const fresh = (await store.claimMemorySync(projectId, claimOptions()))!;
    expect(fresh.lease.token).not.toBe(old.lease.token);
    expect(await store.claimMemorySync(projectId, claimOptions())).toBeUndefined();
    const write = vi.fn(async () => {});
    expect(await store.applyMemorySync(projectId, old, write)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect((await store.getMemorySync(projectId))!.attempts).toBe(2);
  });

  it.each(['revision', 'key', 'scope', 'expired'] as const)('does not apply a %s-mismatched claim', async (change) => {
    await accept(store);
    const claim = (await store.claimMemorySync(projectId, change === 'expired'
      ? { ...claimOptions(), now: new Date(Date.now() - 2000).toISOString(), leaseMs: 1000 } : claimOptions()))!;
    if (change === 'revision') claim.revision += 1;
    if (change === 'key') claim.idempotencyKey = 'wrong';
    if (change === 'scope') claim.clientId = 'a'.repeat(64);
    const write = vi.fn(async () => {});
    const before = await readFile(join(root, `${projectId}.json`), 'utf8');
    expect(await store.applyMemorySync(projectId, claim, write)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(join(root, `${projectId}.json`), 'utf8')).toBe(before);
  });

  it('replaces an old claim after a new acceptance, without applying an old projection', async () => {
    await accept(store);
    const old = (await store.claimMemorySync(projectId, claimOptions()))!;
    await accept(store, 2);
    const write = vi.fn(async () => {});
    expect(await store.applyMemorySync(projectId, old, write)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(await store.getMemorySync(projectId)).toMatchObject({ status: 'pending', attempts: 0, projection: { revision: 2 } });
  });

  it('keeps a failed synchronization separate from acceptance and requires explicit retry', async () => {
    await accept(store);
    const before = (await store.getProjectState(projectId))!;
    const claim = (await store.claimMemorySync(projectId, claimOptions()))!;
    const failed = (await store.applyMemorySync(projectId, claim, async () => { throw new Error('secret sk-private diagnostic'); }))!;
    expect(failed.status).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain('sk-private');
    expect((await store.getProjectState(projectId))!.episodes).toEqual(before.episodes);
    expect((await store.getProjectState(projectId))!.continuityCommits).toEqual(before.continuityCommits);
    expect(await store.claimMemorySync(projectId, claimOptions())).toBeUndefined();
    const retried = (await store.claimMemorySync(projectId, { ...claimOptions(), retryFailed: true }))!;
    expect(retried.idempotencyKey).toBe(claim.idempotencyKey);
    await store.applyMemorySync(projectId, retried, async () => {});
    expect(await store.getMemorySync(projectId)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('does not publish an ACK whose persistence failed, and permits idempotent replay after lease expiry', async () => {
    await accept(store);
    const claim = (await store.claimMemorySync(projectId, claimOptions()))!;
    const diskBefore = await readFile(join(root, `${projectId}.json`), 'utf8');
    vi.spyOn(store as unknown as { persist(state: ScriptProjectState): Promise<void> }, 'persist').mockRejectedValueOnce(new Error('ACK disk failed'));
    const write = vi.fn(async () => {});
    await expect(store.applyMemorySync(projectId, claim, write)).rejects.toThrow('ACK disk failed');
    expect(write).toHaveBeenCalledOnce();
    expect((await store.getMemorySync(projectId))!.status).toBe('running');
    expect(await readFile(join(root, `${projectId}.json`), 'utf8')).toBe(diskBefore);
    const retry = (await store.claimMemorySync(projectId, { ...claimOptions(), now: new Date(Date.parse(claim.lease.expiresAt) + 1).toISOString() }))!;
    await store.applyMemorySync(projectId, retry, write);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
  });

  it('serializes an in-flight local projection before an edit and queues a new replacement after it', async () => {
    await accept(store);
    const claim = (await store.claimMemorySync(projectId, claimOptions()))!;
    const first = (await store.getProjectState(projectId))!.episodes[0]!;
    const entered = deferred(); const release = deferred();
    const applying = store.applyMemorySync(projectId, claim, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    let edited = false;
    const editing = store.saveEpisode({ ...first, title: 'new' }, first.revision).then(() => { edited = true; });
    await Promise.resolve(); expect(edited).toBe(false);
    release.resolve(); await applying; await editing;
    expect(await store.getMemorySync(projectId)).toMatchObject({ status: 'pending', projection: { revision: 2, acceptances: [] } });
  });

  it('never recreates a deleted project on a late claim or ACK', async () => {
    await accept(store);
    const claim = (await store.claimMemorySync(projectId, claimOptions()))!;
    const entered = deferred(); const release = deferred();
    const applying = store.applyMemorySync(projectId, claim, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const deleting = store.deleteProject(projectId);
    release.resolve(); await applying; await deleting;
    const write = vi.fn(async () => {});
    expect(await store.applyMemorySync(projectId, claim, write)).toBeUndefined();
    expect(await store.claimMemorySync(projectId, claimOptions())).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('repairs a persisted intent after restart normalizes an invalidated source chain, before it can be claimed', async () => {
    await accept(store); await accept(store, 2);
    const path = join(root, `${projectId}.json`);
    const disk = JSON.parse(await readFile(path, 'utf8')) as ScriptProjectState;
    const oldRevision = disk.memorySync!.projection.revision;
    disk.episodes[0]!.revision += 1;
    await writeFile(path, JSON.stringify(disk), 'utf8');
    const restarted = await FileScriptStore.create(root);
    expect(await restarted.getMemorySync(projectId)).toMatchObject({ status: 'pending', projection: { revision: oldRevision + 1, acceptances: [] } });
    const repaired = JSON.parse(await readFile(path, 'utf8')) as ScriptProjectState;
    expect(repaired.memorySync!.projection.acceptances).toEqual([]);
    const claim = (await restarted.claimMemorySync(projectId, claimOptions()))!;
    expect(claim.revision).toBe(oldRevision + 1);
  });

  it('does not invent accepted memory from a legacy completed body or continuity delta', async () => {
    await accept(store);
    const path = join(root, `${projectId}.json`);
    const legacy = JSON.parse(await readFile(path, 'utf8')) as ScriptProjectState;
    delete legacy.memorySync; legacy.continuityCommits!.forEach((commit) => { delete commit.memoryInput; });
    await writeFile(path, JSON.stringify(legacy), 'utf8');
    const restarted = await FileScriptStore.create(root);
    expect(await restarted.getMemorySync(projectId)).toBeUndefined();
    expect(await restarted.listMemorySyncTargets()).toEqual([{ clientId: 'local', projectId }]);
    expect(await restarted.claimMemorySync(projectId, claimOptions())).toBeUndefined();
    await accept(restarted, 2);
    expect((await restarted.getMemorySync(projectId))!.projection.acceptances.map((item) => item.source.unitNumber)).toEqual([2]);
  });

  it('discovers pending work for all persisted clients including local and binds source/client scopes across restart', async () => {
    const scoped = createClientScopedScriptStore(root);
    const clientA = 'a'.repeat(64); const clientB = 'b'.repeat(64);
    await runWithClientId(clientA, () => accept(scoped));
    await runWithClientId(clientB, () => accept(scoped));
    await accept(scoped);
    await mkdir(join(root, 'invalid-client'));
    const restarted = createClientScopedScriptStore(root);
    expect(await restarted.listMemorySyncTargets!()).toEqual([
      { clientId: clientA, projectId }, { clientId: clientB, projectId }, { clientId: 'local', projectId },
    ]);
    const claimA = (await runWithClientId(clientA, () => restarted.claimMemorySync!(projectId, claimOptions())))!;
    const write = vi.fn(async () => {});
    expect(await runWithClientId(clientB, () => restarted.applyMemorySync!(projectId, claimA, write))).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect((await runWithClientId(clientB, () => restarted.getMemorySync!(projectId)))!.projection.acceptances[0]!.source.clientId).toBe(clientB);
  });

  it('isolates discovery from corrupt JSON files', async () => {
    await accept(store);
    await writeFile(join(root, 'broken.json'), '{broken', 'utf8');
    expect(await store.listMemorySyncTargets()).toEqual([
      { clientId: 'local', projectId: 'broken' }, { clientId: 'local', projectId },
    ]);
    expect(await store.claimMemorySync(projectId, claimOptions())).toBeDefined();
  });

  it.each(['body', 'acceptanceId', 'resourceId', 'revision', 'clientId'] as const)(
    'withdraws a source after restart detects a %s mismatch without freezing a replacement acceptance', async (change) => {
      await accept(store); await accept(store, 2);
      const path = join(root, `${projectId}.json`);
      const disk = JSON.parse(await readFile(path, 'utf8')) as ScriptProjectState;
      if (change === 'body') {
        // This old dialogue is normalized to action with a prefixed text while
        // its revision stays unchanged. Keep the original accepted block snapshot.
        disk.episodes[0]!.scenes[0]!.blocks[0] = { ...disk.episodes[0]!.scenes[0]!.blocks[0]!, type: 'dialogue', speaker: '特写' };
      } else if (change === 'revision') disk.continuityCommits![0]!.memoryInput!.source.revision += 1;
      else disk.continuityCommits![0]!.memoryInput!.source[change] = 'wrong';
      await writeFile(path, JSON.stringify(disk), 'utf8');
      const restarted = await FileScriptStore.create(root);
      expect((await restarted.getMemorySync(projectId))!.projection.acceptances).toEqual([]);
      const state = (await restarted.getProjectState(projectId))!;
      expect(state.continuityCommits).toHaveLength(2);
      expect(state.continuityCommits![0]!.status).toBe('stale');
    },
  );

  it('replaces a valid but mismatched intent payload even when its source refs are identical', async () => {
    await accept(store);
    const path = join(root, `${projectId}.json`);
    const disk = JSON.parse(await readFile(path, 'utf8')) as ScriptProjectState;
    const original = structuredClone(disk.continuityCommits![0]!.memoryInput!);
    const altered = structuredClone(original); altered.entries[0]!.text = 'changed projection entry';
    disk.memorySync!.projection = createFrozenMemoryProjection({ ...disk.memorySync!.projection, acceptances: [altered] });
    await writeFile(path, JSON.stringify(disk), 'utf8');
    const restarted = await FileScriptStore.create(root);
    const next = (await restarted.getMemorySync(projectId))!;
    expect(next.projection.revision).toBe(2);
    expect(next.projection.acceptances).toEqual([original]);
  });

  it('never treats an invalid persisted lease timestamp as a current owner', async () => {
    await accept(store);
    const old = (await store.claimMemorySync(projectId, claimOptions()))!;
    const path = join(root, `${projectId}.json`);
    const disk = JSON.parse(await readFile(path, 'utf8')) as ScriptProjectState;
    disk.memorySync!.lease!.expiresAt = 'invalid-date'; old.lease.expiresAt = 'invalid-date';
    await writeFile(path, JSON.stringify(disk), 'utf8');
    const restarted = await FileScriptStore.create(root);
    const write = vi.fn(async () => {});
    expect(await restarted.applyMemorySync(projectId, old, write)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(await restarted.claimMemorySync(projectId, claimOptions())).toBeDefined();
  });
});
