/**
 * Property-based test for chapter reordering through {@link ChapterService}.
 *
 * Covers design.md Correctness **Property 10: 章节排序为提供顺序的置换往返**
 * (task 4.6; Requirement 2.5): for any arrangement (permutation) of a project's
 * existing chapter identifiers, submitting that arrangement as a reorder request
 * makes {@link ChapterService.list} return the chapters in exactly that order.
 *
 * Method (design.md Testing Strategy): exercised end-to-end through a real
 * {@link FileDataStore} (no mocks) backed by a UNIQUE temp file per run, so the
 * full create -> reorder -> list path goes through genuine persistence. A fresh
 * project is created for every run and the temp directory is removed afterward.
 *
 * Generators: 1..8 chapters with non-empty titles (covering ASCII, Unicode,
 * whitespace-padded and longer strings via a guaranteed non-whitespace head),
 * and an arbitrary full-length permutation of the created chapters' indices —
 * mapped at runtime to the store-assigned UUIDs.
 *
 * Uses fast-check with 100 runs (design.md: >= 100 iterations per property).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from '../../store/FileDataStore.js';
import { ChapterService } from './ChapterService.js';

const NUM_RUNS = 100;

/**
 * Title generator that is guaranteed non-empty after trim (the service rejects
 * whitespace-only titles). A non-whitespace leading character is prepended to a
 * free-form tail that covers Unicode, whitespace and longer strings.
 */
const titleArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('第', 'A', '章', 'X', 'Z', '1', '序', '🜲'),
    fc.string({ maxLength: 40 }),
  )
  .map(([head, tail]) => head + tail);

/**
 * Generate a list of chapter titles together with an arbitrary full-length
 * permutation of their indices. The permutation is a shuffled subarray of the
 * full index set `[0, n)`, i.e. it contains every index exactly once.
 */
const scenarioArb = fc
  .array(titleArb, { minLength: 1, maxLength: 8 })
  .chain((titles) => {
    const indices = titles.map((_, i) => i);
    return fc.record({
      titles: fc.constant(titles),
      permutation: fc.shuffledSubarray(indices, {
        minLength: indices.length,
        maxLength: indices.length,
      }),
    });
  });

describe('ChapterService.reorder', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chapter-reorder-prop-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('Feature: novel-writing-agent, Property 10: 章节排序为提供顺序的置换往返', async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ titles, permutation }) => {
        // Fresh store backed by a unique temp file for every run.
        run += 1;
        const filePath = join(dir, `store-${run}.json`);
        const store = await FileDataStore.create(filePath);
        const service = new ChapterService(store);

        const project = await store.createProject('小说项目');

        // Create chapters in order; capture the store-assigned ids.
        const createdIds: string[] = [];
        for (const title of titles) {
          const chapter = await service.create(project.id, title);
          createdIds.push(chapter.id);
        }

        // Submit the permutation of existing ids as the desired order.
        const permutedIds = permutation.map((index) => createdIds[index]);
        await service.reorder(project.id, permutedIds);

        // The list must come back in exactly the requested permutation order.
        const listed = await service.list(project.id);
        expect(listed.map((c) => c.id)).toEqual(permutedIds);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
