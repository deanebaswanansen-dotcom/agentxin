/**
 * Property-based test for {@link validateBlueprint} scene-count rule.
 *
 * Covers design.md Correctness **Property 5: 场景数量越界校验** (task 4.2;
 * Validates: Requirements 4.2): *For any* blueprint whose every other structural
 * rule is satisfied, `validateBlueprint` accepts it iff the scene count is in
 * `[3, 7]`; a count `< 3` or `> 7` must be rejected with a {@link ServiceError}
 * whose `code === 'VALIDATION_ERROR'`.
 *
 * Isolation strategy (to ensure ONLY the scene-count rule decides the outcome):
 * every scene gets an identical positive-integer `target_words` `W`, all
 * `scene_id`s are made unique (`s-0`, `s-1`, …), and the chapter
 * `target_words` is set to the exact scene sum (`count * W`) so the deviation
 * ratio is exactly 0 (well within the ≤ 0.1 limit). For the empty-scene case
 * the chapter `target_words` is a fixed positive integer, so rule 4.5 (word
 * legality) still passes and the count rule (4.2) is the one that fires.
 *
 * Uses fast-check with >= 100 runs; counts span 0..14 with explicit emphasis on
 * the boundaries 2/3 and 7/8.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { validateBlueprint } from './blueprintValidator.js';
import { isServiceError } from '../ServiceError.js';
import { ERROR_CODES } from '../../types/index.js';
import type { BlueprintCore, Scene } from '../../types/index.js';

const NUM_RUNS = 200;

/** Build a structurally complete {@link Scene} (only id & words matter here). */
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

/**
 * Generates a blueprint that differs ONLY in scene count, paired with whether
 * the count is in the allowed `[3, 7]` range. Counts are biased to hit the
 * boundaries 2/3 and 7/8 while still spanning 0..14.
 */
const sceneCountCaseArb: fc.Arbitrary<{
  core: BlueprintCore;
  expectedValid: boolean;
}> = fc
  .record({
    count: fc.oneof(
      fc.integer({ min: 0, max: 14 }),
      fc.constantFrom(0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    ),
    wordsPerScene: fc.integer({ min: 1, max: 100_000 }),
  })
  .map(({ count, wordsPerScene }) => {
    const scenes: Scene[] = Array.from({ length: count }, (_unused, i) =>
      makeScene(`s-${i}`, wordsPerScene),
    );
    // count === 0 → no scene sum; use a fixed positive integer so rule 4.5
    // (chapter target_words positive integer) passes and 4.2 is what fires.
    const chapterTargetWords = count > 0 ? count * wordsPerScene : 1000;
    const core: BlueprintCore = {
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
    return { core, expectedValid: count >= 3 && count <= 7 };
  });

describe('blueprintValidator scene-count property test', () => {
  it('Feature: chapter-blueprint, Property 5: 场景数量越界校验', () => {
    fc.assert(
      fc.property(sceneCountCaseArb, ({ core, expectedValid }) => {
        if (expectedValid) {
          // In range [3,7] with all other rules satisfied → must be accepted.
          expect(() => validateBlueprint(core)).not.toThrow();
        } else {
          // < 3 or > 7 → must be rejected as VALIDATION_ERROR.
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
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
