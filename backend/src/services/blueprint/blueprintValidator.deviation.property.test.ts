/**
 * Property-based test for {@link validateBlueprint} word-budget deviation rule
 * and {@link deviationRatio}.
 *
 * Covers design.md Correctness **Property 6: 字数分配偏差校验** (task 4.3;
 * Validates: Requirements 4.1, 4.3): *For any* blueprint with 3–7 scenes, unique
 * `scene_id`s and positive-integer word counts, let `S` be the sum of scene
 * `target_words` and `T` the chapter `target_words`. Then:
 *   - `deviationRatio(core)` equals `|S − T| / T`; and
 *   - `validateBlueprint` rejects (VALIDATION_ERROR) iff `|S − T| / T` is
 *     *strictly* greater than `0.1`, accepting it when `≤ 0.1` (incl. exactly
 *     `0.1`).
 *
 * Isolation strategy: scene count is fixed to `[3, 7]`, all `scene_id`s unique,
 * and the scene sum `S` is partitioned into positive integers, so rules 4.2 /
 * 4.4 / 4.5 always pass and ONLY the deviation rule (4.3) decides the outcome.
 *
 * Generators deliberately produce samples on BOTH sides of the threshold,
 * including exactly `0.1` (passes) and just over `0.1` (rejected), via
 * tenth-aligned chapter targets (`T = 10k`).
 *
 * Uses fast-check with >= 100 runs.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { validateBlueprint, deviationRatio } from './blueprintValidator.js';
import { isServiceError } from '../ServiceError.js';
import { ERROR_CODES } from '../../types/index.js';
import type { BlueprintCore, Scene } from '../../types/index.js';

const NUM_RUNS = 300;

/** Partition `sum` into exactly `n` positive integers (requires `sum >= n`). */
function partition(sum: number, n: number): number[] {
  const parts = new Array<number>(n).fill(1);
  parts[0] = sum - (n - 1); // first absorbs the remainder; rest are 1
  return parts;
}

/** Build a blueprint with `n` unique scenes carrying the given word counts. */
function makeCore(chapterTargetWords: number, sceneWords: number[]): BlueprintCore {
  const scenes: Scene[] = sceneWords.map((words, i) => ({
    scene_id: `s-${i}`,
    name: '场景',
    target_words: words,
    location: '地点',
    characters: [],
    purpose: '目的',
    emotion: '情绪',
    pacing: '节奏',
    must_include: [],
    ending_state: '结束状态',
  }));
  return {
    chapter_id: 'chapter-1',
    title: '章节标题',
    target_words: chapterTargetWords,
    main_goal: '主目标',
    tone: '基调',
    pacing: '节奏',
    required_plot_points: [],
    forbidden_points: [],
    emotional_curve: '情绪曲线',
    scenes,
    ending_hook: '钩子',
  };
}

const sceneCountArb = fc.integer({ min: 3, max: 7 });

/**
 * Produces `{ T, S }` pairs covering: random-within-tolerance, random-over-
 * tolerance (both directions), exactly-0.1 (both directions, via T = 10k), and
 * just-over-0.1 (both directions). `S >= n` is guaranteed in every branch so it
 * can always be partitioned into `n` positive integers.
 */
function targetSumArb(n: number): fc.Arbitrary<{ T: number; S: number }> {
  // within tolerance: |delta| <= floor(0.1*T) ⇒ ratio <= 0.1
  const within = fc
    .record({ T: fc.integer({ min: 100, max: 1_000_000 }), sign: fc.boolean() })
    .chain(({ T, sign }) => {
      const maxDelta = Math.floor(0.1 * T);
      return fc.integer({ min: 0, max: maxDelta }).map((mag) => ({
        T,
        S: sign ? T + mag : T - mag, // T - mag >= 0.9T >= 90 >= n
      }));
    });

  // over tolerance: |delta| > floor(0.1*T) ⇒ ratio > 0.1
  const over = fc
    .record({ T: fc.integer({ min: 100, max: 1_000_000 }), sign: fc.boolean() })
    .chain(({ T, sign }) => {
      const minMag = Math.floor(0.1 * T) + 1;
      if (sign) {
        // high side: S can be much larger than T
        return fc
          .integer({ min: minMag, max: 5 * T })
          .map((mag) => ({ T, S: T + mag }));
      }
      // low side: keep S >= n
      return fc
        .integer({ min: minMag, max: T - n })
        .map((mag) => ({ T, S: T - mag }));
    });

  // exactly 0.1 (passes, not strictly greater): T = 10k, |delta| = k
  const exact = fc
    .record({ k: fc.integer({ min: 1, max: 100_000 }), sign: fc.boolean() })
    .map(({ k, sign }) => {
      const T = 10 * k;
      return { T, S: sign ? T + k : T - k }; // ratio = k/(10k) = 0.1 exactly
    });

  // just over 0.1 (rejected): T = 10k, |delta| = k + 1 ⇒ ratio = (k+1)/(10k)
  const justOver = fc
    .record({ k: fc.integer({ min: 1, max: 100_000 }), sign: fc.boolean() })
    .map(({ k, sign }) => {
      const T = 10 * k;
      return { T, S: sign ? T + k + 1 : T - (k + 1) }; // T-(k+1)=9k-1 >= n
    });

  return fc.oneof(within, over, exact, justOver);
}

const deviationCaseArb: fc.Arbitrary<BlueprintCore> = sceneCountArb.chain((n) =>
  targetSumArb(n).map(({ T, S }) => makeCore(T, partition(S, n))),
);

describe('blueprintValidator deviation property test', () => {
  it('Feature: chapter-blueprint, Property 6: 字数分配偏差校验', () => {
    fc.assert(
      fc.property(deviationCaseArb, (core) => {
        const S = core.scenes.reduce((sum, s) => sum + s.target_words, 0);
        const T = core.target_words;
        const expectedRatio = Math.abs(S - T) / T;

        // deviationRatio must equal |S - T| / T (float-tolerant compare).
        expect(deviationRatio(core)).toBeCloseTo(expectedRatio, 10);

        // Rule 4.3: reject strictly > 0.1, accept otherwise (incl. == 0.1).
        if (expectedRatio > 0.1) {
          let thrown: unknown;
          try {
            validateBlueprint(core);
          } catch (error) {
            thrown = error;
          }
          expect(isServiceError(thrown)).toBe(true);
          expect((thrown as { code: string }).code).toBe(
            ERROR_CODES.VALIDATION_ERROR,
          );
        } else {
          expect(() => validateBlueprint(core)).not.toThrow();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
