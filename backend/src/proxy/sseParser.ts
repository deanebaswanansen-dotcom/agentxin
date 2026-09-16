import { recordCacheUsage } from './cacheStats.js';
import { ProxyError, providerErrorDetail, sanitizeProviderDetail } from './ProxyError.js';

/**
 * A typed incremental delta extracted from an OpenAI-compatible SSE stream.
 * `content` carries the final answer text; `thinking` carries the model's
 * chain-of-thought reasoning text (e.g. DeepSeek `reasoning_content`).
 */
export type StreamDelta =
  | { kind: 'content'; text: string }
  | { kind: 'thinking'; text: string };

/**
 * Pure parsing helpers for an OpenAI-compatible Server-Sent Events (SSE)
 * completion stream.
 *
 * The provider streams the assistant response as a sequence of SSE events,
 * each typically of the form:
 *
 * ```text
 * data: {"choices":[{"delta":{"content":"Hello"}}]}
 *
 * data: {"choices":[{"delta":{"content":" world"}}]}
 *
 * data: [DONE]
 * ```
 *
 * These helpers extract the incremental `choices[0].delta.content` text from
 * such a stream. They are intentionally split into small pure functions plus a
 * tiny stateful wrapper so the chunk-boundary handling can be unit/property
 * tested with a mock provider (design.md Testing Strategy; Property 17:
 * "流式增量保序无损转发").
 *
 * Chunk-boundary correctness: the network may split the byte stream at any
 * position, so a single `data:` line can arrive across multiple reads. Callers
 * must therefore buffer any trailing partial line between reads — see
 * {@link parseSseChunk} and {@link SseDeltaParser}.
 *
 * SECURITY (Requirement 5.6): these helpers only ever surface decoded
 * `delta.content` text. They never read, log, or emit the provider API key
 * (which lives solely in the outbound request header and never appears in the
 * response body).
 */

/**
 * Shape of a single OpenAI-compatible streaming chunk we care about. All fields
 * are optional/defensive because providers vary and the final `[DONE]` sentinel
 * is not JSON at all.
 */
