/**
 * Wiring smoke test for the backend entrypoint (task 13.1).
 *
 * Verifies that {@link buildServer} actually assembles the store-backed
 * services and registers every route group, by exercising the live app through
 * `app.inject` (no network). A temp-file {@link FileDataStore} backs the app so
 * the test touches the real persistence path without polluting the repo's
 * `data/` directory.
 *
 * This intentionally stays at the "is everything wired?" level — exhaustive
 * per-route behavior is covered by each route module's own tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from './index.js';
import { FileDataStore } from './store/FileDataStore.js';
import { createClientScopedDataStore } from './store/ClientScopedDataStore.js';
import { FileScriptStore, createClientScopedScriptStore } from './services/script/FileScriptStore.js';
import { buildScriptAtomicCommitInput, buildScriptContinuityCandidate } from './services/script/ScriptContinuityCommit.js';
import { MemoryService } from './services/memory/MemoryService.js';
import { MemoryStore } from './services/memory/MemoryStore.js';

describe('buildServer wiring', () => {
  let dir: string;
  let app: FastifyInstance;
  let scriptStore: FileScriptStore;
  let memory: MemoryService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nwa-wiring-'));
    const store = await FileDataStore.create(join(dir, 'store.json'));
    scriptStore = await FileScriptStore.create(join(dir, 'scripts'));
    memory = new MemoryService(MemoryStore.ephemeral());
    app = buildServer(store, undefined, memory, undefined, undefined, undefined, undefined, scriptStore);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('exposes cache-stats only on the loopback probe', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/cache-stats' });
    expect(res.statusCode).toBe(200);
    expect(res.json().localCache).toEqual(
      expect.objectContaining({ hits: expect.any(Number), misses: expect.any(Number) }),
    );
  });

  it('keeps the /health probe', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['access-control-expose-headers']).toBe('Content-Disposition');
  });

  it('exposes the liveness probe through the proxied API prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('registers the project routes (GET /api/projects → 200 [])', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('registers the model-config route (GET /api/model-config → masked view)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      baseUrl: '',
      modelName: '',
      apiKeyMasked: '',
      temperature: 1,
      topP: 1,
    });
  });

  it('wires project → chapter routes through the shared store', async () => {
    // Create a project, then list its (empty) chapters: proves the project and
    // chapter route groups share the same store instance.
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Wired Project' },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id as string;

    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json()).toEqual([{ id: projectId, name: 'Wired Project', kind: 'novel' }]);

    const chapters = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/chapters`,
    });
    expect(chapters.statusCode).toBe(200);
    expect(chapters.json()).toEqual([]);
  });

  it('wires isolated short-drama state and cascades it when a project is deleted', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '短剧', kind: 'short_drama' },
    });
    const projectId = created.json().id as string;

    const state = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/script-state`,
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ projectId, episodes: [] });

    const removed = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}` });
    expect(removed.statusCode).toBe(204);
    const missing = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/script-state`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('registers the setting routes (GET /api/projects/:id/characters → 200 [])', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'S' },
    });
    const projectId = created.json().id as string;
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/characters`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('uses the configured single local library for memory APIs even when the browser sends a client id', async () => {
    const headers = { 'x-agentxin-client-id': 'd'.repeat(64) };
    const created = await app.inject({ method: 'POST', url: '/api/projects', headers,
      payload: { name: '本地短剧', kind: 'short_drama' } });
    const projectId = created.json().id as string;
    const episode = await scriptStore.saveEpisode({
      id: 'episode-1', projectId, episodeNumber: 1, title: '第1集', outlineId: 'outline-1',
      status: 'reviewing', targetChars: 100, revision: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      scenes: [{ id: 'scene-1', ordinal: 1, location: '门外', timeOfDay: 'day',
        interiorExterior: 'exterior', characterIds: [],
        blocks: [{ id: 'block-1', type: 'action', text: '钥匙留在门外。' }] }],
      summary: '钥匙留在门外。', newFacts: ['钥匙留在门外。'], openedThreads: [], closedThreads: [],
    }, 0);
    const state = (await scriptStore.getProjectState(projectId))!;
    await scriptStore.commitEpisodeWithContinuity(buildScriptAtomicCommitInput(state, episode,
      buildScriptContinuityCandidate(state, episode), { promptVersion: 'no-model', modelConfigFingerprint: 'no-model' }));
    const frozen = (await scriptStore.getMemorySync(projectId))!.projection;

    const status = await app.inject({ url: `/api/projects/${projectId}/memory-sync`, headers });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ status: 'pending', acceptedSources: 1 });
    const fallback = await app.inject({ url: `/api/projects/${projectId}/source-memory?beforeUnit=2`, headers });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json()).toMatchObject({ origin: 'accepted_sources', memorySync: { status: 'pending' } });
    expect(fallback.json().entries[0].source.clientId).toBe('local');

    const retry = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/memory-sync/retry`, headers });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: 'succeeded', attempts: 1 });
    const projected = await app.inject({ url: `/api/projects/${projectId}/source-memory?beforeUnit=2`, headers });
    expect(projected.statusCode).toBe(200);
    expect(projected.json()).toMatchObject({ origin: 'projection', memorySync: { status: 'succeeded' } });

    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/projects/${projectId}/memory-sync`, headers })).statusCode).toBe(404);
    await expect(memory.applySourceProjection(frozen)).rejects.toThrow();
  });

  it('keeps request isolation for a client-scoped store that also contains a local library', async () => {
    await app.close();
    const projects = createClientScopedDataStore(join(dir, 'scoped-projects'));
    const localProject = await projects.createProject('本地库', 'short_drama');
    const scripts = createClientScopedScriptStore(join(dir, 'scoped-scripts'));
    app = buildServer(projects, undefined, undefined, undefined, undefined, undefined, undefined, scripts);
    const headers = { 'x-agentxin-client-id': 'e'.repeat(64) };
    const created = await app.inject({ method: 'POST', url: '/api/projects', headers,
      payload: { name: '浏览器库', kind: 'short_drama' } });
    const ownStatus = await app.inject({ url: `/api/projects/${created.json().id}/memory-sync`, headers });
    expect(ownStatus.statusCode).toBe(200);
    expect(ownStatus.json().status).toBe('legacy_untracked');
    for (const request of [
      { method: 'GET' as const, url: `/api/projects/${localProject.id}/memory-sync` },
      { method: 'GET' as const, url: `/api/projects/${localProject.id}/source-memory?beforeUnit=2` },
      { method: 'POST' as const, url: `/api/projects/${localProject.id}/memory-sync/retry` },
    ]) expect((await app.inject({ ...request, headers })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/projects/${localProject.id}/memory-sync` })).statusCode).toBe(200);
  });

  it('registers the writing SSE route and surfaces MODEL_NOT_CONFIGURED', async () => {
    // No model config saved → the writing route emits an SSE error frame
    // carrying the MODEL_NOT_CONFIGURED ApiError on a 200 event-stream.
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'W' },
    });
    const projectId = created.json().id as string;

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters/missing/write`,
      payload: { operation: 'continue', instruction: 'go' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('event: error');
    expect(res.payload).toContain('MODEL_NOT_CONFIGURED');
  });
});
