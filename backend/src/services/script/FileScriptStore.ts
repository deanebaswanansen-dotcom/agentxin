import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { getCurrentClientId } from '../client/clientScope.js';
import { StoreError } from '../../store/StoreError.js';
import type {
  ScriptCharacter,
  ScriptCommitEpisodeWithContinuityInput,
  ScriptCommitEpisodeWithContinuityResult,
  ScriptContinuityState,
  ScriptEpisode,
  ScriptEpisodeContinuityCommit,
  ScriptEpisodeContinuityCommitInput,
  ScriptEpisodeOutline,
  ScriptPlan,
  ScriptProjectState,
  ScriptReviewIssue,
  ScriptReviewIssueCollection,
  ScriptReviewSource,
  ScriptSeriesOutline,
  ScriptWorldBible,
} from './domain.js';
import {
  assertExpectedRevision,
  computeScriptEpisodeCandidateHash,
  computeScriptInputFingerprint,
  ScriptCommitConflictError,
  type ScriptStore,
} from './ScriptStore.js';
import { currentScriptContinuityCommits } from './ScriptContinuityCommit.js';
import { isBlockingScriptReviewIssue } from './quality/ScriptQualityGates.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RENAME_DELAYS_MS = [5, 15, 35, 75, 150, 300] as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyState(projectId: string): ScriptProjectState {
  return {
    schemaVersion: 1,
    projectId,
    characters: [],
    episodeOutlines: [],
    episodes: [],
    continuityCommits: [],
    continuity: {
      currentState: [],
      openThreads: [],
      wardrobeLedger: [],
    },
    reviewRevision: 0,
    reviewIssues: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeState(value: unknown, projectId: string): ScriptProjectState {
  if (typeof value !== 'object' || value === null) {
    throw new StoreError(`短剧项目文件格式无效: ${projectId}`);
  }
  const input = value as Partial<ScriptProjectState>;
  if (input.schemaVersion !== 1) {
    throw new StoreError(`不支持的短剧存储版本: ${String(input.schemaVersion)}`);
  }
  if (input.projectId !== undefined && input.projectId !== projectId) {
    throw new StoreError(`短剧项目标识与文件名不一致: ${projectId}`);
  }
  const continuity = input.continuity;
  const episodes = Array.isArray(input.episodes) ? clone(input.episodes) : [];
  const continuityCommits = normalizeContinuityCommits(
    input.continuityCommits,
    projectId,
    episodes,
  );
  return {
    schemaVersion: 1,
    projectId,
    ...(input.plan ? { plan: clone(input.plan) } : {}),
    characters: Array.isArray(input.characters) ? clone(input.characters) : [],
    ...(input.worldBible ? { worldBible: clone(input.worldBible) } : {}),
    ...(input.seriesOutline ? { seriesOutline: clone(input.seriesOutline) } : {}),
    episodeOutlines: Array.isArray(input.episodeOutlines)
      ? clone(input.episodeOutlines)
      : [],
    episodes,
    continuityCommits,
    continuity: {
      currentState: Array.isArray(continuity?.currentState)
        ? clone(continuity.currentState)
        : [],
      openThreads: Array.isArray(continuity?.openThreads)
        ? clone(continuity.openThreads)
        : [],
      wardrobeLedger: Array.isArray(continuity?.wardrobeLedger)
        ? clone(continuity.wardrobeLedger)
        : [],
    },
    reviewRevision:
      Number.isInteger(input.reviewRevision) && (input.reviewRevision as number) >= 0
        ? (input.reviewRevision as number)
        : 0,
    reviewIssues: Array.isArray(input.reviewIssues)
      ? clone(input.reviewIssues).map((item) => ({ ...item, projectId }))
      : [],
    updatedAt:
      typeof input.updatedAt === 'string'
        ? input.updatedAt
        : new Date(0).toISOString(),
  };
}

function normalizeContinuityCommits(
  value: unknown,
  projectId: string,
  episodes: ScriptEpisode[],
): ScriptEpisodeContinuityCommit[] {
  if (!Array.isArray(value)) return [];
  const episodeByNumber = new Map(episodes.map((episode) => [episode.episodeNumber, episode]));
  const commits = clone(value) as ScriptEpisodeContinuityCommit[];
  for (const commit of commits) {
    if (commit.schemaVersion !== 1) {
      throw new StoreError(
        `不支持的短剧连续性存储版本: ${String(commit.schemaVersion)}`,
      );
    }
    commit.projectId = projectId;
    const episode = episodeByNumber.get(commit.episodeNumber);
    if (
      commit.status === 'current' &&
      (episode?.status !== 'completed' || episode.revision !== commit.episodeRevision)
    ) {
      commit.status = 'stale';
    }
  }
  const currentByEpisode = new Map<number, ScriptEpisodeContinuityCommit>();
  for (const commit of commits) {
    if (commit.status !== 'current') continue;
    const previous = currentByEpisode.get(commit.episodeNumber);
    if (!previous || commit.revision > previous.revision) {
      if (previous) previous.status = 'stale';
      currentByEpisode.set(commit.episodeNumber, commit);
    } else {
      commit.status = 'stale';
    }
  }
  return commits.sort((left, right) =>
    left.revision - right.revision || left.episodeNumber - right.episodeNumber,
  );
}

function resourceRevision(
  state: ScriptProjectState,
  resource: ScriptCommitEpisodeWithContinuityInput['inputRevisionRefs'][number]['resource'],
  id: string,
): number {
  switch (resource) {
    case 'plan':
      return state.plan?.id === id ? state.plan.revision : 0;
    case 'outline': {
      const episodeOutline = state.episodeOutlines.find((item) => item.id === id);
      if (episodeOutline) return episodeOutline.revision;
      return state.seriesOutline?.projectId === id ? state.seriesOutline.revision : 0;
    }
    case 'characters': {
      const character = state.characters.find((item) => item.id === id);
      if (character) return character.revision;
      return id === state.projectId
        ? Math.max(0, ...state.characters.map((item) => item.revision))
        : 0;
    }
    case 'world':
      return state.worldBible?.projectId === id ? state.worldBible.revision : 0;
    case 'episode':
      return state.episodes.find((item) => item.id === id)?.revision ?? 0;
    case 'continuity':
      return state.continuityCommits?.find((item) => item.id === id)?.revision ?? 0;
  }
}

function staleCurrentContinuityCommit(
  state: ScriptProjectState,
  episodeNumber: number,
  updatedAt: string,
): void {
  for (const commit of state.continuityCommits ?? []) {
    if (commit.episodeNumber === episodeNumber && commit.status === 'current') {
      commit.status = 'stale';
      commit.updatedAt = updatedAt;
    }
  }
}

function previousEpisodeContinuityCommit(
  state: ScriptProjectState,
  episodeNumber: number,
): ScriptEpisodeContinuityCommit | undefined {
  if (episodeNumber <= 1) return undefined;
  const previousEpisode = state.episodes.find(
    (episode) => episode.episodeNumber === episodeNumber - 1,
  );
  if (!previousEpisode || previousEpisode.status !== 'completed') {
    throw new ScriptCommitConflictError(
      `第 ${episodeNumber} 集提交前，第 ${episodeNumber - 1} 集必须处于已完成状态。`,
    );
  }
  const previous = currentScriptContinuityCommits(state).find(
    (commit) => commit.episodeNumber === previousEpisode.episodeNumber,
  );
  if (!previous) {
    throw new ScriptCommitConflictError(
      `第 ${episodeNumber - 1} 集缺少与最新正文版本匹配的连续性提交（完整链）。`,
    );
  }
  return previous;
}

function assertUniqueContinuityIds<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  label: string,
): void {
  const ids = new Set<string>();
  for (const item of items) {
    const id = idOf(item).trim();
    if (!id) {
      throw new ScriptCommitConflictError(`${label} ID 不能为空。`);
    }
    if (ids.has(id)) {
      throw new ScriptCommitConflictError(`${label} ID 在同一连续性提交中必须唯一: ${id}`);
    }
    ids.add(id);
  }
}

