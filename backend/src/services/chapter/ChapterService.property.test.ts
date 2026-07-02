/**
 * Property-based test for {@link ChapterService} chapter creation (task 4.2).
 *
 * Covers design.md Correctness **Property 6: 章节创建-读回往返与唯一性**
 * (Requirement 2.1): for any sequence of NON-EMPTY chapter titles created under
 * a single project, every returned chapter identifier is unique, and each
 * chapter can be read back by its identifier to recover its original title.
 * The project's chapter list also contains all created identifiers.
 *
 * **Validates: Requirements 2.1**
 *
 * Method (design.md Testing Strategy): end-to-end through a REAL
 * {@link FileDataStore} backed by a unique temp file per run (no mocks), so the
 * round-trip exercises genuine create -> persist -> read-back behavior. A fresh
 * project is created in each run; the temp directory is removed afterwards.
 *
 * Title generator covers the required edge classes: ASCII, full Unicode,
 * graphemes/emoji, special characters, whitespace padded around a meaningful
 * core, and long strings. The service rejects titles that are empty after
 * `trim()`, so every generated title is constructed to contain at least one
 * non-whitespace character (i.e. non-empty after trim). Titles are stored
 * as-given (untrimmed), so the round-trip compares against the original title.
 *
 * Uses fast-check with 100 runs.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from '../../store/FileDataStore.js';
import { ChapterService } from './ChapterService.js';

const NUM_RUNS = 100;

/**
 * A "meaningful" core containing at least one non-whitespace character, so the
 * resulting title is guaranteed non-empty after `trim()`. Covers ASCII, full
 * Unicode, graphemes/emoji, special characters and long strings.
 */
const meaningfulCoreArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ minLength: 1 }),
    fc.string({ unit: 'grapheme', minLength: 1 }),
    fc.string({ unit: 'binary', minLength: 1 }),
    fc.constantFrom(
      '第一章',
      '序章',
      'Chapter 1',
      '世界观设定',
      '日本語のタイトル',
      '😀🎉👨‍👩‍👧‍👦',
      '#特殊@字符!?&',
      'line1\nline2',
      '"quoted"\\slash',
      '长'.repeat(500),
      'A'.repeat(1000),
    ),
  )
  // Guard: a generated string could be entirely whitespace; keep only cores
  // that survive trim so the title is a valid (non-empty) chapter title.
  .filter((s) => s.trim().length > 0);

/** Optional whitespace to pad around the core (exercises whitespace-around). */
const whitespaceArb: fc.Arbitrary<string> = fc.constantFrom(
  '',
  ' ',
  '  ',
  '\t',
  '\n',
  ' \t ',
  '\r\n',
);

/**
 * A non-empty-after-trim chapter title: a meaningful core optionally surrounded
 * by whitespace. The whitespace padding never removes the non-whitespace
 * anchor, so `title.trim()` is always non-empty.
 */
const titleArb: fc.Arbitrary<string> = fc
  .tuple(whitespaceArb, meaningfulCoreArb, whitespaceArb)
  .map(([pre, core, post]) => `${pre}${core}${post}`);

/** A sequence of titles, including the empty-sequence boundary case. */
const titlesArb: fc.Arbitrary<string[]> = fc.array(titleArb, {
  minLength: 0,
  maxLength: 30,
});

describe('ChapterService chapter creation', () => {
  it('Feature: novel-writing-agent, Property 6: 章节创建-读回往返与唯一性', async () => {
    await fc.assert(
      fc.asyncProperty(titlesArb, async (titles) => {
        const dir = await mkdtemp(join(tmpdir(), 'chapter-prop-'));
        try {
          const store = await FileDataStore.create(join(dir, 'store.json'));
          const service = new ChapterService(store);
          const project = await store.createProject('属性测试项目');

          const created: { id: string; title: string }[] = [];
          for (const title of titles) {
            const chapter = await service.create(project.id, title);
            created.push({ id: chapter.id, title });
            // The returned chapter must echo back the exact (untrimmed) title.
            expect(chapter.title).toBe(title);
          }

          // (1) All returned chapter identifiers are unique.
          const ids = created.map((c) => c.id);
          expect(new Set(ids).size).toBe(ids.length);

          // (2) Each chapter can be read back by its id with the same title.
          for (const { id, title } of created) {
            const reread = await store.getChapter(id);
            expect(reread).toBeDefined();
            expect(reread?.id).toBe(id);
            expect(reread?.title).toBe(title);
          }

          // The project's chapter list contains all created identifiers.
          const list = await service.list(project.id);
          const listIds = new Set(list.map((c) => c.id));
          expect(listIds.size).toBe(ids.length);
          for (const id of ids) {
            expect(listIds.has(id)).toBe(true);
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
