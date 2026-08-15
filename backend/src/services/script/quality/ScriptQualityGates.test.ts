import { describe, expect, it } from 'vitest';

import type { ScriptEpisode, ScriptEpisodeOutline, ScriptPlan } from '../domain.js';
import { validateScriptEpisode } from './ScriptQualityGates.js';

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
});
