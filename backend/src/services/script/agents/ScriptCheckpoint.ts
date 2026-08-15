import { createHash } from 'node:crypto';

import type {
  ScriptEpisode,
  ScriptInputRevisionRef,
  ScriptPlannedScene,
  ScriptUpstreamArtifactRef,
} from '../domain.js';
import { computeScriptEpisodeCandidateHash } from '../ScriptStore.js';

export type ScriptCheckpointNode =
  | 'plan'
  | 'series_outline'
  | 'character_bible'
  | 'world_bible'
  | 'episode_outline'
  | 'scene_plan'
  | 'draft'
  | 'review'
  | 'revision'
  | 'completed'
  | 'batch_report';

/** Internal node state. Job-level waiting_user is represented by needs_review. */
export type ScriptNodeStatus =
  | 'pending'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'needs_review'
  | 'failed'
  | 'stale';

export type LegacyScriptNodeStatus = 'running' | 'completed';

export interface ScriptCheckpointValidationError {
  path?: string;
  code: string;
  message: string;
}

export type ScriptArtifactStage = 'scene_plan' | 'draft' | 'patched';

export interface ScriptCheckpointArtifactMeta {
  schemaVersion: 1;
  stage: ScriptArtifactStage;
  projectId: string;
  episodeNumber: number;
  baseEpisodeRevision: number;
  inputRevisionRefs: ScriptInputRevisionRef[];
  upstreamArtifactRefs: ScriptUpstreamArtifactRef[];
  promptVersion: string;
  configRevision: string;
  inputFingerprint: string;
  candidateHash: string;
  validationErrors: ScriptCheckpointValidationError[];
  createdAt: string;
}

export interface ScriptScenePlanArtifact extends ScriptCheckpointArtifactMeta {
  stage: 'scene_plan';
  plannedScenes: ScriptPlannedScene[];
}

export interface ScriptEpisodeCandidateArtifact extends ScriptCheckpointArtifactMeta {
  stage: 'draft' | 'patched';
  episode: ScriptEpisode;
}

export interface ScriptCheckpointArtifactBuildContext {
  projectId: string;
  episodeNumber: number;
  baseEpisodeRevision: number;
  inputRevisionRefs: readonly ScriptInputRevisionRef[];
  upstreamArtifactRefs?: readonly ScriptUpstreamArtifactRef[];
  promptVersion: string;
  configRevision: string;
  validationErrors?: readonly ScriptCheckpointValidationError[];
  createdAt: string;
}

export interface ScriptCheckpointArtifactExpectation {
  projectId: string;
  episodeNumber: number;
  baseEpisodeRevision: number;
  /** Recomputed from the current canon, Prompt and model configuration. */
  inputFingerprint: string;
  candidateHash?: string;
}

/** Canonical v2 checkpoint returned by every checkpoint store. */
export interface ScriptPipelineCheckpoint {
  schemaVersion: 2;
  projectId: string;
  runKey: string;
  node: ScriptCheckpointNode;
  status: ScriptNodeStatus;
  attempt: number;
  artifactRevision: number;
  episodeNumber?: number;
  chunkStart?: number;
  inputRevisionRefs: ScriptInputRevisionRef[];
  upstreamArtifactRefs: ScriptUpstreamArtifactRef[];
  promptVersion: string;
  configRevision: string;
  /** Empty only for migrated or compatibility writes whose inputs cannot be proven. */
  inputFingerprint: string;
  validationErrors: ScriptCheckpointValidationError[];
  artifact?: unknown;
  updatedAt: string;
}

/**
 * Transitional write contract for call sites that predate checkpoint v2.
 * Stores always expand this value to a complete v2 record before persisting it;
 * an unversioned write gets an empty fingerprint and is therefore never reusable.
 */
export type ScriptPipelineCheckpointWrite = Omit<
  ScriptPipelineCheckpoint,
  | 'schemaVersion'
  | 'status'
  | 'inputRevisionRefs'
  | 'upstreamArtifactRefs'
  | 'promptVersion'
  | 'configRevision'
  | 'inputFingerprint'
  | 'validationErrors'
> & {
  schemaVersion?: 2;
  status: ScriptNodeStatus | LegacyScriptNodeStatus;
  inputRevisionRefs?: ScriptInputRevisionRef[];
  upstreamArtifactRefs?: ScriptUpstreamArtifactRef[];
  promptVersion?: string;
  configRevision?: string;
  inputFingerprint?: string;
  validationErrors?: ScriptCheckpointValidationError[];
};

export interface ScriptCheckpointStore {
  list(projectId: string, runKey: string): Promise<ScriptPipelineCheckpoint[]>;
  save(checkpoint: ScriptPipelineCheckpointWrite): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
}