function validateContinuityCandidate(
  state: ScriptProjectState,
  episode: ScriptEpisode,
  continuity: ScriptEpisodeContinuityCommitInput,
): void {
  const blockIds = new Set(
    episode.scenes.flatMap((scene) => scene.blocks.map((block) => block.id)),
  );
  const registeredCharacterIds = new Set(state.characters.map((character) => character.id));

  for (const update of continuity.characterUpdates) {
    if (!registeredCharacterIds.has(update.characterId)) {
      throw new ScriptCommitConflictError(
        `连续性人物更新引用了未登记人物: ${update.characterId}`,
      );
    }
  }
  for (const prop of continuity.props) {
    if (
      prop.holderCharacterId !== undefined &&
      !registeredCharacterIds.has(prop.holderCharacterId)
    ) {
      throw new ScriptCommitConflictError(
        `连续性道具持有人未登记: ${prop.holderCharacterId}`,
      );
    }
  }

  assertUniqueContinuityIds(continuity.factsAdded, (fact) => fact.factId, '事实');
  assertUniqueContinuityIds(continuity.props, (prop) => prop.propId, '道具');
  assertUniqueContinuityIds(continuity.threads, (thread) => thread.threadId, '伏笔');
  assertUniqueContinuityIds(continuity.timelineEvents, (event) => event.eventId, '时间事件');

  const evidenceOwners = [
    ...continuity.factsAdded.map((item) => ({
      label: `事实 ${item.factId}`,
      evidenceBlockIds: item.evidenceBlockIds,
    })),
    ...continuity.props.map((item) => ({
      label: `道具 ${item.propId}`,
      evidenceBlockIds: item.evidenceBlockIds,
    })),
    ...continuity.threads.map((item) => ({
      label: `伏笔 ${item.threadId}`,
      evidenceBlockIds: item.evidenceBlockIds,
    })),
    ...continuity.timelineEvents.map((item) => ({
      label: `时间事件 ${item.eventId}`,
      evidenceBlockIds: item.evidenceBlockIds,
    })),
  ];
  for (const owner of evidenceOwners) {
    for (const blockId of owner.evidenceBlockIds) {
      if (!blockIds.has(blockId)) {
        throw new ScriptCommitConflictError(
          `${owner.label} 引用了不属于候选正文的证据块: ${blockId}`,
        );
      }
    }
  }

  const resolvableEventIds = new Set(
    currentScriptContinuityCommits(state)
      .filter((commit) => commit.episodeNumber < episode.episodeNumber)
      .flatMap((commit) => commit.timelineEvents.map((event) => event.eventId)),
  );
  for (const event of continuity.timelineEvents) resolvableEventIds.add(event.eventId);
  for (const event of continuity.timelineEvents) {
    for (const causeEventId of event.causeEventIds) {
      if (!resolvableEventIds.has(causeEventId)) {
        throw new ScriptCommitConflictError(
          `时间事件 ${event.eventId} 引用了无法解析的原因事件: ${causeEventId}`,
        );
      }
    }
  }
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isTransientRenameError(error: unknown): boolean {
  return (
    isErrno(error) &&
    ['EPERM', 'EBUSY', 'EACCES', 'EEXIST', 'ENOTEMPTY'].includes(error.code ?? '')
  );
}

async function renameWithRetry(tempPath: string, targetPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempPath, targetPath);
      return;
    } catch (error) {
      if (attempt >= RENAME_DELAYS_MS.length || !isTransientRenameError(error)) throw error;
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, RENAME_DELAYS_MS[attempt]);
      });
    }
  }
}

