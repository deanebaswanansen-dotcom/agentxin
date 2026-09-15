import type {
  AcceptedMemoryEntry,
  AcceptedMemoryInput,
  MemoryEvidence,
  MemorySourceBlock,
} from '../../types/SourceMemory.js';
import { createFrozenMemoryProjection, hashSourceMemoryBlocks, hashSourceMemoryValue } from '../memory/sourceMemoryContract.js';
import type { ScriptEpisode, ScriptEpisodeContinuityCommit, ScriptProjectState } from './domain.js';
import { currentScriptContinuityCommits } from './ScriptContinuityCommit.js';

/** A citation match is deliberately literal; old tail-block pointers are not evidence. */
function locateQuote(blocks: MemorySourceBlock[], quote: string): MemoryEvidence[] {
  if (!quote.trim()) return [];
  for (const block of blocks) {
    const start = block.text.indexOf(quote);
    if (start >= 0) return [{ blockId: block.id, start, end: start + quote.length, quote }];
  }
  return [];
}

function episodeBlocks(episode: ScriptEpisode): MemorySourceBlock[] {
  return episode.scenes.flatMap((scene) =>
    scene.blocks.map((block) => ({ id: block.id, sceneId: scene.id, text: block.text })),
  );
}

/** A compatibility normalization must not silently re-accept a changed body. */
export function staleInvalidScriptMemorySources(state: ScriptProjectState, clientId: string): boolean {
  let changed = false;
  for (const commit of state.continuityCommits ?? []) {
    if (commit.status !== 'current' || !commit.memoryInput) continue;
    const source = commit.memoryInput.source;
    const episode = state.episodes.find((item) => item.episodeNumber === commit.episodeNumber);
    let valid = Boolean(source && episode && source.acceptanceId === commit.id && source.clientId === clientId &&
      source.projectId === state.projectId && source.mode === 'short_drama' && source.resourceId === episode.id &&
      source.unitNumber === commit.episodeNumber && source.revision === commit.episodeRevision &&
      source.revision === episode.revision && episode.status === 'completed');
    try {
      valid = valid && source!.contentHash === hashSourceMemoryBlocks(commit.memoryInput.blocks) &&
        source!.contentHash === hashSourceMemoryBlocks(episodeBlocks(episode!));
    } catch { valid = false; }
    if (!valid) { commit.status = 'stale'; commit.updatedAt = new Date().toISOString(); changed = true; }
  }
  return changed;
}

/** Freeze from the final saved body, never from mutable metadata at sync time. */
export function freezeScriptMemoryInput(
  clientId: string,
  episode: ScriptEpisode,
  commit: ScriptEpisodeContinuityCommit,
): AcceptedMemoryInput {
  const blocks = episodeBlocks(episode);
  const entries: AcceptedMemoryEntry[] = [];
  function add(entry: Omit<AcceptedMemoryEntry, 'evidence'>): void {
    const text = entry.text.trim();
    if (text) entries.push({ ...entry, text, evidence: locateQuote(blocks, text) });
  }
  for (const fact of commit.factsAdded) add({ id: `fact:${fact.factId}`, kind: 'fact', text: fact.text });
  for (const update of commit.characterUpdates) {
    for (const key of ['location', 'emotionalState', 'outfit'] as const) {
      const value = update[key];
      if (value) add({ id: `character:${update.characterId}:${key}`, kind: 'state', entity: update.characterId, key, value, action: 'set', text: value });
    }
    update.knownFactsAdded.forEach((text, index) => add({ id: `known:${update.characterId}:${index}`, kind: 'fact', entity: update.characterId, text }));
    // The legacy delta has no stable relationship target. An array position
    // must never supersede another person's relationship in a later episode.
    update.relationshipChanges.forEach((text, index) => add({ id: `relationship:${update.characterId}:${index}`, kind: 'fact', entity: update.characterId, text }));
  }
  for (const prop of commit.props) {
    add({ id: `prop:${prop.propId}:state`, kind: 'state', entity: prop.propId, key: 'state', value: prop.state, action: 'set', text: `${prop.name}：${prop.state}` });
    if (prop.holderCharacterId) add({ id: `prop:${prop.propId}:holder`, kind: 'state', entity: prop.propId, key: 'holder', value: prop.holderCharacterId, action: 'set', text: `${prop.name}持有人：${prop.holderCharacterId}` });
  }
  for (const thread of commit.threads) add({
    id: `thread:${thread.threadId}`, kind: 'thread', entity: thread.threadId, key: 'thread',
    action: thread.action === 'closed' ? 'close' : 'open', text: thread.description,
  });
  for (const event of commit.timelineEvents) add({ id: `event:${event.eventId}`, kind: 'summary', text: event.summary });
  add({ id: 'episode-summary', kind: 'summary', text: episode.summary });
  return {
    schemaVersion: 1,
    source: { clientId, projectId: episode.projectId, mode: 'short_drama', resourceId: episode.id,
      unitNumber: episode.episodeNumber, revision: episode.revision,
      contentHash: hashSourceMemoryBlocks(blocks), acceptanceId: commit.id },
    title: episode.title,
    acceptedAt: commit.createdAt,
    blocks,
    entries,
  };
}

/** Keep only the current complete continuity chain; old files are never backfilled as accepted. */
export function refreshScriptMemoryIntent(state: ScriptProjectState, clientId: string): void {
  const acceptances = currentScriptContinuityCommits(state)
    .flatMap((commit) => commit.memoryInput ? [commit.memoryInput] : []);
  const previous = state.memorySync;
  if (!previous && acceptances.length === 0) return;
  if (previous && hashSourceMemoryValue(previous.projection.acceptances) === hashSourceMemoryValue(acceptances)) return;
  const now = new Date().toISOString();
  state.memorySync = {
    projection: createFrozenMemoryProjection({
      clientId, projectId: state.projectId, mode: 'short_drama',
      revision: (previous?.projection.revision ?? 0) + 1, acceptances,
    }),
    status: 'pending', attempts: 0, createdAt: now, updatedAt: now,
  };
}