export interface ScriptCheckpointFingerprintInput {
  node: string;
  inputRevisionRefs: readonly ScriptInputRevisionRef[];
  upstreamArtifactRefs?: readonly ScriptUpstreamArtifactRef[];
  promptVersion: string;
  configRevision: string;
}

export type ScriptCheckpointResumeDecision =
  | { disposition: 'reuse'; checkpoint: ScriptPipelineCheckpoint }
  | { disposition: 'resume'; checkpoint: ScriptPipelineCheckpoint }
  | { disposition: 'stale'; checkpoint: ScriptPipelineCheckpoint };

const LEGACY_VERSION = 'legacy-unversioned';
const SHA256_HEX = /^[a-f0-9]{64}$/i;
const SCRIPT_CHECKPOINT_NODES: readonly ScriptCheckpointNode[] = [
  'plan',
  'series_outline',
  'character_bible',
  'world_bible',
  'episode_outline',
  'scene_plan',
  'draft',
  'review',
  'revision',
  'completed',
  'batch_report',
];
const SCRIPT_NODE_STATUSES: readonly ScriptNodeStatus[] = [
  'pending',
  'running',
  'retrying',
  'succeeded',
  'needs_review',
  'failed',
  'stale',
];

interface DecodedCheckpointBase extends Record<string, unknown> {
  projectId: string;
  runKey: string;
  node: ScriptCheckpointNode;
  status: unknown;
  attempt: number;
  artifactRevision: number;
  updatedAt: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = canonicalize(child);
  }
  return result;
}

function canonicalHash(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) {
    throw new TypeError('checkpoint artifact 无法进行 canonical JSON 序列化');
  }
  return createHash('sha256')
    .update(serialized, 'utf8')
    .digest('hex');
}

/** Stable hash for an immutable checkpoint artifact or artifact payload. */
export function computeScriptCheckpointArtifactHash(value: unknown): string {
  return canonicalHash(value);
}

/**
 * Stable input identity for one node. It deliberately excludes timestamps,
 * model output and artifacts produced by the node itself.
 */
export function computeScriptCheckpointInputFingerprint(
  input: ScriptCheckpointFingerprintInput,
): string {
  const inputRevisionRefs = [...input.inputRevisionRefs].sort((left, right) =>
    left.resource.localeCompare(right.resource) ||
    left.id.localeCompare(right.id) ||
    left.revision - right.revision,
  );
  const upstreamArtifactRefs = [...(input.upstreamArtifactRefs ?? [])].sort(
    (left, right) =>
      left.node.localeCompare(right.node) ||
      left.artifactRevision - right.artifactRevision ||
      left.artifactHash.localeCompare(right.artifactHash),
  );
  return canonicalHash({
    node: input.node,
    inputRevisionRefs,
    upstreamArtifactRefs,
    promptVersion: input.promptVersion,
    configRevision: input.configRevision,
  });
}

export function buildScriptScenePlanArtifact(
  context: ScriptCheckpointArtifactBuildContext,
  plannedScenes: readonly ScriptPlannedScene[],
): ScriptScenePlanArtifact {
  const scenes = structuredClone([...plannedScenes]);
  const inputFingerprint = artifactInputFingerprint('scene_plan', context);
  const artifact: ScriptScenePlanArtifact = {
    ...artifactMeta(context, 'scene_plan', inputFingerprint),
    candidateHash: computeScriptCheckpointArtifactHash(scenes),
    plannedScenes: scenes,
  };
  return decodeScriptScenePlanArtifact(artifact, artifactExpectation(artifact));
}

export function buildScriptEpisodeCandidateArtifact(
  context: ScriptCheckpointArtifactBuildContext,
  stage: 'draft' | 'patched',
  episode: ScriptEpisode,
): ScriptEpisodeCandidateArtifact {
  const candidate = structuredClone(episode);
  const inputFingerprint = artifactInputFingerprint(
    stage === 'draft' ? 'draft' : 'revision',
    context,
  );
  const artifact: ScriptEpisodeCandidateArtifact = {
    ...artifactMeta(context, stage, inputFingerprint),
    candidateHash: computeScriptEpisodeCandidateHash(candidate),
    episode: candidate,
  };
  return decodeScriptEpisodeCandidateArtifact(artifact, artifactExpectation(artifact));
}

