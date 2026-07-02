/**
 * Property-based test for {@link ChapterMerger.merge} when scenes are missing.
 *
 * Covers design.md Correctness **Property 18: 缺正文场景阻止合并** (task 8.4;
 * **Validates: Requirements 8.4**): *For any* chapter blueprint whose scene set
 * (3–7 unique scenes) has AT LEAST ONE scene with no persisted scene draft,
 * calling {@link ChapterMerger.merge} must reject with a `ServiceError` of code
 * `VALIDATION_ERROR`, AND the chapter's persisted `content` field must be left
 * exactly as it was before the call (the merge is rejected without touching the
 * stored chapter content).
 *
 * Method (design.md Testing Strategy — "用内存/临时文件 `DataStore` 验证仅目标场景
 * 被改"): exercised end-to-end through a real {@link FileDataStore} (no mocks)
 * backed by a UNIQUE temp directory per run, so the full create blueprint ->
 * partially write drafts -> merge -> read-back path goes through genuine
 * persistence. The temp directory is removed in a `finally` block so runs never
 * contaminate each other and no leftover files remain.
 *
 * Generators: 3–7 pairwise-distinct scene_ids (mixing numbered ids and free
 * strings), a per-scene "has draft" flag array constrained so at least one
 * scene stays draft-less, scene-draft contents (incl. empty — an empty-content
 * draft still counts as "written", so missing means NO draft at all), and an
 * arbitrary pre-existing chapter content to prove merge leaves it untouched.
 *
 * Runs: 50. Each run performs real filesystem I/O (mkdtemp + several atomic
 * writes + recursive cleanup), so the count is kept modest (>= 50) to bound
 * wall-clock time while still broadly sampling the input space.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from '../../store/FileDataStore.js';
import { ServiceError, isServiceError } from '../ServiceError.js';
import type { ChapterBlueprint, Scene } from '../../types/index.js';
import { ChapterMerger } from './ChapterMerger.js';

// Modest run count: every run does real disk I/O (see file header).
const NUM_RUNS = 50;

/**
 * Free-form text generator covering empty / whitespace / Unicode / emoji /
 * longer strings. Used for both chapter content and scene-draft content.
 */
const textArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.constantFrom('   ', '\t', '\n', '\u3000'),
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.constantFrom('已写场景正文', '😀🎉 scene', '第一段\n第二段'),
  fc.string({ minLength: 50, maxLength: 200 }),
);

/**
 * scene_id arbitrary mixing numbered ids (exercise numeric-aware ordering) and
 * arbitrary short strings. Uniqueness is enforced at the list level below.
 */
const sceneIdArb: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 0, max: 999 }).map((n) => `scene-${n}`),
  fc.integer({ min: 0, max: 999 }).map((n) => `${n}`),
  fc.string({ minLength: 1, maxLength: 6 }),
);

interface Scenario {
  /** 3–7 pairwise-distinct scene ids declared by the blueprint. */
  sceneIds: string[];
  /** Per-scene flag: true => persist a draft for that scene. >= 1 is false. */
  hasDraft: boolean[];
  /** Per-scene draft content (used only where hasDraft is true). */
  draftContents: string[];
  /** Pre-existing chapter content set before merge; must survive untouched. */
  initialContent: string;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .uniqueArray(sceneIdArb, { minLength: 3, maxLength: 7, selector: (id) => id })
  .chain((sceneIds) =>
    fc
      .record({
        hasDraft: fc.array(fc.boolean(), {
          minLength: sceneIds.length,
          maxLength: sceneIds.length,
        }),
        draftContents: fc.array(textArb, {
          minLength: sceneIds.length,
          maxLength: sceneIds.length,
        }),
        initialContent: textArb,
      })
      .map(({ hasDraft, draftContents, initialContent }) => {
        // Guarantee the property's precondition: at least one scene has NO
        // draft. If the generator made every flag true, drop the first.
        const flags = [...hasDraft];
        if (flags.every(Boolean)) {
          flags[0] = false;
        }
        return { sceneIds, hasDraft: flags, draftContents, initialContent };
      }),
  );

/** Build a minimal-but-complete scene for a given id (only scene_id matters). */
function makeScene(sceneId: string): Scene {
  return {
    scene_id: sceneId,
    name: `场景 ${sceneId}`,
    target_words: 1000,
    location: '某地',
    characters: [],
    purpose: '推进剧情',
    emotion: '平静',
    pacing: '中速',
    must_include: [],
    ending_state: '过渡',
  };
}

/** Build a minimal-but-complete blueprint for the given chapter and scenes. */
function makeBlueprint(chapterId: string, sceneIds: string[]): ChapterBlueprint {
  return {
    chapter_id: chapterId,
    title: '测试章节',
    target_words: sceneIds.length * 1000,
    main_goal: '主目标',
    tone: '基调',
    pacing: '章节节奏',
    required_plot_points: [],
    forbidden_points: [],
    emotional_curve: '情绪曲线',
    scenes: sceneIds.map(makeScene),
    ending_hook: '钩子',
  };
}

describe('ChapterMerger.merge — missing scenes block merge', () => {
  it('Feature: chapter-blueprint, Property 18: 缺正文场景阻止合并', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        // Unique temp dir per run so runs never contaminate each other.
        const dir = await mkdtemp(join(tmpdir(), 'merger-missing-prop-'));
        const file = join(dir, 'store.json');
        try {
          const store = await FileDataStore.create(file);

          // Arrange: a project + chapter, with an arbitrary pre-existing
          // chapter content that the rejected merge must leave untouched.
          const project = await store.createProject('合并测试项目');
          const chapter = await store.createChapter(project.id, '第一章');
          await store.updateChapterContent(chapter.id, scenario.initialContent);
          const contentBefore = (await store.getChapter(chapter.id))?.content;

          // Persist the blueprint declaring all scenes.
          await store.saveChapterBlueprint(
            makeBlueprint(chapter.id, scenario.sceneIds),
          );

          // Write drafts for only the flagged subset, leaving >= 1 scene with
          // no persisted draft (the precondition for this property).
          const nowIso = new Date().toISOString();
          for (let i = 0; i < scenario.sceneIds.length; i += 1) {
            if (scenario.hasDraft[i]) {
              await store.saveSceneDraft({
                chapterId: chapter.id,
                sceneId: scenario.sceneIds[i],
                content: scenario.draftContents[i],
                updatedAt: nowIso,
              });
            }
          }

          // Act: merge must reject because at least one scene is unwritten.
          const merger = new ChapterMerger(store);
          let thrown: unknown;
          try {
            await merger.merge(chapter.id);
          } catch (error) {
            thrown = error;
          }

          // Assert: rejected with a VALIDATION_ERROR ServiceError (需求 8.4).
          expect(isServiceError(thrown)).toBe(true);
          expect((thrown as ServiceError).code).toBe('VALIDATION_ERROR');

          // Assert: the chapter content is unchanged by the rejected merge.
          const contentAfter = (await store.getChapter(chapter.id))?.content;
          expect(contentAfter).toBe(contentBefore);
        } finally {
          // Tolerates Windows file locks / already-removed paths.
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: NUM_RUNS },
    );
    // 50 runs * real filesystem I/O comfortably exceeds vitest's 5s default.
  }, 120_000);
});
