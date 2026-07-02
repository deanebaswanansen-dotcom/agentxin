/**
 * Route integration tests for {@link registerSettingRoutes} (task 11.6 coverage
 * for the settings group — characters / worldSettings / outlines). These fill
 * the gap left by the smoke-level project/chapter tests: the settings routes
 * had no `app.inject` coverage before.
 *
 * Setup mirrors `chapterRoutes.test.ts`: a real {@link FileDataStore} over a
 * unique temp file (no mocks) backs a real {@link SettingService}, so the
 * routes are exercised end-to-end through the domain + persistence layers.
 *
 * The three entity types share an identical route shape, so the CRUD assertions
 * are parameterized over a small table to avoid triplicating the cases while
 * still covering each segment (note the world-settings segment is the camelCase
 * `worldSettings`, per the route module). Each entity has two string fields:
 *   - characters:    name / description
 *   - worldSettings: title / content
 *   - outlines:      title / content
 *
 * Covered (Requirements 3.1–3.6):
 *   - POST create → 201 with the returned entity (id + echoed fields)
 *   - GET  list   → 200 with the created entities
 *   - PATCH update → 200 with the updated entity; missing id → 404 NOT_FOUND
 *   - DELETE → 204 no content; missing id → 404 NOT_FOUND
 *   - POST with a missing required field → 400 VALIDATION_ERROR
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SettingService } from '../services/setting/SettingService.js';
import { FileDataStore } from '../store/FileDataStore.js';
import type { Id } from '../types/index.js';
import { registerSettingRoutes } from './settingRoutes.js';

/** One row of the entity table driving the parameterized CRUD suite. */
interface EntityCase {
  /** URL segment (also the apiClient namespace), e.g. `characters`. */
  segment: string;
  /** First/second body field names in order. */
  fields: [string, string];
  /** A sample create payload. */
  createPayload: Record<string, string>;
  /** A partial update payload targeting the first field. */
  updatePayload: Record<string, string>;
}

const ENTITY_CASES: EntityCase[] = [
  {
    segment: 'characters',
    fields: ['name', 'description'],
    createPayload: { name: '林夜', description: '沉默的剑客' },
    updatePayload: { name: '林昼' },
  },
  {
    segment: 'worldSettings',
    fields: ['title', 'content'],
    createPayload: { title: '魔法体系', content: '以星辰为源' },
    updatePayload: { title: '新体系' },
  },
  {
    segment: 'outlines',
    fields: ['title', 'content'],
    createPayload: { title: '第一幕', content: '起' },
    updatePayload: { title: '序章' },
  },
];

let dir: string;
let store: FileDataStore;
let app: FastifyInstance;
let projectId: Id;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'setting-routes-'));
  store = await FileDataStore.create(join(dir, 'store.json'));
  const project = await store.createProject('小说项目');
  projectId = project.id;

  app = Fastify({ logger: false });
  registerSettingRoutes(app, new SettingService(store));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe.each(ENTITY_CASES)('settingRoutes /$segment', ({ segment, fields, createPayload, updatePayload }) => {
  const [field1, field2] = fields;

  it(`POST creates an entity and returns 201 with the entity (Req 3.1–3.3)`, async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/${segment}`,
      payload: createPayload,
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<Record<string, unknown>>();
    expect(created.id).toBeTruthy();
    expect(created.projectId).toBe(projectId);
    expect(created[field1]).toBe(createPayload[field1]);
    expect(created[field2]).toBe(createPayload[field2]);
  });

  it(`POST with a missing required field returns 400 VALIDATION_ERROR`, async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/${segment}`,
      payload: { [field1]: createPayload[field1] }, // second field omitted
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it(`GET lists created entities and returns 200 (Req 3.4)`, async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/${segment}`,
        payload: createPayload,
      })
    ).json<{ id: Id }>();

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/${segment}`,
    });
    expect(res.statusCode).toBe(200);
    const list = res.json<Array<{ id: Id }>>();
    expect(list.map((e) => e.id)).toEqual([created.id]);
  });

  it(`GET on an empty project returns 200 with []`, async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/${segment}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it(`PATCH updates an entity and returns 200 (Req 3.5)`, async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/${segment}`,
        payload: createPayload,
      })
    ).json<Record<string, unknown>>();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/${segment}/${created.id as string}`,
      payload: updatePayload,
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json<Record<string, unknown>>();
    // Patched field reflects the new value; the untouched field is preserved.
    expect(updated[field1]).toBe(updatePayload[field1]);
    expect(updated[field2]).toBe(createPayload[field2]);
  });

  it(`PATCH on a missing id returns 404 NOT_FOUND (Req 3.7)`, async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/${segment}/missing`,
      payload: updatePayload,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it(`DELETE removes an entity and returns 204 (Req 3.6)`, async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/${segment}`,
        payload: createPayload,
      })
    ).json<{ id: Id }>();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/${segment}/${created.id}`,
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const list = (
      await app.inject({ method: 'GET', url: `/api/projects/${projectId}/${segment}` })
    ).json<Array<{ id: Id }>>();
    expect(list).toEqual([]);
  });

  it(`DELETE on a missing id returns 404 NOT_FOUND (Req 3.7)`, async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/${segment}/missing`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('settingRoutes cross-entity behavior', () => {
  it('keeps the three entity collections independent (Req 3.4)', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/characters`,
      payload: { name: '甲', description: 'd' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/worldSettings`,
      payload: { title: '乙', content: 'c' },
    });

    const characters = (
      await app.inject({ method: 'GET', url: `/api/projects/${projectId}/characters` })
    ).json<unknown[]>();
    const outlines = (
      await app.inject({ method: 'GET', url: `/api/projects/${projectId}/outlines` })
    ).json<unknown[]>();

    expect(characters).toHaveLength(1);
    // Outlines were never created, so that collection stays empty.
    expect(outlines).toEqual([]);
  });

  it('PATCH does not match an id from a different entity kind → 404 (Req 3.7)', async () => {
    const character = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/characters`,
        payload: { name: '甲', description: 'd' },
      })
    ).json<{ id: Id }>();

    // Using a character id against the worldSettings route must not resolve.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/worldSettings/${character.id}`,
      payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
