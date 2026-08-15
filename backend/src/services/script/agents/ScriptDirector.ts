import { createHash, randomUUID } from 'node:crypto';

import type {
  ScriptCharacter,
  ScriptEpisode,
  ScriptEpisodeCard,
  ScriptEpisodeOutline,
  ScriptPlannedScene,
  ScriptPlan,
  ScriptProjectState,
  ScriptReviewIssueCollection,
  ScriptScene,
  ScriptSeriesOutline,
  ScriptWorldBible,
  ScriptUpstreamArtifactRef,
} from '../domain.js';
import {
  buildScriptAtomicCommitInput,
  buildScriptContinuityCandidate,
  buildScriptInputRevisionRefs,
  currentScriptContinuityCommits,
  projectScriptContinuity,
} from '../ScriptContinuityCommit.js';
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
} from '../ScriptCanonicalInput.js';
import { ScriptServiceError } from '../ScriptServiceError.js';
import type { ScriptStore } from '../ScriptStore.js';
import {
  createScriptReviewIssues,
  isBlockingScriptReviewIssue,
  validateScriptEpisode,
  type ScriptEvaluatedGateIssue,
  type ScriptGateIssue,
  type ScriptGateReport,
} from '../quality/ScriptQualityGates.js';
import {
  assessScriptPlanning,
  type ScriptPlanningSession,
} from './ScriptPlanningAgent.js';
import {
  buildScriptEpisodeCandidateArtifact,
  buildScriptScenePlanArtifact,
  buildScriptUpstreamArtifactRef,
  computeScriptCheckpointInputFingerprint,
  decideScriptCheckpointResume,
  decodeScriptEpisodeCandidateArtifact,
  decodeScriptScenePlanArtifact,
  latestScriptCheckpoint,
  nextScriptCheckpointArtifactRevision,
  type ScriptCheckpointNode,
  type ScriptCheckpointSelector,
  type ScriptCheckpointArtifactMeta,
  type ScriptEpisodeCandidateArtifact,
  type ScriptScenePlanArtifact,
  type ScriptCheckpointStore,
  type ScriptPipelineCheckpoint,
  type ScriptPipelineCheckpointWrite,
} from './ScriptCheckpoint.js';
import {
  defineStructuredContract,
  type StructuredContract,
  type StructuredDecodeIssue,
} from './StructuredContract.js';
import {
  generateStructured,
  type StructuredGenerationError,
  type StructuredModel,
} from './generateStructured.js';
import {
  applyScriptRevisionPatch,
  buildScriptRevisionPatchPolicy,
  SCRIPT_REVISION_PATCH_CONTRACT,
  ScriptRevisionPatchError,
} from './ScriptRevisionPatch.js';
import { ScriptModelOutputError } from './structuredOutput.js';

export { InMemoryScriptCheckpointStore } from './ScriptCheckpoint.js';
export type {
  ScriptCheckpointNode,
  ScriptCheckpointStore,
  ScriptPipelineCheckpoint,
  ScriptPipelineCheckpointWrite,
} from './ScriptCheckpoint.js';

export type ScriptModelNode =
  | 'plan'
  | 'series_outline'
  | 'character_bible'
  | 'world_bible'
  | 'episode_outline'
  | 'scene_plan'
  | 'draft'
  | 'review'
  | 'revision';

export interface ScriptModelRequest {
  node: ScriptModelNode;
  projectId: string;
  episodeNumber?: number;
  chunkStart?: number;
  chunkEnd?: number;
  prompt: string;
  /** Uses another model on the same request-scoped provider credentials. */
  modelNameOverride?: string;
  signal?: AbortSignal;
}

export interface ScriptModelAdapter {
  complete(request: ScriptModelRequest): Promise<string>;
  getStructuredFallbackModelName?(): Promise<string | undefined>;
  /** SHA-256 over non-secret routing fields; never includes API keys or headers. */
  getModelConfigFingerprint?(): Promise<string>;
}

export interface ScriptDirectorDependencies {
  model: ScriptModelAdapter;
  store: ScriptStore;
  checkpoints: ScriptCheckpointStore;
  now?: () => string;
  id?: () => string;
}

export interface ScriptCheckpointProgress {
  episodeNumber?: number;
  node: ScriptCheckpointNode;
  attempt: number;
  artifactRevision: number;
}

export interface ScriptProgressEvent {
  phase: 'info';
  message: string;
  current?: number;
  total?: number;
  scriptCheckpoint: ScriptCheckpointProgress;
}

export type ScriptDirectorRequest =
  | {
      task: 'script_plan';
      projectId: string;
      planningSession: ScriptPlanningSession;
      seedPrompt?: string;
      signal?: AbortSignal;
    }
  | {
      task: 'script_series_outline';
      projectId: string;
      signal?: AbortSignal;
    }
  | {
      task: 'script_bible';
      projectId: string;
      signal?: AbortSignal;
      /** Regenerate the candidate that caused a durable needs-review pause. */
      resumeRejectedCandidates?: boolean;
    }
  | {
      task: 'script_episode_batch';
      projectId: string;
      startEpisode: number;
      episodeCount: number;
      expectedPlanRevision: number;
      signal?: AbortSignal;
      /** Regenerate the candidate that caused a durable needs-review pause. */
      resumeRejectedCandidates?: boolean;
      onProgress?: (event: ScriptProgressEvent) => void | Promise<void>;
    };

export type ScriptDirectorResult =
  | {
      kind: 'planning_questions';
      questions: ReturnType<typeof assessScriptPlanning> extends infer _T
        ? Extract<ReturnType<typeof assessScriptPlanning>, { kind: 'questions' }>['questions']
        : never;
      askedFields: Extract<ReturnType<typeof assessScriptPlanning>, { kind: 'questions' }>['askedFields'];
      questionCount: number;
    }
  | { kind: 'planning_waiting'; missingFields: string[] }
  | { kind: 'plan_draft'; plan: ScriptPlan }
  | { kind: 'series_outline'; outline: ScriptSeriesOutline }
  | { kind: 'bible'; characters: ScriptCharacter[]; worldBible: ScriptWorldBible }
  | {
      kind: 'episode_batch';
      episodes: ScriptEpisode[];
      reports: Array<{ episodeNumber: number; report: ScriptGateReport }>;
      skippedEpisodeNumbers: number[];
    };

export class ScriptBatchPausedError extends Error {
  readonly code = 'SCRIPT_BATCH_NEEDS_REVIEW';
  readonly recoverable = true;

  constructor(
    readonly episodeNumber: number,
    readonly report: ScriptGateReport,
  ) {
    const hardIssueSummary = report.issues
      .filter((issue) => issue.severity === 'hard')
      .slice(0, 4)
      .map((issue) => `${issue.code}：${issue.message}`)
      .join('；');
    super(
      `第 ${episodeNumber} 集未通过硬质量门，批次已暂停。${hardIssueSummary
        ? ` ${hardIssueSummary}`
        : ''}`,
    );
    this.name = 'ScriptBatchPausedError';
  }
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ScriptModelOutputError(`模型结果缺少字符串字段 ${field}。`);
  }
  return value.trim();
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ScriptModelOutputError(`模型结果缺少数字字段 ${field}。`);
  }
  return value;
}

function stringsField(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ScriptModelOutputError(`模型结果缺少字符串数组 ${field}。`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScriptModelOutputError(`模型结果缺少对象字段 ${field}。`);
  }
  return value as Record<string, unknown>;
}

function enumField<const T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ScriptModelOutputError(`模型结果字段 ${field} 的值无效。`);
  }
  return value as T;
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Keep Agent writes on exactly the same canonical validation boundary as ScriptService. */
function canonicalModelCandidate<T>(decodeAndValidate: () => T): T {
  try {
    return decodeAndValidate();
  } catch (error) {
    if (error instanceof ScriptServiceError) {
      throw new ScriptModelOutputError(error.message);
    }
    throw error;
  }
}

export class ScriptStructuredNeedsReviewError extends Error {
  readonly code = 'SCRIPT_STRUCTURED_NEEDS_REVIEW';
  readonly recoverable = true;

  constructor(
    readonly node: ScriptModelNode,
    readonly cause: StructuredGenerationError,
  ) {
    super(`${node} 结构化结果需要人工检查：${cause.message}`);
    this.name = 'ScriptStructuredNeedsReviewError';
  }
}

function issuePathFromMessage(message: string): readonly (string | number)[] {
  const match = message.match(/(?:字段|字符串数组|对象字段|数字字段)\s+([A-Za-z0-9_.]+)/u);
  return match?.[1]?.split('.').filter(Boolean) ?? [];
}

function parserContract<T>(
  name: string,
  instructions: string,
  parse: (value: Record<string, unknown>) => T,
): StructuredContract<T> {
  return defineStructuredContract({
    name,
    version: 1,
    instructions,
    decode(value) {
      try {
        return { success: true, value: parse(recordField(value, name)) };
      } catch (error) {
        if (!(error instanceof ScriptModelOutputError)) throw error;
        return {
          success: false,
          issues: [{
            path: issuePathFromMessage(error.message),
            code: /缺少|必须/u.test(error.message) ? 'field.required' : 'field.invalid',
            message: error.message,
          }],
        };
      }
    },
  });
}

function scriptLengthInstruction(targetChars: number, currentChars?: number): string {
  const blockCount = Math.max(12, Math.min(100, Math.round(targetChars / 18)));
  const charsPerBlock = Math.round(targetChars / blockCount);
  const minimumPerBlock = Math.max(12, Math.floor(charsPerBlock * 0.9));
  const maximumPerBlock = Math.ceil(charsPerBlock * 1.1);
  const current = currentChars === undefined
    ? ''
    : `当前正文只有 ${currentChars} 个可见字符，需增删约 ${Math.abs(targetChars - currentChars)} 个字符。`;
  return [
    current,
    `请让全部场景合计恰好包含 ${blockCount} 个 caption/action/dialogue 正文块，`,
    `每个 blocks.text 约 ${minimumPerBlock}—${maximumPerBlock} 个可见字符；`,
    '每个 text 至少写成一个完整句子，长度可参考“她攥紧彩票退到监控灯下，盯着老板把兑奖记录藏进抽屉”，不要用四五字短句凑块数；',
    `篇幅只能写进 blocks.text，summary、newFacts、openedThreads、closedThreads 不计入正文。`,
  ].join('');
}

function scriptVisibleChars(episode: ScriptEpisode): number {
  return episode.scenes
    .flatMap((scene) => scene.blocks)
    .map((block) => block.text)
    .join('')
    .replace(/\s/gu, '')
    .length;
}

function checkpointArtifactMetadata(artifact: ScriptCheckpointArtifactMeta): Pick<
  ScriptPipelineCheckpointWrite,
  | 'inputRevisionRefs'
  | 'upstreamArtifactRefs'
  | 'promptVersion'
  | 'configRevision'
  | 'inputFingerprint'
  | 'validationErrors'
> {
  return {
    inputRevisionRefs: artifact.inputRevisionRefs,
    upstreamArtifactRefs: artifact.upstreamArtifactRefs,
    promptVersion: artifact.promptVersion,
    configRevision: artifact.configRevision,
    inputFingerprint: artifact.inputFingerprint,
    validationErrors: artifact.validationErrors,
  };
}

const PLAN_LOCK_CONFIG_REVISION = createHash('sha256')
  .update('agentxin:script-plan-lock:v1', 'utf8')
  .digest('hex');

export class ScriptDirector {
  constructor(private readonly dependencies: ScriptDirectorDependencies) {}

