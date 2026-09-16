import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileDataStore } from '../store/FileDataStore.js';
import { FileScriptStore } from '../services/script/FileScriptStore.js';
import { MemoryStore } from '../services/memory/MemoryStore.js';
import { MemoryService } from '../services/memory/MemoryService.js';
import { MemorySyncRunner } from '../services/memory/MemorySyncRunner.js';
import { StoryMemoryService } from '../services/memory/StoryMemoryService.js';
import { registerStoryMemoryRoutes } from './storyMemoryRoutes.js';
import { getCurrentClientId, registerClientScope, runWithStoredClientId } from '../services/client/clientScope.js';
import { createClientScopedDataStore } from '../store/ClientScopedDataStore.js';
import { createClientScopedMemoryStore } from '../store/ClientScopedAuxiliaryStores.js';
import { hashWriteBriefValue } from '../services/writing/WriteBrief.js';
import { buildServer } from '../index.js';

describe('story memory workbench routes with actual author stores', () => {
  let directory: string, dataFile: string, data: FileDataStore, script: FileScriptStore, app: FastifyInstance;
  let novelId: string, dramaId: string, chapterId: string;
  const headers = { 'x-agentxin-client-id': 'f'.repeat(64) };
  const preference = { kind: 'preference', text: '对白简短', enabled: true, importance: 'advisory', fromUnit: 1 };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'story-memory-routes-')); dataFile = join(directory, 'data.json');
    data = await FileDataStore.create(dataFile); script = await FileScriptStore.create(join(directory, 'scripts'));
    novelId = (await data.createProject('小说')).id; dramaId = (await data.createProject('短剧', 'short_drama')).id;
    let chapter = await data.createChapter(novelId, '约定'); chapterId = chapter.id;
    chapter = await data.updateChapterContent(chapter.id, '苏禾承诺周五黄昏归还红伞。', chapter.revision ?? 0);
    await data.acceptChapter({ chapterId, expectedRevision: chapter.revision ?? 0, contentHash: hashWriteBriefValue(chapter.content), entries: [] });
    const memory = new MemoryService(MemoryStore.ephemeral());
    const runner = new MemorySyncRunner(data, script, memory, { novelSource: data, fixedClientId: 'local' });
    const service = new StoryMemoryService(data, runner, data, script, { fixedClientId: 'local',
      nextUnit: async (id, mode) => mode === 'novel' ? (await data.listChapters(id)).length + 1 : 1 });
    app = Fastify(); registerClientScope(app); registerStoryMemoryRoutes(app, service);
  });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); await rm(directory, { recursive: true, force: true }); });

  it('returns accepted source choices and retrieves frozen text with the actual default boundary', async () => {
    const response = await app.inject({ url: `/api/projects/${novelId}/story-memory?q=红伞`, headers });
    expect(response.statusCode).toBe(200);
    const view = response.json();
    expect(view).toMatchObject({ mode: 'novel', beforeUnit: 2, memorySync: { status: 'pending' } });
    expect(view.acceptedSources).toHaveLength(1);
    expect(view.acceptedSources[0].source).toMatchObject({ clientId: 'local', resourceId: chapterId });
    expect(view.retrieval.hits.find((hit: { kind: string }) => hit.kind === 'body')).toMatchObject({ kind: 'body', evidenceStatus: 'matched', text: '苏禾承诺周五黄昏归还红伞。' });
    const historical = await app.inject({ url: `/api/projects/${novelId}/story-memory?beforeUnit=1&q=红伞`, headers });
    expect(historical.json()).toMatchObject({ entries: [], acceptedSources: [], retrieval: { hits: [] } });
    expect(view).not.toHaveProperty('projection');
  });

  it('wires novel-only recovery and workbench routes through the actual server without model calls', async () => {
    const streamCompletion = vi.fn(async function* () { throw new Error('A memory query must not call a model'); });
    const wired = buildServer(data, { streamCompletion });
    try {
      const response = await wired.inject({ url: `/api/projects/${novelId}/story-memory?q=红伞`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ memorySync: { mode: 'novel', status: 'succeeded' }, beforeUnit: 2 });
      const status = await wired.inject({ url: `/api/projects/${novelId}/memory-sync`, headers });
      expect(status.json()).toMatchObject({ mode: 'novel', status: 'succeeded' });
      expect(streamCompletion).not.toHaveBeenCalled();
    } finally { await wired.close(); }
  });

  it('routes author CRUD into the matching manuscript store and rejects a concurrent stale revision', async () => {
    for (const projectId of [novelId, dramaId]) {
      const created = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/story-controls`, headers, payload: { expectedRevision: 0, control: preference } });
      expect(created.statusCode).toBe(200); expect(created.json().revision).toBe(1);
      const id = created.json().items[0].id;
      const updated = await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/story-controls/${id}`, headers,
        payload: { expectedRevision: 1, control: { ...preference, text: '保留自然口语' } } });
      expect(updated.statusCode).toBe(200); expect(updated.json().revision).toBe(2);
      const stale = await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/story-controls/${id}`, headers,
        payload: { expectedRevision: 1, control: { ...preference, text: '迟到覆盖' } } });
      expect(stale.statusCode).toBe(409);
      const collection = projectId === novelId ? await data.getStoryControls(projectId) : await script.getStoryControls(projectId);
      expect(collection.items[0]!.text).toBe('保留自然口语');
      const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/story-controls/${id}`, headers, payload: { expectedRevision: 2 } });
      expect(deleted.statusCode).toBe(200); expect(deleted.json()).toMatchObject({ revision: 3, items: [] });
    }
    await expect((await FileDataStore.create(dataFile)).getStoryControls(novelId)).resolves.toMatchObject({ revision: 3, items: [] });
  });

  it('requires explicit adjudication before retracting a selected source and preserves the body', async () => {
    const view = (await app.inject({ url: `/api/projects/${novelId}/story-memory`, headers })).json();
    const control = { kind: 'fact_correction', text: '该承诺作废，由作者另行安排', enabled: true, importance: 'required', fromUnit: 1, source: view.acceptedSources[0].source };
    const bytes = await readFile(dataFile, 'utf8');
    const missing = await app.inject({ method: 'POST', url: `/api/projects/${novelId}/story-controls`, headers, payload: { expectedRevision: 0, control } });
    expect(missing.statusCode).toBe(400); expect(await readFile(dataFile, 'utf8')).toBe(bytes);
    const confirmed = await app.inject({ method: 'POST', url: `/api/projects/${novelId}/story-controls`, headers, payload: { expectedRevision: 0, control: { ...control, resolutionConfirmed: true } } });
    expect(confirmed.statusCode).toBe(200);
    expect((await data.getChapter(chapterId))!.content).toBe('苏禾承诺周五黄昏归还红伞。');
    const after = (await app.inject({ url: `/api/projects/${novelId}/story-memory?q=红伞`, headers })).json();
    expect(after.acceptedSources).toEqual([]); expect(after.retrieval.hits).toEqual([]);
  });

  it('retries a mixed author/source snapshot and never returns old facts beside a new correction', async () => {
    const original = data.getStoryControls.bind(data);
    const source = (await data.getMemorySync(novelId))!.projection.acceptances[0]!.source;
    vi.spyOn(data, 'getStoryControls').mockImplementationOnce(async (projectId) => {
      await data.upsertStoryControl(projectId, { kind: 'fact_correction', text: '红伞承诺已由作者撤回', enabled: true,
        importance: 'required', fromUnit: 1, source, resolutionConfirmed: true }, 0);
      return original(projectId);
    });
    const response = await app.inject({ url: `/api/projects/${novelId}/story-memory?q=红伞` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ acceptedSources: [], retrieval: { hits: [] }, controls: { revision: 1 } });
    expect(response.json().retrieval.authorMatches[0]).toMatchObject({ origin: 'author' });
  });

  it('caps snapshot retries and reports conflict while author records keep changing', async () => {
    let revision = 0;
    const get = vi.spyOn(data, 'getStoryControls').mockImplementation(async () => ({ schemaVersion: 1, revision: ++revision, items: [] }));
    const response = await app.inject({ url: `/api/projects/${novelId}/story-memory` });
    expect(response.statusCode).toBe(409); expect(get).toHaveBeenCalledTimes(6);
  });

  it('rejects invalid query/body parameters and unknown projects', async () => {
    expect((await app.inject({ url: `/api/projects/${novelId}/story-memory?beforeUnit=1.5` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/projects/${novelId}/story-memory?q=红伞&topK=100` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${novelId}/story-controls`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/projects/missing/story-memory' })).statusCode).toBe(404);
  });

  it('keeps scoped workbench reads and writes inside the header library', async () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64);
    const scoped = createClientScopedDataStore(join(directory, 'clients'));
    const scopedMemory = new MemoryService(await createClientScopedMemoryStore(join(directory, 'memories')));
    const project = await runWithStoredClientId(a, () => scoped.createProject('私有项目'));
    const runner = new MemorySyncRunner(scoped, {}, scopedMemory, { novelSource: scoped });
    const service = new StoryMemoryService(scoped, runner, scoped, {}, { nextUnit: async () => 1 });
    const isolated = Fastify(); registerClientScope(isolated); registerStoryMemoryRoutes(isolated, service);
    const own = await isolated.inject({ url: `/api/projects/${project.id}/story-memory`, headers: { 'x-agentxin-client-id': a } });
    expect(own.statusCode).toBe(200);
    const foreign = await isolated.inject({ method: 'POST', url: `/api/projects/${project.id}/story-controls`, headers: { 'x-agentxin-client-id': b }, payload: { expectedRevision: 0, control: preference, clientId: a } });
    expect(foreign.statusCode).toBe(404);
    expect((await runWithStoredClientId(a, () => scoped.getStoryControls!(project.id))).items).toEqual([]);
    expect(getCurrentClientId()).toBe('local');
    await isolated.close();
  });
});
