import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../index.js';
import type { ModelProxy } from '../proxy/ModelProxy.js';
import type { StreamDelta } from '../proxy/sseParser.js';
import { FileDataStore } from '../store/FileDataStore.js';
import type { ChatMessage, ModelConfig } from '../types/index.js';

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
    expect(await store.listOutlines(body.projectId)).toHaveLength(1);
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
