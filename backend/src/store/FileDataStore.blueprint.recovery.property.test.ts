/**
 * Property-based test for {@link FileDataStore} restart recovery of
 * blueprint-module data (task 2.6).
 *
 * Covers design.md Correctness **Property 16: 重启后从存储恢复蓝图模块数据**
 * (Validates: Requirements 13.2): *For any* chapter blueprint, scene drafts,
 * word-count report and pacing report written to a `FileDataStore`,
 * re-constructing a store over the SAME persistence file (a simulated service
 * restart) reads back EXACTLY the same blueprint-module data that was
 * observable before the restart.
 *
 * Method (mirrors the existing FileDataStore restart-recovery property test):
 * drive the real store through its public mutators, capture the full read-back
 * of all four blueprint-module collections from the live instance, then build a
 * fresh `FileDataStore.create(samePath)` and assert its read-back deep-equals
 * the captured one.
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
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '',
    ' ',
    '\n',
    '\t',
    '   \n\t  ',
    '第一章',
    '林夜与星辰之海',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2\r\nline3',
    '"quoted" <tag> & ampersand \\backslash',
    '{"looks":"like json"}',
  ),
  fc.string({ minLength: 100, maxLength: 300 }),
);

const stringArrayArb: fc.Arbitrary<string[]> = fc.array(textArb, {
  maxLength: 5,
});

/** Positive-integer word counts (Requirement 4.5). */
const positiveIntArb: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: 1_000_000,
});

const sceneIdArb: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 16,
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

/** Full observable read-back of a chapter's blueprint-module data. */
interface CapturedModuleState {
  blueprint: ChapterBlueprint | undefined;
  sceneDrafts: SceneDraft[];
  wordCountReport: WordCountReport | undefined;
  pacingReport: PacingReport | undefined;
}

async function captureModuleState(
  store: FileDataStore,
  chapterId: string,
): Promise<CapturedModuleState> {
  return {
    blueprint: await store.getChapterBlueprintByChapter(chapterId),
    sceneDrafts: await store.listSceneDrafts(chapterId),
    wordCountReport: await store.getWordCountReportByChapter(chapterId),
    pacingReport: await store.getPacingReportByChapter(chapterId),
  };
}

describe('FileDataStore blueprint-module restart recovery property test', () => {
  it('Feature: chapter-blueprint, Property 16: 重启后从存储恢复蓝图模块数据', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          body: blueprintBodyArb,
          tsDraft: isoTimestampArb,
          tsWordCount: isoTimestampArb,
          tsPacing: isoTimestampArb,
        }),
        async ({ body, tsDraft, tsWordCount, tsPacing }) => {
          const dir = await mkdtemp(join(tmpdir(), 'fds-bp-recover-'));
          const file = join(dir, 'store.json');
          try {
            // 1. Write all four collections via the original store instance.
            const original = await FileDataStore.create(file);
            const project = await original.createProject('p');
            const chapter = await original.createChapter(project.id, 'c');

            const blueprint: ChapterBlueprint = {
              chapter_id: chapter.id,
              ...body,
            };
            await original.saveChapterBlueprint(blueprint);

            for (const scene of body.scenes) {
              const draft: SceneDraft = {
                chapterId: chapter.id,
                sceneId: scene.scene_id,
                content: `正文：${scene.name}`,
                updatedAt: tsDraft,
              };
              await original.saveSceneDraft(draft);
            }

            const wordCountReport: WordCountReport = {
              chapterId: chapter.id,
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
              generatedAt: tsWordCount,
            };
            await original.saveWordCountReport(wordCountReport);

            const pacingReport: PacingReport = {
              chapterId: chapter.id,
              plotPoints: body.required_plot_points.map((p) => ({
                point: p,
                status: 'completed' as const,
              })),
              violatedForbiddenPoints: body.forbidden_points,
              sceneIssues: body.scenes.map((s) => ({
                sceneId: s.scene_id,
                issue: '问题描述',
                suggestion: '修改建议',
                priority: 'high' as const,
              })),
              generatedAt: tsPacing,
            };
            await original.savePacingReport(pacingReport);

            // 2. Capture everything observable before the simulated restart.
            const before = await captureModuleState(original, chapter.id);

            // 3. Simulate a restart: a brand-new store over the SAME file.
            const restarted = await FileDataStore.create(file);
            const after = await captureModuleState(restarted, chapter.id);

            // 4. The recovered blueprint-module data is identical, and the
            //    blueprint/reports equal exactly what was written.
            expect(after).toEqual(before);
            expect(after.blueprint).toEqual(blueprint);
            expect(after.wordCountReport).toEqual(wordCountReport);
            expect(after.pacingReport).toEqual(pacingReport);
            expect(after.sceneDrafts).toHaveLength(body.scenes.length);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);
});
