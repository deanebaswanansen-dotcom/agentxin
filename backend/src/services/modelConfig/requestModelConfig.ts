import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ModelConfig } from '../../types/index.js';

const HEADER_NAME = 'x-agentxin-model-config';
const requestModelConfig = new AsyncLocalStorage<{ config: ModelConfig | undefined }>();

function parseHeader(value: string | string[] | undefined): ModelConfig | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<ModelConfig>;
    if (
      typeof parsed.baseUrl === 'string' &&
      typeof parsed.apiKey === 'string' &&
      typeof parsed.modelName === 'string'
    ) {
      return {
        baseUrl: parsed.baseUrl,
        apiKey: parsed.apiKey,
        modelName: parsed.modelName,
        temperature: typeof parsed.temperature === 'number' ? parsed.temperature : undefined,
        topP: typeof parsed.topP === 'number' ? parsed.topP : undefined,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function getRequestModelConfig(): ModelConfig | undefined {
  return requestModelConfig.getStore()?.config;
}

export function hasRequestModelConfigScope(): boolean {
  return requestModelConfig.getStore() !== undefined;
}

/** Restore a captured BYOK model configuration inside a detached background task. */
export function runWithRequestModelConfig<T>(
  config: ModelConfig | undefined,
  operation: () => T,
): T {
  return requestModelConfig.run({ config }, operation);
}

export function registerRequestModelConfig(app: FastifyInstance): void {
  app.addHook('onRequest', (request: FastifyRequest, _reply, done) => {
    requestModelConfig.run({ config: parseHeader(request.headers[HEADER_NAME]) }, done);
  });
}