  async run(request: ScriptDirectorRequest): Promise<ScriptDirectorResult> {
    if (request.task === 'script_series_outline') {
      return this.generateSeriesOutline(request.projectId, request.signal);
    }
    if (request.task === 'script_bible') {
      return this.generateBible(
        request.projectId,
        request.signal,
        request.resumeRejectedCandidates === true,
      );
    }
    if (request.task === 'script_episode_batch') {
      return this.generateEpisodeBatch(request);
    }
    const assessment = assessScriptPlanning(request.planningSession);
    if (assessment.kind === 'questions') {
      return {
        kind: 'planning_questions',
        questions: assessment.questions,
        askedFields: assessment.askedFields,
        questionCount: assessment.questionCount,
      };
    }
    if (assessment.kind === 'waiting') {
      return { kind: 'planning_waiting', missingFields: assessment.missingFields };
    }
    const current = (await this.dependencies.store.getProjectState(request.projectId))?.plan;
    const prompt = [
        '你是短剧策划 Agent。根据已确认选项补全专业策划。',
        '只返回与 ScriptPlan 对应的 JSON，不输出思考过程或 Markdown 围栏。',
        [
          '必须返回以下全部字段：',
          'title, theme, market, channel, genres, audience, coreConflict, logline, highlights,',
          'totalEpisodes, episodeDurationSeconds, targetCharsPerEpisode, maxPrimaryCharacters,',
          'maxScenesPerEpisode, dialogueDensityPercent, language, format, coreRequirements,',
          'forbiddenElements, endingDirection；coverPrompt 可选。',
        ].join(' '),
        'episodeDurationSeconds 必须是 {"min":数字,"max":数字}；genres、highlights、forbiddenElements 必须是字符串数组。',
        'market 只能是 domestic/overseas，channel 只能是 female/male/general，language 必须是 zh-CN，format 必须是 cn_short_drama。',
        '范围：总集数1—200，时长30—180秒，单集300—3000字，主要角色1—20，场景1—5，对话密度20—90。',
        `用户故事想法：${request.seedPrompt?.trim() || '未提供，由 Agent 原创'}`,
        `已确认：${JSON.stringify(assessment.values)}`,
        `委托 Agent 字段：${assessment.delegatedFields.join('、') || '无'}`,
      ].join('\n');
    const explicit = assessment.values;
    const now = this.dependencies.now?.() ?? new Date().toISOString();
    const configRevision = await this.modelConfigFingerprint();
    const inputRevisionRefs = current
      ? [{ resource: 'plan' as const, id: current.id, revision: current.revision }]
      : [];
    const upstreamArtifactRefs = [buildScriptUpstreamArtifactRef('planning_session', 1, {
      values: assessment.values,
      delegatedFields: assessment.delegatedFields,
      seedPrompt: request.seedPrompt?.trim() ?? '',
    })];
    const promptVersion = 'script-plan-v2';
    const inputFingerprint = computeScriptCheckpointInputFingerprint({
      node: 'plan', inputRevisionRefs, upstreamArtifactRefs, promptVersion, configRevision,
    });
    const plan = await this.generateNodeStructured({
      node: 'plan', projectId: request.projectId, prompt, signal: request.signal,
    }, parserContract(
      'script_plan',
      '必须返回全部 ScriptPlan 字段；缺失字段必须修复后才可保存。',
      (parsed): ScriptPlan => {
        const duration = recordField(parsed.episodeDurationSeconds, 'episodeDurationSeconds');
        const candidate: ScriptPlan = {
          id: current?.id ?? this.dependencies.id?.() ?? randomUUID(),
          projectId: request.projectId,
          status: 'draft',
          revision: current?.revision ?? 0,
          title: stringField(parsed.title, 'title'),
          theme: stringField(parsed.theme, 'theme'),
          market: enumField(parsed.market, 'market', ['domestic', 'overseas']),
          channel: enumField(parsed.channel, 'channel', ['female', 'male', 'general']),
          genres: explicit.genres ?? stringsField(parsed.genres, 'genres'),
          audience: explicit.audience ?? stringField(parsed.audience, 'audience'),
          coreConflict: explicit.coreConflict ?? stringField(parsed.coreConflict, 'coreConflict'),
          logline: stringField(parsed.logline, 'logline'),
          highlights: stringsField(parsed.highlights, 'highlights'),
          totalEpisodes: explicit.totalEpisodes ?? numberField(parsed.totalEpisodes, 'totalEpisodes'),
          episodeDurationSeconds: explicit.episodeDurationSeconds ?? {
            min: numberField(duration.min, 'episodeDurationSeconds.min'),
            max: numberField(duration.max, 'episodeDurationSeconds.max'),
          },
          targetCharsPerEpisode: explicit.targetCharsPerEpisode
            ?? numberField(parsed.targetCharsPerEpisode, 'targetCharsPerEpisode'),
          maxPrimaryCharacters: numberField(parsed.maxPrimaryCharacters, 'maxPrimaryCharacters'),
          maxScenesPerEpisode: explicit.maxScenesPerEpisode
            ?? numberField(parsed.maxScenesPerEpisode, 'maxScenesPerEpisode'),
          dialogueDensityPercent: explicit.dialogueDensityPercent
            ?? numberField(parsed.dialogueDensityPercent, 'dialogueDensityPercent'),
          language: enumField(parsed.language, 'language', ['zh-CN']),
          format: enumField(parsed.format, 'format', ['cn_short_drama']),
          coreRequirements: stringField(parsed.coreRequirements, 'coreRequirements'),
          forbiddenElements: stringsField(parsed.forbiddenElements, 'forbiddenElements'),
          endingDirection: explicit.endingDirection
            ?? stringField(parsed.endingDirection, 'endingDirection'),
          ...(typeof parsed.coverPrompt === 'string' && parsed.coverPrompt.trim()
            ? { coverPrompt: parsed.coverPrompt.trim() }
            : {}),
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        };
        const canonical = canonicalModelCandidate(() => decodeScriptPlanInput(candidate));
        return {
          ...canonical,
          id: candidate.id,
          projectId: candidate.projectId,
          status: candidate.status,
          revision: candidate.revision,
          createdAt: candidate.createdAt,
          updatedAt: candidate.updatedAt,
        };
      },
    ));
    request.signal?.throwIfAborted();
    const saved = await this.dependencies.store.savePlan(plan, current?.revision ?? 0);
    const planCheckpointRevision = await this.nextCheckpointArtifactRevision(
      request.projectId,
      'script_plan',
      { node: 'plan' },
    );
    await this.dependencies.checkpoints.save({
      projectId: request.projectId,
      runKey: 'script_plan',
      node: 'plan',
      status: 'succeeded',
      attempt: 1,
      artifactRevision: planCheckpointRevision,
      artifact: saved,
      inputRevisionRefs,
      upstreamArtifactRefs,
      promptVersion,
      configRevision,
      inputFingerprint,
      validationErrors: [],
      updatedAt: now,
    });
    return { kind: 'plan_draft', plan: saved };
  }

