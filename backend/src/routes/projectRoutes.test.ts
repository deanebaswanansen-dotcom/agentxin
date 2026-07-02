/**
 * Basic route integration tests for {@link registerProjectRoutes} (task 11.1).
 *
 * These are a smoke-level subset exercising the happy paths and the key error
 * status mappings via Fastify's `app.inject`. Full route coverage (all CRUD
 * paths + every error status) is task 11.6.
 *
 * A minimal in-memory fake {@link DataStore} backs a real {@link ProjectService}
 * so the routes are exercised end-to-end through the domain layer without
 * touching the file persistence layer.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DataStore } from '../store/DataStore.js';
import type { Id, Project } from '../types/index.js';
import { ProjectService } from '../services/project/ProjectService.js';
import { registerProjectRoutes } from './projectRoutes.js';

/** Minimal in-memory store covering only the project surface used here. */
function makeFakeStore(): DataStore {
  const projects = new Map<Id, Project>();
  let seq = 0;

  const fake: Partial<DataStore> = {
    async createProject(name: string): Promise<Project> {
      const now = new Date().toISOString();
      const project: Project = { id: `id-${++seq}`, name, createdAt: now, updatedAt: now };
      projects.set(project.id, project);
      return { ...project };
    },
    async listProjects(): Promise<Pick<Project, 'id' | 'name'>[]> {
      return [...projects.values()].map(({ id, name }) => ({ id, name }));
    },
    async getProject(id: Id): Promise<Project | undefined> {
      const found = projects.get(id);
      return found ? { ...found } : undefined;
    },
    async renameProject(id: Id, name: string): Promise<Project> {
      const found = projects.get(id);
      if (!found) throw new Error('unexpected: renameProject on missing id');
      const updated: Project = { ...found, name, updatedAt: new Date().toISOString() };
      projects.set(id, updated);
      return { ...updated };
    },
    async deleteProject(id: Id): Promise<void> {
      projects.delete(id);
    },
  };

  return fake as DataStore;
}

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify({ logger: false });
  registerProjectRoutes(app, new ProjectService(makeFakeStore()));
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/projects', () => {
  it('creates a project and returns 201 with the project (Req 1.1)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '我的小说' } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('我的小说');
    expect(body.id).toBeTruthy();
  });

  it('returns 400 VALIDATION_ERROR for an empty name (Req 1.5)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '   ' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: expect.any(String) } });
  });
});

describe('GET /api/projects', () => {
  it('returns 200 with the list of {id, name} (Req 1.2)', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'a' } });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'b' } });
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: 'id-1', name: 'a' },
      { id: 'id-2', name: 'b' },
    ]);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('renames an existing project and returns 200 (Req 1.4)', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'old' } })).json();
    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${created.id}`, payload: { name: 'new' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('new');
  });

  it('returns 404 NOT_FOUND for an unknown id (Req 1.6)', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/projects/missing', payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /api/projects/:id', () => {
  it('deletes an existing project and returns 204 (Req 1.3)', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'p' } })).json();
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json()).toEqual([]);
  });

  it('returns 404 NOT_FOUND for an unknown id (Req 1.6)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/projects/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
