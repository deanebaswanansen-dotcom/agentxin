import { describe, expect, it, vi } from 'vitest';
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { ModelConfig } from '../../types/index.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import {
  collectScaleFromSession,
  extractScaleFromText,
  MAX_OUTLINE_CHAPTERS,
  NovelPlanService,
} from './NovelPlanService.js';

function mockConfigService(config: ModelConfig | undefined): ModelConfigService {
  return {
    getInternalConfig: vi.fn().mockResolvedValue(config),
  } as unknown as ModelConfigService;
}

function mockProxy(content: string): ModelProxy {
  return {
    async *streamCompletion() {
      yield { kind: 'content' as const, text: content };
    },
  };
}

describe('NovelPlanService depth modes', () => {
  it('first turn without depth returns depth selection (light / standard / deep)', async () => {
    const service = new NovelPlanService(mockConfigService(undefined), mockProxy(''));
    const result = await service.turn(
      { seedPrompt: '写一本修仙小说', targetTask: 'full_novel' },
      new AbortController().signal,
    );
    expect(result.status).toBe('asking');
    expect(result.round).toBe(0);
    expect(result.questions?.[0]?.id).toBe('plan_depth');
    const ids = result.questions?.[0]?.options.map((o) => o.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(['light', 'standard', 'deep']));
  });

  it('choosing light depth starts content round 1 with 2-3 questions', async () => {
    const service = new NovelPlanService(mockConfigService(undefined), mockProxy(''));
    const result = await service.turn(
      {
        seedPrompt: '写一本修仙小说',
        targetTask: 'full_novel',
        history: [
          { role: 'user', content: '灵感：写一本修仙小说' },
          { role: 'assistant', content: '先选计划深度' },
        ],
        answers: [{ questionId: 'plan_depth', selectedOptionIds: ['light'] }],
      },
      new AbortController().signal,
    );
    expect(result.status).toBe('asking');
    expect(result.depth).toBe('light');
    expect(result.depthRoundRange).toEqual([4, 5]);
    expect(result.round).toBe(1);
    expect((result.questions?.length ?? 0) >= 2).toBe(true);
    expect((result.questions?.length ?? 0) <= 3).toBe(true);
  });

  it('starts content round 1 when the browser sends depth and plan_depth together', async () => {
    const service = new NovelPlanService(mockConfigService(undefined), mockProxy(''));
    const result = await service.turn(
      {
        seedPrompt: '写一本民俗小说',
        targetTask: 'long_novel',
        depth: 'deep',
        history: [
          { role: 'user', content: '灵感：写一本民俗小说' },
          { role: 'assistant', content: '进入计划模式前，先选追问深度。' },
        ],
        answers: [{ questionId: 'plan_depth', selectedOptionIds: ['deep'] }],
      },
      new AbortController().signal,
    );

    expect(result.round).toBe(1);
    expect(result.questions?.map((q) => q.id)).toEqual([
      'genre_lane',
      'core_hook',
      'tone_pace',
    ]);
  });

  it('does not repeat question ids across consecutive scripted rounds', async () => {
    const service = new NovelPlanService(mockConfigService(undefined), mockProxy(''));
    const r1 = await service.turn(
      {
        seedPrompt: '写一本修仙小说',
        depth: 'light',
        history: [
          { role: 'user', content: '灵感：写一本修仙小说' },
          { role: 'assistant', content: '轻量第1轮' },
        ],
      },
      new AbortController().signal,
    );
    const ids1 = new Set((r1.questions ?? []).map((q) => q.id));
    const r2 = await service.turn(
      {
        seedPrompt: '写一本修仙小说',
        depth: 'light',
        history: [
          { role: 'user', content: '灵感：写一本修仙小说' },
          { role: 'assistant', content: '轻量第1轮' },
          {
            role: 'user',
            content: [...ids1].map((id) => `- ${id}: opt`).join('\n'),
          },
          { role: 'assistant', content: '轻量第2轮提示' },
        ],
        answers: [...ids1].map((id) => ({ questionId: id, selectedOptionIds: ['x'] })),
      },
      new AbortController().signal,
    );
    const ids2 = (r2.questions ?? []).map((q) => q.id);
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
    expect(ids2.length).toBeGreaterThanOrEqual(2);
  });

  it('does not repeat questions across a deep browser-formatted plan session', async () => {
    const service = new NovelPlanService(mockConfigService(undefined), mockProxy(''));
    const signal = new AbortController().signal;
    const seedPrompt = '写一本民俗悬疑小说';
    const depthTurn = await service.turn({ seedPrompt, targetTask: 'long_novel' }, signal);
    let history = [
      { role: 'user' as const, content: `灵感：${seedPrompt}` },
      { role: 'assistant' as const, content: depthTurn.message },
    ];
    let previousQuestions = depthTurn.questions ?? [];
    let answers = [{ questionId: 'plan_depth', selectedOptionIds: ['deep'] }];
    const seen = new Set<string>();
    let reachedReady = false;

    for (let turn = 0; turn < 20; turn += 1) {
      const response = await service.turn(
        { seedPrompt, targetTask: 'long_novel', depth: 'deep', history, answers },
        signal,
      );
      const questions = response.questions ?? [];
      for (const question of questions) {
        expect(seen.has(question.id), `重复问题：${question.id}`).toBe(false);
        seen.add(question.id);
      }
      if (response.status === 'ready') {
        reachedReady = true;
        break;
      }

      const userLine = answers
        .map((answer) => {
          const question = previousQuestions.find((item) => item.id === answer.questionId);
          const optionId = answer.selectedOptionIds[0] ?? '';
          const label = question?.options.find((item) => item.id === optionId)?.label ?? optionId;
          return `- ${answer.questionId}: ${optionId} | ${question?.question ?? answer.questionId} → ${label}`;
        })
        .join('\n');
      history = [
        ...history,
        { role: 'user', content: userLine },
        { role: 'assistant', content: response.message },
      ];
      previousQuestions = questions;
      answers = questions.map((question) => ({
        questionId: question.id,
        selectedOptionIds: [question.options[0]?.id ?? ''],
      }));
    }
    expect(reachedReady).toBe(true);
  });

  it('does not repeat questions when an already-open browser uses the legacy history format', async () => {
    const service = new NovelPlanService(mockConfigService(undefined), mockProxy(''));
    const signal = new AbortController().signal;
    const seedPrompt = '写一本民俗悬疑小说';
    const depthTurn = await service.turn({ seedPrompt, targetTask: 'long_novel' }, signal);
    let history = [
      { role: 'user' as const, content: `灵感：${seedPrompt}` },
      { role: 'assistant' as const, content: depthTurn.message },
    ];
    let previousQuestions = depthTurn.questions ?? [];
    let answers = [{ questionId: 'plan_depth', selectedOptionIds: ['standard'] }];
    const seen = new Set<string>();
    let reachedReady = false;

    for (let turn = 0; turn < 10; turn += 1) {
      const response = await service.turn(
        { seedPrompt, targetTask: 'long_novel', depth: 'standard', history, answers },
        signal,
      );
      const questions = response.questions ?? [];
      for (const question of questions) {
        expect(seen.has(question.id), `旧页面重复问题：${question.id}`).toBe(false);
        seen.add(question.id);
      }
      if (response.status === 'ready') {
        reachedReady = true;
        break;
      }

      const userLine = answers
        .map((answer) => {
          const question = previousQuestions.find((item) => item.id === answer.questionId);
          const optionId = answer.selectedOptionIds[0] ?? '';
          const label = question?.options.find((item) => item.id === optionId)?.label ?? optionId;
          return `${question?.question ?? answer.questionId} → ${label}`;
        })
        .join('\n');
      history = [
        ...history,
        { role: 'user', content: userLine },
        { role: 'assistant', content: response.message },
      ];
      previousQuestions = questions;
      answers = questions.map((question) => ({
        questionId: question.id,
        selectedOptionIds: [question.options[0]?.id ?? ''],
      }));
    }
    expect(reachedReady).toBe(true);
  });

  it('standard depth reports 8-10 range', async () => {
    const service = new NovelPlanService(mockConfigService(undefined), mockProxy(''));
    const result = await service.turn(
      {
        seedPrompt: '都市异能',
        history: [
          { role: 'user', content: '灵感：都市异能' },
          { role: 'assistant', content: '选深度' },
        ],
        answers: [{ questionId: 'plan_depth', selectedOptionIds: ['standard'] }],
      },
      new AbortController().signal,
    );
    expect(result.depth).toBe('standard');
    expect(result.depthRoundRange).toEqual([8, 10]);
  });

  it('deep depth reports 18-20 range', async () => {
    const service = new NovelPlanService(mockConfigService(undefined), mockProxy(''));
    const result = await service.turn(
      {
        seedPrompt: '科幻长篇',
        history: [
          { role: 'user', content: '灵感：科幻长篇' },
          { role: 'assistant', content: '选深度' },
        ],
        answers: [{ questionId: 'plan_depth', selectedOptionIds: ['deep'] }],
      },
      new AbortController().signal,
    );
    expect(result.depth).toBe('deep');
    expect(result.depthRoundRange).toEqual([18, 20]);
  });

  it('forceReady with scale after depth yields chapter outlines', async () => {
    const service = new NovelPlanService(mockConfigService(undefined), mockProxy(''));
    const result = await service.turn(
      {
        seedPrompt: '写一本修仙小说',
        depth: 'light',
        history: [
          { role: 'user', content: '灵感：写一本修仙小说' },
          { role: 'assistant', content: '轻量模式第1轮' },
          { role: 'user', content: '选了玄幻' },
          { role: 'assistant', content: '轻量模式第2轮' },
        ],
        answers: [
          { questionId: 'total_words', selectedOptionIds: ['total_100k'] },
          { questionId: 'words_per_chapter', selectedOptionIds: ['wpc_2000'] },
          { questionId: 'chapter_count', selectedOptionIds: ['ch_10'] },
        ],
        forceReady: true,
      },
      new AbortController().signal,
    );
    expect(result.status).toBe('ready');
    expect(result.planSummary?.chapterOutlines?.length).toBe(10);
    expect(result.brief).toContain('分章大纲');
  });

  it('rejects empty seedPrompt', async () => {
    const service = new NovelPlanService(mockConfigService(undefined), mockProxy(''));
    await expect(service.turn({ seedPrompt: '   ' }, new AbortController().signal)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('extractScaleFromText chapter count', () => {
  it('restores scale from legacy browser labels', () => {
    expect(
      collectScaleFromSession([
        {
          role: 'user',
          content:
            '全书目标总字数大约多少？ → 约 10 万字\n' +
            '每一章目标字数？ → 约 2000 字\n' +
            '先规划写多少章？ → 10 章',
        },
      ]),
    ).toEqual({ totalWords: 100000, wordsPerChapter: 2000, chapterCount: 10 });
  });

  it('restores scale option ids from browser-formatted history', () => {
    expect(
      collectScaleFromSession([
        {
          role: 'user',
          content:
            '- total_words: total_100k | 全书目标总字数大约多少？ → 约 10 万字\n' +
            '- words_per_chapter: wpc_2000 | 每一章目标字数？ → 约 2000 字\n' +
            '- chapter_count: ch_10 | 先规划写多少章？ → 10 章',
        },
      ]),
    ).toEqual({ totalWords: 100000, wordsPerChapter: 2000, chapterCount: 10 });
  });

  it('does not treat 前N章 as chapterCount', () => {
    expect(extractScaleFromText('前3章要精彩').chapterCount).toBeUndefined();
    expect(extractScaleFromText('前 10 章先立人设').chapterCount).toBeUndefined();
  });

  it('does not treat 第N章 / 第N章内 as chapterCount', () => {
    expect(extractScaleFromText('第1章内解决冲突').chapterCount).toBeUndefined();
    expect(extractScaleFromText('第 1 章开局打脸').chapterCount).toBeUndefined();
  });

  it('does not treat bare N章 goal text as chapterCount', () => {
    expect(extractScaleFromText('3章内大冲突').chapterCount).toBeUndefined();
    expect(extractScaleFromText('写3章内解决冲突').chapterCount).toBeUndefined();
  });

  it('accepts explicit scale phrases', () => {
    expect(extractScaleFromText('计划写30章').chapterCount).toBe(30);
    expect(extractScaleFromText('一共30章').chapterCount).toBe(30);
    expect(extractScaleFromText('共 20 章').chapterCount).toBe(20);
    expect(extractScaleFromText('约50章').chapterCount).toBe(50);
    expect(extractScaleFromText('总章数 15').chapterCount).toBe(15);
    expect(extractScaleFromText('计划章节数：12').chapterCount).toBe(12);
    expect(extractScaleFromText('先规划写10章').chapterCount).toBe(10);
    expect(extractScaleFromText('写 10 章').chapterCount).toBe(10);
    expect(extractScaleFromText('30章左右').chapterCount).toBe(30);
    expect(extractScaleFromText('10章大纲').chapterCount).toBe(10);
    expect(extractScaleFromText('20章计划').chapterCount).toBe(20);
  });
});

describe('collectScaleFromSession', () => {
  it('option id ch_10 still sets chapterCount to 10', () => {
    const scale = collectScaleFromSession([], [
      { questionId: 'chapter_count', selectedOptionIds: ['ch_10'] },
    ]);
    expect(scale.chapterCount).toBe(10);
  });

  it('option ids ch_3 / ch_30 still work', () => {
    expect(
      collectScaleFromSession([], [{ questionId: 'chapter_count', selectedOptionIds: ['ch_3'] }])
        .chapterCount,
    ).toBe(3);
    expect(
      collectScaleFromSession([], [{ questionId: 'chapter_count', selectedOptionIds: ['ch_30'] }])
        .chapterCount,
    ).toBe(30);
  });

  it('option id ch_50 maps to MAX_OUTLINE_CHAPTERS (outline cap)', () => {
    const scale = collectScaleFromSession([], [
      { questionId: 'chapter_count', selectedOptionIds: ['ch_50'] },
    ]);
    expect(scale.chapterCount).toBe(MAX_OUTLINE_CHAPTERS);
    expect(scale.chapterCount).toBe(30);
  });

  it('history non-scale 前N章 does not corrupt chapterCount over explicit option', () => {
    const scale = collectScaleFromSession(
      [
        { role: 'user', content: '前3章要精彩，第1章内解决冲突' },
        { role: 'assistant', content: '继续' },
      ],
      [{ questionId: 'chapter_count', selectedOptionIds: ['ch_10'] }],
    );
    expect(scale.chapterCount).toBe(10);
  });

  it('explicit free-text scale in history is collected', () => {
    const scale = collectScaleFromSession([
      { role: 'user', content: '计划写30章，每章2000字' },
    ]);
    expect(scale.chapterCount).toBe(30);
    expect(scale.wordsPerChapter).toBe(2000);
  });
});
