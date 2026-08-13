import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BLUEPRINT_REQUIREMENT_MAX_CHARS,
  buildChapterBlueprintRequirement,
  buildControlOutlineFromPlan,
  extractChapterOutfitPlan,
  extractChapterOutline,
  normalizeFullNovelOptions,
  normalizeLongNovelTotalWords,
  remainingLongNovelBatch,
  parseCharacterProfiles,
  parseReflection,
  revisionDoesNotWorsenWordRange,
  AgentOrchestrator,
} from './AgentOrchestrator.js';
import type { ModelProxy, StreamCompletionOptions } from '../../proxy/ModelProxy.js';
import { ProxyError } from '../../proxy/ProxyError.js';
import type { DataStore } from '../../store/DataStore.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import { MemoryService } from '../memory/MemoryService.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import type { ChatMessage, ModelConfig, NovelStoryPlan } from '../../types/index.js';
import type { StreamDelta } from '../../proxy/sseParser.js';

const STORY_PLAN: NovelStoryPlan = {
  metadata: { title: '代码御剑', genre: '赛博修仙', targetLength: 1600, tone: '硬核爽文' },
  premise: { oneSentence: '程序员用漏洞修仙。', coreConflict: '个人自由与学院垄断冲突。' },
  protagonist: {
    name: '陆辞',
    identity: '黑户程序员',
    personality: ['冷静'],
    motivation: '摆脱追捕',
    goal: '破解聚灵网络',
    weakness: '不信任他人',
    growthArc: '从独行到承担团队责任',
  },
  world: {
    overview: '灵气由学院垄断的赛博修仙世界。',
    regions: [],
    countries: [],
    races: [],
    religions: [],
    factions: ['中央学院'],
    history: [],
  },
  powerSystem: {
    rules: ['代码可改写阵法'],
    levels: [],
    limitations: ['算力有限'],
    specialCases: [],
  },
  characters: [],
  factions: ['中央学院'],
  mainPlot: { beginning: '潜入学院', development: '破解阵法', climax: '公开漏洞', ending: '打破垄断' },
  subplots: [],
  characterArcs: [],
  volumes: [],
  foreshadowing: ['神秘芯片来源'],
  mysteries: [],
  constraints: { mustInclude: ['阵法漏洞'], mustAvoid: ['后宫'] },
};

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
      text = JSON.stringify({
        summary: '洛言推进代码御剑主线',
        facts: [{ kind: 'character', text: '洛言保持谨慎稳定' }],
        learning: '保持代码御剑风格',
        foreshadows: [
          {
            action: 'plant',
            title: '热数据坟场',
            detail: '学院深处存在被封锁的热数据坟场',
            urgency: 'high',
            suggestPayoffBy: '中后期',
          },
        ],
      });
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

  it('honors an explicitly configured short total instead of silently raising it to 10,000 words', () => {
    expect(normalizeLongNovelTotalWords(2400)).toBe(2400);
    expect(normalizeLongNovelTotalWords(undefined)).toBe(200_000);
  });

  it('clips a resumed batch to the chapters remaining in the full plan', () => {
    expect(remainingLongNovelBatch(3, 2, 3)).toBe(1);
    expect(remainingLongNovelBatch(3, 3, 3)).toBe(0);
    expect(remainingLongNovelBatch(3, 1, 10)).toBe(3);
  });

  it('rejects a ReviewAgent revision that moves farther outside the confirmed word range', () => {
    expect(
      revisionDoesNotWorsenWordRange('甲'.repeat(1200), '乙'.repeat(2200), {
        minWords: 700,
        maxWords: 900,
      }),
    ).toBe(false);
    expect(
      revisionDoesNotWorsenWordRange('甲'.repeat(1200), '乙'.repeat(850), {
        minWords: 700,
        maxWords: 900,
      }),
    ).toBe(true);
  });

  it('keeps blueprint requirements within the API limit without dropping story memory', () => {
    const requirement = buildChapterBlueprintRequirement({
      chapterNumber: 7,
      chapterTitle: '破碎盟约',
      targetWords: 3000,
      chapterGoal: '推进联盟冲突。'.repeat(400),
      seedPrompt: '西方玄幻世界设定。'.repeat(1000),
      memoryContext: '塞琳娜的发尾灰黑。'.repeat(1000),
    });

    expect(requirement.length).toBeLessThanOrEqual(BLUEPRINT_REQUIREMENT_MAX_CHARS);
    expect(requirement).toContain('章节编号：7');
    expect(requirement).toContain('整本题材与用户要求');
    expect(requirement).toContain('当前故事记忆');
    expect(requirement).toContain('塞琳娜');
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

  it('parses foreshadow ops from reflection JSON', () => {
    const parsed = parseReflection(
      JSON.stringify({
        summary: '开篇',
        facts: [],
        learning: '短句',
        foreshadows: [
          { action: 'plant', title: '神秘芯片', detail: '袖口闪过芯片', urgency: 'high' },
          { action: 'resolve', title: '神秘芯片', detail: '是监工信标' },
          { action: 'noop', title: '无效' },
        ],
      }),
    );
    expect(parsed.foreshadows).toHaveLength(2);
    expect(parsed.foreshadows[0]).toMatchObject({ action: 'plant', title: '神秘芯片', urgency: 'high' });
    expect(parsed.foreshadows[1]?.action).toBe('resolve');
  });

  it('formats plan chapter outlines into extractable control anchors', () => {
    const control = buildControlOutlineFromPlan(
      [
        { number: 1, title: '黑户入学', goal: '陆辞潜入学院', estimatedWords: 2000 },
        { number: 2, title: '第一堂课', goal: '用漏洞完成聚灵阵' },
      ],
      3,
      2000,
    );
    expect(extractChapterOutline(control, 1)).toContain('陆辞潜入学院');
    expect(extractChapterOutline(control, 2)).toContain('用漏洞完成聚灵阵');
    expect(extractChapterOutline(control, 3)).toContain('本章锚点');
  });

  it('adopts planSummary chapter outlines instead of regenerating control outline', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-orchestrator-plan-'));
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
        prompt: '代码御剑长篇',
        options: {
          chapters: 2,
          targetWords: 800,
          planSummary: {
            title: '代码御剑',
            genre: '赛博修仙',
            protagonist: '陆辞',
            hook: '写代码御剑',
            tone: '硬核爽文',
            constraints: ['不写后宫', '不降智反派'],
            chapterCount: 2,
            wordsPerChapter: 800,
            totalWords: 1600,
            storyPlan: STORY_PLAN,
            chapterOutlines: [
              { number: 1, title: '黑户入学', goal: '陆辞绕过身份验证进入学院。' },
              { number: 2, title: '第一堂课', goal: '陆辞用低算力漏洞完成聚灵阵。' },
            ],
          },
        },
      },
      new AbortController().signal,
    );

    // 计划已提供全部分章锚点，不应再调用总控策划 LLM
    expect(proxy.controlSystems).toHaveLength(0);
    const outlines = await store.listOutlines(result.projectId);
    expect(outlines.some((o) => o.title.includes('分章大纲（计划采纳）'))).toBe(true);
    const worlds = await store.listWorldSettings(result.projectId);
    expect(worlds.some((w) => w.title.includes('创作规则'))).toBe(true);
    expect(worlds.find((w) => w.title === 'Story Plan（计划锁定）')?.content).toContain(
      '代码可改写阵法',
    );
    const chapters = await store.listChapters(result.projectId);
    expect(chapters[0]?.title).toContain('黑户入学');
    expect(chapters[1]?.title).toContain('第一堂课');
    expect(proxy.chapterSystems[0]).toContain('陆辞绕过身份验证进入学院');
    expect(result.summary).toContain('按计划');
    expect(result.steps.some((s) => s.includes('已采纳分章大纲'))).toBe(true);
  });

  it('parses named character profiles and the chapter outfit table', () => {
    const markdown = [
      '# 人物与口吻护栏',
      '## 人物：林夜',
      '- 身份/年龄：学生，18岁',
      '- 基础服装：黑色校服、银色袖扣',
      '## 人物：苏青',
      '- 身份/年龄：导师，27岁',
      '- 基础服装：灰色风衣、短靴',
      '## 分章人物服装连续性表',
      '| 章节 | 人物 | 服装与配件 | 换装原因/连续性 |',
      '| 第一章 | 林夜 | 黑色校服 | 入学 |',
    ].join('\n');

    expect(parseCharacterProfiles(markdown).map((item) => item.name)).toEqual(['林夜', '苏青']);
    expect(parseCharacterProfiles(markdown)[0]?.description).toContain('黑色校服');
    expect(extractChapterOutfitPlan(markdown)).toContain('第一章');
  });

  it('updates plan materials instead of duplicating them across chapter batches', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-orchestrator-plan-upsert-'));
    const store = await FileDataStore.create(join(tempDir, 'store.json'));
    await store.saveModelConfig({ baseUrl: 'mock', apiKey: 'mock', modelName: 'mock-model' });
    const memory = new MemoryService(await MemoryStore.create(join(tempDir, 'memory.json')));
    const orchestrator = new AgentOrchestrator(
      store,
      new ModelConfigService(store),
      new CaptureProxy(),
      undefined as never,
      undefined as never,
      memory,
    );
    const planSummary = {
      title: '代码御剑',
      protagonist: '陆辞',
      chapterCount: 2,
      totalWords: 1000,
      wordsPerChapter: 500,
      constraints: ['不写后宫'],
      chapterOutlines: [
        { number: 1, title: '黑户入学', goal: '陆辞潜入学院。' },
        { number: 2, title: '第一堂课', goal: '陆辞修复聚灵阵。' },
      ],
    };

    const first = await orchestrator.run(
      {
        task: 'long_novel',
        mode: 'draft',
        prompt: '代码御剑',
        options: {
          chapters: 1,
          totalChapters: 2,
          targetWords: 500,
          automationLevel: 'semi_auto',
          planSummary,
        },
      },
      new AbortController().signal,
    );
    await orchestrator.run(
      {
        task: 'long_novel',
        mode: 'draft',
        prompt: '代码御剑',
        projectId: first.projectId,
        options: {
          chapters: 1,
          totalChapters: 2,
          targetWords: 500,
          automationLevel: 'semi_auto',
          planSummary,
        },
      },
      new AbortController().signal,
    );

    const worlds = await store.listWorldSettings(first.projectId);
    const characters = await store.listCharacters(first.projectId);
    const outlines = await store.listOutlines(first.projectId);
    expect(characters.map((item) => item.name)).toContain('陆辞');
    expect(characters.map((item) => item.name)).not.toContain('人物与口吻护栏');
    expect(worlds.filter((item) => item.title === '创作规则（计划采纳）')).toHaveLength(1);
    expect(outlines.filter((item) => item.title.endsWith('：分章大纲（计划采纳）'))).toHaveLength(1);
    expect(outlines.filter((item) => item.title === '长篇小说模式配置')).toHaveLength(1);
    expect(outlines.filter((item) => item.title === '分章人物服装表')).toHaveLength(1);
    expect(outlines.find((item) => item.title === '分章人物服装表')?.content).toContain(
      '分章人物服装连续性表',
    );
  });

  it('runs long_novel multi-subagent pipeline with gates and config outline', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-orchestrator-longmode-'));
    const store = await FileDataStore.create(join(tempDir, 'store.json'));
    await store.saveModelConfig({ baseUrl: 'mock', apiKey: 'mock', modelName: 'mock-model' });
    const memory = new MemoryService(await MemoryStore.create(join(tempDir, 'memory.json')));
    const proxy = new CaptureProxy();
    // 正文写长一点，避免格式 Gate 字数 soft 干扰
    const orig = proxy.streamCompletion.bind(proxy);
    proxy.streamCompletion = (config, messages, signal, options) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('正文写作子 Agent')) {
        proxy.chapterSystems.push(system);
        const text =
          '林远推开门，雨砸在锈蚀的招牌上。他说：“跟我来。”空气里有机油与血腥。他们却发现地图是假的，真正的危机才刚开始。'.repeat(
            8,
          );
        return (async function* () {
          yield { kind: 'content' as const, text };
        })();
      }
      return orig(config, messages, signal, options);
    };
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
        task: 'long_novel',
        mode: 'draft',
        prompt: '赛博修仙学院，主角靠写代码御剑',
        options: {
          chapters: 2,
          targetWords: 500,
          totalWords: 100_000,
          automationLevel: 'semi_auto',
        },
      },
      new AbortController().signal,
    );

    expect(result.task).toBe('long_novel');
    expect(result.steps.some((s) => s.includes('PlanningDirector') || s.includes('多子代理'))).toBe(
      true,
    );
    const outlines = await store.listOutlines(result.projectId);
    expect(outlines.some((o) => o.title.includes('长篇小说模式配置'))).toBe(true);
    expect((result.metrics?.completedChapters ?? 0) >= 1).toBe(true);
    const artifactKeys = result.artifacts.map((artifact) => `${artifact.kind}:${artifact.id}`);
    expect(new Set(artifactKeys).size).toBe(artifactKeys.length);
  });

  it('retries an empty ChapterAgent response before continuity review', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-orchestrator-empty-chapter-retry-'));
    const store = await FileDataStore.create(join(tempDir, 'store.json'));
    await store.saveModelConfig({ baseUrl: 'mock', apiKey: 'mock', modelName: 'mock-model' });
    const memory = new MemoryService(await MemoryStore.create(join(tempDir, 'memory.json')));
    const proxy = new CaptureProxy();
    const original = proxy.streamCompletion.bind(proxy);
    const chapterPipeline: string[] = [];
    let writerAttempts = 0;
    proxy.streamCompletion = (config, messages, signal, options) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('正文写作子 Agent')) {
        writerAttempts += 1;
        chapterPipeline.push('writer');
        const text =
          writerAttempts < 3
            ? ''
            : '林远拔出断剑，雨水沿着护手滴落。他说：“誓言还没有结束。”守卫却突然封死城门，远处的钟声揭开了新的危险。'.repeat(12);
        return (async function* () {
          yield { kind: 'content' as const, text };
        })();
      }
      if (system.includes('检测子 Agent')) {
        chapterPipeline.push('inspector');
        return (async function* () {
          yield {
            kind: 'content' as const,
            text: JSON.stringify({
              score0to100: 85,
              verdict: 'pass',
              plotCoherence: '连续',
              fatalIssues: [],
              earlyCharacterStatus: [],
              recommendRevision: false,
              revisionHints: [],
            }),
          };
        })();
      }
      return original(config, messages, signal, options);
    };
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
        task: 'long_novel',
        mode: 'draft',
        prompt: '西方玄幻，断剑骑士履行誓言',
        options: { chapters: 1, targetWords: 500, automationLevel: 'semi_auto' },
      },
      new AbortController().signal,
    );

    const chapters = await store.listChapters(result.projectId);
    expect(writerAttempts).toBe(3);
    expect(chapterPipeline.slice(0, 4)).toEqual(['writer', 'writer', 'writer', 'inspector']);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.content).toContain('誓言还没有结束');
    expect(result.metrics?.completedChapters).toBe(1);
    expect(result.summary).not.toContain('已暂停');
  });

  it('retries transient provider errors in the direct long-chapter fallback', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-orchestrator-provider-retry-'));
    const store = await FileDataStore.create(join(tempDir, 'store.json'));
    await store.saveModelConfig({ baseUrl: 'mock', apiKey: 'mock', modelName: 'mock-model' });
    const memory = new MemoryService(await MemoryStore.create(join(tempDir, 'memory.json')));
    const proxy = new CaptureProxy();
    const original = proxy.streamCompletion.bind(proxy);
    let writerAttempts = 0;
    proxy.streamCompletion = (config, messages, signal, options) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('正文写作子 Agent')) {
        writerAttempts += 1;
        if (writerAttempts <= 2) {
          return (async function* () {
            throw new ProxyError('模型提供商暂时不可用', { status: 503 });
          })();
        }
        return (async function* () {
          yield {
            kind: 'content' as const,
            text: '林远推门走进雨夜，说：“跟我来。”他们发现地图暗藏秘密，真正的危险才刚刚开始。'.repeat(10),
          };
        })();
      }
      return original(config, messages, signal, options);
    };

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
        task: 'long_novel',
        mode: 'draft',
        prompt: '西方玄幻，断剑骑士履行誓言',
        options: { chapters: 1, targetWords: 500, automationLevel: 'semi_auto' },
      },
      new AbortController().signal,
    );

    expect(writerAttempts).toBe(3);
    expect(result.metrics?.completedChapters).toBe(1);
    expect(result.summary).not.toContain('已暂停');
  });

  it('keeps the saved draft when ReviewAgent revision fails', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-orchestrator-review-fallback-'));
    const store = await FileDataStore.create(join(tempDir, 'store.json'));
    await store.saveModelConfig({ baseUrl: 'mock', apiKey: 'mock', modelName: 'mock-model' });
    const memory = new MemoryService(await MemoryStore.create(join(tempDir, 'memory.json')));
    const proxy = new CaptureProxy();
    const original = proxy.streamCompletion.bind(proxy);
    let revisionAttempts = 0;
    proxy.streamCompletion = (config, messages, signal, options) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('正在修订')) {
        revisionAttempts += 1;
        return (async function* () {
          throw new ProxyError('模型提供商返回错误状态 502', { status: 502 });
        })();
      }
      if (system.includes('检测子 Agent')) {
        return (async function* () {
          yield {
            kind: 'content' as const,
            text: JSON.stringify({
              score0to100: 65,
              verdict: 'needs_revision',
              plotCoherence: '可继续',
              fatalIssues: [],
              earlyCharacterStatus: [],
              recommendRevision: true,
              revisionHints: ['加强章末钩子'],
            }),
          };
        })();
      }
      if (system.includes('正文写作子 Agent')) {
        const text =
          '林远推门走进雨夜，说：“跟我来。”他们沿着旧城前行，却发现地图暗藏秘密，真正的危险才刚刚开始。'.repeat(
            10,
          );
        return (async function* () {
          yield { kind: 'content' as const, text };
        })();
      }
      return original(config, messages, signal, options);
    };
    const progress: string[] = [];
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
        task: 'long_novel',
        mode: 'draft',
        prompt: '旧城悬疑',
        options: { chapters: 1, targetWords: 500, automationLevel: 'semi_auto' },
      },
      new AbortController().signal,
      (event) => progress.push(event.message),
    );

    const chapters = await store.listChapters(result.projectId);
    expect(revisionAttempts).toBe(1);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.content).toContain('真正的危险才刚刚开始');
    expect(progress.some((message) => message.includes('修订请求失败'))).toBe(true);
    expect(result.metrics?.completedChapters).toBe(1);
  });

  it('keeps the saved draft when ReviewAgent returns an empty revision', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-orchestrator-empty-revision-'));
    const store = await FileDataStore.create(join(tempDir, 'store.json'));
    await store.saveModelConfig({ baseUrl: 'mock', apiKey: 'mock', modelName: 'mock-model' });
    const memory = new MemoryService(await MemoryStore.create(join(tempDir, 'memory.json')));
    const proxy = new CaptureProxy();
    const original = proxy.streamCompletion.bind(proxy);
    let revisionAttempts = 0;
    proxy.streamCompletion = (config, messages, signal, options) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('正在修订')) {
        revisionAttempts += 1;
        return (async function* () {
          yield { kind: 'content' as const, text: '' };
        })();
      }
      if (system.includes('检测子 Agent')) {
        return (async function* () {
          yield {
            kind: 'content' as const,
            text: JSON.stringify({
              score0to100: 65,
              verdict: 'needs_revision',
              plotCoherence: '可继续',
              fatalIssues: [],
              earlyCharacterStatus: [],
              recommendRevision: true,
              revisionHints: ['加强章末钩子'],
            }),
          };
        })();
      }
      if (system.includes('正文写作子 Agent')) {
        const text =
          '林远推门走进雨夜，说：“跟我来。”他们沿着旧城前行，却发现地图暗藏秘密，真正的危险才刚刚开始。'.repeat(
            10,
          );
        return (async function* () {
          yield { kind: 'content' as const, text };
        })();
      }
      return original(config, messages, signal, options);
    };
    const progress: string[] = [];
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
        task: 'long_novel',
        mode: 'draft',
        prompt: '旧城悬疑',
        options: { chapters: 1, targetWords: 500, automationLevel: 'semi_auto' },
      },
      new AbortController().signal,
      (event) => progress.push(event.message),
    );

    const chapters = await store.listChapters(result.projectId);
    expect(revisionAttempts).toBe(1);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.content).toContain('真正的危险才刚刚开始');
    expect(progress.some((message) => message.includes('返回空正文'))).toBe(true);
    expect(result.metrics?.completedChapters).toBe(1);
  });

  it('plants foreshadows during reflection and injects open ledger into later chapters', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-orchestrator-foreshadow-'));
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
        options: { chapters: 2, targetWords: 500 },
      },
      new AbortController().signal,
    );

    const open = memory.listOpenForeshadows(result.projectId);
    expect(open.some((f) => f.title.includes('热数据坟场'))).toBe(true);
    const outlines = await store.listOutlines(result.projectId);
    expect(outlines.some((o) => o.title === '伏笔台账')).toBe(true);
    // 第 2 章写作时应回灌第 1 章埋下的伏笔
    expect(proxy.chapterSystems[1]).toContain('伏笔台账');
    expect(proxy.chapterSystems[1]).toContain('热数据坟场');
  });
});

function extractAnchorBlock(system: string): string {
  const start = system.indexOf('# 本章大纲锚点');
  if (start < 0) return '';
  const rest = system.slice(start);
  const next = rest.indexOf('\n# ', '# 本章大纲锚点'.length);
  return next < 0 ? rest : rest.slice(0, next);
}
