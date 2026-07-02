import type { ChatMessage, ModelConfig } from '../types/index.js';
import { OpenAiCompatibleModelProxy } from '../proxy/ModelProxy.js';
import type { ModelProxy } from '../proxy/ModelProxy.js';
import { ProxyError } from '../proxy/ProxyError.js';
import type { LlmRuntimeConfig } from '../config/env.js';

export interface LlmProvider {
  generate(messages: ChatMessage[], options?: { jsonMode?: boolean }): Promise<string>;
  ping(): Promise<{ ok: boolean; provider: string; modelName: string; message: string }>;
}

export function createLlmProvider(config: LlmRuntimeConfig): LlmProvider {
  if (config.provider === 'mock') {
    return new MockLlmProvider(config);
  }
  return new OpenAiCompatibleProvider(config, new OpenAiCompatibleModelProxy());
}

export class MockLlmProvider implements LlmProvider {
  constructor(private readonly config: LlmRuntimeConfig) {}

  async generate(messages: ChatMessage[], options?: { jsonMode?: boolean }): Promise<string> {
    const last = messages.at(-1)?.content ?? '';
    if (options?.jsonMode === true) {
      return JSON.stringify({
        title: 'Mock Novel Plan',
        chapters: [
          { number: 1, title: '第一章：开端', goal: '建立主角目标与核心冲突' },
          { number: 2, title: '第二章：试炼', goal: '推进阻碍并揭示代价' },
          { number: 3, title: '第三章：转折', goal: '形成下一阶段钩子' },
        ],
      });
    }
    return [
      'MOCK_OUTPUT',
      `MODEL=${this.config.modelName || 'mock-model'}`,
      normalizeForMock(last),
    ].join('\n');
  }

  async ping(): Promise<{ ok: boolean; provider: string; modelName: string; message: string }> {
    return {
      ok: true,
      provider: 'mock',
      modelName: this.config.modelName || 'mock-model',
      message: 'mock provider ready',
    };
  }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly config: LlmRuntimeConfig,
    private readonly proxy: ModelProxy,
  ) {}

  async generate(messages: ChatMessage[], options?: { jsonMode?: boolean }): Promise<string> {
    const modelConfig = this.toModelConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const chunks: string[] = [];
    try {
      for await (const delta of this.proxy.streamCompletion(
        modelConfig,
        messages,
        controller.signal,
        options,
      )) {
        if (delta.kind === 'content') {
          chunks.push(delta.text);
        }
      }
      return chunks.join('');
    } finally {
      clearTimeout(timeout);
    }
  }

  async ping(): Promise<{ ok: boolean; provider: string; modelName: string; message: string }> {
    const text = await this.generate([
      { role: 'system', content: 'You are a provider health checker. Reply with exactly: pong' },
      { role: 'user', content: 'ping' },
    ]);
    return {
      ok: text.trim().length > 0,
      provider: 'openai-compatible',
      modelName: this.config.modelName,
      message: text.trim(),
    };
  }

  private toModelConfig(): ModelConfig {
    const missing = [
      ['LLM_BASE_URL', this.config.baseUrl],
      ['LLM_API_KEY', this.config.apiKey],
      ['LLM_MODEL', this.config.modelName],
    ].filter(([, value]) => value.length === 0);
    if (missing.length > 0) {
      throw new ProxyError(`缺少模型环境变量：${missing.map(([key]) => key).join(', ')}`);
    }
    return {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      modelName: this.config.modelName,
    };
  }
}

function normalizeForMock(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, 240);
}
