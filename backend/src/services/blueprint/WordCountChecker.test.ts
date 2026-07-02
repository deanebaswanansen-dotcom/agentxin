/**
 * Example/edge-case unit tests for {@link WordCountChecker} (task 9.5).
 *
 * Covers the字数检查 orchestration in isolation from the HTTP layer, using a
 * REAL {@link FileDataStore} over a unique temp file (no mocks) so the report is
 * exercised through genuine persistence:
 *
 * - `check` computes scene-level + chapter-level statistics and persists the
 *   report so {@link FileDataStore.getWordCountReportByChapter} reads it back
 *   identically (Req 9.4).
 * - The report's per-scene fields (`actualWords`/`delta`/`needsExpansion`/
 *   `suggestedExpansion`) and chapter-level fields are computed from the
 *   blueprint targets and persisted scene drafts; scenes with no draft count 0
 *   (Req 9.1–9.3, surfaced via the persisted 9.4 report).
 * - A chapter with no persisted blueprint throws `NOT_FOUND`.
 *
 * No model dependency: {@link WordCountChecker} takes only a {@link DataStore}
 * (no {@link import('../../proxy/ModelProxy.js').ModelProxy}), so it is
 * structurally impossible for字数检查 to reach a provider — the count is purely
 * local (design: "WordCountService（字数检查，无模型调用）").
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChapterBlueprint, Scene } from '../../types/index.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import { isServiceError } from '../ServiceError.js';
import { WordCountChecker } from './WordCountChecker.js';

function makeScene(sceneId: string, targetWords: number): Scene {
  return {
    scene_id: sceneId,
    name: `场景 ${sceneId}`,
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

function makeBlueprint(chapterId: string, scenes: Scene[]): ChapterBlueprint {
  return {
    chapter_id: chapterId,
    title: '章节标题',
    target_words: scenes.reduce((sum, s) => sum + s.target_words, 0),
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

describe('WordCountChecker.check', () => {
  let dir: string;
  let store: FileDataStore;
  let checker: WordCountChecker;
  let chapterId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'word-count-checker-'));
    store = await FileDataStore.create(join(dir, 'store.json'));
    checker = new WordCountChecker(store);

    const project = await store.createProject('小说项目');
    const chapter = await store.createChapter(project.id, '第一章');
    chapterId = chapter.id;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('computes scene + chapter statistics and persists a readable report (Req 9.4)', async () => {
    const scenes = [
      makeScene('scene-0', 1000),
      makeScene('scene-1', 10),
      makeScene('scene-2', 100),
    ];
    await store.saveChapterBlueprint(makeBlueprint(chapterId, scenes));

    // scene-0: 6 non-whitespace chars after stripping spaces/newline.
    await store.saveSceneDraft({
      chapterId,
      sceneId: 'scene-0',
      content: '你好 世界\n再见',
      updatedAt: new Date().toISOString(),
    });
    // scene-1: 20 non-whitespace chars (above target → no expansion).
    await store.saveSceneDraft({
      chapterId,
      sceneId: 'scene-1',
      content: 'a'.repeat(20),
      updatedAt: new Date().toISOString(),
    });
    // scene-2: no draft → actualWords 0.

    const report = await checker.check(chapterId);

    expect(report.chapterId).toBe(chapterId);
    expect(report.scenes).toHaveLength(3);

    // scene-0: actual 6, target 1000 → shortfall 0.994 ≥ 0.15 → expand 994.
    expect(report.scenes[0]).toEqual({
      sceneId: 'scene-0',
      targetWords: 1000,
      actualWords: 6,
      delta: -994,
      needsExpansion: true,
      suggestedExpansion: 994,
    });
    // scene-1: actual 20, target 10 → above target → no expansion.
    expect(report.scenes[1]).toEqual({
      sceneId: 'scene-1',
      targetWords: 10,
      actualWords: 20,
      delta: 10,
      needsExpansion: false,
      suggestedExpansion: 0,
    });
    // scene-2: no draft → actual 0, target 100 → expand 100.
    expect(report.scenes[2]).toEqual({
      sceneId: 'scene-2',
      targetWords: 100,
      actualWords: 0,
      delta: -100,
      needsExpansion: true,
      suggestedExpansion: 100,
    });

    // Chapter-level: target 1110, actual 6 + 20 + 0 = 26.
    expect(report.chapterTargetWords).toBe(1110);
    expect(report.chapterActualWords).toBe(26);
    expect(report.chapterDelta).toBe(-1084);
    expect(typeof report.generatedAt).toBe('string');

    // Persisted (Req 9.4): the report reads back identically.
    const persisted = await store.getWordCountReportByChapter(chapterId);
    expect(persisted).toEqual(report);
  });

  it('throws NOT_FOUND when the chapter has no persisted blueprint', async () => {
    await expect(checker.check(chapterId)).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'NOT_FOUND',
    );

    // Nothing was persisted for a failed check.
    expect(await store.getWordCountReportByChapter(chapterId)).toBeUndefined();
  });
});
