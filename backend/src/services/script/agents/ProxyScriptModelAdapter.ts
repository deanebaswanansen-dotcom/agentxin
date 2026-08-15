import { createHash } from 'node:crypto';

import type { ChatMessage, ModelConfig } from '../../../types/index.js';
import type { ModelProxy, StreamCompletionOptions } from '../../../proxy/ModelProxy.js';
import { ServiceError } from '../../ServiceError.js';
import type { ScriptModelAdapter, ScriptModelRequest } from './ScriptDirector.js';
import { ScriptModelOutputError } from './structuredOutput.js';

interface ScriptModelConfigProvider {
  getInternalConfig(): Promise<ModelConfig | undefined>;
}

const NODE_OUTPUT_BUDGET: Record<ScriptModelRequest['node'], number> = {
  plan: 6_000,
  series_outline: 12_000,
  character_bible: 8_000,
  world_bible: 6_000,
  episode_outline: 8_000,
  scene_plan: 5_000,
  draft: 16_000,
  review: 6_000,
  revision: 12_000,
};

function temperatureForNode(node: ScriptModelRequest['node']): number {
  return node === 'draft' || node === 'revision' ? 0.6 : 0.2;
}

/** Bridges the short-drama director to the existing request-scoped BYOK proxy. */
export class ProxyScriptModelAdapter implements ScriptModelAdapter {
  constructor(
    private readonly modelConfig: ScriptModelConfigProvider,
    private readonly proxy: ModelProxy,
  ) {}

  async getStructuredFallbackModelName(): Promise<string | undefined> {
    const config = await this.modelConfig.getInternalConfig();
    return config?.structuredFallbackModelName?.trim() || undefined;
  }

  async getModelConfigFingerprint(): Promise<string> {
    const config = await this.modelConfig.getInternalConfig();
    if (!config) {
      throw ServiceError.modelNotConfigured('尚未配置模型，请先在模型设置中保存 API 配置。');
    }
    const safeConfig = {
      baseUrl: config.baseUrl.trim().replace(/\/+$/u, ''),
      modelName: config.modelName.trim(),
      structuredFallbackModelName: config.structuredFallbackModelName?.trim() || '',
    };
    return createHash('sha256')
      .update(JSON.stringify(safeConfig), 'utf8')
      .digest('hex');
  }

  async complete(request: ScriptModelRequest): Promise<string> {
    const config = await this.modelConfig.getInternalConfig();
    if (!config) {
      throw ServiceError.modelNotConfigured('尚未配置模型，请先在模型设置中保存 API 配置。');
    }
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: '你是 AgentXin 短剧生产 Agent。严格遵守用户已确认的约束，只输出调用节点要求的结构化结果。',
      },
      { role: 'user', content: request.prompt },
    ];
    const options: StreamCompletionOptions = {
      jsonMode: true,
      disableThinking: true,
      maxTokens: NODE_OUTPUT_BUDGET[request.node],
      temperature: temperatureForNode(request.node),
    };
    const chunks: string[] = [];
    const signal = request.signal ?? new AbortController().signal;
    const effectiveConfig = request.modelNameOverride
      ? { ...config, modelName: request.modelNameOverride }
      : config;
    for await (const delta of this.proxy.streamCompletion(effectiveConfig, messages, signal, options)) {
      if (delta.kind === 'content' && delta.text) chunks.push(delta.text);
    }
    const content = chunks.join('').trim();
    if (!content) {
      throw new ScriptModelOutputError(`短剧 ${request.node} 节点未返回有效内容。`);
    }
    return content;
  }
}
