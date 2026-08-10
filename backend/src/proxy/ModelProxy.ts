/**
 * ModelProxy：OpenAI 兼容转发（design.md「ModelProxy：OpenAI 兼容转发」）。
 *
 * 该组件使用用户保存的 {@link ModelConfig} 将写作请求转发到任意 OpenAI 兼容
 * 提供商的 `/chat/completions` 接口，并以流式（SSE）方式逐段产出生成文本。
 *
 * 转发规则（Requirements 5.1, 5.2, 5.3, 5.5, 5.6）：
 * - 向 `${baseUrl}/chat/completions` 发起 POST；
 * - 请求头注入 `Authorization: Bearer ${apiKey}` 与 `Content-Type: application/json`；
 * - body 含 `model`、`messages`、`stream: true`；
 * - DeepSeek 官方 V4 模型自动附加 `thinking` / `reasoning_effort`；
 * - 解析提供商 SSE，抽取 `choices[0].delta.content` 增量并按序产出；
 * - 提供商返回非 2xx，或请求被 AbortSignal 中止/超时时，抛出 {@link ProxyError}。
 *
 * 安全（Requirement 5.6）：API Key 仅出现在服务端到提供商的请求头中。
 * 产出的增量、抛出的错误信息均不包含 API Key——本模块从不将 `config.apiKey`
 * 写入任何产出值或错误消息。
 */

import crypto from 'node:crypto';
import type { ChatMessage, ModelConfig } from '../types/index.js';
import { ProxyError } from './ProxyError.js';
import { SseDeltaParser, type StreamDelta } from './sseParser.js';

export interface StreamCompletionOptions {
  jsonMode?: boolean;
}

const DEFAULT_TEMPERATURE = 1;
const DEFAULT_TOP_P = 1;

// Reasoning models (DeepSeek V4 family, Kimi, etc.) default to "thinking mode"
// ON: the hidden `reasoning_content` and the visible `content` SHARE one output
// budget (`max_tokens`). A low budget lets the thinking chain consume it all,
// yielding `finish_reason: "length"` with an EMPTY `content` (a saved chapter
// that reads as "not written"). Provider docs recommend >= 16k `max_tokens`
// for thinking models to leave room for the final answer.
const DEFAULT_MAX_TOKENS = 16384;

export interface ModelProxy {
  streamCompletion(
    config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    options?: StreamCompletionOptions,
  ): AsyncIterable<StreamDelta>;
}

function buildCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/chat/completions`;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

const FETCH_MAX_ATTEMPTS = 4;
const FETCH_RETRY_BASE_MS = 2000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(attempt: number): number {
  return FETCH_RETRY_BASE_MS * 2 ** attempt;
}

async function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new ProxyError('请求模型提供商超时或已被取消');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new ProxyError('请求模型提供商超时或已被取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class OpenAiCompatibleModelProxy implements ModelProxy {
  streamCompletion(
    config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    options?: StreamCompletionOptions,
  ): AsyncIterable<StreamDelta> {
    return this.run(config, messages, signal, options);
  }

  private async *run(
    config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    options?: StreamCompletionOptions,
  ): AsyncGenerator<StreamDelta> {
    const isMock = config.baseUrl.trim() === 'mock' || config.modelName.trim() === 'mock-model';
    if (isMock) {
      // Extract last user prompt for canned response
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const promptText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '');
      yield* mockGenerate(promptText, signal);
      return;
    }

    const url = buildCompletionsUrl(config.baseUrl);

    // Prompt Debug Logging (Requirement 1 & 3)
    console.log(`\n--- [ModelProxy] Requesting ${config.modelName} ---`);
    const promptJson = JSON.stringify(messages);
    const prefix = promptJson.slice(0, 4000); // First ~1000 tokens
    const prefixHash = crypto.createHash('sha256').update(prefix).digest('hex').slice(0, 8);
    console.log(`[ModelProxy] Prefix Hash (first 4000 chars): ${prefixHash}`);
    // Log system message stability for cache debugging
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg) {
      const sysHash = crypto.createHash('sha256').update(systemMsg.content).digest('hex').slice(0, 8);
      console.log(`[ModelProxy] System Msg Hash: ${sysHash} (${systemMsg.content.length} chars)`);
    }
    console.log(`[ModelProxy] Prompt Structure:`);
    messages.forEach((m, i) => {
      const typeStr = Array.isArray(m.content) ? 'Array' : 'String';
      const preview = typeof m.content === 'string' ? m.content.slice(0, 80).replace(/\n/g, '\\n') : '';
      console.log(`  [${i}] ${m.role} (${typeStr}): ${preview}${preview.length === 80 ? '...' : ''}`);
    });
    console.log(`--------------------------------------------------\n`);

    const requestBody: Record<string, unknown> = {
      model: config.modelName,
      messages,
      stream: true,
      max_tokens: DEFAULT_MAX_TOKENS,
      temperature: config.temperature ?? DEFAULT_TEMPERATURE,
      top_p: config.topP ?? DEFAULT_TOP_P,
    };
    if (options?.jsonMode === true) {
      requestBody.response_format = { type: 'json_object' };
    }
    applyProviderRequestOptions(requestBody, config);

    let response: Response | undefined;
    for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt += 1) {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(requestBody),
          signal,
        });
      } catch (error: unknown) {
        if (isAbortError(error) || signal.aborted) {
          throw new ProxyError('请求模型提供商超时或已被取消', {
            cause: error,
          });
        }
        if (attempt < FETCH_MAX_ATTEMPTS - 1) {
          const delay = retryDelayMs(attempt);
          console.warn(`[ModelProxy] Connection failed (attempt ${attempt + 1}/${FETCH_MAX_ATTEMPTS}), retrying in ${delay}ms`);
          await sleepMs(delay, signal);
          continue;
        }
        throw new ProxyError('无法连接到模型提供商', { cause: error });
      }

      if (response.ok) {
        break;
      }

      if (isRetryableStatus(response.status) && attempt < FETCH_MAX_ATTEMPTS - 1) {
        const delay = retryDelayMs(attempt);
        console.warn(
          `[ModelProxy] Provider status ${response.status} (attempt ${attempt + 1}/${FETCH_MAX_ATTEMPTS}), retrying in ${delay}ms`,
        );
        await sleepMs(delay, signal);
        continue;
      }

      throw new ProxyError(
        `模型提供商返回错误状态 ${response.status}`,
        { status: response.status },
      );
    }

    if (response === undefined) {
      throw new ProxyError('无法连接到模型提供商');
    }

    if (response.body === null) {
      throw new ProxyError('模型提供商未返回响应内容');
    }

    const decoder = new TextDecoder('utf-8');
    const parser = new SseDeltaParser(config.modelName);
    const reader = response.body.getReader();

    try {
      for (;;) {
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (error: unknown) {
          if (isAbortError(error) || signal.aborted) {
            throw new ProxyError('接收模型响应时超时或已被取消', {
              cause: error,
            });
          }
          throw new ProxyError('读取模型响应流失败', { cause: error });
        }

        if (done) {
          break;
        }
        if (value === undefined) {
          continue;
        }

        const text = decoder.decode(value, { stream: true });
        for (const delta of parser.push(text)) {
          yield delta;
        }
      }

      const tail = decoder.decode();
      if (tail.length > 0) {
        for (const delta of parser.push(tail)) {
          yield delta;
        }
      }
      for (const delta of parser.flush()) {
        yield delta;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function applyProviderRequestOptions(
  requestBody: Record<string, unknown>,
  config: ModelConfig,
): void {
  if (!isDeepSeekOfficialBaseUrl(config.baseUrl)) {
    return;
  }
  // Ask for usage chunks (drives the cache-hit stats).
  requestBody.stream_options = { include_usage: true };
  // IMPORTANT: We deliberately DO NOT force `thinking: { type: 'enabled' }` or
  // `reasoning_effort: 'max'/'high'` here.
  //
  // DeepSeek V4 models already reason by default at a modest token budget and
  // still emit the final answer in `content`. Forcing high/max reasoning made
  // the hidden chain-of-thought (streamed as `reasoning_content`, which this
  // app correctly discards) consume the ENTIRE `max_tokens` budget — the stream
  // then finished with `finish_reason: "length"` and an EMPTY `content`, so the
  // app produced no usable text at all (the "API 不能用" failure). Leaving the
  // reasoning effort at the provider default lets `content` flow normally.
}

function isDeepSeekOfficialBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

/** Simple local mock for demo / offline use. Yields StreamDelta chunks with small delay. */
async function* mockGenerate(prompt: string, signal?: AbortSignal): AsyncGenerator<StreamDelta> {
  const p = (prompt || '默认主题').slice(0, 80);
  const canned = [
    `【MOCK DEMO】根据需求「${p}...」`,
    '，系统已模拟生成世界观、人物关系与首章大纲。',
    '\n\n世界观：这是一个融合都市奇幻的背景，灵气复苏的现代社会。',
    '主角拥有特殊能力，能看到隐藏的“裂缝”。',
    '\n\n人物：主角林辰，28岁，程序员出身，性格谨慎但有正义感。',
    '导师“白先生”神秘，实为守序者。',
    '\n\n第一章草稿：林辰在加班时意外触碰公司服务器的异常日志，眼前浮现一道光痕。',
    '他推开键盘，走向天台，风中传来低语：“裂缝已开，你准备好了吗？”',
    '\n\n（此为本地模拟输出，无真实模型调用。切换回真实提供商即可获得完整连贯长文本。）',
  ];
  for (const piece of canned) {
    if (signal?.aborted) break;
    // Simulate streaming by yielding word-ish chunks
    const words = piece.split(/(\s+)/);
    for (const w of words) {
      if (signal?.aborted) return;
      yield { kind: 'content', text: w };
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 20));
    }
  }
}