  private async generateSeriesOutline(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ScriptDirectorResult> {
    const state = await this.dependencies.store.getProjectState(projectId);
    const plan = state?.plan;
    if (!plan || (plan.status !== 'approved' && plan.status !== 'locked')) {
      throw new ScriptModelOutputError('生成全剧大纲前必须先确认策划。');
    }
    if (state?.seriesOutline?.episodeCards.length === plan.totalEpisodes) {
      return { kind: 'series_outline', outline: state.seriesOutline };
    }

    const runKey = 'script_series_outline';
    const checkpoints = await this.dependencies.checkpoints.list(projectId, runKey);
    const configRevision = await this.modelConfigFingerprint();
    const inputRevisionRefs = [{ resource: 'plan' as const, id: plan.id, revision: plan.revision }];
    const chunks: Record<string, unknown>[] = [];
    for (let start = 1; start <= plan.totalEpisodes; start += 10) {
      const end = Math.min(plan.totalEpisodes, start + 9);
      const upstreamArtifactRefs = [buildScriptUpstreamArtifactRef(
        'series_outline_range',
        start,
        { start, end, totalEpisodes: plan.totalEpisodes },
      )];
      const promptVersion = 'series-outline-chunk-v2';
      const inputFingerprint = computeScriptCheckpointInputFingerprint({
        node: 'series_outline',
        inputRevisionRefs,
        upstreamArtifactRefs,
        promptVersion,
        configRevision,
      });
      const restored = latestScriptCheckpoint(checkpoints, {
        node: 'series_outline',
        chunkStart: start,
      });
      if (restored) {
        const decision = decideScriptCheckpointResume(restored, inputFingerprint);
        if (decision.disposition === 'reuse' && restored.artifact !== undefined) {
          chunks.push(recordField(restored.artifact, 'seriesOutlineChunk'));
          continue;
        }
        if (decision.disposition === 'stale') await this.markCheckpointStale(restored);
      }
      const prompt = [
        '你是 SeriesOutlineAgent，生成全剧总纲和指定范围的轻量分集卡。',
        `本段只返回第 ${start}—${end} 集，集号必须连续。`,
        '只返回 JSON，字段：synopsis, openingState, midpointTurn, climax, endingState, mainArc, subplotArcs, episodeCards。',
        '严格模板：{"synopsis":"字符串","openingState":"字符串","midpointTurn":"字符串","climax":"字符串","endingState":"字符串","mainArc":["字符串"],"subplotArcs":["字符串"],"episodeCards":[{"episodeNumber":1,"title":"字符串","logline":"字符串","mainEvent":"字符串","endingHook":"字符串"}]}。不得翻译、缩写或改名任何键。',
        `已锁定策划：${JSON.stringify(plan)}`,
      ].join('\n');
      const parsed = await this.generateNodeStructured({
        node: 'series_outline',
        projectId,
        chunkStart: start,
        chunkEnd: end,
        prompt,
        signal,
      }, parserContract(
        'series_outline_chunk',
        `必须包含全部总纲字段以及第 ${start}—${end} 集连续、唯一的 episodeCards。`,
        (value) => {
          stringField(value.synopsis, 'synopsis');
          stringField(value.openingState, 'openingState');
          stringField(value.midpointTurn, 'midpointTurn');
          stringField(value.climax, 'climax');
          stringField(value.endingState, 'endingState');
          stringsField(value.mainArc, 'mainArc');
          stringsField(value.subplotArcs, 'subplotArcs');
          if (!Array.isArray(value.episodeCards)) {
            throw new ScriptModelOutputError('分集卡字段 episodeCards 必须是数组。');
          }
          const episodeNumbers = value.episodeCards.map((candidate) => {
            const card = recordField(candidate, 'episodeCard');
            const episodeNumber = numberField(card.episodeNumber, 'episodeCard.episodeNumber');
            stringField(card.title, 'episodeCard.title');
            stringField(card.logline, 'episodeCard.logline');
            stringField(card.mainEvent, 'episodeCard.mainEvent');
            stringField(card.endingHook, 'episodeCard.endingHook');
            return episodeNumber;
          });
          if (episodeNumbers.length !== end - start + 1 || episodeNumbers.some((item, index) => item !== start + index)) {
            throw new ScriptModelOutputError(`分集卡字段 episodeCards 必须连续覆盖 ${start}—${end} 集。`);
          }
          const canonical = canonicalModelCandidate(() => decodeScriptSeriesOutlineInput({
            ...value,
            episodeCards: (value.episodeCards as unknown[]).map((card, index) => ({
              ...recordField(card, `episodeCards.${index}`),
              episodeNumber: index + 1,
            })),
          }));
          return {
            ...canonical,
            episodeCards: canonical.episodeCards.map((card, index) => ({
              ...card,
              episodeNumber: start + index,
            })),
          };
        },
      ));
      chunks.push(parsed);
      const artifactRevision = await this.nextCheckpointArtifactRevision(
        projectId,
        runKey,
        { node: 'series_outline', chunkStart: start },
      );
      await this.dependencies.checkpoints.save({
        projectId,
        runKey,
        node: 'series_outline',
        status: 'succeeded',
        attempt: 1,
        artifactRevision,
        chunkStart: start,
        artifact: parsed,
        inputRevisionRefs,
        upstreamArtifactRefs,
        promptVersion,
        configRevision,
        inputFingerprint,
        validationErrors: [],
        updatedAt: this.dependencies.now?.() ?? new Date().toISOString(),
      });
    }
    const first = chunks[0];
    if (!first) throw new ScriptModelOutputError('全剧大纲未生成任何分段。');
    const cards: ScriptEpisodeCard[] = chunks.flatMap((chunk) => {
      if (!Array.isArray(chunk.episodeCards)) {
        throw new ScriptModelOutputError('分集卡 episodeCards 必须是数组。');
      }
      return chunk.episodeCards.map((candidate) => {
        const card = recordField(candidate, 'episodeCard');
        return {
          episodeNumber: numberField(card.episodeNumber, 'episodeNumber'),
          title: stringField(card.title, 'title'),
          logline: stringField(card.logline, 'logline'),
          mainEvent: stringField(card.mainEvent, 'mainEvent'),
          endingHook: stringField(card.endingHook, 'endingHook'),
        };
      });
    });
    cards.sort((left, right) => left.episodeNumber - right.episodeNumber);
    if (
      cards.length !== plan.totalEpisodes ||
      cards.some((card, index) => card.episodeNumber !== index + 1)
    ) {
      throw new ScriptModelOutputError(
        `分集卡必须完整覆盖 1—${plan.totalEpisodes} 集且集号唯一连续。`,
      );
    }
    const candidateOutline: ScriptSeriesOutline = {
      projectId,
      synopsis: stringField(first.synopsis, 'synopsis'),
      openingState: stringField(first.openingState, 'openingState'),
      midpointTurn: stringField(first.midpointTurn, 'midpointTurn'),
      climax: stringField(first.climax, 'climax'),
      endingState: stringField(first.endingState, 'endingState'),
      mainArc: stringsField(first.mainArc, 'mainArc'),
      subplotArcs: stringsField(first.subplotArcs, 'subplotArcs'),
      episodeCards: cards,
      revision: state?.seriesOutline?.revision ?? 0,
    };
    const canonicalOutline = canonicalModelCandidate(() => {
      const parsed = decodeScriptSeriesOutlineInput(candidateOutline);
      validateScriptSeriesOutlineInput(parsed, { totalEpisodes: plan.totalEpisodes });
      return parsed;
    });
    const outline: ScriptSeriesOutline = {
      ...canonicalOutline,
      projectId,
      revision: candidateOutline.revision,
    };
    signal?.throwIfAborted();
    const saved = await this.dependencies.store.saveSeriesOutline(
      outline,
      state?.seriesOutline?.revision ?? 0,
    );
    return { kind: 'series_outline', outline: saved };
  }

  private async generateBible(
    projectId: string,
    signal?: AbortSignal,
    resumeRejectedCandidates = false,
  ): Promise<ScriptDirectorResult> {
    const state = await this.dependencies.store.getProjectState(projectId);
    if (!state?.plan || !state.seriesOutline) {
      throw new ScriptModelOutputError('生成剧本圣经前必须先完成策划和全剧大纲。');
    }
    const now = this.dependencies.now?.() ?? new Date().toISOString();
    const plan = state.plan;
    const outline = state.seriesOutline;
    const characterInputRevisionRefs = [
      { resource: 'plan' as const, id: plan.id, revision: plan.revision },
      {
        resource: 'outline' as const,
        id: outline.projectId,
        revision: outline.revision,
      },
    ];
    const characterPromptVersion = 'character-bible-v3';
    const characterConfigRevision = await this.modelConfigFingerprint();
    const characterInputFingerprint = computeScriptCheckpointInputFingerprint({
      node: 'character_bible',
      inputRevisionRefs: characterInputRevisionRefs,
      promptVersion: characterPromptVersion,
      configRevision: characterConfigRevision,
    });
    const rejectedCharacters = await this.latestCheckpoint(
      projectId,
      'script_bible',
      { node: 'character_bible' },
    );
    if (rejectedCharacters?.status === 'needs_review') {
      await this.markCheckpointStale(rejectedCharacters);
    }
    const generateCharacters = async (): Promise<ScriptCharacter[]> => {
      if (state.characters.length > 0) return state.characters;
      let preservedCharacters: Array<{ index: number; character: ScriptCharacter }> = [];
      let failedIndexes: number[] = [];
      let characterCount: number | undefined;
      try {
        const prompt = [
          '你是 CharacterDesignAgent。根据策划和大纲生成结构化人物圣经。',
          '只返回 JSON 对象 {"characters": [...]} ，不输出思考过程。',
          '每个人物严格包含：id, name, aliases, role, age(可选), occupation(可选), identity, biography, motivation, goal, weakness, arc, appearance, hairstyle, physique, defaultOutfit, personality, skills, speechStyle, catchphrases, relationships。',
          'role 只能是 lead/supporting/antagonist/minor；aliases/personality/skills/catchphrases/relationships 必须是数组；relationship 使用 {"characterId":"已存在人物id","label":"关系","notes":"可选说明"}。不得改名任何键。',
          `当前策划允许最多 ${plan.maxPrimaryCharacters} 个非 minor 主要人物；请以当前数字为准，不沿用旧候选约束。`,
          resumeRejectedCandidates
            ? '这是用户显式恢复后的新候选生成；必须重新依据下方最新策划与大纲作答。'
            : '',
          `策划：${JSON.stringify(plan)}`,
          `大纲：${JSON.stringify(outline)}`,
        ].filter(Boolean).join('\n');
        const characterContract = defineStructuredContract<ScriptCharacter[]>({
          name: 'character_bible',
          version: 2,
          instructions: [
            '首次必须返回 {"characters":[完整人物...]}。',
            '若校验错误只指向部分 characters[i]，修复时只改这些索引；可返回完整 characters 数组，或 {"repairs":[{"index":i,"character":{...}}]}。',
            '未报错人物会由系统保留，模型对它们的改写不会生效。',
          ].join(''),
          decode: (raw) => {
            let value: Record<string, unknown>;
            try {
              value = recordField(raw, 'character_bible');
            } catch (error) {
              return { success: false, issues: [{ path: [], code: 'field.required', message: error instanceof Error ? error.message : String(error) }] };
            }
            const issueFor = (index: number, error: unknown): StructuredDecodeIssue => ({
              path: ['characters', index, ...(
                error instanceof ScriptModelOutputError ? issuePathFromMessage(error.message) : []
              )],
              code: 'field.invalid',
              message: error instanceof Error ? error.message : String(error),
            });
            const validateGroup = (
              indexed: Array<{ index: number; character: ScriptCharacter }>,
            ): StructuredDecodeIssue[] => {
              const issues: StructuredDecodeIssue[] = [];
              const idOwner = new Map<string, number>();
              const nameOwner = new Map<string, number>();
              const ids = new Set(indexed.map((item) => item.character.id));
              let primaryCount = 0;
              for (const item of indexed.sort((left, right) => left.index - right.index)) {
                const { character, index } = item;
                const duplicateId = idOwner.get(character.id);
                if (duplicateId !== undefined) {
                  issues.push({ path: ['characters', index, 'id'], code: 'character.id.duplicate', message: `人物 id 与 characters[${duplicateId}] 重复。` });
                } else idOwner.set(character.id, index);
                const normalizedName = character.name.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
                const duplicateName = nameOwner.get(normalizedName);
                if (duplicateName !== undefined) {
                  issues.push({ path: ['characters', index, 'name'], code: 'character.name.duplicate', message: `人物 name 与 characters[${duplicateName}] 重复。` });
                } else nameOwner.set(normalizedName, index);
                if (character.role !== 'minor') {
                  primaryCount += 1;
                  if (primaryCount > plan.maxPrimaryCharacters) {
                    issues.push({ path: ['characters', index, 'role'], code: 'character.primary.limit', message: `主要人物不得超过 ${plan.maxPrimaryCharacters} 人。` });
                  }
                }
                for (const relationship of character.relationships) {
                  if (relationship.characterId === character.id) {
                    issues.push({ path: ['characters', index, 'relationships'], code: 'character.relationship.self', message: '人物关系不得指向自己。' });
                  } else if (!ids.has(relationship.characterId)) {
                    issues.push({ path: ['characters', index, 'relationships'], code: 'character.relationship.unknown', message: `人物关系引用未登记 id：${relationship.characterId}。` });
                  }
                }
              }
              return issues;
            };
            let candidateByIndex = new Map<number, Record<string, unknown>>();
            if (characterCount === undefined) {
              if (!Array.isArray(value.characters) || value.characters.length === 0) {
                return { success: false, issues: [{ path: ['characters'], code: 'field.required', message: '人物圣经 characters 必须是非空数组。' }] };
              }
              characterCount = value.characters.length;
              value.characters.forEach((candidate, index) => {
                try { candidateByIndex.set(index, recordField(candidate, `characters.${index}`)); } catch { /* reported below */ }
              });
              failedIndexes = Array.from({ length: characterCount }, (_, index) => index);
            } else if (Array.isArray(value.repairs)) {
              for (const repairCandidate of value.repairs) {
                try {
                  const repair = recordField(repairCandidate, 'repair');
                  const index = numberField(repair.index, 'repair.index');
                  if (failedIndexes.includes(index)) {
                    candidateByIndex.set(index, recordField(repair.character, 'repair.character'));
                  }
                } catch { /* missing repair is reported below */ }
              }
            } else if (Array.isArray(value.characters)) {
              const repairCharacters = value.characters;
              if (repairCharacters.length === characterCount) {
                for (const index of failedIndexes) {
                  const candidate = repairCharacters[index];
                  if (candidate !== undefined) candidateByIndex.set(index, recordField(candidate, `characters.${index}`));
                }
              } else if (repairCharacters.length === failedIndexes.length) {
                failedIndexes.forEach((index, offset) => {
                  const candidate = repairCharacters[offset];
                  if (candidate !== undefined) candidateByIndex.set(index, recordField(candidate, `characters.${index}`));
                });
              }
            }

            const repaired: Array<{ index: number; character: ScriptCharacter }> = [];
            const issues: StructuredDecodeIssue[] = [];
            for (const index of failedIndexes) {
              const candidate = candidateByIndex.get(index);
              if (!candidate) {
                issues.push({ path: ['characters', index], code: 'field.required', message: `缺少 characters[${index}] 的定向修复。` });
                continue;
              }
              try {
                repaired.push({ index, character: this.parseCharacter(candidate, projectId, now) });
              } catch (error) {
                issues.push(issueFor(index, error));
              }
            }
            preservedCharacters = [
              ...preservedCharacters.filter((item) => !failedIndexes.includes(item.index)),
              ...repaired,
            ].sort((left, right) => left.index - right.index);
            failedIndexes = issues.map((issue) => Number(issue.path[1])).filter(Number.isInteger);
            if (issues.length > 0) return { success: false, issues };

            const groupIssues = validateGroup(preservedCharacters);
            if (groupIssues.length > 0) {
              failedIndexes = [...new Set(groupIssues.map((issue) => Number(issue.path[1])).filter(Number.isInteger))];
              preservedCharacters = preservedCharacters.filter((item) => !failedIndexes.includes(item.index));
              return { success: false, issues: groupIssues };
            }
            try {
              const candidates = preservedCharacters.map((item) => item.character);
              const canonicalInputs = canonicalModelCandidate(() =>
                decodeScriptCharacterInputs(candidates));
              const canonicalCharacters = canonicalInputs.map((input, index): ScriptCharacter => ({
                ...input,
                id: input.id ?? candidates[index]!.id,
                projectId,
                revision: candidates[index]!.revision,
                updatedAt: candidates[index]!.updatedAt,
              }));
              canonicalModelCandidate(() => validateScriptCharacterSet(canonicalCharacters, {
                maxPrimaryCharacters: plan.maxPrimaryCharacters,
              }));
              return { success: true, value: canonicalCharacters };
            } catch (error) {
              failedIndexes = preservedCharacters.map((item) => item.index);
              preservedCharacters = [];
              return {
                success: false,
                issues: [{
                  path: ['characters'],
                  code: 'character.canonical.invalid',
                  message: error instanceof Error ? error.message : String(error),
                }],
              };
            }
          },
        });
        const generated = await this.generateNodeStructured({
          node: 'character_bible', projectId, prompt, signal,
        }, characterContract);
        signal?.throwIfAborted();
        const saved = await this.dependencies.store.saveCharacters(projectId, generated, 0);
        const artifactRevision = await this.nextCheckpointArtifactRevision(
          projectId,
          'script_bible',
          { node: 'character_bible' },
        );
        await this.dependencies.checkpoints.save({
          projectId, runKey: 'script_bible', node: 'character_bible', status: 'succeeded',
          attempt: 1,
          artifactRevision,
          artifact: saved,
          inputRevisionRefs: characterInputRevisionRefs,
          upstreamArtifactRefs: [],
          promptVersion: characterPromptVersion,
          configRevision: characterConfigRevision,
          inputFingerprint: characterInputFingerprint,
          validationErrors: [],
          updatedAt: now,
        });
        return saved;
      } catch (error) {
        const artifactRevision = await this.nextCheckpointArtifactRevision(
          projectId,
          'script_bible',
          { node: 'character_bible' },
        );
        await this.dependencies.checkpoints.save({
          projectId, runKey: 'script_bible', node: 'character_bible',
          status: error instanceof ScriptStructuredNeedsReviewError ? 'needs_review' : 'failed',
          attempt: 1, artifactRevision,
          artifact: {
            validCharacters: preservedCharacters.map((item) => item.character),
            failedCharacterIndexes: failedIndexes,
          },
          inputRevisionRefs: characterInputRevisionRefs,
          upstreamArtifactRefs: [],
          promptVersion: characterPromptVersion,
          configRevision: characterConfigRevision,
          inputFingerprint: characterInputFingerprint,
          validationErrors: [{ code: 'CHARACTER_BIBLE_FAILED', message: error instanceof Error ? error.message : String(error) }],
          updatedAt: now,
        });
        throw error;
      }
    };

    const generateWorld = async (): Promise<ScriptWorldBible> => {
      if (state.worldBible) return state.worldBible;
      try {
        const prompt = [
          '你是 WorldDesignAgent。根据策划和大纲生成结构化世界圣经。',
          '只返回 JSON，不输出思考过程。',
          '严格模板：{"era":"字符串","primaryLocations":["字符串"],"worldState":"字符串","rules":["字符串"],"transport":["字符串"],"communication":["字符串"],"organizations":["字符串"],"recurringProps":["字符串"],"forbiddenAnachronisms":["字符串"]}。不得翻译、缩写或改名任何键。',
          `策划：${JSON.stringify(plan)}`,
          `大纲：${JSON.stringify(outline)}`,
        ].join('\n');
        const generated = await this.generateNodeStructured({
          node: 'world_bible', projectId, prompt, signal,
        }, parserContract(
          'world_bible',
          '必须返回完整世界圣经对象，era、primaryLocations、worldState 及所有数组字段不可省略。',
          (value) => this.parseWorld(value, projectId, now),
        ));
        signal?.throwIfAborted();
        const saved = await this.dependencies.store.saveWorldBible(generated, 0);
        const artifactRevision = await this.nextCheckpointArtifactRevision(
          projectId,
          'script_bible',
          { node: 'world_bible' },
        );
        await this.dependencies.checkpoints.save({
          projectId, runKey: 'script_bible', node: 'world_bible', status: 'succeeded',
          attempt: 1, artifactRevision, artifact: saved, updatedAt: now,
        });
        return saved;
      } catch (error) {
        const artifactRevision = await this.nextCheckpointArtifactRevision(
          projectId,
          'script_bible',
          { node: 'world_bible' },
        );
        await this.dependencies.checkpoints.save({
          projectId, runKey: 'script_bible', node: 'world_bible',
          status: error instanceof ScriptStructuredNeedsReviewError ? 'needs_review' : 'failed',
          attempt: 1, artifactRevision,
          validationErrors: [{ code: 'WORLD_BIBLE_FAILED', message: error instanceof Error ? error.message : String(error) }],
          updatedAt: now,
        });
        throw error;
      }
    };

    const [charactersResult, worldResult] = await Promise.allSettled([
      generateCharacters(),
      generateWorld(),
    ]);
    if (charactersResult.status === 'rejected') throw charactersResult.reason;
    if (worldResult.status === 'rejected') throw worldResult.reason;
    return { kind: 'bible', characters: charactersResult.value, worldBible: worldResult.value };
  }

  private parseCharacter(
    value: Record<string, unknown>,
    projectId: string,
    now: string,
  ): ScriptCharacter {
      const id = stringField(value.id, 'id');
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
        throw new ScriptModelOutputError('模型结果字段 id 的格式无效。');
      }
      if (
        value.age !== undefined &&
        (!Number.isInteger(value.age) || (value.age as number) < 0 || (value.age as number) > 150)
      ) {
        throw new ScriptModelOutputError('模型结果字段 age 必须是 0—150 的整数。');
      }
      if (!Array.isArray(value.relationships)) {
        throw new ScriptModelOutputError('模型结果缺少数组字段 relationships。');
      }
      const relationships = value.relationships.map((candidateRelationship) => {
            const relationship = recordField(candidateRelationship, 'relationship');
            return {
              characterId: stringField(relationship.characterId, 'relationship.characterId'),
              label: stringField(relationship.label, 'relationship.label'),
              ...(optionalStringField(relationship.notes) ? { notes: optionalStringField(relationship.notes) } : {}),
            };
          });
      return {
        id,
        projectId,
        name: stringField(value.name, 'name'),
        aliases: stringsField(value.aliases, 'aliases'),
        role: enumField(value.role, 'role', ['lead', 'supporting', 'antagonist', 'minor']),
        ...(typeof value.age === 'number' ? { age: value.age } : {}),
        ...(optionalStringField(value.occupation) ? { occupation: optionalStringField(value.occupation) } : {}),
        identity: stringField(value.identity, 'identity'),
        biography: stringField(value.biography, 'biography'),
        motivation: stringField(value.motivation, 'motivation'),
        goal: stringField(value.goal, 'goal'),
        weakness: stringField(value.weakness, 'weakness'),
        arc: stringField(value.arc, 'arc'),
        appearance: stringField(value.appearance, 'appearance'),
        hairstyle: stringField(value.hairstyle, 'hairstyle'),
        physique: stringField(value.physique, 'physique'),
        defaultOutfit: stringField(value.defaultOutfit, 'defaultOutfit'),
        personality: (() => {
          const personality = stringsField(value.personality, 'personality');
          if (personality.length === 0) {
            throw new ScriptModelOutputError('模型结果字段 personality 必须至少包含一项。');
          }
          return personality;
        })(),
        skills: stringsField(value.skills, 'skills'),
        speechStyle: stringField(value.speechStyle, 'speechStyle'),
        catchphrases: stringsField(value.catchphrases, 'catchphrases'),
        relationships,
        revision: 0,
        updatedAt: now,
      };
  }

