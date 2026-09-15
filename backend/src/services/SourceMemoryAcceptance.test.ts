import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../index.js';
import { createClientScopedDataStore } from '../store/ClientScopedDataStore.js';
import { createClientScopedMemoryStore } from '../store/ClientScopedAuxiliaryStores.js';
import { runWithStoredClientId } from './client/clientScope.js';
import { MemoryService } from './memory/MemoryService.js';
import { MemoryStore } from './memory/MemoryStore.js';
import { FileScriptStore, createClientScopedScriptStore } from './script/FileScriptStore.js';
import { buildScriptAtomicCommitInput } from './script/ScriptContinuityCommit.js';
import type { ScriptEpisode, ScriptProjectState } from './script/domain.js';

/** Exercises both actual persistence boundaries. Faults intercept disk writes,
 * never the public acceptance/projection implementation. No model is constructed. */
describe('accepted screenplay → durable source memory recovery', () => {
  let directory: string;
  let scriptDirectory: string;
  let memoryFile: string;
  let script: FileScriptStore;
  let memoryStore: MemoryStore;
  let memory: MemoryService;
  const projectId = 'source-recovery';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'source-memory-acceptance-'));
    scriptDirectory = join(directory, 'scripts');
    memoryFile = join(directory, 'memory.json');
    await reopen();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function reopen(): Promise<void> {
    script = await FileScriptStore.create(scriptDirectory);
    memoryStore = await MemoryStore.create(memoryFile);
    memory = new MemoryService(memoryStore);
  }
  function draft(number = 1): ScriptEpisode {
    return {
      id: `episode-${number}`, projectId, episodeNumber: number, title: `第${number}集`,
      outlineId: `outline-${number}`, status: 'reviewing', targetChars: 300,
      scenes: [{ id: `scene-${number}`, ordinal: 1, location: '门外', timeOfDay: 'day',
        interiorExterior: 'exterior', characterIds: [],
        blocks: [{ id: `block-${number}`, type: 'action', text: `第${number}集的钥匙留在门外。` }] }],
      summary: `第${number}集的钥匙留在门外。`, newFacts: [`第${number}集的钥匙留在门外。`],
      openedThreads: [], closedThreads: [], revision: 0,
      createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    };
  }
  async function prepare(number = 1) {
    const episode = await script.saveEpisode(draft(number), 0);
    const state = (await script.getProjectState(projectId))!;
    return buildScriptAtomicCommitInput(state, episode, {
      characterUpdates: [], props: [], threads: [], timelineEvents: [], nextEpisodeMustInherit: [],
      factsAdded: [{ factId: `key-${number}`, text: episode.newFacts[0]!, evidenceBlockIds: [`block-${number}`] }],
    }, { promptVersion: 'manual-source-acceptance', modelConfigFingerprint: 'no-model' });
  }
  async function accept(number = 1) {
    return script.commitEpisodeWithContinuity(await prepare(number));
  }
  async function claim(now = new Date().toISOString(), retryFailed = false) {
    const result = await script.claimMemorySync(projectId, { owner: 'acceptance-worker', now, leaseMs: 60_000, retryFailed });
    expect(result).toBeDefined();
    return result!;
  }
  function failNextScriptWrite() {
    // Deliberately intercept a private persistence boundary without introducing
    // production fault switches. The next store instance reads the real disk.
    return vi.spyOn(script as unknown as { persist(state: ScriptProjectState): Promise<void> }, 'persist')
      .mockRejectedValueOnce(new Error('injected disk failure'));
  }

  it('publishes neither completed body nor sync intent if atomic acceptance cannot persist', async () => {
    const input = await prepare();
    const before = await readFile(join(scriptDirectory, `${projectId}.json`), 'utf8');
    failNextScriptWrite();
    await expect(script.commitEpisodeWithContinuity(input)).rejects.toThrow();
    expect(await readFile(join(scriptDirectory, `${projectId}.json`), 'utf8')).toBe(before);
    await reopen();
    expect((await script.getProjectState(projectId))!.episodes[0]!.status).toBe('reviewing');
    expect(await script.getMemorySync(projectId)).toBeUndefined();
  });

  it('recovers the frozen accepted input after restart and does not reinterpret the body', async () => {
    const accepted = await accept();
    const frozen = (await script.getMemorySync(projectId))!.projection;
    await reopen();
    expect((await script.getMemorySync(projectId))!.projection).toEqual(frozen);
    await script.applyMemorySync(projectId, await claim(), (projection) => memory.applySourceProjection(projection));
    await reopen();
    const intent = (await script.getMemorySync(projectId))!;
    expect(intent.status).toBe('succeeded');
    expect(intent.projection).toEqual(frozen);
    expect((await script.getProjectState(projectId))!.episodes[0]).toEqual(accepted.episode);
    const view = memory.querySourceMemory(intent.projection, 2);
    expect(view.origin).toBe('projection');
    expect(view.entries.some((entry) => entry.text === '第1集的钥匙留在门外。')).toBe(true);
    expect(view.entries.every((entry) => entry.source.acceptanceId === accepted.continuity.id)).toBe(true);
  });

  it('retains accepted body after projection failure and explicitly retries without raw error leakage', async () => {
    const accepted = await accept();
    await script.applyMemorySync(projectId, await claim(), async () => { throw new Error('private provider diagnostics'); });
    await reopen();
    expect((await script.getProjectState(projectId))!.episodes[0]).toEqual(accepted.episode);
    const failed = (await script.getMemorySync(projectId))!;
    expect(failed.status).toBe('failed');
    expect(JSON.stringify(failed.error)).not.toContain('private provider diagnostics');
    expect(await script.claimMemorySync(projectId, { owner: 'poll', now: new Date().toISOString(), leaseMs: 60_000 })).toBeUndefined();
    await script.applyMemorySync(projectId, await claim(undefined, true), (projection) => memory.applySourceProjection(projection));
    expect((await script.getMemorySync(projectId))!.status).toBe('succeeded');
  });

  it('replays idempotently when memory persisted but its success ACK did not', async () => {
    await accept();
    const first = await claim();
    failNextScriptWrite();
    await expect(script.applyMemorySync(projectId, first, (projection) => memory.applySourceProjection(projection))).rejects.toThrow();
    await reopen();
    const interrupted = (await script.getMemorySync(projectId))!;
    expect(interrupted.status).toBe('running');
    const before = memory.querySourceMemory(interrupted.projection, 2);
    const retryTime = new Date(Date.parse(first.lease.expiresAt) + 1).toISOString();
    await script.applyMemorySync(projectId, await claim(retryTime), (projection) => memory.applySourceProjection(projection));
    await reopen();
    const recovered = (await script.getMemorySync(projectId))!;
    expect(recovered.status).toBe('succeeded');
    expect(memory.querySourceMemory(recovered.projection, 2)).toEqual(before);
    expect((await script.getProjectState(projectId))!.continuityCommits).toHaveLength(1);
  });

  it('uses current accepted sources after an upstream edit and ignores a late old worker', async () => {
    const first = await accept();
    await accept(2);
    const oldClaim = await claim();
    await script.applyMemorySync(projectId, oldClaim, (projection) => memory.applySourceProjection(projection));
    const edited = structuredClone(first.episode);
    edited.scenes[0]!.blocks[0]!.text = '作者改写：钥匙从未出现。';
    await script.saveEpisode(edited, first.episode.revision);
    const current = (await script.getMemorySync(projectId))!;
    expect(current.status).toBe('pending');
    const view = memory.querySourceMemory(current.projection, 3);
    expect(view.origin).toBe('accepted_sources');
    expect(view.entries).toEqual([]);
    expect(view.unverifiedReferences).toEqual([]);
    const lateWrite = vi.fn();
    await script.applyMemorySync(projectId, oldClaim, lateWrite);
    expect(lateWrite).not.toHaveBeenCalled();
    await script.applyMemorySync(projectId, await claim(), (projection) => memory.applySourceProjection(projection));
    await reopen();
    expect(memory.querySourceMemory((await script.getMemorySync(projectId))!.projection, 3).entries).toEqual([]);
  });

  it('serializes project deletion with in-flight persistence and blocks subsequent resurrection', async () => {
    await accept();
    const oldClaim = await claim();
    const frozen = (await script.getMemorySync(projectId))!.projection;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const syncing = script.applyMemorySync(projectId, oldClaim, async (projection) => {
      entered();
      await gate;
      await memory.applySourceProjection(projection);
    });
    await started;
    const deleting = script.deleteProject(projectId).then(() => memory.clearProject(projectId));
    release();
    await Promise.all([syncing, deleting]);
    await reopen();
    expect(await script.getProjectState(projectId)).toBeUndefined();
    const lateWrite = vi.fn();
    await script.applyMemorySync(projectId, oldClaim, lateWrite);
    expect(lateWrite).not.toHaveBeenCalled();
    await expect(memory.applySourceProjection(frozen)).rejects.toThrow();
    expect(await script.getProjectState(projectId)).toBeUndefined();
    await expect(readFile(join(scriptDirectory, `${projectId}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('wires restart recovery, client isolation and deletion through the real server without a model', async () => {
    const projectsDirectory = join(directory, 'clients', 'projects');
    const scriptsDirectory = join(directory, 'clients', 'scripts');
    const memoriesDirectory = join(directory, 'clients', 'memory');
    let projects = createClientScopedDataStore(projectsDirectory);
    let scripts = createClientScopedScriptStore(scriptsDirectory);
    const clients = ['a'.repeat(64), 'b'.repeat(64), 'local'];
    const ids: string[] = [];
    for (const clientId of clients) {
      ids.push(await runWithStoredClientId(clientId, async () => {
        const project = await projects.createProject('离线恢复验收', 'short_drama');
        const episode = await scripts.saveEpisode({ ...draft(), projectId: project.id }, 0);
        const state = (await scripts.getProjectState(project.id))!;
        await scripts.commitEpisodeWithContinuity!(buildScriptAtomicCommitInput(state, episode, {
          characterUpdates: [], props: [], threads: [], timelineEvents: [], nextEpisodeMustInherit: [],
          factsAdded: [{ factId: 'key', text: episode.newFacts[0]!, evidenceBlockIds: ['block-1'] }],
        }, { promptVersion: 'manual-source-acceptance', modelConfigFingerprint: 'no-model' }));
        expect((await scripts.getMemorySync!(project.id))!.status).toBe('pending');
        return project.id;
      }));
    }
    // Construct entirely new store instances before the real onReady hook scans disk.
    projects = createClientScopedDataStore(projectsDirectory);
    scripts = createClientScopedScriptStore(scriptsDirectory);
    const scopedMemory = new MemoryService(await createClientScopedMemoryStore(memoriesDirectory));
    const modelCall = vi.fn(() => { throw new Error('source sync must never invoke a model'); });
    const app = buildServer(projects, { streamCompletion: modelCall }, scopedMemory,
      undefined, undefined, undefined, undefined, scripts);
    try {
      await app.ready();
      for (const [index, clientId] of clients.entries()) {
        const headers = clientId === 'local' ? {} : { 'x-agentxin-client-id': clientId };
        const response = await app.inject({ url: `/api/projects/${ids[index]}/source-memory?beforeUnit=2`, headers });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ origin: 'projection', memorySync: { status: 'succeeded', acceptedSources: 1 } });
        expect(response.json().entries.every((entry: { source: { clientId: string; projectId: string } }) =>
          entry.source.clientId === clientId && entry.source.projectId === ids[index])).toBe(true);
      }
      const headers = { 'x-agentxin-client-id': clients[0]! };
      const denied = await app.inject({ url: `/api/projects/${ids[1]}/memory-sync`, headers });
      expect(denied.statusCode).toBe(404);
      const frozen = await runWithStoredClientId(clients[0]!, async () => (await scripts.getMemorySync!(ids[0]!))!.projection);
      const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${ids[0]}`, headers });
      expect(deleted.statusCode).toBe(204);
      expect((await app.inject({ url: `/api/projects/${ids[0]}/memory-sync`, headers })).statusCode).toBe(404);
      const restartedMemory = new MemoryService(await createClientScopedMemoryStore(memoriesDirectory));
      await expect(runWithStoredClientId(clients[0]!, () => restartedMemory.applySourceProjection(frozen))).rejects.toThrow();
      expect(modelCall).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
