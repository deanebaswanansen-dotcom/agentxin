import { createHash, randomUUID } from 'node:crypto';

import { StoreError } from '../../store/StoreError.js';
import type {
  ScriptBatchSummary,
  ScriptCharacter,
  ScriptEpisode,
  ScriptEpisodeOutline,
  ScriptEpisodeSummary,
  ScriptExportFormat,
  ScriptPlan,
  ScriptProjectState,
  ScriptReviewCategory,
  ScriptReviewIssue,
  ScriptReviewIssueCollection,
  ScriptReviewIssueInput,
  ScriptReviewIssueUpdateResult,
  ScriptReviewSeverity,
  ScriptReviewSource,
  ScriptReviewStatus,
  ScriptSeriesOutline,
  ScriptWorldBible,
  ScriptWorkspaceSnapshot,
} from './domain.js';
import {
  decodeScriptCharacterInputs,
  decodeScriptEpisodeInput,
  decodeScriptEpisodeOutlineInput,
  decodeScriptPlanInput,
  decodeScriptSeriesOutlineInput,
  decodeScriptWorldBibleInput,
  validateScriptCharacterSet,
  validateScriptEpisodeInput,
  validateScriptEpisodeOutlineInput,
  validateScriptSeriesOutlineInput,
} from './ScriptCanonicalInput.js';
import {
  buildScriptAtomicCommitInput,
  buildScriptContinuityCandidate,
  currentScriptContinuityCommits,
  projectScriptContinuity,
} from './ScriptContinuityCommit.js';
import { serializeChineseShortDrama } from './serializers/chineseShortDrama.js';
import { serializeScriptMarkdown } from './serializers/markdown.js';
import { serializeFountain } from './serializers/fountain.js';
import { ScriptConflictError, type ScriptStore } from './ScriptStore.js';
import { ScriptServiceError } from './ScriptServiceError.js';
import {
  collectTemporaryDialogueSpeakers,
  createScriptReviewIssues,
  isBlockingScriptReviewIssue,
  type ScriptGateReport,
  validateScriptEpisode,
} from './quality/ScriptQualityGates.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REVIEW_SEVERITIES = ['hard', 'soft', 'suggestion'] as const;
const REVIEW_STATUSES = ['open', 'fixed', 'ignored'] as const;
const REVIEW_SOURCES = ['deterministic', 'ai', 'user'] as const;
const REVIEW_CATEGORIES = [
  'format',
  'continuity',
  'logic',
  'dialogue',
  'character',
  'pacing',
  'spelling',
  'hook',
] as const;
const DETERMINISTIC_REVIEW_CONFIG_FINGERPRINT = createHash('sha256')
  .update('agentxin:deterministic-script-review:v1', 'utf8')
  .digest('hex');

export { ScriptServiceError };
export type { ScriptServiceErrorCode } from './ScriptServiceError.js';

export interface ScriptServiceOptions {
  projectLookup?: (
    projectId: string,
  ) => Promise<{ kind?: 'novel' | 'short_drama' } | undefined>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw ScriptServiceError.validation(`${label}必须是对象`);
  }
  return value as UnknownRecord;
}

function stringValue(value: unknown, label: string, max = 20_000): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ScriptServiceError.validation(`${label}不能为空`);
  }
  if (value.length > max) throw ScriptServiceError.validation(`${label}超过${max}个字符`);
  return value;
}

function optionalString(value: unknown, label: string, max = 20_000): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw ScriptServiceError.validation(`${label}必须是字符串`);
  if (value.length > max) throw ScriptServiceError.validation(`${label}超过${max}个字符`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw ScriptServiceError.validation(`${label}必须是${min}到${max}的整数`);
  }
  return value as number;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw ScriptServiceError.validation(`${label}的值无效`);
  }
  return value as T[number];
}

function optionalId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return idValue(value, 'id');
}

function idValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw ScriptServiceError.validation(`${label}格式无效`);
  }
  return value;
}

