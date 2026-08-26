import { createHash, randomUUID } from 'node:crypto';

import type {
  ScriptCharacter,
  ScriptBlock,
  ScriptEpisode,
  ScriptEpisodeCard,
  ScriptEpisodeOutline,
  ScriptPlannedScene,
  ScriptPlan,
  ScriptProjectState,
  ScriptReviewIssue,
  ScriptReviewIssueCollection,
  ScriptReviewSource,
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
import {
  computeScriptEpisodeCandidateHash,
  computeScriptInputFingerprint,
  type ScriptStore,
} from '../ScriptStore.js';
import { parseChineseShortDramaText } from '../parsers/chineseShortDramaText.js';
import {
  collectTemporaryDialogueSpeakers,
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
  coerceEpisodeDraftCandidate,
  coerceEpisodeOutlineCandidate,
  coercePlannedScenes,
} from './EpisodeArtifactCoercion.js';
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
  type ScriptCheckpointValidationError,
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
  coerceCharacterBibleCandidate,
  coerceScriptPlanCandidate,
  coerceSeriesOutlineChunk,
  coerceWorldBibleCandidate,
} from './FoundationArtifactCoercion.js';
import {
  generateStructured,
  type StructuredGenerationError,
  type StructuredGenerationResult,
  type StructuredModel,
} from './generateStructured.js';
import {
  assertScriptRevisionPatchAllowed,
  applyScriptRevisionPatch,
  buildScriptRevisionPatchPolicy,
  SCRIPT_REVISION_PATCH_CONTRACT,
  ScriptRevisionPatchError,
  type ScriptRevisionPatch,
  type ScriptRevisionPatchPolicy,
} from './ScriptRevisionPatch.js';
import {
  buildDirectContinuationPrompt,
  buildDirectDraftPrompt,
  buildDirectReviewPrompt,
  buildDirectRewritePrompt,
  createLocalDirectHandoffReview,
  createMinimalDirectDraftFallback,
  decodeDirectHandoffReview,
  directEpisodeText,
  directWritingContext,
  mergeDirectHandoffContinuity,
  mergeDirectContinuation,
  reconcileDirectReviewBoundary,
  type ScriptDirectDraftArtifact,
  type ScriptDirectHandoffReview,
  type ScriptDirectReviewArtifact,
  type ScriptDirectReviewIssue,
} from './ScriptDirectWriting.js';
import { parseStructuredModelOutput, ScriptModelOutputError } from './structuredOutput.js';

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
  responseFormat?: 'json' | 'text';
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

export interface ScriptStructuredCallMetric {
  node: ScriptModelNode;
  episodeNumber?: number;
  contractName: string;
  status: 'completed' | 'needs_review';
  callsUsed: number;
  completedBy?: 'primary' | 'fixup' | 'fallback';
  attempts: Array<{
    stage: 'primary' | 'fixup' | 'fallback';
    outcome: 'completed' | 'call_failed' | 'parse_failed' | 'decode_failed';
  }>;
}

export interface ScriptBatchCallSummary {
  totalCalls: number;
  primaryCalls: number;
  fixupCalls: number;
  fallbackCalls: number;
  byNode: Partial<Record<ScriptModelNode, number>>;
  byEpisode: Array<{ episodeNumber: number; calls: number }>;
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
      /** User explicitly requested a fresh candidate instead of checkpoint reuse. */
      regenerate?: boolean;
      regenerationRunId?: string;
      signal?: AbortSignal;
      onProgress?: (event: ScriptProgressEvent) => void | Promise<void>;
    }
  | {
      task: 'script_bible';
      projectId: string;
      /** User explicitly requested fresh character and world candidates. */
      regenerate?: boolean;
      regenerationRunId?: string;
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
      draftMode?: 'structured_legacy' | 'direct_text';
      /** User explicitly requested fresh episode bodies for this batch. */
      regenerate?: boolean;
      regenerationRunId?: string;
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
      callSummary: ScriptBatchCallSummary;
    };

export class ScriptBatchPausedError extends Error {
  readonly code = 'SCRIPT_BATCH_NEEDS_REVIEW';
  readonly recoverable = true;

  constructor(
    readonly episodeNumber: number,
    readonly report: ScriptGateReport,
  ) {
    const hardIssueSummary = [...report.blockingIssues]
      .sort((left, right) =>
        Number(right.code === 'REVISION_PATCH_REJECTED') -
        Number(left.code === 'REVISION_PATCH_REJECTED'))
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

function scriptLengthInstruction(
  targetChars: number,
  sceneCount: number,
  dialogueDensityPercent: number,
  currentChars?: number,
): string {
  const safeSceneCount = Math.max(1, sceneCount);
  const charsPerScene = Math.round(targetChars / safeSceneCount);
  const preferredMinimum = Math.ceil(targetChars * 0.75);
  const current = currentChars === undefined
    ? ''
    : `当前正文已有 ${currentChars} 个可见字符，只需从现有结尾自然续写，不得复述或重写。`;
  return [
    current,
    `整集以约 ${targetChars} 个可见字符为创作目标，达到约 ${preferredMinimum} 字即可进入审查，不要求精确凑数；`,
    `当前 ${safeSceneCount} 场可按戏剧任务自然分配，平均约 ${charsPerScene} 字，重要冲突场可以更长；`,
    `对白目标约 ${dialogueDensityPercent}%，允许按剧情自然波动，不得为了比例重复台词或灌水；`,
    '每个 blocks.text 写完整、可拍摄的动作或有信息量的对白，不要用四五字短句机械凑块数；',
    '篇幅只统计 blocks.text，summary、newFacts、openedThreads、closedThreads 不计入正文。',
  ].join('');
}

function scriptRevisionLengthInstruction(
  targetChars: number,
  currentChars: number,
  reduceOnly: boolean,
): string {
  const minimum = Math.ceil(targetChars * 0.75);
  const maximum = Math.floor(targetChars * 1.25);
  const operationConstraint = reduceOnly
    ? `本轮只能使用 replaceBlockText 精简现有正文块，至少净减少 ${Math.max(1, currentChars - maximum)} 个可见字符；不得插入、追加、改人物或改结构。`
    : '只执行当前阻断项授权的 Patch 操作，不要为了初稿块数建议而重构未授权内容。';
  return [
    `当前正文有 ${currentChars} 个可见字符，修订后必须落在 ${minimum}—${maximum} 个可见字符。`,
    operationConstraint,
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

function directOutlineFromEpisodeCard(
  projectId: string,
  seriesOutline: ScriptSeriesOutline,
  card: ScriptEpisodeCard,
  characterIds: readonly string[],
): ScriptEpisodeOutline {
  const stableId = createHash('sha256')
    .update(`${projectId}:${seriesOutline.revision}:${card.episodeNumber}`)
    .digest('hex')
    .slice(0, 24);
  return {
    id: `direct-outline-${stableId}`,
    projectId,
    episodeNumber: card.episodeNumber,
    title: card.title,
    goal: card.logline,
    conflict: card.mainEvent,
    beats: [card.mainEvent],
    characterIds: [...characterIds],
    plannedScenes: [],
    endingHook: card.endingHook,
    requiredFacts: [],
    forbiddenFacts: [],
    status: 'expanded',
    revision: seriesOutline.revision,
  };
}

function planForDirectDraftValidation(plan: ScriptPlan): ScriptPlan {
  if (plan.maxScenesPerEpisode >= 5) return plan;
  return { ...plan, maxScenesPerEpisode: 5 };
}

function stableCharacterName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

/** Keep IDs already referenced by outlines, scripts and continuity records. */
function stabilizeRegeneratedCharacters(
  generated: readonly ScriptCharacter[],
  existing: readonly ScriptCharacter[],
  maxPrimaryCharacters: number,
): ScriptCharacter[] {
  if (existing.length === 0) return [...generated];
  const existingById = new Map(existing.map((character) => [character.id, character]));
  const existingByIdentity = new Map<string, ScriptCharacter>();
  for (const character of existing) {
    for (const identity of [character.name, ...character.aliases]) {
      const key = stableCharacterName(identity);
      if (key && !existingByIdentity.has(key)) existingByIdentity.set(key, character);
    }
  }
  const matchedByIndex = new Map<number, ScriptCharacter>();
  const usedExistingIds = new Set<string>();

  generated.forEach((character, index) => {
    const exact = existingById.get(character.id) ?? [character.name, ...character.aliases]
      .map((identity) => existingByIdentity.get(stableCharacterName(identity)))
      .find((candidate): candidate is ScriptCharacter => candidate !== undefined);
    if (exact && !usedExistingIds.has(exact.id)) {
      matchedByIndex.set(index, exact);
      usedExistingIds.add(exact.id);
    }
  });

  const generatedIdMap = new Map<string, string>();
  const stabilized = generated.map((character, index) => {
    const matched = matchedByIndex.get(index);
    const id = matched?.id ?? character.id;
    generatedIdMap.set(character.id, id);
    return { ...character, id, revision: matched?.revision ?? character.revision };
  });
  stabilized.push(...existing.filter((character) => !usedExistingIds.has(character.id)));

  const validIds = new Set(stabilized.map((character) => character.id));
  const existingIds = new Set(existing.map((character) => character.id));
  let primaryCount = stabilized.filter((character) => (
    existingIds.has(character.id) && character.role !== 'minor'
  )).length;
  return stabilized.map((character) => {
    let role = character.role;
    if (!existingIds.has(character.id) && role !== 'minor') {
      primaryCount += 1;
      if (primaryCount > maxPrimaryCharacters) role = 'minor';
    }
    const relationships = character.relationships
      .map((relationship) => ({
        ...relationship,
        characterId: generatedIdMap.get(relationship.characterId) ?? relationship.characterId,
      }))
      .filter((relationship) =>
        relationship.characterId !== character.id && validIds.has(relationship.characterId));
    return { ...character, role, relationships };
  });
}

function isDirectStageDirectionSpeaker(value: string): boolean {
  const speaker = value.trim();
  return /^【\s*(?:特写|近景|中景|远景|全景|空镜|俯拍|仰拍|航拍|跟拍|推镜|拉镜|摇镜|慢镜头|定格|蒙太奇|画面|镜头)\s*】/u.test(speaker) ||
    /^(?:特写|近景|中景|远景|全景|空镜|俯拍|仰拍|航拍|跟拍|推镜|拉镜|摇镜|慢镜头|定格|蒙太奇|画面|镜头)$/u.test(speaker);
}

function reconcileDirectSceneCast(episode: ScriptEpisode): ScriptEpisode {
  return {
    ...episode,
    scenes: episode.scenes.map((scene) => {
      const blocks: ScriptBlock[] = scene.blocks.map((block) => (
        block.type === 'dialogue' &&
        !block.characterId
          ? block.speaker.trim() === '字幕'
            ? { id: block.id, type: 'caption', text: block.text }
            : isDirectStageDirectionSpeaker(block.speaker)
              ? { id: block.id, type: 'action', text: `${block.speaker.trim()}：${block.text}` }
              : block
          : block
      ));
      return {
        ...scene,
        blocks,
        characterIds: [...new Set([
          ...scene.characterIds,
          ...blocks.flatMap((block) => (
            block.type === 'dialogue' && block.characterId ? [block.characterId] : []
          )),
        ])],
      };
    }),
  };
}

interface ScriptTextComposition {
  visibleChars: number;
  dialogueChars: number;
  nonDialogueChars: number;
  dialogueDensityPercent: number;
}

type ScriptDraftExpansionBlock =
  | {
      sceneOrdinal: number;
      type: 'action';
      text: string;
    }
  | {
      sceneOrdinal: number;
      type: 'dialogue';
      characterId: string;
      speaker: string;
      delivery?: string;
      mode?: 'normal' | 'os' | 'vo';
      text: string;
    };

interface ScriptDraftExpansion {
  blocks: ScriptDraftExpansionBlock[];
}

const SCRIPT_DRAFT_PREFERRED_MIN_RATIO = 0.75;
const SCRIPT_DRAFT_MAX_CONTINUATIONS = 1;
const SCRIPT_DRAFT_CONTINUATION_MAX_CHARS = 700;
const SCRIPT_SANITY_REVIEW_MAX_ISSUES = 3;
const SCRIPT_SANITY_REVIEW_CODES = new Set([
  'CHARACTER_PRESENCE',
  'SPEAKER_ATTRIBUTION',
  'PROP_CUSTODY',
  'KNOWLEDGE_TIMING',
  'CAUSAL_ORDER',
  'CONTINUITY_CONTRADICTION',
  'REPEATED_ACTION',
]);

function summarizeStructuredCalls(
  metrics: readonly ScriptStructuredCallMetric[],
): ScriptBatchCallSummary {
  const byNode: Partial<Record<ScriptModelNode, number>> = {};
  const byEpisodeMap = new Map<number, number>();
  let primaryCalls = 0;
  let fixupCalls = 0;
  let fallbackCalls = 0;
  for (const metric of metrics) {
    byNode[metric.node] = (byNode[metric.node] ?? 0) + metric.callsUsed;
    if (metric.episodeNumber !== undefined) {
      byEpisodeMap.set(
        metric.episodeNumber,
        (byEpisodeMap.get(metric.episodeNumber) ?? 0) + metric.callsUsed,
      );
    }
    for (const attempt of metric.attempts) {
      if (attempt.stage === 'primary') primaryCalls += 1;
      else if (attempt.stage === 'fixup') fixupCalls += 1;
      else fallbackCalls += 1;
    }
  }
  return {
    totalCalls: primaryCalls + fixupCalls + fallbackCalls,
    primaryCalls,
    fixupCalls,
    fallbackCalls,
    byNode,
    byEpisode: [...byEpisodeMap.entries()]
      .sort(([left], [right]) => left - right)
      .map(([episodeNumber, calls]) => ({ episodeNumber, calls })),
  };
}

function scriptTextComposition(episode: ScriptEpisode): ScriptTextComposition {
  const blocks = episode.scenes.flatMap((scene) => scene.blocks);
  const visibleChars = blocks.reduce(
    (total, block) => total + visibleTextChars(block.text),
    0,
  );
  const dialogueChars = blocks.reduce(
    (total, block) => total + (block.type === 'dialogue' ? visibleTextChars(block.text) : 0),
    0,
  );
  return {
    visibleChars,
    dialogueChars,
    nonDialogueChars: visibleChars - dialogueChars,
    dialogueDensityPercent: visibleChars === 0
      ? 0
      : Math.round(dialogueChars / visibleChars * 100),
  };
}

function draftContinuationRequest(
  episode: ScriptEpisode,
  targetChars: number,
): {
  current: ScriptTextComposition;
  minimumVisibleChars: number;
  requestedVisibleChars: number;
} | undefined {
  const current = scriptTextComposition(episode);
  const preferredMinimum = Math.ceil(targetChars * SCRIPT_DRAFT_PREFERRED_MIN_RATIO);
  if (current.visibleChars >= preferredMinimum) return undefined;
  const requestedVisibleChars = Math.min(
    SCRIPT_DRAFT_CONTINUATION_MAX_CHARS,
    Math.max(1, targetChars - current.visibleChars),
  );
  return {
    current,
    minimumVisibleChars: preferredMinimum,
    requestedVisibleChars,
  };
}

function normalizedExpansionDialogue(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]/gu, '');
}

function expansionDialogueSimilarity(left: string, right: string): number {
  if (left === right) return left.length === 0 ? 0 : 1;
  if (left.length === 0 || right.length === 0) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        (current[column - 1] ?? 0) + 1,
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  const distance = previous[right.length] ?? Math.max(left.length, right.length);
  return 1 - distance / Math.max(left.length, right.length);
}

function applyDraftExpansion(
  base: ScriptEpisode,
  expansion: ScriptDraftExpansion,
  createId: () => string,
): ScriptEpisode {
  const episode = structuredClone(base);
  const finalScene = episode.scenes.at(-1);
  const insertionAnchorBySceneOrdinal = new Map(
    episode.scenes.map((scene) => {
      const protectedTailLength = scene === finalScene ? Math.min(2, scene.blocks.length) : 1;
      return [
        scene.ordinal,
        protectedTailLength > 0 ? scene.blocks.at(-protectedTailLength)?.id : undefined,
      ] as const;
    }),
  );
  const existingIds = new Set(
    episode.scenes.flatMap((scene) => scene.blocks.map((block) => block.id)),
  );
  for (const input of expansion.blocks) {
    const scene = episode.scenes.find((candidate) => candidate.ordinal === input.sceneOrdinal);
    if (!scene) {
      throw new ScriptModelOutputError(`增量正文引用了不存在的场号 ${input.sceneOrdinal}。`);
    }
    const id = createId();
    if (!id || existingIds.has(id)) {
      throw new ScriptModelOutputError(`增量正文块 ID 冲突: ${id || '空 ID'}。`);
    }
    existingIds.add(id);
    const block: ScriptBlock = input.type === 'dialogue'
      ? {
          id,
          type: 'dialogue',
          characterId: input.characterId,
          speaker: input.speaker,
          ...(input.delivery ? { delivery: input.delivery } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
          text: input.text,
        }
      : { id, type: 'action', text: input.text };
    const insertionAnchorId = insertionAnchorBySceneOrdinal.get(scene.ordinal);
    if (insertionAnchorId) {
      const insertionIndex = scene.blocks.findIndex((candidate) => candidate.id === insertionAnchorId);
      if (insertionIndex >= 0) {
        scene.blocks.splice(insertionIndex, 0, block);
        continue;
      }
    }
    scene.blocks.push(block);
  }
  return episode;
}

function gateDecodeIssues(
  issues: readonly ScriptGateIssue[],
): StructuredDecodeIssue[] {
  return issues.map((issue) => ({
    path: issue.path?.split('.').filter(Boolean) ?? [],
    code: issue.code,
    message: [
      issue.sceneId ? `sceneId=${issue.sceneId}` : '',
      issue.blockId ? `blockId=${issue.blockId}` : '',
      issue.message,
    ].filter(Boolean).join('；'),
  }));
}

type RevisionSemanticIssueCode =
  | 'revision.policy'
  | 'revision.apply'
  | 'revision.length'
  | 'revision.canonical'
  | 'revision.quality';

class ScriptRevisionSemanticError extends ScriptRevisionPatchError {
  constructor(
    readonly validationCode: RevisionSemanticIssueCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScriptRevisionSemanticError';
  }
}

function visibleTextChars(value: string): number {
  return value.replace(/\s/gu, '').length;
}

function revisionPolicyPromptContext(
  base: ScriptEpisode,
  policy: ScriptRevisionPatchPolicy,
  targetChars: number,
): string[] {
  const permissions = policy.rules.flatMap((rule) => {
    if (rule.target === 'blockText') {
      return [{ op: 'replaceBlockText', sceneId: rule.sceneId, blockId: rule.blockId }];
    }
    if (rule.target === 'longReduction') {
      return rule.allowedBlocks.map((target) => ({ op: 'replaceBlockText', ...target }));
    }
    if (rule.target === 'sceneCharacters') {
      return [{ op: 'updateSceneCharacters', sceneId: rule.sceneId }];
    }
    if (rule.target === 'sceneAppend') {
      return [{ op: 'appendBlock', sceneId: rule.sceneId }];
    }
    if (rule.target !== 'shortExpansion') return [];
    return [
      { op: 'appendBlock', sceneId: rule.sceneId },
      ...rule.allowedAfterBlockIds.map((afterBlockId) => ({
        op: 'insertBlockAfter',
        sceneId: rule.sceneId,
        afterBlockId,
      })),
    ];
  });
  const uniquePermissions = [...new Map(
    permissions.map((permission) => [JSON.stringify(permission), permission]),
  ).values()];
  const currentChars = scriptVisibleChars(base);
  return [
    `精确 revisionPolicy（唯一授权来源）：${JSON.stringify(policy)}`,
    `唯一允许的操作与锚点（未列出的一律禁止）：${JSON.stringify(uniquePermissions)}`,
    `每块当前可见字数：${JSON.stringify(base.scenes.map((scene) => ({
      sceneId: scene.id,
      blocks: scene.blocks.map((block) => ({
        blockId: block.id,
        type: block.type,
        visibleChars: visibleTextChars(block.text),
      })),
    })))}`,
    `目标总字数：${JSON.stringify({
      current: currentChars,
      target: targetChars,
      minimum: Math.ceil(targetChars * 0.75),
      maximum: Math.floor(targetChars * 1.25),
      idealNetChange: targetChars - currentChars,
    })}`,
  ];
}

function deterministicRevisionValidationIdFactory(base: ScriptEpisode): () => string {
  const existing = new Set(base.scenes.flatMap((scene) => [
    scene.id,
    ...scene.blocks.map((block) => block.id),
  ]));
  let sequence = 0;
  return () => {
    let candidate: string;
    do {
      sequence += 1;
      candidate = `revision-validation-${sequence}`;
    } while (existing.has(candidate));
    existing.add(candidate);
    return candidate;
  };
}

function redactStructuredValidationMessage(code: string, message: string): string {
  if (code === 'model.call_failed' || code === 'contract.decode_threw') {
    return '模型调用或结构契约执行失败；提供方详情未写入检查点。';
  }
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/giu, '[REDACTED]')
    .replace(/\b(?:authorization|bearer|api[_ -]?key)\b\s*[:=]?\s*\S+/giu, '[REDACTED]')
    .slice(0, 500);
}

function redactRevisionValidationMessage(code: string, message: string): string {
  return redactStructuredValidationMessage(code, message);
}

function sanitizedStructuredValidationErrors(
  error: StructuredGenerationError,
): ScriptCheckpointValidationError[] {
  const sanitized = [
    ...error.attempts.flatMap((attempt) => attempt.issues),
    ...error.issues,
  ].map((issue) => ({
    ...(issue.path.length > 0
      ? { path: issue.path.reduce<string>((path, segment) =>
          typeof segment === 'number' ? `${path}[${segment}]` : `${path}.${segment}`, '$') }
      : {}),
    code: /^[A-Za-z0-9_.-]{1,80}$/u.test(issue.code) ? issue.code : 'structured.invalid',
    message: redactStructuredValidationMessage(issue.code, issue.message),
  }));
  const unique = [...new Map(sanitized.map((issue) => [
    JSON.stringify(issue),
    issue,
  ])).values()];
  return unique
    .sort((left, right) =>
      Number(right.code.startsWith('revision.')) -
      Number(left.code.startsWith('revision.')))
    .slice(0, 8);
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

const SERIES_SYNOPSIS_MIN_CHARS = 450;

function synopsisFragment(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized) return '';
  return /[。！？]$/u.test(normalized) ? normalized : `${normalized}。`;
}

/**
 * Keeps a useful model-written synopsis intact, but expands a one-line result
 * locally from the approved plan and generated cards. This does not make an
 * extra model call and therefore cannot turn a short synopsis into a stuck job.
 */
function completeSeriesSynopsis(
  original: string,
  plan: ScriptPlan,
  cards: readonly ScriptEpisodeCard[],
  milestones: {
    openingState: string;
    midpointTurn: string;
    climax: string;
    endingState: string;
    mainArc: readonly string[];
    subplotArcs: readonly string[];
  },
): string {
  const normalizedOriginal = original.replace(/\s+/gu, ' ').trim();
  if (normalizedOriginal.length >= SERIES_SYNOPSIS_MIN_CHARS) return normalizedOriginal;

  const paragraphs: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const fragment = synopsisFragment(value);
    if (!fragment || seen.has(fragment)) return;
    seen.add(fragment);
    paragraphs.push(fragment);
  };
  add(normalizedOriginal);
  add(`《${plan.title}》面向${plan.audience}，以“${plan.theme}”为主题，围绕“${plan.coreConflict}”展开。${plan.logline}`);
  add(`开篇阶段，${milestones.openingState} 主角由此被卷入核心矛盾，必须在连续升级的阻力中作出选择并推动局面变化`);

  const addCard = (card: ScriptEpisodeCard): void => add(
    `推进到第${card.episodeNumber}集《${card.title}》时，${card.logline} 主要事件是：${card.mainEvent} 本集以“${card.endingHook}”形成下一阶段的推动力`,
  );
  add(`全剧主线依次推进${milestones.mainArc.join('、') || plan.coreConflict}；支线围绕${milestones.subplotArcs.join('、') || plan.highlights.join('、') || plan.theme}展开，并持续影响主角的判断与关系`);
  add(`中段发生关键转折：${milestones.midpointTurn} 此后人物从被动应对转为主动破局，前段埋下的线索、关系和利益冲突开始汇合`);
  add(`高潮阶段，${milestones.climax} 冲突在公开行动或不可回避的正面对抗中兑现，主角必须为此前的选择承担代价`);
  add(`最终，${milestones.endingState || plan.endingDirection} 结局回应开篇提出的核心矛盾，并完成主要人物的阶段性成长与主题落点`);

  // Add representative concrete events only while the structural paragraphs
  // are still short, so the local completion stays around 500–700 Chinese
  // characters instead of dumping dozens of cards into the synopsis.
  const milestoneIndexes = new Set<number>();
  if (cards.length > 0) {
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      milestoneIndexes.add(Math.min(cards.length - 1, Math.round((cards.length - 1) * ratio)));
    }
  }
  for (const index of [...milestoneIndexes].sort((left, right) => left - right)) {
    if (paragraphs.join('\n\n').length >= 540) break;
    const card = cards[index];
    if (card) addCard(card);
  }
  if (paragraphs.join('\n\n').length < SERIES_SYNOPSIS_MIN_CHARS) {
    add(`创作执行中保持“${plan.coreRequirements}”，突出${plan.highlights.join('、') || plan.genres.join('、')}，并避免${plan.forbiddenElements.join('、') || '无因果的突变'}，使每一阶段都能自然承接下一阶段`);
  }
  return paragraphs.join('\n\n');
}

