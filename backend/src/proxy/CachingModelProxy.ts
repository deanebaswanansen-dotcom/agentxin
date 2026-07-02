/**
 * CachingModelProxy：在任意 {@link ModelProxy} 之上加一层「本地磁盘响应缓存」。
 *
 * 动机：原实现只有 DeepSeek 服务端 prompt-token 缓存（省的是输入 token），相同的整次
 * 请求仍会重新生成、重新计费。对小说 Agent 而言，重试、重跑、整本生成里的重复子调用
 * （如固定的世界观/人物子 prompt）非常常见——本层把「完全相同的请求」直接用磁盘上的
 * 历史完整响应满足，跳过模型调用。
 *
 * 行为约定：
 * - 缓存键 = sha256(modelName + 全部 messages + jsonMode)。任何输入变化都会换键，
 *   因此不会让本应「常写常新」的章节正文意外复用——只有逐字节相同的请求才命中。
 * - Mock 提供商（baseUrl='mock' 或 model='mock-model'）不缓存：它本就免费且本地。
 * - 仅在流式**完整正常结束**后才写缓存；被 AbortSignal 中止或出错时不写，避免缓存半截。
 * - 命中/未命中计入 {@link cacheStats}，在 /api/cache-stats 的 localCache 字段可见。
 * - 缓存读写失败一律降级为「不缓存、走真实调用」，绝不让缓存问题影响主流程。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChatMessage, ModelConfig } from '../types/index.js';
import { recordLocalCacheHit, recordLocalCacheMiss } from './cacheStats.js';
import type { ModelProxy, StreamCompletionOptions } from './ModelProxy.js';
import type { StreamDelta } from './sseParser.js';

/** 默认缓存目录（相对后端进程 cwd）。 */
export const DEFAULT_CACHE_DIR = 'data/llm-cache';

export interface CachingModelProxyOptions {
  /** 缓存目录，默认 {@link DEFAULT_CACHE_DIR}。 */
  dir?: string;
  /** 是否启用缓存；默认 true。设为 false 时本类等价于透传内层 proxy。 */
  enabled?: boolean;
  /** 命中后回放时的分片大小（字符）。默认 400，模拟流式输出体验。 */
  replayChunkSize?: number;
}

interface CacheEntry {
  model: string;
  at: string;
  content: string;
}

function isMockConfig(config: ModelConfig): boolean {
  return config.baseUrl.trim() === 'mock' || config.modelName.trim() === 'mock-model';
}

export class CachingModelProxy implements ModelProxy {
  private readonly inner: ModelProxy;
  private readonly dir: string;
  private readonly enabled: boolean;
  private readonly replayChunkSize: number;

  constructor(inner: ModelProxy, options: CachingModelProxyOptions = {}) {
    this.inner = inner;
    this.dir = resolve(options.dir ?? DEFAULT_CACHE_DIR);
    this.enabled = options.enabled ?? true;
    this.replayChunkSize = Math.max(1, options.replayChunkSize ?? 400);
  }

  streamCompletion(
    config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    options?: StreamCompletionOptions,
  ): AsyncIterable<StreamDelta> {
    return this.run(config, messages, signal, options);
  }

  private cacheKey(config: ModelConfig, messages: ChatMessage[], options?: StreamCompletionOptions): string {
    const payload = JSON.stringify({
      model: config.modelName,
      temperature: config.temperature ?? null,
      topP: config.topP ?? null,
      jsonMode: options?.jsonMode === true,
      messages,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  private pathFor(key: string): string {
    return resolve(this.dir, `${key}.json`);
  }

  private async readCache(key: string): Promise<CacheEntry | undefined> {
    try {
      const raw = await readFile(this.pathFor(key), 'utf8');
      const parsed = JSON.parse(raw) as Partial<CacheEntry>;
      if (typeof parsed.content === 'string' && parsed.content.length > 0) {
        return { model: parsed.model ?? '', at: parsed.at ?? '', content: parsed.content };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCache(key: string, entry: CacheEntry): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const tempPath = `${this.pathFor(key)}.tmp`;
      await writeFile(tempPath, JSON.stringify(entry), 'utf8');
      await rename(tempPath, this.pathFor(key));
    } catch {
      // 写缓存失败不影响主流程：静默降级。
    }
  }

  private async *run(
    config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    options?: StreamCompletionOptions,
  ): AsyncGenerator<StreamDelta> {
    // Mock 或禁用：直接透传，不参与缓存统计。
    if (!this.enabled || isMockConfig(config)) {
      yield* this.inner.streamCompletion(config, messages, signal, options);
      return;
    }

    const key = this.cacheKey(config, messages, options);
    const cached = await this.readCache(key);
    if (cached !== undefined) {
      recordLocalCacheHit();
      // 分片回放，保持与真实流式一致的消费体验。
      for (let i = 0; i < cached.content.length; i += this.replayChunkSize) {
        if (signal.aborted) return;
        yield { kind: 'content', text: cached.content.slice(i, i + this.replayChunkSize) };
      }
      return;
    }

    recordLocalCacheMiss();
    const contentChunks: string[] = [];
    for await (const delta of this.inner.streamCompletion(config, messages, signal, options)) {
      yield delta;
      if (delta.kind === 'content') {
        contentChunks.push(delta.text);
      }
    }
    // 仅在未被中止且产出非空时写缓存，避免缓存半截/空响应。
    if (!signal.aborted) {
      const content = contentChunks.join('');
      if (content.trim().length > 0) {
        await this.writeCache(key, {
          model: config.modelName,
          at: new Date().toISOString(),
          content,
        });
      }
    }
  }
}
