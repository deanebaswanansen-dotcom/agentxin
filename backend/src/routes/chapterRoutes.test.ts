/**
 * Basic route integration tests for {@link registerChapterRoutes} (task 11.2).
 * Full CRUD + error-mapping coverage lives in task 11.6; these smoke-level
 * `app.inject` tests just confirm the routes are wired to the service and that
 * the unified error mapping fires for the common cases.
 *
 * A real {@link FileDataStore} backed by a unique temp file is used (no mocks)
 * so the routes exercise genuine end-to-end behavior through the service/store.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChapterService } from '../services/chapter/ChapterService.js';
import { FileDataStore } from '../store/FileDataStore.js';
import type { Chapter } from '../types/index.js';
import { registerChapterRoutes } from './chapterRoutes.js';

describe('chapterRoutes', () => {
  let dir: string;
  let store: FileDataStore;
  let app: FastifyInstance;
  let projectId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chapter-routes-'));
    store = await FileDataStore.create(join(dir, 'store.json'));
    const project = await store.createProject('小说项目');
    projectId = project.id;

    app = Fastify({ logger: false });
    registerChapterRoutes(app, new ChapterService(store));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('POST creates a chapter and returns 201 (Req 2.1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      payload: { title: '第一章' },
    });
    expect(res.statusCode).toBe(201);
    const chapter = res.json<Chapter>();
    expect(chapter.id).toBeTruthy();
    expect(chapter.title).toBe('第一章');
  });

  it('POST with empty title returns 400 VALIDATION_ERROR (Req 2.1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      payload: { title: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('POST under a missing project returns 404 NOT_FOUND (Req 2.6)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/missing/chapters`,
      payload: { title: '第一章' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('GET lists chapters in position order and returns 200 (Req 2.2)', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      payload: { title: 'A' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      payload: { title: 'B' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/chapters`,
    });
    expect(res.statusCode).toBe(200);
    const chapters = res.json<Chapter[]>();
    expect(chapters.map((c) => c.title)).toEqual(['A', 'B']);
  });

  it('PATCH updates chapter content and returns 200 (Req 2.3)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      payload: { title: '第一章' },
    });
    const { id } = created.json<Chapter>();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/chapters/${id}/content`,
      payload: { content: '正文内容' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Chapter>().content).toBe('正文内容');
  });

  it('PATCH content of a missing chapter returns 404 (Req 2.6)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/chapters/missing/content`,
      payload: { content: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('DELETE removes a chapter and returns 204 (Req 2.4)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      payload: { title: '第一章' },
    });
    const { id } = created.json<Chapter>();
    const res = await app.inject({ method: 'DELETE', url: `/api/chapters/${id}` });
    expect(res.statusCode).toBe(204);
  });

  it('DELETE of a missing chapter returns 404 (Req 2.6)', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/chapters/missing` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('PUT reorders chapters and returns 204 (Req 2.5)', async () => {
    const a = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/chapters`,
        payload: { title: 'A' },
      })
    ).json<Chapter>();
    const b = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/chapters`,
        payload: { title: 'B' },
      })
    ).json<Chapter>();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/chapters/order`,
      payload: { orderedIds: [b.id, a.id] },
    });
    expect(res.statusCode).toBe(204);

    const list = (
      await app.inject({ method: 'GET', url: `/api/projects/${projectId}/chapters` })
    ).json<Chapter[]>();
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
  });

  it('PUT with a non-array orderedIds returns 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/chapters/order`,
      payload: { orderedIds: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT reorder under a missing project returns 404 (Req 2.6)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/missing/chapters/order`,
      payload: { orderedIds: [] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
