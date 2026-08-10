import { describe, expect, it } from 'vitest';

import type { ModelProxy, StreamCompletionOptions } from '../../proxy/ModelProxy.js';
import type { ChatMessage, ModelConfig } from '../../types/index.js';
import type { StreamDelta } from '../../proxy/sseParser.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import { MemoryService } from '../memory/MemoryService.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { parseProfileJson, ReferenceAnalysisService } from './ReferenceAnalysisService.js';
import { ReferenceStore } from './ReferenceStore.js';
import { detectChapters } from './chapterDetect.js';
import { computeChapterMetrics } from './styleMetrics.js';
import { checkSimilarityAgainstReference } from './similarityCheck.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class SilentProxy implements ModelProxy {
  messages: ChatMessage[] = [];
  calls: ChatMessage[][] = [];

  streamCompletion(
    _config: ModelConfig,
    messages: ChatMessage[],
    _signal: AbortSignal,
    _options?: StreamCompletionOptions,
  ): AsyncIterable<StreamDelta> {
    this.messages = messages;
    this.calls.push(messages);
    return (async function* () {
      yield {
        kind: 'content' as const,
        text: JSON.stringify({
          oneLineSummary: '林远在废弃车站发现地图线索，并被卷入逐步升级的生存危机。',
          genreGuess: '玄幻',
          coreConflict: '林远追查车站秘密，同时躲避逼近的对手。',
          mainPlotAbstract: '林远进入废弃车站，遭遇对手并得到半张地图，意识到真正危机刚刚开始。',
          characters: [
            {
              name: '林远',
              role: '主角',
              identity: '断刀的持有者',
              goal: '查清废弃车站与地图的秘密',
              motivation: '求生并回应师父留下的告诫',
              traits: ['警觉', '果断'],
              arc: '从被动应战转为主动追查',
              keyActions: ['进入废弃车站', '击退对手', '取得半张地图'],
            },
          ],
          relationships: [
            {
              from: '林远',
              to: '师父',
              relation: '师徒',
              evolution: '师父的告诫持续影响林远的选择',
            },
          ],
          chapterCharacterOutfits: [
            {
              chapter: '第一章 开端',
              characters: [
                {
                  name: '林远',
                  outfit: '黑色短衣，袖口沾着灰',
                  evidence: '林远拂去黑色短衣袖口的灰',
                  certainty: 'explicit',
                },
              ],
            },
            {
              chapter: '第二章 冲突',
              characters: [
                {
                  name: '林远',
                  outfit: '沿用第一章的黑色短衣',
                  evidence: '第一章穿过，本章没有换装',
                  certainty: 'inferred',
                },
              ],
            },
          ],
          conflicts: [
            {
              type: 'core',
              parties: ['林远', '未知对手'],
              description: '林远为查明真相必须面对追击与未知危机。',
              stakes: '生命与真相',
              progression: '车站异响→被迫应战→地图揭示更大危机',
            },
          ],
          payoffs: [
            {
              title: '击退逼近的对手',
              setup: '金属摩擦声与无人回应制造威胁',
              trigger: '对手逼近',
              payoff: '林远握紧断刀迅速结束战斗',
              impact: '危机暂缓，但半张地图带来更大谜团',
              chapter: '第二章',
            },
          ],
          worldbuilding: {
            premise: '旧时代遗迹中潜藏未知威胁。',
            rules: ['地图是追查危机的重要线索'],
            factions: [],
            locations: ['废弃车站'],
            systems: ['断刀'],
            history: ['师父曾警告林远相关危险'],
            terminology: ['半张地图'],
          },
          plotOutline: [
            {
              stage: '进入谜局',
              chapters: '第一章',
              summary: '林远进入废弃车站并察觉异常。',
              turningPoint: '无人回应暗示威胁潜伏。',
            },
            {
              stage: '冲突升级',
              chapters: '第二至三章',
              summary: '林远击退对手并取得半张地图。',
              turningPoint: '地图表明真正危机才刚开始。',
            },
          ],
          foreshadowing: [
            {
              setup: '车站中的金属摩擦声',
              payoff: '引出逼近的对手',
              status: 'resolved',
            },
          ],
          reversals: [
            {
              setup: '战斗很快结束',
              reversal: '半张地图显示更大的危机仍在后面',
              effect: '局部胜利转化为主线谜团',
              chapter: '第三章',
            },
          ],
          themes: ['面对未知', '师徒传承'],
          characterMethods: ['行动塑造', '危机选择'],
          worldbuildingDelivery: ['冲突展示'],
          transferableMethods: [
            {
              dimension: 'pacing',
              title: '快切',
              method: '短章高频冲突',
              why: '追读',
              howToApply: '每章至少一个有效推进',
            },
            {
              dimension: 'style',
              title: '短句',
              method: '紧张场面短句',
              why: '节奏',
              howToApply: '打斗用短句',
            },
          ],
          strengths: ['节奏明快'],
          risks: ['若抄事件链会同质化'],
          doNotCopy: ['专有地名'],
        }),
      };
    })();
  }
}

