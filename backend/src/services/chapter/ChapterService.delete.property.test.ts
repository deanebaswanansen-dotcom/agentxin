/**
 * Property-based test for {@link ChapterService.remove} (task 4.5).
 *
 * Covers design.md Correctness **Property 9: 删除章节仅影响目标章节**
 * (Requirement 2.4):
 *
 *   For any 项目的章节集合与其中任一章节，删除该章节后其不再存在，
 *   且集合中其余章节保持不变。
 *
 * **Validates: Requirements 2.4**
 *
 * Method (design.md Testing Strategy): exercised end-to-end through a REAL
 * {@link FileDataStore} backed by a unique temp file per run (no mocks), with a
 * project created first. For each run we create N chapters (non-empty titles),
 * optionally set some of their contents, snapshot the survivors' identity and
 * content, delete one randomly chosen chapter via the service, then assert:
 *   1. the deleted chapter is gone from the store (`getChapter` -> undefined);
 *   2. the project's chapter list no longer contains it;
 *   3. every surviving chapter is still present with an unchanged
 *      id / title / content / projectId (positions may shift, but the surviving
 *      chapters' identities and contents must be intact).
 *
 * Uses fast-check with >= 100 runs. Generators cover ASCII, Unicode, emoji,
 * whitespace and long strings for both titles and contents.
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
 * Title generator: guarantees a leading non-whitespace character so the title
 * always survives the service's `trim().length > 0` validation, while still
 * exercising Unicode, emoji, whitespace and longer suffixes.
 */
const titleArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('第', 'A', '章', 'x', '标题', '世', '😀', 'Z'),
    fc.oneof(
      fc.string({ maxLength: 30 }),
      fc.string({ unit: 'grapheme', maxLength: 20 }),
      fc.constantFrom('', ' 一', '\t结尾', '😀🎉', '日本語', '   '),
    ),
  )
  .map(([head, rest]) => head + rest);

/**
 * Content generator covering empty, whitespace, special characters, Unicode and
 * longer strings. `undefined` means "leave the chapter's content untouched"
 * (the store defaults new chapters to an empty string).
 */
const contentArb: fc.Arbitrary<string | undefined> = fc.option(
  fc.oneof(
    fc.string(),
    fc.string({ unit: 'grapheme', maxLength: 40 }),
    fc.constantFrom(
      '',
      ' ',
      '\n',
      '正文内容',
      'line1\nline2\r\nline3',
      '"quoted" \\ slash',
      '😀🎉👨‍👩‍👧‍👦',
    ),
    fc.string({ minLength: 100, maxLength: 300 }),
  ),
  { nil: undefined },
);

interface ChapterSpec {
  title: string;
  content: string | undefined;
}

const chapterSpecArb: fc.Arbitrary<ChapterSpec> = fc.record({
  title: titleArb,
  content: contentArb,
});

/** At least one chapter so there is always a deletion target. */
const specsArb: fc.Arbitrary<ChapterSpec[]> = fc.array(chapterSpecArb, {
  minLength: 1,
  maxLength: 8,
});

describe('ChapterService.remove (property)', () => {
  it('Feature: novel-writing-agent, Property 9: 删除章节仅影响目标章节', async () => {
    await fc.assert(
      fc.asyncProperty(
        specsArb,
        fc.nat(),
        async (specs, selector) => {
          // Fresh store + temp file per run for full isolation.
          const dir = await mkdtemp(join(tmpdir(), 'chapter-delete-prop-'));
          try {
            const store = await FileDataStore.create(join(dir, 'store.json'));
            const service = new ChapterService(store);
            const project = await store.createProject('小说项目');
            const projectId = project.id;

            // Create the chapters; optionally set content.
            for (const spec of specs) {
              const chapter = await service.create(projectId, spec.title);
              if (spec.content !== undefined) {
                await service.updateContent(chapter.id, spec.content);
              }
            }

            // Snapshot the full chapter set before deletion.
            const before = await service.list(projectId);
            expect(before.length).toBe(specs.length);

            // Pick a random chapter to delete.
            const targetIndex = selector % before.length;
            const target = before[targetIndex];

            // Capture the survivors' identity + content before deletion.
            const survivors = before
              .filter((c) => c.id !== target.id)
              .map((c) => ({
                id: c.id,
                title: c.title,
                content: c.content,
                projectId: c.projectId,
              }));

            await service.remove(target.id);

            // 1. The deleted chapter no longer exists in the store.
            expect(await store.getChapter(target.id)).toBeUndefined();

            // 2. The project's list no longer contains the deleted chapter, and
            //    its size shrank by exactly one.
            const after = await service.list(projectId);
            expect(after.some((c) => c.id === target.id)).toBe(false);
            expect(after.length).toBe(before.length - 1);

            // 3. Every surviving chapter is still present with an unchanged
            //    id / title / content / projectId.
            for (const expected of survivors) {
              const found = after.find((c) => c.id === expected.id);
              expect(found).toBeDefined();
              expect(found?.title).toBe(expected.title);
              expect(found?.content).toBe(expected.content);
              expect(found?.projectId).toBe(expected.projectId);
            }

            // The surviving id set matches exactly (nothing else removed/added).
            expect(new Set(after.map((c) => c.id))).toEqual(
              new Set(survivors.map((s) => s.id)),
            );
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
