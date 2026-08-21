/**
 * Example unit tests for {@link ChapterService} (task 4.1). These cover the
 * core happy paths and the validation / not-found error conditions. The
 * exhaustive property-based coverage lives in separate tasks (4.2-4.6).
 *
 * A real {@link FileDataStore} backed by a unique temp file is used (no mocks)
 * so the tests exercise genuine end-to-end behavior through the store.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileDataStore } from '../../store/FileDataStore.js';
import { ServiceError } from '../ServiceError.js';
import { ChapterService } from './ChapterService.js';

describe('ChapterService', () => {
  let dir: string;
  let store: FileDataStore;
  let service: ChapterService;
  let projectId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chapter-service-'));
    store = await FileDataStore.create(join(dir, 'store.json'));
    service = new ChapterService(store);
    const project = await store.createProject('小说项目');
    projectId = project.id;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a chapter and assigns a unique id (Req 2.1)', async () => {
    const chapter = await service.create(projectId, '第一章');
    expect(chapter.id).toBeTruthy();
    expect(chapter.title).toBe('第一章');
    expect(chapter.projectId).toBe(projectId);
  });

  it('rejects an empty / whitespace-only title with VALIDATION_ERROR (Req 2.1)', async () => {
    await expect(service.create(projectId, '   ')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    // store state unchanged
    expect(await service.list(projectId)).toHaveLength(0);
  });

  it('returns NOT_FOUND when creating under a missing project (Req 2.6)', async () => {
    await expect(
      service.create('missing-project', '第一章'),
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      service.create('missing-project', '第一章'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists chapters in position-ascending order (Req 2.2)', async () => {
    await service.create(projectId, 'A');
    await service.create(projectId, 'B');
    await service.create(projectId, 'C');
    const list = await service.list(projectId);
    expect(list.map((c) => c.title)).toEqual(['A', 'B', 'C']);
    for (let i = 1; i < list.length; i += 1) {
      expect(list[i].position).toBeGreaterThanOrEqual(list[i - 1].position);
    }
  });

  it('updates chapter content round-trip (Req 2.3)', async () => {
    const chapter = await service.create(projectId, '第一章');
    const updated = await service.updateContent(chapter.id, '正文内容');
    expect(updated.content).toBe('正文内容');
    const reread = await service.list(projectId);
    expect(reread[0].content).toBe('正文内容');
  });

  it('maps stale chapter revisions to a CONFLICT service error', async () => {
    const chapter = await service.create(projectId, '第一章');
    await service.updateContent(chapter.id, '第一版', 0);
    await expect(service.updateContent(chapter.id, '过期覆盖', 0)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('returns NOT_FOUND when updating content of a missing chapter (Req 2.6)', async () => {
    await expect(
      service.updateContent('missing-chapter', 'x'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('deletes a chapter and leaves others intact (Req 2.4)', async () => {
    const a = await service.create(projectId, 'A');
    const b = await service.create(projectId, 'B');
    await service.remove(a.id);
    const list = await service.list(projectId);
    expect(list.map((c) => c.id)).toEqual([b.id]);
  });

  it('returns NOT_FOUND when deleting a missing chapter (Req 2.6)', async () => {
    await expect(service.remove('missing-chapter')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reorders chapters to the provided id order (Req 2.5)', async () => {
    const a = await service.create(projectId, 'A');
    const b = await service.create(projectId, 'B');
    const c = await service.create(projectId, 'C');
    await service.reorder(projectId, [c.id, a.id, b.id]);
    const list = await service.list(projectId);
    expect(list.map((ch) => ch.id)).toEqual([c.id, a.id, b.id]);
  });

  it('returns NOT_FOUND when reordering a missing project (Req 2.6)', async () => {
    await expect(
      service.reorder('missing-project', []),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
