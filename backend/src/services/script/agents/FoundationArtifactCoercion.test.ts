import { describe, expect, it } from 'vitest';

import {
  decodeScriptCharacterInputs,
  decodeScriptPlanInput,
  decodeScriptSeriesOutlineInput,
  decodeScriptWorldBibleInput,
  validateScriptCharacterSet,
} from '../ScriptCanonicalInput.js';
import type { ScriptPlan } from '../domain.js';
import {
  coerceCharacterBibleCandidate,
  coerceScriptPlanCandidate,
  coerceSeriesOutlineChunk,
  coerceWorldBibleCandidate,
} from './FoundationArtifactCoercion.js';

function plan(overrides: Partial<ScriptPlan> = {}): ScriptPlan {
  return {
    id: 'plan-1', projectId: 'project-1', status: 'approved', revision: 4,
    title: '逆风', theme: '成长', market: 'domestic', channel: 'general',
    genres: ['都市'], audience: '大众', coreConflict: '主角夺回事业与尊严',
    logline: '主角从低谷重新出发。', highlights: ['反转'], totalEpisodes: 20,
    episodeDurationSeconds: { min: 60, max: 90 }, targetCharsPerEpisode: 1_000,
    maxPrimaryCharacters: 4, maxScenesPerEpisode: 3, dialogueDensityPercent: 60,
    language: 'zh-CN', format: 'cn_short_drama', coreRequirements: '',
    forbiddenElements: [], endingDirection: '真相公开，主角完成成长',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('FoundationArtifactCoercion', () => {
  it('fills a nearly empty plan while preserving confirmed values and ownership metadata', () => {
    const current = plan();
    const completed = coerceScriptPlanCandidate({
      title: '  新标题  ',
      maxPrimaryCharacters: '999',
      market: '国内',
    }, {
      projectId: 'project-1',
      now: '2026-08-26T00:00:00.000Z',
      id: 'must-not-replace-current-id',
      current,
      explicit: {
        genres: ['悬疑'], coreConflict: '追查失踪真相', audience: '年轻观众',
        totalEpisodes: 60, episodeDurationSeconds: { min: 80, max: 100 },
        targetCharsPerEpisode: 1_200, maxScenesPerEpisode: 4,
        dialogueDensityPercent: 55, endingDirection: '案件告破',
      },
    });

    expect(completed).toMatchObject({
      id: 'plan-1', projectId: 'project-1', revision: 4,
      title: '新标题', market: 'domestic', maxPrimaryCharacters: 20,
      genres: ['悬疑'], totalEpisodes: 60, endingDirection: '案件告破',
    });
    expect(() => decodeScriptPlanInput(completed)).not.toThrow();

    const converted = coerceScriptPlanCandidate({
      genres: '都市、悬疑', totalEpisodes: '88集',
    }, {
      projectId: 'project-1', now: '2026-08-26T00:00:00.000Z', id: 'plan-2', explicit: {},
    });
    expect(converted).toMatchObject({ genres: ['都市', '悬疑'], totalEpisodes: 88 });
  });

  it('repairs duplicated, sparse and out-of-order outline cards into one complete range', () => {
    const completed = coerceSeriesOutlineChunk({
      synopsis: '只给了一个总述',
      episodeCards: [
        { episodeNumber: 12, title: '十二', mainEvent: '取得线索' },
        { episodeNumber: 12, title: '重复十二' },
        { episodeNumber: 11, endingHook: '门外有人' },
      ],
    }, { plan: plan(), start: 11, end: 20 });
    const cards = completed.episodeCards as Array<Record<string, unknown>>;

    expect(cards).toHaveLength(10);
    expect(cards.map((card) => card.episodeNumber)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 11),
    );
    expect(cards[0]).toMatchObject({ episodeNumber: 11, endingHook: '门外有人' });
    expect(cards[1]).toMatchObject({ episodeNumber: 12, title: '十二' });
    expect(() => decodeScriptSeriesOutlineInput({
      ...completed,
      episodeCards: cards.map((card, index) => ({ ...card, episodeNumber: index + 1 })),
    })).not.toThrow();
  });

  it('completes partial characters, repairs duplicate IDs and drops unsafe relationships', () => {
    const completed = coerceCharacterBibleCandidate({ characters: [
      { id: 'same', name: '阿青', role: '主角', relationships: [{ characterId: 'missing' }] },
      { id: 'same', name: '阿青', role: '配角' },
    ] }, {
      projectId: 'project-1', now: '2026-08-26T00:00:00.000Z',
      plan: plan({ maxPrimaryCharacters: 1 }),
    });

    expect(completed.map((character) => character.id)).toEqual(['same', 'same-2']);
    expect(completed.map((character) => character.name)).toEqual(['阿青', '阿青2']);
    expect(completed.map((character) => character.role)).toEqual(['lead', 'minor']);
    expect(completed[0]?.relationships).toEqual([]);
    const canonical = decodeScriptCharacterInputs(completed).map((character, index) => ({
      ...character,
      id: character.id ?? completed[index]!.id,
    }));
    expect(() => validateScriptCharacterSet(canonical, { maxPrimaryCharacters: 1 })).not.toThrow();
  });

  it('turns a one-field world response into an editable canonical world bible', () => {
    const completed = coerceWorldBibleCandidate({ era: '近未来' }, {
      projectId: 'project-1', now: '2026-08-26T00:00:00.000Z', plan: plan(),
    });

    expect(completed).toMatchObject({
      projectId: 'project-1', era: '近未来', primaryLocations: ['主要故事场景'],
      rules: [], organizations: [], revision: 0,
    });
    expect(() => decodeScriptWorldBibleInput(completed)).not.toThrow();
  });
});