export function buildScriptUpstreamArtifactRef(
  node: string,
  artifactRevision: number,
  artifact: ScriptScenePlanArtifact | ScriptEpisodeCandidateArtifact | unknown,
): ScriptUpstreamArtifactRef {
  if (!node.trim()) throw new TypeError('upstream artifact node 不能为空');
  if (!Number.isInteger(artifactRevision) || artifactRevision < 0) {
    throw new TypeError('upstream artifact revision 必须是非负整数');
  }
  return {
    node: node.trim(),
    artifactRevision,
    artifactHash: isVersionedScriptCheckpointArtifact(artifact)
      ? computeScriptCheckpointArtifactHash({
          schemaVersion: artifact.schemaVersion,
          stage: artifact.stage,
          projectId: artifact.projectId,
          episodeNumber: artifact.episodeNumber,
          baseEpisodeRevision: artifact.baseEpisodeRevision,
          inputFingerprint: artifact.inputFingerprint,
          candidateHash: artifact.candidateHash,
        })
      : computeScriptCheckpointArtifactHash(artifact),
  };
}

function isVersionedScriptCheckpointArtifact(
  value: unknown,
): value is ScriptScenePlanArtifact | ScriptEpisodeCandidateArtifact {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (!['scene_plan', 'draft', 'patched'].includes(String(value.stage))) return false;
  return (
    isNonEmptyString(value.projectId) &&
    Number.isInteger(value.episodeNumber) &&
    (value.episodeNumber as number) >= 1 &&
    Number.isInteger(value.baseEpisodeRevision) &&
    (value.baseEpisodeRevision as number) >= 0 &&
    typeof value.inputFingerprint === 'string' &&
    SHA256_HEX.test(value.inputFingerprint) &&
    typeof value.candidateHash === 'string' &&
    SHA256_HEX.test(value.candidateHash) &&
    (value.stage === 'scene_plan' ? Array.isArray(value.plannedScenes) : isRecord(value.episode))
  );
}

export function decodeScriptScenePlanArtifact(
  value: unknown,
  expected: ScriptCheckpointArtifactExpectation,
): ScriptScenePlanArtifact {
  const record = artifactRecord(value);
  const meta = decodeArtifactMeta(record, 'scene_plan', expected);
  const plannedScenes = decodePlannedScenes(record.plannedScenes);
  const candidateHash = computeScriptCheckpointArtifactHash(plannedScenes);
  verifyCandidateHash(meta.candidateHash, candidateHash, expected);
  return { ...meta, stage: 'scene_plan', plannedScenes };
}

export function decodeScriptEpisodeCandidateArtifact(
  value: unknown,
  expected: ScriptCheckpointArtifactExpectation,
): ScriptEpisodeCandidateArtifact {
  const record = artifactRecord(value);
  if (record.stage !== 'draft' && record.stage !== 'patched') {
    throw new TypeError(`单集候选 artifact stage 无效: ${String(record.stage)}`);
  }
  const meta = decodeArtifactMeta(record, record.stage, expected);
  const episode = decodeCandidateEpisode(record.episode);
  if (episode.projectId !== meta.projectId || episode.episodeNumber !== meta.episodeNumber) {
    throw new TypeError('单集候选 artifact 的项目或集号与正文不一致');
  }
  if (episode.revision !== meta.baseEpisodeRevision) {
    throw new TypeError('单集候选 artifact 的 baseEpisodeRevision 与正文 revision 不一致');
  }
  if (episode.status !== 'reviewing') {
    throw new TypeError('单集候选 artifact 正文状态必须是 reviewing');
  }
  const candidateHash = computeScriptEpisodeCandidateHash(episode);
  verifyCandidateHash(meta.candidateHash, candidateHash, expected);
  return { ...meta, stage: record.stage, episode };
}

function artifactInputFingerprint(
  node: 'scene_plan' | 'draft' | 'revision',
  context: ScriptCheckpointArtifactBuildContext,
): string {
  return computeScriptCheckpointInputFingerprint({
    node,
    inputRevisionRefs: context.inputRevisionRefs,
    upstreamArtifactRefs: context.upstreamArtifactRefs,
    promptVersion: context.promptVersion,
    configRevision: context.configRevision,
  });
}

function artifactMeta<TStage extends ScriptArtifactStage>(
  context: ScriptCheckpointArtifactBuildContext,
  stage: TStage,
  inputFingerprint: string,
): Omit<ScriptCheckpointArtifactMeta, 'candidateHash' | 'stage'> & { stage: TStage } {
  const inputRevisionRefs = [...context.inputRevisionRefs].sort((left, right) =>
    left.resource.localeCompare(right.resource) ||
    left.id.localeCompare(right.id) ||
    left.revision - right.revision,
  );
  const upstreamArtifactRefs = [...(context.upstreamArtifactRefs ?? [])].sort(
    (left, right) =>
      left.node.localeCompare(right.node) ||
      left.artifactRevision - right.artifactRevision ||
      left.artifactHash.localeCompare(right.artifactHash),
  );
  return {
    schemaVersion: 1,
    stage,
    projectId: context.projectId,
    episodeNumber: context.episodeNumber,
    baseEpisodeRevision: context.baseEpisodeRevision,
    inputRevisionRefs: structuredClone(inputRevisionRefs),
    upstreamArtifactRefs: structuredClone(upstreamArtifactRefs),
    promptVersion: context.promptVersion,
    configRevision: context.configRevision,
    inputFingerprint,
    validationErrors: structuredClone([...(context.validationErrors ?? [])]),
    createdAt: context.createdAt,
  };
}

