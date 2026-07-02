/**
 * Frontend API client for the Novel Writing Agent (task 12.1).
 *
 * Responsibilities:
 *  - Wrap `fetch` for every REST endpoint defined in the design's HTTP API
 *    table (projects / chapters / settings / model-config).
 *  - Convert any non-success HTTP response into a thrown {@link ApiClientError}
 *    carrying the unified {@link ApiError} shape so the UI can display
 *    `error.message` (Requirement 8.6). Reads always reflect the latest
 *    server-persisted state (Requirement 7.2).
 *  - Consume the backend Server-Sent-Events (SSE) stream for the writing
 *    endpoint. `EventSource` cannot issue a POST with a JSON body, so we use
 *    `fetch` + a `ReadableStream` reader and parse the SSE frames ourselves.
 *    Text deltas are forwarded to a callback; an `event: error` frame carrying
 *    an `ApiError` is surfaced as a rejected {@link ApiClientError}.
 *    Cancellation is supported via an `AbortSignal`.
 *
 * SSE wire contract (frontend-facing; the writing route in task 11.5 must
 * emit this shape). The API key is NEVER part of any frame.
 *   - Text delta:  `event: delta`  `data: <JSON-encoded string chunk>`
 *   - Completion:  `event: done`   `data:` (payload ignored)
 *   - Failure:     `event: error`  `data: <JSON ApiError>`
 * For leniency the delta parser also accepts a raw (non-JSON) `data` payload.
 */
import type {
  ApiError,
  AgentProgressEvent,
  AgentRunRequest,
  AgentRunResult,
  CacheStatsSummary,
  Chapter,
  ChapterBlueprint,
  Character,
  ErrorCode,
  ExpandSceneBody,
  FreeChatRequestBody,
  GenerateBlueprintBody,
  Id,
  ImportNovelRequest,
  ImportNovelResult,
  ModelConfig,
  ModelConfigView,
  Outline,
  PacingReport,
  Project,
  RewriteSceneBody,
  WordCountReport,
  WorldSetting,
  WritingRequestBody,
} from '../types/index.js';
import { ReasoningArtifactFilter } from '../lib/reasoningSanitizer.js';

// ---------------------------------------------------------------------------
// Base URL configuration
// ---------------------------------------------------------------------------

/**
 * Resolve the API base URL. Defaults to the relative `/api` path (works behind
 * the Vite dev proxy and in production where the SPA is served by the backend).
 * Overridable via the `VITE_API_BASE_URL` env var. Accessed defensively
 * because `vite/client` types are not enabled in this project's tsconfig.
 */
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const DEFAULT_BASE_URL = (env?.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

let volatileModelConfig: ModelConfig | null = null;

function toModelConfigView(config: ModelConfig | null): ModelConfigView {
  if (config === null) {
    return {
      baseUrl: '',
      modelName: '',
      apiKeyMasked: '',
      temperature: 1,
      topP: 1,
    };
  }
  return {
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    apiKeyMasked: maskApiKey(config.apiKey),
    temperature: config.temperature ?? 1,
    topP: config.topP ?? 1,
  };
}

function maskApiKey(apiKey: string): string {
  const chars = Array.from(apiKey);
  if (chars.length === 0) return '';
  const reveal = chars.slice(Math.max(1, chars.length - 4)).join('');
  return `****${reveal}`;
}

function modelConfigHeader(): Record<string, string> {
  if (volatileModelConfig === null) return {};
  return {
    'X-Agentxin-Model-Config': encodeURIComponent(JSON.stringify(volatileModelConfig)),
  };
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Error thrown for any non-success API interaction. Carries the unified
 * {@link ApiError} payload plus the originating HTTP status (when available),
 * so the global error UI (task 12.7) can render `error.message` directly.
 */
export class ApiClientError extends Error {
  /** Unified error code from the backend (or synthesized client-side). */
  readonly code: ErrorCode;
  /** Originating HTTP status code, when the error came from a response. */
  readonly status?: number;
  /** The full unified error payload. */
  readonly apiError: ApiError;

  constructor(apiError: ApiError, status?: number) {
    super(apiError.error.message);
    this.name = 'ApiClientError';
    this.code = apiError.error.code;
    this.status = status;
    this.apiError = apiError;
    Object.setPrototypeOf(this, ApiClientError.prototype);
  }
}

/** Type guard for {@link ApiClientError}. */
export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Map an HTTP status to a best-effort {@link ErrorCode} when the body lacks one. */
function statusToCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'MODEL_NOT_CONFIGURED';
    case 502:
      return 'PROVIDER_ERROR';
    default:
      return 'STORE_ERROR';
  }
}