export interface ScriptEpisodeReviewResult extends ScriptReviewIssueCollection {
  report: ScriptGateReport;
}

function parseReviewIssue(value: unknown, index: number): ScriptReviewIssueInput {
  const input = record(value, `第${index + 1}条校稿问题`);
  const sceneId = optionalId(input.sceneId);
  const blockId = optionalId(input.blockId);
  const path = optionalString(input.path, '问题路径', 500);
  const suggestion = optionalString(input.suggestion, '修改建议', 4_000);
  return {
    ...(optionalId(input.id) ? { id: optionalId(input.id) } : {}),
    episodeNumber: integer(input.episodeNumber, '问题集号', 1, 200),
    ...(sceneId ? { sceneId } : {}),
    ...(blockId ? { blockId } : {}),
    ...(path !== undefined ? { path } : {}),
    code: stringValue(input.code, '问题代码', 100),
    severity: enumValue(input.severity, '问题严重度', REVIEW_SEVERITIES) as ScriptReviewSeverity,
    category: enumValue(input.category, '问题分类', REVIEW_CATEGORIES) as ScriptReviewCategory,
    message: stringValue(input.message, '问题描述', 4_000),
    ...(suggestion !== undefined ? { suggestion } : {}),
    status: enumValue(input.status ?? 'open', '问题状态', REVIEW_STATUSES) as ScriptReviewStatus,
    source: enumValue(input.source ?? 'user', '问题来源', REVIEW_SOURCES) as ScriptReviewSource,
  };
}

function parseReviewIssues(value: unknown): ScriptReviewIssueInput[] {
  if (!Array.isArray(value)) throw ScriptServiceError.validation('校稿问题必须是数组');
  if (value.length > 5_000) throw ScriptServiceError.validation('校稿问题不能超过5000条');
  const parsed = value.map(parseReviewIssue);
  if (parsed.some((item) =>
    item.severity === 'hard' && item.source !== 'ai' && item.status === 'ignored')) {
    throw ScriptServiceError.validation('阻断性校稿问题不能标记为已忽略');
  }
  const suppliedIds = parsed.flatMap((item) => item.id ? [item.id] : []);
  if (new Set(suppliedIds).size !== suppliedIds.length) {
    throw ScriptServiceError.validation('校稿问题 id 不能重复');
  }
  return parsed;
}

function currentRevision(items: Array<{ revision: number }>): number {
  return Math.max(0, ...items.map((item) => item.revision));
}

export function countScriptVisibleChars(episode: ScriptEpisode): number {
  return episode.scenes.reduce(
    (total, scene) => total + scene.blocks.reduce((sum, block) => sum + block.text.replace(/\s/gu, '').length, 0),
    0,
  );
}

function episodeSummaries(state: ScriptProjectState | undefined): ScriptEpisodeSummary[] {
  return (state?.episodes ?? [])
    .map((episode) => ({
      id: episode.id,
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      status: episode.status,
      targetChars: episode.targetChars,
      visibleChars: countScriptVisibleChars(episode),
      sceneCount: episode.scenes.length,
      revision: episode.revision,
      updatedAt: episode.updatedAt,
    }))
    .sort((left, right) => left.episodeNumber - right.episodeNumber);
}