const SAMPLE_NOVEL = `
第一章 开端
林远走进废弃车站，听到金属摩擦声。他说：“谁在那里？”没有人回答。风从裂开的穹顶灌入，像旧时代的呼吸。

第二章 冲突
对手逼近，林远被迫应战。他想起师父的告诫，握紧断刀。战斗很快结束，却留下更大的疑问。

第三章 悬念
信封里只有半张地图。林远知道，真正的危机才刚开始。
`.repeat(3);

describe('reference chapterDetect / metrics / similarity', () => {
  it('repairs an unclosed long JSON string before a structural newline', () => {
    const parsed = parseProfileJson(
      [
        '{',
        '  "oneLineSummary": "顾停舟追查无名雾。",',
        '  "plotOutline": [{',
        '    "stage": "开端",',
        '    "chapters": "第1-3章",',
        '    "summary": "发现空灯。",',
        '    "turningPoint": "顾晚星的声音说去水下。',
        '  }]',
        '}',
      ].join('\n'),
    );

    expect(parsed.oneLineSummary).toBe('顾停舟追查无名雾。');
    expect(parsed.plotOutline?.[0]?.turningPoint).toBe('顾晚星的声音说去水下。');
  });

  it('detects Chinese chapter headings', () => {
    const chapters = detectChapters(SAMPLE_NOVEL);
    expect(chapters.length).toBeGreaterThanOrEqual(3);
    expect(chapters[0]?.title).toContain('第');
  });

  it('computes dialogue ratio > 0 when quotes exist', () => {
    const m = computeChapterMetrics('他说：“你好。”然后离开。');
    expect(m.wordCount).toBeGreaterThan(0);
    expect(m.dialogueRatio).toBeGreaterThan(0);
  });

  it('flags long copied spans', () => {
    const span = '林远走进废弃车站，听到金属摩擦声。他说谁在那里没有人回答。风从裂开的穹顶灌入。'.repeat(2);
    const result = checkSimilarityAgainstReference({
      referenceId: 'r1',
      referenceTitle: '样例',
      referenceTexts: [SAMPLE_NOVEL],
      candidateText: span + '额外原创补充文字让长度足够通过阈值。'.repeat(2),
    });
    expect(['warn', 'block']).toContain(result.riskLevel);
  });
});

