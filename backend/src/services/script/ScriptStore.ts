import { createHash } from 'node:crypto';

import type {
  ScriptCharacter,
  ScriptCommitEpisodeWithContinuityInput,
  ScriptCommitEpisodeWithContinuityResult,
  ScriptContinuityState,
  ScriptEpisode,
  ScriptEpisodeInput,
  ScriptEpisodeOutline,
  ScriptPlan,
  ScriptProjectState,
  ScriptReviewIssue,
  ScriptReviewIssueCollection,
  ScriptReviewSource,
  ScriptSeriesOutline,
  ScriptWorldBible,
} from './domain.js';

export interface ScriptStore {
  getProjectState(projectId: string): Promise<ScriptProjectState | undefined>;
  savePlan(plan: ScriptPlan, expectedRevision?: number): Promise<ScriptPlan>;
  saveCharacters(
    projectId: string,
    items: ScriptCharacter[],
    expectedRevision?: number,
  ): Promise<ScriptCharacter[]>;
  saveWorldBible(
    value: ScriptWorldBible,
    expectedRevision?: number,
  ): Promise<ScriptWorldBible>;
  saveSeriesOutline(
    value: ScriptSeriesOutline,
    expectedRevision?: number,
  ): Promise<ScriptSeriesOutline>;
  saveEpisodeOutline(
    value: ScriptEpisodeOutline,
    expectedRevision?: number,
  ): Promise<ScriptEpisodeOutline>;
  saveEpisode(
    value: ScriptEpisode,
    expectedRevision?: number,
  ): Promise<ScriptEpisode>;
  commitEpisodeWithContinuity?(
    input: ScriptCommitEpisodeWithContinuityInput,
  ): Promise<ScriptCommitEpisodeWithContinuityResult>;
  saveContinuity(
    projectId: string,
    value: ScriptContinuityState,
  ): Promise<ScriptContinuityState>;
  saveReviewIssues(
    projectId: string,
    items: ScriptReviewIssue[],
    expectedRevision?: number,
  ): Promise<ScriptReviewIssueCollection>;
  replaceEpisodeReviewIssues(
    projectId: string,
    episodeNumber: number,
    sources: readonly ScriptReviewSource[],
    items: ScriptReviewIssue[],
    expectedRevision?: number,
  ): Promise<ScriptReviewIssueCollection>;
  deleteProject(projectId: string): Promise<void>;
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

/** Hash only candidate-controlled EpisodeInput fields, not store metadata. */
export function computeScriptEpisodeCandidateHash(
  episode: ScriptEpisode | ScriptEpisodeInput,
): string {
  const candidate = { ...(episode as unknown as Record<string, unknown>) };
  delete candidate.projectId;
  delete candidate.revision;
  delete candidate.createdAt;
  delete candidate.updatedAt;
  return canonicalHash(candidate);
}

/** Canonical fingerprint shared by candidate creation and the atomic commit. */
export function computeScriptInputFingerprint(input: Pick<
  ScriptCommitEpisodeWithContinuityInput,
  | 'inputRevisionRefs'
  | 'upstreamArtifactRefs'
  | 'promptVersion'
  | 'modelConfigFingerprint'
  | 'candidateHash'
>): string {
  const inputRevisionRefs = [...input.inputRevisionRefs].sort((left, right) =>
    left.resource.localeCompare(right.resource) ||
    left.id.localeCompare(right.id) ||
    left.revision - right.revision,
  );
  const upstreamArtifactRefs = [...input.upstreamArtifactRefs].sort((left, right) =>
    left.node.localeCompare(right.node) ||
    left.artifactRevision - right.artifactRevision ||
    left.artifactHash.localeCompare(right.artifactHash),
  );
  return canonicalHash({
    inputRevisionRefs,
    upstreamArtifactRefs,
    promptVersion: input.promptVersion,
    modelConfigFingerprint: input.modelConfigFingerprint,
    candidateHash: input.candidateHash,
  });
}

export class ScriptConflictError extends Error {
  readonly code = 'CONFLICT' as const;

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super('数据已被更新，请刷新后重试。');
    this.name = 'ScriptConflictError';
    Object.setPrototypeOf(this, ScriptConflictError.prototype);
  }
}

/** A stale or replaced candidate is a CAS conflict, not a storage failure. */
export class ScriptCommitConflictError extends ScriptConflictError {
  constructor(message: string) {
    super(0, 0);
    this.message = message;
    this.name = 'ScriptCommitConflictError';
    Object.setPrototypeOf(this, ScriptCommitConflictError.prototype);
  }
}

export function assertExpectedRevision(
  expectedRevision: number | undefined,
  actualRevision: number,
): void {
  if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
    throw new ScriptConflictError(expectedRevision, actualRevision);
  }
}