function artifactExpectation(
  artifact: ScriptCheckpointArtifactMeta,
): ScriptCheckpointArtifactExpectation {
  return {
    projectId: artifact.projectId,
    episodeNumber: artifact.episodeNumber,
    baseEpisodeRevision: artifact.baseEpisodeRevision,
    inputFingerprint: artifact.inputFingerprint,
    candidateHash: artifact.candidateHash,
  };
}

function artifactRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('短剧 checkpoint artifact 必须是对象');
  return value;
}

function decodeArtifactMeta(
  record: Record<string, unknown>,
  stage: ScriptArtifactStage,
  expected: ScriptCheckpointArtifactExpectation,
): ScriptCheckpointArtifactMeta {
  if (record.schemaVersion !== 1) {
    throw new TypeError(`短剧 checkpoint artifact schemaVersion 无效: ${String(record.schemaVersion)}`);
  }
  if (record.stage !== stage) {
    throw new TypeError(`短剧 checkpoint artifact stage 无效: ${String(record.stage)}`);
  }
  if (typeof record.projectId !== 'string' || !record.projectId.trim()) {
    throw new TypeError('短剧 checkpoint artifact projectId 无效');
  }
  if (!Number.isInteger(record.episodeNumber) || (record.episodeNumber as number) < 1) {
    throw new TypeError('短剧 checkpoint artifact episodeNumber 无效');
  }
  if (!Number.isInteger(record.baseEpisodeRevision) ||
    (record.baseEpisodeRevision as number) < 0) {
    throw new TypeError('短剧 checkpoint artifact baseEpisodeRevision 无效');
  }
  if (
    record.projectId !== expected.projectId ||
    record.episodeNumber !== expected.episodeNumber ||
    record.baseEpisodeRevision !== expected.baseEpisodeRevision
  ) {
    throw new TypeError('短剧 checkpoint artifact 与当前项目、集号或 base revision 不匹配');
  }
  if (
    !isInputRevisionRefs(record.inputRevisionRefs) ||
    !isUpstreamArtifactRefs(record.upstreamArtifactRefs) ||
    typeof record.promptVersion !== 'string' ||
    !record.promptVersion.trim() ||
    typeof record.configRevision !== 'string' ||
    !record.configRevision.trim() ||
    typeof record.inputFingerprint !== 'string' ||
    !SHA256_HEX.test(record.inputFingerprint) ||
    typeof record.candidateHash !== 'string' ||
    !SHA256_HEX.test(record.candidateHash) ||
    !isValidationErrors(record.validationErrors) ||
    typeof record.createdAt !== 'string' ||
    !record.createdAt.trim()
  ) {
    throw new TypeError('短剧 checkpoint artifact 缺少有效的版本、fingerprint 或校验元数据');
  }
  const inputFingerprint = computeScriptCheckpointInputFingerprint({
    node: stage === 'patched' ? 'revision' : stage,
    inputRevisionRefs: record.inputRevisionRefs,
    upstreamArtifactRefs: record.upstreamArtifactRefs,
    promptVersion: record.promptVersion,
    configRevision: record.configRevision,
  });
  if (
    inputFingerprint !== record.inputFingerprint ||
    record.inputFingerprint !== expected.inputFingerprint
  ) {
    throw new TypeError('短剧 checkpoint artifact inputFingerprint 校验失败');
  }
  return {
    schemaVersion: 1,
    stage,
    projectId: record.projectId,
    episodeNumber: record.episodeNumber as number,
    baseEpisodeRevision: record.baseEpisodeRevision as number,
    inputRevisionRefs: structuredClone(record.inputRevisionRefs),
    upstreamArtifactRefs: structuredClone(record.upstreamArtifactRefs),
    promptVersion: record.promptVersion,
    configRevision: record.configRevision,
    inputFingerprint: record.inputFingerprint,
    candidateHash: record.candidateHash,
    validationErrors: structuredClone(record.validationErrors),
    createdAt: record.createdAt,
  };
}

