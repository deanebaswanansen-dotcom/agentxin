/**
 * Domain-level error shared by all services in the领域层 (ProjectService,
 * ChapterService, SettingService, ModelConfigService, WritingService).
 *
 * A `ServiceError` represents a business-rule failure (validation, not-found,
 * model-not-configured, ...) as opposed to a storage I/O failure ({@link
 * import('../store/StoreError.js').StoreError}) or a provider failure
 * ({@link import('../proxy/ProxyError.js').ProxyError}). It carries one of the
 * unified {@link ErrorCode} values plus a user-facing `message`, which the
 * route/transport layer maps directly to the unified {@link ApiError} response
 * and HTTP status (design: "Error Handling").
 *
 * | code                  | HTTP | 场景                          |
 * |-----------------------|------|-------------------------------|
 * | `VALIDATION_ERROR`    | 400  | 空名称 / 空字段               |
 * | `NOT_FOUND`           | 404  | 标识符不存在                  |
 * | `MODEL_NOT_CONFIGURED`| 409  | 未配置模型即写作              |
 *
 * This class is intentionally generic so every service shares a single domain
 * error type rather than each defining its own.
 */
import type { ApiError, ErrorCode } from '../types/index.js';
import { ERROR_CODES } from '../types/index.js';

export class ServiceError extends Error {
  /**
   * The unified error code carried to the transport layer. Mirrors the
   * discriminator pattern used by `StoreError`/`ProxyError`, but is a field
   * (not a literal) because a `ServiceError` may represent any domain code.
   */
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ServiceError';
    this.code = code;
    // Restore the prototype chain for environments that down-level the
    // `extends Error` call (defensive; harmless under ES2022 targets).
    Object.setPrototypeOf(this, ServiceError.prototype);
  }

  /** Build a `VALIDATION_ERROR` (HTTP 400) domain error. */
  static validation(message: string): ServiceError {
    return new ServiceError(ERROR_CODES.VALIDATION_ERROR, message);
  }

  /** Build a `NOT_FOUND` (HTTP 404) domain error. */
  static notFound(message: string): ServiceError {
    return new ServiceError(ERROR_CODES.NOT_FOUND, message);
  }

  /** Build a `CONFLICT` (HTTP 409) domain error for optimistic revisions. */
  static conflict(message: string): ServiceError {
    return new ServiceError(ERROR_CODES.CONFLICT, message);
  }

  /** Build a `MODEL_NOT_CONFIGURED` (HTTP 409) domain error. */
  static modelNotConfigured(message: string): ServiceError {
    return new ServiceError(ERROR_CODES.MODEL_NOT_CONFIGURED, message);
  }

  /** Serialize to the unified {@link ApiError} response shape. */
  toApiError(): ApiError {
    return { error: { code: this.code, message: this.message } };
  }
}

/**
 * Type guard for {@link ServiceError}. Useful in the transport layer when
 * narrowing a caught `unknown` value before mapping it to an HTTP response.
 */
export function isServiceError(value: unknown): value is ServiceError {
  return value instanceof ServiceError;
}
