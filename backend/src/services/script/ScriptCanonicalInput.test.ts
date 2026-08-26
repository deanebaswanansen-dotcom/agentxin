import { describe, expect, it } from 'vitest';

import type { ScriptCharacterInput, ScriptPlanInput } from './domain.js';
import {
  decodeScriptCharacterInputs,
  decodeScriptEpisodeInput,
  decodeScriptEpisodeOutlineInput,
  decodeScriptPlanInput,
  decodeScriptSeriesOutlineInput,
  decodeScriptWorldBibleInput,
  validateScriptCharacterSet,
  validateScriptEpisodeInput,
  validateScriptEpisodeOutlineInput,
  validateScriptSeriesOutlineInput,
} from './ScriptCanonicalInput.js';
import { ScriptServiceError } from './ScriptServiceError.js';

function planInput(): ScriptPlanInput {
  return {
    status: 'draft',
    title: '绝食逼我道歉？',
    theme: '平等和尊重',
    market: 'domestic',
    channel: 'female',
    genres: [' 都市 ', '家庭', '都市'],
    audience: '女性观众',
    coreConflict: '新媳妇对抗家族权威',
    logline: '新媳妇用美食打破家族绝食绑架。',
    highlights: ['反向打脸'],
    totalEpisodes: 10,
    episodeDurationSeconds: { min: 60, max: 90 },
    targetCharsPerEpisode: 1_200,
    maxPrimaryCharacters: 2,
    maxScenesPerEpisode: 3,
    dialogueDensityPercent: 65,
    language: 'zh-CN',
    format: 'cn_short_drama',
    coreRequirements: '',
    forbiddenElements: [],
    endingDirection: '重建家庭秩序',
  };
}

function character(
  id: string,
  name: string,
  role: ScriptCharacterInput['role'] = 'lead',
): ScriptCharacterInput & { id: string } {
  return {
    id,
    name,
    aliases: [],
    role,
    identity: `${name}的身份`,
    biography: `${name}的人物小传`,
    motivation: '守护家人',
    goal: '改变旧规',
    weakness: '过度心软',
    arc: '学会建立边界',
    appearance: '神情坚定',
    hairstyle: '黑色长发',
    physique: '身形挺拔',
    defaultOutfit: '白衬衫',
    personality: ['冷静'],
    skills: ['烹饪'],
    speechStyle: '简洁有力',
    catchphrases: [],
    relationships: [],
  };
}

function outlineInput(episodeNumber = 1) {
  return {
    episodeNumber,
    title: '初入老宅',
    goal: '建立冲突',
    conflict: '跪请与拒绝',
    beats: ['进门'],
    characterIds: ['character-1'],
    plannedScenes: [{
      ordinal: 1,
      location: '沈家老宅',
      timeOfDay: 'day',
      interiorExterior: 'interior',
      purpose: '建立冲突',
    }],
    endingHook: '沈清决定改规矩',
    requiredFacts: [],
    forbiddenFacts: [],
    status: 'expanded',
  };
}

function episodeInput(episodeNumber = 1) {
  return {
    episodeNumber,
    title: '初入老宅',
    outlineId: 'outline-1',
    status: 'reviewing',
    targetChars: 1_200,
    scenes: [{
      ordinal: 1,
      location: '沈家老宅',
      timeOfDay: 'day',
      interiorExterior: 'interior',
      characterIds: ['character-1'],
      blocks: [{ type: 'action', text: '沈清跨过门槛。' }],
    }],
    summary: '',
    newFacts: [],
    openedThreads: [],
    closedThreads: [],
  };
}

function expectValidation(run: () => unknown, message: string): void {
  try {
    run();
    throw new Error('预期校验失败');
  } catch (error) {
    expect(error).toBeInstanceOf(ScriptServiceError);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message });
  }
}