function verifyCandidateHash(
  storedHash: string,
  computedHash: string,
  expected: ScriptCheckpointArtifactExpectation,
): void {
  if (
    storedHash !== computedHash ||
    (expected.candidateHash !== undefined && storedHash !== expected.candidateHash)
  ) {
    throw new TypeError('短剧 checkpoint artifact candidateHash 校验失败');
  }
}

function decodePlannedScenes(value: unknown): ScriptPlannedScene[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new TypeError('scene plan artifact 的 plannedScenes 必须包含 1—5 场');
  }
  const ordinals = new Set<number>();
  const scenes = value.map((candidate, index): ScriptPlannedScene => {
    if (!isRecord(candidate)) {
      throw new TypeError(`scene plan artifact plannedScenes[${index}] 必须是对象`);
    }
    if (!Number.isInteger(candidate.ordinal) || (candidate.ordinal as number) < 1) {
      throw new TypeError(`scene plan artifact plannedScenes[${index}].ordinal 无效`);
    }
    const ordinal = candidate.ordinal as number;
    if (ordinals.has(ordinal)) {
      throw new TypeError(`scene plan artifact 场号 ${ordinal} 重复`);
    }
    ordinals.add(ordinal);
    if (
      !isNonEmptyString(candidate.location) ||
      !isNonEmptyString(candidate.purpose) ||
      !['day', 'night', 'dawn', 'dusk'].includes(String(candidate.timeOfDay)) ||
      !['interior', 'exterior'].includes(String(candidate.interiorExterior))
    ) {
      throw new TypeError(`scene plan artifact plannedScenes[${index}] 字段无效`);
    }
    return {
      ordinal,
      location: candidate.location,
      timeOfDay: candidate.timeOfDay as ScriptPlannedScene['timeOfDay'],
      interiorExterior:
        candidate.interiorExterior as ScriptPlannedScene['interiorExterior'],
      purpose: candidate.purpose,
    };
  });
  if (scenes.some((scene, index) => scene.ordinal !== index + 1)) {
    throw new TypeError('scene plan artifact 场号必须从 1 连续递增');
  }
  return scenes;
}

function decodeCandidateEpisode(value: unknown): ScriptEpisode {
  if (!isRecord(value)) throw new TypeError('单集候选 artifact episode 必须是对象');
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.projectId) ||
    !Number.isInteger(value.episodeNumber) ||
    (value.episodeNumber as number) < 1 ||
    !isNonEmptyString(value.title) ||
    !isNonEmptyString(value.outlineId) ||
    !['planned', 'generating', 'reviewing', 'completed', 'failed'].includes(
      String(value.status),
    ) ||
    !Number.isInteger(value.targetChars) ||
    (value.targetChars as number) < 1 ||
    !Array.isArray(value.scenes) ||
    !isString(value.summary) ||
    !isStringArray(value.newFacts) ||
    !isStringArray(value.openedThreads) ||
    !isStringArray(value.closedThreads) ||
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isNonEmptyString(value.createdAt) ||
    !isNonEmptyString(value.updatedAt)
  ) {
    throw new TypeError('单集候选 artifact episode 基础字段无效');
  }
  for (const [sceneIndex, sceneValue] of value.scenes.entries()) {
    if (!isRecord(sceneValue)) {
      throw new TypeError(`单集候选 artifact scenes[${sceneIndex}] 必须是对象`);
    }
    if (
      !isNonEmptyString(sceneValue.id) ||
      !Number.isInteger(sceneValue.ordinal) ||
      (sceneValue.ordinal as number) < 1 ||
      !isNonEmptyString(sceneValue.location) ||
      !['day', 'night', 'dawn', 'dusk'].includes(String(sceneValue.timeOfDay)) ||
      !['interior', 'exterior'].includes(String(sceneValue.interiorExterior)) ||
      !isStringArray(sceneValue.characterIds) ||
      !Array.isArray(sceneValue.blocks)
    ) {
      throw new TypeError(`单集候选 artifact scenes[${sceneIndex}] 字段无效`);
    }
    for (const [blockIndex, blockValue] of sceneValue.blocks.entries()) {
      if (!isRecord(blockValue) ||
        !isNonEmptyString(blockValue.id) ||
        !['caption', 'action', 'dialogue'].includes(String(blockValue.type)) ||
        !isString(blockValue.text)) {
        throw new TypeError(
          `单集候选 artifact scenes[${sceneIndex}].blocks[${blockIndex}] 字段无效`,
        );
      }
      if (blockValue.type === 'dialogue' && (
        !isNonEmptyString(blockValue.speaker) ||
        (blockValue.characterId !== undefined && !isNonEmptyString(blockValue.characterId)) ||
        (blockValue.delivery !== undefined && !isString(blockValue.delivery)) ||
        (blockValue.mode !== undefined &&
          !['normal', 'os', 'vo'].includes(String(blockValue.mode)))
      )) {
        throw new TypeError(
          `单集候选 artifact scenes[${sceneIndex}].blocks[${blockIndex}] 对白字段无效`,
        );
      }
    }
  }
  return structuredClone(value as unknown as ScriptEpisode);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/**
 * Pure recovery decision: only a succeeded node with the exact current,
 * non-empty fingerprint can be reused. Changed inputs stale the old artifact.
 */