describe('ReferenceAnalysisService MVP', () => {
  it('imports, analyzes locally/with mock model, transfers, and injects methods only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ref-novel-'));
    try {
      const store = await FileDataStore.create(join(dir, 'store.json'));
      await store.saveModelConfig({ baseUrl: 'mock', apiKey: 'mock', modelName: 'mock' });
      const memory = new MemoryService(MemoryStore.ephemeral());
      const refs = ReferenceStore.ephemeral();
      const proxy = new SilentProxy();
      const service = new ReferenceAnalysisService(
        refs,
        store,
        new ModelConfigService(store),
        proxy,
        memory,
      );

      const imported = await service.importText({
        title: '样例参考',
        text: SAMPLE_NOVEL,
        depth: 'quick',
      });
      expect(imported.chaptersDetected).toBeGreaterThanOrEqual(3);

      expect(imported.chapters.length).toBeGreaterThanOrEqual(3);
      const halfIds = imported.chapters.slice(0, 2).map((c) => c.id);
      const analyzed = await service.analyze(imported.reference.id, new AbortController().signal, {
        chapterIds: halfIds,
        depth: 'quick',
      });
      expect(analyzed.chaptersSelected).toBe(2);
      expect(analyzed.profile.characters?.[0]?.name).toBe('林远');
      expect(analyzed.profile.conflicts?.[0]?.description).toContain('真相');
      expect(analyzed.profile.payoffs?.[0]?.setup).toContain('金属摩擦声');
      expect(analyzed.profile.worldbuilding?.locations).toContain('废弃车站');
      expect(analyzed.profile.plotOutline?.length).toBeGreaterThanOrEqual(2);
      expect(analyzed.profile.chapterCharacterOutfits?.[0]?.characters[0]?.outfit).toContain(
        '黑色短衣',
      );
      expect(analyzed.profile.chapterCharacterOutfits?.[1]?.characters[0]?.certainty).toBe(
        'not_described',
      );
      expect(analyzed.profile.markdownReport).not.toContain('沿用第一章的黑色短衣');
      expect(analyzed.profile.markdownReport).toContain('## 人物');
      expect(analyzed.profile.markdownReport).toContain('## 爽点与兑现');
      expect(proxy.calls[0]?.[0]?.content).toContain('不是续写、改写、仿写');
      expect(proxy.calls[0]?.[1]?.content).toContain('林远走进废弃车站');
      expect(
        proxy.calls.some((call) => call[0]?.content.includes('小说服装连续性分析师')),
      ).toBe(true);
      expect(analyzed.profile.transferableMethods.length).toBeGreaterThan(0);
      expect(analyzed.profile.markdownReport).not.toContain('求收藏');
      expect(analyzed.analysisProjectName).toBe('小说拆解 · 样例参考');
      expect(analyzed.message).toContain('按原顺序写入');

      const analysisProject = await store.getProject(analyzed.analysisProjectId);
      expect(analysisProject?.name).toBe('小说拆解 · 样例参考');
      const analysisChapters = await store.listChapters(analyzed.analysisProjectId);
      const analysisCharacters = await store.listCharacters(analyzed.analysisProjectId);
      const analysisWorlds = await store.listWorldSettings(analyzed.analysisProjectId);
      const analysisOutlines = await store.listOutlines(analyzed.analysisProjectId);
      expect(analysisCharacters.find((item) => item.name === '林远')?.description).toContain(
        '## 人物弧光',
      );
      expect(analysisCharacters.find((item) => item.name === '林远')?.description).toContain(
        '## 分章服装',
      );
      expect(analysisChapters).toHaveLength(imported.chaptersDetected);
      expect(analysisChapters.map((chapter) => chapter.title)).toEqual(
        imported.chapters.map((chapter) => chapter.title),
      );
      expect(analysisChapters[0]?.content).toContain('林远走进废弃车站');
      expect(
        analyzed.artifacts.filter((artifact) => artifact.kind === 'chapter'),
      ).toHaveLength(imported.chaptersDetected);
      expect(analysisWorlds.find((item) => item.title === '世界观拆解')?.content).toContain(
        '废弃车站',
      );
      expect(analysisOutlines.map((item) => item.title)).toEqual(
        expect.arrayContaining([
          '01 · 故事总览与剧情大纲',
          '02 · 冲突与爽点',
          '03 · 伏笔、反转与主题',
          '04 · 完整拆解报告',
          '05 · 分章人物服装',
        ]),
      );
      expect(
        analysisOutlines.find((item) => item.title === '05 · 分章人物服装')?.content,
      ).toContain('正文未描写');
      await store.createCharacter(
        analyzed.analysisProjectId,
        '旧自动候选',
        '# 旧自动候选\n\n## 人物弧光\n待确认\n\n## 关键行动\n- 待确认',
      );
      await store.createCharacter(analyzed.analysisProjectId, '用户笔记', '这是用户手工添加的资料');

      const analyzedAgain = await service.analyze(
        imported.reference.id,
        new AbortController().signal,
        {
          chapterIds: halfIds,
          depth: 'quick',
        },
      );
      expect(analyzedAgain.analysisProjectId).toBe(analyzed.analysisProjectId);
      expect((await store.listProjects()).filter((item) => item.name === analyzed.analysisProjectName))
        .toHaveLength(1);
      const refreshedCharacters = await store.listCharacters(analyzed.analysisProjectId);
      const refreshedChapters = await store.listChapters(analyzed.analysisProjectId);
      expect(refreshedChapters.map((chapter) => chapter.id)).toEqual(
        analysisChapters.map((chapter) => chapter.id),
      );
      expect(refreshedCharacters.some((item) => item.name === '旧自动候选')).toBe(false);
      expect(refreshedCharacters.some((item) => item.name === '用户笔记')).toBe(true);

      const duplicateImport = await service.importText({
        title: '样例参考',
        text: SAMPLE_NOVEL,
        depth: 'quick',
      });
      const duplicateAnalysis = await service.analyze(
        duplicateImport.reference.id,
        new AbortController().signal,
        {
          chapterIds: duplicateImport.chapters.slice(0, 2).map((chapter) => chapter.id),
          depth: 'quick',
        },
      );
      expect(duplicateAnalysis.analysisProjectId).toBe(analyzed.analysisProjectId);
      expect(await store.listChapters(analyzed.analysisProjectId)).toHaveLength(
        imported.chaptersDetected,
      );

      const project = await store.createProject('原创项目');
      const transfer = await service.transferToProject(
        project.id,
        {
          referenceId: imported.reference.id,
          dimensions: ['pacing', 'style'],
          originalBrief: '废土科幻原创',
        },
        new AbortController().signal,
      );
      expect(transfer.artifacts.some((a) => a.kind === 'outline')).toBe(true);

      const prompt = service.buildActiveTransferPrompt(project.id);
      expect(prompt).toContain('参考写作方法');
      expect(prompt).not.toContain(SAMPLE_NOVEL.slice(0, 40));

      const sim = await service.checkSimilarity(project.id, {
        referenceId: imported.reference.id,
        text: '这是一段完全原创的废土科幻描写，主角在锈蚀管道中寻找水源与同盟。'.repeat(3),
      });
      expect(sim.riskLevel).toBe('ok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
