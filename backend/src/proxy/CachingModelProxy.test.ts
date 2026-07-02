import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CachingModelProxy } from './CachingModelProxy.js';
import type { ModelProxy, StreamCompletionOptions } from './ModelProxy.js';
import type { StreamDelta } from './sseParser.js';
import { getCacheStatsSummary, resetCacheStats } from './cacheStats.js';
import type { ChatMessage, ModelConfig } from '../types/index.js';

class CountingProxy implements ModelProxy {
  calls = 0;
  constructor(private readonly output: string) {}
  streamCompletion(
    _config: ModelConfig,
    _messages: ChatMessage[],
    _signal: AbortSignal,
    _options?: StreamCompletionOptions,
  ): AsyncIterable<StreamDelta> {
    this.calls += 1;
    const output = this.output;
    return (async function* () {
      yield { kind: 'content' as const, text: output };
    })();
  }
}

const realConfig: ModelConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  modelName: 'test-model',
};
const messages: ChatMessage[] = [{ role: 'user', content: '写一段开头' }];

async function collect(iter: AsyncIterable<StreamDelta>): Promise<string> {
  const chunks: string[] = [];
  for await (const d of iter) { if (d.kind === 'content') chunks.push(d.text); }
  return chunks.join('');
}

describe('CachingModelProxy', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llm-cache-'));
    resetCacheStats();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    resetCacheStats();
  });

  it('misses on first identical call then hits on the second (skips inner)', async () => {
    const inner = new CountingProxy('缓存正文');
    const proxy = new CachingModelProxy(inner, { dir });

    const first = await collect(proxy.streamCompletion(realConfig, messages, new AbortController().signal));
    expect(first).toBe('缓存正文');
    expect(inner.calls).toBe(1);

    const second = await collect(proxy.streamCompletion(realConfig, messages, new AbortController().signal));
    expect(second).toBe('缓存正文');
    expect(inner.calls).toBe(1); // 未再调用内层

    const stats = getCacheStatsSummary();
    expect(stats.localCache.misses).toBe(1);
    expect(stats.localCache.hits).toBe(1);
    expect(stats.localCache.hitRatePct).toBe(50);
  });

  it('uses a different cache key for different messages', async () => {
    const inner = new CountingProxy('X');
    const proxy = new CachingModelProxy(inner, { dir });
    await collect(proxy.streamCompletion(realConfig, messages, new AbortController().signal));
    await collect(
      proxy.streamCompletion(realConfig, [{ role: 'user', content: '不同的提示' }], new AbortController().signal),
    );
    expect(inner.calls).toBe(2);
    expect(getCacheStatsSummary().localCache.hits).toBe(0);
  });

  it('uses a different cache key for different sampling params', async () => {
    const inner = new CountingProxy('X');
    const proxy = new CachingModelProxy(inner, { dir });
    await collect(proxy.streamCompletion({ ...realConfig, temperature: 0.7 }, messages, new AbortController().signal));
    await collect(proxy.streamCompletion({ ...realConfig, temperature: 1.2 }, messages, new AbortController().signal));
    expect(inner.calls).toBe(2);
    expect(getCacheStatsSummary().localCache.hits).toBe(0);
  });

  it('does not cache mock provider', async () => {
    const inner = new CountingProxy('mock 输出');
    const proxy = new CachingModelProxy(inner, { dir });
    const mockConfig: ModelConfig = { baseUrl: 'mock', apiKey: 'x', modelName: 'mock-model' };
    await collect(proxy.streamCompletion(mockConfig, messages, new AbortController().signal));
    await collect(proxy.streamCompletion(mockConfig, messages, new AbortController().signal));
    expect(inner.calls).toBe(2); // 每次都透传
    const stats = getCacheStatsSummary();
    expect(stats.localCache.hits).toBe(0);
    expect(stats.localCache.misses).toBe(0);
  });

  it('does not write cache when aborted mid-stream', async () => {
    const controller = new AbortController();
    const slowInner: ModelProxy = {
      streamCompletion() {
        return (async function* () {
          yield { kind: 'content' as const, text: '片段1' };
          controller.abort();
          yield { kind: 'content' as const, text: '片段2' };
        })();
      },
    };
    const proxy = new CachingModelProxy(slowInner, { dir });
    await collect(proxy.streamCompletion(realConfig, messages, controller.signal));

    // 再次请求应仍为 miss（未缓存半截）
    const inner2 = new CountingProxy('完整正文');
    const proxy2 = new CachingModelProxy(inner2, { dir });
    const out = await collect(proxy2.streamCompletion(realConfig, messages, new AbortController().signal));
    expect(out).toBe('完整正文');
    expect(inner2.calls).toBe(1);
  });

  it('transparently passes through when disabled', async () => {
    const inner = new CountingProxy('Y');
    const proxy = new CachingModelProxy(inner, { dir, enabled: false });
    await collect(proxy.streamCompletion(realConfig, messages, new AbortController().signal));
    await collect(proxy.streamCompletion(realConfig, messages, new AbortController().signal));
    expect(inner.calls).toBe(2);
    expect(getCacheStatsSummary().localCache.lookups).toBe(0);
  });
});
