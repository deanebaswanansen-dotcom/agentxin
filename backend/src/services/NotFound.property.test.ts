/**
 * Property-based test for the unified `NOT_FOUND` behavior shared across the
 * three domain services (task 5.5).
 *
 * Covers design.md Correctness **Property 5: 不存在的标识符返回 NOT_FOUND**:
 *
 *   For any 在数据存储中不存在的项目、章节或设定条目标识符，针对其的读取、更新、
 *   重命名或删除操作均返回 `NOT_FOUND` 错误。
 *
 * **Validates: Requirements 1.6, 2.6, 3.7**
 *
 * Method (design.md Testing Strategy): exercised end-to-end through a REAL
 * {@link FileDataStore} backed by a unique temp file per run (no mocks). To make
 * the property meaningful we first seed a non-empty store (a project plus one
 * chapter, character, world setting and outline) so that "id not found" is
 * distinguished from "store is empty". We then generate an arbitrary identifier
 * that is guaranteed NOT to match any seeded entity id, and assert that every
 * mutating / lookup operation targeting that id rejects with a
 * {@link ServiceError} whose `code === 'NOT_FOUND'`:
 *
 *   - ProjectService.rename(id, name) / .remove(id)                 (Req 1.6)
 *   - ChapterService.updateContent(id, content) / .remove(id)
 *       / .reorder(id, [])                                          (Req 2.6)
 *   - SettingService.{characters,worldSettings,outlines}
 *       .update(id, fields) / .remove(id)                           (Req 3.7)
 *
 * Uses fast-check with 100 runs. The id generator covers UUID-shaped strings,
 * arbitrary unicode/whitespace/special strings and notable constants so the
 * "not found" path is probed across a wide input space. A fresh store + temp
 * file is created per run for full isolation and cleaned up afterwards.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from '../store/FileDataStore.js';
import { ProjectService } from './project/ProjectService.js';
import { ChapterService } from './chapter/ChapterService.js';
import { SettingService } from './setting/SettingService.js';
import { isServiceError } from './ServiceError.js';
import { ERROR_CODES } from '../types/index.js';

const NUM_RUNS = 100;

/**
 * Generator for identifiers that may or may not exist. Covers UUID-shaped
 * strings (the real id format), arbitrary unicode/whitespace/special strings
 * and notable constants. Generated ids are filtered against the seeded ids at
 * runtime so the property only asserts the not-found path.
 */
const idArb: fc.Arbitrary<string> = fc.oneof(
  fc.uuid(),
  fc.string(),
  fc.string({ unit: 'grapheme', maxLength: 40 }),
  fc.constantFrom(
    '',
    ' ',
    '\t',
    '\n',
    'nonexistent',
    '00000000-0000-0000-0000-000000000000',
    'undefined',
    'null',
    '../../etc/passwd',
    '中文标识符',
    '😀',
    'a'.repeat(200),
  ),
);

/**
 * Assert that `op()` rejects with a {@link ServiceError} carrying
 * `code === 'NOT_FOUND'`. Returns nothing; throws (failing the property) when
 * the operation resolves or rejects with any other error.
 */
async function expectNotFound(label: string, op: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  let resolved = false;
  try {
    await op();
    resolved = true;
  } catch (err) {
    caught = err;
  }
  expect(resolved, `${label} 应当因标识符不存在而拒绝，但却成功返回`).toBe(false);
  expect(
    isServiceError(caught),
    `${label} 应当抛出 ServiceError，实际抛出：${String(caught)}`,
  ).toBe(true);
  expect((caught as { code: string }).code, `${label} 的错误码应为 NOT_FOUND`).toBe(
    ERROR_CODES.NOT_FOUND,
  );
}

describe('NOT_FOUND for non-existent identifiers (property)', () => {
  it('Feature: novel-writing-agent, Property 5: 不存在的标识符返回 NOT_FOUND', async () => {
    await fc.assert(
      fc.asyncProperty(idArb, async (candidateId) => {
        const dir = await mkdtemp(join(tmpdir(), 'not-found-prop-'));
        try {
          const store = await FileDataStore.create(join(dir, 'store.json'));
          const projects = new ProjectService(store);
          const chapters = new ChapterService(store);
          const settings = new SettingService(store);

          // Seed a non-empty store so "id not found" is meaningful (not just
          // an empty store). Collect every real id to exclude collisions.
          const project = await store.createProject('已存在的项目');
          const chapter = await store.createChapter(project.id, '第一章');
          const character = await store.createCharacter(project.id, '主角', '描述');
          const world = await store.createWorldSetting(project.id, '世界', '内容');
          const outline = await store.createOutline(project.id, '大纲', '内容');

          const seededIds = new Set<string>([
            project.id,
            chapter.id,
            character.id,
            world.id,
            outline.id,
          ]);

          // Only assert the not-found path: skip the (astronomically unlikely)
          // case where the generated id collides with a seeded entity.
          fc.pre(!seededIds.has(candidateId));

          // --- ProjectService (Requirement 1.6) ---
          await expectNotFound('ProjectService.rename', () =>
            projects.rename(candidateId, '新名称'),
          );
          await expectNotFound('ProjectService.remove', () =>
            projects.remove(candidateId),
          );

          // --- ChapterService (Requirement 2.6) ---
          await expectNotFound('ChapterService.updateContent', () =>
            chapters.updateContent(candidateId, '新正文'),
          );
          await expectNotFound('ChapterService.remove', () =>
            chapters.remove(candidateId),
          );
          await expectNotFound('ChapterService.reorder', () =>
            chapters.reorder(candidateId, []),
          );

          // --- SettingService (Requirement 3.7) ---
          await expectNotFound('SettingService.characters.update', () =>
            settings.characters.update(candidateId, { name: '新名' }),
          );
          await expectNotFound('SettingService.characters.remove', () =>
            settings.characters.remove(candidateId),
          );
          await expectNotFound('SettingService.worldSettings.update', () =>
            settings.worldSettings.update(candidateId, { title: '新标题' }),
          );
          await expectNotFound('SettingService.worldSettings.remove', () =>
            settings.worldSettings.remove(candidateId),
          );
          await expectNotFound('SettingService.outlines.update', () =>
            settings.outlines.update(candidateId, { title: '新标题' }),
          );
          await expectNotFound('SettingService.outlines.remove', () =>
            settings.outlines.remove(candidateId),
          );
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  },
  // Each of the 100 runs performs real filesystem I/O (mkdtemp + atomic writes
  // for seeding) plus many service calls, so allow a generous timeout beyond
  // the 5s vitest default.
  30000);
});