describe('ScriptCanonicalInput', () => {
  it('decodes and canonicalizes a complete plan with the service limits', () => {
    const decoded = decodeScriptPlanInput(planInput());

    expect(decoded.genres).toEqual(['都市', '家庭']);
    expect(decoded.episodeDurationSeconds).toEqual({ min: 60, max: 90 });
    expectValidation(
      () => decodeScriptPlanInput({
        ...planInput(),
        episodeDurationSeconds: { min: 120, max: 60 },
      }),
      '最短时长不能大于最长时长',
    );
  });

  it('accepts bounded optional creative rules while keeping old plans compatible', () => {
    expect(decodeScriptPlanInput(planInput()).creativeRules).toBeUndefined();
    const decoded = decodeScriptPlanInput({
      ...planInput(),
      creativeRules: {
        preset: 'custom',
        fiveEpisodeArc: true,
        openingHook: true,
        endingHook: true,
        goldenLine: false,
        firstAppearanceDetails: true,
        productionLabels: false,
        writingInstructions: '优先保持人物动机清楚',
        formatInstructions: '',
        qualityMode: 'custom',
        qualityInstructions: '只提示明显的情绪断层',
      },
    });
    expect(decoded.creativeRules).toMatchObject({
      preset: 'custom',
      qualityMode: 'custom',
      qualityInstructions: '只提示明显的情绪断层',
    });
  });

  it('decodes every required character field and rejects duplicate supplied identity', () => {
    expect(decodeScriptCharacterInputs([character('character-1', '沈清')]))
      .toMatchObject([{ id: 'character-1', name: '沈清', hairstyle: '黑色长发' }]);

    expectValidation(
      () => decodeScriptCharacterInputs([
        character('character-1', '沈清'),
        character('character-2', '沈清'),
      ]),
      '人物姓名重复: 沈清',
    );
    expectValidation(
      () => decodeScriptCharacterInputs([
        character('character-1', '沈清'),
        character('character-1', '沈亦舟'),
      ]),
      '人物 id 重复: character-1',
    );
  });

  it('validates the complete materialized cast and all relationship references', () => {
    const lead = character('character-1', '沈清');
    const partner = character('character-2', '沈亦舟', 'supporting');
    lead.relationships = [{ characterId: partner.id, label: '伴侣' }];
    expect(() => validateScriptCharacterSet([lead, partner], { maxPrimaryCharacters: 2 }))
      .not.toThrow();

    expectValidation(
      () => validateScriptCharacterSet([lead, partner], { maxPrimaryCharacters: 1 }),
      '主要人物数超过策划上限1',
    );
    expectValidation(
      () => validateScriptCharacterSet([
        { ...lead, relationships: [{ characterId: lead.id, label: '自己' }] },
        partner,
      ]),
      '人物「沈清」不能与自己建立关系',
    );
    expectValidation(
      () => validateScriptCharacterSet([
        { ...lead, relationships: [{ characterId: 'missing', label: '对手' }] },
        partner,
      ]),
      '人物「沈清」的关系目标不存在: missing',
    );
    expectValidation(
      () => validateScriptCharacterSet([lead, { ...partner, id: lead.id }]),
      '人物 id 重复: character-1',
    );
    expectValidation(
      () => validateScriptCharacterSet([lead, { ...partner, name: ' 沈清 ' }]),
      '人物姓名重复: 沈清',
    );
  });

  it('enforces the canonical world-bible array ranges', () => {
    const world = decodeScriptWorldBibleInput({
      era: '2026年',
      primaryLocations: ['沈家老宅'],
      worldState: '现代都市',
      rules: [],
      transport: [],
      communication: [],
      organizations: [],
      recurringProps: [],
      forbiddenAnachronisms: [],
    });
    expect(world.primaryLocations).toEqual(['沈家老宅']);
    expectValidation(
      () => decodeScriptWorldBibleInput({ ...world, primaryLocations: [] }),
      '主要地点数量必须为1到50',
    );
  });

  it('requires a continuous full-series card sequence and planned total', () => {
    const outline = decodeScriptSeriesOutlineInput({
      synopsis: '全剧概要',
      openingState: '开场',
      midpointTurn: '中点',
      climax: '高潮',
      endingState: '结局',
      mainArc: ['第一阶段'],
      subplotArcs: [],
      episodeCards: [1, 2].map((episodeNumber) => ({
        episodeNumber,
        title: `第${episodeNumber}集`,
        logline: '概要',
        mainEvent: '事件',
        endingHook: '卡点',
      })),
    });
    expect(() => validateScriptSeriesOutlineInput(outline, { totalEpisodes: 2 })).not.toThrow();
    expectValidation(
      () => validateScriptSeriesOutlineInput(outline, { totalEpisodes: 3 }),
      '分集卡必须完整覆盖1到3集',
    );
    expectValidation(
      () => decodeScriptSeriesOutlineInput({
        ...outline,
        episodeCards: [outline.episodeCards[0], { ...outline.episodeCards[1], episodeNumber: 3 }],
      }),
      '分集卡集号必须从1开始连续且唯一',
    );
  });

  it('separates episode-outline decoding from contextual path and scene limits', () => {
    const outline = decodeScriptEpisodeOutlineInput(outlineInput());
    expect(() => validateScriptEpisodeOutlineInput(outline, {
      expectedEpisodeNumber: 1,
      totalEpisodes: 10,
      maxScenesPerEpisode: 3,
    })).not.toThrow();
    expectValidation(
      () => validateScriptEpisodeOutlineInput(outline, { expectedEpisodeNumber: 2 }),
      '请求路径与正文中的集号不一致',
    );
    expectValidation(
      () => validateScriptEpisodeOutlineInput({ ...outline, plannedScenes: [] }),
      '计划场景至少需要1场',
    );
  });

  it('decodes episode blocks with an injectable id source and applies context limits', () => {
    let nextId = 0;
    const episode = decodeScriptEpisodeInput(episodeInput(), {
      createId: () => `generated-${++nextId}`,
    });
    expect(episode.scenes[0]?.id).toBe('generated-1');
    expect(episode.scenes[0]?.blocks[0]?.id).toBe('generated-2');
    expect(() => validateScriptEpisodeInput(episode, {
      expectedEpisodeNumber: 1,
      totalEpisodes: 10,
      maxScenesPerEpisode: 3,
    })).not.toThrow();
    expectValidation(
      () => validateScriptEpisodeInput({ ...episode, scenes: [] }),
      '剧本正文至少需要1场',
    );
    expectValidation(
      () => decodeScriptEpisodeInput({
        ...episodeInput(),
        scenes: [{ ...episodeInput().scenes[0], blocks: [] }],
      }),
      '剧本场景必须包含正文块',
    );
  });
});