function batchSummaries(
  state: ScriptProjectState | undefined,
  summaries: readonly ScriptEpisodeSummary[],
): ScriptBatchSummary[] {
  const highestKnownEpisode = Math.max(
    0,
    ...summaries.map((item) => item.episodeNumber),
    ...(state?.episodeOutlines ?? []).map((item) => item.episodeNumber),
  );
  const totalEpisodes = state?.plan?.totalEpisodes ?? highestKnownEpisode;
  const frontMatterReady = Boolean(
    state?.plan &&
    state.plan.status !== 'draft' &&
    state.characters.length > 0 &&
    state.worldBible &&
    state.seriesOutline,
  );
  const outlinedEpisodes = new Set(
    (state?.seriesOutline?.episodeCards ?? []).map((card) => card.episodeNumber),
  );
  const result: ScriptBatchSummary[] = [];
  for (let startEpisode = 1; startEpisode <= totalEpisodes; startEpisode += 5) {
    const endEpisode = Math.min(startEpisode + 4, totalEpisodes);
    const episodes = summaries.filter(
      (item) => item.episodeNumber >= startEpisode && item.episodeNumber <= endEpisode,
    );
    const unresolved = (state?.reviewIssues ?? []).filter(
      (item) =>
        item.status === 'open' &&
        item.episodeNumber >= startEpisode &&
        item.episodeNumber <= endEpisode,
    );
    const unresolvedHardIssues = unresolved.filter(isBlockingScriptReviewIssue).length;
    const unresolvedSoftIssues = unresolved.length - unresolvedHardIssues;
    const completedEpisodes = episodes.filter((item) => item.status === 'completed').length;
    const batchSize = endEpisode - startEpisode + 1;
    const batchOutlineReady = frontMatterReady && Array.from(
      { length: batchSize },
      (_, index) => startEpisode + index,
    ).every((episodeNumber) => outlinedEpisodes.has(episodeNumber));
    let status: ScriptBatchSummary['status'];
    if (episodes.some((item) => item.status === 'generating')) status = 'generating';
    else if (episodes.some((item) => item.status === 'failed') || unresolvedHardIssues > 0) status = 'failed';
    else if (
      episodes.some((item) => item.status === 'reviewing') ||
      unresolvedSoftIssues > 0
    ) status = 'proofreading';
    else if (completedEpisodes === batchSize) status = 'completed';
    else status = batchOutlineReady ? 'ready' : 'blocked';
    result.push({
      startEpisode,
      endEpisode,
      status,
      completedEpisodes,
      visibleChars: episodes.reduce((sum, item) => sum + item.visibleChars, 0),
      unresolvedHardIssues,
      unresolvedSoftIssues,
    });
  }
  return result;
}

export class ScriptService {
  constructor(
    private readonly store: ScriptStore,
    private readonly options: ScriptServiceOptions = {},
  ) {}

  private async assertProject(projectId: string): Promise<void> {
    idValue(projectId, '项目 id');
    if (!this.options.projectLookup) return;
    const project = await this.options.projectLookup(projectId);
    if (!project) throw ScriptServiceError.notFound(`项目不存在: ${projectId}`);
    if (project.kind !== undefined && project.kind !== 'short_drama') {
      throw ScriptServiceError.validation('该项目不是短剧项目');
    }
  }

  async getState(projectId: string): Promise<ScriptProjectState | undefined> {
    await this.assertProject(projectId);
    return this.store.getProjectState(projectId);
  }

  async getWorkspace(projectId: string): Promise<ScriptWorkspaceSnapshot> {
    await this.assertProject(projectId);
    const state = await this.store.getProjectState(projectId);
    const summaries = episodeSummaries(state);
    return {
      schemaVersion: 1,
      projectId,
      ...(state?.plan ? { plan: state.plan } : {}),
      ...(state?.seriesOutline ? { outline: state.seriesOutline } : {}),
      characters: state?.characters ?? [],
      ...(state?.worldBible ? { worldBible: state.worldBible } : {}),
      episodeSummaries: summaries,
      batchSummaries: batchSummaries(state, summaries),
      reviewRevision: state?.reviewRevision ?? 0,
      reviewIssues: state?.reviewIssues ?? [],
      updatedAt: state?.updatedAt ?? new Date(0).toISOString(),
    };
  }

  private async requireState(projectId: string): Promise<ScriptProjectState> {
    const state = await this.getState(projectId);
    if (!state) throw ScriptServiceError.notFound('短剧项目资料尚未创建');
    return state;
  }