/** Narrow an arbitrary parsed value to a valid {@link ApiError}. */
function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string';
}

/**
 * Build an {@link ApiClientError} from a parsed response body and status.
 * If the body is already a valid {@link ApiError} it is used verbatim;
 * otherwise a reasonable error is synthesized from the status.
 */
function toApiClientError(body: unknown, status: number, statusText?: string): ApiClientError {
  if (isApiError(body)) {
    return new ApiClientError(body, status);
  }
  const message =
    typeof body === 'string' && body.trim().length > 0
      ? body
      : statusText && statusText.length > 0
        ? statusText
        : `请求失败（HTTP ${status}）`;
  return new ApiClientError({ error: { code: statusToCode(status), message } }, status);
}

/** Read a response body as JSON when possible, falling back to text / undefined. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * Core request helper: performs the fetch, converts any non-2xx response into
 * a thrown {@link ApiClientError}, and parses the JSON body on success.
 * Returns `undefined` for empty (e.g. 204) bodies. `AbortError` propagates
 * unchanged so callers can distinguish user-initiated cancellation.
 */
async function request<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const init: RequestInit = { method, signal: options?.signal };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...modelConfigHeader() };
    init.body = JSON.stringify(body);
  } else {
    init.headers = modelConfigHeader();
  }

  const res = await fetch(`${baseUrl}${path}`, init);
  if (!res.ok) {
    const errBody = await readBody(res);
    throw toApiClientError(errBody, res.status, res.statusText);
  }
  const parsedBody = await readBody(res);
  if (typeof parsedBody === 'string') {
    throw new ApiClientError(
      {
        error: {
          code: 'STORE_ERROR',
          message: '接口返回了非 JSON 响应，可能是后端 API 未部署或路径被静态站回退。',
        },
      },
      res.status,
    );
  }
  return parsedBody as T;
}

/** Encode a path segment (typically an id) for safe URL interpolation. */
function seg(value: Id): string {
  return encodeURIComponent(value);
}

// ---------------------------------------------------------------------------
// SSE parsing (pure, exported for unit testing)
// ---------------------------------------------------------------------------

export interface SseEvent {
  /** Event name; defaults to `'message'` when no `event:` field is present. */
  event: string;
  /** Concatenated `data:` payload (multiple data lines joined with `\n`). */
  data: string;
}

/**
 * Extract complete SSE event blocks from a text buffer. An event block is
 * terminated by a blank line. Returns the parsed events plus any trailing
 * partial block that must be retained for the next chunk. Handles both `\n`
 * and `\r\n` line endings.
 */
export function parseSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const events: SseEvent[] = [];
  let rest = normalized;

  let sepIndex = rest.indexOf('\n\n');
  while (sepIndex !== -1) {
    const block = rest.slice(0, sepIndex);
    rest = rest.slice(sepIndex + 2);

    let eventName = 'message';
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
      if (rawLine.length === 0 || rawLine.startsWith(':')) continue; // blank / comment
      const colon = rawLine.indexOf(':');
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      // Per spec, a single leading space after the colon is stripped.
      let val = colon === -1 ? '' : rawLine.slice(colon + 1);
      if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'event') eventName = val;
      else if (field === 'data') dataLines.push(val);
    }
    if (dataLines.length > 0 || eventName !== 'message') {
      events.push({ event: eventName, data: dataLines.join('\n') });
    }
    sepIndex = rest.indexOf('\n\n');
  }

  return { events, rest };
}

