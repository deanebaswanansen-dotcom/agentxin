import { describe, expect, it, vi } from 'vitest';
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import { ProxyError } from '../../proxy/ProxyError.js';
import type { ChatMessage, ModelConfig } from '../../types/index.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import {
  collectScaleFromSession,
  extractScaleFromText,
  inferExplicitGenre,
  MAX_OUTLINE_CHAPTERS,
  NovelPlanService,
} from './NovelPlanService.js';

const CONFIG: ModelConfig = {
  baseUrl: 'https://api.example.com',
  apiKey: 'test-key',
  modelName: 'test-model',
};

function mockConfigService(config: ModelConfig | undefined = CONFIG): ModelConfigService {
  return {
    getInternalConfig: vi.fn().mockResolvedValue(config),
  } as unknown as ModelConfigService;
}

class QueueProxy implements ModelProxy {
  readonly calls: ChatMessage[][] = [];

  constructor(private readonly outputs: Array<string | Error>) {}

  async *streamCompletion(_config: ModelConfig, messages: ChatMessage[]) {
    this.calls.push(messages);
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    yield { kind: 'content' as const, text: output ?? '' };
  }
}

function outlines(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `灰烬之路 ${index + 1}`,
    goal: `骑士寻找第 ${index + 1} 枚符文，与教廷冲突并获得下一章线索。`,
    estimatedWords: 1200,
  }));
}

function readyDecision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'ready',
    message: '方向明确，开始执行。',
    questions: [],
    brief: '一名流亡骑士追查失落王冠。',
    planSummary: {
      title: '灰烬王冠',
      genre: '西方玄幻',
      protagonist: '流亡骑士艾琳',
      hook: '王冠会吞噬每一位继承者的记忆。',
      tone: '史诗、阴郁',
      constraints: [],
      totalWords: 2400,
      wordsPerChapter: 1200,
      chapterCount: 2,
      chapterOutlines: outlines(2),
      ...overrides,
    },
  });
}

