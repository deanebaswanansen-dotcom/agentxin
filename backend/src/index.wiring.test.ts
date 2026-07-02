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

describe('buildServer wiring', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nwa-wiring-'));
    const store = await FileDataStore.create(join(dir, 'store.json'));
    app = buildServer(store);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the /health probe', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
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
    expect(list.json()).toEqual([{ id: projectId, name: 'Wired Project' }]);

    const chapters = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/chapters`,
    });
    expect(chapters.statusCode).toBe(200);
    expect(chapters.json()).toEqual([]);
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
