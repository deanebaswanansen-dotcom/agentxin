import { describe, expect, it } from 'vitest';

import type { ScriptEpisode } from '../domain.js';
import {
  capGeneratedEpisodeLength,
  scriptEpisodeLengthRange,
  scriptEpisodeVisibleChars,
} from './ScriptEpisodeLength.js';

function episodeWith(blocksByScene: string[][], targetChars = 120): ScriptEpisode {
  return {
    id: 'episode-1',
    projectId: 'project-1',
    episodeNumber: 1,
    title: '第一集',
    outlineId: 'outline-1',
    status: 'reviewing',
    targetChars,
    scenes: blocksByScene.map((texts, sceneIndex) => ({
      id: `scene-${sceneIndex + 1}`,
      ordinal: sceneIndex + 1,
      location: `地点${sceneIndex + 1}`,
      timeOfDay: 'day',
      interiorExterior: 'interior',
      characterIds: [],
      blocks: texts.map((text, blockIndex) => ({
        id: `block-${sceneIndex + 1}-${blockIndex + 1}`,
        type: 'action',
        text,
      })),
    })),
    summary: '',
    newFacts: [],
    openedThreads: [],
    closedThreads: [],
    revision: 0,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
  };
}

describe('ScriptEpisodeLength', () => {
  it('caps generated body text at the configured tolerance and preserves the ending beat', () => {
    const source = episodeWith([
      ['开场冲突发生。'.repeat(80), '调查过程推进。'.repeat(80)],
      ['证人交出线索。'.repeat(80), '门外突然传来敲门声。'.repeat(80)],
    ], 1_200);

    const result = capGeneratedEpisodeLength(source);

    expect(result.trimmed).toBe(true);
    expect(result.beforeVisibleChars).toBeGreaterThan(1_600);
    expect(result.afterVisibleChars).toBeGreaterThanOrEqual(800);
    expect(result.afterVisibleChars).toBeLessThanOrEqual(1_600);
    expect(result.episode.scenes.at(-1)?.blocks.at(-1)?.text).toContain('门外突然传来敲门声');
    expect(result.episode.scenes.map((scene) => scene.ordinal)).toEqual([1, 2]);
    expect(result.episode.scenes.every((scene) => scene.blocks.length > 0)).toBe(true);
  });

  it('returns the original episode unchanged when it is already within the target', () => {
    const source = episodeWith([['沈清推门进入校报社。']], 1_200);
    const result = capGeneratedEpisodeLength(source);

    expect(result).toMatchObject({ trimmed: false });
    expect(result.episode).toBe(source);
    expect(scriptEpisodeVisibleChars(result.episode)).toBeLessThanOrEqual(1_200);
  });

  it('keeps every scene and block non-empty when all blocks need proportional shortening', () => {
    const source = episodeWith([
      ['第一场完整动作。'.repeat(40)],
      ['第二场完整动作。'.repeat(40)],
      ['结尾钩子落下。'.repeat(40)],
    ], 300);

    const result = capGeneratedEpisodeLength(source);

    expect(result.afterVisibleChars).toBeLessThanOrEqual(700);
    expect(result.episode.scenes).toHaveLength(3);
    expect(result.episode.scenes.every((scene) => scene.blocks[0]!.text.length > 0)).toBe(true);
    expect(result.episode.scenes.map((scene) => scene.ordinal)).toEqual([1, 2, 3]);
  });

  it('uses an exact 800 to 1600 tolerance window for a 1200-character target', () => {
    expect(scriptEpisodeLengthRange(1_200)).toEqual({ minimum: 800, maximum: 1_600 });
  });
});