/**
 * Produces a complete, editable outline chunk from the already approved plan.
 * This is deliberately local: if the provider cannot return even the first
 * chunk, the job must still finish instead of leaving an empty outline behind.
 */
function directSeriesOutlineChunk(
  plan: ScriptPlan,
  start: number,
  end: number,
  previousBoundary: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const phaseFor = (episodeNumber: number): string => {
    const progress = episodeNumber / plan.totalEpisodes;
    if (progress <= 0.2) return '危机显现';
    if (progress <= 0.45) return '主动破局';
    if (progress <= 0.7) return '局势逆转';
    if (progress <= 0.9) return '终局逼近';
    return '结局兑现';
  };
  const previousHook = previousBoundary.at(-1)?.endingHook;
  const episodeCards = Array.from({ length: end - start + 1 }, (_, offset) => {
    const episodeNumber = start + offset;
    const phase = phaseFor(episodeNumber);
    const isLastEpisode = episodeNumber === plan.totalEpisodes;
    const nextPhase = phaseFor(Math.min(plan.totalEpisodes, episodeNumber + 1));
    const bridge = offset === 0 && typeof previousHook === 'string' && previousHook.trim()
      ? `承接上一集“${previousHook.trim()}”，`
      : '';
    return {
      episodeNumber,
      title: `第${episodeNumber}集 ${phase}`,
      logline: `${bridge}主角围绕“${plan.coreConflict}”推进到${phase}阶段。`,
      mainEvent: `在${plan.theme}主题下，主线完成第${episodeNumber}步推进，并形成一次可见的行动结果。`,
      endingHook: isLastEpisode
        ? plan.endingDirection
        : `新的证据或阻力出现，把剧情推向下一阶段“${nextPhase}”。`,
    };
  });
  return {
    synopsis: plan.logline,
    openingState: `故事从“${plan.coreConflict}”全面显现开始。`,
    midpointTurn: `主角取得关键证据或盟友，围绕“${plan.coreConflict}”转守为攻。`,
    climax: `核心冲突在终局正面爆发，${plan.highlights.at(-1) ?? plan.theme}成为胜负关键。`,
    endingState: plan.endingDirection,
    mainArc: [plan.coreConflict, plan.endingDirection],
    subplotArcs: plan.highlights.length > 0 ? [...plan.highlights] : [...plan.genres],
    episodeCards,
  };
}

export class ScriptDirector {
  constructor(private readonly dependencies: ScriptDirectorDependencies) {}

