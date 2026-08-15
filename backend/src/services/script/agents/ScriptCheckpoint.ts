import { createHash } from 'node:crypto';

import type {
  ScriptInputRevisionRef,
  ScriptUpstreamArtifactRef,
} from '../domain.js';

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
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex');
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
    this.items.set(key, structuredClone(normalized));
  }

  async deleteProject(projectId: string): Promise<void> {
    for (const [key, checkpoint] of this.items.entries()) {
      if (checkpoint.projectId === projectId) this.items.delete(key);
    }
  }
}

export function checkpointIdentity(checkpoint: Pick<
  ScriptPipelineCheckpoint,
  'projectId' | 'runKey' | 'node' | 'episodeNumber' | 'chunkStart'
>): string {
  return [
    checkpoint.projectId,
    checkpoint.runKey,
    checkpoint.node,
    checkpoint.episodeNumber ?? '',
    checkpoint.chunkStart ?? '',
  ].join(':');
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
