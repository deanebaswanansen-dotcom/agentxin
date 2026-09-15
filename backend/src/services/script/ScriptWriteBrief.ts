import type { WriteBrief, WriteBriefItem, WriteBriefSource, WriteBriefView } from '../../types/WriteBrief.js';
import { createWriteBrief, hashWriteBriefValue, writeBriefSourceKey } from '../writing/WriteBrief.js';
import type { ScriptEpisodeOutline, ScriptProjectState, ScriptUpstreamArtifactRef } from './domain.js';
import { currentScriptContinuityCommits } from './ScriptContinuityCommit.js';
import { computeScriptEpisodeCandidateHash, ScriptCommitConflictError } from './ScriptStore.js';

export interface ScriptWriteBriefOptions {
  outline?: ScriptEpisodeOutline;
  rewriteInstruction?: string;
  rewriteMode?: 'revise' | 'replace';
}

function source(
  kind: WriteBriefSource['kind'], id: string, label: string, value: unknown,
  metadata: Pick<WriteBriefSource, 'revision' | 'unitNumber' | 'excerpt'> = {},
): WriteBriefSource {
  const { excerpt, ...version } = metadata;
  return {
    key: writeBriefSourceKey(kind, id), kind, id, label, contentHash: hashWriteBriefValue(value), ...version,
    ...(excerpt?.trim() ? { excerpt: excerpt.trim().slice(0, 500) } : {}),
  };
}

function items(values: readonly (string | undefined)[], sourceKeys: string[]): WriteBriefItem[] {
  return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((text) => ({ text: text.trim(), sourceKeys }));
}