/** Decode a delta frame's `data` payload into the raw text chunk. */
function decodeDelta(data: string): string {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Not JSON: fall back to the raw payload.
  }
  return data;
}

// ---------------------------------------------------------------------------
// Writing (SSE streaming) interface
// ---------------------------------------------------------------------------

export interface WriteOptions {
  /** Invoked for each text delta as it arrives from the stream. */
  onDelta?: (delta: string) => void;
  /** Invoked for each reasoning/thinking delta (chain-of-thought). */
  onThinking?: (delta: string) => void;
  /** Cancels the in-flight request/stream. */
  signal?: AbortSignal;
}

/**
 * Consumption options for whole-chapter generation. Extends {@link WriteOptions}
 * with optional scene-boundary callbacks driven by the `event: scene` frame.
 * `onSceneDone` is reserved for a future `scene-done` frame and may never fire
 * against the current backend.
 */
export interface AssembleOptions extends WriteOptions {
  /** Invoked when generation advances to a new scene (carries its `scene_id`). */
  onSceneStart?: (sceneId: string) => void;
  /** Invoked when a scene finishes, if the backend emits a `scene-done` frame. */
  onSceneDone?: (sceneId: string) => void;
}

/**
 * Convert an `event: error` frame's `data` payload into an
 * {@link ApiClientError}. Accepts a unified {@link ApiError} JSON body, a raw
 * error string, or anything else (synthesizing a `PROVIDER_ERROR`).
 */
function sseErrorToApiClientError(data: string): ApiClientError {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return data;
    }
  })();
  return isApiError(parsed)
    ? new ApiClientError(parsed)
    : new ApiClientError({
        error: {
          code: 'PROVIDER_ERROR',
          message: typeof parsed === 'string' && parsed.length > 0 ? parsed : '写作请求失败。',
        },
      });
}

/**
 * Generic SSE consumer shared by every streaming endpoint (writing + blueprint
 * scene/chapter generation). POSTs `body` to `url`, reads the `ReadableStream`,
 * and parses SSE frames with {@link parseSseEvents}. Resolves with the full
 * concatenated text once an `event: done` frame (or stream end) is reached,
 * forwarding each text delta to `onDelta`. Rejects with an
 * {@link ApiClientError} on a non-success HTTP response or an `event: error`
 * frame; `AbortError` propagates on cancellation.
 *
 * `onSseEvent` lets callers intercept non-delta frames (e.g. the `event: scene`
 * boundary emitted by chapter generation). Returning `true` marks the frame as
 * consumed; returning `false`/`undefined` (or omitting the handler) preserves
 * the legacy behavior of treating every non-`error`/non-`done` frame as a text
 * delta via {@link decodeDelta}.
 */
