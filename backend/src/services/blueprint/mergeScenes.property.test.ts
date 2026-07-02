/**
 * Property-based test for {@link mergeScenes} (and the {@link compareSceneId}
 * ordering it relies on).
 *
 * Covers design.md Correctness **Property 12: 章节合并为 scene_id 升序拼接**
 * (task 5.5; Validates: Requirements 7.3, 8.2): *For any* list of
 * `{ scene_id, content }` parts, `mergeScenes` joins the contents in ascending
 * `scene_id` order with a fixed separator, independently of the input order
 * (order-independent & deterministic).
 *
 * Oracle strategy: the spec defines the merged chapter as the scene contents
 * concatenated in `compareSceneId` ascending order with the `\n\n` separator.
 * Two independent oracles are used:
 *   1. Order independence: applying `mergeScenes` to any two permutations of the
 *      same parts yields identical output.
 *   2. Explicit sort: the output equals the contents of an explicitly
 *      `compareSceneId`-sorted copy joined with `\n\n`.
 *
 * To avoid ambiguity from sort stability when two parts share a `scene_id`
 * (their relative order is then input-dependent), `scene_id`s are generated
 * pairwise-distinct. The non-empty separator `\n\n` makes the join unambiguous.
 *
 * Generators cover content spanning empty / whitespace / Unicode / emoji / long
 * strings, scene_ids with embedded numbers (to exercise numeric-aware ordering,
 * e.g. "scene-2" before "scene-10"), and lists of varying length.
 *
 * Uses fast-check with >= 100 runs.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { mergeScenes, compareSceneId } from './mergeScenes.js';

const NUM_RUNS = 300;
const SEPARATOR = '\n\n';

interface Part {
  scene_id: string;
  content: string;
}

const contentArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.constantFrom('   ', '\t', '\u3000'),
  fc.string(),
  fc.fullUnicodeString(),
  fc.constantFrom('汉字内容', '😀🎉👍', '👨‍👩‍👧 family'),
  fc.array(fc.constantFrom('a', '字', '😀'), { minLength: 100, maxLength: 300 }).map((c) => c.join('')),
);

/**
 * scene_id arbitrary mixing numbered ids (exercise numeric-aware ordering) and
 * arbitrary strings. Uniqueness is enforced at the list level below.
 */
const sceneIdArb: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 0, max: 999 }).map((n) => `scene-${n}`),
  fc.integer({ min: 0, max: 999 }).map((n) => `${n}`),
  fc.string({ minLength: 1, maxLength: 6 }),
);

/** Knuth-style deterministic shuffle driven by a fast-check permutation seed. */
function permute<T>(items: readonly T[], order: readonly number[]): T[] {
  // `order` is a permutation of indices [0, n); map through it.
  return order.map((i) => items[i]);
}

/**
 * Generates parts with pairwise-distinct `scene_id`s plus two index
 * permutations of the same parts, so we can assert order-independence.
 */
const mergeCaseArb = fc
  .uniqueArray(sceneIdArb, { minLength: 1, maxLength: 8, selector: (id) => id })
  .chain((ids) =>
    fc
      .record({
        contents: fc.array(contentArb, {
          minLength: ids.length,
          maxLength: ids.length,
        }),
        permA: indexPermutation(ids.length),
        permB: indexPermutation(ids.length),
      })
      .map(({ contents, permA, permB }) => {
        const parts: Part[] = ids.map((scene_id, i) => ({
          scene_id,
          content: contents[i],
        }));
        return { parts, permA, permB };
      }),
  );

/** Arbitrary producing a permutation (array of distinct indices) of [0, n). */
function indexPermutation(n: number): fc.Arbitrary<number[]> {
  const base = Array.from({ length: n }, (_unused, i) => i);
  if (n <= 1) {
    return fc.constant(base);
  }
  // Use shuffledSubarray to obtain a random full-length permutation.
  return fc.shuffledSubarray(base, { minLength: n, maxLength: n });
}

describe('mergeScenes property test', () => {
  it('Feature: chapter-blueprint, Property 12: 章节合并为 scene_id 升序拼接', () => {
    fc.assert(
      fc.property(mergeCaseArb, ({ parts, permA, permB }) => {
        const arrangedA = permute(parts, permA);
        const arrangedB = permute(parts, permB);

        const outputA = mergeScenes(arrangedA);
        const outputB = mergeScenes(arrangedB);

        // 1) Order independence: any permutation yields the same merged text.
        expect(outputA).toBe(outputB);

        // 2) Explicit-sort oracle: equals compareSceneId-sorted contents joined.
        const expected = [...parts]
          .sort((a, b) => compareSceneId(a.scene_id, b.scene_id))
          .map((p) => p.content)
          .join(SEPARATOR);
        expect(outputA).toBe(expected);

        // 3) Determinism: same input → same output.
        expect(mergeScenes(arrangedA)).toBe(outputA);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Feature: chapter-blueprint, Property 12: 章节合并为 scene_id 升序拼接 (empty list → empty string)', () => {
    expect(mergeScenes([])).toBe('');
  });
});
