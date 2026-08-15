import type {
  ScriptCharacter,
  ScriptContinuityState,
  ScriptEpisode,
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

export function assertExpectedRevision(
  expectedRevision: number | undefined,
  actualRevision: number,
): void {
  if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
    throw new ScriptConflictError(expectedRevision, actualRevision);
  }
}