export function decideScriptCheckpointResume(
  checkpoint: ScriptPipelineCheckpoint,
  currentInputFingerprint: string,
): ScriptCheckpointResumeDecision {
  const copy = structuredClone(checkpoint);
  if (
    !SHA256_HEX.test(checkpoint.inputFingerprint) ||
    checkpoint.inputFingerprint !== currentInputFingerprint
  ) {
    return {
      disposition: 'stale',
      checkpoint: { ...copy, status: 'stale' },
    };
  }
  return checkpoint.status === 'succeeded'
    ? { disposition: 'reuse', checkpoint: copy }
    : { disposition: 'resume', checkpoint: copy };
}

export class InMemoryScriptCheckpointStore implements ScriptCheckpointStore {
  private readonly items = new Map<string, ScriptPipelineCheckpoint>();

  async list(projectId: string, runKey: string): Promise<ScriptPipelineCheckpoint[]> {
    return [...this.items.values()]
      .filter((item) => item.projectId === projectId && item.runKey === runKey)
      .map((item) => structuredClone(item));
  }

  async save(checkpoint: ScriptPipelineCheckpointWrite): Promise<void> {
    const normalized = normalizeScriptCheckpointWrite(checkpoint);
    const key = checkpointIdentity(normalized);
    const current = this.items.get(key);
    this.items.set(
      key,
      current
        ? mergeScriptCheckpointRevision(current, normalized)
        : structuredClone(normalized),
    );
  }

  async deleteProject(projectId: string): Promise<void> {
    for (const [key, checkpoint] of this.items.entries()) {
      if (checkpoint.projectId === projectId) this.items.delete(key);
    }
  }
}

export function checkpointIdentity(checkpoint: Pick<
  ScriptPipelineCheckpoint,
  | 'projectId'
  | 'runKey'
  | 'node'
  | 'episodeNumber'
  | 'chunkStart'
  | 'artifactRevision'
>): string {
  return JSON.stringify([
    checkpoint.projectId,
    checkpoint.runKey,
    checkpoint.node,
    checkpoint.episodeNumber ?? null,
    checkpoint.chunkStart ?? null,
    checkpoint.artifactRevision,
  ]);
}

export interface ScriptCheckpointSelector {
  node: ScriptCheckpointNode;
  episodeNumber?: number;
  chunkStart?: number;
}

/**
 * Select the newest immutable artifact revision for one logical node scope.
 * Store iteration order is deliberately not part of recovery semantics.
 */
export function latestScriptCheckpoint(
  checkpoints: readonly ScriptPipelineCheckpoint[],
  selector: ScriptCheckpointSelector,
): ScriptPipelineCheckpoint | undefined {
  return checkpoints
    .filter((checkpoint) =>
      checkpoint.node === selector.node &&
      (selector.episodeNumber === undefined ||
        checkpoint.episodeNumber === selector.episodeNumber) &&
      (selector.chunkStart === undefined || checkpoint.chunkStart === selector.chunkStart),
    )
    .reduce<ScriptPipelineCheckpoint | undefined>((latest, checkpoint) => {
      if (!latest || compareScriptCheckpointRecency(checkpoint, latest) > 0) {
        return checkpoint;
      }
      return latest;
    }, undefined);
}

/** Return the next artifact revision for one logical node scope. */
export function nextScriptCheckpointArtifactRevision(
  checkpoints: readonly ScriptPipelineCheckpoint[],
  selector: ScriptCheckpointSelector,
): number {
  const latest = latestScriptCheckpoint(checkpoints, selector);
  return latest ? latest.artifactRevision + 1 : 0;
}

/**
 * Merge an operational status update for one immutable artifact revision.
 * A running record may materialize its artifact once; after that, changing the
 * artifact or any of its provenance fields requires a new artifactRevision.
 */