/** One file per project. A FileScriptStore instance represents one client library. */
export class FileScriptStore implements ScriptStore {
  private readonly rootDirectory: string;
  private readonly loaded = new Set<string>();
  private readonly states = new Map<string, ScriptProjectState | undefined>();
  private readonly mutationQueues = new Map<string, Promise<void>>();

  private constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  static async create(rootDirectory: string): Promise<FileScriptStore> {
    await mkdir(resolve(rootDirectory), { recursive: true });
    return new FileScriptStore(rootDirectory);
  }

  private filePath(projectId: string): string {
    if (!SAFE_ID.test(projectId)) {
      throw new StoreError(`短剧项目标识格式无效: ${projectId}`);
    }
    return join(this.rootDirectory, `${projectId}.json`);
  }

  private async load(projectId: string): Promise<ScriptProjectState | undefined> {
    if (this.loaded.has(projectId)) return this.states.get(projectId);
    const filePath = this.filePath(projectId);
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      const state = normalizeState(parsed, projectId);
      this.states.set(projectId, state);
      this.loaded.add(projectId);
      return state;
    } catch (error) {
      if (isErrno(error) && error.code === 'ENOENT') {
        this.states.set(projectId, undefined);
        this.loaded.add(projectId);
        return undefined;
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError(`读取短剧项目失败: ${projectId}`, { cause: error });
    }
  }