  private parseWorld(
    value: Record<string, unknown>,
    projectId: string,
    now: string,
  ): ScriptWorldBible {
    const primaryLocations = stringsField(value.primaryLocations, 'primaryLocations');
    if (primaryLocations.length === 0) {
      throw new ScriptModelOutputError('模型结果字段 primaryLocations 必须至少包含一项。');
    }
    const candidate: ScriptWorldBible = {
      projectId,
      era: stringField(value.era, 'era'),
      primaryLocations,
      worldState: stringField(value.worldState, 'worldState'),
      rules: stringsField(value.rules, 'rules'),
      transport: stringsField(value.transport, 'transport'),
      communication: stringsField(value.communication, 'communication'),
      organizations: stringsField(value.organizations, 'organizations'),
      recurringProps: stringsField(value.recurringProps, 'recurringProps'),
      forbiddenAnachronisms: stringsField(value.forbiddenAnachronisms, 'forbiddenAnachronisms'),
      revision: 0,
      updatedAt: now,
    };
    const canonical = canonicalModelCandidate(() => decodeScriptWorldBibleInput(candidate));
    return {
      ...canonical,
      projectId,
      revision: candidate.revision,
      updatedAt: candidate.updatedAt,
    };
  }

  private async generateEpisodeBatch(
    request: Extract<ScriptDirectorRequest, { task: 'script_episode_batch' }>,
  ): Promise<ScriptDirectorResult> {
    if (!Number.isInteger(request.episodeCount) || request.episodeCount < 1 || request.episodeCount > 5) {
      throw new ScriptModelOutputError('每批只能生成 1—5 集。');
    }
    if (!Number.isInteger(request.startEpisode) || request.startEpisode < 1) {
      throw new ScriptModelOutputError('起始集号必须是正整数。');
    }
    const initialState = await this.dependencies.store.getProjectState(request.projectId);
    if (!initialState?.plan || !initialState.seriesOutline || !initialState.worldBible || initialState.characters.length === 0) {
      throw new ScriptModelOutputError('生成正文前必须完成策划、全剧大纲、人物和世界圣经。');
    }
    const validatedPlan = initialState.plan;
    if (!validatedPlan) throw new ScriptModelOutputError('生成正文前必须先确认策划。');
    let state: ScriptProjectState = initialState;
    const endEpisode = request.startEpisode + request.episodeCount - 1;
    if (endEpisode > validatedPlan.totalEpisodes) {
      throw new ScriptModelOutputError('批次范围超过策划总集数。');
    }
    if ((request.startEpisode - 1) % 5 !== 0) {
      throw new ScriptModelOutputError('正文批次起始集必须是 1、6、11……');
    }
    const expectedBatchCount = Math.min(
      5,
      validatedPlan.totalEpisodes - request.startEpisode + 1,
    );
    if (request.episodeCount !== expectedBatchCount) {
      throw new ScriptModelOutputError(
        `第 ${request.startEpisode} 集批次必须包含 ${expectedBatchCount} 集。`,
      );
    }
    const hasCanonicalContinuity = (
      projectState: ScriptProjectState,
      episode: ScriptEpisode,
    ): boolean =>
      currentScriptContinuityCommits(projectState).filter((commit) =>
        commit.episodeNumber === episode.episodeNumber &&
        commit.episodeRevision === episode.revision,
      ).length === 1;
    if (request.startEpisode > 1) {
      for (let episodeNumber = 1; episodeNumber < request.startEpisode; episodeNumber += 1) {
        const previousEpisode = state.episodes.find(
          (episode) => episode.episodeNumber === episodeNumber,
        );
        if (
          !previousEpisode ||
          previousEpisode.status !== 'completed' ||
          !hasCanonicalContinuity(state, previousEpisode)
        ) {
          throw new ScriptModelOutputError(
            `开始第 ${request.startEpisode} 集批次前，第 ${episodeNumber} 集必须完成且具有匹配正文版本的连续性提交。`,
          );
        }
      }
    }
    const range = Array.from({ length: request.episodeCount }, (_, index) => request.startEpisode + index);
    const completed = state.episodes.filter(
      (episode) =>
        range.includes(episode.episodeNumber) &&
        episode.status === 'completed' &&
        hasCanonicalContinuity(state, episode),
    );
    if (completed.length === range.length) {
      return {
        kind: 'episode_batch',
        episodes: completed.sort((left, right) => left.episodeNumber - right.episodeNumber),
        reports: [],
        skippedEpisodeNumbers: [...range],
      };
    }

    const runKey = `script_episode_batch:${request.startEpisode}:${request.episodeCount}`;
    const existingCheckpoints = await this.dependencies.checkpoints.list(request.projectId, runKey);
    const configRevision = await this.modelConfigFingerprint();
    await this.invalidateRejectedEpisodeCandidates(existingCheckpoints, range);
    let plan: ScriptPlan = state.plan ?? validatedPlan;
    if (plan.status === 'approved') {
      const requestedPlanRevision = request.expectedPlanRevision;
      request.signal?.throwIfAborted();
      plan = await this.dependencies.store.savePlan(
        { ...plan, status: 'locked', updatedAt: this.now() },
        requestedPlanRevision,
      );
      const inputRevisionRefs = [{
        resource: 'plan' as const,
        id: plan.id,
        revision: plan.revision,
      }];
      const promptVersion = 'plan-lock-v1';
      const inputFingerprint = computeScriptCheckpointInputFingerprint({
        node: 'plan',
        inputRevisionRefs,
        promptVersion,
        configRevision: PLAN_LOCK_CONFIG_REVISION,
      });
      const artifactRevision = await this.nextCheckpointArtifactRevision(
        request.projectId,
        runKey,
        { node: 'plan' },
      );
      await this.saveCheckpoint(request, {
        projectId: request.projectId,
        runKey,
        node: 'plan',
        status: 'succeeded',
        attempt: 1,
        artifactRevision,
        artifact: {
          planId: plan.id,
          requestedPlanRevision,
          lockedPlanRevision: plan.revision,
        },
        inputRevisionRefs,
        upstreamArtifactRefs: [],
        promptVersion,
        configRevision: PLAN_LOCK_CONFIG_REVISION,
        inputFingerprint,
        validationErrors: [],
        updatedAt: this.now(),
      }, '剧本策划已锁定。');
    } else if (plan.status !== 'locked') {
      throw new ScriptModelOutputError('策划修订版已变更，请重新创建批次。');
    } else if (plan.revision !== request.expectedPlanRevision) {
      const inputRevisionRefs = [{
        resource: 'plan' as const,
        id: plan.id,
        revision: plan.revision,
      }];
      const inputFingerprint = computeScriptCheckpointInputFingerprint({
        node: 'plan',
        inputRevisionRefs,
        promptVersion: 'plan-lock-v1',
        configRevision: PLAN_LOCK_CONFIG_REVISION,
      });
      const checkpoint = latestScriptCheckpoint(existingCheckpoints, { node: 'plan' });
      const artifact = checkpoint?.artifact;
      const verified = checkpoint &&
        decideScriptCheckpointResume(checkpoint, inputFingerprint).disposition === 'reuse' &&
        typeof artifact === 'object' &&
        artifact !== null &&
        !Array.isArray(artifact) &&
        (artifact as Record<string, unknown>).planId === plan.id &&
        (artifact as Record<string, unknown>).requestedPlanRevision === request.expectedPlanRevision &&
        (artifact as Record<string, unknown>).lockedPlanRevision === plan.revision;
      if (!verified) {
        if (checkpoint) await this.markCheckpointStale(checkpoint);
        throw new ScriptModelOutputError('策划修订版已变更，请重新创建批次。');
      }
    }

    state = (await this.dependencies.store.getProjectState(request.projectId)) ?? state;
    const seriesOutline = state.seriesOutline;
    if (!seriesOutline) {
      throw new ScriptModelOutputError('生成正文前必须先生成全剧大纲。');
    }
    let outlines = state.episodeOutlines.filter((outline) => range.includes(outline.episodeNumber));
    const missingOutlineNumbers = range.filter(
      (episodeNumber) => !outlines.some((outline) => outline.episodeNumber === episodeNumber),
    );
    if (missingOutlineNumbers.length > 0) {
      const registeredCharacterIds = new Set(
        state.characters.map((character) => character.id),
      );
      const episodeOutlineInputRevisionRefs = buildScriptInputRevisionRefs(
        state,
        request.startEpisode,
      );
      const episodeOutlineUpstreamArtifactRefs = [buildScriptUpstreamArtifactRef(
        'episode_outline_range',
        request.startEpisode,
        {
          missingOutlineNumbers,
          cards: seriesOutline.episodeCards.filter((card) => range.includes(card.episodeNumber)),
          continuity: projectScriptContinuity(state, request.startEpisode),
        },
      )];
      const episodeOutlinePromptVersion = 'episode-outline-batch-v2';
      const episodeOutlineInputFingerprint = computeScriptCheckpointInputFingerprint({
        node: 'episode_outline',
        inputRevisionRefs: episodeOutlineInputRevisionRefs,
        upstreamArtifactRefs: episodeOutlineUpstreamArtifactRefs,
        promptVersion: episodeOutlinePromptVersion,
        configRevision,
      });
      const prompt = [
        '你是 EpisodeOutlineAgent。只展开当前 1—5 集详细大纲。',
        '只返回 JSON {"outlines":[...]} ，每集必须有冲突、节拍和结尾卡点。',
        '每项严格模板：{"episodeNumber":1,"title":"字符串","goal":"字符串","conflict":"字符串","beats":["字符串"],"characterIds":["人物id"],"plannedScenes":[],"reveal":"可选字符串","reversal":"可选字符串","endingHook":"字符串","requiredFacts":["字符串"],"forbiddenFacts":["字符串"]}。plannedScenes 必须原样返回空数组 []，场景由下一节点规划；不得改名任何键。',
        `characterIds 只能从以下人物 ID 白名单选择：${JSON.stringify([...registeredCharacterIds])}。`,
        `需要集号：${missingOutlineNumbers.join('、')}`,
        `策划：${JSON.stringify(plan)}`,
        `分集卡：${JSON.stringify(seriesOutline.episodeCards.filter((card) => range.includes(card.episodeNumber)))}`,
        `当前连续性：${JSON.stringify({
          aggregate: projectScriptContinuity(state, request.startEpisode),
          recentCommits: currentScriptContinuityCommits(state).slice(-2),
        })}`,
      ].join('\n');
      const episodeOutlineContract = parserContract(
        'episode_outlines',
        '根对象必须包含 outlines 数组；每个所需集号恰好出现一次且各字段完整。',
        (value) => {
          if (!Array.isArray(value.outlines)) {
            throw new ScriptModelOutputError('详细分集大纲字段 outlines 必须是数组。');
          }
          const parsed = value.outlines.map((candidate) => {
            const parsedCandidate = this.parseEpisodeOutline(
              recordField(candidate, 'episodeOutline'),
              request.projectId,
              registeredCharacterIds,
            );
            return this.canonicalEpisodeOutlineCandidate(
              parsedCandidate,
              plan,
              parsedCandidate.episodeNumber,
            );
          });
          parsed.sort((left, right) => left.episodeNumber - right.episodeNumber);
          if (
            parsed.length !== missingOutlineNumbers.length ||
            parsed.some((item, index) => item.episodeNumber !== missingOutlineNumbers[index])
          ) {
            throw new ScriptModelOutputError(
              `详细分集大纲必须唯一连续覆盖 ${missingOutlineNumbers.join('、')} 集。`,
            );
          }
          return parsed;
        },
      );
      const storedEpisodeOutlines = await this.latestCheckpoint(
        request.projectId,
        runKey,
        { node: 'episode_outline', episodeNumber: request.startEpisode },
      );
      let generated: ScriptEpisodeOutline[] | undefined;
      let artifactRevision: number | undefined;
      if (storedEpisodeOutlines) {
        const decision = decideScriptCheckpointResume(
          storedEpisodeOutlines,
          episodeOutlineInputFingerprint,
        );
        if (decision.disposition === 'reuse' && storedEpisodeOutlines.artifact !== undefined) {
          const decoded = episodeOutlineContract.decode({
            outlines: storedEpisodeOutlines.artifact,
          });
          if (decoded.success) {
            generated = decoded.value;
            artifactRevision = storedEpisodeOutlines.artifactRevision;
          } else {
            await this.markCheckpointStale(storedEpisodeOutlines);
          }
        } else if (decision.disposition === 'stale') {
          await this.markCheckpointStale(storedEpisodeOutlines);
        }
      }
      generated ??= await this.generateNodeStructured({
        node: 'episode_outline',
        projectId: request.projectId,
        prompt,
        signal: request.signal,
      }, episodeOutlineContract);
      for (const episodeNumber of missingOutlineNumbers) {
        const outline = generated.find((item) => item.episodeNumber === episodeNumber);
        if (!outline) throw new ScriptModelOutputError(`详细大纲缺少第 ${episodeNumber} 集。`);
        // This is an in-memory/checkpoint candidate until ScenePlanner supplies
        // plannedScenes. ScriptService's canonical validator intentionally
        // rejects an empty scene plan, so no formal store write is allowed yet.
        outlines.push(outline);
      }
      artifactRevision ??= await this.nextCheckpointArtifactRevision(
          request.projectId,
          runKey,
          { node: 'episode_outline', episodeNumber: request.startEpisode },
        );
      await this.saveCheckpoint(request, {
        projectId: request.projectId,
        runKey,
        node: 'episode_outline',
        status: 'completed',
        attempt: 1,
        artifactRevision,
        episodeNumber: request.startEpisode,
        artifact: generated,
        inputRevisionRefs: episodeOutlineInputRevisionRefs,
        upstreamArtifactRefs: episodeOutlineUpstreamArtifactRefs,
        promptVersion: episodeOutlinePromptVersion,
        configRevision,
        inputFingerprint: episodeOutlineInputFingerprint,
        validationErrors: [],
        updatedAt: this.now(),
      }, `已保存第 ${request.startEpisode}—${endEpisode} 集详细大纲。`);
    }

    const reports: Array<{ episodeNumber: number; report: ScriptGateReport }> = [];
    const episodes: ScriptEpisode[] = [];
    const skippedEpisodeNumbers: number[] = [];
    for (const episodeNumber of range) {
      const episodeUpstreamRefs: ScriptUpstreamArtifactRef[] = [];
      state = (await this.dependencies.store.getProjectState(request.projectId)) ?? state;
      const alreadyCompleted = state.episodes.find(
        (episode) =>
          episode.episodeNumber === episodeNumber &&
          episode.status === 'completed' &&
          hasCanonicalContinuity(state, episode),
      );
      if (alreadyCompleted) {
        episodes.push(alreadyCompleted);
        skippedEpisodeNumbers.push(episodeNumber);
        continue;
      }
      let outline = state.episodeOutlines.find((item) => item.episodeNumber === episodeNumber)
        ?? outlines.find((item) => item.episodeNumber === episodeNumber);
      if (!outline) throw new ScriptModelOutputError(`第 ${episodeNumber} 集详细大纲不存在。`);
      let scenePlanArtifact: ScriptScenePlanArtifact | undefined;
      let scenePlanCheckpointRevision: number | undefined;
      if (outline.plannedScenes.length === 0) {
        const currentEpisodeRevision = state.episodes.find(
          (episode) => episode.episodeNumber === episodeNumber,
        )?.revision ?? 0;
        const inputRevisionRefs = buildScriptInputRevisionRefs(state, episodeNumber);
        const promptVersion = 'scene-plan-v2';
        const inputFingerprint = computeScriptCheckpointInputFingerprint({
          node: 'scene_plan',
          inputRevisionRefs,
          promptVersion,
          configRevision,
        });
        const storedCheckpoint = await this.latestCheckpoint(
          request.projectId,
          runKey,
          { node: 'scene_plan', episodeNumber },
        );
        let plannedScenes: ScriptPlannedScene[] | undefined;
        if (storedCheckpoint) {
          const decision = decideScriptCheckpointResume(storedCheckpoint, inputFingerprint);
          if (decision.disposition === 'reuse' && storedCheckpoint.artifact !== undefined) {
            try {
              scenePlanArtifact = decodeScriptScenePlanArtifact(storedCheckpoint.artifact, {
                projectId: request.projectId,
                episodeNumber,
                baseEpisodeRevision: currentEpisodeRevision,
                inputFingerprint,
              });
              plannedScenes = scenePlanArtifact.plannedScenes;
              scenePlanCheckpointRevision = storedCheckpoint.artifactRevision;
            } catch {
              await this.markCheckpointStale(storedCheckpoint);
            }
          } else if (decision.disposition === 'stale') {
            await this.markCheckpointStale(storedCheckpoint);
          }
        }
        const prompt = [
          '你是 EpisodeScenePlanner。将详细大纲确认为 1—5 个可拍摄场景。',
          '只返回 JSON {"plannedScenes":[...]}。',
          '每个场景严格使用 {"ordinal":1,"location":"地点","timeOfDay":"day|night|dawn|dusk","interiorExterior":"interior|exterior","purpose":"场景目的"}，场号从1连续递增，不得改名任何键。',
          '每个场景必须承担不同的戏剧任务，依次完成开场抓人、冲突升级、反转或结尾卡点；地点要具体且可拍摄，禁止用“某处”“未知地点”等占位词。',
          '优先复用人物与世界圣经已有地点，控制换景成本；结尾卡点必须落实在最后一个场景的 purpose 中。',
          `场景上限：${plan.maxScenesPerEpisode}`,
          `大纲：${JSON.stringify(outline)}`,
        ].join('\n');
        if (!plannedScenes) {
          plannedScenes = await this.generateNodeStructured({
            node: 'scene_plan',
            projectId: request.projectId,
            episodeNumber,
            prompt,
            signal: request.signal,
          }, parserContract(
            'scene_plan',
            `必须返回 plannedScenes 数组，包含 1—${plan.maxScenesPerEpisode} 个字段完整且场号唯一的场景。`,
            (value) => this.parsePlannedScenes(value.plannedScenes, plan.maxScenesPerEpisode),
          ));
          scenePlanArtifact = buildScriptScenePlanArtifact({
            projectId: request.projectId,
            episodeNumber,
            baseEpisodeRevision: currentEpisodeRevision,
            inputRevisionRefs,
            promptVersion,
            configRevision,
            createdAt: this.now(),
          }, plannedScenes);
          scenePlanCheckpointRevision = await this.nextCheckpointArtifactRevision(
            request.projectId,
            runKey,
            { node: 'scene_plan', episodeNumber },
          );
        }
        if (!scenePlanArtifact) {
          throw new ScriptModelOutputError(`第 ${episodeNumber} 集场景计划候选无法恢复。`);
        }
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'scene_plan',
          status: 'succeeded',
          attempt: 1,
          artifactRevision: scenePlanCheckpointRevision ?? await this.nextCheckpointArtifactRevision(
            request.projectId,
            runKey,
            { node: 'scene_plan', episodeNumber },
          ),
          episodeNumber,
          artifact: scenePlanArtifact,
          ...checkpointArtifactMetadata(scenePlanArtifact),
          updatedAt: this.now(),
        }, `第 ${episodeNumber} 集场景计划候选已写入检查点。`);
        request.signal?.throwIfAborted();
        const outlineCandidate = this.canonicalEpisodeOutlineCandidate(
          { ...outline, plannedScenes },
          plan,
          episodeNumber,
        );
        outline = await this.dependencies.store.saveEpisodeOutline(
          outlineCandidate,
          outline.revision,
        );
      }