export function mergeScriptCheckpointRevision(
  current: ScriptPipelineCheckpoint,
  incoming: ScriptPipelineCheckpoint,
): ScriptPipelineCheckpoint {
  if (checkpointIdentity(current) !== checkpointIdentity(incoming)) {
    throw new TypeError('只能合并同一短剧检查点 artifact revision');
  }

  if (current.artifact === undefined) {
    const immutableCurrent = checkpointImmutablePayload(current, undefined);
    const immutableIncoming = checkpointImmutablePayload(incoming, undefined);
    if (canonicalHash(immutableCurrent) !== canonicalHash(immutableIncoming)) {
      throw new TypeError(
        '短剧检查点 artifact revision 不可原地改写 provenance；请增加 artifactRevision',
      );
    }
    return structuredClone(incoming);
  }

  const incomingArtifact = incoming.artifact === undefined
    ? current.artifact
    : incoming.artifact;
  const immutableCurrent = checkpointImmutablePayload(current, current.artifact);
  const immutableIncoming = checkpointImmutablePayload(incoming, incomingArtifact);
  if (canonicalHash(immutableCurrent) !== canonicalHash(immutableIncoming)) {
    throw new TypeError(
      '短剧检查点 artifact revision 不可原地改写；请增加 artifactRevision',
    );
  }

  return structuredClone({
    ...incoming,
    artifact: incomingArtifact,
  });
}

function checkpointImmutablePayload(
  checkpoint: ScriptPipelineCheckpoint,
  artifact: unknown,
): unknown {
  return {
    inputRevisionRefs: checkpoint.inputRevisionRefs,
    upstreamArtifactRefs: checkpoint.upstreamArtifactRefs,
    promptVersion: checkpoint.promptVersion,
    configRevision: checkpoint.configRevision,
    inputFingerprint: checkpoint.inputFingerprint,
    artifact,
  };
}

function compareScriptCheckpointRecency(
  left: ScriptPipelineCheckpoint,
  right: ScriptPipelineCheckpoint,
): number {
  return left.artifactRevision - right.artifactRevision ||
    left.attempt - right.attempt ||
    left.updatedAt.localeCompare(right.updatedAt);
}

/** Expand a legacy call-site write to a non-reusable, complete v2 record. */
export function normalizeScriptCheckpointWrite(
  checkpoint: ScriptPipelineCheckpointWrite,
): ScriptPipelineCheckpoint {
  const status = checkpoint.status === 'completed' ? 'succeeded' : checkpoint.status;
  if (!isScriptNodeStatus(status)) {
    throw new TypeError(`未知的短剧检查点写入状态: ${String(checkpoint.status)}`);
  }
  const normalized: ScriptPipelineCheckpoint = {
    ...structuredClone(checkpoint),
    schemaVersion: 2,
    status,
    inputRevisionRefs: structuredClone(checkpoint.inputRevisionRefs ?? []),
    upstreamArtifactRefs: structuredClone(checkpoint.upstreamArtifactRefs ?? []),
    promptVersion: checkpoint.promptVersion ?? LEGACY_VERSION,
    configRevision: checkpoint.configRevision ?? LEGACY_VERSION,
    inputFingerprint: checkpoint.inputFingerprint ?? '',
    validationErrors: structuredClone(checkpoint.validationErrors ?? []),
  };
  return decodeScriptCheckpointV2(normalized);
}

/** Used only while reading an outer schemaVersion 1 checkpoint file. */
export function migrateScriptCheckpointV1(value: unknown): ScriptPipelineCheckpoint {
  const checkpoint = decodeCheckpointBase(value);
  const legacyStatus = checkpoint.status;
  if (legacyStatus !== 'running' && legacyStatus !== 'completed') {
    throw new TypeError(`未知的 v1 短剧检查点状态: ${String(legacyStatus)}`);
  }
  return normalizeScriptCheckpointWrite({
    projectId: checkpoint.projectId,
    runKey: checkpoint.runKey,
    node: checkpoint.node,
    status: legacyStatus === 'running' ? 'pending' : 'succeeded',
    attempt: checkpoint.attempt,
    artifactRevision: checkpoint.artifactRevision,
    ...(typeof checkpoint.episodeNumber === 'number'
      ? { episodeNumber: checkpoint.episodeNumber }
      : {}),
    ...(typeof checkpoint.chunkStart === 'number'
      ? { chunkStart: checkpoint.chunkStart }
      : {}),
    ...(isInputRevisionRefs(checkpoint.inputRevisionRefs)
      ? { inputRevisionRefs: checkpoint.inputRevisionRefs }
      : {}),
    ...(isUpstreamArtifactRefs(checkpoint.upstreamArtifactRefs)
      ? { upstreamArtifactRefs: checkpoint.upstreamArtifactRefs }
      : {}),
    ...(typeof checkpoint.promptVersion === 'string'
      ? { promptVersion: checkpoint.promptVersion }
      : {}),
    ...(typeof checkpoint.configRevision === 'string'
      ? { configRevision: checkpoint.configRevision }
      : {}),
    ...(typeof checkpoint.inputFingerprint === 'string' &&
    (checkpoint.inputFingerprint === '' || SHA256_HEX.test(checkpoint.inputFingerprint))
      ? { inputFingerprint: checkpoint.inputFingerprint }
      : {}),
    ...(isValidationErrors(checkpoint.validationErrors)
      ? { validationErrors: checkpoint.validationErrors }
      : {}),
    ...('artifact' in checkpoint ? { artifact: checkpoint.artifact } : {}),
    updatedAt: checkpoint.updatedAt,
  });
}

