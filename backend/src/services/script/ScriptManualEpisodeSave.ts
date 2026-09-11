import type {
  ScriptEpisode,
  ScriptEpisodeContinuityCommitInput,
  ScriptProjectState,
} from './domain.js';
import {
  buildScriptContinuityCandidate,
  currentScriptContinuityCommits,
} from './ScriptContinuityCommit.js';

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function normalizedStrings(values: readonly string[]): string {
  return JSON.stringify([...new Set(values.map(normalizedText))].sort());
}

/** IDs, titles and formatting are not story changes; scene/cast/dialogue edits are. */
function bodyKey(episode: ScriptEpisode): string {
  return JSON.stringify(episode.scenes.map((scene) => ({
    location: normalizedText(scene.location),
    timeOfDay: scene.timeOfDay,
    interiorExterior: scene.interiorExterior,
    characterIds: [...scene.characterIds].sort(),
    blocks: scene.blocks.map((block) => ({
      type: block.type,
      text: normalizedText(block.text),
      ...(block.type === 'dialogue' ? {
        characterId: block.characterId,
        speaker: normalizedText(block.speaker),
        delivery: normalizedText(block.delivery ?? ''),
        mode: block.mode ?? 'normal',
      } : {}),
    })),
  })));
}

const LIST_METADATA_FIELDS = ['newFacts', 'openedThreads', 'closedThreads'] as const;

function metadataMatches(current: ScriptEpisode, episode: ScriptEpisode): boolean {
  return normalizedText(current.summary) === normalizedText(episode.summary) &&
    LIST_METADATA_FIELDS.every((field) =>
      normalizedStrings(current[field]) === normalizedStrings(episode[field]),
    );
}

/**
 * The editor round-trips hidden metadata without editing it. Invalidate each
 * unchanged field after a body edit, while accepting fields the caller actually
 * updated. Persist this on the Episode itself so every later context/review path
 * sees the same safe metadata, including saves that remain drafts.
 */
export function reconcileManualEpisodeMetadata(
  current: ScriptEpisode | undefined,
  episode: ScriptEpisode,
): ScriptEpisode {
  if (!current || bodyKey(current) === bodyKey(episode)) return episode;
  const reconciled = { ...episode };
  if (normalizedText(current.summary) === normalizedText(episode.summary)) {
    reconciled.summary = '';
  }
  for (const field of LIST_METADATA_FIELDS) {
    if (normalizedStrings(current[field]) === normalizedStrings(episode[field])) {
      reconciled[field] = [];
    }
  }
  return reconciled;
}

/** Preserve an unchanged body's handoff without reviving metadata from an older revision. */
export function buildManualScriptContinuityCandidate(
  state: ScriptProjectState,
  episode: ScriptEpisode,
  current: ScriptEpisode | undefined,
): ScriptEpisodeContinuityCommitInput {
  const bodyUnchanged = current && bodyKey(current) === bodyKey(episode);
  const previousCommit = bodyUnchanged
    ? [...(state.continuityCommits ?? [])]
      .filter((commit) => commit.episodeNumber === current.episodeNumber &&
        commit.episodeRevision === current.revision)
      .sort((left, right) => right.revision - left.revision)[0]
    : undefined;
  const wardrobe = previousCommit?.characterUpdates.flatMap((update) =>
    update.outfit ? [{ characterId: update.characterId, outfit: update.outfit }] : [],
  ) ?? [];
  const registeredCharacterIds = new Set(state.characters.map((character) => character.id));
  const validCharacterReferences = previousCommit?.characterUpdates.every((update) =>
    registeredCharacterIds.has(update.characterId),
  ) && previousCommit.props.every((prop) =>
    prop.holderCharacterId === undefined || registeredCharacterIds.has(prop.holderCharacterId),
  );
  if (!previousCommit || !current || !metadataMatches(current, episode) || !validCharacterReferences) {
    return buildScriptContinuityCandidate(state, episode, wardrobe);
  }

  // An unchanged body may have regenerated scene/block IDs. Rebind all retained
  // evidence positionally, which is safe because bodyKey includes ordered blocks.
  const blockIds = new Map(current.scenes.flatMap((scene, sceneIndex) =>
    scene.blocks.map((block, blockIndex) =>
      [block.id, episode.scenes[sceneIndex]!.blocks[blockIndex]!.id] as const,
    ),
  ));
  const rebindEvidence = <T extends { evidenceBlockIds: string[] }>(item: T): T => ({
    ...structuredClone(item),
    evidenceBlockIds: item.evidenceBlockIds.flatMap((id) => {
      const rebound = blockIds.get(id);
      return rebound ? [rebound] : [];
    }),
  });
  const resolvableEventIds = new Set([
    ...currentScriptContinuityCommits(state)
      .filter((commit) => commit.episodeNumber < episode.episodeNumber)
      .flatMap((commit) => commit.timelineEvents.map((event) => event.eventId)),
    ...previousCommit.timelineEvents.map((event) => event.eventId),
  ]);
  return {
    characterUpdates: structuredClone(previousCommit.characterUpdates),
    factsAdded: previousCommit.factsAdded.map(rebindEvidence),
    props: previousCommit.props.map(rebindEvidence),
    threads: previousCommit.threads.map(rebindEvidence),
    timelineEvents: previousCommit.timelineEvents.map((event) => ({
      ...rebindEvidence(event),
      // An earlier manual edit may have invalidated its old summary/event.
      causeEventIds: event.causeEventIds.filter((id) => resolvableEventIds.has(id)),
    })),
    nextEpisodeMustInherit: [...previousCommit.nextEpisodeMustInherit],
  };
}