  private async persist(state: ScriptProjectState): Promise<void> {
    const filePath = this.filePath(state.projectId);
    const tempPath = `${filePath}.tmp-${randomUUID()}`;
    try {
      await mkdir(this.rootDirectory, { recursive: true });
      await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
      await renameWithRetry(tempPath, filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw new StoreError(`写入短剧项目失败: ${state.projectId}`, { cause: error });
    }
  }

  private mutate<T>(
    projectId: string,
    operation: (state: ScriptProjectState) => Promise<T> | T,
  ): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    });
    const previous = this.mutationQueues.get(projectId) ?? Promise.resolve();
    const run = async (): Promise<void> => {
      try {
        const current = (await this.load(projectId)) ?? emptyState(projectId);
        const working = clone(current);
        const value = await operation(working);
        working.updatedAt = new Date().toISOString();
        await this.persist(working);
        this.states.set(projectId, working);
        this.loaded.add(projectId);
        resolveResult(clone(value));
      } catch (error) {
        rejectResult(error);
      }
    };
    const queued = previous.then(run, run);
    this.mutationQueues.set(projectId, queued);
    void queued.finally(() => {
      if (this.mutationQueues.get(projectId) === queued) this.mutationQueues.delete(projectId);
    });
    return result;
  }

  async getProjectState(projectId: string): Promise<ScriptProjectState | undefined> {
    const queued = this.mutationQueues.get(projectId);
    if (queued) await queued;
    const state = await this.load(projectId);
    return state ? clone(state) : undefined;
  }

  savePlan(plan: ScriptPlan, expectedRevision?: number): Promise<ScriptPlan> {
    return this.mutate(plan.projectId, (state) => {
      const currentRevision = state.plan?.revision ?? 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const saved: ScriptPlan = {
        ...clone(plan),
        revision: currentRevision + 1,
        createdAt: state.plan?.createdAt ?? plan.createdAt,
        updatedAt: new Date().toISOString(),
      };
      state.plan = saved;
      return saved;
    });
  }

  saveCharacters(
    projectId: string,
    items: ScriptCharacter[],
    expectedRevision?: number,
  ): Promise<ScriptCharacter[]> {
    return this.mutate(projectId, (state) => {
      const currentRevision = Math.max(0, ...state.characters.map((item) => item.revision));
      assertExpectedRevision(expectedRevision, currentRevision);
      const updatedAt = new Date().toISOString();
      const saved = clone(items).map((item) => ({
        ...item,
        projectId,
        revision: currentRevision + 1,
        updatedAt,
      }));
      state.characters = saved;
      return saved;
    });
  }

  saveWorldBible(
    value: ScriptWorldBible,
    expectedRevision?: number,
  ): Promise<ScriptWorldBible> {
    return this.mutate(value.projectId, (state) => {
      const currentRevision = state.worldBible?.revision ?? 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const saved = {
        ...clone(value),
        revision: currentRevision + 1,
        updatedAt: new Date().toISOString(),
      };
      state.worldBible = saved;
      return saved;
    });
  }

  saveSeriesOutline(
    value: ScriptSeriesOutline,
    expectedRevision?: number,
  ): Promise<ScriptSeriesOutline> {
    return this.mutate(value.projectId, (state) => {
      const currentRevision = state.seriesOutline?.revision ?? 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const saved = { ...clone(value), revision: currentRevision + 1 };
      state.seriesOutline = saved;
      return saved;
    });
  }

  saveEpisodeOutline(
    value: ScriptEpisodeOutline,
    expectedRevision?: number,
  ): Promise<ScriptEpisodeOutline> {
    return this.mutate(value.projectId, (state) => {
      const index = state.episodeOutlines.findIndex(
        (item) => item.episodeNumber === value.episodeNumber,
      );
      const currentRevision = index >= 0 ? state.episodeOutlines[index]!.revision : 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const saved = { ...clone(value), revision: currentRevision + 1 };
      if (index >= 0) state.episodeOutlines[index] = saved;
      else state.episodeOutlines.push(saved);
      state.episodeOutlines.sort((a, b) => a.episodeNumber - b.episodeNumber);
      return saved;
    });
  }

  saveEpisode(
    value: ScriptEpisode,
    expectedRevision?: number,
  ): Promise<ScriptEpisode> {
    return this.mutate(value.projectId, (state) => {
      const index = state.episodes.findIndex(
        (item) => item.episodeNumber === value.episodeNumber,
      );
      const current = index >= 0 ? state.episodes[index] : undefined;
      const currentRevision = current?.revision ?? 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const updatedAt = new Date().toISOString();
      const editedCompletedEpisode = current?.status === 'completed';
      const saved: ScriptEpisode = {
        ...clone(value),
        // A completed Episode and its continuity commit are one canonical
        // boundary. Any later edit must be reviewed and recommitted together.
        status: editedCompletedEpisode ? 'reviewing' : value.status,
        revision: currentRevision + 1,
        createdAt: current?.createdAt ?? value.createdAt,
        updatedAt,
      };
      if (editedCompletedEpisode) {
        staleCurrentContinuityCommit(state, value.episodeNumber, updatedAt);
      }
      if (index >= 0) state.episodes[index] = saved;
      else state.episodes.push(saved);
      state.episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
      return saved;
    });
  }

  commitEpisodeWithContinuity(
    input: ScriptCommitEpisodeWithContinuityInput,
  ): Promise<ScriptCommitEpisodeWithContinuityResult> {
    const projectId = input.episode.projectId;
    return this.mutate(projectId, (state) => {
      const episodeIndex = state.episodes.findIndex(
        (item) => item.episodeNumber === input.episode.episodeNumber,
      );
      const currentEpisode = episodeIndex >= 0 ? state.episodes[episodeIndex] : undefined;
      const currentEpisodeRevision = currentEpisode?.revision ?? 0;
      assertExpectedRevision(input.expectedEpisodeRevision, currentEpisodeRevision);
      assertExpectedRevision(input.expectedReviewRevision, state.reviewRevision);
      if (state.reviewIssues.some((issue) =>
        issue.episodeNumber === input.episode.episodeNumber && isBlockingScriptReviewIssue(issue)
      )) {
        throw new ScriptCommitConflictError(
          `第 ${input.episode.episodeNumber} 集仍有未解决的硬性校稿问题。`,
        );
      }

      if (input.episode.projectId !== state.projectId) {
        throw new ScriptCommitConflictError('候选正文与短剧项目不一致。');
      }
      const previous = previousEpisodeContinuityCommit(
        state,
        input.episode.episodeNumber,
      );
      for (const reference of input.inputRevisionRefs) {
        assertExpectedRevision(
          reference.revision,
          resourceRevision(state, reference.resource, reference.id),
        );
      }

      const candidateHash = computeScriptEpisodeCandidateHash(input.episode);
      if (candidateHash !== input.candidateHash) {
        throw new ScriptCommitConflictError(
          '候选正文哈希不匹配，拒绝提交可能已被替换的正文。',
        );
      }
      const inputFingerprint = computeScriptInputFingerprint(input);
      if (inputFingerprint !== input.inputFingerprint) {
        throw new ScriptCommitConflictError('候选输入指纹不匹配，拒绝提交过期正文。');
      }
      validateContinuityCandidate(state, input.episode, input.continuity);

      const updatedAt = new Date().toISOString();
      const episode: ScriptEpisode = {
        ...clone(input.episode),
        projectId,
        status: 'completed',
        revision: currentEpisodeRevision + 1,
        createdAt: currentEpisode?.createdAt ?? input.episode.createdAt,
        updatedAt,
      };

      staleCurrentContinuityCommit(state, episode.episodeNumber, updatedAt);
      const continuityCommits = state.continuityCommits ??= [];
      const revision = Math.max(
        0,
        ...continuityCommits.map((commit) => commit.revision),
      ) + 1;
      const continuity: ScriptEpisodeContinuityCommit = {
        ...clone(input.continuity),
        id: randomUUID(),
        schemaVersion: 1,
        projectId,
        episodeNumber: episode.episodeNumber,
        episodeRevision: episode.revision,
        revision,
        status: 'current',
        inputFingerprint,
        ...(previous
          ? {
              previousContinuityCommitId: previous.id,
              previousContinuityRevision: previous.revision,
            }
          : {}),
        createdAt: updatedAt,
        updatedAt,
      };

      if (episodeIndex >= 0) state.episodes[episodeIndex] = episode;
      else state.episodes.push(episode);
      state.episodes.sort((left, right) => left.episodeNumber - right.episodeNumber);
      continuityCommits.push(continuity);
      continuityCommits.sort((left, right) =>
        left.revision - right.revision || left.episodeNumber - right.episodeNumber,
      );
      return { episode, continuity };
    });
  }

  saveContinuity(
    projectId: string,
    value: ScriptContinuityState,
  ): Promise<ScriptContinuityState> {
    return this.mutate(projectId, (state) => {
      const saved = clone(value);
      state.continuity = saved;
      return saved;
    });
  }

  saveReviewIssues(
    projectId: string,
    items: ScriptReviewIssue[],
    expectedRevision?: number,
  ): Promise<ScriptReviewIssueCollection> {
    return this.mutate(projectId, (state) => {
      assertExpectedRevision(expectedRevision, state.reviewRevision);
      const revision = state.reviewRevision + 1;
      const saved = clone(items)
        .map((item) => ({ ...item, projectId }))
        .sort((left, right) =>
          left.episodeNumber - right.episodeNumber || left.createdAt.localeCompare(right.createdAt),
        );
      state.reviewRevision = revision;
      state.reviewIssues = saved;
      return { revision, items: saved };
    });
  }

  replaceEpisodeReviewIssues(
    projectId: string,
    episodeNumber: number,
    sources: readonly ScriptReviewSource[],
    items: ScriptReviewIssue[],
    expectedRevision?: number,
  ): Promise<ScriptReviewIssueCollection> {
    return this.mutate(projectId, (state) => {
      assertExpectedRevision(expectedRevision, state.reviewRevision);
      const replacedSources = new Set(sources);
      const retained = state.reviewIssues.filter(
        (item) => item.episodeNumber !== episodeNumber || !replacedSources.has(item.source),
      );
      const existing = state.reviewIssues.filter(
        (item) => item.episodeNumber === episodeNumber && replacedSources.has(item.source),
      );
      const fingerprint = (item: ScriptReviewIssue): string =>
        [item.source, item.code, item.sceneId ?? '', item.blockId ?? '', item.path ?? ''].join('\u0000');
      const existingByFingerprint = new Map<string, ScriptReviewIssue[]>();
      for (const item of existing) {
        const key = fingerprint(item);
        existingByFingerprint.set(key, [...(existingByFingerprint.get(key) ?? []), item]);
      }
      const usedIds = new Set(retained.map((item) => item.id));
      const replacements = clone(items).map((item) => {
        const previous = existingByFingerprint.get(fingerprint(item))?.shift();
        let id = previous?.id ?? item.id;
        if (usedIds.has(id)) id = randomUUID();
        usedIds.add(id);
        return {
          ...item,
          id,
          projectId,
          status: previous?.status === 'ignored' && !isBlockingScriptReviewIssue(item)
            ? 'ignored' as const
            : item.status,
          createdAt: previous?.createdAt ?? item.createdAt,
        };
      });
      const saved = [...retained, ...replacements].sort((left, right) =>
        left.episodeNumber - right.episodeNumber || left.createdAt.localeCompare(right.createdAt),
      );
      const revision = state.reviewRevision + 1;
      state.reviewRevision = revision;
      state.reviewIssues = saved;
      return { revision, items: saved };
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    const previous = this.mutationQueues.get(projectId) ?? Promise.resolve();
    const run = async (): Promise<void> => {
      try {
        await unlink(this.filePath(projectId));
      } catch (error) {
        if (!(isErrno(error) && error.code === 'ENOENT')) {
          throw new StoreError(`删除短剧项目失败: ${projectId}`, { cause: error });
        }
      }
      this.states.set(projectId, undefined);
      this.loaded.add(projectId);
    };
    const queued = previous.then(run, run);
    this.mutationQueues.set(projectId, queued);
    try {
      await queued;
    } finally {
      if (this.mutationQueues.get(projectId) === queued) this.mutationQueues.delete(projectId);
    }
  }
}

/** Lazily supplies one FileScriptStore per validated browser client id. */
export function createClientScopedScriptStore(rootDirectory: string): ScriptStore {
  const root = resolve(rootDirectory);
  const stores = new Map<string, Promise<FileScriptStore>>();

  function currentStore(): Promise<FileScriptStore> {
    const clientId = getCurrentClientId();
    let store = stores.get(clientId);
    if (!store) {
      store = FileScriptStore.create(join(root, clientId));
      stores.set(clientId, store);
    }
    return store;
  }

  return new Proxy({} as ScriptStore, {
    get(_target, property) {
      if (property === 'then' || typeof property !== 'string') return undefined;
      return async (...args: unknown[]) => {
        const store = await currentStore();
        const method = Reflect.get(store, property) as unknown;
        if (typeof method !== 'function') {
          throw new TypeError(`Unknown ScriptStore method: ${property}`);
        }
        return Reflect.apply(method, store, args) as unknown;
      };
    },
  });
}
