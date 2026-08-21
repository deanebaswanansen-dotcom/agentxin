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
 * - DeepSeek 官方 V4 可按调用场景显式关闭 thinking；
 * - 解析提供商 SSE，抽取 `choices[0].delta.content` 增量并按序产出；
 * - 提供商返回非 2xx，或请求被 AbortSignal 中止/超时时，抛出 {@link ProxyError}。
 *
 * 安全（Requirement 5.6）：API Key 仅出现在服务端到提供商的请求头中。
 * 产出的增量、抛出的错误信息均不包含 API Key——本模块从不将 `config.apiKey`
 * 写入任何产出值或错误消息。
 */

import crypto from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { ChatMessage, ModelConfig } from '../types/index.js';
import { ProxyError } from './ProxyError.js';
import { SseDeltaParser, type StreamDelta } from './sseParser.js';

export interface StreamCompletionOptions {
  jsonMode?: boolean;
  /** Optional small output budget for connection probes and classifiers. */
  maxTokens?: number;
  /** Optional per-call sampling override for deterministic structured tasks. */
  temperature?: number;
  /** Official DeepSeek only: use non-thinking mode for bounded structured output. */
  disableThinking?: boolean;
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

const BLOCKED_MODEL_NETS = (() => {
  const list = new BlockList();
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addSubnet('10.0.0.0', 8, 'ipv4');
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addSubnet('172.16.0.0', 12, 'ipv4');
  list.addSubnet('192.168.0.0', 16, 'ipv4');
  // CGNAT / Aliyun metadata (100.100.100.200 lives in 100.64.0.0/10).
  list.addSubnet('100.64.0.0', 10, 'ipv4');
  list.addAddress('::', 'ipv6');
  list.addAddress('::1', 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  return list;
})();

function isBlockedModelHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    host === 'metadata.internal' ||
    host.endsWith('instance-data')
  ) {
    return true;
  }
  const version = isIP(host);
  if (version === 4) return BLOCKED_MODEL_NETS.check(host, 'ipv4');
  if (version === 6) return BLOCKED_MODEL_NETS.check(host, 'ipv6');
  return false;
}