/** Deterministic, inspectable task input. No model output or global memory blob. */
export function buildScriptWriteBrief(
  state: ScriptProjectState, episodeNumber: number, options: ScriptWriteBriefOptions = {},
): WriteBrief | undefined {
  const plan = state.plan;
  if (!plan) return undefined;
  const persistedOutline = state.episodeOutlines.find((item) => item.episodeNumber === episodeNumber);
  const card = state.seriesOutline?.episodeCards.find((item) => item.episodeNumber === episodeNumber);
  const outline = options.outline ?? persistedOutline;
  if ((!outline && !card) || episodeNumber > plan.totalEpisodes) return undefined;
  const current = state.episodes.find((item) => item.episodeNumber === episodeNumber);
  const sources: WriteBriefSource[] = [
    source('plan', plan.id, '短剧策划', plan, { revision: plan.revision, excerpt: plan.logline }),
    source('author_constraints', plan.id, '作者创作约束', {
      coreRequirements: plan.coreRequirements, creativeRules: plan.creativeRules,
      forbiddenElements: plan.forbiddenElements,
    }, { revision: plan.revision, excerpt: plan.coreRequirements }),
    source('collection', `${state.projectId}:characters`, '登记人物集合',
      state.characters.map(({ id, revision }) => ({ id, revision })).sort((a, b) => a.id.localeCompare(b.id))),
    source('collection', `${state.projectId}:episode-${episodeNumber}-inputs`, '本集资料集合', {
      outline: persistedOutline?.id ?? null, world: state.worldBible?.projectId ?? null,
      seriesOutline: state.seriesOutline?.projectId ?? null,
    }),
  ];
  const planKey = sources[0]!.key;
  const authorKey = sources[1]!.key;
  let outlineKey = planKey;
  if (state.seriesOutline) {
    const entry = source('outline', `${state.projectId}:series`, '全剧大纲与本集分集卡', state.seriesOutline, {
      revision: state.seriesOutline.revision, unitNumber: episodeNumber, excerpt: card?.mainEvent,
    });
    sources.push(entry);
    outlineKey = entry.key;
  }
  if (persistedOutline) {
    const usedOutline = !options.outline || hashWriteBriefValue(options.outline) === hashWriteBriefValue(persistedOutline);
    const entry = source('outline', persistedOutline.id, `第 ${episodeNumber} 集详细大纲${usedOutline ? '' : '（仅监测版本）'}`, persistedOutline, {
      revision: persistedOutline.revision, unitNumber: episodeNumber, ...(usedOutline ? { excerpt: persistedOutline.goal } : {}),
    });
    sources.push(entry);
    if (usedOutline) outlineKey = entry.key;
  }
  for (const character of [...state.characters].sort((a, b) => a.id.localeCompare(b.id))) {
    sources.push(source('character', character.id, character.name, character, {
      revision: character.revision, excerpt: character.identity,
    }));
  }
  if (state.worldBible) {
    sources.push(source('world', state.worldBible.projectId, '世界规则', state.worldBible, {
      revision: state.worldBible.revision, excerpt: state.worldBible.era,
    }));
  }
  const pastCommits = currentScriptContinuityCommits(state).filter((commit) => commit.episodeNumber < episodeNumber);
  const hasDetailedContinuity = (state.continuityCommits?.length ?? 0) > 0;
  const pastEpisodes = state.episodes
    .filter((episode) => episode.status === 'completed' && episode.episodeNumber < episodeNumber &&
      (!hasDetailedContinuity || pastCommits.some((commit) => commit.episodeNumber === episode.episodeNumber)))
    .sort((a, b) => a.episodeNumber - b.episodeNumber);
  sources.push(source('collection', `${state.projectId}:before-${episodeNumber}`, '已完成前集与有效连续性集合', {
    episodes: pastEpisodes.map(({ id, revision }) => ({ id, revision })),
    continuity: pastCommits.map(({ id, revision }) => ({ id, revision })),
  }));
  const required: WriteBriefItem[] = items(outline?.requiredFacts ?? [], [outlineKey]);
  for (const episode of pastEpisodes) {
    const entry = source('episode', episode.id, `第 ${episode.episodeNumber} 集已完成正文`, {
      id: episode.id, revision: episode.revision, candidateHash: computeScriptEpisodeCandidateHash(episode),
    }, {
      revision: episode.revision, unitNumber: episode.episodeNumber,
      ...(episode.episodeNumber === episodeNumber - 1 ? { excerpt: episode.summary } : {}),
    });
    sources.push(entry);
    if (episode.episodeNumber === episodeNumber - 1) {
      required.push(...items([episode.summary], [entry.key]));
    }
    if (!hasDetailedContinuity) {
      required.push(...items(episode.newFacts, [entry.key]));
    }
  }
  const liveThreads = new Map<string, WriteBriefItem>();
  const currentProps = new Map<string, WriteBriefItem>();
  for (const commit of pastCommits) {
    const entry = source('continuity', commit.id, `第 ${commit.episodeNumber} 集连续性交接`, commit, {
      revision: commit.revision, unitNumber: commit.episodeNumber,
      ...(commit.episodeNumber === episodeNumber - 1 ? { excerpt: commit.nextEpisodeMustInherit.join('；') } : {}),
    });
    sources.push(entry);
    required.push(...items(commit.factsAdded.map((fact) => fact.text), [entry.key]));
    if (commit.episodeNumber === episodeNumber - 1) required.push(...items(commit.nextEpisodeMustInherit, [entry.key]));
    for (const thread of commit.threads) {
      if (thread.action === 'closed') liveThreads.delete(thread.threadId);
      else if (thread.description.trim()) liveThreads.set(thread.threadId, { text: `待承接伏笔：${thread.description}`, sourceKeys: [entry.key] });
    }
    for (const prop of commit.props) {
      currentProps.set(prop.propId, { text: `道具 ${prop.name}：${prop.state}${prop.holderCharacterId ? `；持有人：${prop.holderCharacterId}` : ''}`, sourceKeys: [entry.key] });
    }
  }
  required.push(...liveThreads.values(), ...currentProps.values());
  const authorConstraints = items([
    plan.coreRequirements, plan.creativeRules?.writingInstructions,
    plan.creativeRules?.formatInstructions, plan.creativeRules?.qualityInstructions,
  ], [authorKey]);
  if (options.rewriteInstruction?.trim() || options.rewriteMode) {
    const instruction = options.rewriteInstruction?.trim() ?? '';
    const mode = options.rewriteMode ?? 'revise';
    const requestSource = source('request', `episode-${episodeNumber}:rewrite`, '本次作者修改要求', {
      instruction, mode,
    }, { unitNumber: episodeNumber, excerpt: instruction });
    sources.push(requestSource);
    authorConstraints.push(...items([
      mode === 'replace' ? '按当前分集卡重新创作完整一集。' : '在当前正文基础上执行本次修改。', instruction,
    ], [requestSource.key]));
  }
  const forbidden = items([...plan.forbiddenElements, ...(outline?.forbiddenFacts ?? [])], [planKey, outlineKey]);
  if (state.worldBible) {
    forbidden.push(...items(state.worldBible.forbiddenAnachronisms, [writeBriefSourceKey('world', state.worldBible.projectId)]));
    authorConstraints.push(...items(state.worldBible.rules, [writeBriefSourceKey('world', state.worldBible.projectId)]));
  }
  return createWriteBrief({
    mode: 'short_drama', projectId: state.projectId,
    target: { id: current?.id ?? `episode-${episodeNumber}`, unitNumber: episodeNumber, revision: current?.revision ?? 0, title: outline?.title ?? card!.title },
    objective: items([outline?.goal ?? card?.mainEvent, outline?.conflict, ...(outline?.beats ?? []), outline?.endingHook ?? card?.endingHook], [outlineKey]),
    required, forbidden, authorConstraints, sources,
  });
}

