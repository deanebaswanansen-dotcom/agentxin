/**
 * Example/edge-case unit tests for {@link SettingService} (task 5.1). The
 * property tests for this service live in separate tasks (5.2–5.5); these
 * cover the CRUD surface across all three setting kinds and the `NOT_FOUND`
 * behavior for non-existent ids (Requirement 3.7 / design Property 5).
 *
 * Tests run against a real {@link FileDataStore} backed by a unique temp file
 * (no mocks), exercising the genuine persistence path.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileDataStore } from '../../store/FileDataStore.js';
import { isServiceError } from '../ServiceError.js';
import { SettingService } from './SettingService.js';

let dir: string;
let store: FileDataStore;
let service: SettingService;
let projectId: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'setting-svc-test-'));
  store = await FileDataStore.create(join(dir, 'store.json'));
  service = new SettingService(store);
  const project = await store.createProject('p');
  projectId = project.id;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SettingService characters', () => {
  it('creates a character that appears in the list with matching fields', async () => {
    const created = await service.characters.create(projectId, '林夜', '沉默的剑客');
    expect(created.projectId).toBe(projectId);
    expect(created.name).toBe('林夜');
    expect(created.description).toBe('沉默的剑客');

    const list = await service.characters.list(projectId);
    expect(list).toEqual([created]);
  });

  it('updates a character and round-trips the new fields', async () => {
    const created = await service.characters.create(projectId, 'old', 'olddesc');
    const updated = await service.characters.update(created.id, { name: 'new' });
    expect(updated.name).toBe('new');
    expect(updated.description).toBe('olddesc');

    const [persisted] = await service.characters.list(projectId);
    expect(persisted.name).toBe('new');
  });

  it('removes only the target character', async () => {
    const a = await service.characters.create(projectId, 'a', 'da');
    const b = await service.characters.create(projectId, 'b', 'db');
    await service.characters.remove(a.id);
    const list = await service.characters.list(projectId);
    expect(list.map((c) => c.id)).toEqual([b.id]);
  });

  it('throws NOT_FOUND when updating a non-existent character', async () => {
    await expect(
      service.characters.update('missing', { name: 'x' }),
    ).rejects.toSatisfy(
      (e) => isServiceError(e) && e.code === 'NOT_FOUND',
    );
  });

  it('throws NOT_FOUND when removing a non-existent character', async () => {
    await expect(service.characters.remove('missing')).rejects.toSatisfy(
      (e) => isServiceError(e) && e.code === 'NOT_FOUND',
    );
  });
});

describe('SettingService worldSettings', () => {
  it('creates and lists a world setting with matching fields', async () => {
    const created = await service.worldSettings.create(
      projectId,
      '魔法体系',
      '以星辰为源',
    );
    expect(created.title).toBe('魔法体系');
    expect(created.content).toBe('以星辰为源');
    expect(await service.worldSettings.list(projectId)).toEqual([created]);
  });

  it('updates a world setting and round-trips the new content', async () => {
    const created = await service.worldSettings.create(projectId, 't', 'oldc');
    const updated = await service.worldSettings.update(created.id, {
      content: 'newc',
    });
    expect(updated.title).toBe('t');
    expect(updated.content).toBe('newc');
  });

  it('removes only the target world setting', async () => {
    const a = await service.worldSettings.create(projectId, 'a', 'ca');
    const b = await service.worldSettings.create(projectId, 'b', 'cb');
    await service.worldSettings.remove(a.id);
    const list = await service.worldSettings.list(projectId);
    expect(list.map((w) => w.id)).toEqual([b.id]);
  });

  it('throws NOT_FOUND for update/remove of a non-existent world setting', async () => {
    await expect(
      service.worldSettings.update('missing', { title: 'x' }),
    ).rejects.toSatisfy((e) => isServiceError(e) && e.code === 'NOT_FOUND');
    await expect(service.worldSettings.remove('missing')).rejects.toSatisfy(
      (e) => isServiceError(e) && e.code === 'NOT_FOUND',
    );
  });
});

describe('SettingService outlines', () => {
  it('creates outlines and lists them by ascending position', async () => {
    const o1 = await service.outlines.create(projectId, '第一幕', '起');
    const o2 = await service.outlines.create(projectId, '第二幕', '承');
    const list = await service.outlines.list(projectId);
    expect(list.map((o) => o.id)).toEqual([o1.id, o2.id]);
    expect(list[0].position).toBeLessThan(list[1].position);
  });

  it('updates an outline title without altering position', async () => {
    const created = await service.outlines.create(projectId, 'old', 'c');
    const updated = await service.outlines.update(created.id, { title: 'new' });
    expect(updated.title).toBe('new');
    expect(updated.position).toBe(created.position);
  });

  it('removes only the target outline', async () => {
    const a = await service.outlines.create(projectId, 'a', 'c');
    const b = await service.outlines.create(projectId, 'b', 'c');
    await service.outlines.remove(a.id);
    const list = await service.outlines.list(projectId);
    expect(list.map((o) => o.id)).toEqual([b.id]);
  });

  it('throws NOT_FOUND for update/remove of a non-existent outline', async () => {
    await expect(
      service.outlines.update('missing', { title: 'x' }),
    ).rejects.toSatisfy((e) => isServiceError(e) && e.code === 'NOT_FOUND');
    await expect(service.outlines.remove('missing')).rejects.toSatisfy(
      (e) => isServiceError(e) && e.code === 'NOT_FOUND',
    );
  });
});

describe('SettingService NOT_FOUND scoping', () => {
  it('does not match an id that belongs to a different setting kind', async () => {
    // A character id must not satisfy existence for a world setting update.
    const character = await service.characters.create(projectId, 'n', 'd');
    await expect(
      service.worldSettings.update(character.id, { title: 'x' }),
    ).rejects.toSatisfy((e) => isServiceError(e) && e.code === 'NOT_FOUND');
  });

  it('throws NOT_FOUND when creating settings under a missing project', async () => {
    await expect(
      service.characters.create('missing-project', '林夜', '描述'),
    ).rejects.toSatisfy((e) => isServiceError(e) && e.code === 'NOT_FOUND');
    await expect(
      service.worldSettings.create('missing-project', '世界', '内容'),
    ).rejects.toSatisfy((e) => isServiceError(e) && e.code === 'NOT_FOUND');
    await expect(
      service.outlines.create('missing-project', '大纲', '内容'),
    ).rejects.toSatisfy((e) => isServiceError(e) && e.code === 'NOT_FOUND');
  });
});