describe('NovelPlanService goal-driven agent', () => {
  it('requires a real model instead of returning a scripted questionnaire', async () => {
    const service = new NovelPlanService(
      { getInternalConfig: vi.fn().mockResolvedValue(undefined) } as unknown as ModelConfigService,
      new QueueProxy([]),
    );
    await expect(
      service.turn({ seedPrompt: '写一本西方玄幻' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
  });

  it('calls the agent immediately and asks at most two blocking questions', async () => {
    const proxy = new QueueProxy([
      JSON.stringify({
        status: 'asking',
        message: '只补充会改变主线的选择。',
        questions: [
          {
            id: 'protagonist_goal',
            question: '主角最优先追求什么？',
            options: [
              { id: 'revenge', label: '复仇' },
              { id: 'throne', label: '夺回王位' },
            ],
          },
          {
            id: 'magic_cost',
            question: '魔法代价采用哪一种？',
            options: [
              { id: 'memory', label: '消耗记忆' },
              { id: 'life', label: '消耗寿命' },
            ],
          },
          {
            id: 'extra',
            question: '不应出现的第三题？',
            options: [
              { id: 'a', label: '甲' },
              { id: 'b', label: '乙' },
            ],
          },
        ],
      }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '写一本西方玄幻，流亡骑士寻找王冠' },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    expect(result.questions).toHaveLength(2);
    const prompt = proxy.calls[0].map((message) => message.content).join('\n');
    expect(prompt).toContain('不是固定问卷或工作流');
    expect(prompt).toContain('已识别硬约束题材：西方玄幻');
  });

  it('keeps explicit western fantasy even when the model drifts to campus fiction', async () => {
    const proxy = new QueueProxy([
      readyDecision({
        genre: '校园青春',
        title: '校园夏日',
        chapterOutlines: outlines(2),
      }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '西方玄幻，两章，每章1200字，流亡女骑士寻找诅咒王冠' },
      new AbortController().signal,
    );

    expect(result.status).toBe('ready');
    expect(result.planSummary?.genre).toBe('西方玄幻');
    expect(result.planSummary?.constraints).toContain(
      '题材固定为西方玄幻，不得替换成其他题材或时代背景',
    );
    expect(result.brief).toContain('原始需求：西方玄幻');
  });

  it('filters repeated questions and forces a ready decision', async () => {
    const repeated = JSON.stringify({
      status: 'asking',
      message: '还想再问一次。',
      questions: [
        {
          id: 'magic_cost',
          question: '魔法代价采用哪一种？',
          options: [
            { id: 'memory', label: '消耗记忆' },
            { id: 'life', label: '消耗寿命' },
          ],
        },
      ],
    });
    const proxy = new QueueProxy([repeated, readyDecision()]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      {
        seedPrompt: '写西方玄幻，两章，每章1200字',
        history: [
          { role: 'assistant', content: 'magic_cost: 魔法代价采用哪一种？' },
          { role: 'user', content: 'magic_cost：消耗记忆' },
        ],
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('ready');
    expect(proxy.calls).toHaveLength(2);
    expect(proxy.calls[1][0].content).toContain('本轮必须 ready');
  });

  it('creates missing chapter outlines with a dedicated agent call', async () => {
    const first = readyDecision({ chapterOutlines: [] });
    const second = JSON.stringify({ chapterOutlines: outlines(2) });
    const proxy = new QueueProxy([first, second]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '西方玄幻，计划写2章，每章1200字' },
      new AbortController().signal,
    );

    expect(result.planSummary?.chapterOutlines).toHaveLength(2);
    expect(proxy.calls[1][0].content).toContain('必须连续生成 2 章');
    expect(result.brief).toContain('第2章 灰烬之路 2');
  });

  it('repairs malformed JSON once and fails clearly after two invalid responses', async () => {
    const service = new NovelPlanService(
      mockConfigService(),
      new QueueProxy(['not-json', 'still-not-json']),
    );
    await expect(
      service.turn({ seedPrompt: '写西方玄幻' }, new AbortController().signal),
    ).rejects.toThrow('模型连续两次未返回有效 JSON');
  });

  it('does not silently replace provider failures with templates', async () => {
    const service = new NovelPlanService(
      mockConfigService(),
      new QueueProxy([new ProxyError('provider unavailable')]),
    );
    await expect(
      service.turn({ seedPrompt: '写西方玄幻' }, new AbortController().signal),
    ).rejects.toThrow('provider unavailable');
  });

  it('rejects an empty seed', async () => {
    const service = new NovelPlanService(mockConfigService(), new QueueProxy([]));
    await expect(
      service.turn({ seedPrompt: '   ' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('planning facts', () => {
  it('recognizes explicit genres without collapsing western fantasy into generic fantasy', () => {
    expect(inferExplicitGenre('写一本西方玄幻')).toBe('西方玄幻');
    expect(inferExplicitGenre('中式修仙门派')).toBe('仙侠');
  });

  it('collects explicit scale labels and ids without treating 前N章 as total chapters', () => {
    expect(
      collectScaleFromSession([
        {
          role: 'user',
          content:
            '全书目标总字数大约多少？ → 约 10 万字\n每一章目标字数？ → 约 2000 字\n先规划写多少章？ → 10 章',
        },
      ]),
    ).toEqual({ totalWords: 100000, wordsPerChapter: 2000, chapterCount: 10 });
    expect(
      collectScaleFromSession([], [
        { questionId: 'chapter_count', selectedOptionIds: ['ch_50'] },
      ]).chapterCount,
    ).toBe(MAX_OUTLINE_CHAPTERS);
    expect(extractScaleFromText('前3章要精彩，第1章内解决冲突').chapterCount).toBeUndefined();
  });

  it('accepts explicit chapter-count phrases', () => {
    expect(extractScaleFromText('计划写30章').chapterCount).toBe(30);
    expect(extractScaleFromText('写 10 章').chapterCount).toBe(10);
    expect(extractScaleFromText('10章大纲').chapterCount).toBe(10);
  });
});