export function scriptWriteBriefRef(brief: WriteBrief): ScriptUpstreamArtifactRef {
  return { node: 'write_brief', artifactRevision: brief.schemaVersion, artifactHash: brief.fingerprint };
}

/** Request constraints are immutable per-run input, while persisted sources must be rebuilt. */
export function scriptWriteBriefSourcesCurrent(state: ScriptProjectState, brief: WriteBrief): boolean {
  try {
    const rebuilt = createWriteBrief(brief);
    if (rebuilt.fingerprint !== brief.fingerprint || rebuilt.sourceFingerprint !== brief.sourceFingerprint) return false;
  } catch { return false; }
  const current = buildScriptWriteBrief(state, brief.target.unitNumber);
  if (!current) return false;
  const persistent = (sources: WriteBriefSource[]) => sources.filter((item) => item.kind !== 'request')
    .map(({ key, kind, id, contentHash, revision, unitNumber }) => ({ key, kind, id, contentHash, revision, unitNumber }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return hashWriteBriefValue(persistent(brief.sources)) === hashWriteBriefValue(persistent(current.sources));
}

export function assertScriptWriteBriefCurrent(state: ScriptProjectState, brief: WriteBrief, expectedRevision: number): void {
  const current = state.episodes.find((episode) => episode.episodeNumber === brief.target.unitNumber);
  if (brief.mode !== 'short_drama' || brief.projectId !== state.projectId || brief.target.revision !== expectedRevision ||
      (current && current.id !== brief.target.id)) {
    throw new ScriptCommitConflictError('写作任务书与本次正文版本不匹配，请重新生成。');
  }
  if (!scriptWriteBriefSourcesCurrent(state, brief)) {
    throw new ScriptCommitConflictError('写作任务书的来源或作者约束已变化，请按最新资料重新生成。');
  }
}

export function scriptWriteBriefView(state: ScriptProjectState | undefined, episodeNumber: number): WriteBriefView {
  if (!state) return { status: 'unavailable', origin: 'preview', reason: '尚未创建短剧策划资料。' };
  const episode = state.episodes.find((item) => item.episodeNumber === episodeNumber);
  if (episode?.writeBrief) {
    const current = scriptWriteBriefSourcesCurrent(state, episode.writeBrief) &&
      computeScriptEpisodeCandidateHash(episode) === episode.writeBriefCandidateHash;
    return {
      status: current ? 'current' : 'stale', origin: 'generation', brief: episode.writeBrief,
      candidateHash: episode.writeBriefCandidateHash,
      ...(!current ? { reason: '正文或任务书来源已变化；这里保留的是上次生成实际使用的依据。' } : {}),
    };
  }
  const brief = buildScriptWriteBrief(state, episodeNumber);
  return brief ? { status: 'current', origin: 'preview', brief }
    : { status: 'unavailable', origin: 'preview', reason: '请先保存策划和本集大纲或分集卡。' };
}
