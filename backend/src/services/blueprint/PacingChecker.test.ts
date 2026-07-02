/**
 * Example/edge-case unit tests for {@link PacingChecker} (task 9.5).
 *
 * Covers the节奏检查 orchestration in isolation from the HTTP and provider
 * layers, using a REAL {@link FileDataStore} over a unique temp file plus a
 * FAKE {@link ModelProxy}:
 *
 * - A valid `PacingReport` JSON from the model is parsed, has metadata injected
 *   and is persisted so {@link FileDataStore.getPacingReportByChapter} reads it
 *   back (Req 10.2/10.3/10.4/10.5).
 * - `MODEL_NOT_CONFIGURED` is thrown BEFORE any provider call when no model
 *   config is saved (the fake proxy records zero calls) (Req 10.6).
 * - A malformed / schema-violating model output raises `VALIDATION_ERROR`
 *   (Req 10.2–10.4).
 * - `getReport` throws `NOT_FOUND` when no report has been persisted
 *   (Req 13.5).
 *
 * The fake {@link ModelProxy} records each call and yields canned deltas; it
 * never performs network I/O.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type {
  ChapterBlueprint,
  ChatMessage,
  ModelConfig,
  PacingReport,
  Scene,
} from '../../types/index.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import { isServiceError } from '../ServiceError.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { PacingChecker } from './PacingChecker.js';

const VALID_CONFIG: ModelConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-secret-canary',
  modelName: 'gpt-4o-mini',
};

/**
 * Fake {@link ModelProxy} recording the (config, messages) of every call and
 * yielding the supplied canned text in chunks. Never performs any I/O.
 */
function makeFakeProxy(chunks: string[]) {
  const calls: { config: ModelConfig; messages: ChatMessage[] }[] = [];
  const proxy: ModelProxy = {
    streamCompletion(config, messages) {
      calls.push({ config, messages });
      return (async function* () {
        for (const chunk of chunks) yield { kind: 'content' as const, text: chunk };
      })();
    },
  };
  return { proxy, calls };
}

function makeScene(sceneId: string): Scene {
  return {
    scene_id: sceneId,
    name: `场景 ${sceneId}`,
    target_words: 1000,
    location: '地点',
    characters: [],
    purpose: '目的',
    emotion: '情绪',
    pacing: '节奏',
    must_include: [],
    ending_state: '结束状态',
  };
}

function makeBlueprint(chapterId: string): ChapterBlueprint {
  return {
    chapter_id: chapterId,
    title: '章节标题',
    target_words: 3000,
    main_goal: '主目标',
    tone: '基调',
    pacing: '紧凑',
    required_plot_points: ['主角登场', '冲突爆发'],
    forbidden_points: ['不得提前揭示反派身份'],
    emotional_curve: '由平稳到高潮',
    scenes: [makeScene('scene-0'), makeScene('scene-1'), makeScene('scene-2')],
    ending_hook: '钩子',
  };
}

/** A valid PacingReport body JSON (with surrounding prose to exercise extraction). */
function validReportJson(): string {
  return [
    '以下是节奏检查结果：',
    '{',
    '  "plotPoints": [',
    '    { "point": "主角登场", "status": "completed" },',
    '    { "point": "冲突爆发", "status": "partial" }',
    '  ],',
    '  "violatedForbiddenPoints": ["不得提前揭示反派身份"],',
    '  "sceneIssues": [',
    '    { "sceneId": "scene-0", "issue": "开场过慢", "suggestion": "删减铺垫", "priority": "high" }',
    '  ]',
    '}',
    '（以上为报告）',
  ].join('\n');
}

