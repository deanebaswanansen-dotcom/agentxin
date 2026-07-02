/**
 * Example/edge-case unit tests for {@link ProjectService} (task 3.1).
 *
 * These complement the property tests in tasks 3.2–3.5. They use a minimal
 * in-memory fake {@link DataStore} so the service's business rules
 * (validation + existence checks) are exercised in isolation from the file
 * persistence layer.
 */
import { describe, expect, it } from 'vitest';

import type { DataStore } from '../../store/DataStore.js';
import type { Id, Project } from '../../types/index.js';
import { ServiceError, isServiceError } from '../ServiceError.js';
import { ProjectService } from './ProjectService.js';

/** Minimal in-memory store covering only the project surface used here. */
function makeFakeStore(): DataStore {
  const projects = new Map<Id, Project>();
  let seq = 0;

  const fake: Partial<DataStore> = {
    async createProject(name: string): Promise<Project> {
      const now = new Date().toISOString();
      const project: Project = {
        id: `id-${++seq}`,
        name,
        createdAt: now,
        updatedAt: now,
      };
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

describe('ProjectService.create', () => {
  it('creates a project and returns it (Req 1.1)', async () => {
    const service = new ProjectService(makeFakeStore());
    const project = await service.create('我的小说');
    expect(project.name).toBe('我的小说');
    expect(project.id).toBeTruthy();
  });

  it('persists the name exactly as provided, without trimming', async () => {
    const service = new ProjectService(makeFakeStore());
    const project = await service.create('  有空格的名称  ');
    expect(project.name).toBe('  有空格的名称  ');
  });

  it.each(['', '   ', '\t\n', '\u00A0'])(
    'rejects empty/whitespace-only name %j with VALIDATION_ERROR (Req 1.5)',
    async (name) => {
      const store = makeFakeStore();
      const service = new ProjectService(store);
      await expect(service.create(name)).rejects.toSatisfy(
        (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
      );
      // State unchanged: no project created.
      expect(await service.list()).toEqual([]);
    },
  );
});

describe('ProjectService.list', () => {
  it('returns id+name for all created projects (Req 1.2)', async () => {
    const service = new ProjectService(makeFakeStore());
    const a = await service.create('a');
    const b = await service.create('b');
    const list = await service.list();
    expect(list).toEqual([
      { id: a.id, name: 'a' },
      { id: b.id, name: 'b' },
    ]);
  });
});

describe('ProjectService.rename', () => {
  it('renames an existing project (Req 1.4)', async () => {
    const service = new ProjectService(makeFakeStore());
    const created = await service.create('old');
    const renamed = await service.rename(created.id, 'new');
    expect(renamed.name).toBe('new');
    expect((await service.list())[0]).toEqual({ id: created.id, name: 'new' });
  });

  it('throws NOT_FOUND for an unknown id (Req 1.6)', async () => {
    const service = new ProjectService(makeFakeStore());
    await expect(service.rename('missing', 'x')).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'NOT_FOUND',
    );
  });

  it('rejects an empty new name with VALIDATION_ERROR', async () => {
    const service = new ProjectService(makeFakeStore());
    const created = await service.create('old');
    await expect(service.rename(created.id, '   ')).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
    );
    // Name unchanged.
    expect((await service.list())[0]).toEqual({ id: created.id, name: 'old' });
  });
});

describe('ProjectService.remove', () => {
  it('deletes an existing project (Req 1.3)', async () => {
    const service = new ProjectService(makeFakeStore());
    const created = await service.create('p');
    await service.remove(created.id);
    expect(await service.list()).toEqual([]);
  });

  it('throws NOT_FOUND for an unknown id (Req 1.6)', async () => {
    const service = new ProjectService(makeFakeStore());
    await expect(service.remove('missing')).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'NOT_FOUND',
    );
  });
});

describe('ServiceError', () => {
  it('serializes to the unified ApiError body', () => {
    const err = ServiceError.notFound('项目不存在: x');
    expect(err.toApiError()).toEqual({
      error: { code: 'NOT_FOUND', message: '项目不存在: x' },
    });
  });
});
