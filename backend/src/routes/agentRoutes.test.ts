import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../index.js';
import type { ModelProxy } from '../proxy/ModelProxy.js';
import type { StreamDelta } from '../proxy/sseParser.js';
import { FileDataStore } from '../store/FileDataStore.js';
import { FileScriptStore } from '../services/script/FileScriptStore.js';
import type { ChatMessage, ModelConfig } from '../types/index.js';
import { parseAgentBody, parsePlanSummary } from './agentRoutes.js';

class FakeProxy implements ModelProxy {
  calls: ChatMessage[][] = [];
  signalStates: boolean[] = [];

  streamCompletion(
    _config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    this.calls.push(messages);
    this.signalStates.push(signal.aborted);
    return (async function* () {
      yield { kind: 'content' as const, text: '自动控稿输出' };
    })();
  }
}

class JsonProxy implements ModelProxy {
  readonly prompts: string[] = [];

  constructor(private readonly response: string) {}

  streamCompletion(
    _config: ModelConfig,
    messages: ChatMessage[],
    _signal: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    this.prompts.push(String(messages.at(-1)?.content ?? ''));
    const response = this.response;
    return (async function* () {
      yield { kind: 'content' as const, text: response };
    })();
  }
}

const MODEL_CONFIG: ModelConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  modelName: 'test-model',
};

function modelConfigHeaders(config: ModelConfig = MODEL_CONFIG): Record<string, string> {
  return { 'X-Agentxin-Model-Config': encodeURIComponent(JSON.stringify(config)) };
}

