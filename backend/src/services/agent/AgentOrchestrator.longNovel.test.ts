import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { extractChapterOutline, normalizeFullNovelOptions, AgentOrchestrator } from './AgentOrchestrator.js';
import type { ModelProxy, StreamCompletionOptions } from '../../proxy/ModelProxy.js';
import type { DataStore } from '../../store/DataStore.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import { MemoryService } from '../memory/MemoryService.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import type { ChatMessage, ModelConfig } from '../../types/index.js';
import type { StreamDelta } from '../../proxy/sseParser.js';

class CaptureProxy implements ModelProxy {
  chapterSystems: string[] = [];
  controlSystems: string[] = [];

  streamCompletion(
    _config: ModelConfig,
    messages: ChatMessage[],
    _signal: AbortSignal,
    _options?: StreamCompletionOptions,
  ): AsyncIterable<StreamDelta> {
    const system = messages[0]?.content ?? '';
    let text = 'OK';
    if (system.includes('世界观策划')) text = '# 世界与规则\n\n世界稳定。';
    else if (system.includes('人物策划')) text = '# 人物与口吻护栏\n\n洛言，谨慎稳定。';
    else if (system.includes('大纲策划')) {
      text = [
        '# 第一卷大纲',
        '',
        '### 第一章：黑户入学',
        '陆辞绕过身份验证进入学院。',
        '',
        '### 第二章：第一堂课与BUG',
        '陆辞用低算力漏洞完成聚灵阵，实验室虚拟机过载。',
        '',
        '### 第三章：符文工坊的秘密',
        '陆辞换取闲置算力，误入热数据坟场。',
        '',
        '### 第四章：御剑飞行是逆向工程',
        '陆辞逆向劣质飞剑 API，参加新生选拔赛。',
      ].join('\n');
    }
    else if (system.includes('长篇小说总控策划子 Agent')) {
      this.controlSystems.push(system);
      const range = system.match(/当前只规划第\s*(\d+)-(\d+)\s*章/);
      const start = Number(range?.[1] ?? 1);
      const end = Number(range?.[2] ?? start);
      text = Array.from({ length: end - start + 1 }, (_, index) => {
        const chapter = start + index;
        return `### 第${chapter}章：控制锚点${chapter}\n本章锚点：推进代码御剑主线第${chapter}步，更新人物状态并保留后续伏笔。`;
      }).join('\n\n');
    } else if (system.includes('正文写作子 Agent')) {
      this.chapterSystems.push(system);
      text = '# 正文\n\n洛言继续推进代码御剑主线。';
    } else if (system.includes('反思子 Agent')) {
      text = '{"summary":"洛言推进代码御剑主线","facts":[{"kind":"character","text":"洛言保持谨慎稳定"}],"learning":"保持代码御剑风格"}';
    }
    return (async function* () {
      yield { kind: 'content' as const, text };
    })();
  }
}

