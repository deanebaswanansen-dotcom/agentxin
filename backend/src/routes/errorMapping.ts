/**
 * Shared error-mapping helpers for the Fastify transport layer (design:
 * "Error Handling"). Converts a thrown domain/storage/provider error — or any
 * unknown value — into the unified {@link ApiError} response shape plus the
 * HTTP status code it should be returned with.
 *
 * This module is intentionally generic so every route group (projects,
 * chapters, settings, model-config, writing) maps errors consistently:
 *
 * | error / code            | HTTP | 场景                         |
 * |-------------------------|------|------------------------------|
 * | `VALIDATION_ERROR`      | 400  | 空字段 / 非法请求体          |
 * | `NOT_FOUND`             | 404  | 标识符不存在                 |
 * | `MODEL_NOT_CONFIGURED`  | 409  | 未配置模型即写作             |
 * | `PROVIDER_ERROR`        | 502  | 提供商错误 / 超时            |
 * | `STORE_ERROR`           | 500  | 数据存储读写失败             |
 * | unknown                 | 500  | 兜底（未预期错误）           |
 *
 * - {@link ServiceError} carries an explicit {@link ErrorCode} and is mapped
 *   via that code.
 * - {@link StoreError} → `STORE_ERROR` (500).
 * - {@link ProxyError} → `PROVIDER_ERROR` (502).
 * - Anything else → `STORE_ERROR` (500) with a generic, key-free message.
 *
 * SECURITY: messages forwarded here are user-facing. Domain/proxy errors build
 * controlled messages that never contain secrets; for unknown errors we fall
 * back to a generic message rather than leaking internal detail.
 */
import { isProxyError } from '../proxy/ProxyError.js';
import { isServiceError } from '../services/ServiceError.js';
import { isStoreError } from '../store/StoreError.js';
import type { ApiError, ErrorCode } from '../types/index.js';
import { ERROR_CODES } from '../types/index.js';

/** Map a unified {@link ErrorCode} to its HTTP status code. */
export function errorCodeToStatus(code: ErrorCode): number {
  switch (code) {
    case ERROR_CODES.VALIDATION_ERROR:
      return 400;
    case ERROR_CODES.NOT_FOUND:
      return 404;
    case ERROR_CODES.CONFLICT:
      return 409;
    case ERROR_CODES.MODEL_NOT_CONFIGURED:
      return 409;
    case ERROR_CODES.PROVIDER_ERROR:
      return 502;
    case ERROR_CODES.STORE_ERROR:
      return 500;
    default:
      return 500;
  }
}

/** The HTTP status + unified {@link ApiError} body a caught error maps to. */
export interface MappedError {
  status: number;
  body: ApiError;
}

/**
 * Convert any caught value into a {@link MappedError} (HTTP status + unified
 * {@link ApiError} body). Routes use this in their catch blocks:
 *
 * ```ts
 * } catch (err) {
 *   const { status, body } = toErrorResponse(err);
 *   return reply.code(status).send(body);
 * }
 * ```
 */
export function toErrorResponse(error: unknown): MappedError {
  if (isServiceError(error)) {
    const body = error.toApiError();
    return { status: errorCodeToStatus(body.error.code), body };
  }

  if (isStoreError(error)) {
    return {
      status: errorCodeToStatus(ERROR_CODES.STORE_ERROR),
      body: { error: { code: ERROR_CODES.STORE_ERROR, message: error.message } },
    };
  }

  if (isProxyError(error)) {
    return {
      status: errorCodeToStatus(ERROR_CODES.PROVIDER_ERROR),
      body: { error: { code: ERROR_CODES.PROVIDER_ERROR, message: error.message } },
    };
  }

  // Unknown / unexpected failure: do not leak internal detail.
  return {
    status: errorCodeToStatus(ERROR_CODES.STORE_ERROR),
    body: { error: { code: ERROR_CODES.STORE_ERROR, message: '服务器内部错误。' } },
  };
}
