/**
 * Property-based test for {@link validateBlueprint} word-legality rule.
 *
 * Covers design.md Correctness **Property 8: 非正整数字数校验** (task 4.5;
 * Validates: Requirements 4.5): *For any* blueprint in which the chapter
 * `target_words` OR at least one scene `target_words` is not a positive integer
 * (i.e. `0`, negative, non-integer/decimal, or `NaN`/non-finite),
 * `validateBlueprint` rejects it with a {@link ServiceError} whose
 * `code === 'VALIDATION_ERROR'`.
 *
 * Construction: start from a valid baseline (3–7 unique scenes, deviation 0),
 * then corrupt exactly one word-count field — either the chapter's or a single
 * scene's — to a non-positive-integer value. Because rule 4.5 runs FIRST in
 * `validateBlueprint`, the corruption is guaranteed to be what triggers the
 * rejection regardless of the other rules.
 *
 * Uses fast-check with >= 100 runs; the illegal-value generator covers 0,
 * negatives, decimals, and `NaN` / `±Infinity`.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { validateBlueprint } from './blueprintValidator.js';
import { isServiceError } from '../ServiceError.js';
import { ERROR_CODES } from '../../types/index.js';
import type { BlueprintCore, Scene } from '../../types/index.js';

const NUM_RUNS = 300;

function makeScene(sceneId: string, targetWords: number): Scene {
  return {
    scene_id: sceneId,
    name: '场景',
    target_words: targetWords,
    location: '地点',
    characters: [],
    purpose: '目的',
    emotion: '情绪',
    pacing: '节奏',
    must_include: [],
    ending_state: '结束状态',
  };
}

/** A valid baseline blueprint: 3–7 unique scenes, equal words, deviation 0. */
const baselineArb: fc.Arbitrary<{ core: BlueprintCore; count: number }> = fc
  .record({
    count: fc.integer({ min: 3, max: 7 }),
    words: fc.integer({ min: 1, max: 100_000 }),
  })
  .map(({ count, words }) => {
    const scenes = Array.from({ length: count }, (_unused, i) =>
      makeScene(`s-${i}`, words),
    );
    const core: BlueprintCore = {
      chapter_id: 'chapter-1',
      title: '章节标题',
      target_words: count * words,
      main_goal: '主目标',
      tone: '基调',
      pacing: '节奏',
      required_plot_points: [],
      forbidden_points: [],
      emotional_curve: '情绪曲线',
      scenes,
      ending_hook: '钩子',
    };
    return { core, count };
  });

/** Non-positive-integer word counts: 0, negatives, decimals, NaN/±Infinity. */
const illegalWordsArb: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: -1_000_000, max: -1 }),
  // decimals strictly between integers (non-integer finite values)
  fc.double({ min: 0.0001, max: 100_000, noInteger: true, noNaN: true }),
  fc.constantFrom(
    NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0.5,
    -0.5,
    -0,
    1.0001,
    -1000.75,
  ),
);

/**
 * Take a valid baseline and corrupt exactly one word field to an illegal value:
 * either the chapter `target_words` or a single scene's `target_words`.
 */
const corruptedCaseArb: fc.Arbitrary<BlueprintCore> = baselineArb.chain(
  ({ core, count }) =>
    fc
      .record({
        bad: illegalWordsArb,
        // -1 → corrupt the chapter; 0..count-1 → corrupt that scene index
        targetIndex: fc.integer({ min: -1, max: count - 1 }),
      })
      .map(({ bad, targetIndex }) => {
        const scenes = core.scenes.map((s) => ({ ...s }));
        let chapterTargetWords = core.target_words;
        if (targetIndex === -1) {
          chapterTargetWords = bad;
        } else {
          scenes[targetIndex] = { ...scenes[targetIndex], target_words: bad };
        }
        return { ...core, target_words: chapterTargetWords, scenes };
      }),
);

describe('blueprintValidator positive-integer word-count property test', () => {
  it('Feature: chapter-blueprint, Property 8: 非正整数字数校验', () => {
    fc.assert(
      fc.property(corruptedCaseArb, (core) => {
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
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
