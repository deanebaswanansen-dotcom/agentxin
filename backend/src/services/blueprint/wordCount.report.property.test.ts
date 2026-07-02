/**
 * Property-based test for {@link buildWordCountReport} scene-level statistics.
 *
 * Covers design.md Correctness **Property 10: 扩写建议触发与建议字数** (task 5.3;
 * Validates: Requirements 9.2, 9.3): *For any* `BlueprintCore` (3–7 scenes,
 * unique `scene_id`s, positive-integer `target_words`) and any
 * `draftsBySceneId` map (some scenes may have no draft), for every scene:
 *   - `actualWords` equals `countActualWords(content)` (0 when no draft); and
 *   - `delta` equals `actualWords − targetWords`; and
 *   - `needsExpansion` is true *iff* `(target − actual) / target ≥ 0.15`; and
 *   - `suggestedExpansion` equals `target − actual` when `needsExpansion`, else 0.
 *
 * Oracle strategy: per-scene values are recomputed directly from the spec
 * formula (需求 9.2/9.3). `actualWords` uses `countActualWords` as the spec
 * defines actual word count by that function; the expansion threshold/amount
 * are derived independently of the SUT's branch structure. Generators include
 * scenes that are far below target (trigger expansion), exactly at the 0.15
 * boundary, and at/above target (no expansion), plus scenes with no draft.
 *
 * Uses fast-check with >= 100 runs.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { buildWordCountReport, countActualWords } from './wordCount.js';
import type { BlueprintCore, Scene } from '../../types/index.js';

const NUM_RUNS = 300;
const EXPANSION_THRESHOLD = 0.15;

/** Content arbitrary covering empty / whitespace / Unicode / emoji / long. */
const contentArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.constantFrom('   ', '\n\n', '\t \u3000'),
  fc.string(),
  fc.fullUnicodeString(),
  fc.constantFrom('汉字内容', '😀🎉👍', '👨‍👩‍👧 family'),
  // long string of non-whitespace code points so its actual count is sizeable
  fc.array(fc.constantFrom('a', '字', '😀'), { minLength: 200, maxLength: 400 }).map((c) => c.join('')),
);

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

function makeCore(scenes: Scene[], chapterTargetWords: number): BlueprintCore {
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

/**
 * Generates a `{ core, drafts }` pair: 3–7 unique scenes with positive-integer
 * `target_words`; each scene independently either has a draft (random content)
 * or no draft at all (→ actualWords 0). Some contents are tuned to land below /
 * around / above their target to exercise both branches of `needsExpansion`.
 */
const reportCaseArb: fc.Arbitrary<{
  core: BlueprintCore;
  drafts: ReadonlyMap<string, string>;
}> = fc
  .integer({ min: 3, max: 7 })
  .chain((count) =>
    fc
      .array(
        fc.record({
          target: fc.integer({ min: 1, max: 100_000 }),
          hasDraft: fc.boolean(),
          content: contentArb,
        }),
        { minLength: count, maxLength: count },
      )
      .map((specs) => {
        const scenes = specs.map((spec, i) => makeScene(`scene-${i}`, spec.target));
        const drafts = new Map<string, string>();
        specs.forEach((spec, i) => {
          if (spec.hasDraft) {
            drafts.set(`scene-${i}`, spec.content);
          }
        });
        const chapterTarget =
          specs.reduce((sum, s) => sum + s.target, 0) || 1;
        return { core: makeCore(scenes, chapterTarget), drafts };
      }),
  );

describe('wordCount buildWordCountReport scene-level property test', () => {
  it('Feature: chapter-blueprint, Property 10: 扩写建议触发与建议字数', () => {
    fc.assert(
      fc.property(reportCaseArb, ({ core, drafts }) => {
        const report = buildWordCountReport(core, drafts);

        // One SceneWordCount per blueprint scene, in blueprint order.
        expect(report.scenes).toHaveLength(core.scenes.length);

        core.scenes.forEach((scene, i) => {
          const sceneCount = report.scenes[i];
          const content = drafts.get(scene.scene_id);
          const expectedActual =
            content === undefined ? 0 : countActualWords(content);
          const target = scene.target_words;

          expect(sceneCount.sceneId).toBe(scene.scene_id);
          expect(sceneCount.targetWords).toBe(target);

          // 需求 9.1: actual = countActualWords(content); 0 when no draft.
          expect(sceneCount.actualWords).toBe(expectedActual);

          // 需求 9.2: delta = actual - target.
          expect(sceneCount.delta).toBe(expectedActual - target);

          // 需求 9.3: needsExpansion iff (target - actual)/target >= 0.15.
          const shortfallRatio = (target - expectedActual) / target;
          const expectedNeedsExpansion = shortfallRatio >= EXPANSION_THRESHOLD;
          expect(sceneCount.needsExpansion).toBe(expectedNeedsExpansion);

          // 需求 9.3: suggestedExpansion = target - actual when expanding, else 0.
          const expectedSuggested = expectedNeedsExpansion
            ? Math.max(0, target - expectedActual)
            : 0;
          expect(sceneCount.suggestedExpansion).toBe(expectedSuggested);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