interface OpenAiStreamChunk {
  error?: unknown;
  type?: unknown;
  object?: unknown;
  choices?: Array<{
    delta?: {
      content?: unknown;
      // Reasoning models (e.g. DeepSeek `deepseek-reasoner` / `deepseek-v4-pro`)
      // stream their chain-of-thought here BEFORE any `content` arrives. We
      // forward it so the user sees live progress instead of a long silent
      // wait; otherwise the UI looks frozen until the (possibly much later)
      reasoning_content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    // OpenAI format
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    // DeepSeek format — cache fields are at usage root level
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/** SSE sentinel that signals the end of the stream; carries no content. */
const DONE_SENTINEL = '[DONE]';

/**
 * Extract the content or reasoning delta from the payload that follows an
 * SSE `data:` field.
 *
 * @returns a {@link StreamDelta} with `kind: 'content'` for final answer text,
 *   `kind: 'thinking'` for reasoning chain-of-thought text, or `null` when the
 *   payload is the `[DONE]` sentinel, is not valid JSON, or carries no usable
 *   delta.
 */
export function extractDeltaFromData(
  dataPayload: string,
  modelName = 'unknown',
  errorEvent = false,
  sanitizeDetail = sanitizeProviderDetail,
): StreamDelta | null {
  const trimmed = dataPayload.trim();

  // End-of-stream sentinel carries no content.
  if (!errorEvent && (trimmed === DONE_SENTINEL || trimmed.length === 0)) {
    return null;
  }

  let parsed: OpenAiStreamChunk;
  try {
    parsed = JSON.parse(trimmed) as OpenAiStreamChunk;
  } catch {
    if (errorEvent) {
      throw new ProxyError(`模型响应流返回错误：${sanitizeDetail(trimmed) || '提供商未说明原因'}`);
    }
    // Non-JSON data line (e.g. a provider keep-alive comment that slipped
    // through). Nothing to forward.
    return null;
  }

  if (
    errorEvent || (parsed && typeof parsed === 'object' && (
      (parsed.error !== undefined && parsed.error !== null && parsed.error !== false) ||
      parsed.type === 'error' || parsed.object === 'error'
    ))
  ) {
    throw new ProxyError(`模型响应流返回错误：${sanitizeDetail(providerErrorDetail(parsed)) || '提供商未说明原因'}`);
  }
  if (!parsed || typeof parsed !== 'object') return null;

  if (parsed.usage) {
    const u = parsed.usage;
    recordCacheUsage(modelName, u);
    // DeepSeek returns `prompt_cache_hit_tokens` at root; OpenAI uses nested `prompt_tokens_details.cached_tokens`
    const cachedTokens = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    const missTokens = u.prompt_cache_miss_tokens;
    console.log(
      `[ModelProxy] Usage — prompt: ${u.prompt_tokens ?? '?'}, completion: ${u.completion_tokens ?? '?'}, total: ${u.total_tokens ?? '?'} | ` +
      `cache_hit: ${cachedTokens}, cache_miss: ${missTokens ?? '?'}`
    );
    if (cachedTokens > 0) {
      const hitRate = u.prompt_tokens ? ((cachedTokens / u.prompt_tokens) * 100).toFixed(1) : '?';
      console.log(`[ModelProxy] ✓ Cache HIT — ${cachedTokens} tokens cached (${hitRate}% of prompt)`);
    } else if (u.prompt_tokens && u.prompt_tokens > 0) {
      console.log(`[ModelProxy] ✗ Cache MISS — 0 tokens cached out of ${u.prompt_tokens} prompt tokens`);
    }
  }

  const delta = parsed.choices?.[0]?.delta;
  const content = delta?.content;
  // Prefer the real answer text. Only string, non-empty content is forwarded.
  if (typeof content === 'string' && content.length > 0) {
    return { kind: 'content', text: content };
  }
  // Surface reasoning text (chain-of-thought) for reasoning models so the
  // UI can show live progress while the model "thinks" before the answer
  // begins (e.g. DeepSeek streams `reasoning_content` with `content: null`
  // first). The route layer emits these as a separate `thinking` SSE event
  // so they never pollute the story content.
  const reasoning = delta?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    return { kind: 'thinking', text: reasoning };
  }
  return null;
}

/**
 * Parse a single complete SSE line and return its content delta if present.
 *
 * Recognises the `data:` field (with or without the conventional single space
 * after the colon). Comment lines (`:` prefix), other field names
 * (`event:`, `id:`, `retry:`) and blank separator lines yield `null`.
 *
 * @param line a single line WITHOUT its terminating newline.
 */
export function extractDeltaFromLine(line: string, modelName = 'unknown'): StreamDelta | null {
  // Trim only the trailing CR so we tolerate CRLF line endings; leading
  // whitespace inside the JSON payload is handled by the JSON parser.
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;

  if (!normalized.startsWith('data:')) {
    return null;
  }

  // Strip the field name. Per the SSE spec a single leading space after the
  // colon is part of the framing and removed; `extractDeltaFromData` also
  // trims, so either way is handled.
  const payload = normalized.slice('data:'.length);
  return extractDeltaFromData(payload, modelName);
}

/**
 * Result of feeding one network chunk to the pure SSE parser.
 */
export interface ParseSseChunkResult {
  /** Deltas (content + thinking) extracted from the COMPLETE lines in this chunk, in order. */
  deltas: StreamDelta[];
  /**
   * The trailing partial line (text after the last newline) that has not yet
   * been terminated. The caller MUST pass this back as `buffer` on the next
   * call so a `data:` line split across chunks is reassembled losslessly.
   */
  rest: string;
}

/**
 * Pure, stateless core of the streaming parser.
 *
 * Concatenates the previously buffered partial line with the freshly received
 * `chunk`, splits on newlines, extracts deltas from every COMPLETE line, and
 * returns those deltas together with the new trailing partial line.
 *
 * Being a pure function of `(buffer, chunk)`, it is trivial to property-test:
 * for any arbitrary re-chunking of a provider stream, folding this function
 * over the chunks must yield the same ordered delta sequence (Property 17).
 *
 * @param buffer leftover partial line from the previous call (`''` initially).
 * @param chunk newly received text.
 */
export function parseSseChunk(
  buffer: string,
  chunk: string,
  modelName = 'unknown',
): ParseSseChunkResult {
  const combined = buffer + chunk;
  const segments = combined.split('\n');

  // The final segment has no terminating newline yet: it is an incomplete line
  // that must be carried over to the next call.
  const rest = segments.pop() ?? '';

  const deltas: StreamDelta[] = [];
  for (const line of segments) {
    const delta = extractDeltaFromLine(line, modelName);
    if (delta !== null) {
      deltas.push(delta);
    }
  }

  return { deltas, rest };
}

/**
 * Stateful SSE event parser that carries partial lines and multi-line data
 * fields across chunks. Feed it raw decoded text chunks via {@link push}; call
 * {@link flush} once after the stream ends to drain any final line that lacked
 * a trailing newline.
 *
 * Error details pass through the caller's sanitizer before being exposed.
 */
export class SseDeltaParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventType = '';
  private sawData = false;

  constructor(
    private readonly modelName = 'unknown',
    private readonly sanitizeDetail = sanitizeProviderDetail,
  ) {}

  get receivedData(): boolean {
    return this.sawData;
  }

  /**
   * Feed one decoded text chunk. Returns the content deltas contained in the
   * complete lines now available, in stream order.
   */
  push(chunk: string): StreamDelta[] {
    const combined = this.buffer + chunk;
    const endings = /\r\n|\r|\n/g;
    let start = 0;
    const deltas: StreamDelta[] = [];
    for (let ending = endings.exec(combined); ending; ending = endings.exec(combined)) {
      // Hold a trailing CR until we know whether the next chunk starts with LF.
      if (ending[0] === '\r' && ending.index === combined.length - 1) break;
      const delta = this.readLine(combined.slice(start, ending.index));
      if (delta) deltas.push(delta);
      start = ending.index + ending[0].length;
    }
    this.buffer = combined.slice(start);
    return deltas;
  }

  /**
   * Drain any buffered final line (a `data:` line whose stream ended without a
   * trailing newline). Returns the remaining deltas, if any, and clears state.
   */
  flush(): StreamDelta[] {
    const deltas = this.push('\n');
    const delta = this.dispatch();
    if (delta) deltas.push(delta);
    return deltas;
  }

  private readLine(line: string): StreamDelta | null {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (normalized.length === 0) return this.dispatch();
    if (normalized.startsWith('event:')) this.eventType = normalized.slice(6).trim();
    if (normalized.startsWith('data:')) {
      this.sawData = true;
      this.dataLines.push(normalized.slice(5).replace(/^ /, ''));
    }
    return null;
  }

  private dispatch(): StreamDelta | null {
    const data = this.dataLines.join('\n');
    const errorEvent = this.eventType === 'error';
    this.dataLines = [];
    this.eventType = '';
    return extractDeltaFromData(data, this.modelName, errorEvent, this.sanitizeDetail);
  }
}
