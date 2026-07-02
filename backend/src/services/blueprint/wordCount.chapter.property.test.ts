/**
 * Property-based test for {@link buildWordCountReport} chapter-level statistics.
 *
 * Covers design.md Correctness **Property 11: 整章实际字数等于各场景合并后的实际字数**
 * (task 5.4; Validates: Requirements 9.2, 9.1): *For any* `BlueprintCore`
 * (3–7 scenes, unique `scene_id`s, positive-integer `target_words`) and any
 * `draftsBySceneId` map, the report's `chapterActualWords` equals the actual
 * word count of the merged chapter text, i.e.
 * `countActualWords(mergeScenes(scenes → {scene_id, content ?? ''}))`, and
 * `chapterDelta` equals `chapterActualWords − chapterTargetWords`.
 *
 * Oracle strategy: the SUT computes chapter actual words by merging each
 * scene's draft (missing → empty string) via {@link mergeScenes} and counting
 * the result. The oracle reproduces that exact pipeline independently. Because
 * the merge separator (`\n\n`) is whitespace and stripped during counting, this
 * also implies `chapterActualWords == Σ scene.actualWords`, asserted as a
 * secondary invariant.
 *
 * Generators cover scenes with / without drafts, and content spanning empty /
 * whitespace / Unicode / emoji / long strings.
 *
 * Uses fast-check with >= 100 runs.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { buildWordCountReport, countActualWords } from './wordCount.js';
import { mergeScenes } from './mergeScenes.js';
import type { BlueprintCore, Scene } from '../../types/index.js';

const NUM_RUNS = 300;

const contentArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.constantFrom('   ', '\n\n', '\t \u3000'),
  fc.string(),
  fc.fullUnicodeString(),
  fc.constantFrom('汉字内容', '😀🎉👍', '👨‍👩‍👧 family'),
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

const chapterCaseArb: fc.Arbitrary<{
  core: BlueprintCore;
  drafts: ReadonlyMap<string, string>;
}> = fc
  .integer({ min: 3, max: 7 })
  .chain((count) =>
    fc
      .record({
        targets: fc.array(fc.integer({ min: 1, max: 100_000 }), {
          minLength: count,
          maxLength: count,
        }),
        chapterTarget: fc.integer({ min: 1, max: 700_000 }),
        contents: fc.array(fc.option(contentArb, { nil: undefined }), {
          minLength: count,
          maxLength: count,
        }),
      })
      .map(({ targets, chapterTarget, contents }) => {
        const scenes = targets.map((t, i) => makeScene(`scene-${i}`, t));
        const drafts = new Map<string, string>();
        contents.forEach((content, i) => {
          if (content !== undefined) {
            drafts.set(`scene-${i}`, content);
          }
        });
        return { core: makeCore(scenes, chapterTarget), drafts };
      }),
  );

describe('wordCount buildWordCountReport chapter-level property test', () => {
  it('Feature: chapter-blueprint, Property 11: 整章实际字数等于各场景合并后的实际字数', () => {
    fc.assert(
      fc.property(chapterCaseArb, ({ core, drafts }) => {
        const report = buildWordCountReport(core, drafts);

        // Oracle: replicate the SUT's merge-then-count pipeline independently.
        const mergedContent = mergeScenes(
          core.scenes.map((scene) => ({
            scene_id: scene.scene_id,
            content: drafts.get(scene.scene_id) ?? '',
          })),
        );
        const expectedChapterActual = countActualWords(mergedContent);

        expect(report.chapterActualWords).toBe(expectedChapterActual);
        expect(report.chapterTargetWords).toBe(core.target_words);
        expect(report.chapterDelta).toBe(
          expectedChapterActual - core.target_words,
        );

        // Secondary invariant: separator is whitespace, so chapter actual ==
        // sum of scene actual words.
        const sumSceneActual = report.scenes.reduce(
          (sum, s) => sum + s.actualWords,
          0,
        );
        expect(report.chapterActualWords).toBe(sumSceneActual);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