describe('PacingChecker.check', () => {
  let dir: string;
  let store: FileDataStore;
  let chapterId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pacing-checker-'));
    store = await FileDataStore.create(join(dir, 'store.json'));

    const project = await store.createProject('小说项目');
    const chapter = await store.createChapter(project.id, '第一章');
    chapterId = chapter.id;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses a valid model report, injects metadata and persists it (Req 10.2–10.5)', async () => {
    await store.saveChapterBlueprint(makeBlueprint(chapterId));
    await store.saveModelConfig(VALID_CONFIG);

    // Split the JSON across chunks to exercise stream aggregation.
    const full = validReportJson();
    const mid = Math.floor(full.length / 2);
    const { proxy, calls } = makeFakeProxy([full.slice(0, mid), full.slice(mid)]);
    const checker = new PacingChecker(
      store,
      new ModelConfigService(store),
      proxy,
    );

    const report = await checker.check(chapterId);

    // The internal config (raw key) reached the proxy exactly once.
    expect(calls).toHaveLength(1);
    expect(calls[0].config).toEqual(VALID_CONFIG);

    expect(report.chapterId).toBe(chapterId);
    expect(report.plotPoints).toEqual([
      { point: '主角登场', status: 'completed' },
      { point: '冲突爆发', status: 'partial' },
    ]);
    expect(report.violatedForbiddenPoints).toEqual(['不得提前揭示反派身份']);
    expect(report.sceneIssues).toEqual([
      {
        sceneId: 'scene-0',
        issue: '开场过慢',
        suggestion: '删减铺垫',
        priority: 'high',
      },
    ]);
    expect(typeof report.generatedAt).toBe('string');

    // Persisted (Req 10.5): reads back identically.
    const persisted = await store.getPacingReportByChapter(chapterId);
    expect(persisted).toEqual(report);
  });

  it('throws MODEL_NOT_CONFIGURED before any provider call when no config is saved (Req 10.6)', async () => {
    await store.saveChapterBlueprint(makeBlueprint(chapterId));
    const { proxy, calls } = makeFakeProxy([validReportJson()]);
    const checker = new PacingChecker(
      store,
      new ModelConfigService(store),
      proxy,
    );

    await expect(checker.check(chapterId)).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'MODEL_NOT_CONFIGURED',
    );

    // Provider must NOT be reached when the model is unconfigured (Req 10.6).
    expect(calls).toHaveLength(0);
    expect(await store.getPacingReportByChapter(chapterId)).toBeUndefined();
  });

  it('throws NOT_FOUND when the chapter has no persisted blueprint', async () => {
    await store.saveModelConfig(VALID_CONFIG);
    const { proxy } = makeFakeProxy([validReportJson()]);
    const checker = new PacingChecker(
      store,
      new ModelConfigService(store),
      proxy,
    );

    await expect(checker.check(chapterId)).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'NOT_FOUND',
    );
  });

  it('throws VALIDATION_ERROR when the model output is not valid JSON', async () => {
    await store.saveChapterBlueprint(makeBlueprint(chapterId));
    await store.saveModelConfig(VALID_CONFIG);
    const { proxy } = makeFakeProxy(['这里没有任何 JSON 对象，只有说明文字。']);
    const checker = new PacingChecker(
      store,
      new ModelConfigService(store),
      proxy,
    );

    await expect(checker.check(chapterId)).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
    );
    expect(await store.getPacingReportByChapter(chapterId)).toBeUndefined();
  });

  it('throws VALIDATION_ERROR when the model output violates the schema (illegal enum)', async () => {
    await store.saveChapterBlueprint(makeBlueprint(chapterId));
    await store.saveModelConfig(VALID_CONFIG);
    // status "done" is not a legal PlotPointStatus; priority is missing too.
    const badJson = JSON.stringify({
      plotPoints: [{ point: '主角登场', status: 'done' }],
      violatedForbiddenPoints: [],
      sceneIssues: [{ sceneId: 'scene-0', issue: 'x', suggestion: 'y' }],
    });
    const { proxy } = makeFakeProxy([badJson]);
    const checker = new PacingChecker(
      store,
      new ModelConfigService(store),
      proxy,
    );

    await expect(checker.check(chapterId)).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
    );
    expect(await store.getPacingReportByChapter(chapterId)).toBeUndefined();
  });
});

describe('PacingChecker.getReport', () => {
  let dir: string;
  let store: FileDataStore;
  let chapterId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pacing-checker-get-'));
    store = await FileDataStore.create(join(dir, 'store.json'));
    const project = await store.createProject('小说项目');
    const chapter = await store.createChapter(project.id, '第一章');
    chapterId = chapter.id;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws NOT_FOUND when no pacing report has been persisted (Req 13.5)', async () => {
    const { proxy } = makeFakeProxy([validReportJson()]);
    const checker = new PacingChecker(
      store,
      new ModelConfigService(store),
      proxy,
    );

    await expect(checker.getReport(chapterId)).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'NOT_FOUND',
    );
  });

  it('returns the persisted report when one exists', async () => {
    const persisted: PacingReport = {
      chapterId,
      plotPoints: [{ point: '主角登场', status: 'missing' }],
      violatedForbiddenPoints: [],
      sceneIssues: [],
      generatedAt: new Date().toISOString(),
    };
    await store.savePacingReport(persisted);

    const { proxy } = makeFakeProxy([validReportJson()]);
    const checker = new PacingChecker(
      store,
      new ModelConfigService(store),
      proxy,
    );

    expect(await checker.getReport(chapterId)).toEqual(persisted);
  });
});
