/**
 * Route integration tests for {@link registerModelConfigRoutes} (task 11.6
 * coverage for the model-config group). These fill a gap: the model-config
 * routes had no `app.inject` coverage before.
 *
 * Setup uses a real {@link FileDataStore} over a unique temp file (no mocks)
 * backing a real {@link ModelConfigService}, so the routes are exercised
 * end-to-end through the domain + persistence layers.
 *
 * Covered (Requirements 4.1–4.4 + security 4.2/5.6):
 *   - PUT  /api/model-config → 200 with the MASKED view; the raw apiKey is
 *     NEVER present anywhere in the response body (security).
 *   - PUT  with an empty/whitespace field → 400 VALIDATION_ERROR.
 *   - GET  /api/model-config → 200 with the MASKED view after a save.
 *   - GET  when unset → 200 with the empty view ({ baseUrl:'', modelName:'',
 *     apiKeyMasked:'' }).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ModelConfigService } from '../services/modelConfig/ModelConfigService.js';
import { FileDataStore } from '../store/FileDataStore.js';
import type { ModelProxy } from '../proxy/ModelProxy.js';
import { ProxyError } from '../proxy/ProxyError.js';
import type { ModelConfig, ModelConfigView } from '../types/index.js';
import { registerModelConfigRoutes } from './modelConfigRoutes.js';

const VALID_CONFIG: ModelConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-secret-1234567890abcd',
  modelName: 'gpt-4o-mini',
};

let dir: string;
let store: FileDataStore;
let app: FastifyInstance;
let connectionError: Error | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-config-routes-'));
  store = await FileDataStore.create(join(dir, 'store.json'));
  connectionError = undefined;

  app = Fastify({ logger: false });
  const proxy: ModelProxy = {
    async *streamCompletion() {
      if (connectionError) throw connectionError;
      yield { kind: 'content', text: 'OK' };
    },
  };
  registerModelConfigRoutes(app, new ModelConfigService(store), proxy);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('PUT /api/model-config', () => {
  it('saves a valid config and returns 200 with the masked view (Req 4.1, 4.3)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/model-config',
      payload: VALID_CONFIG,
    });
    expect(res.statusCode).toBe(200);
    const view = res.json<ModelConfigView>();
    expect(view.baseUrl).toBe(VALID_CONFIG.baseUrl);
    expect(view.modelName).toBe(VALID_CONFIG.modelName);
    expect(view.apiKeyMasked).toBeTruthy();
    expect(view.temperature).toBe(1);
    expect(view.topP).toBe(1);
  });

  it('saves temperature and Top-P sampling params', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/model-config',
      payload: { ...VALID_CONFIG, temperature: 0.7, topP: 0.8 },
    });
    expect(res.statusCode).toBe(200);
    const view = res.json<ModelConfigView>();
    expect(view.temperature).toBe(0.7);
    expect(view.topP).toBe(0.8);
  });

  it('never includes the raw apiKey in the response body (security, Req 4.2/5.6)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/model-config',
      payload: VALID_CONFIG,
    });
    expect(res.statusCode).toBe(200);
    // Raw key must not appear anywhere in the serialized response.
    expect(res.body).not.toContain(VALID_CONFIG.apiKey);
    const view = res.json<ModelConfigView>();
    expect(view.apiKeyMasked).not.toContain(VALID_CONFIG.apiKey);
    expect((view as unknown as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('persists the config so a later GET reflects it', async () => {
    await app.inject({ method: 'PUT', url: '/api/model-config', payload: VALID_CONFIG });
    const get = await app.inject({ method: 'GET', url: '/api/model-config' });
    const view = get.json<ModelConfigView>();
    expect(view.baseUrl).toBe(VALID_CONFIG.baseUrl);
    expect(view.modelName).toBe(VALID_CONFIG.modelName);
  });

  it.each<[string, ModelConfig]>([
    ['empty baseUrl', { ...VALID_CONFIG, baseUrl: '' }],
    ['whitespace baseUrl', { ...VALID_CONFIG, baseUrl: '   ' }],
    ['empty apiKey', { ...VALID_CONFIG, apiKey: '' }],
    ['empty modelName', { ...VALID_CONFIG, modelName: '' }],
    ['invalid temperature', { ...VALID_CONFIG, temperature: 2.1 }],
    ['invalid topP', { ...VALID_CONFIG, topP: 1.1 }],
  ])('rejects %s with 400 VALIDATION_ERROR (Req 4.4)', async (_label, config) => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/model-config',
      payload: config,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('treats a missing body field as empty → 400 VALIDATION_ERROR (Req 4.4)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/model-config',
      payload: { baseUrl: VALID_CONFIG.baseUrl, modelName: VALID_CONFIG.modelName },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('leaves an existing config unchanged when a new save is rejected (Req 4.4)', async () => {
    await app.inject({ method: 'PUT', url: '/api/model-config', payload: VALID_CONFIG });
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/model-config',
      payload: { ...VALID_CONFIG, apiKey: '   ' },
    });
    expect(rejected.statusCode).toBe(400);

    const get = await app.inject({ method: 'GET', url: '/api/model-config' });
    const view = get.json<ModelConfigView>();
    expect(view.baseUrl).toBe(VALID_CONFIG.baseUrl);
    expect(view.modelName).toBe(VALID_CONFIG.modelName);
  });
});

describe('GET /api/model-config', () => {
  it('returns 200 with the empty view when no config is saved (Req 4.2)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json<ModelConfigView>()).toEqual({
      baseUrl: '',
      modelName: '',
      apiKeyMasked: '',
      temperature: 1,
      topP: 1,
    });
  });

  it('returns the masked view after a save without leaking the raw key (Req 4.2/5.6)', async () => {
    await app.inject({ method: 'PUT', url: '/api/model-config', payload: VALID_CONFIG });

    const res = await app.inject({ method: 'GET', url: '/api/model-config' });
    expect(res.statusCode).toBe(200);
    const view = res.json<ModelConfigView>();
    expect(view.baseUrl).toBe(VALID_CONFIG.baseUrl);
    expect(view.modelName).toBe(VALID_CONFIG.modelName);
    // The raw key must not appear in the body or the masked field.
    expect(res.body).not.toContain(VALID_CONFIG.apiKey);
    expect(view.apiKeyMasked).not.toContain(VALID_CONFIG.apiKey);
  });
});

describe('POST /api/model-config/test', () => {
  it('runs a real proxy probe with the active config', async () => {
    await app.inject({ method: 'PUT', url: '/api/model-config', payload: VALID_CONFIG });
    const res = await app.inject({ method: 'POST', url: '/api/model-config/test' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, modelName: VALID_CONFIG.modelName, receivedOutput: true });
    expect(res.body).not.toContain(VALID_CONFIG.apiKey);
  });

  it('returns MODEL_NOT_CONFIGURED before any config is supplied', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/model-config/test' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MODEL_NOT_CONFIGURED');
  });

  it('returns a sanitized provider error instead of an unexplained 502', async () => {
    await app.inject({ method: 'PUT', url: '/api/model-config', payload: VALID_CONFIG });
    connectionError = new ProxyError('API Key 无效');
    const res = await app.inject({ method: 'POST', url: '/api/model-config/test' });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('API Key 无效');
    expect(res.body).not.toContain(VALID_CONFIG.apiKey);
  });
});
