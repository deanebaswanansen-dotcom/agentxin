/**
 * Property-based test for {@link validateBlueprint} `scene_id` uniqueness rule.
 *
 * Covers design.md Correctness **Property 7: 重复 scene_id 校验** (task 4.4;
 * Validates: Requirements 4.4): *For any* blueprint with 3–7 scenes, positive-
 * integer word counts and deviation ratio 0, `validateBlueprint` rejects it with
 * a {@link ServiceError} (`code === 'VALIDATION_ERROR'`) when at least one
 * `scene_id` is duplicated, and does NOT reject on account of this rule when all
 * `scene_id`s are pairwise distinct.
 *
 * Isolation strategy: every scene shares the same positive-integer
 * `target_words` `W` and the chapter `target_words` is the exact sum
 * (`count * W`), so the deviation ratio is exactly 0; the scene count is fixed
 * to `[3, 7]`. Thus rules 4.5 / 4.2 / 4.3 always pass and ONLY the uniqueness
 * rule (4.4) governs the outcome. The duplicate case forces a collision by
 * overwriting one scene's id with another's.
 *
 * Uses fast-check with >= 100 runs; ids are drawn from a small alphabet to make
 * natural collisions likely and the forced-duplicate case explicit.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { validateBlueprint } from './blueprintValidator.js';
import { isServiceError } from '../ServiceError.js';
import { ERROR_CODES } from '../../types/index.js';
import type { BlueprintCore, Scene } from '../../types/index.js';

const NUM_RUNS = 200;

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

function makeCore(sceneIds: string[], wordsPerScene: number): BlueprintCore {
  const scenes = sceneIds.map((id) => makeScene(id, wordsPerScene));
  return {
    chapter_id: 'chapter-1',
    title: '章节标题',
    target_words: sceneIds.length * wordsPerScene, // deviation ratio = 0
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

const sceneIdAlphabet = fc.constantFrom('a', 'b', 'c', 'd', 'e');
const wordsArb = fc.integer({ min: 1, max: 100_000 });

/**
 * Distinct-ids case: 3–7 pairwise-distinct `scene_id`s. Must NOT be rejected on
 * account of the uniqueness rule (all other rules pass by construction).
 */
const distinctCaseArb: fc.Arbitrary<BlueprintCore> = fc
  .record({
    count: fc.integer({ min: 3, max: 7 }),
    words: wordsArb,
  })
  .map(({ count, words }) => {
    const ids = Array.from({ length: count }, (_unused, i) => `scene-${i}`);
    return makeCore(ids, words);
  });

/**
 * Duplicate-ids case: 3–7 scenes where one id is overwritten with another's,
 * guaranteeing at least one duplicate pair. Must be rejected (VALIDATION_ERROR).
 */
const duplicateCaseArb: fc.Arbitrary<BlueprintCore> = fc
  .integer({ min: 3, max: 7 })
  .chain((count) =>
    fc
      .record({
        ids: fc.array(sceneIdAlphabet, { minLength: count, maxLength: count }),
        words: wordsArb,
        from: fc.integer({ min: 0, max: count - 1 }),
        to: fc.integer({ min: 0, max: count - 1 }),
      })
      .map(({ ids, words, from, to }) => {
        const dupIds = [...ids];
        // Force a collision: copy the id at `from` into a different slot `to`.
        const target = to === from ? (to + 1) % count : to;
        dupIds[target] = dupIds[from];
        return makeCore(dupIds, words);
      }),
  );

describe('blueprintValidator duplicate scene_id property test', () => {
  it('Feature: chapter-blueprint, Property 7: 重复 scene_id 校验', () => {
    fc.assert(
      fc.property(duplicateCaseArb, (core) => {
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

  it('Feature: chapter-blueprint, Property 7: 重复 scene_id 校验 (distinct ids accepted)', () => {
    fc.assert(
      fc.property(distinctCaseArb, (core) => {
        // All ids distinct + every other rule satisfied → not rejected.
        expect(() => validateBlueprint(core)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
