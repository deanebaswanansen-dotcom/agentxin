import type { ScriptEpisode } from '../domain.js';

export interface ScriptEpisodeLengthCapResult {
  episode: ScriptEpisode;
  trimmed: boolean;
  beforeVisibleChars: number;
  afterVisibleChars: number;
}

export const SCRIPT_EPISODE_TARGET_TOLERANCE_CHARS = 400;

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

/**
 * Keeps generated episodes inside the user's configured target without asking
 * the model to retry. Every scene and block is retained so speakers and story
 * beats cannot disappear; block text is shortened at a sentence boundary where
 * possible so the batch can still finish.
 */
export function capGeneratedEpisodeLength(
  episode: ScriptEpisode,
  targetChars = episode.targetChars,
): ScriptEpisodeLengthCapResult {
  const hardLimit = scriptEpisodeLengthRange(targetChars).maximum;
  const beforeVisibleChars = scriptEpisodeVisibleChars(episode);
  if (beforeVisibleChars <= hardLimit) {
    return {
      episode,
      trimmed: false,
      beforeVisibleChars,
      afterVisibleChars: beforeVisibleChars,
    };
  }

  const entries = episode.scenes.flatMap((scene, sceneIndex) =>
    scene.blocks.map((block, blockIndex) => ({
      key: `${sceneIndex}:${blockIndex}`,
      sceneIndex,
      blockIndex,
      block,
      length: visibleChars(block.text),
    })),
  );
  if (entries.length === 0) {
    return {
      episode,
      trimmed: false,
      beforeVisibleChars,
      afterVisibleChars: beforeVisibleChars,
    };
  }

  const nonEmptyEntries = entries.filter((entry) => entry.length > 0);
  const minimumPerBlock = Math.max(
    1,
    Math.min(40, Math.floor(hardLimit / Math.max(1, nonEmptyEntries.length))),
  );
  const budgets = new Map<string, number>();
  let allocated = 0;
  for (const entry of nonEmptyEntries) {
    const base = Math.min(entry.length, minimumPerBlock);
    budgets.set(entry.key, base);
    allocated += base;
  }
  const remaining = Math.max(0, hardLimit - allocated);
  const gaps = nonEmptyEntries.map((entry) => ({
    entry,
    gap: entry.length - (budgets.get(entry.key) ?? 0),
  }));
  const totalGap = gaps.reduce((total, item) => total + item.gap, 0);
  let distributed = 0;
  const fractions: Array<{ key: string; fraction: number; gap: number }> = [];
  for (const { entry, gap } of gaps) {
    if (gap <= 0 || totalGap <= 0) continue;
    const exactShare = remaining * gap / totalGap;
    const share = Math.min(gap, Math.floor(exactShare));
    budgets.set(entry.key, (budgets.get(entry.key) ?? 0) + share);
    distributed += share;
    fractions.push({ key: entry.key, fraction: exactShare - share, gap: gap - share });
  }
  let leftover = remaining - distributed;
  for (const item of fractions.sort((left, right) => right.fraction - left.fraction)) {
    if (leftover <= 0) break;
    if (item.gap <= 0) continue;
    budgets.set(item.key, (budgets.get(item.key) ?? 0) + 1);
    leftover -= 1;
  }

  const scenes = episode.scenes.map((scene, sceneIndex) => ({
    ...scene,
    blocks: scene.blocks.map((block, blockIndex) => {
      const budget = budgets.get(`${sceneIndex}:${blockIndex}`);
      return budget === undefined ? block : { ...block, text: trimTextToVisibleLimit(block.text, budget) };
    }),
  }));

  const cappedEpisode = { ...episode, scenes };
  return {
    episode: cappedEpisode,
    trimmed: true,
    beforeVisibleChars,
    afterVisibleChars: scriptEpisodeVisibleChars(cappedEpisode),
  };
}

function visibleChars(value: string): number {
  return value.replace(/\s/gu, '').length;
}

function trimTextToVisibleLimit(value: string, limit: number): string {
  if (visibleChars(value) <= limit) return value;
  let used = 0;
  let end = 0;
  for (const character of value) {
    const width = /\s/u.test(character) ? 0 : character.length;
    if (used + width > limit) break;
    used += width;
    end += character.length;
  }
  let candidate = value.slice(0, end).trimEnd();
  const safeBoundary = Math.floor(candidate.length * 0.55);
  const sentenceBoundary = Math.max(
    candidate.lastIndexOf('。'),
    candidate.lastIndexOf('！'),
    candidate.lastIndexOf('？'),
    candidate.lastIndexOf('!'),
    candidate.lastIndexOf('?'),
    candidate.lastIndexOf('；'),
    candidate.lastIndexOf(';'),
  );
  if (sentenceBoundary >= safeBoundary) candidate = candidate.slice(0, sentenceBoundary + 1).trimEnd();
  if (!candidate) candidate = value.slice(0, end).trim() || value.trim().slice(0, 1);
  if (!/[。！？!?；;…]$/u.test(candidate) && visibleChars(candidate) >= limit) {
    candidate = `${candidate.slice(0, -1)}…`;
  }
  return candidate;
}
