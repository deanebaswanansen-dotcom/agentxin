/**
 * Unit tests for the shared error-mapping helpers (task 11.6 / Requirement 7.4
 * and the design "Error Handling" table). These directly exercise
 * {@link errorCodeToStatus} and {@link toErrorResponse} so the code→status
 * mapping and the unknown-error fallback are covered independently of any
 * single route group.
 *
 * Mapping under test:
 *   VALIDATION_ERROR     → 400
 *   NOT_FOUND            → 404
 *   MODEL_NOT_CONFIGURED → 409
 *   PROVIDER_ERROR       → 502
 *   STORE_ERROR          → 500
 *   unknown / unexpected → 500 (with a generic, secret-free message)
 */
import { describe, expect, it } from 'vitest';

import { ProxyError } from '../proxy/ProxyError.js';
import { ServiceError } from '../services/ServiceError.js';
import { StoreError } from '../store/StoreError.js';
import type { ErrorCode } from '../types/index.js';
import { errorCodeToStatus, toErrorResponse } from './errorMapping.js';

describe('errorCodeToStatus', () => {
  it.each<[ErrorCode, number]>([
    ['VALIDATION_ERROR', 400],
    ['NOT_FOUND', 404],
    ['MODEL_NOT_CONFIGURED', 409],
    ['PROVIDER_ERROR', 502],
    ['STORE_ERROR', 500],
  ])('maps %s → %d', (code, status) => {
    expect(errorCodeToStatus(code)).toBe(status);
  });

  it('falls back to 500 for an unrecognized code', () => {
    expect(errorCodeToStatus('NOT_A_REAL_CODE' as ErrorCode)).toBe(500);
  });
});

describe('toErrorResponse', () => {
  it('maps a VALIDATION_ERROR ServiceError → 400 with its code/message', () => {
    const { status, body } = toErrorResponse(ServiceError.validation('字段为空'));
    expect(status).toBe(400);
    expect(body).toEqual({ error: { code: 'VALIDATION_ERROR', message: '字段为空' } });
  });

  it('maps a NOT_FOUND ServiceError → 404', () => {
    const { status, body } = toErrorResponse(ServiceError.notFound('缺失'));
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('maps a MODEL_NOT_CONFIGURED ServiceError → 409', () => {
    const { status, body } = toErrorResponse(
      ServiceError.modelNotConfigured('未配置模型'),
    );
    expect(status).toBe(409);
    expect(body.error.code).toBe('MODEL_NOT_CONFIGURED');
  });

  it('maps a StoreError → 500 STORE_ERROR preserving the message', () => {
    const { status, body } = toErrorResponse(new StoreError('写入失败'));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: 'STORE_ERROR', message: '写入失败' } });
  });

  it('maps a ProxyError → 502 PROVIDER_ERROR', () => {
    const { status, body } = toErrorResponse(
      new ProxyError('提供商返回错误状态。', { status: 502 }),
    );
    expect(status).toBe(502);
    expect(body.error.code).toBe('PROVIDER_ERROR');
    expect(body.error.message).toBe('提供商返回错误状态。');
  });

  it('maps an unknown error → 500 with a generic, detail-free message', () => {
    const { status, body } = toErrorResponse(new Error('内部栈信息泄露风险'));
    expect(status).toBe(500);
    expect(body.error.code).toBe('STORE_ERROR');
    // The unknown-error branch must not leak the original message.
    expect(body.error.message).not.toContain('内部栈信息泄露风险');
    expect(body.error.message).toBe('服务器内部错误。');
  });

  it('maps a non-Error thrown value → 500 fallback', () => {
    const { status, body } = toErrorResponse('a bare string');
    expect(status).toBe(500);
    expect(body.error.code).toBe('STORE_ERROR');
  });
});
