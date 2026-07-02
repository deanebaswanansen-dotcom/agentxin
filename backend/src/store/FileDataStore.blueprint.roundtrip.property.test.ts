/**
 * Property-based test for {@link FileDataStore} chapter-blueprint persistence
 * (task 2.7).
 *
 * Covers design.md Correctness **Property 13: 蓝图持久化替换与读回往返**
 * (Validates: Requirements 5.1, 5.2, 5.3): *For any* chapter and two valid
 * blueprints saved for it in turn, after the second save the data store keeps
 * exactly ONE blueprint associated with that chapter and
 * `getChapterBlueprintByChapter` reads back a blueprint that field-for-field
 * equals the second one.
 *
 * Method:
 *   1. Create a real project + two real chapters so the blueprints reference
 *      genuine `chapter_id`s (the store keys blueprints by `chapter_id`).
 *   2. Save blueprint #1 then blueprint #2 for chapter A, plus a third
 *      blueprint for chapter B (a control to prove queries do not cross-talk).
 *   3. Assert `getChapterBlueprintByChapter(A)` deep-equals blueprint #2 (so
 *      the second save REPLACED the first — Requirements 5.1/5.2) and
 *      `getChapterBlueprintByChapter(B)` deep-equals B's blueprint (no
 *      cross-contamination between chapters).
 *   4. Read the persisted JSON file directly and assert chapter A is associated
 *      with exactly one stored blueprint (Requirement 5.3 — at most one per
 *      chapter), and the total stored count is two (A + B).
 *
 * Uses fast-check. Because every run performs real filesystem I/O (mkdtemp +
 * several atomic writes + recursive cleanup), runs are capped at 40 — enough to
 * exercise the generators' edge classes while keeping wall-clock reasonable.
 * Every run gets its OWN temp directory (created inside the predicate) which is
 * removed in a `finally` block, so runs never contaminate each other and no
 * leftover files remain.
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from './FileDataStore.js';
import type { ChapterBlueprint, Scene } from '../types/index.js';

// File I/O per run -> keep runs modest (design.md Testing Strategy: 文件 IO 取 30-50).
const NUM_RUNS = 40;

/**
 * Text generator covering the required edge classes: ASCII (incl. empty),
 * full Unicode code points, printable graphemes/emoji, hand-picked
 * whitespace / structural-marker strings, and longer strings.
 */
const textArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '',
    ' ',
    '\n',
    '\t',
    '   \n\t  ',
    '第一章',
    '林夜与星辰之海',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2\r\nline3',
    '"quoted" <tag> & ampersand \\backslash',
    '{"looks":"like json"}',
  ),
  fc.string({ minLength: 100, maxLength: 300 }),
);

/** Arbitrary string[] field (covers the empty-array edge via maxLength incl. 0). */
const stringArrayArb: fc.Arbitrary<string[]> = fc.array(textArb, {
  maxLength: 5,
});

/** Positive-integer word counts (Requirement 4.5). */
const positiveIntArb: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: 1_000_000,
});

/**
 * High-entropy scene id generator so a unique 3–7 scene array is easy to
 * sample (uniqueness is enforced via `uniqueArray`'s selector below).
 */
const sceneIdArb: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 16,
});

const sceneArb: fc.Arbitrary<Scene> = fc.record({
  scene_id: sceneIdArb,
  name: textArb,
  target_words: positiveIntArb,
  location: textArb,
  characters: stringArrayArb,
  purpose: textArb,
  emotion: textArb,
  pacing: textArb,
  must_include: stringArrayArb,
  ending_state: textArb,
});

/** Blueprint body (everything except `chapter_id`, which is bound to a real id). */
type BlueprintBody = Omit<ChapterBlueprint, 'chapter_id'>;

const blueprintBodyArb: fc.Arbitrary<BlueprintBody> = fc.record({
  title: textArb,
  target_words: positiveIntArb,
  main_goal: textArb,
  tone: textArb,
  pacing: textArb,
  required_plot_points: stringArrayArb,
  forbidden_points: stringArrayArb,
  emotional_curve: textArb,
  // 3–7 scenes with unique scene_id (Requirements 4.2 / 4.4).
  scenes: fc.uniqueArray(sceneArb, {
    minLength: 3,
    maxLength: 7,
    selector: (s) => s.scene_id,
  }),
  ending_hook: textArb,
});

describe('FileDataStore chapter-blueprint persistence property test', () => {
  it('Feature: chapter-blueprint, Property 13: 蓝图持久化替换与读回往返', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          first: blueprintBodyArb,
          second: blueprintBodyArb,
          other: blueprintBodyArb,
        }),
        async ({ first, second, other }) => {
          const dir = await mkdtemp(join(tmpdir(), 'fds-bp-rt-'));
          const file = join(dir, 'store.json');
          try {
            const store = await FileDataStore.create(file);
            const project = await store.createProject('p');
            const chapterA = await store.createChapter(project.id, 'A');
            const chapterB = await store.createChapter(project.id, 'B');

            const blueprintA1: ChapterBlueprint = {
              chapter_id: chapterA.id,
              ...first,
            };
            const blueprintA2: ChapterBlueprint = {
              chapter_id: chapterA.id,
              ...second,
            };
            const blueprintB: ChapterBlueprint = {
              chapter_id: chapterB.id,
              ...other,
            };

            // Save two blueprints for chapter A in turn, plus one for B.
            await store.saveChapterBlueprint(blueprintA1);
            await store.saveChapterBlueprint(blueprintA2);
            await store.saveChapterBlueprint(blueprintB);

            // Read-back for A equals the SECOND blueprint (replacement), and
            // for B equals B's blueprint (no cross-contamination).
            const readA = await store.getChapterBlueprintByChapter(chapterA.id);
            const readB = await store.getChapterBlueprintByChapter(chapterB.id);
            expect(readA).toEqual(blueprintA2);
            expect(readB).toEqual(blueprintB);

            // Exactly one blueprint persisted per chapter (Requirement 5.3):
            // inspect the on-disk JSON directly.
            const persisted = JSON.parse(await readFile(file, 'utf8')) as {
              chapterBlueprints: ChapterBlueprint[];
            };
            const forA = persisted.chapterBlueprints.filter(
              (b) => b.chapter_id === chapterA.id,
            );
            expect(forA).toHaveLength(1);
            expect(forA[0]).toEqual(blueprintA2);
            // Only A's and B's blueprints exist — no orphan/duplicate rows.
            expect(persisted.chapterBlueprints).toHaveLength(2);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);
});