describe('agent routes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-route-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('preserves the structured Story Plan in downstream agent options', () => {
    const parsed = parsePlanSummary({
      title: '灰烬王冠',
      storyPlan: {
        metadata: { genre: '西方玄幻' },
        premise: { one_sentence: '流亡骑士寻找王冠。', core_conflict: '记忆与权力冲突。' },
        protagonist: { identity: '流亡骑士', goal: '找回王冠' },
        world: { overview: '旧帝国覆灭后的大陆。' },
        power_system: { rules: ['魔法消耗记忆'] },
        main_plot: { beginning: '接任务', development: '被追杀', climax: '争夺王冠', ending: '封印王冠' },
      },
    });

    expect(parsed?.storyPlan?.premise.coreConflict).toBe('记忆与权力冲突。');
    expect(parsed?.storyPlan?.powerSystem.rules).toEqual(['魔法消耗记忆']);
  });

  it('preserves the user-confirmed chapter word range', () => {
    const parsed = parseAgentBody({
      task: 'long_novel',
      mode: 'draft',
      prompt: '校园悬疑',
      options: {
        targetWords: 800,
        minWordsPerChapter: 700,
        maxWordsPerChapter: 900,
      },
    });

    expect(parsed.options).toMatchObject({
      targetWords: 800,
      minWordsPerChapter: 700,
      maxWordsPerChapter: 900,
    });
  });

  it('parses a five-episode short-drama background job without legacy mode fields', () => {
    const parsed = parseAgentBody({
      task: 'script_episode_batch',
      projectId: 'script-project',
      scriptBatchOptions: {
        startEpisode: 6,
        episodeCount: 5,
        expectedPlanRevision: 3,
      },
    });

    expect(parsed).toMatchObject({
      task: 'script_episode_batch',
      mode: 'draft',
      prompt: '',
      projectId: 'script-project',
      scriptBatchOptions: {
        startEpisode: 6,
        episodeCount: 5,
        expectedPlanRevision: 3,
      },
    });
  });

  it('rejects a short-drama batch that does not start on a fixed five-episode boundary', () => {
    expect(() => parseAgentBody({
      task: 'script_episode_batch',
      projectId: 'script-project',
      scriptBatchOptions: {
        startEpisode: 2,
        episodeCount: 5,
        expectedPlanRevision: 3,
      },
    })).toThrow('短剧正文批次必须从第 1、6、11……集开始。');
  });

  it('accepts direct screenplay writing mode and rejects unknown draft modes', () => {
    expect(parseAgentBody({
      task: 'script_episode_batch',
      projectId: 'script-project',
      scriptBatchOptions: {
        startEpisode: 1,
        episodeCount: 5,
        expectedPlanRevision: 3,
        draftMode: 'direct_text',
      },
    }).scriptBatchOptions?.draftMode).toBe('direct_text');

    expect(() => parseAgentBody({
      task: 'script_episode_batch',
      projectId: 'script-project',
      scriptBatchOptions: {
        startEpisode: 1,
        episodeCount: 5,
        expectedPlanRevision: 3,
        draftMode: 'unknown',
      },
    })).toThrow('短剧正文模式必须是 structured_legacy 或 direct_text。');
  });

  it('routes short-drama tasks through ScriptDirector instead of the novel orchestrator', async () => {
    const store = await FileDataStore.create(join(dir, 'store.json'));
    const scriptStore = await FileScriptStore.create(join(dir, 'scripts'));
    const project = await store.createProject('竖屏短剧', 'short_drama');
    const proxy = new JsonProxy(JSON.stringify({
      title: '她不再道歉', theme: '摆脱情绪勒索', market: 'domestic', channel: 'female',
      genres: ['都市情感'], audience: '女性观众', coreConflict: '女主反抗家庭控制',
      logline: '女主在婚礼前夜揭穿家人的控制骗局。', highlights: ['婚礼反转'], totalEpisodes: 10,
      episodeDurationSeconds: { min: 60, max: 90 }, targetCharsPerEpisode: 1200,
      maxPrimaryCharacters: 6, maxScenesPerEpisode: 3, dialogueDensityPercent: 60,
      language: 'zh-CN', format: 'cn_short_drama', coreRequirements: '每集有卡点',
      forbiddenElements: [], endingDirection: '女主赢回人生',
    }));
    const app = buildServer(
      store, proxy, undefined, undefined, undefined, undefined, undefined, scriptStore,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/run',
      headers: modelConfigHeaders(),
      payload: { task: 'script_plan', projectId: project.id, prompt: '一个拒绝道德绑架的女孩' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ task: 'script_plan', projectId: project.id });
    expect((await scriptStore.getProjectState(project.id))?.plan?.title).toBe('她不再道歉');
    expect(proxy.prompts.join('\n')).toContain('一个拒绝道德绑架的女孩');
    await app.close();
  });

  it('runs draft automation from one sentence and persists project artifacts', async () => {
    const store = await FileDataStore.create(join(dir, 'store.json'));
    const proxy = new FakeProxy();
    const app = buildServer(store, proxy);

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/run',
      headers: modelConfigHeaders(),
      payload: { task: 'novel', mode: 'draft', prompt: '赛博修仙学院，主角靠写代码御剑' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { projectId: string; chapterId: string; artifacts: unknown[] };
    expect(body.projectId).toBeTruthy();
    expect(body.chapterId).toBeTruthy();
    expect(body.artifacts).toHaveLength(5);
    expect(await store.listWorldSettings(body.projectId)).toHaveLength(1);
    expect(await store.listCharacters(body.projectId)).toHaveLength(1);
    const outlines = await store.listOutlines(body.projectId);
    expect(outlines).toHaveLength(2);
    expect(outlines.some((outline) => outline.title.endsWith('：大纲'))).toBe(true);
    expect(outlines.some((outline) => outline.title === '伏笔台账')).toBe(true);
    const chapter = await store.getChapter(body.chapterId);
    expect(chapter?.content).toBe('自动控稿输出');
    expect(proxy.calls.length).toBeGreaterThanOrEqual(2);
    expect(proxy.signalStates.every((aborted) => aborted === false)).toBe(true);
    expect(proxy.signalStates.length).toBeGreaterThanOrEqual(4);

    await app.close();
  });

  it('rejects automation when model config is missing', async () => {
    const store = await FileDataStore.create(join(dir, 'store.json'));
    const app = buildServer(store, new FakeProxy());

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/run',
      payload: { task: 'outline', mode: 'reference', prompt: '都市异能' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain('sk-');
    await app.close();
  });

  it('runs workspace_review with an empty prompt and saves a proactive report', async () => {
    const store = await FileDataStore.create(join(dir, 'store.json'));
    const project = await store.createProject('主动审阅项目');
    await store.createChapter(project.id, '第一章');
    await store.createCharacter(project.id, '主角', '便利店夜班店员');
    await store.createWorldSetting(project.id, '世界观', '城市地下有异常空间');
    await store.createOutline(project.id, '主线', '夜班中发现异常');
    const app = buildServer(store, new FakeProxy());

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/run',
      headers: modelConfigHeaders(),
      payload: { task: 'workspace_review', mode: 'reference', prompt: '', projectId: project.id },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { task: string; projectId: string; artifacts: Array<{ kind: string; title: string }> };
    expect(body.task).toBe('workspace_review');
    expect(body.projectId).toBe(project.id);
    expect(body.artifacts).toContainEqual(expect.objectContaining({ kind: 'outline', title: '主动审阅报告' }));
    const outlines = await store.listOutlines(project.id);
    expect(outlines.some((outline) => outline.title === '主动审阅报告')).toBe(true);
    await app.close();
  });
});