describe('normalizeFullNovelOptions', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('keeps the million-word test plan at 500 chapters x 2000 words', () => {
    expect(normalizeFullNovelOptions(500, 2000)).toEqual({
      chapterCount: 500,
      wordsPerChapter: 2000,
      plannedWords: 1_000_000,
    });
  });

  it('clamps unsafe long-novel parameters to explicit bounds', () => {
    expect(normalizeFullNovelOptions(999, 9000)).toEqual({
      chapterCount: 500,
      wordsPerChapter: 8000,
      plannedWords: 4_000_000,
    });
    expect(normalizeFullNovelOptions(0, 100)).toEqual({
      chapterCount: 1,
      wordsPerChapter: 300,
      plannedWords: 300,
    });
  });

  it('extracts the requested chapter anchor from a markdown outline', () => {
    const outline = [
      '# 第一卷大纲',
      '',
      '### 第一章：黑户入学',
      '开篇。',
      '',
      '### 第12章：缓存命中',
      '中段。',
      '',
      '### Chapter 13: Audit',
      '审计。',
    ].join('\n');

    expect(extractChapterOutline(outline, 1)).toContain('黑户入学');
    expect(extractChapterOutline(outline, 12)).toContain('缓存命中');
    expect(extractChapterOutline(outline, 13)).toContain('Audit');
    expect(extractChapterOutline(outline, 2)).toBeUndefined();
  });

  it('uses the global final chapter number when resuming a batched long run', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-orchestrator-long-'));
    const store = await FileDataStore.create(join(tempDir, 'store.json'));
    await store.saveModelConfig({ baseUrl: 'mock', apiKey: 'mock', modelName: 'mock-model' });
    const memory = new MemoryService(await MemoryStore.create(join(tempDir, 'memory.json')));
    const proxy = new CaptureProxy();
    const modelConfigService = new ModelConfigService(store);
    const orchestrator = new AgentOrchestrator(
      store,
      modelConfigService,
      proxy,
      undefined as never,
      undefined as never,
      memory,
    );

    const first = await orchestrator.run(
      { task: 'full_novel', mode: 'draft', prompt: '代码御剑', options: { chapters: 2, targetWords: 500 } },
      new AbortController().signal,
    );
    await orchestrator.run(
      {
        task: 'full_novel',
        mode: 'draft',
        prompt: '代码御剑',
        projectId: first.projectId,
        options: { chapters: 2, targetWords: 500 },
      },
      new AbortController().signal,
    );

    expect(proxy.chapterSystems.at(-2)).toContain('第 3 / 4 章');
    expect(proxy.chapterSystems.at(-1)).toContain('第 4 / 4 章');
    const thirdAnchor = extractAnchorBlock(proxy.chapterSystems.at(-2) ?? '');
    const fourthAnchor = extractAnchorBlock(proxy.chapterSystems.at(-1) ?? '');
    expect(thirdAnchor).toContain('第三章：符文工坊的秘密');
    expect(thirdAnchor).not.toContain('第四章：御剑飞行是逆向工程');
    expect(fourthAnchor).toContain('第四章：御剑飞行是逆向工程');
    expect((await (store as DataStore).listChapters(first.projectId))).toHaveLength(4);
  });

  it('creates a persisted 500-chapter control outline before a short batched run', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-orchestrator-long-'));
    const store = await FileDataStore.create(join(tempDir, 'store.json'));
    await store.saveModelConfig({ baseUrl: 'mock', apiKey: 'mock', modelName: 'mock-model' });
    const memory = new MemoryService(await MemoryStore.create(join(tempDir, 'memory.json')));
    const proxy = new CaptureProxy();
    const orchestrator = new AgentOrchestrator(
      store,
      new ModelConfigService(store),
      proxy,
      undefined as never,
      undefined as never,
      memory,
    );

    const result = await orchestrator.run(
      {
        task: 'full_novel',
        mode: 'draft',
        prompt: '代码御剑',
        options: { chapters: 2, totalChapters: 500, targetWords: 2000 },
      },
      new AbortController().signal,
    );

    const outlines = await store.listOutlines(result.projectId);
    const controlOutline = outlines.find((outline) => outline.title.includes('长篇章节控制大纲'));
    expect(proxy.controlSystems).toHaveLength(10);
    expect(controlOutline?.content).toContain('总章数：500');
    expect(extractChapterOutline(controlOutline?.content ?? '', 500)).toContain('控制锚点500');
    expect(proxy.chapterSystems[0]).toContain('第 1 / 500 章');
    expect(proxy.chapterSystems[1]).toContain('第 2 / 500 章');
    expect(result.metrics?.plannedWords).toBe(1_000_000);
  });
});

function extractAnchorBlock(system: string): string {
  const start = system.indexOf('# 本章大纲锚点');
  if (start < 0) return '';
  const rest = system.slice(start);
  const next = rest.indexOf('\n# ', '# 本章大纲锚点'.length);
  return next < 0 ? rest : rest.slice(0, next);
}
