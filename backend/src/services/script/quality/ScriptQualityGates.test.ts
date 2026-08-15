import { describe, expect, it } from 'vitest';

import type { ScriptEpisode, ScriptEpisodeOutline, ScriptPlan } from '../domain.js';
import {
  createScriptReviewIssues,
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

  it('reports all deterministic hard failures with stable issue codes', () => {
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
          'TOO_MANY_SCENES',
          'DUPLICATE_SCENE_ORDINAL',
          'MISSING_LOCATION',
          'MISSING_SPEAKER',
          'UNKNOWN_CHARACTER_REFERENCE',
          'MODEL_ARTIFACT',
          'FORBIDDEN_ELEMENT',
          'MISSING_KEY_EVENT',
          'MISSING_ENDING_HOOK',
        ]),
    );
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

  it.each([
    '△沈清推门而入。',
    '【字幕：三天后】',
    '沈清（冷静）：证据在这里。',
  ])('hard-fails caption blocks polluted by action/dialogue structure: %s', (caption) => {
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

    expect(report.hardFailed).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'CAPTION_STRUCTURE_POLLUTION',
        sceneId: 'scene-1',
        blockId: 'caption',
      }),
    ]));
  });

  it.each([
    '△沈清推门而入。',
    '【字幕：三天后】',
    '沈清（冷静）：证据在这里。',
  ])('hard-fails action blocks polluted by serialized structure: %s', (action) => {
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

    expect(report.hardFailed).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ACTION_STRUCTURE_POLLUTION',
        severity: 'hard',
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
  ])('hard-fails dialogue text polluted by serialized structure: %s', (dialogue) => {
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

    expect(report.hardFailed).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'DIALOGUE_STRUCTURE_POLLUTION',
        severity: 'hard',
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

    expect(report.issues.filter((issue) => issue.code.includes('FORBIDDEN')).map((issue) => issue.code))
      .toEqual(['FORBIDDEN_FACT']);
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
