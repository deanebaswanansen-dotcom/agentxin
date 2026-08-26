import { describe, expect, it } from 'vitest';

import type { ScriptEpisodeCard, ScriptEpisodeOutline, ScriptPlan } from '../domain.js';
import {
  coerceEpisodeDraftCandidate,
  coerceEpisodeOutlineCandidate,
  coercePlannedScenes,
} from './EpisodeArtifactCoercion.js';

const card = {
  episodeNumber: 2,
  title: '冰库告急',
  logline: '主角发现备用电源即将耗尽。',
  mainEvent: '主角组织众人抢修发电机。',
  endingHook: '发电机重新启动时，外面传来敲门声。',
} as ScriptEpisodeCard;

const plan = {
  totalEpisodes: 60,
  targetCharsPerEpisode: 1_000,
  maxScenesPerEpisode: 3,
} as ScriptPlan;

function ids() {
  let sequence = 0;
  return () => `local-${++sequence}`;
}

describe('EpisodeArtifactCoercion', () => {
  it('fills a missing outline object from its confirmed episode card', () => {
    const outline = coerceEpisodeOutlineCandidate({}, {
      projectId: 'project-1',
      episodeNumber: 2,
      card,
      registeredCharacterIds: new Set(['lead']),
      createId: ids(),
    });

    expect(outline).toMatchObject({
      episodeNumber: 2,
      title: card.title,
      goal: card.logline,
      conflict: card.mainEvent,
      endingHook: card.endingHook,
      beats: [card.mainEvent],
      plannedScenes: [],
    });
  });

  it('normalizes duplicate and malformed scene-plan fields locally', () => {
    expect(coercePlannedScenes([
      { ordinal: 3, location: '', timeOfDay: '夜', interiorExterior: '外景', purpose: '发现线索' },
      { ordinal: 3, place: '仓库', time: 'bad', purpose: '' },
    ])).toEqual([
      expect.objectContaining({ ordinal: 1, location: '未指定地点', timeOfDay: 'night', interiorExterior: 'exterior' }),
      expect.objectContaining({ ordinal: 2, location: '仓库', timeOfDay: 'day', purpose: '推进第 2 场事件' }),
    ]);
  });

  it('keeps usable draft content despite missing metadata and polluted block formatting', () => {
    const outline = {
      ...coerceEpisodeOutlineCandidate({}, {
        projectId: 'project-1', episodeNumber: 2, card,
        registeredCharacterIds: new Set(['lead']), createId: ids(),
      }),
      plannedScenes: coercePlannedScenes([{ location: '冰库', purpose: '抢修发电机' }]),
    } as ScriptEpisodeOutline;
    const draft = coerceEpisodeDraftCandidate({
      episodeNumber: 3,
      scenes: [{
        ordinal: 7,
        blocks: [
          { type: 'action', text: '△主角拆开发电机外壳。' },
          { type: 'dialogue', speaker: '主角', text: '主角：把扳手给我！' },
          { type: 'action', text: '' },
        ],
      }],
    }, {
      projectId: 'project-1', outline, plan, createId: ids(),
      now: '2026-08-26T00:00:00.000Z',
    });

    expect(draft.episodeNumber).toBe(2);
    expect(draft.summary).toBe(outline.goal);
    expect(draft.scenes[0]).toMatchObject({ ordinal: 1, location: '冰库' });
    expect(draft.scenes[0]?.blocks.map((block) => block.text)).toEqual([
      '主角拆开发电机外壳。',
      '把扳手给我！',
    ]);
  });

  it('still rejects an out-of-range episode number and a genuinely empty body', () => {
    const outline = coerceEpisodeOutlineCandidate({}, {
      projectId: 'project-1', episodeNumber: 2, card,
      registeredCharacterIds: new Set(), createId: ids(),
    });
    const options = {
      projectId: 'project-1', outline, plan, createId: ids(),
      now: '2026-08-26T00:00:00.000Z',
    };
    expect(() => coerceEpisodeDraftCandidate({ episodeNumber: 61, content: '仍有正文' }, options))
      .toThrow('超出 1—60');
    expect(() => coerceEpisodeDraftCandidate({ episodeNumber: 2, scenes: [] }, options))
      .toThrow('未返回可见正文');
  });
});