async function streamSse(
  url: string,
  body: unknown,
  options?: WriteOptions,
  onSseEvent?: (event: SseEvent) => boolean | void,
): Promise<string> {
  const init: RequestInit = {
    method: 'POST',
    headers: { Accept: 'text/event-stream', ...modelConfigHeader() },
    signal: options?.signal,
  };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...modelConfigHeader() };
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);

  if (!res.ok) {
    const errBody = await readBody(res);
    throw toApiClientError(errBody, res.status, res.statusText);
  }
  if (res.body === null) {
    throw new ApiClientError(
      { error: { code: 'PROVIDER_ERROR', message: '写作响应缺少数据流。' } },
      res.status,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const reasoningFilter = new ReasoningArtifactFilter();
  let buffer = '';
  let full = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseEvents(buffer);
      buffer = rest;
      for (const ev of events) {
        if (ev.event === 'error') {
          throw sseErrorToApiClientError(ev.data);
        }
        if (ev.event === 'done') {
          const tail = reasoningFilter.flush();
          if (tail.length > 0) {
            full += tail;
            options?.onDelta?.(tail);
          }
          return full;
        }
        // Let callers consume custom frames (e.g. `scene`) before delta handling.
        if (onSseEvent?.(ev) === true) {
          continue;
        }
        // Thinking/reasoning event (model chain-of-thought) — forward to onThinking only.
        if (ev.event === 'thinking') {
          const thinkingDelta = decodeDelta(ev.data);
          if (thinkingDelta.length > 0) {
            options?.onThinking?.(thinkingDelta);
          }
          continue;
        }
        // Default / `delta` event carries a text increment.
        const delta = reasoningFilter.push(decodeDelta(ev.data));
        if (delta.length > 0) {
          full += delta;
          options?.onDelta?.(delta);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const tail = reasoningFilter.flush();
  if (tail.length > 0) {
    full += tail;
    options?.onDelta?.(tail);
  }
  return full;
}

/**
 * Consume the writing SSE stream for a chapter. Thin wrapper over
 * {@link streamSse} preserving the original `write()` behavior and signature.
 * Resolves with the full concatenated text once the stream completes,
 * forwarding each delta to `onDelta` as it arrives. Rejects with an
 * {@link ApiClientError} on a non-success HTTP response or an `event: error`
 * frame; `AbortError` propagates on cancellation.
 */
async function streamWrite(
  baseUrl: string,
  projectId: Id,
  chapterId: Id,
  body: WritingRequestBody,
  options?: WriteOptions,
): Promise<string> {
  return streamSse(
    `${baseUrl}/projects/${seg(projectId)}/chapters/${seg(chapterId)}/write`,
    body,
    options,
  );
}

/** Options for the streaming agent run: cancellation + live progress callback. */
export interface AgentRunStreamOptions {
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
}

/**
 * Consume the agent SSE stream (`POST /api/agent/run-stream`). Forwards each
 * `event: progress` frame to `onProgress`, captures the final `event: result`
 * frame, and resolves with the {@link AgentRunResult} once `event: done`
 * arrives. Rejects with an {@link ApiClientError} on an `event: error` frame or
 * a non-success HTTP response; `AbortError` propagates on cancellation.
 */
async function streamAgentRun(
  baseUrl: string,
  body: AgentRunRequest,
  options?: AgentRunStreamOptions,
): Promise<AgentRunResult> {
  let result: AgentRunResult | undefined;
  await streamSse(
    `${baseUrl}/agent/run-stream`,
    body,
    { signal: options?.signal },
    (ev) => {
      if (ev.event === 'progress') {
        try {
          options?.onProgress?.(JSON.parse(ev.data) as AgentProgressEvent);
        } catch {
          // 忽略无法解析的进度帧。
        }
        return true;
      }
      if (ev.event === 'result') {
        try {
          result = JSON.parse(ev.data) as AgentRunResult;
        } catch {
          // 解析失败时下方统一抛错。
        }
        return true;
      }
      return false;
    },
  );
  if (result === undefined) {
    throw new ApiClientError(
      { error: { code: 'PROVIDER_ERROR', message: 'Agent 流未返回最终结果。' } },
      200,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Blueprint streaming (SSE) helpers
// ---------------------------------------------------------------------------

/**
 * Consume the chapter-generation SSE stream. In addition to the shared
 * `delta`/`done`/`error` handling, recognizes the `event: scene` boundary
 * frame (`data: <JSON {sceneId}>`) and forwards the scene id to
 * `onSceneStart`. An optional `event: scene-done` frame (not emitted by the
 * current backend) is forwarded to `onSceneDone` when present.
 */
async function streamAssembleChapter(
  baseUrl: string,
  chapterId: Id,
  options?: AssembleOptions,
): Promise<string> {
  return streamSse(
    `${baseUrl}/chapters/${seg(chapterId)}/generate`,
    undefined,
    options,
    (ev) => {
      if (ev.event === 'scene') {
        const sceneId = decodeSceneId(ev.data);
        if (sceneId !== undefined) options?.onSceneStart?.(sceneId);
        return true;
      }
      if (ev.event === 'scene-done') {
        const sceneId = decodeSceneId(ev.data);
        if (sceneId !== undefined) options?.onSceneDone?.(sceneId);
        return true;
      }
      return false;
    },
  );
}

/** Extract the `sceneId` string from a `scene` frame's JSON `data` payload. */
function decodeSceneId(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { sceneId?: unknown }).sceneId === 'string'
    ) {
      return (parsed as { sceneId: string }).sceneId;
    }
  } catch {
    // Not JSON / unexpected shape: no scene id to report.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export interface ApiClient {
  agent: {
    run(body: AgentRunRequest, signal?: AbortSignal): Promise<AgentRunResult>;
    runStream(body: AgentRunRequest, options?: AgentRunStreamOptions): Promise<AgentRunResult>;
  };
  projects: {
    list(signal?: AbortSignal): Promise<Pick<Project, 'id' | 'name'>[]>;
    create(name: string, signal?: AbortSignal): Promise<{ id: Id }>;
    rename(id: Id, name: string, signal?: AbortSignal): Promise<void>;
    remove(id: Id, signal?: AbortSignal): Promise<void>;
  };
  chapters: {
    list(projectId: Id, signal?: AbortSignal): Promise<Chapter[]>;
    create(projectId: Id, title: string, signal?: AbortSignal): Promise<{ id: Id }>;
    updateContent(id: Id, content: string, signal?: AbortSignal): Promise<void>;
    rename(id: Id, title: string, signal?: AbortSignal): Promise<Chapter>;
    remove(id: Id, signal?: AbortSignal): Promise<void>;
    reorder(projectId: Id, orderedIds: Id[], signal?: AbortSignal): Promise<void>;
  };
  settings: {
    characters: {
      list(projectId: Id, signal?: AbortSignal): Promise<Character[]>;
      create(
        projectId: Id,
        fields: Pick<Character, 'name' | 'description'>,
        signal?: AbortSignal,
      ): Promise<Character>;
      update(
        id: Id,
        fields: Partial<Pick<Character, 'name' | 'description'>>,
        signal?: AbortSignal,
      ): Promise<Character>;
      remove(id: Id, signal?: AbortSignal): Promise<void>;
    };
    worldSettings: {
      list(projectId: Id, signal?: AbortSignal): Promise<WorldSetting[]>;
      create(
        projectId: Id,
        fields: Pick<WorldSetting, 'title' | 'content'>,
        signal?: AbortSignal,
      ): Promise<WorldSetting>;
      update(
        id: Id,
        fields: Partial<Pick<WorldSetting, 'title' | 'content'>>,
        signal?: AbortSignal,
      ): Promise<WorldSetting>;
      remove(id: Id, signal?: AbortSignal): Promise<void>;
    };
    outlines: {
      list(projectId: Id, signal?: AbortSignal): Promise<Outline[]>;
      create(
        projectId: Id,
        fields: Pick<Outline, 'title' | 'content'>,
        signal?: AbortSignal,
      ): Promise<Outline>;
      update(
        id: Id,
        fields: Partial<Pick<Outline, 'title' | 'content'>>,
        signal?: AbortSignal,
      ): Promise<Outline>;
      remove(id: Id, signal?: AbortSignal): Promise<void>;
    };
  };
  modelConfig: {
    get(signal?: AbortSignal): Promise<ModelConfigView>;
    save(config: ModelConfig, signal?: AbortSignal): Promise<ModelConfigView>;
    clear(): void;
  };
  cacheStats: {
    get(signal?: AbortSignal): Promise<CacheStatsSummary>;
    reset(signal?: AbortSignal): Promise<{ ok: true }>;
  };
  imports: {
    organizeNovel(
      projectId: Id,
      body: ImportNovelRequest,
      signal?: AbortSignal,
    ): Promise<ImportNovelResult>;
  };
  write(
    projectId: Id,
    chapterId: Id,
    body: WritingRequestBody,
    options?: WriteOptions,
  ): Promise<string>;
  freeChat: {
    stream(
      projectId: Id,
      body: FreeChatRequestBody,
      options?: WriteOptions,
    ): Promise<string>;
  };
  blueprint: {
    /** Read the latest persisted blueprint for a chapter (NOT_FOUND if none). */
    get(chapterId: Id, signal?: AbortSignal): Promise<ChapterBlueprint>;
    /** Generate and persist a blueprint, returning the validated result. */
    generate(
      chapterId: Id,
      body: GenerateBlueprintBody,
      signal?: AbortSignal,
    ): Promise<ChapterBlueprint>;
    /** Merge persisted scene drafts into the chapter content. */
    merge(chapterId: Id, signal?: AbortSignal): Promise<{ content: string }>;
    wordCount: {
      /** Run a word-count check and persist the report. */
      run(chapterId: Id, signal?: AbortSignal): Promise<WordCountReport>;
      /** Read the latest persisted word-count report (NOT_FOUND if none). */
      get(chapterId: Id, signal?: AbortSignal): Promise<WordCountReport>;
    };
    pacing: {
      /** Run a pacing check and persist the report. */
      run(chapterId: Id, signal?: AbortSignal): Promise<PacingReport>;
      /** Read the latest persisted pacing report (NOT_FOUND if none). */
      get(chapterId: Id, signal?: AbortSignal): Promise<PacingReport>;
    };
    /** Stream a single scene draft (SSE); resolves with the full text. */
    writeScene(chapterId: Id, sceneId: string, options?: WriteOptions): Promise<string>;
    /** Stream an expansion of an existing scene draft (SSE). */
    expandScene(
      chapterId: Id,
      sceneId: string,
      body: ExpandSceneBody,
      options?: WriteOptions,
    ): Promise<string>;
    /** Stream a rewrite of an existing scene draft (SSE). */
    rewriteScene(
      chapterId: Id,
      sceneId: string,
      body: RewriteSceneBody,
      options?: WriteOptions,
    ): Promise<string>;
    /** Stream whole-chapter generation (SSE); recognizes `event: scene` frames. */
    assembleChapter(chapterId: Id, options?: AssembleOptions): Promise<string>;
  };
}

/**
 * Create an {@link ApiClient} bound to the given base URL. Exported as a
 * factory primarily to ease testing (inject a mock base) and custom
 * deployments; most callers should import the default {@link apiClient}.
 */
export function createApiClient(baseUrl: string = DEFAULT_BASE_URL): ApiClient {
  const b = baseUrl.replace(/\/$/, '');
  return {
    agent: {
      run: (body, signal) => request(b, 'POST', '/agent/run', body, { signal }),
      runStream: (body, options) => streamAgentRun(b, body, options),
    },
    projects: {
      list: (signal) => request(b, 'GET', '/projects', undefined, { signal }),
      create: (name, signal) => request(b, 'POST', '/projects', { name }, { signal }),
      rename: (id, name, signal) =>
        request(b, 'PATCH', `/projects/${seg(id)}`, { name }, { signal }),
      remove: (id, signal) => request(b, 'DELETE', `/projects/${seg(id)}`, undefined, { signal }),
    },
    chapters: {
      list: (projectId, signal) =>
        request(b, 'GET', `/projects/${seg(projectId)}/chapters`, undefined, { signal }),
      create: (projectId, title, signal) =>
        request(b, 'POST', `/projects/${seg(projectId)}/chapters`, { title }, { signal }),
      updateContent: (id, content, signal) =>
        request(b, 'PATCH', `/chapters/${seg(id)}/content`, { content }, { signal }),
      rename: (id, title, signal) =>
        request(b, 'PATCH', `/chapters/${seg(id)}`, { title }, { signal }),
      remove: (id, signal) => request(b, 'DELETE', `/chapters/${seg(id)}`, undefined, { signal }),
      reorder: (projectId, orderedIds, signal) =>
        request(b, 'PUT', `/projects/${seg(projectId)}/chapters/order`, { orderedIds }, { signal }),
    },
    settings: {
      characters: {
        list: (projectId, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/characters`, undefined, { signal }),
        create: (projectId, fields, signal) =>
          request(b, 'POST', `/projects/${seg(projectId)}/characters`, fields, { signal }),
        update: (id, fields, signal) =>
          request(b, 'PATCH', `/characters/${seg(id)}`, fields, { signal }),
        remove: (id, signal) =>
          request(b, 'DELETE', `/characters/${seg(id)}`, undefined, { signal }),
      },
      worldSettings: {
        list: (projectId, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/worldSettings`, undefined, { signal }),
        create: (projectId, fields, signal) =>
          request(b, 'POST', `/projects/${seg(projectId)}/worldSettings`, fields, { signal }),
        update: (id, fields, signal) =>
          request(b, 'PATCH', `/worldSettings/${seg(id)}`, fields, { signal }),
        remove: (id, signal) =>
          request(b, 'DELETE', `/worldSettings/${seg(id)}`, undefined, { signal }),
      },
      outlines: {
        list: (projectId, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/outlines`, undefined, { signal }),
        create: (projectId, fields, signal) =>
          request(b, 'POST', `/projects/${seg(projectId)}/outlines`, fields, { signal }),
        update: (id, fields, signal) =>
          request(b, 'PATCH', `/outlines/${seg(id)}`, fields, { signal }),
        remove: (id, signal) =>
          request(b, 'DELETE', `/outlines/${seg(id)}`, undefined, { signal }),
      },
    },
    modelConfig: {
      get: async (_signal) => toModelConfigView(volatileModelConfig),
      save: async (config, _signal) => {
        volatileModelConfig = { ...config };
        return toModelConfigView(volatileModelConfig);
      },
      clear: () => {
        volatileModelConfig = null;
      },
    },
    cacheStats: {
      get: (signal) => request(b, 'GET', '/cache-stats', undefined, { signal }),
      reset: (signal) => request(b, 'POST', '/cache-stats/reset', undefined, { signal }),
    },
    imports: {
      organizeNovel: (projectId, body, signal) =>
        request(b, 'POST', `/projects/${seg(projectId)}/import/novel`, body, { signal }),
    },
    write: (projectId, chapterId, body, options) =>
      streamWrite(b, projectId, chapterId, body, options),
    freeChat: {
      stream: (projectId, body, options) =>
        streamSse(`${b}/projects/${seg(projectId)}/chat`, body, options),
    },
    blueprint: {
      get: (chapterId, signal) =>
        request(b, 'GET', `/chapters/${seg(chapterId)}/blueprint`, undefined, { signal }),
      // Backend route is POST /projects/:id/chapters/:chapterId/blueprint, but the
      // projectId is resolved server-side from the chapter, so the `:id` segment
      // is a placeholder ('_') ignored by the handler.
      generate: (chapterId, body, signal) =>
        request(
          b,
          'POST',
          `/projects/_/chapters/${seg(chapterId)}/blueprint`,
          body,
          { signal },
        ),
      merge: (chapterId, signal) =>
        request(b, 'POST', `/chapters/${seg(chapterId)}/merge`, undefined, { signal }),
      wordCount: {
        run: (chapterId, signal) =>
          request(b, 'POST', `/chapters/${seg(chapterId)}/word-count-check`, undefined, {
            signal,
          }),
        get: (chapterId, signal) =>
          request(b, 'GET', `/chapters/${seg(chapterId)}/word-count-report`, undefined, {
            signal,
          }),
      },
      pacing: {
        run: (chapterId, signal) =>
          request(b, 'POST', `/chapters/${seg(chapterId)}/pacing-check`, undefined, { signal }),
        get: (chapterId, signal) =>
          request(b, 'GET', `/chapters/${seg(chapterId)}/pacing-report`, undefined, { signal }),
      },
      writeScene: (chapterId, sceneId, options) =>
        streamSse(
          `${b}/chapters/${seg(chapterId)}/scenes/${seg(sceneId)}/write`,
          undefined,
          options,
        ),
      expandScene: (chapterId, sceneId, body, options) =>
        streamSse(
          `${b}/chapters/${seg(chapterId)}/scenes/${seg(sceneId)}/expand`,
          body,
          options,
        ),
      rewriteScene: (chapterId, sceneId, body, options) =>
        streamSse(
          `${b}/chapters/${seg(chapterId)}/scenes/${seg(sceneId)}/rewrite`,
          body,
          options,
        ),
      assembleChapter: (chapterId, options) => streamAssembleChapter(b, chapterId, options),
    },
  };
}

/** Default API client bound to the resolved base URL. */
export const apiClient: ApiClient = createApiClient();

export default apiClient;
