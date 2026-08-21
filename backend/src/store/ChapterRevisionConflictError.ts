/** Raised atomically by a store when a stale chapter write is rejected. */
export class ChapterRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`章节正文版本冲突：期望 ${expectedRevision}，当前 ${actualRevision}`);
    this.name = 'ChapterRevisionConflictError';
    Object.setPrototypeOf(this, ChapterRevisionConflictError.prototype);
  }
}
