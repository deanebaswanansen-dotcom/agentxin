import { describe, expect, it, vi } from 'vitest';

import {
  decodeScriptCharacterInputs,
  decodeScriptEpisodeInput,
  decodeScriptEpisodeOutlineInput,
  decodeScriptPlanInput,
  decodeScriptSeriesOutlineInput,
  decodeScriptWorldBibleInput,
} from '../ScriptCanonicalInput.js';
import type {
  ScriptEpisodeCard,
  ScriptEpisodeOutline,
  ScriptPlan,
} from '../domain.js';
import {
  coerceEpisodeDraftCandidate,
  coerceEpisodeOutlineCandidate,
  coercePlannedScenes,
} from './EpisodeArtifactCoercion.js';
import {
  coerceCharacterBibleCandidate,
  coerceScriptPlanCandidate,
  coerceSeriesOutlineChunk,
  coerceWorldBibleCandidate,
} from './FoundationArtifactCoercion.js';
import { generateStructured } from './generateStructured.js';
import { ScriptConceptService } from './ScriptConceptService.js';
import { ScriptDirector } from './ScriptDirector.js';
import { defineStructuredContract } from './StructuredContract.js';

const NOW = '2026-08-26T00:00:00.000Z';

function plan(overrides: Partial<ScriptPlan> = {}): ScriptPlan {
  return {
    id: 'plan-1',
    projectId: 'project-1',
    status: 'approved',
    revision: 1,
    title: '冰库求生',
    theme: '普通人在危机中互助',
    market: 'domestic',
    channel: 'general',
    genres: ['灾难', '剧情'],
    audience: '大众短剧观众',
    coreConflict: '暴雪封路，备用电源即将耗尽',
    logline: '众人必须在备用电源耗尽前修好发电机。',
    highlights: ['限时危机', '身份反转'],
    totalEpisodes: 20,
    episodeDurationSeconds: { min: 60, max: 90 },
    targetCharsPerEpisode: 1_000,
    maxPrimaryCharacters: 4,
    maxScenesPerEpisode: 3,
    dialogueDensityPercent: 60,
    language: 'zh-CN',
    format: 'cn_short_drama',
    coreRequirements: '危机推进清楚',
    forbiddenElements: [],
    endingDirection: '众人获救，幕后破坏者被揭穿',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const episodeCard: ScriptEpisodeCard = {
  episodeNumber: 2,
  title: '冰库告急',
  logline: '主角发现备用电源即将耗尽。',
  mainEvent: '主角组织众人抢修发电机。',
  endingHook: '电机启动时，外面传来敲门声。',
};

function ids(): () => string {
  let sequence = 0;
  return () => `local-${++sequence}`;
}

async function completeFromOneImperfectResponse<T>(
  name: string,
  imperfect: unknown,
  normalize: (value: Record<string, unknown>) => T,
): Promise<T> {
  const complete = vi.fn().mockResolvedValue(JSON.stringify(imperfect));
  const contract = defineStructuredContract<T>({
    name,
    version: 1,
    instructions: '允许机器可修复的缺项，由本地转换器补齐。',
    decode(value) {
      try {
        return {
          success: true,
          value: normalize(value as Record<string, unknown>),
        };
      } catch (error) {
        return {
          success: false,
          issues: [{
            path: [],
            code: 'leniency.normalize_failed',
            message: error instanceof Error ? error.message : String(error),
          }],
        };
      }
    },
  });

  const result = await generateStructured({
    contract,
    prompt: `生成 ${name}`,
    primary: { complete },
  });

  expect(result.status).toBe('completed');
  if (result.status !== 'completed') throw result.error;
  expect(result.completedBy).toBe('primary');
  expect(result.callsUsed).toBe(1);
  expect(result.attempts).toEqual([
    expect.objectContaining({ stage: 'primary', outcome: 'completed' }),
  ]);
  expect(complete).toHaveBeenCalledTimes(1);
  return result.value;
}

describe('screenplay leniency matrix: machine-fixable output never pauses the workflow', () => {
  it('case 1 — concept: keeps one sparse proposal and fills every editable field locally', async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      proposals: [{ title: '暴雪封门', genres: '灾难、悬疑', totalEpisodes: '60集' }],
    }));
    const service = new ScriptConceptService({ complete }, async () => ({
      id: 'project-1',
      name: '冰库项目',
      kind: 'short_drama' as const,
      createdAt: NOW,
      updatedAt: NOW,
    }));

    const result = await service.generate('project-1', '暴雪中的密闭冰库');

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      title: '暴雪封门',
      genres: ['灾难', '悬疑'],
      totalEpisodes: 60,
    });
    expect(result.proposals[0]?.logline).toBeTruthy();
    expect(result.proposals[0]?.mainArc).toBeTruthy();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('case 2 — concept: turns unusable prose into three local choices after one failed response', async () => {
    const complete = vi.fn().mockResolvedValue('我暂时只能给出一些想法，稍后再整理 JSON。');
    const service = new ScriptConceptService({ complete }, async () => ({
      id: 'project-1',
      name: '冰库项目',
      kind: 'short_drama' as const,
      createdAt: NOW,
      updatedAt: NOW,
    }));

    const result = await service.generate('project-1', '暴雪中的密闭冰库');

    expect(result.proposals).toHaveLength(3);
    expect(new Set(result.proposals.map((item) => item.title)).size).toBe(3);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('case 3 — plan: accepts aliases, scalar lists and numeric text without a fixup call', async () => {
    const completed = await completeFromOneImperfectResponse(
      'script_plan_lenient',
      {
        title: '  冰库求生  ',
        market: '国内',
        channel: '大众',
        genres: '灾难、悬疑',
        totalEpisodes: '60集',
        episodeDurationSeconds: { min: '90秒', max: '60秒' },
      },
      (value) => coerceScriptPlanCandidate(value, {
        projectId: 'project-1',
        now: NOW,
        id: 'plan-new',
        explicit: {},
        seedPrompt: '暴雪中的密闭冰库',
      }),
    );

    expect(completed).toMatchObject({
      title: '冰库求生',
      market: 'domestic',
      channel: 'general',
      genres: ['灾难', '悬疑'],
      totalEpisodes: 60,
      episodeDurationSeconds: { min: 60, max: 90 },
    });
    expect(() => decodeScriptPlanInput(completed)).not.toThrow();
  });

  it('case 4 — plan: fills a nearly empty object from confirmed values and safe defaults', async () => {
    const completed = await completeFromOneImperfectResponse(
      'script_plan_sparse',
      {},
      (value) => coerceScriptPlanCandidate(value, {
        projectId: 'project-1',
        now: NOW,
        id: 'plan-new',
        explicit: {
          genres: ['灾难'],
          coreConflict: '备用电源即将耗尽',
          totalEpisodes: 40,
          maxScenesPerEpisode: 4,
          endingDirection: '众人获救',
        },
      }),
    );

    expect(completed).toMatchObject({
      genres: ['灾难'],
      coreConflict: '备用电源即将耗尽',
      totalEpisodes: 40,
      maxScenesPerEpisode: 4,
      endingDirection: '众人获救',
    });
    expect(() => decodeScriptPlanInput(completed)).not.toThrow();
  });

  it('case 5 — series outline: repairs missing, duplicated and out-of-order episode cards locally', async () => {
    const completed = await completeFromOneImperfectResponse(
      'series_outline_chunk_lenient',
      {
        summary: '众人在冰库中寻找出路。',
        episodes: [
          { episodeNumber: 4, title: '第四集', mainEvent: '发现破坏痕迹' },
          { episodeNumber: 2, title: '第二集', endingHook: '门外有人' },
          { episodeNumber: 2, title: '重复第二集' },
        ],
      },
      (value) => coerceSeriesOutlineChunk(value, {
        plan: plan({ totalEpisodes: 5 }),
        start: 1,
        end: 5,
      }),
    );
    const cards = completed.episodeCards as Array<Record<string, unknown>>;

    expect(cards.map((card) => card.episodeNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(cards[1]).toMatchObject({ title: '第二集', endingHook: '门外有人' });
    expect(cards[3]).toMatchObject({ title: '第四集', mainEvent: '发现破坏痕迹' });
    expect(() => decodeScriptSeriesOutlineInput(completed)).not.toThrow();
  });

  it('case 6 — character bible: completes sparse cards and repairs duplicate IDs and names locally', async () => {
    const completed = await completeFromOneImperfectResponse(
      'character_bible_lenient',
      {
        characters: [
          { id: 'same', name: '林舟', role: '主角', personality: '冷静、固执' },
          { id: 'same', name: '林舟', role: '反派', relationships: [{ characterId: 'missing' }] },
        ],
      },
      (value) => coerceCharacterBibleCandidate(value, {
        projectId: 'project-1',
        now: NOW,
        plan: plan(),
      }),
    );

    expect(completed.map((item) => item.id)).toEqual(['same', 'same-2']);
    expect(completed.map((item) => item.name)).toEqual(['林舟', '林舟2']);
    expect(completed[0]).toMatchObject({ role: 'lead', personality: ['冷静', '固执'] });
    expect(completed[1]?.relationships).toEqual([]);
    expect(() => decodeScriptCharacterInputs(completed)).not.toThrow();
  });

  it('case 7 — character bible: creates a minimal editable cast from an empty object', async () => {
    const completed = await completeFromOneImperfectResponse(
      'character_bible_empty',
      {},
      (value) => coerceCharacterBibleCandidate(value, {
        projectId: 'project-1',
        now: NOW,
        plan: plan(),
      }),
    );

    expect(completed.map((item) => item.role)).toEqual(['lead', 'antagonist', 'supporting']);
    expect(completed.every((item) => item.identity && item.defaultOutfit && item.speechStyle)).toBe(true);
    expect(() => decodeScriptCharacterInputs(completed)).not.toThrow();
  });

  it('case 8 — world bible: turns one useful field into a complete editable world record', async () => {
    const completed = await completeFromOneImperfectResponse(
      'world_bible_lenient',
      { era: '近未来', locations: '冰库、维修间', organizations: '救援队' },
      (value) => coerceWorldBibleCandidate(value, {
        projectId: 'project-1',
        now: NOW,
        plan: plan(),
      }),
    );

    expect(completed).toMatchObject({
      era: '近未来',
      primaryLocations: ['冰库', '维修间'],
      organizations: ['救援队'],
      rules: [],
      recurringProps: [],
    });
    expect(completed.worldState).toBeTruthy();
    expect(() => decodeScriptWorldBibleInput(completed)).not.toThrow();
  });

  it('case 9 — episode outline: ignores a wrong episode number and unknown character references', async () => {
    const completed = await completeFromOneImperfectResponse(
      'episode_outline_lenient',
      {
        episodeNumber: 99,
        name: '错误集号也不阻塞',
        characters: ['lead', '路人甲', 'lead'],
        beat: '发现断线、抢修电机',
        hook: '门外传来敲击声',
      },
      (value) => coerceEpisodeOutlineCandidate(value, {
        projectId: 'project-1',
        episodeNumber: 2,
        card: episodeCard,
        registeredCharacterIds: new Set(['lead']),
        createId: ids(),
      }),
    );

    expect(completed).toMatchObject({
      episodeNumber: 2,
      title: '错误集号也不阻塞',
      characterIds: ['lead'],
      endingHook: '门外传来敲击声',
    });
    expect(completed.beats).toEqual(['发现断线、抢修电机']);
    expect(() => decodeScriptEpisodeOutlineInput(completed)).not.toThrow();
  });

  it('case 10 — scene plan: reindexes duplicate ordinals and converts Chinese time and space labels', async () => {
    const completed = await completeFromOneImperfectResponse(
      'scene_plan_lenient',
      {
        scenes: [
          { ordinal: 9, location: '', timeOfDay: '夜', interiorExterior: '外景', purpose: '寻找电源' },
          { ordinal: 9, place: '维修间', time: '错误值', content: '' },
        ],
      },
      (value) => coercePlannedScenes(value.scenes, { max: 3 }),
    );

    expect(completed).toEqual([
      expect.objectContaining({
        ordinal: 1,
        location: '未指定地点',
        timeOfDay: 'night',
        interiorExterior: 'exterior',
      }),
      expect.objectContaining({
        ordinal: 2,
        location: '维修间',
        timeOfDay: 'day',
        purpose: '推进第 2 场事件',
      }),
    ]);
  });

  it('case 11 — draft: accepts plain body text and supplies scene and episode metadata locally', async () => {
    const outline = coerceEpisodeOutlineCandidate({}, {
      projectId: 'project-1',
      episodeNumber: 2,
      card: episodeCard,
      registeredCharacterIds: new Set(['lead']),
      createId: ids(),
    });
    const completed = await completeFromOneImperfectResponse(
      'episode_draft_plain_text',
      { episodeNumber: 3, body: '林舟拆开电机外壳，发现主线被人剪断。' },
      (value) => coerceEpisodeDraftCandidate(value, {
        projectId: 'project-1',
        outline,
        plan: plan(),
        createId: ids(),
        now: NOW,
      }),
    );

    expect(completed).toMatchObject({
      episodeNumber: 2,
      title: episodeCard.title,
      summary: episodeCard.logline,
    });
    expect(completed.scenes[0]?.blocks[0]).toMatchObject({
      type: 'action',
      text: '林舟拆开电机外壳，发现主线被人剪断。',
    });
    expect(() => decodeScriptEpisodeInput(completed)).not.toThrow();
  });

  it('case 12 — draft: removes blank blocks, infers dialogue and reuses planned scene metadata', async () => {
    const outline = {
      ...coerceEpisodeOutlineCandidate({}, {
        projectId: 'project-1',
        episodeNumber: 2,
        card: episodeCard,
        registeredCharacterIds: new Set(['lead']),
        createId: ids(),
      }),
      plannedScenes: coercePlannedScenes([{
        location: '维修间',
        timeOfDay: '夜',
        interiorExterior: '内景',
        purpose: '抢修电机',
      }]),
    } as ScriptEpisodeOutline;
    const completed = await completeFromOneImperfectResponse(
      'episode_draft_polluted',
      {
        scenes: [{
          ordinal: 7,
          blocks: [
            { type: 'action', text: '△林舟拆开电机外壳。' },
            { type: 'unknown', text: '林舟：把扳手给我！' },
            { type: 'dialogue', text: '' },
          ],
        }],
      },
      (value) => coerceEpisodeDraftCandidate(value, {
        projectId: 'project-1',
        outline,
        plan: plan(),
        createId: ids(),
        now: NOW,
      }),
    );

    expect(completed.scenes).toHaveLength(1);
    expect(completed.scenes[0]).toMatchObject({
      ordinal: 1,
      location: '维修间',
      timeOfDay: 'night',
      interiorExterior: 'interior',
    });
    expect(completed.scenes[0]?.blocks).toEqual([
      expect.objectContaining({ type: 'action', text: '林舟拆开电机外壳。' }),
      expect.objectContaining({ type: 'dialogue', speaker: '林舟', text: '把扳手给我！' }),
    ]);
    expect(() => decodeScriptEpisodeInput(completed)).not.toThrow();
  });

  it('case 13 — review: drops malformed and unknown issues and defaults every optional ledger', async () => {
    type ReviewValue = {
      issues: Array<{ code: string; severity: 'hard' | 'soft'; message: string }>;
      qualityNotes: string[];
      summary: string;
      newFacts: string[];
      openedThreads: string[];
      closedThreads: string[];
      wardrobe: Array<{ characterId: string; outfit: string }>;
    };
    const director = new ScriptDirector({
      model: { complete: vi.fn() },
      store: {} as never,
      checkpoints: {} as never,
    });
    const parseReview = (director as unknown as {
      parseReview(value: Record<string, unknown>): ReviewValue;
    }).parseReview.bind(director);
    const completed = await completeFromOneImperfectResponse(
      'review_lenient',
      {
        issues: [
          { code: 'UNKNOWN_CODE', severity: 'hard', message: '未知代码不应卡住' },
          { code: 'FORMAT', severity: 'soft' },
          null,
        ],
        newFacts: '本应是数组但模型给了字符串',
        wardrobe: [{ characterId: 'lead' }, { outfit: '棉衣' }],
      },
      parseReview,
    );

    expect(completed).toEqual({
      issues: [],
      qualityNotes: [],
      summary: '',
      newFacts: [],
      openedThreads: [],
      closedThreads: [],
      wardrobe: [],
    });
  });
});
