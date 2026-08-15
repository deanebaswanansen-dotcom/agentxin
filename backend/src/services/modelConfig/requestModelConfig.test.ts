import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { DataStore } from '../../store/DataStore.js';
import type { ModelConfig } from '../../types/index.js';
import { ModelConfigService } from './ModelConfigService.js';
import { getRequestModelConfig, registerRequestModelConfig } from './requestModelConfig.js';

describe('requestModelConfig', () => {
  it('exposes model config from the request header only inside the request scope', async () => {
    const app = Fastify();
    registerRequestModelConfig(app);
    app.get('/probe', async () => ({ config: getRequestModelConfig() ?? null }));

    const headerValue = encodeURIComponent(
      JSON.stringify({
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-live',
        modelName: 'novel-model',
        structuredFallbackModelName: 'novel-model-pro',
        temperature: 0.7,
        topP: 0.8,
      }),
    );

    const withHeader = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'X-Agentxin-Model-Config': headerValue },
    });
    expect(withHeader.json()).toEqual({
      config: {
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-live',
        modelName: 'novel-model',
        structuredFallbackModelName: 'novel-model-pro',
        temperature: 0.7,
        topP: 0.8,
      },
    });

    const withoutHeader = await app.inject({ method: 'GET', url: '/probe' });
    expect(withoutHeader.json()).toEqual({ config: null });

    await app.close();
  });

  it('falls back to stored config when the volatile header is absent', async () => {
    const stored: ModelConfig = {
      baseUrl: 'https://stored.example.com',
      apiKey: 'sk-stored',
      modelName: 'stored-model',
    };
    const store = {
      async getModelConfig() {
        return stored;
      },
      async saveModelConfig() {
        // not used by this test
      },
    } as unknown as DataStore;
    const service = new ModelConfigService(store);
    const app = Fastify();
    registerRequestModelConfig(app);
    app.get('/internal', async () => ({ config: (await service.getInternalConfig()) ?? null }));

    // No browser header → use server-persisted key (refresh-friendly).
    const withoutHeader = await app.inject({ method: 'GET', url: '/internal' });
    expect(withoutHeader.json()).toEqual({ config: stored });

    // Header still wins when present.
    const volatile = {
      baseUrl: 'https://volatile.example.com',
      apiKey: 'sk-volatile',
      modelName: 'volatile-model',
    };
    const withHeader = await app.inject({
      method: 'GET',
      url: '/internal',
      headers: { 'X-Agentxin-Model-Config': encodeURIComponent(JSON.stringify(volatile)) },
    });
    expect(withHeader.json()).toEqual({ config: volatile });

    await app.close();
  });
});