  async run(request: ScriptDirectorRequest): Promise<ScriptDirectorResult> {
    if (request.task === 'script_series_outline') {
      return this.generateSeriesOutline(
        request.projectId,
        request.signal,
        request.onProgress,
        request.regenerate === true,
        request.regenerationRunId,
      );
    }
    if (request.task === 'script_bible') {
      return this.generateBible(
        request.projectId,
        request.signal,
        request.resumeRejectedCandidates === true,
        request.regenerate === true,
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
          '优先返回以下字段；不确定的辅助字段可以省略，系统会本地补齐：',
          'title, theme, market, channel, genres, audience, coreConflict, logline, highlights,',
          'totalEpisodes, episodeDurationSeconds, targetCharsPerEpisode, maxPrimaryCharacters,',
          'maxScenesPerEpisode, dialogueDensityPercent, language, format, coreRequirements,',
          'forbiddenElements, endingDirection；coverPrompt 可选。',
        ].join(' '),
        'episodeDurationSeconds 建议使用 {"min":数字,"max":数字}；genres、highlights、forbiddenElements 建议使用字符串数组。',
        'market 优先使用 domestic/overseas，channel 优先使用 female/male/general；中文值和少量格式偏差也可由系统转换。',
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
    const planId = current?.id ?? this.dependencies.id?.() ?? randomUUID();
    const completePlan = (parsed: Record<string, unknown>): ScriptPlan => {
      const candidate = coerceScriptPlanCandidate(parsed, {
        projectId: request.projectId,
        now,
        id: planId,
        ...(current ? { current } : {}),
        explicit,
        seedPrompt: request.seedPrompt,
      });
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
    };
    let plan: ScriptPlan;
    let planFallbackReason: string | undefined;
    try {
      plan = await this.generateNodeStructured({
        node: 'plan', projectId: request.projectId, prompt, signal: request.signal,
      }, parserContract(
        'script_plan',
        '返回可用的短剧策划即可；系统会从用户已确认选项和安全默认值补齐非关键缺项。',
        completePlan,
      ));
    } catch (error) {
      if (!(error instanceof ScriptStructuredNeedsReviewError)) throw error;
      planFallbackReason = '模型未返回可解析策划，已根据用户确认项生成可编辑策划。';
      plan = completePlan({});
    }
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
      validationErrors: planFallbackReason
        ? [{ code: 'script_plan.local_fallback', message: planFallbackReason }]
        : [],
      updatedAt: now,
    });
    return { kind: 'plan_draft', plan: saved };
  }

  private async generateSeriesOutline(
    projectId: string,
    signal?: AbortSignal,
    onProgress?: (event: ScriptProgressEvent) => void | Promise<void>,
    regenerate = false,
    regenerationRunId?: string,
  ): Promise<ScriptDirectorResult> {
    const state = await this.dependencies.store.getProjectState(projectId);
    const plan = state?.plan;
    if (!plan || (plan.status !== 'approved' && plan.status !== 'locked')) {
      throw new ScriptModelOutputError('生成全剧大纲前必须先确认策划。');
    }
    if (!regenerate && state?.seriesOutline?.episodeCards.length === plan.totalEpisodes) {
      return { kind: 'series_outline', outline: state.seriesOutline };
    }

    const runKey = 'script_series_outline';
    const checkpoints = await this.dependencies.checkpoints.list(projectId, runKey);
    const configRevision = await this.modelConfigFingerprint();
    const regenerationMarkerChunk = plan.totalEpisodes + 1;
    const regenerationInitialized = Boolean(
      regenerate &&
      regenerationRunId &&
      checkpoints.some((checkpoint) => {
        if (checkpoint.node !== 'series_outline' || checkpoint.chunkStart !== regenerationMarkerChunk) return false;
        const artifact = checkpoint.artifact;
        return Boolean(
          artifact &&
          typeof artifact === 'object' &&
          !Array.isArray(artifact) &&
          (artifact as Record<string, unknown>).stage === 'regeneration_started' &&
          (artifact as Record<string, unknown>).regenerationRunId === regenerationRunId,
        );
      })
    );
    if (regenerate && !regenerationInitialized && regenerationRunId) {
      for (const checkpoint of checkpoints) {
        if (checkpoint.node === 'series_outline' && checkpoint.chunkStart !== regenerationMarkerChunk && checkpoint.status !== 'stale') {
          await this.markCheckpointStale(checkpoint);
        }
      }
      const markerRevision = await this.nextCheckpointArtifactRevision(
        projectId,
        runKey,
        { node: 'series_outline', chunkStart: regenerationMarkerChunk },
      );
      await this.dependencies.checkpoints.save({
        projectId,
        runKey,
        node: 'series_outline',
        status: 'running',
        attempt: 1,
        artifactRevision: markerRevision,
        chunkStart: regenerationMarkerChunk,
        artifact: { schemaVersion: 1, stage: 'regeneration_started', regenerationRunId },
        validationErrors: [],
        updatedAt: this.dependencies.now?.() ?? new Date().toISOString(),
      });
    }
    const inputRevisionRefs = [{ resource: 'plan' as const, id: plan.id, revision: plan.revision }];
    const chunks: Record<string, unknown>[] = [];
    let directFallbackReason: string | undefined;
    for (let start = 1; start <= plan.totalEpisodes; start += 10) {
      const end = Math.min(plan.totalEpisodes, start + 9);
      const previousChunkCards = chunks.at(-1)?.episodeCards;
      const previousBoundary = Array.isArray(previousChunkCards)
        ? previousChunkCards.slice(-2).map((candidate) => {
            const card = recordField(candidate, 'previousEpisodeCard');
            return {
              episodeNumber: numberField(card.episodeNumber, 'episodeNumber'),
              title: stringField(card.title, 'title'),
              mainEvent: stringField(card.mainEvent, 'mainEvent'),
              endingHook: stringField(card.endingHook, 'endingHook'),
            };
          })
        : [];
      const upstreamArtifactRefs = [buildScriptUpstreamArtifactRef(
        'series_outline_range',
        start,
        { start, end, totalEpisodes: plan.totalEpisodes },
      ), ...(previousBoundary.length > 0
        ? [buildScriptUpstreamArtifactRef(
            'series_outline_previous_boundary',
            start,
            previousBoundary,
          )]
        : [])];
      const promptVersion = 'series-outline-chunk-v4';
      const inputFingerprint = computeScriptCheckpointInputFingerprint({
        node: 'series_outline',
        inputRevisionRefs,
        upstreamArtifactRefs,
        promptVersion,
        configRevision,
      });
      const completeOutlineChunk = (value: Record<string, unknown>): Record<string, unknown> => {
        const completed = coerceSeriesOutlineChunk(value, {
          plan,
          start,
          end,
          previousBoundary,
        });
        const canonical = canonicalModelCandidate(() => decodeScriptSeriesOutlineInput({
          ...completed,
          episodeCards: (completed.episodeCards as unknown[]).map((card, index) => ({
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
      };
      const restored = latestScriptCheckpoint(checkpoints, {
        node: 'series_outline',
        chunkStart: start,
      });
      if (restored) {
        if (regenerate && !regenerationInitialized && !regenerationRunId && restored.status !== 'stale') {
          await this.markCheckpointStale(restored);
        }
        const decision = decideScriptCheckpointResume(restored, inputFingerprint);
        if ((!regenerate || regenerationInitialized) && decision.disposition === 'reuse' && restored.artifact !== undefined) {
          // Older checkpoints may predate the lenient contract. Normalize them
          // on reuse so a sparse/duplicated old chunk cannot break the final
          // 1..N merge or leave a resumed outline stuck.
          chunks.push(completeOutlineChunk(recordField(restored.artifact, 'seriesOutlineChunk')));
          continue;
        }
        if (decision.disposition === 'stale') await this.markCheckpointStale(restored);
      }
      const prompt = [
        '你是 SeriesOutlineAgent，生成全剧总纲和指定范围的轻量分集卡。',
        `本段只返回第 ${start}—${end} 集；请尽量给全，缺集、重号和乱序会由系统补齐。`,
        start === 1
          ? 'synopsis 必须写成 450—650 个汉字的全剧大纲，不是一句话简介。要完整交代故事起因、矛盾升级、关键反转、人物选择、高潮对决和最终结局，并能直接指导后续各集写作。'
          : '本段重点写分集卡；synopsis 可简写或沿用全剧大纲，最终以第一段的完整 synopsis 为准。',
        '每张分集卡要具体：title 约 4—12 字；logline 约 40—80 字；mainEvent 约 40—100 字；endingHook 约 20—50 字。不要只写“调查真相”“冲突升级”这类空话。',
        '只返回 JSON，字段：synopsis, openingState, midpointTurn, climax, endingState, mainArc, subplotArcs, episodeCards。',
        '建议模板：{"synopsis":"字符串","openingState":"字符串","midpointTurn":"字符串","climax":"字符串","endingState":"字符串","mainArc":["字符串"],"subplotArcs":["字符串"],"episodeCards":[{"episodeNumber":1,"title":"字符串","logline":"字符串","mainEvent":"字符串","endingHook":"字符串"}]}。优先使用这些键，辅助缺项可省略。',
        previousBoundary.length > 0
          ? `上一段最后两集：${JSON.stringify(previousBoundary)}。本段第 ${start} 集必须直接承接上一集 endingHook；已经发生、取得或发现的关键事件不得重新当作首次发生。`
          : '',
        `已锁定策划：${JSON.stringify(plan)}`,
      ].filter(Boolean).join('\n');
      const artifactRevision = await this.nextCheckpointArtifactRevision(
        projectId,
        runKey,
        { node: 'series_outline', chunkStart: start },
      );
      const checkpointBase = {
        projectId,
        runKey,
        node: 'series_outline' as const,
        attempt: 1,
        artifactRevision,
        chunkStart: start,
        inputRevisionRefs,
        upstreamArtifactRefs,
        promptVersion,
        configRevision,
        inputFingerprint,
      };
      await this.dependencies.checkpoints.save({
        ...checkpointBase,
        status: 'running',
        validationErrors: [],
        updatedAt: this.dependencies.now?.() ?? new Date().toISOString(),
      });
      await onProgress?.({
        phase: 'info',
        message: directFallbackReason
          ? `正在用保底方案生成第 ${start}—${end} 集分集卡…`
          : `正在生成第 ${start}—${end} 集分集卡…`,
        current: start,
        total: plan.totalEpisodes,
        scriptCheckpoint: {
          node: 'series_outline',
          attempt: 1,
          artifactRevision,
        },
      });
      const contract = parserContract(
        'series_outline_chunk',
        `返回第 ${start}—${end} 集可直接指导正文的剧情；系统会补齐缺项并强制集号连续唯一，不因篇幅不足卡死。`,
        completeOutlineChunk,
      );
      let parsed: Record<string, unknown>;
      if (directFallbackReason) {
        parsed = directSeriesOutlineChunk(plan, start, end, previousBoundary);
      } else {
        try {
          parsed = await this.generateNodeStructured({
            node: 'series_outline',
            projectId,
            chunkStart: start,
            chunkEnd: end,
            prompt,
            signal,
          }, contract);
        } catch (error) {
          if (!(error instanceof ScriptStructuredNeedsReviewError)) throw error;
          if (regenerate && state.seriesOutline) {
            error.message = '全剧大纲重新生成失败，已完整保留原大纲；可再次点击重新生成。';
            await this.dependencies.checkpoints.save({
              ...checkpointBase,
              status: 'needs_review',
              validationErrors: [{
                code: 'series_outline.regenerate_failed',
                message: error.message,
              }],
              updatedAt: this.dependencies.now?.() ?? new Date().toISOString(),
            });
            throw error;
          }
          directFallbackReason = '模型未在固定结构预算内返回有效分集卡，已自动补全剩余大纲。';
          parsed = directSeriesOutlineChunk(plan, start, end, previousBoundary);
        }
      }
      // Apply the same canonical decoder to local fallback output. The fallback
      // may be simpler than the model result, but it is never allowed to bypass
      // the saved outline contract.
      const decoded = contract.decode(parsed);
      if (!decoded.success) {
        throw new ScriptModelOutputError('保底分集卡未通过全剧大纲结构校验。');
      }
      parsed = decoded.value as unknown as Record<string, unknown>;
      chunks.push(parsed);
      await this.dependencies.checkpoints.save({
        ...checkpointBase,
        status: 'succeeded',
        artifact: parsed,
        validationErrors: directFallbackReason
          ? [{ code: 'series_outline.local_fallback', message: directFallbackReason }]
          : [],
        updatedAt: this.dependencies.now?.() ?? new Date().toISOString(),
      });
      await onProgress?.({
        phase: 'info',
        message: directFallbackReason
          ? `第 ${start}—${end} 集分集卡已由保底方案生成并保存。`
          : `第 ${start}—${end} 集分集卡已生成并保存。`,
        current: end,
        total: plan.totalEpisodes,
        scriptCheckpoint: {
          node: 'series_outline',
          attempt: 1,
          artifactRevision,
        },
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
    const openingState = stringField(first.openingState, 'openingState');
    const midpointTurn = stringField(first.midpointTurn, 'midpointTurn');
    const climax = stringField(first.climax, 'climax');
    const endingState = stringField(first.endingState, 'endingState');
    const mainArc = stringsField(first.mainArc, 'mainArc');
    const subplotArcs = stringsField(first.subplotArcs, 'subplotArcs');
    const candidateOutline: ScriptSeriesOutline = {
      projectId,
      synopsis: completeSeriesSynopsis(stringField(first.synopsis, 'synopsis'), plan, cards, {
        openingState,
        midpointTurn,
        climax,
        endingState,
        mainArc,
        subplotArcs,
      }),
      openingState,
      midpointTurn,
      climax,
      endingState,
      mainArc,
      subplotArcs,
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
    regenerate = false,
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
      if (!regenerate && state.characters.length > 0) return state.characters;
      let preservedCharacters: Array<{ index: number; character: ScriptCharacter }> = [];
      let failedIndexes: number[] = [];
      let characterCount: number | undefined;
      try {
        const prompt = [
          '你是 CharacterDesignAgent。根据策划和大纲生成结构化人物圣经。',
          '只返回 JSON 对象 {"characters": [...]} ，不输出思考过程。',
          '每个人物优先包含 name、role、身份、动机和人物弧光；其余外貌、服装、语言风格等字段尽量提供，缺项由系统本地补齐。',
          'role 优先使用 lead/supporting/antagonist/minor；数组和 relationship 格式有轻微偏差也可由系统转换。',
          `当前策划允许最多 ${plan.maxPrimaryCharacters} 个非 minor 主要人物；请以当前数字为准，不沿用旧候选约束。`,
          regenerate && state.characters.length > 0
            ? `这是重新生成人物。相同人物必须沿用以下已有 id；可以改善内容，但不要给同一人物换 id：${JSON.stringify(state.characters.map((character) => ({ id: character.id, name: character.name, aliases: character.aliases, role: character.role })))}。`
            : '',
          resumeRejectedCandidates
            ? '这是用户显式恢复后的新候选生成；必须重新依据下方最新策划与大纲作答。'
            : '',
          `策划：${JSON.stringify(plan)}`,
          `大纲：${JSON.stringify(outline)}`,
        ].filter(Boolean).join('\n');
        const characterContract = defineStructuredContract<ScriptCharacter[]>({
          name: 'character_bible',
          version: 3,
          instructions: [
            '返回 {"characters":[人物...]} 即可；系统会本地补齐人物的非关键缺项。',
            '若校验错误只指向部分 characters[i]，修复时只改这些索引；可返回完整 characters 数组，或 {"repairs":[{"index":i,"character":{...}}]}。',
            '未报错人物会由系统保留，模型对它们的改写不会生效。',
          ].join(''),
          decode: (raw) => {
            // Missing descriptive fields, invalid optional relationships and an
            // empty cast are all recoverable locally. This happens before the
            // existing canonical/uniqueness boundary, so it consumes no extra
            // model call and cannot alter project or revision ownership.
            raw = {
              characters: coerceCharacterBibleCandidate(raw, { projectId, now, plan }),
            };
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
        let generated: ScriptCharacter[];
        let characterFallbackReason: string | undefined;
        try {
          generated = await this.generateNodeStructured({
            node: 'character_bible', projectId, prompt, signal,
          }, characterContract);
        } catch (error) {
          if (!(error instanceof ScriptStructuredNeedsReviewError)) throw error;
          if (regenerate && state.characters.length > 0) {
            error.message = '人物重新生成失败，已完整保留原人物卡；可再次点击重新生成。';
            throw error;
          }
          const completed = characterContract.decode({});
          if (!completed.success) throw error;
          generated = completed.value;
          characterFallbackReason = '模型未返回可解析人物资料，已生成最小可编辑人物卡。';
        }
        signal?.throwIfAborted();
        const stableGenerated = regenerate
          ? stabilizeRegeneratedCharacters(generated, state.characters, plan.maxPrimaryCharacters)
          : generated;
        const expectedRevision = Math.max(0, ...state.characters.map((character) => character.revision));
        const saved = await this.dependencies.store.saveCharacters(projectId, stableGenerated, expectedRevision);
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
          validationErrors: characterFallbackReason
            ? [{ code: 'character_bible.local_fallback', message: characterFallbackReason }]
            : [],
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
      if (!regenerate && state.worldBible) return state.worldBible;
      try {
        const prompt = [
          '你是 WorldDesignAgent。根据策划和大纲生成结构化世界圣经。',
          '只返回 JSON，不输出思考过程。',
          '建议模板：{"era":"字符串","primaryLocations":["字符串"],"worldState":"字符串","rules":["字符串"],"transport":["字符串"],"communication":["字符串"],"organizations":["字符串"],"recurringProps":["字符串"],"forbiddenAnachronisms":["字符串"]}。时代、主要地点、世界状态最重要，辅助数组可以省略。',
          `策划：${JSON.stringify(plan)}`,
          `大纲：${JSON.stringify(outline)}`,
        ].join('\n');
        const worldContract = parserContract(
          'world_bible',
          '返回主要时代、地点和世界状态即可；系统会把省略的辅助数组补为空数组。',
          (value) => {
            const completed = coerceWorldBibleCandidate(value, { projectId, now, plan });
            const canonical = canonicalModelCandidate(() => decodeScriptWorldBibleInput(completed));
            return { ...canonical, projectId, revision: 0, updatedAt: now };
          },
        );
        let generated: ScriptWorldBible;
        let worldFallbackReason: string | undefined;
        try {
          generated = await this.generateNodeStructured({
            node: 'world_bible', projectId, prompt, signal,
          }, worldContract);
        } catch (error) {
          if (!(error instanceof ScriptStructuredNeedsReviewError)) throw error;
          if (regenerate && state.worldBible) {
            error.message = '世界设定重新生成失败，已完整保留原世界设定；可再次点击重新生成。';
            throw error;
          }
          const completed = worldContract.decode({});
          if (!completed.success) throw error;
          generated = completed.value;
          worldFallbackReason = '模型未返回可解析世界观，已生成最小可编辑世界设定。';
        }
        signal?.throwIfAborted();
        const saved = await this.dependencies.store.saveWorldBible(
          generated,
          state.worldBible?.revision ?? 0,
        );
        const artifactRevision = await this.nextCheckpointArtifactRevision(
          projectId,
          'script_bible',
          { node: 'world_bible' },
        );
        await this.dependencies.checkpoints.save({
          projectId, runKey: 'script_bible', node: 'world_bible', status: 'succeeded',
          attempt: 1, artifactRevision, artifact: saved,
          validationErrors: worldFallbackReason
            ? [{ code: 'world_bible.local_fallback', message: worldFallbackReason }]
            : [],
          updatedAt: now,
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
    if (charactersResult.status === 'rejected' || worldResult.status === 'rejected') {
      // The UI presents this as one “人物与世界” rewrite. If either half
      // fails, restore the other half's old content so a partial success never
      // leaves the project in a mixed old/new bible state. Store revisions may
      // advance, but the user-visible canon and every referenced character ID
      // remain unchanged.
      if (regenerate) {
        const rollbacks: Promise<unknown>[] = [];
        if (charactersResult.status === 'fulfilled' && state.characters.length > 0) {
          const writtenRevision = Math.max(
            0,
            ...charactersResult.value.map((character) => character.revision),
          );
          rollbacks.push(this.dependencies.store.saveCharacters(
            projectId,
            state.characters,
            writtenRevision,
          ));
        }
        if (worldResult.status === 'fulfilled' && state.worldBible) {
          rollbacks.push(this.dependencies.store.saveWorldBible(
            state.worldBible,
            worldResult.value.revision,
          ));
        }
        const rollbackResults = await Promise.allSettled(rollbacks);
        const rollbackFailure = rollbackResults.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (rollbackFailure) {
          const message = rollbackFailure.reason instanceof Error
            ? rollbackFailure.reason.message
            : String(rollbackFailure.reason);
          throw new ScriptModelOutputError(
            `人物与世界重新生成失败，且恢复旧设定时写入失败：${message}`,
          );
        }
      }
      if (charactersResult.status === 'rejected') throw charactersResult.reason;
      throw (worldResult as PromiseRejectedResult).reason;
    }
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
    const structuredCallMetrics: ScriptStructuredCallMetric[] = [];
    const recordStructuredCall = (metric: ScriptStructuredCallMetric): void => {
      structuredCallMetrics.push(metric);
    };
    const completed = state.episodes.filter(
      (episode) =>
        range.includes(episode.episodeNumber) &&
        episode.status === 'completed' &&
        hasCanonicalContinuity(state, episode),
    );
    if (!request.regenerate && completed.length === range.length) {
      return {
        kind: 'episode_batch',
        episodes: completed.sort((left, right) => left.episodeNumber - right.episodeNumber),
        reports: [],
        skippedEpisodeNumbers: [...range],
        callSummary: summarizeStructuredCalls(structuredCallMetrics),
      };
    }

    const runKey = `script_episode_batch:${request.startEpisode}:${request.episodeCount}`;
    const existingCheckpoints = await this.dependencies.checkpoints.list(request.projectId, runKey);
    const configRevision = await this.modelConfigFingerprint();
    const regenerationInitialized = Boolean(
      request.regenerate &&
      request.regenerationRunId &&
      existingCheckpoints.some((checkpoint) => {
        if (checkpoint.node !== 'batch_report' || checkpoint.chunkStart !== request.startEpisode) {
          return false;
        }
        const artifact = checkpoint.artifact;
        return Boolean(
          artifact &&
          typeof artifact === 'object' &&
          !Array.isArray(artifact) &&
          (artifact as Record<string, unknown>).stage === 'regeneration_started' &&
          (artifact as Record<string, unknown>).regenerationRunId === request.regenerationRunId,
        );
      })
    );
    if (request.regenerate && !regenerationInitialized) {
      // A deliberate rewrite keeps the stored episodes visible until each new
      // candidate commits, but it must not silently reuse old AI artifacts.
      // Plan-lock provenance remains reusable; every generation/review node in
      // this range is marked stale before fresh work begins.
      for (const checkpoint of existingCheckpoints) {
        if (
          checkpoint.status !== 'stale' &&
          checkpoint.node !== 'plan' &&
          checkpoint.node !== 'batch_report' &&
          (checkpoint.episodeNumber === undefined || range.includes(checkpoint.episodeNumber))
        ) {
          await this.markCheckpointStale(checkpoint);
        }
      }
      if (request.regenerationRunId) {
        const markerRevision = await this.nextCheckpointArtifactRevision(
          request.projectId,
          runKey,
          { node: 'batch_report', chunkStart: request.startEpisode },
        );
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'batch_report',
          status: 'running',
          attempt: 1,
          artifactRevision: markerRevision,
          chunkStart: request.startEpisode,
          artifact: {
            schemaVersion: 1,
            stage: 'regeneration_started',
            regenerationRunId: request.regenerationRunId,
          },
          validationErrors: [],
          updatedAt: this.now(),
        }, `第 ${request.startEpisode}—${endEpisode} 集重新写作已初始化。`);
      }
    }
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
    // A deliberate rewrite must follow the latest series cards rather than a
    // detailed outline saved under an older series-outline revision.
    let outlines = request.regenerate
      ? []
      : state.episodeOutlines.filter((outline) => range.includes(outline.episodeNumber));
    const missingOutlineNumbers = range.filter(
      (episodeNumber) => !outlines.some((outline) => outline.episodeNumber === episodeNumber),
    );
    if (request.draftMode === 'direct_text' && missingOutlineNumbers.length > 0) {
      const characterIds = state.characters.map((character) => character.id);
      for (const episodeNumber of missingOutlineNumbers) {
        const card = seriesOutline.episodeCards.find(
          (candidate) => candidate.episodeNumber === episodeNumber,
        );
        if (!card) throw new ScriptModelOutputError(`全剧分集卡缺少第 ${episodeNumber} 集。`);
        outlines.push(directOutlineFromEpisodeCard(
          request.projectId,
          seriesOutline,
          card,
          characterIds,
        ));
      }
    } else if (missingOutlineNumbers.length > 0) {
      const registeredCharacterIds = new Set(
        state.characters.map((character) => character.id),
      );
      const batchOutlineIds = new Set(
        state.episodeOutlines
          .filter((outline) => range.includes(outline.episodeNumber))
          .map((outline) => outline.id),
      );
      const batchEpisodeIds = new Set(
        state.episodes
          .filter((episode) => range.includes(episode.episodeNumber))
          .map((episode) => episode.id),
      );
      // The five-episode outline is a batch-level upstream artifact. Episodes and
      // detailed outlines written while consuming that artifact are downstream
      // progress and must not invalidate it during resume.
      const episodeOutlineInputRevisionRefs = buildScriptInputRevisionRefs(
        state,
        request.startEpisode,
      ).filter((reference) => !(
        (reference.resource === 'outline' && batchOutlineIds.has(reference.id)) ||
        (reference.resource === 'episode' && batchEpisodeIds.has(reference.id))
      ));
      const batchCards = seriesOutline.episodeCards.filter(
        (card) => range.includes(card.episodeNumber),
      );
      const episodeOutlineUpstreamArtifactRefs = [buildScriptUpstreamArtifactRef(
        'episode_outline_range',
        request.startEpisode,
        {
          episodeNumbers: range,
          cards: batchCards,
          continuity: projectScriptContinuity(state, request.startEpisode),
        },
      )];
      const episodeOutlinePromptVersion = 'episode-outline-batch-v3';
      const episodeOutlineInputFingerprint = computeScriptCheckpointInputFingerprint({
        node: 'episode_outline',
        inputRevisionRefs: episodeOutlineInputRevisionRefs,
        upstreamArtifactRefs: episodeOutlineUpstreamArtifactRefs,
        promptVersion: episodeOutlinePromptVersion,
        configRevision,
      });
      const prompt = [
        `你是 EpisodeOutlineAgent。只展开当前固定批次第 ${range[0]}—${range[range.length - 1]} 集详细大纲。`,
        '只返回 JSON {"outlines":[...]} ，每集必须有冲突、节拍和结尾卡点。',
        `必须且只能返回集号 ${range.join('、')}，即使其中部分集已完成也要保持整批结构完整。`,
        '每项严格模板：{"episodeNumber":"对应上述集号的整数","title":"字符串","goal":"字符串","conflict":"字符串","beats":["字符串"],"characterIds":["人物id"],"plannedScenes":[],"reveal":"可选字符串","reversal":"可选字符串","endingHook":"字符串","requiredFacts":["字符串"],"forbiddenFacts":["字符串"]}。plannedScenes 必须原样返回空数组 []，场景由下一节点规划；不得改名任何键。',
        `characterIds 只能从以下人物 ID 白名单选择：${JSON.stringify([...registeredCharacterIds])}。`,
        `需要集号：${range.join('、')}`,
        `策划：${JSON.stringify(plan)}`,
        `分集卡：${JSON.stringify(batchCards)}`,
        `当前连续性：${JSON.stringify({
          aggregate: projectScriptContinuity(state, request.startEpisode),
          recentCommits: currentScriptContinuityCommits(state)
            .filter((commit) => commit.episodeNumber < request.startEpisode)
            .slice(-2),
        })}`,
      ].join('\n');
      const episodeOutlineContract = parserContract(
        'episode_outlines',
        '根对象必须包含 outlines 数组；每个所需集号恰好出现一次且各字段完整。',
        (value) => {
          const rawOutlines = Array.isArray(value.outlines) ? value.outlines : [];
          const byEpisode = new Map<number, unknown>();
          rawOutlines.forEach((candidate) => {
            const raw = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
              ? candidate as Record<string, unknown>
              : {};
            const number = typeof raw.episodeNumber === 'number'
              ? raw.episodeNumber
              : typeof raw.episodeNumber === 'string'
                ? Number(raw.episodeNumber)
                : Number.NaN;
            if (Number.isInteger(number) && range.includes(number) && !byEpisode.has(number)) {
              byEpisode.set(number, candidate);
            }
          });
          const unused = rawOutlines.filter((candidate) => ![...byEpisode.values()].includes(candidate));
          const parsed = range.map((episodeNumber, index) => {
            const card = batchCards.find((candidate) => candidate.episodeNumber === episodeNumber)!;
            const parsedCandidate = coerceEpisodeOutlineCandidate(
              byEpisode.get(episodeNumber) ?? unused[index] ?? {},
              {
                projectId: request.projectId,
                episodeNumber,
                card,
                registeredCharacterIds,
                createId: () => this.createId(),
              },
            );
            return this.canonicalEpisodeOutlineCandidate(
              parsedCandidate,
              plan,
              episodeNumber,
            );
          });
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
      let reusedEpisodeOutlineCheckpoint = false;
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
            reusedEpisodeOutlineCheckpoint = true;
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
      }, episodeOutlineContract, recordStructuredCall);
      for (const episodeNumber of missingOutlineNumbers) {
        const outline = generated.find((item) => item.episodeNumber === episodeNumber);
        if (!outline) throw new ScriptModelOutputError(`详细大纲缺少第 ${episodeNumber} 集。`);
        // This is an in-memory/checkpoint candidate until ScenePlanner supplies
        // plannedScenes. ScriptService's canonical validator intentionally
        // rejects an empty scene plan, so no formal store write is allowed yet.
        outlines.push(outline);
      }
      // A restored artifact may be normalized in memory by a newer decoder
      // (for example, deterministic IDs can change). Never overwrite the
      // immutable checkpoint with the old artifact revision during resume.
      // The existing checkpoint is already durable; only newly generated
      // output needs a new checkpoint write.
      if (!reusedEpisodeOutlineCheckpoint) {
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
      const completedInCurrentRegeneration = Boolean(
        request.regenerate &&
        regenerationInitialized &&
        existingCheckpoints.some((checkpoint) =>
          checkpoint.node === 'completed' &&
          checkpoint.episodeNumber === episodeNumber &&
          checkpoint.status === 'succeeded')
      );
      if (alreadyCompleted && (!request.regenerate || completedInCurrentRegeneration)) {
        episodes.push(alreadyCompleted);
        skippedEpisodeNumbers.push(episodeNumber);
        continue;
      }
      const storedOutline = state.episodeOutlines.find(
        (item) => item.episodeNumber === episodeNumber,
      );
      const regeneratedOutline = outlines.find((item) => item.episodeNumber === episodeNumber);
      const reachedInCurrentRegeneration = Boolean(
        request.regenerate &&
        regenerationInitialized &&
        existingCheckpoints.some((checkpoint) =>
          checkpoint.episodeNumber === episodeNumber &&
          checkpoint.status !== 'stale' &&
          ['scene_plan', 'draft', 'review', 'revision', 'completed'].includes(checkpoint.node)),
      );
      let outline = reachedInCurrentRegeneration && storedOutline
        ? storedOutline
        : request.regenerate && regeneratedOutline
        ? {
            ...regeneratedOutline,
            ...(storedOutline ? { id: storedOutline.id, revision: storedOutline.revision } : {}),
          }
        : storedOutline ?? regeneratedOutline;
      if (!outline) throw new ScriptModelOutputError(`第 ${episodeNumber} 集详细大纲不存在。`);
      if (request.draftMode === 'direct_text') {
        const direct = await this.generateDirectTextEpisode({
          request,
          state,
          plan,
          outline,
          runKey,
          configRevision,
          recordStructuredCall,
        });
        episodes.push(direct.episode);
        reports.push({ episodeNumber, report: direct.report });
        continue;
      }
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
          ), recordStructuredCall);
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
      const deterministicEpisodeGate = (
        candidate: ScriptEpisode,
        reviewIssues?: readonly ScriptGateIssue[],
      ): ScriptGateReport => validateScriptEpisode(candidate, plan, {
        expectedEpisodeNumber: episodeNumber,
        registeredCharacterIds: new Set(state.characters.map((character) => character.id)),
        registeredCharacterNames: new Set(state.characters.map((character) => character.name)),
        characterNamesById: new Map(state.characters.map((character) => [character.id, character.name])),
        outline,
        previousEpisode: state.episodes
          .filter((item) => item.episodeNumber < episodeNumber)
          .sort((left, right) => right.episodeNumber - left.episodeNumber)[0],
        continuity: projectScriptContinuity(state, episodeNumber),
        ...(reviewIssues ? { reviewIssues } : {}),
      });
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
      const draftPromptVersion = 'episode-draft-v6';
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
      let rejectedDraftFeedback: readonly ScriptCheckpointValidationError[] = [];
      let sourceDraftCheckpoint: ScriptPipelineCheckpoint | undefined;
      let expansionBaseCheckpoint: ScriptPipelineCheckpoint | undefined;
      let draft = state.episodes.find(
        (episode) => episode.episodeNumber === episodeNumber && episode.status === 'reviewing',
      );
      const preflightFreshDraft = !draft;
      if (!draft) {
        const currentEpisode = state.episodes.find((item) => item.episodeNumber === episodeNumber);
        const storedDraft = await this.latestCheckpoint(
          request.projectId,
          runKey,
          { node: 'draft', episodeNumber },
        );
        if (storedDraft) {
          const decision = decideScriptCheckpointResume(storedDraft, draftInputFingerprint);
          const reusableArtifact = decision.disposition === 'reuse' || (
            decision.disposition === 'resume' &&
            (storedDraft.status === 'needs_review' || storedDraft.status === 'running')
          );
          if (reusableArtifact && storedDraft.artifact !== undefined) {
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
              sourceDraftCheckpoint = storedDraft;
              if (decision.disposition === 'reuse') {
                draftCheckpointRevision = storedDraft.artifactRevision;
              } else if (storedDraft.status === 'needs_review') {
                rejectedDraftFeedback = storedDraft.validationErrors;
              }
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
          '未登记的路人、记者、警察等不能借用已登记人物的 characterId 或 speaker 代替说话；若不是正式人物，用 action 或 caption 表达其反应。',
          '同一证据、照片、电话或动作在本集只能首次发现一次；后续只能写核验、转交、追查或产生的新后果。事件必须按“触发—反应—结果”的可见顺序发生，禁止先有结果后补原因。',
          '首次出现的重要人物或地点可用 caption 交代身份；后续不得机械重复字幕。最后一至两个正文块必须兑现本集 endingHook，以反转、证据、人物闯入或未完成动作收尾。',
          '严格遵守大纲 requiredFacts 与 forbiddenFacts；继承上一集结尾状态、服装、道具、人物已知信息和未回收伏笔，禁止让角色无理由换装、瞬移或提前知道秘密。',
          scriptLengthInstruction(
            plan.targetCharsPerEpisode,
            outline.plannedScenes.length,
            plan.dialogueDensityPercent,
          ),
          `所有 blocks.text 去除空白后的总字符数以约 ${plan.targetCharsPerEpisode} 为目标；优先把本集剧情完整写出来，不要为了精确凑字重复台词或省略关键过程。`,
          `对白只能使用这些已登记人物：${JSON.stringify(state.characters.map((character) => ({ id: character.id, name: character.name })))}`,
          this.assembleEpisodeContext(state, plan, outline, episodeNumber),
        ].join('\n');
        if (!draft) {
          const draftContract = defineStructuredContract<ScriptEpisode>({
            name: 'episode_draft',
            version: 2,
            instructions: [
              '必须返回完整单集对象；scenes、每场 blocks 及所有正文块的类型必填字段不可省略。',
              '完整候选必须通过字段、场景人物与对白人物一致性等确定性结构门。若仅正文偏短，系统会保留结构基稿并另行增量扩写，不要求整集重写。',
            ].join('\n'),
            decode: (value) => {
              let candidate: ScriptEpisode;
              try {
                candidate = this.parseEpisode(
                  recordField(value, 'episode_draft'),
                  request.projectId,
                  outline,
                  plan,
                  currentEpisode,
                );
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
              const gate = deterministicEpisodeGate(candidate);
              return gate.blockingIssues.length > 0
                ? { success: false, issues: gateDecodeIssues(gate.blockingIssues) }
                : { success: true, value: candidate };
            },
          });
          draft = await this.generateNodeStructured({
            node: 'draft',
            projectId: request.projectId,
            episodeNumber,
            prompt,
            signal: request.signal,
          }, draftContract, recordStructuredCall);
        }
      }
      draft = this.canonicalEpisodeCandidate(draft, plan, episodeNumber);
      const draftPreflightReport = deterministicEpisodeGate(draft);
      if (
        preflightFreshDraft &&
        draftContinuationRequest(draft, plan.targetCharsPerEpisode)
      ) {
        expansionBaseCheckpoint = sourceDraftCheckpoint;
        if (!expansionBaseCheckpoint) {
          const baseValidationErrors = draftPreflightReport.issues
            .filter((issue) =>
              issue.code === 'TOO_SHORT' || issue.code === 'DIALOGUE_DENSITY'
            )
            .map((issue) => ({
              ...(issue.path ? { path: issue.path } : {}),
              code: issue.code,
              message: issue.message,
            }));
          const baseArtifact = buildScriptEpisodeCandidateArtifact({
            projectId: request.projectId,
            episodeNumber,
            baseEpisodeRevision: currentEpisodeRevision,
            inputRevisionRefs: draftInputRevisionRefs,
            upstreamArtifactRefs: [scenePlanRef],
            promptVersion: draftPromptVersion,
            configRevision,
            validationErrors: baseValidationErrors,
            createdAt: this.now(),
          }, 'draft', draft);
          const baseRevision = await this.nextCheckpointArtifactRevision(
            request.projectId,
            runKey,
            { node: 'draft', episodeNumber },
          );
          await this.saveCheckpoint(request, {
            projectId: request.projectId,
            runKey,
            node: 'draft',
            status: 'running',
            attempt: 1,
            artifactRevision: baseRevision,
            episodeNumber,
            artifact: baseArtifact,
            ...checkpointArtifactMetadata(baseArtifact),
            updatedAt: this.now(),
          }, `第 ${episodeNumber} 集基稿已保存，正文偏短时从原文继续写。`);
          expansionBaseCheckpoint = await this.latestCheckpoint(
            request.projectId,
            runKey,
            { node: 'draft', episodeNumber },
          );
          if (expansionBaseCheckpoint?.artifactRevision !== baseRevision) {
            throw new ScriptModelOutputError('正文基稿检查点写入后无法读取。');
          }
          draftArtifact = baseArtifact;
          draftCheckpointRevision = baseRevision;
          request.signal?.throwIfAborted();
        }

        for (
          let continuationAttempt = 1;
          continuationAttempt <= SCRIPT_DRAFT_MAX_CONTINUATIONS;
          continuationAttempt += 1
        ) {
          const continuationRequest = draftContinuationRequest(
            draft,
            plan.targetCharsPerEpisode,
          );
          if (!continuationRequest) break;
          const continuationBase = draft;
          const knownCharacters = state.characters.map((character) => ({
            id: character.id,
            name: character.name,
          }));
          const continuationPrompt = [
            '你是 ScriptWriterAgent。已有正文必须全部保留；只返回接在现有正文中的新增 blocks，不得重写、复述或总结整集。',
            '严格顶层模板：{"blocks":[...]}。每项只允许 action 或 dialogue，并必须包含 sceneOrdinal、type、text；dialogue 还必须包含本场人物的 characterId、speaker，可选 delivery、mode(normal|os|vo)。',
            'action.text 不带“△”；dialogue.text 不重复说话人或冒号。每条写成完整、可拍摄的动作或推动冲突的对白。',
            `当前已有 ${continuationRequest.current.visibleChars} 字，本轮最多自然续写约 ${continuationRequest.requestedVisibleChars} 字；续写后至少达到 ${continuationRequest.minimumVisibleChars} 字（目标的 75%）。这是唯一一次续写，请把尚未完成的冲突、行动过程和结尾卡点写完整，但不要为了凑数重复内容。`,
            `整集目标约 ${plan.targetCharsPerEpisode} 字，对白倾向约 ${plan.dialogueDensityPercent}%，二者都允许按剧情自然波动。`,
            `对白人物白名单：${JSON.stringify(knownCharacters)}`,
            rejectedDraftFeedback.length > 0
              ? `上一轮续写反馈：${JSON.stringify(rejectedDraftFeedback)}`
              : '',
            `本集大纲：${JSON.stringify(outline)}`,
            `创作上下文：\n${this.assembleEpisodeContext(state, plan, outline, episodeNumber)}`,
            `不可改写的现有正文：${JSON.stringify(continuationBase)}`,
          ].filter(Boolean).join('\n');

          const parseContinuation = (value: unknown): ScriptDraftExpansion => {
            const root = recordField(value, 'episode_draft_continuation');
            if (!Array.isArray(root.blocks) || root.blocks.length === 0) {
              throw new ScriptModelOutputError('续写 blocks 必须是非空数组。');
            }
            const blocks = root.blocks.map((candidate, index): ScriptDraftExpansionBlock => {
              const block = recordField(candidate, `blocks.${index}`);
              const sceneOrdinal = numberField(
                block.sceneOrdinal,
                `blocks.${index}.sceneOrdinal`,
              );
              if (!Number.isInteger(sceneOrdinal) || sceneOrdinal < 1) {
                throw new ScriptModelOutputError(
                  `续写字段 blocks.${index}.sceneOrdinal 必须是正整数。`,
                );
              }
              const type = enumField(
                block.type,
                `blocks.${index}.type`,
                ['action', 'dialogue'] as const,
              );
              const blockText = stringField(block.text, `blocks.${index}.text`);
              if (type === 'action') {
                return { sceneOrdinal, type, text: blockText };
              }
              return {
                sceneOrdinal,
                type,
                characterId: stringField(
                  block.characterId,
                  `blocks.${index}.characterId`,
                ),
                speaker: stringField(block.speaker, `blocks.${index}.speaker`),
                ...(optionalStringField(block.delivery)
                  ? { delivery: optionalStringField(block.delivery) }
                  : {}),
                ...(block.mode === undefined
                  ? {}
                  : {
                      mode: enumField(
                        block.mode,
                        `blocks.${index}.mode`,
                        ['normal', 'os', 'vo'] as const,
                      ),
                    }),
                text: blockText,
              };
            });
            return { blocks };
          };

          const assessContinuation = (
            continuation: ScriptDraftExpansion,
            createId: () => string,
            updatedAt: string,
          ): {
            candidate: ScriptEpisode;
            issues: StructuredDecodeIssue[];
          } => {
            const knownDialogue = continuationBase.scenes
              .flatMap((scene) => scene.blocks)
              .filter((block) => block.type === 'dialogue')
              .map((block) => normalizedExpansionDialogue(block.text))
              .filter(Boolean);
            const duplicateDialogue = continuation.blocks.find((block) => {
              if (block.type !== 'dialogue') return false;
              const normalized = normalizedExpansionDialogue(block.text);
              if (!normalized) return false;
              const duplicate = knownDialogue.some((existing) =>
                expansionDialogueSimilarity(existing, normalized) > 0.92
              );
              knownDialogue.push(normalized);
              return duplicate;
            });
            if (duplicateDialogue) {
              return {
                candidate: continuationBase,
                issues: [{
                  path: ['blocks'],
                  code: 'CONTINUATION_DUPLICATE_DIALOGUE',
                  message: '续写对白与已有正文或本轮其他对白高度重复。',
                }],
              };
            }
            let candidate: ScriptEpisode;
            try {
              candidate = this.canonicalEpisodeCandidate({
                ...applyDraftExpansion(continuationBase, continuation, createId),
                updatedAt,
              }, plan, episodeNumber);
            } catch (error) {
              if (!(error instanceof ScriptModelOutputError)) throw error;
              return {
                candidate: continuationBase,
                issues: [{
                  path: issuePathFromMessage(error.message),
                  code: 'CONTINUATION_INVALID',
                  message: error.message,
                }],
              };
            }
            const before = scriptTextComposition(continuationBase);
            const after = scriptTextComposition(candidate);
            if (after.visibleChars <= before.visibleChars) {
              return {
                candidate: continuationBase,
                issues: [{
                  path: ['blocks'],
                  code: 'CONTINUATION_NO_PROGRESS',
                  message: '续写没有增加可见正文。',
                }],
              };
            }
            if (after.visibleChars < continuationRequest.minimumVisibleChars) {
              return {
                candidate: continuationBase,
                issues: [{
                  path: ['blocks'],
                  code: 'CONTINUATION_STILL_SHORT',
                  message: `续写后正文约 ${after.visibleChars} 字，仍低于轻量可读底线 ${continuationRequest.minimumVisibleChars} 字；请在同一份 blocks 中补足冲突过程与结尾。`,
                }],
              };
            }
            const gate = deterministicEpisodeGate(candidate);
            return gate.blockingIssues.length > 0
              ? { candidate: continuationBase, issues: gateDecodeIssues(gate.blockingIssues) }
              : { candidate, issues: [] };
          };

          const continuationContract = defineStructuredContract<ScriptDraftExpansion>({
            name: 'episode_draft_continuation',
            version: 2,
            instructions: [
              '只返回安全的新正文 blocks；这是本集唯一一次自然续写，应优先补全未完成的冲突、行动过程和结尾卡点。',
              `续写应用后必须达到至少 ${continuationRequest.minimumVisibleChars} 字，同时没有人物、场景、结构或禁止事实等明显错误；不要复述、灌水或机械凑字。`,
            ].join('\n'),
            decode: (value) => {
              let continuation: ScriptDraftExpansion;
              try {
                continuation = parseContinuation(value);
              } catch (error) {
                if (!(error instanceof ScriptModelOutputError)) throw error;
                return {
                  success: false,
                  issues: [{
                    path: issuePathFromMessage(error.message),
                    code: /缺少|必须/u.test(error.message)
                      ? 'field.required'
                      : 'field.invalid',
                    message: error.message,
                  }],
                };
              }
              const assessed = assessContinuation(
                continuation,
                deterministicRevisionValidationIdFactory(continuationBase),
                continuationBase.updatedAt,
              );
              return assessed.issues.length > 0
                ? { success: false, issues: assessed.issues }
                : { success: true, value: continuation };
            },
          });

          let continuation: ScriptDraftExpansion;
          try {
            continuation = await this.generateNodeStructured({
              node: 'draft',
              projectId: request.projectId,
              episodeNumber,
              prompt: continuationPrompt,
              signal: request.signal,
            }, continuationContract, recordStructuredCall);
          } catch (error) {
            if (!(error instanceof ScriptStructuredNeedsReviewError) || error.node !== 'draft') {
              throw error;
            }
            rejectedDraftFeedback = sanitizedStructuredValidationErrors(error.cause);
            break;
          }

          const assessed = assessContinuation(
            continuation,
            () => this.createId(),
            this.now(),
          );
          if (assessed.issues.length > 0) {
            rejectedDraftFeedback = assessed.issues.map((issue) => ({
              path: issue.path.join('.'),
              code: issue.code,
              message: issue.message,
            }));
            break;
          }
          draft = assessed.candidate;
          const continuedArtifact = buildScriptEpisodeCandidateArtifact({
            projectId: request.projectId,
            episodeNumber,
            baseEpisodeRevision: currentEpisodeRevision,
            inputRevisionRefs: draftInputRevisionRefs,
            upstreamArtifactRefs: [scenePlanRef],
            promptVersion: draftPromptVersion,
            configRevision,
            createdAt: this.now(),
          }, 'draft', draft);
          const continuedRevision = await this.nextCheckpointArtifactRevision(
            request.projectId,
            runKey,
            { node: 'draft', episodeNumber },
          );
          await this.saveCheckpoint(request, {
            projectId: request.projectId,
            runKey,
            node: 'draft',
            status: 'running',
            attempt: continuationAttempt + 1,
            artifactRevision: continuedRevision,
            episodeNumber,
            artifact: continuedArtifact,
            ...checkpointArtifactMetadata(continuedArtifact),
            updatedAt: this.now(),
          }, `第 ${episodeNumber} 集已保留第 ${continuationAttempt} 轮续写，当前约 ${scriptVisibleChars(draft)} 字。`);
          if (expansionBaseCheckpoint) {
            await this.markCheckpointStale(expansionBaseCheckpoint);
          }
          expansionBaseCheckpoint = await this.latestCheckpoint(
            request.projectId,
            runKey,
            { node: 'draft', episodeNumber },
          );
          draftArtifact = continuedArtifact;
          draftCheckpointRevision = continuedRevision;
          rejectedDraftFeedback = [];
          request.signal?.throwIfAborted();
        }
      }
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
      if (
        expansionBaseCheckpoint &&
        expansionBaseCheckpoint.artifactRevision !== draftCheckpointRevision
      ) {
        await this.markCheckpointStale(expansionBaseCheckpoint);
      }
      let currentCandidateRef = buildScriptUpstreamArtifactRef(
        'draft',
        draftCheckpointRevision,
        draftArtifact,
      );
      let currentCandidateInputRevisionRefs = structuredClone(draftArtifact.inputRevisionRefs);
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
        const promptVersion = 'script-sanity-review-v1';
        const inputFingerprint = computeScriptCheckpointInputFingerprint({
          node: 'review',
          inputRevisionRefs,
          upstreamArtifactRefs,
          promptVersion,
          configRevision,
        });
        const prompt = [
          '你是 ScriptSanityReviewAgent。只检查会让观众明显困惑的剧情、人物和连续性错误，并返回记忆写回。',
          '只返回 JSON，字段：issues, summary, newFacts, openedThreads, closedThreads, wardrobe。',
          '严格模板：{"issues":[{"code":"CHARACTER_PRESENCE|SPEAKER_ATTRIBUTION|PROP_CUSTODY|KNOWLEDGE_TIMING|CAUSAL_ORDER|CONTINUITY_CONTRADICTION|REPEATED_ACTION","severity":"hard|soft","message":"字符串","sceneId":"可选","blockId":"可选","path":"可选"}],"summary":"150—300字摘要","newFacts":["字符串"],"openedThreads":["字符串"],"closedThreads":["字符串"],"wardrobe":[{"characterId":"人物id","outfit":"服装"}]}。没有问题时 issues 返回空数组，不得改名任何键。',
          'issues 最多返回 3 条，只保留高置信度且能指出正文证据的明显问题：人物未在场却行动或说话、说话人错配、道具归属前后矛盾、角色提前知道信息、因果或行动顺序矛盾、与前集状态直接冲突、同一动作被当成新事件重复发生。',
          '不要评价文风、措辞、节奏、爽点强弱、对白密度、字数、服装审美、反转力度或是否足够精彩；这些不是明显逻辑错误。每条问题必须尽量给出 sceneId 和精确 path。',
          '只有能由正文与连续性材料直接证明的矛盾才标 hard；hard 必须给 sceneId，能定位到正文块时必须给 blockId；拿不准或无法定位就不报。',
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
          'script_sanity_review',
          '必须返回 issues、summary、newFacts、openedThreads、closedThreads、wardrobe 全部字段；summary 不可为空。',
          (value) => this.parseReview(value),
        ), recordStructuredCall);
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
        summary: review.summary || outline.goal,
        newFacts: review.newFacts,
        openedThreads: review.openedThreads,
        closedThreads: review.closedThreads,
        updatedAt: this.now(),
      };
      const validateDraft = (
        candidate: ScriptEpisode,
        reviewIssues?: readonly ScriptGateIssue[],
      ): ScriptGateReport => deterministicEpisodeGate(candidate, reviewIssues);
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
        const hasTooShortIssue = report.blockingIssues.some((issue) => issue.code === 'TOO_SHORT');
        const hasTooLongIssue = report.blockingIssues.some((issue) => issue.code === 'TOO_LONG');
        const revisionInputRevisionRefs = buildScriptInputRevisionRefs(reviewState, episodeNumber);
        const revisionUpstreamArtifactRefs = [currentCandidateRef, currentReviewRef];
        const revisionPromptVersion = 'script-revision-patch-v4';
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
          structuredValidationErrors: readonly ScriptCheckpointValidationError[] = [],
        ): Promise<never> => {
          const safeErrorMessage = redactRevisionValidationMessage(
            'REVISION_PATCH_REJECTED',
            error.message,
          );
          const patchIssue: ScriptEvaluatedGateIssue = {
            code: 'REVISION_PATCH_REJECTED',
            severity: 'hard',
            source: 'deterministic',
            blocking: true,
            message: safeErrorMessage,
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
            validationErrors: structuredValidationErrors.length > 0
              ? structuredValidationErrors
              : [{
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
          let revisionPolicy: ScriptRevisionPatchPolicy | undefined;
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
          if (!revisionPolicy) {
            await rejectRevisionPatch(new ScriptRevisionPatchError('修订策略构造失败。'));
          }
          const exactRevisionPolicy = revisionPolicy as ScriptRevisionPatchPolicy;
          const revisionBase = draft;
          const minimumVisibleChars = Math.ceil(plan.targetCharsPerEpisode * 0.75);
          const maximumVisibleChars = Math.floor(plan.targetCharsPerEpisode * 1.25);
          const validateAndApplyRevisionPatch = (
            patch: ScriptRevisionPatch,
            createId: () => string,
            updatedAt: string,
          ): ScriptEpisode => {
            if (
              expansionOnly &&
              patch.operations.some((operation) =>
                operation.op !== 'insertBlockAfter' && operation.op !== 'appendBlock')
            ) {
              throw new ScriptRevisionSemanticError(
                'revision.policy',
                'TOO_SHORT 修订只允许追加或插入正文块。',
              );
            }
            try {
              assertScriptRevisionPatchAllowed(revisionBase, patch, exactRevisionPolicy);
            } catch (error) {
              if (!(error instanceof ScriptRevisionPatchError)) throw error;
              throw new ScriptRevisionSemanticError('revision.policy', error.message);
            }
            let applied;
            try {
              // Policy is intentionally checked again by apply. The dynamic
              // decoder is feedback, while this remains the mutation boundary.
              applied = applyScriptRevisionPatch(revisionBase, patch, createId, exactRevisionPolicy);
            } catch (error) {
              if (!(error instanceof ScriptRevisionPatchError)) throw error;
              throw new ScriptRevisionSemanticError('revision.apply', error.message);
            }
            const visibleCharsBeforePatch = scriptVisibleChars(revisionBase);
            const visibleCharsAfterPatch = scriptVisibleChars(applied.episode);
            if (
              hasTooShortIssue &&
              (
                visibleCharsAfterPatch <= visibleCharsBeforePatch ||
                visibleCharsAfterPatch < minimumVisibleChars ||
                visibleCharsAfterPatch > maximumVisibleChars
              )
            ) {
              throw new ScriptRevisionSemanticError(
                'revision.length',
                `TOO_SHORT 修订必须增加正文并一次落入 ${minimumVisibleChars}—${maximumVisibleChars} 字；` +
                `当前由 ${visibleCharsBeforePatch} 字变为 ${visibleCharsAfterPatch} 字。`,
              );
            }
            if (
              hasTooLongIssue &&
              (
                visibleCharsAfterPatch >= visibleCharsBeforePatch ||
                visibleCharsAfterPatch < minimumVisibleChars ||
                visibleCharsAfterPatch > maximumVisibleChars
              )
            ) {
              throw new ScriptRevisionSemanticError(
                'revision.length',
                `TOO_LONG 修订必须缩短正文并一次落入 ${minimumVisibleChars}—${maximumVisibleChars} 字；` +
                `当前由 ${visibleCharsBeforePatch} 字变为 ${visibleCharsAfterPatch} 字。`,
              );
            }
            if (
              visibleCharsAfterPatch < visibleCharsBeforePatch &&
              !hasTooLongIssue &&
              !hasTooShortIssue
            ) {
              throw new ScriptRevisionSemanticError(
                'revision.length',
                '修订无权缩短未超长的候选正文。',
              );
            }
            const candidate = {
              ...applied.episode,
              summary: review.summary || outline.goal,
              newFacts: review.newFacts,
              openedThreads: review.openedThreads,
              closedThreads: review.closedThreads,
              updatedAt,
            };
            let canonicalCandidate: ScriptEpisode;
            try {
              canonicalCandidate = this.canonicalEpisodeCandidate(candidate, plan, episodeNumber);
            } catch (error) {
              if (error instanceof ScriptModelOutputError) {
                throw new ScriptRevisionSemanticError(
                  'revision.canonical',
                  `修订候选未通过统一输入校验：${error.message}`,
                );
              }
              throw error;
            }
            const postPatchGate = deterministicEpisodeGate(canonicalCandidate);
            if (postPatchGate.hardFailed) {
              const summary = postPatchGate.blockingIssues
                .slice(0, 4)
                .map((issue) => `${issue.code}：${issue.message}`)
                .join('；');
              throw new ScriptRevisionSemanticError(
                'revision.quality',
                `修订后仍有确定性阻断问题：${summary || '未知硬性问题。'}`,
              );
            }
            return canonicalCandidate;
          };
          const revisionContract = defineStructuredContract<ScriptRevisionPatch>({
            name: SCRIPT_REVISION_PATCH_CONTRACT.name,
            version: 2,
            instructions: [
              SCRIPT_REVISION_PATCH_CONTRACT.instructions,
              '本轮还必须通过精确 revisionPolicy、Patch 应用、总字数和 canonical Episode 校验；失败时必须按校验错误修正同一个完整 Patch。',
            ].join('\n'),
            decode(value) {
              const decoded = SCRIPT_REVISION_PATCH_CONTRACT.decode(value);
              if (!decoded.success) return decoded;
              try {
                validateAndApplyRevisionPatch(
                  decoded.value,
                  deterministicRevisionValidationIdFactory(revisionBase),
                  revisionBase.updatedAt,
                );
                return decoded;
              } catch (error) {
                if (!(error instanceof ScriptRevisionSemanticError)) throw error;
                return {
                  success: false,
                  issues: [{
                    path: ['operations'],
                    code: error.validationCode,
                    message: error.message,
                  }],
                };
              }
            },
          });
          const revisionPrompt = [
            '你是 ScriptRevisionAgent。只返回版本化 Patch JSON，不得返回完整 Episode。',
            '顶层严格为 {"operations":[...]}。可用操作类型与锚点只认下方精确 revisionPolicy；未明确列出的操作一律禁止。',
            '禁止删除场景或正文块、重排场景、替换整集、修改集号/outlineId/既有 id，禁止触碰未被阻断错误定位的内容。',
            'replaceBlockText 使用 {"op":"replaceBlockText","sceneId":"...","blockId":"...","text":"..."}；insertBlockAfter 使用 {"op":"insertBlockAfter","sceneId":"...","afterBlockId":"...","block":{"type":"action","text":"..."}}；appendBlock 与之类似；updateSceneCharacters 只更新 characterIds。',
            expansionOnly
              ? '本轮只修复 TOO_SHORT：operations 只能使用精确策略授权的 insertBlockAfter 或 appendBlock 增写可拍摄内容，严禁替换、删减或缩短既有正文。'
              : '只对阻断项做最小改动；除 TOO_LONG 外，修订后正文不得比当前候选更短。',
            scriptRevisionLengthInstruction(
              plan.targetCharsPerEpisode,
              report.visibleChars,
              hasTooLongIssue,
            ),
            ...revisionPolicyPromptContext(
              revisionBase,
              exactRevisionPolicy,
              plan.targetCharsPerEpisode,
            ),
            `人物 ID 白名单：${JSON.stringify(state.characters.map((character) => character.id))}`,
            `本集大纲：${JSON.stringify(outline)}`,
            `阻断错误：${JSON.stringify(report.blockingIssues)}`,
            rejectedRevisionFeedback.length > 0
              ? `上次候选被系统拒绝：${JSON.stringify(rejectedRevisionFeedback)}。必须根据反馈换一种满足精确策略与长度保护的补丁，禁止重复该越界做法。`
              : '',
            `当前候选：${JSON.stringify(revisionBase)}`,
          ].filter(Boolean).join('\n');
          let patch!: ScriptRevisionPatch;
          try {
            patch = await this.generateNodeStructured({
              node: 'revision',
              projectId: request.projectId,
              episodeNumber,
              prompt: revisionPrompt,
              signal: request.signal,
            }, revisionContract, recordStructuredCall);
          } catch (error) {
            if (!(error instanceof ScriptStructuredNeedsReviewError) || error.node !== 'revision') {
              throw error;
            }
            const structuredValidationErrors = sanitizedStructuredValidationErrors(error.cause);
            const firstValidationError = structuredValidationErrors[0];
            const feedback = firstValidationError
              ? `${firstValidationError.code}: ${firstValidationError.message}`
              : '修订补丁未通过结构与权限校验。';
            await rejectRevisionPatch(
              new ScriptRevisionPatchError(`修订补丁在固定调用预算内仍不合格：${feedback}`),
              structuredValidationErrors,
            );
          }
          try {
            // Run the same semantic boundary again with real IDs immediately
            // before the candidate artifact can be persisted.
            draft = validateAndApplyRevisionPatch(patch, () => this.createId(), this.now());
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
            await rejectRevisionPatch(
              error,
              error instanceof ScriptRevisionSemanticError
                ? [{
                    path: '$.operations',
                    code: error.validationCode,
                    message: redactRevisionValidationMessage(
                      error.validationCode,
                      error.message,
                    ),
                  }]
                : [],
            );
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
        currentCandidateInputRevisionRefs = structuredClone(patchedArtifact!.inputRevisionRefs);
        episodeUpstreamRefs.push(currentCandidateRef);
        reviewed = await reviewDraft(draft, revisionRound + 1, currentCandidateRef);
        review = reviewed.value;
        currentReviewRef = reviewed.artifactRef;
        episodeUpstreamRefs.push(currentReviewRef);
        draft = {
          ...draft,
          summary: review.summary || outline.goal,
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
          inputRevisionRefs: currentCandidateInputRevisionRefs,
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
      const reviewUpdate = this.createReviewIssueUpdate(
        request.projectId,
        episodeNumber,
        deterministicReport.issues,
        review.issues,
      );
      const replacedReviewSources = new Set(reviewUpdate.sources);
      const retainedOpenHard = reviewState.reviewIssues.filter(
        (item) =>
          item.episodeNumber === episodeNumber &&
          !replacedReviewSources.has(item.source) &&
          isBlockingScriptReviewIssue(item),
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
          inputRevisionRefs: currentCandidateInputRevisionRefs,
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
        inputRevisionRefs: currentCandidateInputRevisionRefs,
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
      // Continuity and generation refs must stay bound to the same snapshot
      // that was actually prompted and gated. Only the review-ledger revision
      // comes from this run's own persisted review write. The store compares
      // these stable refs atomically against current canon and rejects any
      // plan/outline/character/episode drift that landed while the model ran.
      const continuity = buildScriptContinuityCandidate(reviewState, draft, review.wardrobe);
      const commitInput = buildScriptAtomicCommitInput(reviewState, draft, continuity, {
        upstreamArtifactRefs: episodeUpstreamRefs,
        promptVersion: 'short-drama-director-v2',
        modelConfigFingerprint: configRevision,
      });
      commitInput.reviewUpdate = reviewUpdate;
      commitInput.inputRevisionRefs = structuredClone(currentCandidateInputRevisionRefs);
      commitInput.expectedReviewRevision = reviewState.reviewRevision;
      commitInput.inputFingerprint = computeScriptInputFingerprint(commitInput);
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
    const callSummary = summarizeStructuredCalls(structuredCallMetrics);
    await this.saveCheckpoint(request, {
      projectId: request.projectId,
      runKey,
      node: 'batch_report',
      status: 'completed',
      attempt: 1,
      artifactRevision: batchReportCheckpointRevision,
      artifact: reports,
      updatedAt: this.now(),
    }, `第 ${request.startEpisode}—${endEpisode} 集批次完成；模型调用 ${callSummary.totalCalls} 次（首答 ${callSummary.primaryCalls}、Fixup ${callSummary.fixupCalls}、fallback ${callSummary.fallbackCalls}）。`);
    return {
      kind: 'episode_batch',
      episodes: episodes.sort((left, right) => left.episodeNumber - right.episodeNumber),
      reports,
      skippedEpisodeNumbers,
      callSummary,
    };
  }

  private async generateDirectTextEpisode(input: {
    request: Extract<ScriptDirectorRequest, { task: 'script_episode_batch' }>;
    state: ScriptProjectState;
    plan: ScriptPlan;
    outline: ScriptEpisodeOutline;
    runKey: string;
    configRevision: string;
    recordStructuredCall: (metric: ScriptStructuredCallMetric) => void;
  }): Promise<{ episode: ScriptEpisode; report: ScriptGateReport }> {
    const { request, state, plan, outline, runKey, configRevision, recordStructuredCall } = input;
    const episodeNumber = outline.episodeNumber;
    const currentEpisode = state.episodes.find((episode) => episode.episodeNumber === episodeNumber);
    const baseEpisodeRevision = currentEpisode?.revision ?? 0;
    const inputRevisionRefs = buildScriptInputRevisionRefs(state, episodeNumber);
    const outlineRef = buildScriptUpstreamArtifactRef('episode_outline', outline.revision, outline);
    const context = directWritingContext(state, plan, outline);
    const directValidationPlan = planForDirectDraftValidation(plan);
    const canonicalStoredDirectCandidate = (value: ScriptEpisode): ScriptEpisode =>
      this.canonicalEpisodeCandidate(
        value,
        directValidationPlan,
        episodeNumber,
      );
    const canonicalDirectCandidate = (value: ScriptEpisode): ScriptEpisode =>
      reconcileDirectSceneCast(canonicalStoredDirectCandidate(value));
    const promptVersion = 'direct-draft-v2';
    const draftFingerprint = computeScriptCheckpointInputFingerprint({
      node: 'direct_draft',
      inputRevisionRefs,
      upstreamArtifactRefs: [outlineRef],
      promptVersion,
      configRevision,
    });

    const parseCandidate = (rawText: string): {
      episode?: ScriptEpisode;
      warnings: ReturnType<typeof parseChineseShortDramaText>['warnings'];
      unparsedLines: ReturnType<typeof parseChineseShortDramaText>['unparsedLines'];
    } => {
      const parsed = parseChineseShortDramaText(rawText, {
        projectId: request.projectId,
        episodeNumber,
        title: outline.title,
        outlineId: outline.id,
        targetChars: plan.targetCharsPerEpisode,
        characters: state.characters,
        createId: () => this.createId(),
      });
      if (!parsed.episode) {
        return { warnings: parsed.warnings, unparsedLines: parsed.unparsedLines };
      }
      const now = this.now();
      try {
        const episode = canonicalDirectCandidate({
          ...parsed.episode,
          id: currentEpisode?.id ?? this.createId(),
          projectId: request.projectId,
          revision: baseEpisodeRevision,
          createdAt: currentEpisode?.createdAt ?? now,
          updatedAt: now,
        });
        return { ...parsed, episode };
      } catch (error) {
        const message = error instanceof Error ? error.message : '剧本结构无法规范化。';
        return {
          warnings: [
            ...parsed.warnings,
            {
              line: 0,
              code: 'UNPARSED_LINE' as const,
              message,
              text: '',
            },
          ],
          unparsedLines: parsed.unparsedLines,
        };
      }
    };

    const recordCall = (
      node: ScriptModelNode,
      contractName: string,
      callsUsed: number,
      status: ScriptStructuredCallMetric['status'] = 'completed',
    ): void => recordStructuredCall({
      node,
      episodeNumber,
      contractName,
      status,
      callsUsed,
      ...(status === 'completed'
        ? { completedBy: callsUsed === 1 ? 'primary' as const : 'fixup' as const }
        : {}),
      attempts: Array.from({ length: callsUsed }, (_, index) => ({
        stage: index === 0 ? 'primary' as const : 'fixup' as const,
        outcome: status === 'completed' && index === callsUsed - 1
          ? 'completed' as const
          : 'decode_failed' as const,
      })),
    });

    const decodeDraftArtifact = (
      value: unknown,
      expectedStage: ScriptDirectDraftArtifact['stage'],
    ): ScriptDirectDraftArtifact | undefined => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const candidate = value as Partial<ScriptDirectDraftArtifact>;
      if (
        candidate.schemaVersion !== 1 ||
        candidate.stage !== expectedStage ||
        typeof candidate.rawText !== 'string' ||
        !candidate.episode ||
        typeof candidate.candidateHash !== 'string' ||
        !Array.isArray(candidate.parseWarnings)
      ) return undefined;
      let storedEpisode: ScriptEpisode;
      try {
        storedEpisode = canonicalStoredDirectCandidate(candidate.episode);
      } catch {
        return undefined;
      }
      if (computeScriptEpisodeCandidateHash(storedEpisode) !== candidate.candidateHash) return undefined;
      const episode = reconcileDirectSceneCast(storedEpisode);
      return {
        ...candidate,
        episode,
        candidateHash: computeScriptEpisodeCandidateHash(episode),
      } as ScriptDirectDraftArtifact;
    };

    let rawText = '';
    let draft: ScriptEpisode | undefined;
    let draftWarnings: ReturnType<typeof parseChineseShortDramaText>['warnings'] = [];
    let directDraftRevision: number | undefined;
    let writerCallsUsed = 0;
    let rejectedDirectDraft: ScriptPipelineCheckpoint | undefined;
    const storedDirectDraft = await this.latestCheckpoint(
      request.projectId,
      runKey,
      { node: 'direct_draft', episodeNumber },
    );
    if (storedDirectDraft) {
      const decision = decideScriptCheckpointResume(storedDirectDraft, draftFingerprint);
      if (decision.disposition === 'reuse') {
        const restored = decodeDraftArtifact(storedDirectDraft.artifact, 'direct_draft');
        if (restored) {
          rawText = restored.rawText;
          draft = restored.episode;
          draftWarnings = restored.parseWarnings;
          directDraftRevision = storedDirectDraft.artifactRevision;
          writerCallsUsed = Math.max(1, storedDirectDraft.attempt);
        } else {
          await this.markCheckpointStale(storedDirectDraft);
        }
      } else if (decision.disposition === 'stale') {
        await this.markCheckpointStale(storedDirectDraft);
      } else if (storedDirectDraft.status === 'needs_review') {
        if (!request.resumeRejectedCandidates) {
          throw new ScriptModelOutputError(
            `第 ${episodeNumber} 集上次没有返回可识别的剧本场景，请从检查点继续。`,
          );
        }
        rejectedDirectDraft = storedDirectDraft;
      }
    }

    if (!draft) {
      request.signal?.throwIfAborted();
      const storedRecoveryAttempt = rejectedDirectDraft
        ? (() => {
            const artifact = rejectedDirectDraft.artifact;
            if (artifact && typeof artifact === 'object' && !Array.isArray(artifact)) {
              const value = (artifact as Record<string, unknown>).recoveryAttempt;
              if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
                return value;
              }
            }
            // Checkpoints written before recoveryAttempt was persisted are ambiguous.
            // Treat revision 0 as at least recovery 1 so the next retry cannot reuse
            // the same primary and format-repair cache keys.
            return rejectedDirectDraft.artifactRevision + 1;
          })()
        : undefined;
      const recoveryAttempt = rejectedDirectDraft
        ? storedRecoveryAttempt! + 1
        : request.resumeRejectedCandidates
          ? 1
          : 0;
      const directDraftPrompt = recoveryAttempt > 0
        ? [
            `显式恢复重写（第 ${recoveryAttempt} 次）：上一份正文和排版修正结果都无法识别。`,
            '必须从分集卡重新写一份完整正文，不得复用上次结果或输出解释。',
            '必须严格用下面三行开头：',
            `第${episodeNumber}集`,
            `${episodeNumber}-1 地点 日/内`,
            '人物：角色名',
            '',
            buildDirectDraftPrompt(context),
          ].join('\n')
        : buildDirectDraftPrompt(context);
      let providerFailureMessage = '';
      try {
        rawText = await this.dependencies.model.complete({
          node: 'draft',
          projectId: request.projectId,
          episodeNumber,
          prompt: directDraftPrompt,
          responseFormat: 'text',
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        providerFailureMessage = error instanceof Error ? error.message : String(error);
        rawText = '';
      }
      let parsed = parseCandidate(rawText);
      const callsUsed = 1;
      if (!parsed.episode) {
        if (request.regenerate && currentEpisode) {
          throw new ScriptModelOutputError(
            `第 ${episodeNumber} 集重新写作没有返回可识别正文，已完整保留旧稿；可再次点击重新写。`,
          );
        }
        const localDraft = createMinimalDirectDraftFallback(
          request.projectId,
          outline,
          plan,
          () => this.createId(),
          this.now(),
        );
        const fallback = canonicalDirectCandidate({
          ...localDraft,
          id: currentEpisode?.id ?? localDraft.id,
          revision: baseEpisodeRevision,
          createdAt: currentEpisode?.createdAt ?? localDraft.createdAt,
        });
        const fallbackMessage = providerFailureMessage
          ? `正文模型调用失败，已保存本地可编辑分场稿：${providerFailureMessage}`
          : '正文模型未返回可见正文，已保存本地可编辑分场稿。';
        rawText = directEpisodeText(fallback, state.characters);
        parsed = {
          episode: fallback,
          warnings: [{
            line: 0,
            code: 'UNPARSED_LINE',
            message: fallbackMessage,
            text: '',
          }],
          unparsedLines: [],
        };
      }
      recordCall('draft', 'ChineseShortDramaText@v1', callsUsed);
      writerCallsUsed = callsUsed;
      const parsedDraft = parsed.episode;
      if (!parsedDraft) throw new ScriptModelOutputError(`第 ${episodeNumber} 集本地正文兜底失败。`);
      draft = parsedDraft;
      draftWarnings = parsed.warnings;
      directDraftRevision = await this.nextCheckpointArtifactRevision(
        request.projectId,
        runKey,
        { node: 'direct_draft', episodeNumber },
      );
      const artifact: ScriptDirectDraftArtifact = {
        schemaVersion: 1,
        stage: 'direct_draft',
        rawText,
        episode: parsedDraft,
        candidateHash: computeScriptEpisodeCandidateHash(parsedDraft),
        parseWarnings: draftWarnings,
        createdAt: this.now(),
      };
      await this.saveCheckpoint(request, {
        projectId: request.projectId,
        runKey,
        node: 'direct_draft',
        status: 'succeeded',
        attempt: callsUsed,
        artifactRevision: directDraftRevision,
        episodeNumber,
        artifact,
        inputRevisionRefs,
        upstreamArtifactRefs: [outlineRef],
        promptVersion,
        configRevision,
        inputFingerprint: draftFingerprint,
        validationErrors: draftWarnings.map((warning) => ({
          path: `line:${warning.line}`,
          code: warning.code,
          message: warning.message,
        })),
        updatedAt: this.now(),
      }, `第 ${episodeNumber} 集首稿已保存。`);
    }

    if (!draft) throw new ScriptModelOutputError(`第 ${episodeNumber} 集直接写作候选丢失。`);

    const directDraftRef = buildScriptUpstreamArtifactRef(
      'direct_draft',
      directDraftRevision!,
      { rawText, candidateHash: computeScriptEpisodeCandidateHash(draft) },
    );
    let currentCandidateRef = directDraftRef;
    const episodeUpstreamRefs: ScriptUpstreamArtifactRef[] = [outlineRef, directDraftRef];
    const continuationThreshold = Math.max(150, Math.round(plan.targetCharsPerEpisode * 0.58));
    if (writerCallsUsed <= 1 && scriptVisibleChars(draft) < continuationThreshold) {
      const continuationPromptVersion = 'direct-continuation-v1';
      const continuationFingerprint = computeScriptCheckpointInputFingerprint({
        node: 'continuation',
        inputRevisionRefs,
        upstreamArtifactRefs: [currentCandidateRef],
        promptVersion: continuationPromptVersion,
        configRevision,
      });
      const storedContinuation = await this.latestCheckpoint(
        request.projectId,
        runKey,
        { node: 'continuation', episodeNumber },
      );
      let continuationRevision: number | undefined;
      let continued: ScriptDirectDraftArtifact | undefined;
      if (storedContinuation) {
        const decision = decideScriptCheckpointResume(storedContinuation, continuationFingerprint);
        if (decision.disposition === 'reuse') {
          continued = decodeDraftArtifact(storedContinuation.artifact, 'direct_continuation');
          continuationRevision = continued ? storedContinuation.artifactRevision : undefined;
          if (!continued) await this.markCheckpointStale(storedContinuation);
        } else if (decision.disposition === 'stale') {
          await this.markCheckpointStale(storedContinuation);
        }
      }
      if (!continued) {
        request.signal?.throwIfAborted();
        let additionText = '';
        try {
          additionText = await this.dependencies.model.complete({
            node: 'draft',
            projectId: request.projectId,
            episodeNumber,
            prompt: buildDirectContinuationPrompt(
              context,
              rawText,
              scriptVisibleChars(draft),
              plan.targetCharsPerEpisode,
            ),
            responseFormat: 'text',
            signal: request.signal,
          });
        } catch (error) {
          if (request.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
          draftWarnings.push({
            line: 0,
            code: 'UNPARSED_LINE',
            message: `续写失败，已保留现有正文：${error instanceof Error ? error.message : String(error)}`,
            text: '',
          });
        }
        recordCall('draft', 'ChineseShortDramaContinuation@v1', 1);
        const addition = parseCandidate(additionText);
        if (addition.episode) {
          draft = canonicalDirectCandidate(mergeDirectContinuation(draft, addition.episode));
          rawText = directEpisodeText(draft, state.characters);
          draftWarnings = [...draftWarnings, ...addition.warnings];
        }
        continuationRevision = await this.nextCheckpointArtifactRevision(
          request.projectId,
          runKey,
          { node: 'continuation', episodeNumber },
        );
        continued = {
          schemaVersion: 1,
          stage: 'direct_continuation',
          rawText,
          episode: draft,
          candidateHash: computeScriptEpisodeCandidateHash(draft),
          parseWarnings: draftWarnings,
          createdAt: this.now(),
        };
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'continuation',
          status: 'succeeded',
          attempt: 1,
          artifactRevision: continuationRevision,
          episodeNumber,
          artifact: continued,
          inputRevisionRefs,
          upstreamArtifactRefs: [currentCandidateRef],
          promptVersion: continuationPromptVersion,
          configRevision,
          inputFingerprint: continuationFingerprint,
          validationErrors: [],
          updatedAt: this.now(),
        }, `第 ${episodeNumber} 集已完成一次自然续写。`);
      } else {
        draft = continued.episode;
        rawText = continued.rawText;
        draftWarnings = continued.parseWarnings;
      }
      currentCandidateRef = buildScriptUpstreamArtifactRef(
        'continuation',
        continuationRevision!,
        continued,
      );
      episodeUpstreamRefs.push(currentCandidateRef);
    }

    const reviewPromptVersion = 'direct-handoff-review-v3';
    const reviewFingerprint = computeScriptCheckpointInputFingerprint({
      node: 'handoff_review',
      inputRevisionRefs,
      upstreamArtifactRefs: [currentCandidateRef],
      promptVersion: reviewPromptVersion,
      configRevision,
    });
    const storedReview = await this.latestCheckpoint(
      request.projectId,
      runKey,
      { node: 'handoff_review', episodeNumber, chunkStart: 1 },
    );
    let review: ScriptDirectHandoffReview | undefined;
    let reviewRevision: number | undefined;
    if (storedReview) {
      const decision = decideScriptCheckpointResume(storedReview, reviewFingerprint);
      if (decision.disposition === 'reuse') {
        const value = storedReview.artifact;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const artifact = value as Partial<ScriptDirectReviewArtifact>;
          if (artifact.schemaVersion === 1 && artifact.stage === 'direct_review' && artifact.review) {
            review = artifact.review;
            reviewRevision = storedReview.artifactRevision;
          }
        }
        if (!review) await this.markCheckpointStale(storedReview);
      } else if (decision.disposition === 'stale') {
        await this.markCheckpointStale(storedReview);
      }
    }
    if (!review) {
      request.signal?.throwIfAborted();
      try {
        const rawReview = await this.dependencies.model.complete({
          node: 'review',
          projectId: request.projectId,
          episodeNumber,
          prompt: buildDirectReviewPrompt(context, rawText),
          responseFormat: 'json',
          signal: request.signal,
        });
        review = reconcileDirectReviewBoundary(
          context,
          decodeDirectHandoffReview(parseStructuredModelOutput(rawReview)),
        );
        recordCall('review', 'ScriptDirectHandoffReview@v1', 1);
      } catch (error) {
        if (request.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        review = createLocalDirectHandoffReview(outline, draft);
        recordCall('review', 'ScriptDirectHandoffReview@v1', 1, 'needs_review');
      }
      if (!review) {
        throw new ScriptModelOutputError(`第 ${episodeNumber} 集审校结果无效。`);
      }
      reviewRevision = await this.nextCheckpointArtifactRevision(
        request.projectId,
        runKey,
        { node: 'handoff_review', episodeNumber, chunkStart: 1 },
      );
      const artifact: ScriptDirectReviewArtifact = {
        schemaVersion: 1,
        stage: 'direct_review',
        review,
        createdAt: this.now(),
      };
      await this.saveCheckpoint(request, {
        projectId: request.projectId,
        runKey,
        node: 'handoff_review',
        status: 'succeeded',
        attempt: 1,
        artifactRevision: reviewRevision,
        episodeNumber,
        chunkStart: 1,
        artifact,
        inputRevisionRefs,
        upstreamArtifactRefs: [currentCandidateRef],
        promptVersion: reviewPromptVersion,
        configRevision,
        inputFingerprint: reviewFingerprint,
        validationErrors: [],
        updatedAt: this.now(),
      }, `第 ${episodeNumber} 集明显错误检查与连续性交接已完成。`);
    }
    if (!review) {
      throw new ScriptModelOutputError(`第 ${episodeNumber} 集审校结果无效。`);
    }
    review = reconcileDirectReviewBoundary(context, review);
    const reviewRef = buildScriptUpstreamArtifactRef('handoff_review', reviewRevision!, review);
    episodeUpstreamRefs.push(reviewRef);
    draft = canonicalDirectCandidate({
      ...draft,
      summary: review.handoff.summary || outline.goal,
      newFacts: [...new Set([
        ...review.handoff.characterStates.flatMap((item) => item.knows),
        ...review.handoff.props.map((item) => `${item.name}：${item.state}`),
      ])],
      openedThreads: review.handoff.openThreads,
      closedThreads: [],
      updatedAt: this.now(),
    });
    if (!draft) throw new ScriptModelOutputError(`第 ${episodeNumber} 集直接写作候选丢失。`);

    const registeredCharacterNames = new Set(state.characters.map((character) => character.name));
    const validateDraft = (candidate: ScriptEpisode, reviewIssues: readonly ScriptGateIssue[] = []): ScriptGateReport => {
      const temporarySpeakers = collectTemporaryDialogueSpeakers(
        candidate,
        plan,
        registeredCharacterNames,
      );
      return validateScriptEpisode(candidate, directValidationPlan, {
        expectedEpisodeNumber: episodeNumber,
        registeredCharacterIds: new Set(state.characters.map((character) => character.id)),
        registeredCharacterNames,
        characterNamesById: new Map(state.characters.map((character) => [character.id, character.name])),
        temporarySpeakers,
        outline,
        previousEpisode: state.episodes
          .filter((episode) => episode.episodeNumber < episodeNumber)
          .sort((left, right) => right.episodeNumber - left.episodeNumber)[0],
        continuity: projectScriptContinuity(state, episodeNumber),
        reviewIssues,
      });
    };
    const draftForReview = draft;
    const aiIssues: ScriptGateIssue[] = review.issues.map((issue) => ({
      code: `DIRECT_${issue.code}`,
      severity: 'soft',
      source: 'ai',
      message: `${issue.evidence}；应为：${issue.expected}`,
      ...(issue.sceneNumber
        ? { sceneId: draftForReview.scenes.find((scene) => scene.ordinal === issue.sceneNumber)?.id }
        : {}),
      path: 'scenes',
    }));
    let deterministicReport = validateDraft(draft);
    let report = validateDraft(draft, aiIssues);
    const rewriteIssues: ScriptDirectReviewIssue[] = [
      ...review.issues,
      ...deterministicReport.blockingIssues.map((issue) => ({
        code: 'CHARACTER_IDENTITY_CONFLICT' as const,
        evidence: issue.message,
        expected: '修正该明确结构或人物错误，同时保持分集卡事件不变。',
      })),
    ].slice(0, 3);
    let rewriteApplied = false;
    if (rewriteIssues.length > 0) {
      const storedRewrite = await this.latestCheckpoint(
        request.projectId,
        runKey,
        { node: 'direct_rewrite', episodeNumber },
      );
      const rewriteFromOutline = storedRewrite?.status === 'stale';
      const rewritePromptVersion = rewriteFromOutline
        ? 'direct-rewrite-from-outline-v1'
        : 'direct-rewrite-v4';
      const rewriteFingerprint = computeScriptCheckpointInputFingerprint({
        node: 'direct_rewrite',
        inputRevisionRefs,
        upstreamArtifactRefs: [currentCandidateRef, reviewRef],
        promptVersion: rewritePromptVersion,
        configRevision,
      });
      let rewriteArtifact: ScriptDirectDraftArtifact | undefined;
      let rewriteRevision: number | undefined;
      if (storedRewrite) {
        const decision = decideScriptCheckpointResume(storedRewrite, rewriteFingerprint);
        if (decision.disposition === 'reuse') {
          rewriteArtifact = decodeDraftArtifact(storedRewrite.artifact, 'direct_rewrite');
          rewriteRevision = rewriteArtifact ? storedRewrite.artifactRevision : undefined;
          if (!rewriteArtifact) await this.markCheckpointStale(storedRewrite);
        } else if (decision.disposition === 'stale') {
          await this.markCheckpointStale(storedRewrite);
        }
      }
      if (!rewriteArtifact) {
        request.signal?.throwIfAborted();
        let rewrittenText = '';
        try {
          rewrittenText = await this.dependencies.model.complete({
            node: 'revision',
            projectId: request.projectId,
            episodeNumber,
            prompt: buildDirectRewritePrompt(context, rawText, rewriteIssues, {
              rewriteFromOutline,
            }),
            responseFormat: 'text',
            signal: request.signal,
          });
        } catch (error) {
          if (request.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
          draftWarnings.push({
            line: 0,
            code: 'UNPARSED_LINE',
            message: `自动重写失败，已保留原正文：${error instanceof Error ? error.message : String(error)}`,
            text: '',
          });
        }
        const rewritten = parseCandidate(rewrittenText);
        const rewriteCallsUsed = 1;
        if (!rewritten.episode) {
          recordCall('revision', 'ChineseShortDramaDirectRewrite@v1', 1, 'needs_review');
        } else {
          recordCall('revision', 'ChineseShortDramaDirectRewrite@v1', 1);
          draft = rewritten.episode;
          rawText = rewrittenText;
          draftWarnings = rewritten.warnings;
          rewriteRevision = await this.nextCheckpointArtifactRevision(
            request.projectId,
            runKey,
            { node: 'direct_rewrite', episodeNumber },
          );
          rewriteArtifact = {
            schemaVersion: 1,
            stage: 'direct_rewrite',
            rawText,
            episode: draft,
            candidateHash: computeScriptEpisodeCandidateHash(draft),
            parseWarnings: draftWarnings,
            createdAt: this.now(),
          };
          await this.saveCheckpoint(request, {
            projectId: request.projectId,
            runKey,
            node: 'direct_rewrite',
            status: 'succeeded',
            attempt: rewriteCallsUsed,
            artifactRevision: rewriteRevision,
            episodeNumber,
            artifact: rewriteArtifact,
            inputRevisionRefs,
            upstreamArtifactRefs: [currentCandidateRef, reviewRef],
            promptVersion: rewritePromptVersion,
            configRevision,
            inputFingerprint: rewriteFingerprint,
            validationErrors: [],
            updatedAt: this.now(),
          }, `第 ${episodeNumber} 集已按明显问题重写一次。`);
        }
      } else {
        draft = rewriteArtifact.episode;
        rawText = rewriteArtifact.rawText;
      }
      if (rewriteArtifact && rewriteRevision !== undefined) {
        rewriteApplied = true;
        currentCandidateRef = buildScriptUpstreamArtifactRef(
        'direct_rewrite',
        rewriteRevision,
        rewriteArtifact,
      );
      episodeUpstreamRefs.push(currentCandidateRef);
      const postRewriteReviewPromptVersion = 'direct-handoff-review-after-rewrite-v3';
      const postRewriteReviewFingerprint = computeScriptCheckpointInputFingerprint({
        node: 'handoff_review',
        inputRevisionRefs,
        upstreamArtifactRefs: [currentCandidateRef],
        promptVersion: postRewriteReviewPromptVersion,
        configRevision,
      });
      const storedPostRewriteReview = await this.latestCheckpoint(
        request.projectId,
        runKey,
        { node: 'handoff_review', episodeNumber, chunkStart: 2 },
      );
      let postRewriteReview: ScriptDirectHandoffReview | undefined;
      let postRewriteReviewRevision: number | undefined;
      if (storedPostRewriteReview) {
        const decision = decideScriptCheckpointResume(
          storedPostRewriteReview,
          postRewriteReviewFingerprint,
        );
        if (decision.disposition === 'reuse') {
          const value = storedPostRewriteReview.artifact;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const artifact = value as Partial<ScriptDirectReviewArtifact>;
            if (artifact.schemaVersion === 1 && artifact.stage === 'direct_review' && artifact.review) {
              postRewriteReview = artifact.review;
              postRewriteReviewRevision = storedPostRewriteReview.artifactRevision;
            }
          }
          if (!postRewriteReview) await this.markCheckpointStale(storedPostRewriteReview);
        } else if (decision.disposition === 'stale') {
          await this.markCheckpointStale(storedPostRewriteReview);
        }
      }
      if (!postRewriteReview) {
        request.signal?.throwIfAborted();
        try {
          const rawPostRewriteReview = await this.dependencies.model.complete({
            node: 'review',
            projectId: request.projectId,
            episodeNumber,
            prompt: buildDirectReviewPrompt(context, rawText),
            responseFormat: 'json',
            signal: request.signal,
          });
          postRewriteReview = reconcileDirectReviewBoundary(
            context,
            decodeDirectHandoffReview(parseStructuredModelOutput(rawPostRewriteReview)),
          );
          recordCall('review', 'ScriptDirectHandoffReviewAfterRewrite@v1', 1);
        } catch (error) {
          if (request.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
          postRewriteReview = createLocalDirectHandoffReview(outline, draft);
          recordCall('review', 'ScriptDirectHandoffReviewAfterRewrite@v1', 1, 'needs_review');
        }
        if (!postRewriteReview) {
          throw new ScriptModelOutputError(`第 ${episodeNumber} 集重写后审校结果无效。`);
        }
        postRewriteReviewRevision = await this.nextCheckpointArtifactRevision(
          request.projectId,
          runKey,
          { node: 'handoff_review', episodeNumber, chunkStart: 2 },
        );
        const postRewriteReviewArtifact: ScriptDirectReviewArtifact = {
          schemaVersion: 1,
          stage: 'direct_review',
          review: postRewriteReview,
          createdAt: this.now(),
        };
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'handoff_review',
          status: 'succeeded',
          attempt: 1,
          artifactRevision: postRewriteReviewRevision,
          episodeNumber,
          chunkStart: 2,
          artifact: postRewriteReviewArtifact,
          inputRevisionRefs,
          upstreamArtifactRefs: [currentCandidateRef],
          promptVersion: postRewriteReviewPromptVersion,
          configRevision,
          inputFingerprint: postRewriteReviewFingerprint,
          validationErrors: [],
          updatedAt: this.now(),
        }, `第 ${episodeNumber} 集重写后复核已完成。`);
      }
      if (!postRewriteReview) {
        throw new ScriptModelOutputError(`第 ${episodeNumber} 集重写后审校结果无效。`);
      }
      review = reconcileDirectReviewBoundary(context, postRewriteReview);
      const postRewriteReviewRef = buildScriptUpstreamArtifactRef(
        'handoff_review',
        postRewriteReviewRevision!,
        postRewriteReview,
      );
      episodeUpstreamRefs.push(postRewriteReviewRef);
      const postRewriteDraft = canonicalDirectCandidate({
        ...draft,
        summary: review.handoff.summary || outline.goal,
        newFacts: [...new Set([
          ...review.handoff.characterStates.flatMap((item) => item.knows),
          ...review.handoff.props.map((item) => `${item.name}：${item.state}`),
        ])],
        openedThreads: review.handoff.openThreads,
        closedThreads: [],
        updatedAt: this.now(),
      });
      draft = postRewriteDraft;
      const postRewriteBlockingIssues: ScriptGateIssue[] = review.issues.map((issue) => ({
        code: `DIRECT_RECHECK_${issue.code}`,
        severity: 'soft',
        source: 'ai',
        message: `${issue.evidence}；应为：${issue.expected}`,
        ...(issue.sceneNumber
          ? { sceneId: postRewriteDraft.scenes.find((scene) => scene.ordinal === issue.sceneNumber)?.id }
          : {}),
        path: 'scenes',
      }));
      deterministicReport = validateDraft(postRewriteDraft, postRewriteBlockingIssues);
      report = deterministicReport;
      }
    }

    const reviewUpdate = this.createReviewIssueUpdate(
      request.projectId,
      episodeNumber,
      deterministicReport.issues,
      rewriteApplied && review.verdict === 'pass' ? [] : aiIssues,
    );
    if (report.hardFailed) {
      await this.dependencies.store.replaceEpisodeReviewIssues(
        request.projectId,
        episodeNumber,
        reviewUpdate.sources,
        reviewUpdate.items,
      );
      const completedCheckpointRevision = await this.nextCheckpointArtifactRevision(
        request.projectId,
        runKey,
        { node: 'completed', episodeNumber },
      );
      const needsReviewArtifact = buildScriptEpisodeCandidateArtifact({
        projectId: request.projectId,
        episodeNumber,
        baseEpisodeRevision,
        inputRevisionRefs,
        upstreamArtifactRefs: episodeUpstreamRefs,
        promptVersion: 'direct-quality-needs-review-v1',
        configRevision,
        validationErrors: report.blockingIssues.map((issue) => ({
          ...(issue.path ? { path: issue.path } : {}),
          code: issue.code,
          message: issue.message,
        })),
        createdAt: this.now(),
      }, 'patched', draft);
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
      }, `第 ${episodeNumber} 集仍有明确结构或人物错误，候选已保留。`);
      throw new ScriptBatchPausedError(episodeNumber, report);
    }

    const completedCheckpointRevision = await this.nextCheckpointArtifactRevision(
      request.projectId,
      runKey,
      { node: 'completed', episodeNumber },
    );
    const finalCandidateArtifact = buildScriptEpisodeCandidateArtifact({
      projectId: request.projectId,
      episodeNumber,
      baseEpisodeRevision,
      inputRevisionRefs,
      upstreamArtifactRefs: episodeUpstreamRefs,
      promptVersion: 'direct-writing-final-v1',
      configRevision,
      createdAt: this.now(),
    }, 'patched', draft);
    const finalCandidateRef = buildScriptUpstreamArtifactRef(
      'completed',
      completedCheckpointRevision,
      finalCandidateArtifact,
    );
    const reviewState = state;
    const continuity = mergeDirectHandoffContinuity(
      buildScriptContinuityCandidate(reviewState, draft, []),
      review,
      draft,
      state.characters,
    );
    const commitInput = buildScriptAtomicCommitInput(reviewState, draft, continuity, {
      upstreamArtifactRefs: [...episodeUpstreamRefs, finalCandidateRef],
      promptVersion: 'short-drama-direct-writing-v1',
      modelConfigFingerprint: configRevision,
    });
    commitInput.reviewUpdate = reviewUpdate;
    commitInput.inputRevisionRefs = structuredClone(inputRevisionRefs);
    commitInput.expectedReviewRevision = reviewState.reviewRevision;
    commitInput.candidateHash = computeScriptEpisodeCandidateHash(draft);
    commitInput.inputFingerprint = computeScriptInputFingerprint(commitInput);
    const commitEpisodeWithContinuity = this.dependencies.store.commitEpisodeWithContinuity;
    if (!commitEpisodeWithContinuity) {
      throw new ScriptModelOutputError('正文存储未实现原子连续性提交。');
    }
    request.signal?.throwIfAborted();
    const { episode: saved } = await commitEpisodeWithContinuity.call(
      this.dependencies.store,
      commitInput,
    );
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
    }, `第 ${episodeNumber} 集直接写作已完成。`);
    return { episode: saved, report };
  }

  private parsePlannedScenes(value: unknown, maxScenes: number): ScriptPlannedScene[] {
    return coercePlannedScenes(value, { max: Math.max(1, maxScenes) });
  }

  private parseEpisode(
    value: Record<string, unknown>,
    projectId: string,
    outline: ScriptEpisodeOutline,
    plan: ScriptPlan,
    current?: ScriptEpisode,
  ): ScriptEpisode {
    const candidate = coerceEpisodeDraftCandidate(value, {
      projectId,
      outline,
      plan,
      ...(current ? { current } : {}),
      createId: () => this.createId(),
      now: this.now(),
    });
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
    const rawIssues = Array.isArray(value.issues) ? value.issues : [];
    const parsedIssues = rawIssues.flatMap((candidate): ScriptGateIssue[] => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const issue = candidate as Record<string, unknown>;
      const code = optionalStringField(issue.code);
      const message = optionalStringField(issue.message);
      if (!code || !message) return [];
      return [{
        code,
        severity: issue.severity === 'hard' ? 'hard' : 'soft',
        message,
        ...(optionalStringField(issue.sceneId) ? { sceneId: optionalStringField(issue.sceneId) } : {}),
        ...(optionalStringField(issue.blockId) ? { blockId: optionalStringField(issue.blockId) } : {}),
        ...(optionalStringField(issue.path) ? { path: optionalStringField(issue.path) } : {}),
      }];
    });
    const seenIssues = new Set<string>();
    const issues = parsedIssues
      .filter((issue) => SCRIPT_SANITY_REVIEW_CODES.has(issue.code))
      .filter((issue) => {
        const key = [
          issue.code,
          issue.sceneId ?? '',
          issue.blockId ?? '',
          issue.path ?? '',
          issue.message.toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]/gu, ''),
        ].join('|');
        if (seenIssues.has(key)) return false;
        seenIssues.add(key);
        return true;
      })
      .slice(0, SCRIPT_SANITY_REVIEW_MAX_ISSUES);
    const wardrobe = (Array.isArray(value.wardrobe) ? value.wardrobe : []).flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const item = candidate as Record<string, unknown>;
      const characterId = optionalStringField(item.characterId);
      const outfit = optionalStringField(item.outfit);
      return characterId && outfit ? [{ characterId, outfit }] : [];
    });
    const looseStrings = (candidate: unknown): string[] => Array.isArray(candidate)
      ? [...new Set(candidate.filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim()).filter(Boolean))]
      : [];
    return {
      issues,
      summary: optionalStringField(value.summary) ?? '',
      newFacts: looseStrings(value.newFacts),
      openedThreads: looseStrings(value.openedThreads),
      closedThreads: looseStrings(value.closedThreads),
      wardrobe,
    };
  }

  private async persistReviewIssues(
    projectId: string,
    episodeNumber: number,
    deterministicIssues: readonly ScriptGateIssue[],
    aiIssues: readonly ScriptGateIssue[],
  ): Promise<ScriptReviewIssueCollection> {
    const update = this.createReviewIssueUpdate(
      projectId,
      episodeNumber,
      deterministicIssues,
      aiIssues,
    );
    return this.dependencies.store.replaceEpisodeReviewIssues(
      projectId,
      episodeNumber,
      update.sources,
      update.items,
    );
  }

  private createReviewIssueUpdate(
    projectId: string,
    episodeNumber: number,
    deterministicIssues: readonly ScriptGateIssue[],
    aiIssues: readonly ScriptGateIssue[],
  ): { sources: ScriptReviewSource[]; items: ScriptReviewIssue[] } {
    const now = this.now();
    return {
      sources: ['deterministic', 'ai'],
      items: [
        ...createScriptReviewIssues(
          projectId,
          episodeNumber,
          'deterministic',
          deterministicIssues,
          now,
        ),
        ...createScriptReviewIssues(projectId, episodeNumber, 'ai', aiIssues, now),
      ],
    };
  }

  private assembleEpisodeContext(
    state: NonNullable<Awaited<ReturnType<ScriptStore['getProjectState']>>>,
    plan: ScriptPlan,
    outline: ScriptEpisodeOutline,
    episodeNumber: number,
  ): string {
    const previous = state.episodes.find((episode) => episode.episodeNumber === episodeNumber - 1);
    const cast = state.characters.filter((character) => outline.characterIds.includes(character.id));
    const planContext = {
      title: plan.title,
      theme: plan.theme,
      genres: plan.genres,
      coreConflict: plan.coreConflict,
      coreRequirements: plan.coreRequirements,
      forbiddenElements: plan.forbiddenElements,
      endingDirection: plan.endingDirection,
      targetCharsPerEpisode: plan.targetCharsPerEpisode,
      dialogueDensityPercent: plan.dialogueDensityPercent,
    };
    const worldContext = state.worldBible ? {
      era: state.worldBible.era,
      primaryLocations: state.worldBible.primaryLocations,
      worldState: state.worldBible.worldState,
      rules: state.worldBible.rules,
      organizations: state.worldBible.organizations,
      recurringProps: state.worldBible.recurringProps,
      forbiddenAnachronisms: state.worldBible.forbiddenAnachronisms,
    } : undefined;
    const castContext = cast.map((character) => ({
      id: character.id,
      name: character.name,
      role: character.role,
      identity: character.identity,
      motivation: character.motivation,
      goal: character.goal,
      weakness: character.weakness,
      arc: character.arc,
      defaultOutfit: character.defaultOutfit,
      personality: character.personality,
      speechStyle: character.speechStyle,
      catchphrases: character.catchphrases,
      relationships: character.relationships,
    }));
    const previousContext = previous ? {
      summary: previous.summary,
      newFacts: previous.newFacts,
      openedThreads: previous.openedThreads,
      lastScene: previous.scenes.slice(-1).map((scene) => ({
        location: scene.location,
        timeOfDay: scene.timeOfDay,
        interiorExterior: scene.interiorExterior,
        characterIds: scene.characterIds,
        blocks: scene.blocks.slice(-6),
      })),
    } : {};
    const sections = [
      ['锁定策划', JSON.stringify(planContext), 1_800],
      ['世界硬规则', JSON.stringify(worldContext), 2_000],
      ['本集人物', JSON.stringify(castContext), 4_500],
      ['本集大纲', JSON.stringify(outline), 2_500],
      ['上集承接', JSON.stringify(previousContext), 2_000],
      ['伏笔与当前状态', JSON.stringify({
        aggregate: projectScriptContinuity(state, episodeNumber),
        recentCommits: currentScriptContinuityCommits(state)
          .filter((commit) => commit.episodeNumber < episodeNumber)
          .slice(-2),
      }), 3_500],
      ['格式规则', '结构化 JSON；1—5 场；每场含地点、时间、内外景、人物与 caption/action/dialogue 块。', 1_000],
    ] as const;
    return sections
      .map(([label, content, limit]) => `${label}：${content.slice(0, limit)}`)
      .join('\n');
  }

  private async generateNodeStructured<T>(
    request: ScriptModelRequest,
    contract: StructuredContract<T>,
    onMetric?: (metric: ScriptStructuredCallMetric) => void,
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
    onMetric?.(this.structuredCallMetric(request, result));
    if (result.status === 'needs_review') {
      throw new ScriptStructuredNeedsReviewError(request.node, result.error);
    }
    return result.value;
  }

  private structuredCallMetric<T>(
    request: ScriptModelRequest,
    result: StructuredGenerationResult<T>,
  ): ScriptStructuredCallMetric {
    return {
      node: request.node,
      ...(request.episodeNumber === undefined ? {} : { episodeNumber: request.episodeNumber }),
      contractName: result.contractName,
      status: result.status,
      callsUsed: result.callsUsed,
      ...(result.status === 'completed' ? { completedBy: result.completedBy } : {}),
      attempts: result.attempts.map((attempt) => ({
        stage: attempt.stage,
        outcome: attempt.outcome,
      })),
    };
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

      if (completedCandidateRejected) {
        const directPostRewriteReview = latestScriptCheckpoint(checkpoints, {
          node: 'handoff_review',
          episodeNumber,
          chunkStart: 2,
        });
        if (directPostRewriteReview && directPostRewriteReview.status !== 'stale') {
          await this.markCheckpointStale(directPostRewriteReview);
        }
        const directRewrite = latestScriptCheckpoint(checkpoints, {
          node: 'direct_rewrite',
          episodeNumber,
        });
        if (directRewrite && directRewrite.status !== 'stale') {
          await this.markCheckpointStale(directRewrite);
        }
      }

      for (const revision of revisions) {
        if (
          revision.status === 'needs_review' ||
          (completedCandidateRejected && revision.status === 'succeeded')
        ) {
          await this.markCheckpointStale(revision);
        }
      }
      // Keep the durable completed=needs_review boundary until every rejected
      // revision has been invalidated. A crash between writes will therefore
      // retry the invalidation instead of reusing a rejected succeeded revision.
      if (completedCandidateRejected) await this.markCheckpointStale(completed);
    }
  }

  private now(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }

  private createId(): string {
    return this.dependencies.id?.() ?? randomUUID();
  }
}
