import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ModelConfig } from '../../../types/index.js';
import type { ModelProxy, StreamCompletionOptions } from '../../../proxy/ModelProxy.js';
import { ServiceError } from '../../ServiceError.js';
import { ProxyScriptModelAdapter } from './ProxyScriptModelAdapter.js';
import { ScriptModelOutputError } from './structuredOutput.js';

const config: ModelConfig = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  modelName: 'test-model',
};

describe('ProxyScriptModelAdapter', () => {
  it('uses the request-scoped model config, ignores thinking, and collects content in order', async () => {
    const calls: Array<{
      config: ModelConfig;
      messages: ChatMessage[];
      options?: StreamCompletionOptions;
    }> = [];
    const proxy: ModelProxy = {
      async *streamCompletion(receivedConfig, messages, _signal, options) {
        calls.push({ config: receivedConfig, messages, options });
        yield { kind: 'thinking', text: 'hidden' };
        yield { kind: 'content', text: '{"title":' };
        yield { kind: 'content', text: '"短剧"}' };
      },
    };
    const adapter = new ProxyScriptModelAdapter(
      { getInternalConfig: vi.fn().mockResolvedValue(config) },
      proxy,
    );

    await expect(adapter.complete({
      node: 'plan',
      projectId: 'project-1',
      prompt: '生成策划',
    })).resolves.toBe('{"title":"短剧"}');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.config).toBe(config);
    expect(calls[0]?.messages.at(-1)?.content).toBe('生成策划');
    expect(calls[0]?.options).toMatchObject({
      jsonMode: true,
      disableThinking: true,
      temperature: 0.2,
    });

    await adapter.complete({
      node: 'draft',
      projectId: 'project-1',
      prompt: '生成正文',
    });
    expect(calls[1]?.options?.temperature).toBe(0.6);

    await adapter.complete({
      node: 'draft',
      projectId: 'project-1',
      prompt: '直接写剧本',
      responseFormat: 'text',
    });
    expect(calls[2]?.options).toMatchObject({ jsonMode: false, disableThinking: true });
    expect(calls[2]?.messages[0]?.content).toContain('短剧编剧');
  });

  it('rejects missing configuration and empty visible output', async () => {
    const unusedProxy = { streamCompletion: vi.fn() } as unknown as ModelProxy;
    const missing = new ProxyScriptModelAdapter(
      { getInternalConfig: vi.fn().mockResolvedValue(undefined) },
      unusedProxy,
    );
    await expect(missing.complete({ node: 'plan', projectId: 'p', prompt: 'x' }))
      .rejects.toBeInstanceOf(ServiceError);

    const emptyProxy: ModelProxy = {
      async *streamCompletion() {
        yield { kind: 'thinking', text: 'only hidden reasoning' };
      },
    };
    const empty = new ProxyScriptModelAdapter(
      { getInternalConfig: vi.fn().mockResolvedValue(config) },
      emptyProxy,
    );
    await expect(empty.complete({ node: 'draft', projectId: 'p', prompt: 'x' }))
      .rejects.toBeInstanceOf(ScriptModelOutputError);
  });

  it('exposes the configured structured fallback and overrides only the model name', async () => {
    const fallbackConfig = { ...config, structuredFallbackModelName: 'repair-model' };
    const received: ModelConfig[] = [];
    const proxy: ModelProxy = {
      async *streamCompletion(modelConfig) {
        received.push(modelConfig);
        yield { kind: 'content', text: '{}' };
      },
    };
    const adapter = new ProxyScriptModelAdapter(
      { getInternalConfig: vi.fn().mockResolvedValue(fallbackConfig) },
      proxy,
    );

    await expect(adapter.getStructuredFallbackModelName()).resolves.toBe('repair-model');
    await adapter.complete({
      node: 'review',
      projectId: 'project-1',
      prompt: '修复结构',
      modelNameOverride: 'repair-model',
    });

    expect(received[0]).toEqual({ ...fallbackConfig, modelName: 'repair-model' });
    expect(received[0]?.baseUrl).toBe(config.baseUrl);
    expect(received[0]?.apiKey).toBe(config.apiKey);
  });

  it('fingerprints only canonical non-secret model routing fields', async () => {
    const first = new ProxyScriptModelAdapter(
      { getInternalConfig: vi.fn().mockResolvedValue({
        ...config,
        apiKey: 'secret-a',
        baseUrl: 'https://example.test/v1/',
        structuredFallbackModelName: 'repair-model',
      }) },
      { streamCompletion: vi.fn() } as unknown as ModelProxy,
    );
    const rotatedKey = new ProxyScriptModelAdapter(
      { getInternalConfig: vi.fn().mockResolvedValue({
        ...config,
        apiKey: 'secret-b',
        structuredFallbackModelName: 'repair-model',
      }) },
      { streamCompletion: vi.fn() } as unknown as ModelProxy,
    );
    const changedModel = new ProxyScriptModelAdapter(
      { getInternalConfig: vi.fn().mockResolvedValue({
        ...config,
        apiKey: 'secret-a',
        modelName: 'another-model',
        structuredFallbackModelName: 'repair-model',
      }) },
      { streamCompletion: vi.fn() } as unknown as ModelProxy,
    );

    const fingerprint = await first.getModelConfigFingerprint();
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(rotatedKey.getModelConfigFingerprint()).resolves.toBe(fingerprint);
    await expect(changedModel.getModelConfigFingerprint()).resolves.not.toBe(fingerprint);
    expect(fingerprint).not.toContain('secret-a');
  });
});
