import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ScriptPlan } from '../domain.js';
import { FileScriptStore } from '../FileScriptStore.js';
import {
  InMemoryScriptCheckpointStore,
  ScriptDirector,
  type ScriptModelAdapter,
  type ScriptModelRequest,
  type ScriptProgressEvent,
} from './ScriptDirector.js';

function plan(totalEpisodes: number): ScriptPlan {
  return {
    id: 'plan-1',
    projectId: 'project-1',
    status: 'approved',
    revision: 0,
    title: '寒潮国货王',
    theme: '普通人在灾难中守住良知',
    market: 'domestic',
    channel: 'general',
    genres: ['灾难', '逆袭'],
    audience: '短剧大众观众',
    coreConflict: '主角必须在寒潮和利益集团夹击下保住救命物资',
    logline: '寒潮降临，仓库老板联合街坊守住物资并揭穿幕后黑手。',
    highlights: ['物资攻防', '身份反转', '全民见证'],
    totalEpisodes,
    episodeDurationSeconds: { min: 60, max: 90 },
    targetCharsPerEpisode: 1_000,
    maxPrimaryCharacters: 8,
    maxScenesPerEpisode: 3,
    dialogueDensityPercent: 60,
    language: 'zh-CN',
    format: 'cn_short_drama',
    coreRequirements: '每集有推进和结尾钩子',
    forbiddenElements: ['无因果反转'],
    endingDirection: '物资获救，幕后黑手伏法，社区建立公开分配制度',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
  };
}

function modelChunk(request: ScriptModelRequest): string {
  const start = request.chunkStart ?? 1;
  const end = request.chunkEnd ?? start;
  return JSON.stringify({
    synopsis: '主角守住物资并揭穿幕后黑手。',
    openingState: '寒潮降临，物资紧缺。',
    midpointTurn: '关键账本曝光。',
    climax: '仓库攻防战全面爆发。',
    endingState: '社区建立公开分配制度。',
    mainArc: ['守住仓库', '揭穿黑手'],
    subplotArcs: ['街坊互助'],
    episodeCards: Array.from({ length: end - start + 1 }, (_, offset) => {
      const episodeNumber = start + offset;
      return {
        episodeNumber,
        title: `第${episodeNumber}集`,
        logline: `第${episodeNumber}集推进物资攻防。`,
        mainEvent: `主角取得第${episodeNumber}条线索。`,
        endingHook: `第${episodeNumber + 1}条危机出现。`,
      };
    }),
  });
}

