import { createHash } from 'node:crypto';

import type {
  ScriptCommitEpisodeWithContinuityInput,
  ScriptContinuityState,
  ScriptEpisode,
  ScriptEpisodeContinuityCommit,
  ScriptEpisodeContinuityCommitInput,
  ScriptInputRevisionRef,
  ScriptProjectState,
  ScriptUpstreamArtifactRef,
} from './domain.js';
import {
  computeScriptEpisodeCandidateHash,
  computeScriptInputFingerprint,
} from './ScriptStore.js';

function normalizedKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN');
}

function stableId(prefix: string, value: string): string {
  const digest = createHash('sha256').update(normalizedKey(value), 'utf8').digest('hex').slice(0, 20);
  return `${prefix}-${digest}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const text = value.trim();
    if (text) byKey.set(normalizedKey(text), text);
  }
  return [...byKey.values()];
}

/** Only commits that still match the completed Episode revision are usable canon. */
export function currentScriptContinuityCommits(
  state: ScriptProjectState,
): ScriptEpisodeContinuityCommit[] {
  const episodeRevisionByNumber = new Map(
    state.episodes
      .filter((episode) => episode.status === 'completed')
      .map((episode) => [episode.episodeNumber, episode.revision]),
  );
  const matching = (state.continuityCommits ?? [])
    .filter((commit) =>
      commit.status === 'current' &&
      episodeRevisionByNumber.get(commit.episodeNumber) === commit.episodeRevision,
    )
    .sort((left, right) =>
      left.episodeNumber - right.episodeNumber || left.revision - right.revision,
    );

  // Canon is a single, contiguous chain beginning at episode one. Merely
  // retaining `current` on a successor is insufficient after an earlier
  // Episode is edited/staled: every pointer must resolve to the immediately
  // preceding canonical commit.
  const byEpisode = new Map<number, ScriptEpisodeContinuityCommit[]>();
  for (const commit of matching) {
    byEpisode.set(commit.episodeNumber, [
      ...(byEpisode.get(commit.episodeNumber) ?? []),
      commit,
    ]);
  }
  const canonical: ScriptEpisodeContinuityCommit[] = [];
  for (let episodeNumber = 1; ; episodeNumber += 1) {
    const candidates = byEpisode.get(episodeNumber) ?? [];
    if (candidates.length !== 1) break;
    const candidate = candidates[0]!;
    const previous = canonical.at(-1);
    if (episodeNumber === 1) {
      if (
        candidate.previousContinuityCommitId !== undefined ||
        candidate.previousContinuityRevision !== undefined
      ) break;
    } else if (
      !previous ||
      candidate.previousContinuityCommitId !== previous.id ||
      candidate.previousContinuityRevision !== previous.revision
    ) {
      break;
    }
    canonical.push(candidate);
  }
  return canonical.map((commit) => structuredClone(commit));
}

/**
 * Compatibility projection for prompts and deterministic gates. New projects are
 * projected from immutable commits; legacy projects continue using the old blob.
 */
export function projectScriptContinuity(
  state: ScriptProjectState,
  beforeEpisodeNumber?: number,
): ScriptContinuityState {
  const hasDetailedContinuity = (state.continuityCommits?.length ?? 0) > 0;
  const commits = currentScriptContinuityCommits(state).filter(
    (commit) => beforeEpisodeNumber === undefined || commit.episodeNumber < beforeEpisodeNumber,
  );
  if (!hasDetailedContinuity) return structuredClone(state.continuity);

  const threadById = new Map<string, string>();
  const wardrobeLedger: ScriptContinuityState['wardrobeLedger'] = [];
  for (const commit of commits) {
    for (const thread of commit.threads) {
      if (thread.action === 'closed') threadById.delete(thread.threadId);
      else threadById.set(thread.threadId, thread.description);
    }
    for (const update of commit.characterUpdates) {
      if (update.outfit) {
        wardrobeLedger.push({
          episodeNumber: commit.episodeNumber,
          characterId: update.characterId,
          outfit: update.outfit,
        });
      }
    }
  }
  return {
    currentState: uniqueStrings(
      commits.flatMap((commit) => commit.factsAdded.map((fact) => fact.text)),
    ).slice(-100),
    openThreads: [...threadById.values()],
    wardrobeLedger,
  };
}

function evidenceBlockId(episode: ScriptEpisode): string | undefined {
  for (let sceneIndex = episode.scenes.length - 1; sceneIndex >= 0; sceneIndex -= 1) {
    const scene = episode.scenes[sceneIndex];
    const block = scene?.blocks[scene.blocks.length - 1];
    if (block) return block.id;
  }
  return undefined;
}

function previousCurrentCommit(
  state: ScriptProjectState,
  episodeNumber: number,
): ScriptEpisodeContinuityCommit | undefined {
  return currentScriptContinuityCommits(state).find(
    (commit) => commit.episodeNumber === episodeNumber - 1,
  );
}

export function buildScriptContinuityCandidate(
  state: ScriptProjectState,
  episode: ScriptEpisode,
  wardrobe: readonly { characterId: string; outfit: string }[] = [],
): ScriptEpisodeContinuityCommitInput {
  const evidenceId = evidenceBlockId(episode);
  const evidenceBlockIds = evidenceId ? [evidenceId] : [];
  const registeredCharacterIds = new Set(state.characters.map((character) => character.id));
  const wardrobeByCharacterId = new Map(
    wardrobe
      .filter((item) => registeredCharacterIds.has(item.characterId) && item.outfit.trim())
      .map((item) => [item.characterId, item.outfit.trim()]),
  );
  const appearingCharacterIds = new Set<string>();
  for (const scene of episode.scenes) {
    for (const characterId of scene.characterIds) {
      if (registeredCharacterIds.has(characterId)) appearingCharacterIds.add(characterId);
    }
    for (const block of scene.blocks) {
      if (
        block.type === 'dialogue' &&
        block.characterId &&
        registeredCharacterIds.has(block.characterId)
      ) {
        appearingCharacterIds.add(block.characterId);
      }
    }
  }
  for (const characterId of wardrobeByCharacterId.keys()) appearingCharacterIds.add(characterId);

  const characterUpdates = [...appearingCharacterIds].map((characterId) => {
    const lastScene = [...episode.scenes].reverse().find((scene) =>
      scene.characterIds.includes(characterId) ||
      scene.blocks.some((block) => block.type === 'dialogue' && block.characterId === characterId),
    );
    const outfit = wardrobeByCharacterId.get(characterId);
    return {
      characterId,
      ...(lastScene ? { location: lastScene.location } : {}),
      knownFactsAdded: [],
      relationshipChanges: [],
      ...(outfit ? { outfit } : {}),
    };
  });

  const factsAdded = uniqueStrings(episode.newFacts).map((text) => ({
    factId: stableId('fact', text),
    text,
    evidenceBlockIds,
  }));
  const props = uniqueStrings(state.worldBible?.recurringProps ?? []).flatMap((name) => {
    const matchingBlockIds = episode.scenes.flatMap((scene) => scene.blocks)
      .filter((block) => block.text.includes(name))
      .map((block) => block.id);
    return matchingBlockIds.length > 0
      ? [{
          propId: stableId('prop', name),
          name,
          state: '本集正文出现',
          evidenceBlockIds: matchingBlockIds,
        }]
      : [];
  });
  const priorThreadIds = new Map<string, string>();
  for (const commit of currentScriptContinuityCommits(state)) {
    for (const thread of commit.threads) {
      priorThreadIds.set(normalizedKey(thread.description), thread.threadId);
    }
  }
  const threadByKey = new Map<string, ScriptEpisodeContinuityCommitInput['threads'][number]>();
  for (const description of uniqueStrings(episode.openedThreads)) {
    const key = normalizedKey(description);
    threadByKey.set(key, {
      threadId: priorThreadIds.get(key) ?? stableId('thread', description),
      action: 'opened',
      description,
      evidenceBlockIds,
    });
  }
  for (const description of uniqueStrings(episode.closedThreads)) {
    const key = normalizedKey(description);
    threadByKey.set(key, {
      threadId: priorThreadIds.get(key) ?? stableId('thread', description),
      action: 'closed',
      description,
      evidenceBlockIds,
    });
  }

  const previous = previousCurrentCommit(state, episode.episodeNumber);
  const causeEventId = previous?.timelineEvents.at(-1)?.eventId;
  const lastScene = episode.scenes.at(-1);
  const timelineEvents = episode.summary.trim()
    ? [{
        eventId: stableId('event', `${episode.projectId}:${episode.episodeNumber}`),
        timeLabel: `第${episode.episodeNumber}集`,
        summary: episode.summary.trim(),
        causeEventIds: causeEventId ? [causeEventId] : [],
        evidenceBlockIds,
      }]
    : [];
  const nextEpisodeMustInherit = uniqueStrings([
    ...episode.newFacts,
    ...episode.openedThreads,
    ...(lastScene ? [`结尾位置：${lastScene.location}`] : []),
    ...[...wardrobeByCharacterId.entries()].map(
      ([characterId, outfit]) => `人物 ${characterId} 服装：${outfit}`,
    ),
  ]);

  return {
    characterUpdates,
    factsAdded,
    props,
    threads: [...threadByKey.values()],
    timelineEvents,
    nextEpisodeMustInherit,
  };
}

export interface BuildScriptAtomicCommitOptions {
  upstreamArtifactRefs?: readonly ScriptUpstreamArtifactRef[];
  promptVersion: string;
  modelConfigFingerprint: string;
}

export function buildScriptInputRevisionRefs(
  state: ScriptProjectState,
  episodeNumber: number,
): ScriptInputRevisionRef[] {
  const inputRevisionRefs: ScriptInputRevisionRef[] = [];
  if (state.plan) {
    inputRevisionRefs.push({ resource: 'plan', id: state.plan.id, revision: state.plan.revision });
  }
  if (state.seriesOutline) {
    inputRevisionRefs.push({
      resource: 'outline',
      id: state.seriesOutline.projectId,
      revision: state.seriesOutline.revision,
    });
  }
  const outline = state.episodeOutlines.find((item) => item.episodeNumber === episodeNumber);
  if (outline) {
    inputRevisionRefs.push({ resource: 'outline', id: outline.id, revision: outline.revision });
  }
  inputRevisionRefs.push(...state.characters.map((character) => ({
    resource: 'characters' as const,
    id: character.id,
    revision: character.revision,
  })));
  if (state.worldBible) {
    inputRevisionRefs.push({
      resource: 'world',
      id: state.worldBible.projectId,
      revision: state.worldBible.revision,
    });
  }
  const currentEpisode = state.episodes.find((item) => item.episodeNumber === episodeNumber);
  if (currentEpisode) {
    inputRevisionRefs.push({
      resource: 'episode',
      id: currentEpisode.id,
      revision: currentEpisode.revision,
    });
  }
  const previousEpisode = state.episodes.find((item) => item.episodeNumber === episodeNumber - 1);
  if (previousEpisode) {
    inputRevisionRefs.push({
      resource: 'episode',
      id: previousEpisode.id,
      revision: previousEpisode.revision,
    });
  }
  const previousContinuity = previousCurrentCommit(state, episodeNumber);
  if (previousContinuity) {
    inputRevisionRefs.push({
      resource: 'continuity',
      id: previousContinuity.id,
      revision: previousContinuity.revision,
    });
  }
  return inputRevisionRefs.sort((left, right) =>
    left.resource.localeCompare(right.resource) ||
    left.id.localeCompare(right.id) ||
    left.revision - right.revision,
  );
}

export function buildScriptAtomicCommitInput(
  state: ScriptProjectState,
  episode: ScriptEpisode,
  continuity: ScriptEpisodeContinuityCommitInput,
  options: BuildScriptAtomicCommitOptions,
): ScriptCommitEpisodeWithContinuityInput {
  const inputRevisionRefs = buildScriptInputRevisionRefs(state, episode.episodeNumber);
  const candidateHash = computeScriptEpisodeCandidateHash(episode);
  const base = {
    episode,
    // Bind the commit to the revision that was actually reviewed. Reading a
    // fresher state must never silently advance this CAS value, otherwise an
    // older candidate could overwrite an edit that landed during review.
    expectedEpisodeRevision: episode.revision,
    // This CAS is checked inside the same store mutation as the Episode and
    // continuity write, closing the window for a concurrent user hard issue.
    expectedReviewRevision: state.reviewRevision,
    continuity,
    inputRevisionRefs,
    upstreamArtifactRefs: [...(options.upstreamArtifactRefs ?? [])],
    promptVersion: options.promptVersion,
    modelConfigFingerprint: options.modelConfigFingerprint,
    candidateHash,
  };
  return {
    ...base,
    inputFingerprint: computeScriptInputFingerprint(base),
  };
}
