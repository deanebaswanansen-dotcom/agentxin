/**
 * Property-based test for {@link ChapterService} chapter ordering.
 *
 * Covers design.md Correctness **Property 7: 章节列表按 position 升序**
 * (task 4.3; Requirement 2.2): for any project and any chapter set produced by
 * an arbitrary number of create and reorder operations, the chapter list
 * returned by {@link ChapterService.list} must have a `position` field that is
 * monotonically non-decreasing (each position >= the previous one).
 *
 * Method (design.md Testing Strategy): exercised end-to-end through a REAL
 * {@link FileDataStore} backed by a UNIQUE temp file per fast-check run (no
 * mocks), with a fresh project created each run. Each run:
 *   1. creates N chapters with non-empty titles (recording their ids in
 *      creation order), then
 *   2. applies M reorder operations, each a random permutation of the current
 *      chapter ids (generated with `fc.shuffledSubarray`).
 * After all operations, `service.list(projectId)` is asserted to be sorted by
 * `position` ascending. When at least one reorder was applied, the returned id
 * order is additionally asserted to equal the LAST reorder's permutation.
 *
 * Uses fast-check with >= 100 runs. The chapter count, the titles (covering
 * ASCII, Unicode, whitespace and structural-marker edge classes — always
 * non-empty so creation is accepted) and the reorder permutations are all
 * randomized.
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
 * A title generator guaranteed to be non-empty after trimming (so the service's
 * `VALIDATION_ERROR` guard never rejects it). A non-whitespace leading marker is
 * always prepended; the trailing segment covers ASCII, Unicode, whitespace and
 * structural markers via `fc.string`.
 */
const nonEmptyTitleArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('第', '章', 'A', '序', '卷', '😀', 'Z'),
    fc.oneof(
      fc.string({ maxLength: 20 }),
      fc.string({ unit: 'grapheme', maxLength: 12 }),
      fc.constantFrom('', ' ', '\n\t', '一', '【标题】', 'line1\nline2'),
    ),
  )
  .map(([head, tail]) => `${head}${tail}`);

/** Build the index array [0, 1, ..., k-1]. */
function range(k: number): number[] {
  return Array.from({ length: k }, (_, i) => i);
}

/**
 * A full permutation (shuffle) of [0, k-1]: a shuffled subarray whose length is
 * pinned to the full size returns every index exactly once in random order.
 */
function permutationArb(k: number): fc.Arbitrary<number[]> {
  return fc.shuffledSubarray(range(k), { minLength: k, maxLength: k });
}

/**
 * Operation plan for one run: N chapters (with N titles) plus M reorder
 * permutations over the index space [0, N-1]. Generated via `chain` so the
 * permutation size matches the chapter count.
 */
const planArb = fc.integer({ min: 1, max: 8 }).chain((n) =>
  fc.record({
    titles: fc.array(nonEmptyTitleArb, { minLength: n, maxLength: n }),
    reorders: fc.array(permutationArb(n), { maxLength: 6 }),
  }),
);

describe('ChapterService chapter ordering property test', () => {
  it('Feature: novel-writing-agent, Property 7: 章节列表按 position 升序', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async ({ titles, reorders }) => {
        // Fresh, isolated store on a unique temp file for this run.
        const dir = await mkdtemp(join(tmpdir(), 'chapter-order-pbt-'));
        try {
          const store = await FileDataStore.create(join(dir, 'store.json'));
          const service = new ChapterService(store);
          const project = await store.createProject('排序属性测试项目');

          // 1. Create N chapters; record their ids in creation order.
          const createdIds: string[] = [];
          for (const title of titles) {
            const chapter = await service.create(project.id, title);
            createdIds.push(chapter.id);
          }

          // 2. Apply M reorder operations, each a permutation of the chapter ids.
          let lastOrderedIds: string[] | null = null;
          for (const perm of reorders) {
            const orderedIds = perm.map((idx) => createdIds[idx]);
            await service.reorder(project.id, orderedIds);
            lastOrderedIds = orderedIds;
          }

          // 3. The list must be sorted by position ascending (monotonic
          //    non-decreasing), regardless of how many ops were applied.
          const list = await service.list(project.id);
          for (let i = 1; i < list.length; i += 1) {
            expect(list[i].position).toBeGreaterThanOrEqual(
              list[i - 1].position,
            );
          }

          // The list always reflects every created chapter exactly once.
          expect(list).toHaveLength(createdIds.length);

          // 4. When a reorder was applied, the returned order must match the
          //    last permutation submitted.
          if (lastOrderedIds !== null) {
            expect(list.map((c) => c.id)).toEqual(lastOrderedIds);
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
