import { describe, expect, it } from 'vitest';

import type { ScriptEpisode, ScriptEpisodeOutline, ScriptPlan } from '../domain.js';
import {
  collectTemporaryDialogueSpeakers,
  createScriptReviewIssues,
  isTemporaryDialogueSpeaker,
  validateScriptEpisode,
} from './ScriptQualityGates.js';

const plan = {
  targetCharsPerEpisode: 100,
  maxScenesPerEpisode: 3,
  dialogueDensityPercent: 60,
  forbiddenElements: [],
} as unknown as ScriptPlan;

function episode(overrides: Partial<ScriptEpisode> = {}): ScriptEpisode {
  return {
    id: 'episode-1',
    projectId: 'project-1',
    episodeNumber: 1,
    title: '第一次冲突',
    outlineId: 'outline-1',
    status: 'reviewing',
    targetChars: 100,
    scenes: [],
    summary: '',
    newFacts: [],
    openedThreads: [],
    closedThreads: [],
    revision: 1,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

function validScene(ordinal = 1) {
  return {
    id: `scene-${ordinal}`,
    ordinal,
    location: '沈家老宅',
    timeOfDay: 'day' as const,
    interiorExterior: 'interior' as const,
    characterIds: [],
    blocks: [{ id: `action-${ordinal}`, type: 'action' as const, text: '剧情'.repeat(45) }],
  };
}

describe('validateScriptEpisode', () => {
  it('allows disposable role speakers but never treats a real name as temporary', () => {
    const speakers = [
      '路人甲', '路人乙', '保安A', '护士二', '主厨', '陌生人',
      '黑夹克男甲', '周技师', '老周', '金丝眼镜', '刺客甲',
    ];
    const candidate = episode({
      scenes: [{
        ...validScene(),
        blocks: [
          { id: 'action', type: 'action', text: '剧情'.repeat(45) },
          ...speakers.map((speaker, index) => ({
            id: `temporary-${index}`,
            type: 'dialogue' as const,
            speaker,
            text: `临时对白${index}`,
          })),
          { id: 'named', type: 'dialogue', speaker: '赵铁柱', text: '我会继续出现。' },
        ],
      }],
    });
    const registeredNames = new Set<string>();
    const temporarySpeakers = collectTemporaryDialogueSpeakers(candidate, plan, registeredNames);
    const report = validateScriptEpisode(candidate, plan, {
      registeredCharacterIds: new Set(),
      registeredCharacterNames: registeredNames,
      temporarySpeakers,
    });

    expect([...temporarySpeakers]).toEqual(speakers);
    expect(speakers.every((speaker) => isTemporaryDialogueSpeaker(speaker))).toBe(true);
    expect(isTemporaryDialogueSpeaker('赵铁柱')).toBe(false);
    expect(report.issues.filter((issue) => issue.code === 'UNKNOWN_SPEAKER')).toEqual([
      expect.objectContaining({ message: '说话人「赵铁柱」未登记。' }),
    ]);
  });

  it('respects an explicit requirement that every dialogue speaker be registered', () => {
    const strictPlan = {
      ...plan,
      coreRequirements: '未登记路人人物不得说话。',
    } as ScriptPlan;
    const candidate = episode({
      scenes: [{
        ...validScene(),
        blocks: [
          { id: 'action', type: 'action', text: '剧情'.repeat(45) },
          { id: 'temporary', type: 'dialogue', speaker: '路人甲', text: '看那边。' },
        ],
      }],
    });
    const temporarySpeakers = collectTemporaryDialogueSpeakers(
      candidate,
      strictPlan,
      new Set(),
    );
    const report = validateScriptEpisode(candidate, strictPlan, {
      registeredCharacterNames: new Set(),
      temporarySpeakers,
    });

    expect(temporarySpeakers.size).toBe(0);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'UNKNOWN_SPEAKER',
        severity: 'soft',
        message: '说话人「路人甲」未登记。',
      }),
    ]));
    expect(report.hardFailed).toBe(false);
  });

  it('hard-fails an empty episode instead of allowing it to complete', () => {
    const report = validateScriptEpisode(episode(), plan, { expectedEpisodeNumber: 1 });

    expect(report.hardFailed).toBe(true);
    expect(report.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'NO_SCENES', severity: 'hard' })]),
    );
  });

  it('allows a structurally valid episode within the configured length window', () => {
    const report = validateScriptEpisode(episode({ scenes: [validScene()] }), plan, {
      expectedEpisodeNumber: 1,
    });

    expect(report.hardFailed).toBe(false);
    expect(report.visibleChars).toBe(90);
  });

  it('keeps large length deviations advisory instead of blocking a usable episode', () => {
    const shortReport = validateScriptEpisode(episode({
      scenes: [{
        ...validScene(),
        blocks: [{ id: 'short', type: 'action', text: '短'.repeat(40) }],
      }],
    }), plan, { expectedEpisodeNumber: 1 });
    const longReport = validateScriptEpisode(episode({
      scenes: [{
        ...validScene(),
        blocks: [{ id: 'long', type: 'action', text: '长'.repeat(130) }],
      }],
    }), plan, { expectedEpisodeNumber: 1 });

    expect(shortReport.hardFailed).toBe(false);
    expect(longReport.hardFailed).toBe(false);
    expect(shortReport.advisoryIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TOO_SHORT', severity: 'soft' }),
    ]));
    expect(longReport.advisoryIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TOO_LONG', severity: 'soft' }),
    ]));
  });

  it('blocks only bottom-line failures and keeps fixable findings advisory', () => {
    const invalidScene = {
      ...validScene(1),
      location: '',
      characterIds: ['ghost'],
      blocks: [
        { id: 'artifact', type: 'action' as const, text: '```json <think>提示词</think> 校园剧' },
        { id: 'speaker', type: 'dialogue' as const, speaker: '', text: '台词' },
      ],
    };
    const invalidPlan = {
      ...plan,
      maxScenesPerEpisode: 1,
      forbiddenElements: ['校园剧'],
    };
    const outline = {
      conflict: '',
      endingHook: '',
    } as unknown as ScriptEpisodeOutline;
    const report = validateScriptEpisode(
      episode({ episodeNumber: 2, scenes: [invalidScene, validScene(1)] }),
      invalidPlan,
      {
        expectedEpisodeNumber: 1,
        existingEpisodeNumbers: [2],
        registeredCharacterIds: new Set(),
        registeredCharacterNames: new Set(),
        outline,
      },
    );

    expect(report.hardFailed).toBe(true);
    expect(report.issues.filter((issue) => issue.severity === 'hard').map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
          'EPISODE_NUMBER_MISMATCH',
          'DUPLICATE_EPISODE_NUMBER',
          'MODEL_ARTIFACT',
          'FORBIDDEN_ELEMENT',
        ]),
    );
    expect(report.advisoryIssues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'TOO_MANY_SCENES',
      'DUPLICATE_SCENE_ORDINAL',
      'MISSING_LOCATION',
      'MISSING_SPEAKER',
      'UNKNOWN_CHARACTER_REFERENCE',
      'MISSING_KEY_EVENT',
      'MISSING_ENDING_HOOK',
    ]));
  });

  it('keeps localized continuity, duplicate-dialogue, and density findings as soft issues', () => {
    const softPlan = {
      ...plan,
      targetCharsPerEpisode: 20,
      dialogueDensityPercent: 30,
    };
    const scene = {
      ...validScene(),
      blocks: [
        { id: 'a', type: 'action' as const, text: '他们沉默了片刻。' },
        { id: 'd1', type: 'dialogue' as const, speaker: '沈清', text: '完全相同台词' },
        { id: 'd2', type: 'dialogue' as const, speaker: '沈清', text: '完全相同台词' },
      ],
    };
    const report = validateScriptEpisode(episode({ targetChars: 20, scenes: [scene] }), softPlan, {
      reviewIssues: [
        {
          code: 'WARDROBE_JUMP',
          severity: 'soft',
          message: '沈清服装与上集不连续。',
          sceneId: scene.id,
        },
      ],
    });

    expect(report.hardFailed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['DUPLICATE_DIALOGUE', 'DIALOGUE_DENSITY', 'WARDROBE_JUMP']),
    );
  });

  it('localizes scene, block and speaker format failures for proofreading', () => {
    const scene = {
      ...validScene(2),
      characterIds: [],
      blocks: [
        {
          id: 'duplicate-block',
          type: 'dialogue' as const,
          characterId: 'character-1',
          speaker: '错误名字',
          text: '剧情'.repeat(45),
        },
        { id: 'duplicate-block', type: 'action' as const, text: '补充动作' },
      ],
    };
    const outline = {
      id: 'outline-1',
      conflict: '正面冲突',
      endingHook: '新证人出现',
      requiredFacts: ['必须出现的证据'],
      forbiddenFacts: ['补充动作'],
    } as unknown as ScriptEpisodeOutline;
    const report = validateScriptEpisode(episode({ scenes: [scene] }), plan, {
      outline,
      registeredCharacterIds: new Set(['character-1']),
      registeredCharacterNames: new Set(['沈清']),
      characterNamesById: new Map([['character-1', '沈清']]),
    });

    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'NON_CONTIGUOUS_SCENE_ORDINAL',
      'DUPLICATE_BLOCK_ID',
      'SPEAKER_NOT_IN_SCENE',
      'SPEAKER_CHARACTER_MISMATCH',
      'MISSING_REQUIRED_FACT',
      'FORBIDDEN_FACT',
    ]));
    expect(report.issues.find((issue) => issue.code === 'DUPLICATE_BLOCK_ID')).toMatchObject({
      sceneId: 'scene-2',
      blockId: 'duplicate-block',
    });
    expect(report.issues.find((issue) => issue.code === 'MISSING_REQUIRED_FACT')).toMatchObject({
      severity: 'soft',
      blocking: false,
    });
  });

  it('reports structured continuity ledger conflicts without hard-failing the episode', () => {
    const report = validateScriptEpisode(
      episode({
        scenes: [validScene()],
        summary: '本集摘要',
        newFacts: ['旧事实'],
        openedThreads: ['即开即收'],
        closedThreads: ['即开即收', '不存在的旧伏笔'],
      }),
      plan,
      {
        continuity: {
          currentState: ['旧事实'],
          openThreads: [],
          wardrobeLedger: [],
        },
      },
    );

    expect(report.hardFailed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'UNKNOWN_CLOSED_THREAD',
      'THREAD_OPENED_AND_CLOSED',
      'DUPLICATE_CONTINUITY_FACT',
    ]));
  });

  it('converts gate issues into persisted review issues with source and location', () => {
    const items = createScriptReviewIssues('project-1', 3, 'deterministic', [{
      code: 'EMPTY_BLOCK_TEXT',
      severity: 'hard',
      message: '正文块内容为空。',
      sceneId: 'scene-1',
      blockId: 'block-1',
      path: 'blocks.text',
    }], '2026-08-15T00:00:00.000Z');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      projectId: 'project-1',
      episodeNumber: 3,
      source: 'deterministic',
      status: 'open',
      category: 'format',
      sceneId: 'scene-1',
      blockId: 'block-1',
    });
  });

  it('keeps AI hard findings advisory while user hard findings remain blocking', () => {
    const aiReport = validateScriptEpisode(
      episode({ scenes: [validScene()], summary: '摘要' }),
      plan,
      {
        reviewIssues: [{
          code: 'AI_WEAK_HOOK',
          severity: 'hard',
          source: 'ai',
          message: '模型认为卡点不够强。',
        }],
      },
    );

    expect(aiReport.hardFailed).toBe(false);
    expect(aiReport.advisoryIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AI_WEAK_HOOK', source: 'ai', blocking: false }),
    ]));

    const userReport = validateScriptEpisode(
      episode({ scenes: [validScene()], summary: '摘要' }),
      plan,
      {
        reviewIssues: [{
          code: 'USER_CANON_CONFLICT',
          severity: 'hard',
          source: 'user',
          message: '用户确认这是设定冲突。',
        }],
      },
    );

    expect(userReport.hardFailed).toBe(true);
    expect(userReport.blockingIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'USER_CANON_CONFLICT', source: 'user', blocking: true }),
    ]));
  });

  it.each([
    '△沈清推门而入。',
    '【字幕：三天后】',
    '沈清（冷静）：证据在这里。',
  ])('keeps caption wrapper pollution advisory: %s', (caption) => {
    const scene = {
      ...validScene(),
      characterIds: ['character-1'],
      blocks: [
        { id: 'action', type: 'action' as const, text: '剧情'.repeat(40) },
        { id: 'caption', type: 'caption' as const, text: caption },
      ],
    };
    const report = validateScriptEpisode(episode({ scenes: [scene], summary: '摘要' }), plan, {
      registeredCharacterNames: new Set(['沈清']),
    });

    expect(report.hardFailed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'CAPTION_STRUCTURE_POLLUTION',
        severity: 'soft',
        sceneId: 'scene-1',
        blockId: 'caption',
      }),
    ]));
  });

  it.each([
    '△沈清推门而入。',
    '【字幕：三天后】',
    '沈清（冷静）：证据在这里。',
  ])('keeps action wrapper pollution advisory: %s', (action) => {
    const scene = {
      ...validScene(),
      characterIds: ['character-1'],
      blocks: [
        { id: 'filler', type: 'action' as const, text: '剧情'.repeat(40) },
        { id: 'polluted-action', type: 'action' as const, text: action },
      ],
    };
    const report = validateScriptEpisode(episode({ scenes: [scene], summary: '摘要' }), plan, {
      registeredCharacterNames: new Set(['沈清']),
    });

    expect(report.hardFailed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ACTION_STRUCTURE_POLLUTION',
        severity: 'soft',
        sceneId: 'scene-1',
        blockId: 'polluted-action',
        path: 'blocks.text',
      }),
    ]));
  });

  it.each([
    '△沈清转身离开。',
    '【字幕：三天后】',
    '沈清：证据在这里。',
    '沈清（冷静）：证据在这里。',
  ])('keeps dialogue wrapper pollution advisory: %s', (dialogue) => {
    const scene = {
      ...validScene(),
      characterIds: ['character-1'],
      blocks: [
        { id: 'filler', type: 'action' as const, text: '剧情'.repeat(40) },
        {
          id: 'polluted-dialogue',
          type: 'dialogue' as const,
          characterId: 'character-1',
          speaker: '沈清',
          text: dialogue,
        },
      ],
    };
    const report = validateScriptEpisode(episode({ scenes: [scene], summary: '摘要' }), plan, {
      registeredCharacterIds: new Set(['character-1']),
      registeredCharacterNames: new Set(['沈清']),
      characterNamesById: new Map([['character-1', '沈清']]),
    });

    expect(report.hardFailed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'DIALOGUE_STRUCTURE_POLLUTION',
        severity: 'soft',
        sceneId: 'scene-1',
        blockId: 'polluted-dialogue',
        path: 'blocks.text',
      }),
    ]));
  });

  it('reports an outline forbidden fact once with the specific stable code', () => {
    const outline = {
      id: 'outline-1',
      conflict: '正面冲突',
      endingHook: '新证人出现',
      requiredFacts: [],
      forbiddenFacts: ['校园剧'],
    } as unknown as ScriptEpisodeOutline;
    const scene = {
      ...validScene(),
      blocks: [{ id: 'action', type: 'action' as const, text: `校园剧${'剧情'.repeat(42)}` }],
    };
    const overlappingPlan = { ...plan, forbiddenElements: ['校园剧'] };
    const report = validateScriptEpisode(
      episode({ scenes: [scene], summary: '摘要' }),
      overlappingPlan,
      { outline },
    );

    expect(report.issues.filter((issue) => issue.code.includes('FORBIDDEN')))
      .toEqual([expect.objectContaining({ code: 'FORBIDDEN_FACT', severity: 'hard' })]);
    expect(report.hardFailed).toBe(true);
  });

  it('reports a localized soft LONG_DIALOGUE finding above 80 visible characters', () => {
    const scene = {
      ...validScene(),
      characterIds: ['character-1'],
      blocks: [{
        id: 'long-dialogue',
        type: 'dialogue' as const,
        characterId: 'character-1',
        speaker: '沈清',
        text: '证据'.repeat(45),
      }],
    };
    const report = validateScriptEpisode(episode({ scenes: [scene], summary: '摘要' }), plan, {
      registeredCharacterIds: new Set(['character-1']),
      registeredCharacterNames: new Set(['沈清']),
      characterNamesById: new Map([['character-1', '沈清']]),
    });

    expect(report.hardFailed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'LONG_DIALOGUE',
        severity: 'soft',
        sceneId: 'scene-1',
        blockId: 'long-dialogue',
      }),
    ]));
  });
});
