/**
 * Property-based test for {@link FileDataStore} cascade deletion of
 * blueprint-module data (task 2.5).
 *
 * Covers design.md Correctness **Property 15: 删除级联清除关联蓝图数据**
 * (Validates: Requirements 13.4): *For any* chapter together with its
 * associated blueprint, scene drafts, word-count report and pacing report,
 * deleting that chapter — OR deleting the project it belongs to — removes ALL of
 * those associated records from the data store.
 *
 * Method (two cascade entry points, both asserted per run):
 *   (a) deleteChapter: build a project + chapter with a full set of associated
 *       blueprint-module data, delete the chapter, then assert every
 *       `getXxx`/`listSceneDrafts` for that chapter returns empty/undefined.
 *   (b) deleteProject: rebuild the same associated data under a fresh
 *       project/chapter, delete the PROJECT, then assert the same emptiness (the
 *       cascade must reach data keyed only by `chapterId`).
 * Each run also persists a CONTROL chapter (under a separate project) whose data
 * must SURVIVE both deletions, proving the cascade is scoped, not global.
 *
 * Uses fast-check. Because every run performs real filesystem I/O (mkdtemp +
 * several atomic writes + recursive cleanup), runs are capped at 40 — enough to
 * exercise the generators' edge classes while keeping wall-clock reasonable.
 * Every run gets its OWN temp directory (created inside the predicate) which is
 * removed in a `finally` block, so runs never contaminate each other and no
 * leftover files remain.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from './FileDataStore.js';
import type {
  ChapterBlueprint,
  PacingReport,
  Scene,
  SceneDraft,
  WordCountReport,
} from '../types/index.js';

// File I/O per run -> keep runs modest (design.md Testing Strategy: 文件 IO 取 30-50).
const NUM_RUNS = 40;

/** Text generator covering empty / whitespace / Unicode / long edge classes. */
const textArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.constantFrom(
    '',
    ' ',
    '\n',
    '第一章',
    '林夜与星辰之海',
    '日本語のテキスト',
    '😀🎉',
    '"quoted" & <tag>',
  ),
  fc.string({ minLength: 60, maxLength: 200 }),
);

const stringArrayArb: fc.Arbitrary<string[]> = fc.array(textArb, {
  maxLength: 4,
});

/** Positive-integer word counts (Requirement 4.5). */
const positiveIntArb: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: 1_000_000,
});

const sceneIdArb: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 12,
});

const isoTimestampArb: fc.Arbitrary<string> = fc
  .date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2100-01-01T00:00:00.000Z'),
  })
  .map((d) => d.toISOString());

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

/** Blueprint body (everything except `chapter_id`, bound to a real chapter id). */
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
  // 3–7 unique scenes (Requirements 4.2 / 4.4).
  scenes: fc.uniqueArray(sceneArb, {
    minLength: 3,
    maxLength: 7,
    selector: (s) => s.scene_id,
  }),
  ending_hook: textArb,
});

/**
 * Build the full set of associated blueprint-module records for a chapter, then
 * persist them all. Returns nothing; the caller asserts on read-back.
 */
async function seedChapterData(
  store: FileDataStore,
  chapterId: string,
  body: BlueprintBody,
  reportMeta: { generatedAtA: string; generatedAtB: string },
): Promise<void> {
  const blueprint: ChapterBlueprint = { chapter_id: chapterId, ...body };
  await store.saveChapterBlueprint(blueprint);

  // A scene draft per blueprint scene.
  for (const scene of body.scenes) {
    const draft: SceneDraft = {
      chapterId,
      sceneId: scene.scene_id,
      content: `正文 for ${scene.scene_id}`,
      updatedAt: reportMeta.generatedAtA,
    };
    await store.saveSceneDraft(draft);
  }

  const wordCountReport: WordCountReport = {
    chapterId,
    scenes: body.scenes.map((s) => ({
      sceneId: s.scene_id,
      targetWords: s.target_words,
      actualWords: 0,
      delta: -s.target_words,
      needsExpansion: true,
      suggestedExpansion: s.target_words,
    })),
    chapterTargetWords: body.target_words,
    chapterActualWords: 0,
    chapterDelta: -body.target_words,
    generatedAt: reportMeta.generatedAtA,
  };
  await store.saveWordCountReport(wordCountReport);

  const pacingReport: PacingReport = {
    chapterId,
    plotPoints: body.required_plot_points.map((p) => ({
      point: p,
      status: 'partial' as const,
    })),
    violatedForbiddenPoints: body.forbidden_points,
    sceneIssues: body.scenes.map((s) => ({
      sceneId: s.scene_id,
      issue: '节奏偏慢',
      suggestion: '删减铺垫',
      priority: 'medium' as const,
    })),
    generatedAt: reportMeta.generatedAtB,
  };
  await store.savePacingReport(pacingReport);
}

/** Assert all blueprint-module data for a chapter is absent (post-cascade). */
async function expectChapterDataAbsent(
  store: FileDataStore,
  chapterId: string,
): Promise<void> {
  expect(await store.getChapterBlueprintByChapter(chapterId)).toBeUndefined();
  expect(await store.listSceneDrafts(chapterId)).toEqual([]);
  expect(await store.getWordCountReportByChapter(chapterId)).toBeUndefined();
  expect(await store.getPacingReportByChapter(chapterId)).toBeUndefined();
}

describe('FileDataStore blueprint cascade-delete property test', () => {
  it('Feature: chapter-blueprint, Property 15: 删除级联清除关联蓝图数据', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          body: blueprintBodyArb,
          controlBody: blueprintBodyArb,
          tsA: isoTimestampArb,
          tsB: isoTimestampArb,
        }),
        async ({ body, controlBody, tsA, tsB }) => {
          const dir = await mkdtemp(join(tmpdir(), 'fds-bp-cascade-'));
          const file = join(dir, 'store.json');
          try {
            const store = await FileDataStore.create(file);

            // Control project/chapter whose data must SURVIVE both cascades.
            const controlProject = await store.createProject('control');
            const controlChapter = await store.createChapter(
              controlProject.id,
              'control-ch',
            );
            await seedChapterData(store, controlChapter.id, controlBody, {
              generatedAtA: tsA,
              generatedAtB: tsB,
            });

            // ---- (a) deleteChapter cascade ----
            const projectA = await store.createProject('pa');
            const chapterA = await store.createChapter(projectA.id, 'cha');
            await seedChapterData(store, chapterA.id, body, {
              generatedAtA: tsA,
              generatedAtB: tsB,
            });

            await store.deleteChapter(chapterA.id);
            await expectChapterDataAbsent(store, chapterA.id);

            // ---- (b) deleteProject cascade (rebuild under a fresh project) ----
            const projectB = await store.createProject('pb');
            const chapterB = await store.createChapter(projectB.id, 'chb');
            await seedChapterData(store, chapterB.id, body, {
              generatedAtA: tsA,
              generatedAtB: tsB,
            });

            await store.deleteProject(projectB.id);
            await expectChapterDataAbsent(store, chapterB.id);

            // ---- Control data untouched by either cascade ----
            expect(
              await store.getChapterBlueprintByChapter(controlChapter.id),
            ).toEqual({ chapter_id: controlChapter.id, ...controlBody });
            expect(
              await store.listSceneDrafts(controlChapter.id),
            ).toHaveLength(controlBody.scenes.length);
            expect(
              await store.getWordCountReportByChapter(controlChapter.id),
            ).toBeDefined();
            expect(
              await store.getPacingReportByChapter(controlChapter.id),
            ).toBeDefined();
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);
});
