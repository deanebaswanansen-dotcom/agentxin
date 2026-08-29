import type { ScriptEpisode } from '../domain.js';

export interface ScriptEpisodeLengthCapResult {
  episode: ScriptEpisode;
  trimmed: boolean;
  beforeVisibleChars: number;
  afterVisibleChars: number;
}

export const SCRIPT_EPISODE_TARGET_TOLERANCE_CHARS = 200;

export function scriptEpisodeLengthRange(targetChars: number): { minimum: number; maximum: number } {
  const target = Math.max(1, Math.floor(targetChars));
  return {
    minimum: Math.max(300, target - SCRIPT_EPISODE_TARGET_TOLERANCE_CHARS),
    maximum: target + SCRIPT_EPISODE_TARGET_TOLERANCE_CHARS,
  };
}

export function scriptEpisodeVisibleChars(episode: ScriptEpisode): number {
  return episode.scenes
    .flatMap((scene) => scene.blocks)
    .reduce((total, block) => total + visibleChars(block.text), 0);
}

/** Measures length without destructively clipping dialogue or story beats. */
export function capGeneratedEpisodeLength(
  episode: ScriptEpisode,
  _targetChars = episode.targetChars,
): ScriptEpisodeLengthCapResult {
  const beforeVisibleChars = scriptEpisodeVisibleChars(episode);
  return {
    episode,
    trimmed: false,
    beforeVisibleChars,
    afterVisibleChars: beforeVisibleChars,
  };
}

function visibleChars(value: string): number {
  return value.replace(/\s/gu, '').length;
}