      state = (await this.dependencies.store.getProjectState(request.projectId)) ?? state;
      // Canonicalize again after saveEpisodeOutline increments its revision.
      // Draft fingerprints must bind to this post-save artifact on both the
      // initial run and every resume.
      const confirmedSceneInputRevisionRefs = buildScriptInputRevisionRefs(state, episodeNumber);
      const confirmedSceneBaseEpisodeRevision = state.episodes.find(
        (episode) => episode.episodeNumber === episodeNumber,
      )?.revision ?? 0;
      const confirmedSceneInputFingerprint = computeScriptCheckpointInputFingerprint({
        node: 'scene_plan',
        inputRevisionRefs: confirmedSceneInputRevisionRefs,
        promptVersion: 'scene-plan-v2',
        configRevision,
      });
      const confirmedStoredScenePlan = await this.latestCheckpoint(
        request.projectId,
        runKey,
        { node: 'scene_plan', episodeNumber },
      );
      if (confirmedStoredScenePlan) {
        const decision = decideScriptCheckpointResume(
          confirmedStoredScenePlan,
          confirmedSceneInputFingerprint,
        );
        if (decision.disposition === 'reuse' && confirmedStoredScenePlan.artifact !== undefined) {
          try {
            scenePlanArtifact = decodeScriptScenePlanArtifact(
              confirmedStoredScenePlan.artifact,
              {
                projectId: request.projectId,
                episodeNumber,
                baseEpisodeRevision: confirmedSceneBaseEpisodeRevision,
                inputFingerprint: confirmedSceneInputFingerprint,
              },
            );
            scenePlanCheckpointRevision = confirmedStoredScenePlan.artifactRevision;
          } catch {
            await this.markCheckpointStale(confirmedStoredScenePlan);
            scenePlanArtifact = undefined;
          }
        } else if (decision.disposition === 'stale') {
          await this.markCheckpointStale(confirmedStoredScenePlan);
          scenePlanArtifact = undefined;
        } else {
          scenePlanArtifact = undefined;
        }
      }
      if (!scenePlanArtifact) {
        const preservedCreatedAt = (() => {
          const artifact = confirmedStoredScenePlan?.artifact;
          if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
            return undefined;
          }
          const createdAt = (artifact as Record<string, unknown>).createdAt;
          return typeof createdAt === 'string' && createdAt ? createdAt : undefined;
        })();
        scenePlanArtifact = buildScriptScenePlanArtifact({
          projectId: request.projectId,
          episodeNumber,
          baseEpisodeRevision: confirmedSceneBaseEpisodeRevision,
          inputRevisionRefs: confirmedSceneInputRevisionRefs,
          promptVersion: 'scene-plan-v2',
          configRevision,
          createdAt: preservedCreatedAt ?? this.now(),
        }, outline.plannedScenes);
        scenePlanCheckpointRevision = await this.nextCheckpointArtifactRevision(
          request.projectId,
          runKey,
          { node: 'scene_plan', episodeNumber },
        );
      }
      await this.saveCheckpoint(request, {
        projectId: request.projectId,
        runKey,
        node: 'scene_plan',
        status: 'succeeded',
        attempt: 1,
        artifactRevision: scenePlanCheckpointRevision!,
        episodeNumber,
        artifact: scenePlanArtifact,
        ...checkpointArtifactMetadata(scenePlanArtifact),
        updatedAt: this.now(),
      }, `第 ${episodeNumber} 集场景计划已确认。`);
      const scenePlanRef = buildScriptUpstreamArtifactRef(
        'scene_plan',
        scenePlanCheckpointRevision!,
        scenePlanArtifact,
      );
      episodeUpstreamRefs.push(scenePlanRef);
      const draftInputRevisionRefs = buildScriptInputRevisionRefs(state, episodeNumber);
      const draftPromptVersion = 'episode-draft-v2';
      const currentEpisodeRevision = state.episodes.find(
        (episode) => episode.episodeNumber === episodeNumber,
      )?.revision ?? 0;
      const draftInputFingerprint = computeScriptCheckpointInputFingerprint({
        node: 'draft',
        inputRevisionRefs: draftInputRevisionRefs,
        upstreamArtifactRefs: [scenePlanRef],
        promptVersion: draftPromptVersion,
        configRevision,
      });
      let draftArtifact: ScriptEpisodeCandidateArtifact | undefined;
      let draftCheckpointRevision: number | undefined;
      let draft = state.episodes.find(
        (episode) => episode.episodeNumber === episodeNumber && episode.status === 'reviewing',
      );
      if (!draft) {
        const currentEpisode = state.episodes.find((item) => item.episodeNumber === episodeNumber);
        const storedDraft = await this.latestCheckpoint(
          request.projectId,
          runKey,
          { node: 'draft', episodeNumber },
        );
        if (storedDraft) {
          const decision = decideScriptCheckpointResume(storedDraft, draftInputFingerprint);
          if (decision.disposition === 'reuse' && storedDraft.artifact !== undefined) {
            try {
              draftArtifact = decodeScriptEpisodeCandidateArtifact(storedDraft.artifact, {
                projectId: request.projectId,
                episodeNumber,
                baseEpisodeRevision: currentEpisodeRevision,
                inputFingerprint: draftInputFingerprint,
              });
              draft = this.canonicalEpisodeCandidate(
                draftArtifact.episode,
                plan,
                episodeNumber,
              );
              draftCheckpointRevision = storedDraft.artifactRevision;
            } catch {
              await this.markCheckpointStale(storedDraft);
              draftArtifact = undefined;
              draft = undefined;
            }
          } else if (decision.disposition === 'stale') {
            await this.markCheckpointStale(storedDraft);
          }
        }
        const prompt = [
          '你是 ScriptWriterAgent。一次生成当前单集的结构化短剧正文。',
          '只返回 JSON，不输出思考过程、Markdown 或提示词。',
          '严格顶层模板：{"episodeNumber":1,"title":"字符串","scenes":[...],"summary":"可为空字符串","newFacts":[],"openedThreads":[],"closedThreads":[]}。',
          '每个 scene 严格包含 ordinal, location, timeOfDay(day|night|dawn|dusk), interiorExterior(interior|exterior), characterIds, blocks。每个 block 的 type 只能是 caption/action/dialogue 且必须有 text；dialogue 还必须有已登记人物的 characterId、speaker，可选 delivery 和 mode(normal|os|vo)。不得改名任何键。',
          'blocks.text 只写内容本身：caption 不要包“【字幕：】”，action 不要带“△”，dialogue 不要重复说话人或冒号；这些格式由序列化器统一添加。',
          'scene.characterIds 必须列出本场所有实际出场或说话人物，且对白 speaker 与 characterId 必须一一匹配。普通对白 mode 使用 normal；只有画外音和内心独白才使用 vo/os。',
          '正文必须是可拍摄的竖屏短剧：前三个正文块内出现人物、处境与冲突；动作使用镜头可见行为，避免小说式心理概述；单句对白简洁、有对抗性，不写大段说教。',
          '首次出现的重要人物或地点可用 caption 交代身份；后续不得机械重复字幕。最后一至两个正文块必须兑现本集 endingHook，以反转、证据、人物闯入或未完成动作收尾。',
          '严格遵守大纲 requiredFacts 与 forbiddenFacts；继承上一集结尾状态、服装、道具、人物已知信息和未回收伏笔，禁止让角色无理由换装、瞬移或提前知道秘密。',
          scriptLengthInstruction(plan.targetCharsPerEpisode),
          `所有 blocks.text 去除空白后的总字符数以 ${plan.targetCharsPerEpisode} 为目标，必须在 ${Math.ceil(plan.targetCharsPerEpisode * 0.85)}—${Math.floor(plan.targetCharsPerEpisode * 1.15)} 之间；请在返回前逐块相加核对，优先贴近目标值。`,
          `对白只能使用这些已登记人物：${JSON.stringify(state.characters.map((character) => ({ id: character.id, name: character.name })))}`,
          this.assembleEpisodeContext(state, plan, outline, episodeNumber),
        ].join('\n');
        if (!draft) {
          draft = await this.generateNodeStructured({
            node: 'draft',
            projectId: request.projectId,
            episodeNumber,
            prompt,
            signal: request.signal,
          }, parserContract(
            'episode_draft',
            '必须返回完整单集对象；scenes、每场 blocks 及所有正文块的类型必填字段不可省略。',
            (value) => this.parseEpisode(
              value,
              request.projectId,
              outline,
              plan,
              currentEpisode,
            ),
          ));
        }
      }
      draft = this.canonicalEpisodeCandidate(draft, plan, episodeNumber);
      draftArtifact ??= buildScriptEpisodeCandidateArtifact({
        projectId: request.projectId,
        episodeNumber,
        baseEpisodeRevision: currentEpisodeRevision,
        inputRevisionRefs: draftInputRevisionRefs,
        upstreamArtifactRefs: [scenePlanRef],
        promptVersion: draftPromptVersion,
        configRevision,
        createdAt: this.now(),
      }, 'draft', draft);
      draftCheckpointRevision ??= await this.nextCheckpointArtifactRevision(
        request.projectId,
        runKey,
        { node: 'draft', episodeNumber },
      );
      await this.saveCheckpoint(request, {
        projectId: request.projectId,
        runKey,
        node: 'draft',
        status: 'succeeded',
        attempt: 1,
        artifactRevision: draftCheckpointRevision,
        episodeNumber,
        artifact: draftArtifact,
        ...checkpointArtifactMetadata(draftArtifact),
        updatedAt: this.now(),
      }, `第 ${episodeNumber} 集初稿候选已写入检查点，进入审查。`);
      let currentCandidateRef = buildScriptUpstreamArtifactRef(
        'draft',
        draftCheckpointRevision,
        draftArtifact,
      );
      episodeUpstreamRefs.push(currentCandidateRef);

      if (!state) throw new ScriptModelOutputError('短剧项目状态丢失。');
      const reviewState = state;
      const reviewDraft = async (
        candidate: ScriptEpisode,
        attempt: number,
        candidateRef: ScriptUpstreamArtifactRef,
      ): Promise<{
        value: ReturnType<ScriptDirector['parseReview']>;
        artifactRef: ScriptUpstreamArtifactRef;
      }> => {
        const inputRevisionRefs = buildScriptInputRevisionRefs(reviewState, episodeNumber);
        const upstreamArtifactRefs = [candidateRef];
        const promptVersion = 'script-review-v2';
        const inputFingerprint = computeScriptCheckpointInputFingerprint({
          node: 'review',
          inputRevisionRefs,
          upstreamArtifactRefs,
          promptVersion,
          configRevision,
        });
        const prompt = [
          '你是 ScriptContinuityAgent。只返回定位到场景/字段的结构化问题与记忆写回。',
          '只返回 JSON，字段：issues, summary, newFacts, openedThreads, closedThreads, wardrobe。',
          '严格模板：{"issues":[{"code":"字符串","severity":"hard|soft","message":"字符串","sceneId":"可选","path":"可选"}],"summary":"150—300字摘要","newFacts":["字符串"],"openedThreads":["字符串"],"closedThreads":["字符串"],"wardrobe":[{"characterId":"人物id","outfit":"服装"}]}。没有问题时 issues 返回空数组，不得改名任何键。',
          '逐项检查：人物身份与口吻、场景人物和说话人、时间地点衔接、服装道具、人物已知信息、requiredFacts、forbiddenFacts、重复台词、不可拍摄动作、冲突升级、反转铺垫和结尾卡点。',
          '会造成剧情矛盾、人物串线、关键事实缺失、结尾无卡点或无法拍摄的问题标为 hard；措辞、节奏、对白密度等可优化项标为 soft。每条问题必须尽量给出 sceneId 和精确 path。',
          attempt > 1 ? '这是修订后复检。不得假设上一轮问题已解决，必须以当前正文重新判断。' : '',
          `策划：${JSON.stringify(plan)}`,
          `大纲：${JSON.stringify(outline)}`,
          `连续性：${JSON.stringify({
            aggregate: projectScriptContinuity(reviewState, episodeNumber),
            recentCommits: currentScriptContinuityCommits(reviewState)
              .filter((commit) => commit.episodeNumber < episodeNumber)
              .slice(-2),
          })}`,
          `正文：${JSON.stringify(candidate)}`,
        ].filter(Boolean).join('\n');
        const storedReview = await this.latestCheckpoint(
          request.projectId,
          runKey,
          { node: 'review', episodeNumber, chunkStart: attempt },
        );
        let parsedReview: ReturnType<ScriptDirector['parseReview']> | undefined;
        let reviewCheckpointRevision: number | undefined;
        if (storedReview) {
          const decision = decideScriptCheckpointResume(storedReview, inputFingerprint);
          if (decision.disposition === 'reuse' && storedReview.artifact !== undefined) {
            try {
              parsedReview = this.parseReview(recordField(storedReview.artifact, 'reviewArtifact'));
              reviewCheckpointRevision = storedReview.artifactRevision;
            } catch {
              await this.markCheckpointStale(storedReview);
            }
          } else if (decision.disposition === 'stale') {
            await this.markCheckpointStale(storedReview);
          }
        }
        parsedReview ??= await this.generateNodeStructured({
          node: 'review',
          projectId: request.projectId,
          episodeNumber,
          prompt,
          signal: request.signal,
        }, parserContract(
          'script_review',
          '必须返回 issues、summary、newFacts、openedThreads、closedThreads、wardrobe 全部字段；summary 不可为空。',
          (value) => this.parseReview(value),
        ));
        reviewCheckpointRevision ??= await this.nextCheckpointArtifactRevision(
          request.projectId,
          runKey,
          { node: 'review', episodeNumber, chunkStart: attempt },
        );
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'review',
          status: 'succeeded',
          attempt,
          artifactRevision: reviewCheckpointRevision,
          episodeNumber,
          chunkStart: attempt,
          artifact: parsedReview,
          inputRevisionRefs,
          upstreamArtifactRefs,
          promptVersion,
          configRevision,
          inputFingerprint,
          validationErrors: [],
          updatedAt: this.now(),
        }, attempt > 1
          ? `第 ${episodeNumber} 集修订后复检完成。`
          : `第 ${episodeNumber} 集审查完成。`);
        return {
          value: parsedReview,
          artifactRef: buildScriptUpstreamArtifactRef(
            'review',
            reviewCheckpointRevision,
            parsedReview,
          ),
        };
      };
      let reviewed = await reviewDraft(draft, 1, currentCandidateRef);
      let review = reviewed.value;
      let currentReviewRef = reviewed.artifactRef;
      episodeUpstreamRefs.push(reviewed.artifactRef);
      draft = {
        ...draft,
        summary: review.summary,
        newFacts: review.newFacts,
        openedThreads: review.openedThreads,
        closedThreads: review.closedThreads,
        updatedAt: this.now(),
      };
      const validateDraft = (
        candidate: ScriptEpisode,
        reviewIssues?: readonly ScriptGateIssue[],
      ): ScriptGateReport => validateScriptEpisode(candidate, plan, {
        expectedEpisodeNumber: episodeNumber,
        registeredCharacterIds: new Set(reviewState.characters.map((character) => character.id)),
        registeredCharacterNames: new Set(reviewState.characters.map((character) => character.name)),
        characterNamesById: new Map(reviewState.characters.map((character) => [character.id, character.name])),
        outline,
        previousEpisode: reviewState.episodes
          .filter((item) => item.episodeNumber < episodeNumber)
          .sort((left, right) => right.episodeNumber - left.episodeNumber)[0],
        continuity: projectScriptContinuity(reviewState, episodeNumber),
        ...(reviewIssues ? { reviewIssues } : {}),
      });
      let deterministicReport = validateDraft(draft);
      let report = validateDraft(
        draft,
        review.issues.map((issue) => ({ ...issue, source: 'ai' })),
      );

      const initialExpansionOnly =
        report.blockingIssues.length > 0 &&
        report.blockingIssues.every((issue) => issue.code === 'TOO_SHORT');
      const maxRevisionRounds = initialExpansionOnly ? 2 : 1;
      for (
        let revisionRound = 1;
        report.hardFailed && revisionRound <= maxRevisionRounds;
        revisionRound += 1
      ) {
        const expansionOnly =
          report.blockingIssues.length > 0 &&
          report.blockingIssues.every((issue) => issue.code === 'TOO_SHORT');
        const revisionInputRevisionRefs = buildScriptInputRevisionRefs(reviewState, episodeNumber);
        const revisionUpstreamArtifactRefs = [currentCandidateRef, currentReviewRef];
        const revisionPromptVersion = 'script-revision-patch-v2';
        const revisionInputFingerprint = computeScriptCheckpointInputFingerprint({
          node: 'revision',
          inputRevisionRefs: revisionInputRevisionRefs,
          upstreamArtifactRefs: revisionUpstreamArtifactRefs,
          promptVersion: revisionPromptVersion,
          configRevision,
        });
        const storedRevision = await this.latestCheckpoint(
          request.projectId,
          runKey,
          { node: 'revision', episodeNumber, chunkStart: revisionRound },
        );
        const rejectedRevisionFeedback = storedRevision &&
          (storedRevision.status === 'needs_review' || storedRevision.status === 'stale')
          ? storedRevision.validationErrors
          : [];
        let patchedArtifact: ScriptEpisodeCandidateArtifact | undefined;
        let revisionCheckpointRevision: number | undefined;
        const rejectRevisionPatch = async (
          error: ScriptRevisionPatchError,
        ): Promise<never> => {
          const patchIssue: ScriptEvaluatedGateIssue = {
            code: 'REVISION_PATCH_REJECTED',
            severity: 'hard',
            source: 'deterministic',
            blocking: true,
            message: error.message,
            path: 'revision.operations',
          };
          report = {
            ...report,
            hardFailed: true,
            issues: [...report.issues, patchIssue],
            blockingIssues: [...report.blockingIssues, patchIssue],
          };
          const rejectedArtifact = buildScriptEpisodeCandidateArtifact({
            projectId: request.projectId,
            episodeNumber,
            baseEpisodeRevision: currentEpisodeRevision,
            inputRevisionRefs: revisionInputRevisionRefs,
            upstreamArtifactRefs: revisionUpstreamArtifactRefs,
            promptVersion: revisionPromptVersion,
            configRevision,
            validationErrors: [{
              path: 'revision.operations',
              code: patchIssue.code,
              message: patchIssue.message,
            }],
            createdAt: this.now(),
          }, 'patched', draft!);
          const rejectedRevision = await this.nextCheckpointArtifactRevision(
            request.projectId,
            runKey,
            { node: 'revision', episodeNumber, chunkStart: revisionRound },
          );
          await this.saveCheckpoint(request, {
            projectId: request.projectId,
            runKey,
            node: 'revision',
            status: 'needs_review',
            attempt: revisionRound,
            artifactRevision: rejectedRevision,
            episodeNumber,
            chunkStart: revisionRound,
            artifact: rejectedArtifact,
            ...checkpointArtifactMetadata(rejectedArtifact),
            updatedAt: this.now(),
          }, `第 ${episodeNumber} 集修订补丁越界，等待人工处理。`);
          throw new ScriptBatchPausedError(episodeNumber, report);
        };
        if (storedRevision) {
          const decision = decideScriptCheckpointResume(storedRevision, revisionInputFingerprint);
          if (decision.disposition === 'reuse' && storedRevision.artifact !== undefined) {
            try {
              patchedArtifact = decodeScriptEpisodeCandidateArtifact(storedRevision.artifact, {
                projectId: request.projectId,
                episodeNumber,
                baseEpisodeRevision: currentEpisodeRevision,
                inputFingerprint: revisionInputFingerprint,
              });
              draft = this.canonicalEpisodeCandidate(
                patchedArtifact.episode,
                plan,
                episodeNumber,
              );
              revisionCheckpointRevision = storedRevision.artifactRevision;
            } catch {
              await this.markCheckpointStale(storedRevision);
              patchedArtifact = undefined;
            }
          } else if (decision.disposition === 'stale') {
            await this.markCheckpointStale(storedRevision);
          }
        }
        if (!patchedArtifact) {
          let revisionPolicy;
          try {
            revisionPolicy = buildScriptRevisionPatchPolicy(
              draft,
              report.blockingIssues,
              { registeredCharacterIds: state.characters.map((character) => character.id) },
            );
          } catch (error) {
            if (!(error instanceof ScriptRevisionPatchError)) throw error;
            await rejectRevisionPatch(error);
          }
          const patch = await this.generateNodeStructured({
            node: 'revision',
            projectId: request.projectId,
            episodeNumber,
            prompt: [
              '你是 ScriptRevisionAgent。只返回版本化 Patch JSON，不得返回完整 Episode。',
              '顶层严格为 {"operations":[...]}。允许操作只有 replaceBlockText、insertBlockAfter、appendBlock、updateSceneCharacters。',
              '禁止删除场景或正文块、重排场景、替换整集、修改集号/outlineId/既有 id，禁止触碰未被阻断错误定位的内容。',
              'replaceBlockText 使用 {"op":"replaceBlockText","sceneId":"...","blockId":"...","text":"..."}；insertBlockAfter 使用 {"op":"insertBlockAfter","sceneId":"...","afterBlockId":"...","block":{"type":"action","text":"..."}}；appendBlock 与之类似；updateSceneCharacters 只更新 characterIds。',
              expansionOnly
                ? '本轮只修复 TOO_SHORT：operations 只能使用 insertBlockAfter 或 appendBlock 增写可拍摄内容，严禁替换、删减或缩短既有正文。'
                : '只对阻断项做最小改动；除 TOO_LONG 外，修订后正文不得比当前候选更短。',
              scriptLengthInstruction(plan.targetCharsPerEpisode, report.visibleChars),
              `当前可见字符 ${report.visibleChars}，目标 ${plan.targetCharsPerEpisode}，合格范围 ${Math.ceil(plan.targetCharsPerEpisode * 0.85)}—${Math.floor(plan.targetCharsPerEpisode * 1.15)}。`,
              `人物 ID 白名单：${JSON.stringify(state.characters.map((character) => character.id))}`,
              `场景与正文块 ID 白名单：${JSON.stringify(draft.scenes.map((scene) => ({ sceneId: scene.id, characterIds: scene.characterIds, blockIds: scene.blocks.map((block) => block.id) })))}`,
              `本集大纲：${JSON.stringify(outline)}`,
              `阻断错误：${JSON.stringify(report.blockingIssues)}`,
              rejectedRevisionFeedback.length > 0
                ? `上次候选被系统拒绝：${JSON.stringify(rejectedRevisionFeedback)}。必须换一种满足白名单与长度保护的补丁，禁止重复该越界做法。`
                : '',
              `当前候选：${JSON.stringify(draft)}`,
            ].filter(Boolean).join('\n'),
            signal: request.signal,
          }, SCRIPT_REVISION_PATCH_CONTRACT);
          try {
            if (
              expansionOnly &&
              patch.operations.some((operation) =>
                operation.op !== 'insertBlockAfter' && operation.op !== 'appendBlock')
            ) {
              throw new ScriptRevisionPatchError('TOO_SHORT 修订只允许追加或插入正文块。');
            }
            const visibleCharsBeforePatch = scriptVisibleChars(draft);
            const applied = applyScriptRevisionPatch(
              draft,
              patch,
              () => this.createId(),
              revisionPolicy,
            );
            const visibleCharsAfterPatch = scriptVisibleChars(applied.episode);
            if (
              visibleCharsAfterPatch < visibleCharsBeforePatch &&
              !report.blockingIssues.some((issue) => issue.code === 'TOO_LONG')
            ) {
              throw new ScriptRevisionPatchError('修订无权缩短未超长的候选正文。');
            }
            draft = {
              ...applied.episode,
              summary: review.summary,
              newFacts: review.newFacts,
              openedThreads: review.openedThreads,
              closedThreads: review.closedThreads,
              updatedAt: this.now(),
            };
            try {
              draft = this.canonicalEpisodeCandidate(draft, plan, episodeNumber);
            } catch (error) {
              if (error instanceof ScriptModelOutputError) {
                throw new ScriptRevisionPatchError(`修订候选未通过统一输入校验：${error.message}`);
              }
              throw error;
            }
            patchedArtifact = buildScriptEpisodeCandidateArtifact({
              projectId: request.projectId,
              episodeNumber,
              baseEpisodeRevision: currentEpisodeRevision,
              inputRevisionRefs: revisionInputRevisionRefs,
              upstreamArtifactRefs: revisionUpstreamArtifactRefs,
              promptVersion: revisionPromptVersion,
              configRevision,
              validationErrors: report.blockingIssues.map((issue) => ({
                ...(issue.path ? { path: issue.path } : {}),
                code: issue.code,
                message: issue.message,
              })),
              createdAt: this.now(),
            }, 'patched', draft);
          } catch (error) {
            if (!(error instanceof ScriptRevisionPatchError)) throw error;
            await rejectRevisionPatch(error);
          }
          revisionCheckpointRevision = await this.nextCheckpointArtifactRevision(
            request.projectId,
            runKey,
            { node: 'revision', episodeNumber, chunkStart: revisionRound },
          );
        }
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'revision',
          status: 'succeeded',
          attempt: revisionRound,
          artifactRevision: revisionCheckpointRevision!,
          episodeNumber,
          chunkStart: revisionRound,
          artifact: patchedArtifact,
          ...checkpointArtifactMetadata(patchedArtifact!),
          updatedAt: this.now(),
        }, `第 ${episodeNumber} 集第 ${revisionRound} 轮受限修订候选已写入检查点。`);
        currentCandidateRef = buildScriptUpstreamArtifactRef(
          'revision',
          revisionCheckpointRevision!,
          patchedArtifact!,
        );
        episodeUpstreamRefs.push(currentCandidateRef);
        reviewed = await reviewDraft(draft, revisionRound + 1, currentCandidateRef);
        review = reviewed.value;
        currentReviewRef = reviewed.artifactRef;
        episodeUpstreamRefs.push(currentReviewRef);
        draft = {
          ...draft,
          summary: review.summary,
          newFacts: review.newFacts,
          openedThreads: review.openedThreads,
          closedThreads: review.closedThreads,
          updatedAt: this.now(),
        };
        deterministicReport = validateDraft(draft);
        report = validateDraft(
          draft,
          review.issues.map((issue) => ({ ...issue, source: 'ai' })),
        );
      }
      if (report.hardFailed) {
        request.signal?.throwIfAborted();
        await this.persistReviewIssues(
          request.projectId,
          episodeNumber,
          deterministicReport.issues,
          review.issues,
        );
        const validationErrors = report.blockingIssues.map((issue) => ({
          ...(issue.path ? { path: issue.path } : {}),
          code: issue.code,
          message: issue.message,
        }));
        const needsReviewArtifact = buildScriptEpisodeCandidateArtifact({
          projectId: request.projectId,
          episodeNumber,
          baseEpisodeRevision: currentEpisodeRevision,
          inputRevisionRefs: buildScriptInputRevisionRefs(reviewState, episodeNumber),
          upstreamArtifactRefs: [currentCandidateRef, currentReviewRef],
          promptVersion: 'quality-gate-needs-review-v1',
          configRevision,
          validationErrors,
          createdAt: this.now(),
        }, 'patched', draft);
        const completedCheckpointRevision = await this.nextCheckpointArtifactRevision(
          request.projectId,
          runKey,
          { node: 'completed', episodeNumber },
        );
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'completed',
          status: 'needs_review',
          attempt: maxRevisionRounds,
          artifactRevision: completedCheckpointRevision,
          episodeNumber,
          artifact: needsReviewArtifact,
          ...checkpointArtifactMetadata(needsReviewArtifact),
          updatedAt: this.now(),
        }, `第 ${episodeNumber} 集候选仍有阻断项，等待人工处理。`);
        reports.push({ episodeNumber, report });
        throw new ScriptBatchPausedError(episodeNumber, report);
      }

      request.signal?.throwIfAborted();
      const persistedReview = await this.persistReviewIssues(
        request.projectId,
        episodeNumber,
        deterministicReport.issues,
        review.issues,
      );
      const retainedOpenHard = persistedReview.items.filter(
        (item) =>
          item.episodeNumber === episodeNumber && isBlockingScriptReviewIssue(item),
      );
      if (retainedOpenHard.length > 0) {
        const known = new Set(report.issues.map((issue) =>
          [issue.code, issue.sceneId ?? '', issue.blockId ?? '', issue.path ?? ''].join('\u0000'),
        ));
        const additional = retainedOpenHard
          .filter((issue) => !known.has(
            [issue.code, issue.sceneId ?? '', issue.blockId ?? '', issue.path ?? ''].join('\u0000'),
          ))
          .map((issue): ScriptEvaluatedGateIssue => ({
            code: issue.code,
            severity: 'hard',
            source: issue.source,
            blocking: true,
            message: issue.message,
            ...(issue.sceneId ? { sceneId: issue.sceneId } : {}),
            ...(issue.blockId ? { blockId: issue.blockId } : {}),
            ...(issue.path ? { path: issue.path } : {}),
          }));
        report = {
          ...report,
          hardFailed: true,
          issues: [...report.issues, ...additional],
          blockingIssues: [...report.blockingIssues, ...additional],
        };
        const validationErrors = retainedOpenHard.map((issue) => ({
          ...(issue.path ? { path: issue.path } : {}),
          code: issue.code,
          message: issue.message,
        }));
        const needsReviewArtifact = buildScriptEpisodeCandidateArtifact({
          projectId: request.projectId,
          episodeNumber,
          baseEpisodeRevision: currentEpisodeRevision,
          inputRevisionRefs: buildScriptInputRevisionRefs(reviewState, episodeNumber),
          upstreamArtifactRefs: [currentCandidateRef, currentReviewRef],
          promptVersion: 'quality-gate-needs-review-v1',
          configRevision,
          validationErrors,
          createdAt: this.now(),
        }, 'patched', draft);
        const completedCheckpointRevision = await this.nextCheckpointArtifactRevision(
          request.projectId,
          runKey,
          { node: 'completed', episodeNumber },
        );
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'completed',
          status: 'needs_review',
          attempt: 1,
          artifactRevision: completedCheckpointRevision,
          episodeNumber,
          artifact: needsReviewArtifact,
          ...checkpointArtifactMetadata(needsReviewArtifact),
          updatedAt: this.now(),
        }, `第 ${episodeNumber} 集存在人工阻断项，等待处理。`);
        reports.push({ episodeNumber, report });
        throw new ScriptBatchPausedError(episodeNumber, report);
      }
      const commitState = (await this.dependencies.store.getProjectState(request.projectId))
        ?? reviewState;
      draft = this.canonicalEpisodeCandidate(draft, plan, episodeNumber);
      const completedCheckpointRevision = await this.nextCheckpointArtifactRevision(
        request.projectId,
        runKey,
        { node: 'completed', episodeNumber },
      );
      const finalCandidateArtifact = buildScriptEpisodeCandidateArtifact({
        projectId: request.projectId,
        episodeNumber,
        baseEpisodeRevision: currentEpisodeRevision,
        inputRevisionRefs: buildScriptInputRevisionRefs(commitState, episodeNumber),
        upstreamArtifactRefs: [currentCandidateRef, currentReviewRef],
        promptVersion: 'quality-gate-final-v1',
        configRevision,
        createdAt: this.now(),
      }, 'patched', draft);
      const finalCandidateRef = buildScriptUpstreamArtifactRef(
        'completed',
        completedCheckpointRevision,
        finalCandidateArtifact,
      );
      episodeUpstreamRefs.push(finalCandidateRef);
      const continuity = buildScriptContinuityCandidate(commitState, draft, review.wardrobe);
      const commitInput = buildScriptAtomicCommitInput(commitState, draft, continuity, {
        upstreamArtifactRefs: episodeUpstreamRefs,
        promptVersion: 'short-drama-director-v2',
        modelConfigFingerprint: configRevision,
      });
      const commitEpisodeWithContinuity = this.dependencies.store.commitEpisodeWithContinuity;
      if (!commitEpisodeWithContinuity) {
        throw new ScriptModelOutputError('正文存储未实现原子连续性提交。');
      }
      request.signal?.throwIfAborted();
      const { episode: saved } = await commitEpisodeWithContinuity.call(
        this.dependencies.store,
        commitInput,
      );
      episodes.push(saved);
      reports.push({ episodeNumber, report });
      await this.saveCheckpoint(request, {
        projectId: request.projectId,
        runKey,
        node: 'completed',
        status: 'completed',
        attempt: 1,
        artifactRevision: completedCheckpointRevision,
        episodeNumber,
        artifact: finalCandidateArtifact,
        ...checkpointArtifactMetadata(finalCandidateArtifact),
        updatedAt: this.now(),
      }, `第 ${episodeNumber} 集已通过质量门。`);
    }
    const batchReportCheckpointRevision = await this.nextCheckpointArtifactRevision(
      request.projectId,
      runKey,
      { node: 'batch_report' },
    );
    await this.saveCheckpoint(request, {
      projectId: request.projectId,
      runKey,
      node: 'batch_report',
      status: 'completed',
      attempt: 1,
      artifactRevision: batchReportCheckpointRevision,
      artifact: reports,
      updatedAt: this.now(),
    }, `第 ${request.startEpisode}—${endEpisode} 集批次完成。`);
    return {
      kind: 'episode_batch',
      episodes: episodes.sort((left, right) => left.episodeNumber - right.episodeNumber),
      reports,
      skippedEpisodeNumbers,
    };
  }

  private parseEpisodeOutline(
    value: Record<string, unknown>,
    projectId: string,
    registeredCharacterIds?: ReadonlySet<string>,
  ): ScriptEpisodeOutline {
    if (!Array.isArray(value.plannedScenes)) {
      throw new ScriptModelOutputError('模型结果缺少数组字段 plannedScenes。');
    }
    const plannedScenes = value.plannedScenes.length > 0
      ? this.parsePlannedScenes(value.plannedScenes, 5)
      : [];
    const characterIds = stringsField(value.characterIds, 'characterIds');
    const unknownCharacterId = characterIds.find(
      (characterId) => registeredCharacterIds && !registeredCharacterIds.has(characterId),
    );
    if (unknownCharacterId) {
      throw new ScriptModelOutputError(`详细大纲引用了未登记人物 ID：${unknownCharacterId}。`);
    }
    return {
      id: optionalStringField(value.id) ?? this.createId(),
      projectId,
      episodeNumber: numberField(value.episodeNumber, 'episodeNumber'),
      title: stringField(value.title, 'title'),
      goal: stringField(value.goal, 'goal'),
      conflict: stringField(value.conflict, 'conflict'),
      beats: stringsField(value.beats, 'beats'),
      characterIds,
      plannedScenes,
      ...(optionalStringField(value.reveal) ? { reveal: optionalStringField(value.reveal) } : {}),
      ...(optionalStringField(value.reversal) ? { reversal: optionalStringField(value.reversal) } : {}),
      endingHook: stringField(value.endingHook, 'endingHook'),
      requiredFacts: stringsField(value.requiredFacts, 'requiredFacts'),
      forbiddenFacts: stringsField(value.forbiddenFacts, 'forbiddenFacts'),
      status: 'expanded',
      revision: 0,
    };
  }

  private parsePlannedScenes(value: unknown, maxScenes: number): ScriptPlannedScene[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > maxScenes) {
      throw new ScriptModelOutputError(`plannedScenes 数量必须为 1—${maxScenes}。`);
    }
    const ordinals = new Set<number>();
    const plannedScenes = value.map((candidate) => {
      const scene = recordField(candidate, 'plannedScene');
      const ordinal = numberField(scene.ordinal, 'ordinal');
      if (ordinals.has(ordinal)) throw new ScriptModelOutputError(`场号 ${ordinal} 重复。`);
      ordinals.add(ordinal);
      return {
        ordinal,
        location: stringField(scene.location, 'location'),
        timeOfDay: enumField(scene.timeOfDay, 'timeOfDay', ['day', 'night', 'dawn', 'dusk']),
        interiorExterior: enumField(scene.interiorExterior, 'interiorExterior', ['interior', 'exterior']),
        purpose: stringField(scene.purpose, 'purpose'),
      };
    });
    if (plannedScenes.some((scene, index) => scene.ordinal !== index + 1)) {
      throw new ScriptModelOutputError('plannedScenes 场号必须从 1 开始连续递增。');
    }
    return plannedScenes;
  }

  private parseEpisode(
    value: Record<string, unknown>,
    projectId: string,
    outline: ScriptEpisodeOutline,
    plan: ScriptPlan,
    current?: ScriptEpisode,
  ): ScriptEpisode {
    if (!Array.isArray(value.scenes)) throw new ScriptModelOutputError('scenes 必须是数组。');
    const scenes: ScriptScene[] = value.scenes.map((candidate) => {
      const scene = recordField(candidate, 'scene');
      if (!Array.isArray(scene.blocks)) throw new ScriptModelOutputError('blocks 必须是数组。');
      return {
        id: optionalStringField(scene.id) ?? this.createId(),
        ordinal: numberField(scene.ordinal, 'ordinal'),
        location: stringField(scene.location, 'location'),
        timeOfDay: enumField(scene.timeOfDay, 'timeOfDay', ['day', 'night', 'dawn', 'dusk']),
        interiorExterior: enumField(scene.interiorExterior, 'interiorExterior', ['interior', 'exterior']),
        characterIds: stringsField(scene.characterIds, 'characterIds'),
        blocks: scene.blocks.map((candidateBlock) => {
          const block = recordField(candidateBlock, 'block');
          const type = enumField(block.type, 'type', ['caption', 'action', 'dialogue']);
          const id = optionalStringField(block.id) ?? this.createId();
          const text = stringField(block.text, 'text');
          if (type === 'caption' || type === 'action') return { id, type, text };
          return {
            id,
            type: 'dialogue' as const,
            ...(optionalStringField(block.characterId) ? { characterId: optionalStringField(block.characterId) } : {}),
            speaker: stringField(block.speaker, 'speaker'),
            ...(optionalStringField(block.delivery) ? { delivery: optionalStringField(block.delivery) } : {}),
            ...(block.mode !== undefined
              ? { mode: enumField(block.mode, 'mode', ['normal', 'os', 'vo']) }
              : {}),
            text,
          };
        }),
      };
    });
    const now = this.now();
    if (typeof value.summary !== 'string') {
      throw new ScriptModelOutputError('模型结果缺少字符串字段 summary。');
    }
    const candidate: ScriptEpisode = {
      id: current?.id ?? optionalStringField(value.id) ?? this.createId(),
      projectId,
      episodeNumber: numberField(value.episodeNumber, 'episodeNumber'),
      title: stringField(value.title, 'title'),
      outlineId: outline.id,
      status: 'reviewing',
      targetChars: plan.targetCharsPerEpisode,
      scenes,
      summary: value.summary.trim(),
      newFacts: stringsField(value.newFacts, 'newFacts'),
      openedThreads: stringsField(value.openedThreads, 'openedThreads'),
      closedThreads: stringsField(value.closedThreads, 'closedThreads'),
      revision: current?.revision ?? 0,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    return this.canonicalEpisodeCandidate(candidate, plan, outline.episodeNumber);
  }

  private canonicalEpisodeCandidate(
    candidate: ScriptEpisode,
    plan: ScriptPlan,
    expectedEpisodeNumber: number,
  ): ScriptEpisode {
    const canonical = canonicalModelCandidate(() => {
      const parsed = decodeScriptEpisodeInput(candidate, { createId: () => this.createId() });
      validateScriptEpisodeInput(parsed, {
        expectedEpisodeNumber,
        totalEpisodes: plan.totalEpisodes,
        maxScenesPerEpisode: plan.maxScenesPerEpisode,
      });
      return parsed;
    });
    return {
      ...canonical,
      id: canonical.id ?? candidate.id,
      projectId: candidate.projectId,
      revision: candidate.revision,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    };
  }

  private canonicalEpisodeOutlineCandidate(
    candidate: ScriptEpisodeOutline,
    plan: ScriptPlan,
    expectedEpisodeNumber: number,
  ): ScriptEpisodeOutline {
    const canonical = canonicalModelCandidate(() => {
      const parsed = decodeScriptEpisodeOutlineInput(candidate);
      if (parsed.episodeNumber !== expectedEpisodeNumber) {
        throw ScriptServiceError.validation('请求路径与正文中的集号不一致');
      }
      if (parsed.episodeNumber > plan.totalEpisodes) {
        throw ScriptServiceError.validation('集号超过策划总集数');
      }
      if (parsed.plannedScenes.length > 0) {
        validateScriptEpisodeOutlineInput(parsed, {
          expectedEpisodeNumber,
          totalEpisodes: plan.totalEpisodes,
          maxScenesPerEpisode: plan.maxScenesPerEpisode,
        });
      }
      return parsed;
    });
    return {
      ...canonical,
      id: canonical.id ?? candidate.id,
      projectId: candidate.projectId,
      revision: candidate.revision,
    };
  }

  private parseReview(value: Record<string, unknown>): {
    issues: ScriptGateIssue[];
    summary: string;
    newFacts: string[];
    openedThreads: string[];
    closedThreads: string[];
    wardrobe: Array<{ characterId: string; outfit: string }>;
  } {
    if (!Array.isArray(value.issues)) {
      throw new ScriptModelOutputError('模型结果缺少数组字段 issues。');
    }
    const rawIssues = value.issues;
    const issues = rawIssues.map((candidate) => {
      const issue = recordField(candidate, 'issue');
      return {
        code: stringField(issue.code, 'issue.code'),
        severity: enumField(issue.severity, 'issue.severity', ['hard', 'soft']),
        message: stringField(issue.message, 'issue.message'),
        ...(optionalStringField(issue.sceneId) ? { sceneId: optionalStringField(issue.sceneId) } : {}),
        ...(optionalStringField(issue.path) ? { path: optionalStringField(issue.path) } : {}),
      };
    });
    if (!Array.isArray(value.wardrobe)) {
      throw new ScriptModelOutputError('模型结果缺少数组字段 wardrobe。');
    }
    const wardrobe = value.wardrobe.map((candidate) => {
          const item = recordField(candidate, 'wardrobe');
          return {
            characterId: stringField(item.characterId, 'wardrobe.characterId'),
            outfit: stringField(item.outfit, 'wardrobe.outfit'),
          };
        });
    return {
      issues,
      summary: stringField(value.summary, 'summary'),
      newFacts: stringsField(value.newFacts, 'newFacts'),
      openedThreads: stringsField(value.openedThreads, 'openedThreads'),
      closedThreads: stringsField(value.closedThreads, 'closedThreads'),
      wardrobe,
    };
  }

  private async persistReviewIssues(
    projectId: string,
    episodeNumber: number,
    deterministicIssues: readonly ScriptGateIssue[],
    aiIssues: readonly ScriptGateIssue[],
  ): Promise<ScriptReviewIssueCollection> {
    const now = this.now();
    return this.dependencies.store.replaceEpisodeReviewIssues(
      projectId,
      episodeNumber,
      ['deterministic', 'ai'],
      [
        ...createScriptReviewIssues(
          projectId,
          episodeNumber,
          'deterministic',
          deterministicIssues,
          now,
        ),
        ...createScriptReviewIssues(projectId, episodeNumber, 'ai', aiIssues, now),
      ],
    );
  }

  private assembleEpisodeContext(
    state: NonNullable<Awaited<ReturnType<ScriptStore['getProjectState']>>>,
    plan: ScriptPlan,
    outline: ScriptEpisodeOutline,
    episodeNumber: number,
  ): string {
    const previous = state.episodes.find((episode) => episode.episodeNumber === episodeNumber - 1);
    const cast = state.characters.filter((character) => outline.characterIds.includes(character.id));
    const sections = [
      ['锁定策划', JSON.stringify(plan), 2_500],
      ['世界圣经', JSON.stringify(state.worldBible), 2_500],
      ['本集人物', JSON.stringify(cast), 6_000],
      ['本集大纲', JSON.stringify(outline), 2_500],
      ['上集摘要', JSON.stringify(previous ? { summary: previous.summary, scenes: previous.scenes.slice(-1) } : {}), 2_000],
      ['伏笔与当前状态', JSON.stringify({
        aggregate: projectScriptContinuity(state, episodeNumber),
        recentCommits: currentScriptContinuityCommits(state)
          .filter((commit) => commit.episodeNumber < episodeNumber)
          .slice(-2),
      }), 4_000],
      ['格式规则', '结构化 JSON；1—5 场；每场含地点、时间、内外景、人物与 caption/action/dialogue 块。', 1_000],
    ] as const;
    return sections
      .map(([label, content, limit]) => `${label}：${content.slice(0, limit)}`)
      .join('\n');
  }

  private async generateNodeStructured<T>(
    request: ScriptModelRequest,
    contract: StructuredContract<T>,
  ): Promise<T> {
    const asStructuredModel = (modelNameOverride?: string): StructuredModel => ({
      complete: ({ prompt, signal }) => this.dependencies.model.complete({
        ...request,
        prompt,
        ...(modelNameOverride ? { modelNameOverride } : {}),
        ...(signal ? { signal } : {}),
      }),
    });
    const fallbackModelName = await this.dependencies.model.getStructuredFallbackModelName?.();
    const result = await generateStructured({
      contract,
      prompt: request.prompt,
      primary: asStructuredModel(),
      ...(fallbackModelName ? { fallback: asStructuredModel(fallbackModelName) } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (result.status === 'needs_review') {
      throw new ScriptStructuredNeedsReviewError(request.node, result.error);
    }
    return result.value;
  }

  private async modelConfigFingerprint(): Promise<string> {
    const reported = await this.dependencies.model.getModelConfigFingerprint?.();
    if (reported?.trim()) return reported.trim();
    // Test/local adapters have no provider configuration. Keep their identity
    // explicit and stable instead of pretending it is a production model config.
    return createHash('sha256')
      .update('unreported-local-script-model-adapter:v1', 'utf8')
      .digest('hex');
  }

  private async latestCheckpoint(
    projectId: string,
    runKey: string,
    selector: ScriptCheckpointSelector,
  ): Promise<ScriptPipelineCheckpoint | undefined> {
    return latestScriptCheckpoint(
      await this.dependencies.checkpoints.list(projectId, runKey),
      selector,
    );
  }

  private async nextCheckpointArtifactRevision(
    projectId: string,
    runKey: string,
    selector: ScriptCheckpointSelector,
  ): Promise<number> {
    return nextScriptCheckpointArtifactRevision(
      await this.dependencies.checkpoints.list(projectId, runKey),
      selector,
    );
  }

  private async saveCheckpoint(
    request: Extract<ScriptDirectorRequest, { task: 'script_episode_batch' }>,
    checkpoint: ScriptPipelineCheckpointWrite,
    message: string,
  ): Promise<void> {
    await this.dependencies.checkpoints.save(checkpoint);
    await request.onProgress?.({
      phase: 'info',
      message,
      ...(checkpoint.episodeNumber !== undefined ? { current: checkpoint.episodeNumber } : {}),
      total: request.startEpisode + request.episodeCount - 1,
      scriptCheckpoint: {
        ...(checkpoint.episodeNumber !== undefined ? { episodeNumber: checkpoint.episodeNumber } : {}),
        node: checkpoint.node,
        attempt: checkpoint.attempt,
        artifactRevision: checkpoint.artifactRevision,
      },
    });
  }

  private async markCheckpointStale(checkpoint: ScriptPipelineCheckpoint): Promise<void> {
    await this.dependencies.checkpoints.save({
      ...checkpoint,
      status: 'stale',
      updatedAt: this.now(),
    });
  }

  /**
   * A durable needs-review boundary requests a new candidate, not another
   * evaluation of the exact candidate that paused the job. This state-based
   * check also covers a process crash between checkpoint persistence and the
   * job runner recording its waiting status. Preserve the expensive draft and
   * first review, but invalidate the rejected revision boundary so its
   * downstream review fingerprint is forced to change as well.
   */
  private async invalidateRejectedEpisodeCandidates(
    checkpoints: readonly ScriptPipelineCheckpoint[],
    episodeNumbers: readonly number[],
  ): Promise<void> {
    for (const episodeNumber of episodeNumbers) {
      const completed = latestScriptCheckpoint(checkpoints, {
        node: 'completed',
        episodeNumber,
      });
      const revisions = [1, 2]
        .map((revisionRound) => latestScriptCheckpoint(checkpoints, {
          node: 'revision',
          episodeNumber,
          chunkStart: revisionRound,
        }))
        .filter((checkpoint): checkpoint is ScriptPipelineCheckpoint => checkpoint !== undefined);
      const rejectedRevision = revisions.find((checkpoint) => checkpoint.status === 'needs_review');
      const completedCandidateRejected = completed?.status === 'needs_review';
      if (!rejectedRevision && !completedCandidateRejected) continue;

      if (completedCandidateRejected) await this.markCheckpointStale(completed);
      for (const revision of revisions) {
        if (
          revision.status === 'needs_review' ||
          (completedCandidateRejected && revision.status === 'succeeded')
        ) {
          await this.markCheckpointStale(revision);
        }
      }
    }
  }

  private now(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }

  private createId(): string {
    return this.dependencies.id?.() ?? randomUUID();
  }
}