/** WHATWG URL requires brackets around IPv6; recover dotted `::ffff:a.b.c.d`. */
function recoverUnbracketedIpv4MappedUrl(raw: string): URL | undefined {
  const match = /^(https?):\/\/(::ffff:\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?(\/.*)?$/i.exec(raw);
  if (!match) return undefined;
  try {
    const port = match[3] ? `:${match[3]}` : '';
    return new URL(`${match[1]}://[${match[2]}]${port}${match[4] ?? ''}`);
  } catch {
    return undefined;
  }
}

function parseModelBaseUrl(baseUrl: string): URL {
  const raw = baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`;
  try {
    return new URL(raw);
  } catch {
    const recovered = recoverUnbracketedIpv4MappedUrl(raw);
    if (recovered) return recovered;
    throw new ProxyError('模型服务地址无效。', { status: 400 });
  }
}

export function assertPublicModelBaseUrl(baseUrl: string): void {
  if (process.env.ALLOW_PRIVATE_MODEL_URLS === '1') return;
  const parsed = parseModelBaseUrl(baseUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ProxyError('模型服务地址必须是 http 或 https。', { status: 400 });
  }
  if (isBlockedModelHostname(parsed.hostname)) {
    throw new ProxyError('模型服务地址不能指向本机、内网或链路本地地址。', { status: 400 });
  }
}

function buildCompletionsUrl(baseUrl: string): string {
  assertPublicModelBaseUrl(baseUrl);
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

function sanitizeProviderDetail(value: string): string {
  return value
    .replace(/sk-[a-zA-Z0-9_-]{8,}/g, '[API_KEY]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [API_KEY]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

async function providerFailureMessage(response: Response): Promise<string> {
  let detail = '';
  try {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
      detail = typeof parsed.error?.message === 'string' ? parsed.error.message : raw;
    } catch {
      detail = raw;
    }
  } catch {
    // Status-specific guidance below remains available when the body cannot be read.
  }
  const safeDetail = sanitizeProviderDetail(detail);
  const guidance: Record<number, string> = {
    400: '请求参数或模型名称不被提供商接受',
    401: 'API Key 无效',
    402: '模型账户余额不足',
    403: 'API Key 没有该模型权限',
    404: 'API 地址或模型名称不存在',
    408: '模型提供商请求超时',
    429: '模型提供商限流，请稍后重试',
    500: '模型提供商内部错误',
    502: '模型提供商网关错误',
    503: '模型提供商暂时不可用',
    504: '模型提供商响应超时',
  };
  const base = guidance[response.status] ?? `模型提供商返回 HTTP ${response.status}`;
  return safeDetail ? `${base}：${safeDetail}` : base;
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
      yield* mockGenerate(promptText, signal, options);
      return;
    }

    const url = buildCompletionsUrl(config.baseUrl);

    console.log(`\n--- [ModelProxy] Requesting ${config.modelName} ---`);
    const promptJson = JSON.stringify(messages);
    const prefix = promptJson.slice(0, 4000);
    const prefixHash = crypto.createHash('sha256').update(prefix).digest('hex').slice(0, 8);
    console.log(`[ModelProxy] Prefix Hash (first 4000 chars): ${prefixHash}`);
    const systemMsg = messages.find((m) => m.role === 'system');
    if (systemMsg) {
      const sysHash = crypto.createHash('sha256').update(systemMsg.content).digest('hex').slice(0, 8);
      console.log(`[ModelProxy] System Msg Hash: ${sysHash} (${systemMsg.content.length} chars)`);
    }
    if (process.env.DEBUG_MODEL_PROMPTS === '1') {
      console.log(`[ModelProxy] Prompt Structure:`);
      messages.forEach((m, i) => {
        const typeStr = Array.isArray(m.content) ? 'Array' : 'String';
        const preview = typeof m.content === 'string' ? m.content.slice(0, 80).replace(/\n/g, '\\n') : '';
        console.log(`  [${i}] ${m.role} (${typeStr}): ${preview}${preview.length === 80 ? '...' : ''}`);
      });
    }
    console.log(`--------------------------------------------------\n`);

    const requestBody: Record<string, unknown> = {
      model: config.modelName,
      messages,
      stream: true,
      max_tokens:
        typeof options?.maxTokens === 'number' && Number.isFinite(options.maxTokens)
          ? Math.min(65536, Math.max(16, Math.round(options.maxTokens)))
          : DEFAULT_MAX_TOKENS,
      temperature:
        typeof options?.temperature === 'number' && Number.isFinite(options.temperature)
          ? Math.min(2, Math.max(0, options.temperature))
          : config.temperature ?? DEFAULT_TEMPERATURE,
      top_p: config.topP ?? DEFAULT_TOP_P,
    };
    if (options?.jsonMode === true) {
      requestBody.response_format = { type: 'json_object' };
    }
    applyProviderRequestOptions(requestBody, config, options);

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
          redirect: 'error',
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

      throw new ProxyError(await providerFailureMessage(response), { status: response.status });
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
  options?: StreamCompletionOptions,
): void {
  if (!isDeepSeekOfficialBaseUrl(config.baseUrl)) {
    return;
  }
  // Ask for usage chunks (drives the cache-hit stats).
  requestBody.stream_options = { include_usage: true };
  if (options?.disableThinking === true) {
    requestBody.thinking = { type: 'disabled' };
  }
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
async function* mockGenerate(
  prompt: string,
  signal?: AbortSignal,
  options?: StreamCompletionOptions,
): AsyncGenerator<StreamDelta> {
  if (prompt.includes('inspector_only') || prompt.includes('「检测子 Agent」')) {
    yield {
      kind: 'content',
      text: JSON.stringify({
        score0to100: 88,
        verdict: 'pass',
        plotCoherence: '本地 mock 审校通过。',
        fatalIssues: [],
        earlyCharacterStatus: [],
        recommendRevision: false,
        revisionHints: [],
      }),
    };
    return;
  }
  if (options?.jsonMode === true && /"summary"|反思子 Agent/.test(prompt)) {
    yield {
      kind: 'content',
      text: JSON.stringify({
        summary: '本地 mock 章节摘要。',
        facts: [],
        learning: '',
        foreshadows: [],
      }),
    };
    return;
  }
  const p = (prompt || '默认主题').slice(0, 80);
  const canned = [
    `【MOCK DEMO】根据需求「${p}...」`,
    '，这里仅返回与输入主题绑定的占位结果，不补充任何未指定题材。',
    '\n\n世界观：沿用用户输入中的时代、地域、文化和力量规则。',
    '\n\n人物：沿用用户指定的主角身份、目标、缺陷和关系。',
    '\n\n大纲：围绕用户输入的核心冲突推进，不自动加入校园、都市或修仙模板。',
    '\n\n（本地测试响应；没有调用真实模型，不代表成稿质量。）',
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
