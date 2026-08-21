/**
 * Example/edge-case unit tests for {@link ModelConfigService} (task 6.1).
 *
 * These complement the property tests in tasks 6.2–6.4. They use a minimal
 * in-memory fake {@link DataStore} (singleton model-config surface only) so the
 * service's business rules — non-empty validation, masking, and the
 * internal/external read split — are exercised in isolation from the file
 * persistence layer.
 */
import { describe, expect, it } from 'vitest';

import type { DataStore } from '../../store/DataStore.js';
import type { ModelConfig } from '../../types/index.js';
import { isServiceError } from '../ServiceError.js';
import { ModelConfigService, maskApiKey } from './ModelConfigService.js';

/** Minimal in-memory store covering only the model-config surface used here. */
function makeFakeStore(): DataStore {
  let config: ModelConfig | undefined;
  const fake: Partial<DataStore> = {
    async saveModelConfig(next: ModelConfig): Promise<void> {
      config = { ...next };
    },
    async getModelConfig(): Promise<ModelConfig | undefined> {
      return config ? { ...config } : undefined;
    },
  };
  return fake as DataStore;
}

const validConfig: ModelConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-1234567890abcd',
  modelName: 'gpt-4o-mini',
};

describe('ModelConfigService.save', () => {
  it('persists a valid config and returns the masked view (Req 4.1, 4.3)', async () => {
    const store = makeFakeStore();
    const service = new ModelConfigService(store);

    const view = await service.save(validConfig);

    expect(view.baseUrl).toBe(validConfig.baseUrl);
    expect(view.modelName).toBe(validConfig.modelName);
    expect(view.temperature).toBe(1);
    expect(view.topP).toBe(1);
    // Masked view never contains the raw key (Req 4.2, 5.6 / Property 15).
    expect(view.apiKeyMasked).not.toContain(validConfig.apiKey);
    // Internal read-back round-trips exactly (Property 14).
    expect(await service.getInternalConfig()).toEqual(validConfig);
  });

  it('does not write API keys when stored config is disabled', async () => {
    const store = makeFakeStore();
    const service = new ModelConfigService(store, { allowStoredConfig: false });
    const view = await service.save(validConfig);
    expect(view.apiKeyMasked).toBeTruthy();
    expect(await store.getModelConfig()).toBeUndefined();
    expect(await service.getInternalConfig()).toBeUndefined();
  });

  it('persists fields verbatim without trimming', async () => {
    const service = new ModelConfigService(makeFakeStore());
    const padded: ModelConfig = {
      baseUrl: ' https://x/v1 ',
      apiKey: ' sk-padded-key ',
      modelName: ' my-model ',
    };
    await service.save(padded);
    expect(await service.getInternalConfig()).toEqual(padded);
  });

  it.each<[string, ModelConfig]>([
    ['empty baseUrl', { ...validConfig, baseUrl: '' }],
    ['whitespace baseUrl', { ...validConfig, baseUrl: '   ' }],
    ['empty apiKey', { ...validConfig, apiKey: '' }],
    ['whitespace apiKey', { ...validConfig, apiKey: '\t\n' }],
    ['empty modelName', { ...validConfig, modelName: '' }],
    ['whitespace modelName', { ...validConfig, modelName: '\u00A0' }],
    ['temperature below range', { ...validConfig, temperature: -0.01 }],
    ['temperature above range', { ...validConfig, temperature: 2.01 }],
    ['topP below range', { ...validConfig, topP: -0.01 }],
    ['topP above range', { ...validConfig, topP: 1.01 }],
  ])('rejects %s with VALIDATION_ERROR (Req 4.4)', async (_label, config) => {
    const service = new ModelConfigService(makeFakeStore());
    await expect(service.save(config)).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
    );
  });

  it('leaves an existing config unchanged when a new save is rejected (Req 4.4 / Property 16)', async () => {
    const service = new ModelConfigService(makeFakeStore());
    await service.save(validConfig);

    await expect(
      service.save({ ...validConfig, apiKey: '   ' }),
    ).rejects.toSatisfy((e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR');

    // Previously stored config is intact.
    expect(await service.getInternalConfig()).toEqual(validConfig);
  });
});

describe('ModelConfigService.getView', () => {
  it('returns an empty view when no config is saved', async () => {
    const service = new ModelConfigService(makeFakeStore());
    expect(await service.getView()).toEqual({
      baseUrl: '',
      modelName: '',
      apiKeyMasked: '',
      temperature: 1,
      topP: 1,
    });
  });

  it('returns an empty view when stored config is disabled even if disk has leftovers', async () => {
    const store = makeFakeStore();
    await store.saveModelConfig(validConfig);
    const service = new ModelConfigService(store, { allowStoredConfig: false });
    expect(await service.getView()).toEqual({
      baseUrl: '',
      modelName: '',
      apiKeyMasked: '',
      temperature: 1,
      topP: 1,
    });
    expect(await service.getInternalConfig()).toBeUndefined();
  });

  it('returns baseUrl + modelName in the clear and a masked key (Req 4.2)', async () => {
    const service = new ModelConfigService(makeFakeStore());
    await service.save(validConfig);

    const view = await service.getView();
    expect(view.baseUrl).toBe(validConfig.baseUrl);
    expect(view.modelName).toBe(validConfig.modelName);
    expect(view.temperature).toBe(1);
    expect(view.topP).toBe(1);
    expect(view.apiKeyMasked).not.toContain(validConfig.apiKey);
    // Full serialized view must not leak the raw key (Property 15).
    expect(JSON.stringify(view)).not.toContain(validConfig.apiKey);
  });
});

describe('ModelConfigService sampling params', () => {
  it('persists and exposes temperature/topP when provided', async () => {
    const service = new ModelConfigService(makeFakeStore());
    const config: ModelConfig = { ...validConfig, temperature: 0.65, topP: 0.75 };
    const view = await service.save(config);

    expect(view.temperature).toBe(0.65);
    expect(view.topP).toBe(0.75);
    expect(await service.getInternalConfig()).toEqual(config);
  });
});

describe('ModelConfigService.getInternalConfig', () => {
  it('returns undefined when no config is saved (Req 4.5)', async () => {
    const service = new ModelConfigService(makeFakeStore());
    expect(await service.getInternalConfig()).toBeUndefined();
  });

  it('returns the full config including the raw apiKey (Req 4.5)', async () => {
    const service = new ModelConfigService(makeFakeStore());
    await service.save(validConfig);
    expect(await service.getInternalConfig()).toEqual(validConfig);
  });
});

describe('maskApiKey', () => {
  it('returns empty string for an empty key', () => {
    expect(maskApiKey('')).toBe('');
  });

  it.each(['*', '**', '****', '****abcd', 'a', 'ab', 'sk-1234567890abcd', '密钥🔑测试key'])(
    'never contains the raw key %j as a substring (Property 15)',
    (key) => {
      expect(maskApiKey(key)).not.toContain(key);
    },
  );

  it('reveals only a short suffix for a normal key', () => {
    expect(maskApiKey('sk-1234567890abcd')).toBe('****abcd');
  });
});
