export type ScriptServiceErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND';

/**
 * Transport-safe error shared by the script service and the canonical input
 * decoders. Keeping this type outside ScriptService avoids a decoder/service
 * import cycle while preserving the public ScriptService export.
 */
export class ScriptServiceError extends Error {
  constructor(
    readonly code: ScriptServiceErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ScriptServiceError';
    Object.setPrototypeOf(this, ScriptServiceError.prototype);
  }

  static validation(message: string, details?: unknown): ScriptServiceError {
    return new ScriptServiceError('VALIDATION_ERROR', message, details);
  }

  static notFound(message: string): ScriptServiceError {
    return new ScriptServiceError('NOT_FOUND', message);
  }
}