describe('ScriptDirector series outline resilience', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setup(totalEpisodes: number) {
    const root = await mkdtemp(join(tmpdir(), 'series-outline-resilience-'));
    roots.push(root);
    const store = await FileScriptStore.create(root);
    await store.savePlan(plan(totalEpisodes), 0);
    return { store, checkpoints: new InMemoryScriptCheckpointStore() };
  }

  it('finishes all 60 cards after the first provider failure without making more model calls', async () => {
    const { store, checkpoints } = await setup(60);
    let modelCalls = 0;
    const progress: ScriptProgressEvent[] = [];
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete() {
          modelCalls += 1;
          throw new Error('provider connection stalled');
        },
      },
    });

    const result = await director.run({
      task: 'script_series_outline',
      projectId: 'project-1',
      onProgress: (event) => {
        progress.push(event);
      },
    });

    expect(result).toMatchObject({ kind: 'series_outline' });
    if (result.kind !== 'series_outline') throw new Error('expected series outline');
    expect(modelCalls).toBe(1);
    expect(result.outline.episodeCards).toHaveLength(60);
    expect(result.outline.episodeCards.map((card) => card.episodeNumber)).toEqual(
      Array.from({ length: 60 }, (_, index) => index + 1),
    );
    expect(result.outline.episodeCards[0]?.logline).toContain('物资');
    expect(result.outline.episodeCards.at(-1)?.endingHook).toContain('公开分配制度');
    expect(result.outline.synopsis.length).toBeGreaterThanOrEqual(450);
    expect(result.outline.synopsis.length).toBeLessThan(800);
    const persistedState = await store.getProjectState('project-1');
    expect(persistedState?.seriesOutline?.episodeCards).toHaveLength(60);

    const saved = await checkpoints.list('project-1', 'script_series_outline');
    expect(saved).toHaveLength(6);
    expect(saved.every((checkpoint) => checkpoint.status === 'succeeded')).toBe(true);
    expect(saved.every((checkpoint) =>
      checkpoint.validationErrors.some((issue) => issue.code === 'series_outline.local_fallback')),
    ).toBe(true);
    expect(progress.at(-1)).toMatchObject({ current: 60, total: 60 });
    expect(progress.some((event) => event.message.includes('保底方案'))).toBe(true);
  });

  it('persists and reports the first running chunk before waiting for the provider', async () => {
    const { store, checkpoints } = await setup(12);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const model: ScriptModelAdapter = {
      async complete(request) {
        calls += 1;
        if (calls === 1) {
          markFirstStarted();
          await firstGate;
        }
        return modelChunk(request);
      },
    };
    const progress: ScriptProgressEvent[] = [];
    const director = new ScriptDirector({ store, checkpoints, model });

    const generation = director.run({
      task: 'script_series_outline',
      projectId: 'project-1',
      onProgress: (event) => {
        progress.push(event);
      },
    });
    await firstStarted;

    const whileWaiting = await checkpoints.list('project-1', 'script_series_outline');
    expect(whileWaiting).toHaveLength(1);
    expect(whileWaiting[0]).toMatchObject({
      node: 'series_outline',
      status: 'running',
      chunkStart: 1,
      artifactRevision: 0,
    });
    expect(whileWaiting[0]?.artifact).toBeUndefined();
    expect(progress[0]).toMatchObject({
      message: '正在生成第 1—10 集分集卡…',
      current: 1,
      total: 12,
    });

    releaseFirst();
    const result = await generation;
    expect(result).toMatchObject({ kind: 'series_outline' });
    const completed = await checkpoints.list('project-1', 'script_series_outline');
    expect(completed).toHaveLength(2);
    expect(completed.every((checkpoint) => checkpoint.status === 'succeeded')).toBe(true);
    expect(progress.at(-1)).toMatchObject({ current: 12, total: 12 });
  });

  it('fills missing outline fields from pasted user material without overwriting it', async () => {
    const { store, checkpoints } = await setup(3);
    const prompts: string[] = [];
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          prompts.push(request.prompt);
          return modelChunk(request);
        },
      },
    });
    const sourceOutline = {
      synopsis: '这是用户自己写好的完整故事大纲，原文必须保留。',
      openingState: '用户指定：寒潮第一夜，仓库已经被围。',
      midpointTurn: '',
      climax: '',
      endingState: '',
      mainArc: [],
      subplotArcs: [],
      episodeCards: [{
        episodeNumber: 1,
        title: '用户第一集标题',
        logline: '',
        mainEvent: '用户指定的仓库冲突。',
        endingHook: '',
      }],
    };

    const result = await director.run({
      task: 'script_series_outline',
      projectId: 'project-1',
      sourceOutline: JSON.stringify(sourceOutline),
    });

    expect(result.kind).toBe('series_outline');
    if (result.kind !== 'series_outline') throw new Error('expected series outline');
    expect(result.outline.synopsis).toBe(sourceOutline.synopsis);
    expect(result.outline.openingState).toBe(sourceOutline.openingState);
    expect(result.outline.midpointTurn).toBe('关键账本曝光。');
    expect(result.outline.episodeCards).toHaveLength(3);
    expect(result.outline.episodeCards[0]).toMatchObject({
      title: '用户第一集标题',
      mainEvent: '用户指定的仓库冲突。',
      logline: '第1集推进物资攻防。',
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('用户已填写的文字和分集卡字段不得擅自覆盖');
  });
});
