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
});