  async getPlan(projectId: string): Promise<ScriptPlan> {
    const plan = (await this.requireState(projectId)).plan;
    if (!plan) throw ScriptServiceError.notFound('剧本策划尚未创建');
    return plan;
  }

  async savePlan(projectId: string, value: unknown, expectedRevision: number): Promise<ScriptPlan> {
    await this.assertProject(projectId);
    const input = decodeScriptPlanInput(value);
    const state = await this.store.getProjectState(projectId);
    const current = state?.plan;
    const highestPersistedEpisode = Math.max(
      0,
      ...(state?.episodes ?? []).map((episode) => episode.episodeNumber),
      ...(state?.episodeOutlines ?? []).map((outline) => outline.episodeNumber),
    );
    if (input.totalEpisodes < highestPersistedEpisode) {
      throw ScriptServiceError.validation(
        `总集数不能少于已保存的第${highestPersistedEpisode}集正文或详细大纲；本次修改未保存，也不会删除已有内容。`,
        {
          requestedTotalEpisodes: input.totalEpisodes,
          minimumTotalEpisodes: highestPersistedEpisode,
        },
      );
    }
    const now = new Date().toISOString();
    const plan: ScriptPlan = {
      ...input,
      id: current?.id ?? input.id ?? randomUUID(),
      projectId,
      status: current?.status ?? 'draft',
      revision: current?.revision ?? 0,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    return this.store.savePlan(plan, expectedRevision);
  }

  async approvePlan(projectId: string, expectedRevision: number): Promise<ScriptPlan> {
    const current = await this.getPlan(projectId);
    if (current.status === 'approved' || current.status === 'locked') return current;
    return this.store.savePlan({ ...current, status: 'approved' }, expectedRevision);
  }

  async getCharacters(projectId: string): Promise<ScriptCharacter[]> {
    await this.assertProject(projectId);
    return (await this.store.getProjectState(projectId))?.characters ?? [];
  }

  async saveCharacters(
    projectId: string,
    value: unknown,
    expectedRevision: number,
  ): Promise<ScriptCharacter[]> {
    await this.assertProject(projectId);
    const inputs = decodeScriptCharacterInputs(value);
    const state = await this.store.getProjectState(projectId);
    const limit = state?.plan?.maxPrimaryCharacters ?? 20;
    const byName = new Map((state?.characters ?? []).map((item) => [item.name, item]));
    const now = new Date().toISOString();
    const items: ScriptCharacter[] = inputs.map((input) => ({
      ...input,
      id: input.id ?? byName.get(input.name)?.id ?? randomUUID(),
      projectId,
      revision: currentRevision(state?.characters ?? []),
      updatedAt: now,
    }));
    validateScriptCharacterSet(items, { maxPrimaryCharacters: limit });
    return this.store.saveCharacters(projectId, items, expectedRevision);
  }

  async getWorld(projectId: string): Promise<ScriptWorldBible> {
    const value = (await this.requireState(projectId)).worldBible;
    if (!value) throw ScriptServiceError.notFound('世界圣经尚未创建');
    return value;
  }

  async saveWorld(projectId: string, value: unknown, expectedRevision: number): Promise<ScriptWorldBible> {
    await this.assertProject(projectId);
    const current = (await this.store.getProjectState(projectId))?.worldBible;
    return this.store.saveWorldBible(
      {
        ...decodeScriptWorldBibleInput(value),
        projectId,
        revision: current?.revision ?? 0,
        updatedAt: new Date().toISOString(),
      },
      expectedRevision,
    );
  }

  async getSeriesOutline(projectId: string): Promise<ScriptSeriesOutline> {
    const value = (await this.requireState(projectId)).seriesOutline;
    if (!value) throw ScriptServiceError.notFound('全剧大纲尚未创建');
    return value;
  }

  async saveSeriesOutline(
    projectId: string,
    value: unknown,
    expectedRevision: number,
  ): Promise<ScriptSeriesOutline> {
    await this.assertProject(projectId);
    const parsed = decodeScriptSeriesOutlineInput(value);
    const state = await this.store.getProjectState(projectId);
    validateScriptSeriesOutlineInput(parsed, { totalEpisodes: state?.plan?.totalEpisodes });
    return this.store.saveSeriesOutline(
      { ...parsed, projectId, revision: state?.seriesOutline?.revision ?? 0 },
      expectedRevision,
    );
  }

  async getEpisodeOutline(projectId: string, episodeNumber: number): Promise<ScriptEpisodeOutline> {
    const item = (await this.requireState(projectId)).episodeOutlines.find(
      (value) => value.episodeNumber === episodeNumber,
    );
    if (!item) throw ScriptServiceError.notFound(`第${episodeNumber}集详细大纲尚未创建`);
    return item;
  }

  async saveEpisodeOutline(
    projectId: string,
    episodeNumber: number,
    value: unknown,
    expectedRevision: number,
  ): Promise<ScriptEpisodeOutline> {
    await this.assertProject(projectId);
    const input = decodeScriptEpisodeOutlineInput(value);
    const state = await this.store.getProjectState(projectId);
    const plan = state?.plan;
    const maxScenes = plan?.maxScenesPerEpisode ?? 5;
    validateScriptEpisodeOutlineInput(input, {
      expectedEpisodeNumber: episodeNumber,
      totalEpisodes: plan?.totalEpisodes,
      maxScenesPerEpisode: maxScenes,
    });
    const current = state?.episodeOutlines.find((item) => item.episodeNumber === episodeNumber);
    return this.store.saveEpisodeOutline(
      {
        ...input,
        id: current?.id ?? input.id ?? randomUUID(),
        projectId,
        revision: current?.revision ?? 0,
      },
      expectedRevision,
    );
  }

  async getEpisode(projectId: string, episodeNumber: number): Promise<ScriptEpisode> {
    const item = (await this.requireState(projectId)).episodes.find(
      (value) => value.episodeNumber === episodeNumber,
    );
    if (!item) throw ScriptServiceError.notFound(`第${episodeNumber}集正文尚未创建`);
    return item;
  }

  async listEpisodes(projectId: string): Promise<ScriptEpisodeSummary[]> {
    await this.assertProject(projectId);
    return episodeSummaries(await this.store.getProjectState(projectId));
  }

  async listReviewIssues(
    projectId: string,
    filters: { episodeNumber?: number; status?: ScriptReviewStatus } = {},
  ): Promise<ScriptReviewIssueCollection> {
    await this.assertProject(projectId);
    const state = await this.store.getProjectState(projectId);
    const items = (state?.reviewIssues ?? []).filter(
      (item) =>
        (filters.episodeNumber === undefined || item.episodeNumber === filters.episodeNumber) &&
        (filters.status === undefined || item.status === filters.status),
    );
    return { revision: state?.reviewRevision ?? 0, items };
  }

  async saveReviewIssues(
    projectId: string,
    value: unknown,
    expectedRevision: number,
  ): Promise<ScriptReviewIssueCollection> {
    await this.assertProject(projectId);
    const inputs = parseReviewIssues(value);
    const state = await this.store.getProjectState(projectId);
    const currentById = new Map((state?.reviewIssues ?? []).map((item) => [item.id, item]));
    const now = new Date().toISOString();
    const items = inputs.map((input) => {
      const previous = input.id ? currentById.get(input.id) : undefined;
      return {
        ...input,
        id: input.id ?? randomUUID(),
        projectId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      } satisfies ScriptReviewIssue;
    });
    return this.store.saveReviewIssues(projectId, items, expectedRevision);
  }

  async updateReviewIssueStatus(
    projectId: string,
    issueId: string,
    statusValue: unknown,
    expectedRevision: number,
  ): Promise<ScriptReviewIssueUpdateResult> {
    await this.assertProject(projectId);
    const id = idValue(issueId, '校稿问题 id');
    const status = enumValue(statusValue, '问题状态', REVIEW_STATUSES) as ScriptReviewStatus;
    const state = await this.store.getProjectState(projectId);
    const current = state?.reviewIssues.find((item) => item.id === id);
    if (!current) throw ScriptServiceError.notFound('校稿问题不存在');
    if (current.severity === 'hard' && current.source !== 'ai' && status === 'ignored') {
      throw ScriptServiceError.validation('阻断性校稿问题不能忽略，必须修复后重新校稿');
    }
    const item = { ...current, status, updatedAt: new Date().toISOString() };
    const saved = await this.store.saveReviewIssues(
      projectId,
      (state?.reviewIssues ?? []).map((candidate) => candidate.id === id ? item : candidate),
      expectedRevision,
    );
    return { revision: saved.revision, item };
  }

  async reviewEpisode(
    projectId: string,
    episodeNumber: number,
    expectedReviewRevision: number,
  ): Promise<ScriptEpisodeReviewResult> {
    const state = await this.requireState(projectId);
    const plan = state.plan;
    if (!plan) throw ScriptServiceError.validation('校稿前必须先保存短剧策划');
    const episode = state.episodes.find((item) => item.episodeNumber === episodeNumber);
    if (!episode) throw ScriptServiceError.notFound(`第${episodeNumber}集正文尚未创建`);
    const outline = state.episodeOutlines.find((item) => item.episodeNumber === episodeNumber);
    const charactersById = new Map(state.characters.map((item) => [item.id, item.name]));
    const registeredCharacterNames = new Set(charactersById.values());
    const report = validateScriptEpisode(episode, plan, {
      expectedEpisodeNumber: episodeNumber,
      registeredCharacterIds: new Set(charactersById.keys()),
      registeredCharacterNames,
      temporarySpeakers: collectTemporaryDialogueSpeakers(
        episode,
        plan,
        registeredCharacterNames,
      ),
      characterNamesById: charactersById,
      ...(outline ? { outline } : {}),
      previousEpisode: state.episodes
        .filter((item) => item.episodeNumber < episodeNumber)
        .sort((left, right) => right.episodeNumber - left.episodeNumber)[0],
      continuity: projectScriptContinuity(state, episodeNumber),
    });
    const generated = createScriptReviewIssues(
      projectId,
      episodeNumber,
      'deterministic',
      report.issues,
    );
    const saved = await this.store.replaceEpisodeReviewIssues(
      projectId,
      episodeNumber,
      ['deterministic'],
      generated,
      expectedReviewRevision,
    );
    const blockingIssues = saved.items.filter(
      (item) => item.episodeNumber === episodeNumber && isBlockingScriptReviewIssue(item),
    );
    const hasCurrentCommit = currentScriptContinuityCommits(state).some(
      (commit) =>
        commit.episodeNumber === episodeNumber &&
        commit.episodeRevision === episode.revision,
    );
    if (!report.hardFailed && blockingIssues.length === 0 && !hasCurrentCommit) {
      const latestState = (await this.store.getProjectState(projectId)) ?? state;
      const previousEpisodeCommit = [...(latestState.continuityCommits ?? [])]
        .filter((commit) => commit.episodeNumber === episodeNumber)
        .sort((left, right) => right.revision - left.revision)[0];
      const wardrobe = previousEpisodeCommit?.characterUpdates.flatMap((update) =>
        update.outfit ? [{ characterId: update.characterId, outfit: update.outfit }] : [],
      ) ?? [];
      const continuity = buildScriptContinuityCandidate(latestState, episode, wardrobe);
      const commitInput = buildScriptAtomicCommitInput(latestState, episode, continuity, {
        promptVersion: 'script-service-proofread-v1',
        modelConfigFingerprint: DETERMINISTIC_REVIEW_CONFIG_FINGERPRINT,
      });
      const commitEpisodeWithContinuity = this.store.commitEpisodeWithContinuity;
      if (!commitEpisodeWithContinuity) {
        throw ScriptServiceError.validation('正文存储未实现原子连续性提交');
      }
      await commitEpisodeWithContinuity.call(this.store, commitInput);
    }
    return {
      revision: saved.revision,
      items: saved.items.filter((item) => item.episodeNumber === episodeNumber),
      report,
    };
  }

  /**
   * Rebuild the immutable continuity chain after a user changes an earlier
   * completed Episode. The successor scripts themselves are not rewritten and
   * no model is called; only their deterministic continuity commits are rebased
   * onto the newly confirmed predecessor.
   */
  private async rechainCompletedSuccessors(
    projectId: string,
    afterEpisodeNumber: number,
  ): Promise<void> {
    const commitEpisodeWithContinuity = this.store.commitEpisodeWithContinuity;
    if (!commitEpisodeWithContinuity) return;

    for (let episodeNumber = afterEpisodeNumber + 1; ; episodeNumber += 1) {
      const state = await this.requireState(projectId);
      const episode = state.episodes.find(
        (item) => item.episodeNumber === episodeNumber && item.status === 'completed',
      );
      if (!episode) return;

      const previousCommit = [...(state.continuityCommits ?? [])]
        .filter((item) => item.episodeNumber === episodeNumber)
        .sort((left, right) => right.revision - left.revision)[0];
      const wardrobe = previousCommit?.characterUpdates.flatMap((update) =>
        update.outfit ? [{ characterId: update.characterId, outfit: update.outfit }] : [],
      ) ?? [];
      const continuity = buildScriptContinuityCandidate(state, episode, wardrobe);
      const commitInput = buildScriptAtomicCommitInput(state, episode, continuity, {
        promptVersion: 'script-service-manual-edit-rechain-v1',
        modelConfigFingerprint: DETERMINISTIC_REVIEW_CONFIG_FINGERPRINT,
      });
      try {
        await commitEpisodeWithContinuity.call(this.store, commitInput);
      } catch {
        // The edited Episode has already been committed successfully. A racing
        // successor edit must not make the UI report that the user's save
        // failed; the next save/rewrite will retry this local chain repair.
        return;
      }
    }
  }

  async saveEpisode(
    projectId: string,
    episodeNumber: number,
    value: unknown,
    expectedRevision: number,
  ): Promise<ScriptEpisode> {
    await this.assertProject(projectId);
    const input = decodeScriptEpisodeInput(value);
    const state = await this.store.getProjectState(projectId);
    const plan = state?.plan;
    const maxScenes = plan?.maxScenesPerEpisode ?? 5;
    validateScriptEpisodeInput(input, {
      expectedEpisodeNumber: episodeNumber,
      totalEpisodes: plan?.totalEpisodes,
      maxScenesPerEpisode: maxScenes,
    });
    const current = state?.episodes.find((item) => item.episodeNumber === episodeNumber);
    const now = new Date().toISOString();
    const episode: ScriptEpisode = {
      ...input,
      id: current?.id ?? input.id ?? randomUUID(),
      projectId,
      revision: current?.revision ?? 0,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    if (episode.status === 'completed') {
      if (!plan) {
        throw ScriptServiceError.validation('完成正文前必须先保存并确认短剧策划');
      }
      const unresolvedHardIssues = (state?.reviewIssues ?? []).filter(
        (item) => item.episodeNumber === episodeNumber && isBlockingScriptReviewIssue(item),
      );
      if (unresolvedHardIssues.length > 0) {
        throw ScriptServiceError.validation('本集仍有未解决的硬性校稿问题，不能标记为已完成', {
          issues: unresolvedHardIssues,
        });
      }
      const outline = state?.episodeOutlines.find((item) => item.episodeNumber === episodeNumber);
      if (!outline) {
        throw ScriptServiceError.validation('完成正文前必须先保存本集详细大纲');
      }
      const report = validateScriptEpisode(episode, plan, {
        expectedEpisodeNumber: episodeNumber,
        existingEpisodeNumbers: (state?.episodes ?? [])
          .filter((item) => item.episodeNumber !== episodeNumber)
          .map((item) => item.episodeNumber),
        registeredCharacterIds: new Set((state?.characters ?? []).map((item) => item.id)),
        registeredCharacterNames: new Set((state?.characters ?? []).map((item) => item.name)),
        temporarySpeakers: collectTemporaryDialogueSpeakers(
          episode,
          plan,
          new Set((state?.characters ?? []).map((item) => item.name)),
        ),
        characterNamesById: new Map((state?.characters ?? []).map((item) => [item.id, item.name])),
        outline,
        previousEpisode: (state?.episodes ?? [])
          .filter((item) => item.episodeNumber < episodeNumber)
          .sort((left, right) => right.episodeNumber - left.episodeNumber)[0],
        continuity: projectScriptContinuity(state, episodeNumber),
      });
      if (report.hardFailed) {
        throw ScriptServiceError.validation('本集未通过短剧质量门，不能标记为已完成', {
          issues: report.issues,
        });
      }
      if (!state) throw ScriptServiceError.validation('短剧项目状态不存在');
      const actualEpisodeRevision = current?.revision ?? 0;
      if (expectedRevision !== actualEpisodeRevision) {
        throw new ScriptConflictError(expectedRevision, actualEpisodeRevision);
      }
      const continuity = buildScriptContinuityCandidate(state, episode);
      const commitInput = buildScriptAtomicCommitInput(state, episode, continuity, {
        promptVersion: 'script-service-save-completed-v1',
        modelConfigFingerprint: DETERMINISTIC_REVIEW_CONFIG_FINGERPRINT,
      });
      const commitEpisodeWithContinuity = this.store.commitEpisodeWithContinuity;
      if (!commitEpisodeWithContinuity) {
        throw ScriptServiceError.validation('正文存储未实现原子连续性提交');
      }
      const committed = await commitEpisodeWithContinuity.call(this.store, commitInput);
      await this.rechainCompletedSuccessors(projectId, episodeNumber);
      return committed.episode;
    }
    return this.store.saveEpisode(episode, expectedRevision);
  }

  async remove(projectId: string): Promise<void> {
    await this.assertProject(projectId);
    await this.store.deleteProject(projectId);
  }

  async export(
    projectId: string,
    format: ScriptExportFormat,
    startEpisode?: number,
    episodeCount?: number,
  ): Promise<{ filename: string; content: string; contentType: string }> {
    const state = await this.requireState(projectId);
    const start = startEpisode ?? 1;
    const end = episodeCount === undefined ? Number.MAX_SAFE_INTEGER : start + episodeCount - 1;
    const episodes = state.episodes.filter(
      (episode) => episode.episodeNumber >= start && episode.episodeNumber <= end,
    );
    if (episodes.length === 0) throw ScriptServiceError.notFound('指定范围内没有可导出的剧本正文');
    const title = state.plan?.title ?? `短剧-${projectId}`;
    const extension = format === 'md' ? 'md' : format === 'fountain' ? 'fountain' : 'txt';
    const content = format === 'md'
      ? serializeScriptMarkdown(episodes, state.characters, { title })
      : format === 'fountain'
        ? serializeFountain(episodes, state.characters)
        : serializeChineseShortDrama(episodes, state.characters);
    return {
      filename: `${title}.${extension}`,
      content: `${content}\n`,
      contentType: format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
    };
  }
}

export function isScriptTransportError(
  error: unknown,
): error is ScriptServiceError | ScriptConflictError | StoreError {
  return (
    error instanceof ScriptServiceError ||
    error instanceof ScriptConflictError ||
    error instanceof StoreError
  );
}