/** Strict decoder for records already stored inside an outer v2 file. */
export function decodeScriptCheckpointV2(value: unknown): ScriptPipelineCheckpoint {
  const checkpoint = decodeCheckpointBase(value);
  if (checkpoint.schemaVersion !== 2) {
    throw new TypeError('v2 短剧检查点记录缺少 schemaVersion=2');
  }
  if (!isScriptNodeStatus(checkpoint.status)) {
    throw new TypeError(`未知的 v2 短剧检查点状态: ${String(checkpoint.status)}`);
  }
  if (
    !isInputRevisionRefs(checkpoint.inputRevisionRefs) ||
    !isUpstreamArtifactRefs(checkpoint.upstreamArtifactRefs) ||
    typeof checkpoint.promptVersion !== 'string' ||
    typeof checkpoint.configRevision !== 'string' ||
    typeof checkpoint.inputFingerprint !== 'string' ||
    (checkpoint.inputFingerprint !== '' && !SHA256_HEX.test(checkpoint.inputFingerprint)) ||
    !isValidationErrors(checkpoint.validationErrors)
  ) {
    throw new TypeError('v2 短剧检查点记录缺少输入版本或校验元数据');
  }
  return structuredClone(checkpoint as unknown as ScriptPipelineCheckpoint);
}

function decodeCheckpointBase(value: unknown): DecodedCheckpointBase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('短剧检查点记录不是对象');
  }
  const checkpoint = value as Record<string, unknown>;
  if (
    typeof checkpoint.projectId !== 'string' ||
    typeof checkpoint.runKey !== 'string' ||
    !isScriptCheckpointNode(checkpoint.node) ||
    !Number.isInteger(checkpoint.attempt) ||
    (checkpoint.attempt as number) < 0 ||
    !Number.isInteger(checkpoint.artifactRevision) ||
    (checkpoint.artifactRevision as number) < 0 ||
    typeof checkpoint.updatedAt !== 'string'
  ) {
    throw new TypeError('短剧检查点记录的基础字段无效');
  }
  if (
    checkpoint.episodeNumber !== undefined &&
    (!Number.isInteger(checkpoint.episodeNumber) || (checkpoint.episodeNumber as number) < 1)
  ) {
    throw new TypeError('短剧检查点 episodeNumber 无效');
  }
  if (
    checkpoint.chunkStart !== undefined &&
    (!Number.isInteger(checkpoint.chunkStart) || (checkpoint.chunkStart as number) < 1)
  ) {
    throw new TypeError('短剧检查点 chunkStart 无效');
  }
  return checkpoint as DecodedCheckpointBase;
}

function isScriptCheckpointNode(value: unknown): value is ScriptCheckpointNode {
  return SCRIPT_CHECKPOINT_NODES.includes(value as ScriptCheckpointNode);
}

function isScriptNodeStatus(value: unknown): value is ScriptNodeStatus {
  return SCRIPT_NODE_STATUSES.includes(value as ScriptNodeStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInputRevisionRefs(value: unknown): value is ScriptInputRevisionRef[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) &&
    ['plan', 'outline', 'characters', 'world', 'episode', 'continuity'].includes(
      String(item.resource),
    ) &&
    typeof item.id === 'string' &&
    Number.isInteger(item.revision) &&
    (item.revision as number) >= 0,
  );
}

function isUpstreamArtifactRefs(value: unknown): value is ScriptUpstreamArtifactRef[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) &&
    typeof item.node === 'string' &&
    item.node.length > 0 &&
    Number.isInteger(item.artifactRevision) &&
    (item.artifactRevision as number) >= 0 &&
    typeof item.artifactHash === 'string' &&
    item.artifactHash.length > 0,
  );
}

function isValidationErrors(value: unknown): value is ScriptCheckpointValidationError[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) &&
    (item.path === undefined || typeof item.path === 'string') &&
    typeof item.code === 'string' &&
    item.code.length > 0 &&
    typeof item.message === 'string' &&
    item.message.length > 0,
  );
}
