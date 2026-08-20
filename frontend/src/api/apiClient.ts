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
  ModelConnectionResult,
  NovelPlanSession,
  NovelPlanTurnRequest,
  NovelPlanTurnResponse,
  Outline,
  PacingReport,
  Project,
  ReferenceAnalyzeRequest,
  ReferenceAnalyzeResult,
  ReferenceImportRequest,
  ReferenceImportResult,
  ReferenceNovelDetail,
  ReferenceNovelSummary,
  ReferenceTransferRequest,
  ReferenceTransferResult,
  RewriteSceneBody,
  SimilarityCheckRequest,
  SimilarityCheckResult,
  ScriptAgentJobRequest,
  ScriptAgentJobSnapshot,
  ScriptCharacter,
  ScriptConceptResult,
  ScriptEpisode,
  ScriptEpisodeContinuityCommit,
  ScriptEpisodeOutline,
  ScriptEpisodeReviewResult,
  ScriptEpisodeSummary,
  ScriptPlan,
  ScriptPlanTurnRequest,
  ScriptPlanTurnResponse,
  ScriptReviewIssue,
  ScriptReviewIssueCollection,
  ScriptReviewStatus,
  ScriptReviewIssueUpdateResult,
  ScriptSeriesOutline,
  ScriptWorkspaceSnapshot,
  ScriptWorldBible,
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
const USE_BACKGROUND_AGENT_JOBS = env?.VITE_AGENT_BACKGROUND_JOBS === 'true';

// A request that has gone completely silent is indistinguishable from a dead
// proxy to a browser.  The backend emits SSE heartbeats while long jobs run,
// so this is an inactivity limit rather than a total job limit.
const REQUEST_TIMEOUT_MS = 45_000;
// A whole-book export can briefly wait behind the screenplay store's
// serialized final writes immediately after a large generation job. Keep the
// ordinary UI timeout strict, but give file downloads enough time to finish.
const FILE_REQUEST_TIMEOUT_MS = 120_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;

/** Browser-local persistence so API Key survives refresh (local-dev tool UX). */
const MODEL_CONFIG_STORAGE_KEY = 'nwa.modelConfig.v1';
const CLIENT_ID_STORAGE_KEY = 'nwa.clientId.v1';
const CLIENT_ID_PATTERN = /^[a-f0-9]{64}$/;

function createClientId(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function loadOrCreateClientId(): string {
  const generated = createClientId();
  if (typeof window === 'undefined') return generated;
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing !== null && CLIENT_ID_PATTERN.test(existing)) return existing;
    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, generated);
  } catch {
    // Storage may be blocked; keep one in-memory id for this page lifetime.
  }
  return generated;
}

const clientId = loadOrCreateClientId();

function isModelConfig(value: unknown): value is ModelConfig {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.baseUrl === 'string' &&
    typeof row.apiKey === 'string' &&
    typeof row.modelName === 'string'
  );
}

/** Upgrade browser-local provider aliases that have been retired upstream. */
export function migrateStoredModelConfig(config: ModelConfig): ModelConfig {
  let isOfficialDeepSeek = false;
  try {
    isOfficialDeepSeek = new URL(config.baseUrl).hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    // Custom and local OpenAI-compatible endpoints remain untouched.
  }
  if (!isOfficialDeepSeek) return config;
  if (config.modelName === 'deepseek-chat') {
    return { ...config, baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' };
  }
  if (config.modelName === 'deepseek-reasoner') {
    return { ...config, baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-pro' };
  }
  return config;
}

function loadStoredModelConfig(): ModelConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(MODEL_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isModelConfig(parsed)) return null;
    const config = migrateStoredModelConfig({
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      modelName: parsed.modelName,
      ...(typeof parsed.structuredFallbackModelName === 'string' &&
      parsed.structuredFallbackModelName.trim().length > 0
        ? { structuredFallbackModelName: parsed.structuredFallbackModelName }
        : {}),
      temperature: typeof parsed.temperature === 'number' ? parsed.temperature : undefined,
      topP: typeof parsed.topP === 'number' ? parsed.topP : undefined,
    });
    if (config.baseUrl !== parsed.baseUrl || config.modelName !== parsed.modelName) {
      window.localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify(config));
    }
    return config;
  } catch {
    return null;
  }
}

function persistModelConfig(config: ModelConfig | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (config === null) {
      window.localStorage.removeItem(MODEL_CONFIG_STORAGE_KEY);
    } else {
      window.localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify(config));
    }
  } catch {
    // Storage may be blocked; runtime still works with in-memory config.
  }
}

let volatileModelConfig: ModelConfig | null = loadStoredModelConfig();

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
    ...(config.structuredFallbackModelName?.trim()
      ? { structuredFallbackModelName: config.structuredFallbackModelName }
      : {}),
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

function clientIdentityHeader(): Record<string, string> {
  return { 'X-Agentxin-Client-Id': clientId };
}

function modelConfigHeader(): Record<string, string> {
  const headers = clientIdentityHeader();
  if (volatileModelConfig !== null) {
    headers['X-Agentxin-Model-Config'] = encodeURIComponent(JSON.stringify(volatileModelConfig));
  }
  return headers;
}

interface LinkedTimeoutSignal {
  signal: AbortSignal;
  didTimeout: () => boolean;
  touch: () => void;
  dispose: () => void;
}

/** Combine the caller's cancellation with a bounded inactivity timeout. */
function linkedTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): LinkedTimeoutSignal {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof globalThis.setTimeout>;
  const arm = (): void => {
    timer = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('Request timed out.', 'TimeoutError'));
    }, timeoutMs);
  };
  arm();
  const onAbort = (): void => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    touch: () => {
      if (!timedOut && !controller.signal.aborted) {
        globalThis.clearTimeout(timer);
        arm();
      }
    },
    dispose: () => {
      globalThis.clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
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

/** A silent HTTP poll exceeded its inactivity window. Persistent jobs may retry this safely. */
class RequestTimeoutError extends ApiClientError {
  constructor(apiError: ApiError) {
    super(apiError);
    this.name = 'RequestTimeoutError';
    Object.setPrototypeOf(this, RequestTimeoutError.prototype);
  }
}

export interface ScriptProjectStateResponse {
  schemaVersion: 1;
  projectId: Id;
  plan?: ScriptPlan;
  characters: ScriptCharacter[];
  worldBible?: ScriptWorldBible;
  seriesOutline?: ScriptSeriesOutline;
  episodeOutlines: ScriptEpisodeOutline[];
  episodes: ScriptEpisode[];
  continuity: {
    currentState: string[];
    openThreads: string[];
    wardrobeLedger: Array<{
      episodeNumber: number;
      characterId: Id;
      outfit: string;
    }>;
  };
  /** Versioned continuity source of truth. Optional while older servers roll forward. */
  continuityCommits?: ScriptEpisodeContinuityCommit[];
  reviewRevision: number;
  reviewIssues: ScriptReviewIssue[];
  updatedAt: string;
}

export type ScriptExportFormat = 'txt' | 'md' | 'fountain';

export interface ScriptExportRange {
  startEpisode?: number;
  episodeCount?: number;
}

/** A server-produced export together with its transport metadata. */
export interface ScriptExportFile {
  blob: Blob;
  filename: string;
  contentType: string;
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
      return 'CONFLICT';
    case 401:
    case 402:
    case 403:
    case 408:
    case 502:
    case 503:
    case 504:
      return 'PROVIDER_ERROR';
    case 429:
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
  includeModelConfig?: boolean;
  refreshClientData?: boolean;
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
  const timeout = linkedTimeoutSignal(options?.signal, REQUEST_TIMEOUT_MS);
  const init: RequestInit = { method, signal: timeout.signal };
  const requestHeaders = options?.includeModelConfig === true
    ? modelConfigHeader()
    : clientIdentityHeader();
  if (options?.refreshClientData === true) {
    requestHeaders['X-Agentxin-Refresh-Data'] = 'true';
  }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...requestHeaders };
    init.body = JSON.stringify(body);
  } else {
    init.headers = requestHeaders;
  }

  try {
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
  } catch (error) {
    if (timeout.didTimeout()) {
      throw new RequestTimeoutError(
        { error: { code: 'PROVIDER_ERROR', message: '请求超过 45 秒没有响应，请检查后端或模型服务。' } },
      );
    }
    throw error;
  } finally {
    timeout.dispose();
  }
}

async function requestText(
  baseUrl: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = linkedTimeoutSignal(signal, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: clientIdentityHeader(),
      signal: timeout.signal,
    });
    if (!response.ok) {
      throw toApiClientError(await readBody(response), response.status, response.statusText);
    }
    return await response.text();
  } catch (error) {
    if (timeout.didTimeout()) {
      throw new ApiClientError({
        error: { code: 'PROVIDER_ERROR', message: '请求超过 45 秒没有响应，请检查后端或模型服务。' },
      });
    }
    throw error;
  } finally {
    timeout.dispose();
  }
}

function decodeContentDispositionFilename(value: string | null): string | undefined {
  if (value === null) return undefined;

  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value)?.[1]
    ?.trim()
    .replace(/^"|"$/g, '');
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Fall back to the legacy filename parameter when the RFC 5987 value is malformed.
    }
  }

  const quoted = /(?:^|;)\s*filename\s*=\s*"([^"]*)"/i.exec(value)?.[1];
  if (quoted) return quoted;
  const unquoted = /(?:^|;)\s*filename\s*=\s*([^;]+)/i.exec(value)?.[1]?.trim();
  return unquoted || undefined;
}

function safeServerFilename(value: string | undefined, fallback: string): string {
  const candidate = (value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim();
  return candidate || fallback;
}

async function requestFile(
  baseUrl: string,
  path: string,
  fallbackFilename: string,
  signal?: AbortSignal,
): Promise<ScriptExportFile> {
  const timeout = linkedTimeoutSignal(signal, FILE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: clientIdentityHeader(),
      signal: timeout.signal,
    });
    if (!response.ok) {
      throw toApiClientError(await readBody(response), response.status, response.statusText);
    }

    const disposition = response.headers.get('Content-Disposition');
    const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
    if (contentType.toLowerCase().includes('text/html') && disposition === null) {
      throw new ApiClientError(
        {
          error: {
            code: 'STORE_ERROR',
            message: '导出接口返回了网页内容，可能是后端 API 未部署或路径被静态站回退。',
          },
        },
        response.status,
      );
    }

    const blob = await response.blob();
    if (blob.size === 0) {
      throw new ApiClientError({
        error: { code: 'STORE_ERROR', message: '导出接口返回了空文件。' },
      });
    }
    return {
      blob,
      filename: safeServerFilename(decodeContentDispositionFilename(disposition), fallbackFilename),
      contentType,
    };
  } catch (error) {
    if (timeout.didTimeout()) {
      throw new ApiClientError({
        error: { code: 'PROVIDER_ERROR', message: '导出请求超过 120 秒没有响应，请检查后端服务。' },
      });
    }
    throw error;
  } finally {
    timeout.dispose();
  }
}

function scriptExportPath(
  projectId: Id,
  format: ScriptExportFormat,
  range?: ScriptExportRange,
): string {
  const params = new URLSearchParams({ format });
  if (range?.startEpisode !== undefined) params.set('startEpisode', String(range.startEpisode));
  if (range?.episodeCount !== undefined) params.set('episodeCount', String(range.episodeCount));
  return `/projects/${seg(projectId)}/script-export?${params.toString()}`;
}

function scriptReviewIssuesPath(
  projectId: Id,
  filters?: { episodeNumber?: number; status?: ScriptReviewStatus },
): string {
  const params = new URLSearchParams();
  if (filters?.episodeNumber !== undefined) params.set('episodeNumber', String(filters.episodeNumber));
  if (filters?.status !== undefined) params.set('status', filters.status);
  const query = params.toString();
  return `/projects/${seg(projectId)}/script-review-issues${query ? `?${query}` : ''}`;
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
  const timeout = linkedTimeoutSignal(options?.signal, STREAM_IDLE_TIMEOUT_MS);
  const init: RequestInit = {
    method: 'POST',
    headers: { Accept: 'text/event-stream', ...modelConfigHeader() },
    signal: timeout.signal,
  };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...modelConfigHeader() };
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    timeout.dispose();
    if (timeout.didTimeout()) {
      throw new ApiClientError({
        error: { code: 'PROVIDER_ERROR', message: '流式响应超过 45 秒没有数据，连接已中止。' },
      });
    }
    throw error;
  }

  if (!res.ok) {
    const errBody = await readBody(res);
    timeout.dispose();
    throw toApiClientError(errBody, res.status, res.statusText);
  }
  if (res.body === null) {
    timeout.dispose();
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
  let sawDone = false;

  const consumeEvents = (events: SseEvent[]): 'done' | 'continue' => {
    for (const ev of events) {
      if (ev.event === 'error') {
        throw sseErrorToApiClientError(ev.data);
      }
      if (ev.event === 'done') {
        sawDone = true;
        const tail = reasoningFilter.flush();
        if (tail.length > 0) {
          full += tail;
          options?.onDelta?.(tail);
        }
        return 'done';
      }
      // Let callers consume custom frames (e.g. `scene` / agent `result`) before delta handling.
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
    return 'continue';
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      timeout.touch();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.rest;
      if (consumeEvents(parsed.events) === 'done') {
        return full;
      }
    }
    // Stream closed: flush decoder + any trailing SSE frame without a final blank line.
    buffer += decoder.decode();
    if (buffer.trim().length > 0 && !buffer.endsWith('\n\n')) {
      buffer += '\n\n';
    }
    const trailing = parseSseEvents(buffer);
    if (consumeEvents(trailing.events) === 'done') {
      return full;
    }
  } catch (error) {
    if (timeout.didTimeout()) {
      throw new ApiClientError({
        error: { code: 'PROVIDER_ERROR', message: '流式响应超过 45 秒没有数据，连接已中止。' },
      });
    }
    throw error;
  } finally {
    timeout.dispose();
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released after a clean return.
    }
  }

  const tail = reasoningFilter.flush();
  if (tail.length > 0) {
    full += tail;
    options?.onDelta?.(tail);
  }
  if (!sawDone) {
    throw new ApiClientError({
      error: { code: 'PROVIDER_ERROR', message: '模型响应流提前结束，未收到完成信号。' },
    });
  }
  return full;
}

async function streamPlanTurn(
  baseUrl: string,
  body: NovelPlanTurnRequest,
  signal?: AbortSignal,
): Promise<NovelPlanTurnResponse> {
  let result: NovelPlanTurnResponse | undefined;
  await streamSse(
    `${baseUrl}/agent/plan/turn-stream`,
    body,
    { signal },
    (event) => {
      if (event.event === 'progress') return true;
      if (event.event === 'result') {
        try {
          result = JSON.parse(event.data) as NovelPlanTurnResponse;
        } catch {
          throw new ApiClientError({
            error: { code: 'PROVIDER_ERROR', message: '计划 Agent 返回了无效结果。' },
          });
        }
        return true;
      }
      return false;
    },
  );
  if (result === undefined) {
    throw new ApiClientError({
      error: { code: 'PROVIDER_ERROR', message: '计划 Agent 数据流结束，但没有返回决策结果。' },
    });
  }
  return result;
}

async function getPlanSession(
  baseUrl: string,
  projectId: Id,
  signal?: AbortSignal,
): Promise<NovelPlanSession | null> {
  return request<NovelPlanSession | null>(
    baseUrl,
    'GET',
    `/projects/${seg(projectId)}/plan-session`,
    undefined,
    { signal },
  );
}

async function streamReferenceAnalyze(
  baseUrl: string,
  referenceId: Id,
  body: ReferenceAnalyzeRequest,
  signal?: AbortSignal,
): Promise<ReferenceAnalyzeResult> {
  let result: ReferenceAnalyzeResult | undefined;
  await streamSse(
    `${baseUrl}/references/${seg(referenceId)}/analyze-stream`,
    body,
    { signal },
    (event) => {
      if (event.event === 'progress') return true;
      if (event.event === 'result') {
        try {
          result = JSON.parse(event.data) as ReferenceAnalyzeResult;
        } catch {
          throw new ApiClientError({
            error: { code: 'PROVIDER_ERROR', message: '参考拆解 Agent 返回了无效结果。' },
          });
        }
        return true;
      }
      return false;
    },
  );
  if (result === undefined) {
    throw new ApiClientError({
      error: { code: 'PROVIDER_ERROR', message: '参考拆解数据流结束，但没有返回分析结果。' },
    });
  }
  return result;
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
  onJobCreated?: (jobId: string) => void;
}

interface AgentJobSnapshot {
  state: 'running' | 'completed' | 'failed';
  events?: AgentProgressEvent[];
  result?: AgentRunResult;
  error?: unknown;
}

export interface PersistentAgentJobSnapshot {
  id: string;
  status: 'queued' | 'running' | 'waiting_user' | 'retrying' | 'completed' | 'failed' | 'cancelled';
  events: AgentProgressEvent[];
  request?: AgentRunRequest;
  result?: AgentRunResult;
  error?: { code?: string; message: string };
}

interface PlanJobSnapshot {
  state: 'running' | 'completed' | 'failed';
  result?: NovelPlanTurnResponse;
  error?: unknown;
}

const BACKGROUND_CHAPTER_TASKS = new Set<AgentRunRequest['task']>(['full_novel', 'long_novel']);

function waitForPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function netlifyFunctionUrl(baseUrl: string, functionName: string): string {
  if (/^https?:\/\//i.test(baseUrl)) {
    return `${new URL(baseUrl).origin}/.netlify/functions/${functionName}`;
  }
  return `/.netlify/functions/${functionName}`;
}

/** Run one unit of long multi-agent work in a 15-minute Netlify background function. */
async function runSingleAgentBackgroundJob(
  baseUrl: string,
  body: AgentRunRequest,
  options?: AgentRunStreamOptions,
): Promise<AgentRunResult> {
  const jobId = globalThis.crypto.randomUUID();
  const startUrl = netlifyFunctionUrl(baseUrl, 'agent-job-background');
  const startResponse = await fetch(startUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...modelConfigHeader() },
    body: JSON.stringify({ jobId, request: body }),
    signal: options?.signal,
  });
  if (!startResponse.ok && startResponse.status !== 202) {
    throw toApiClientError(
      await readBody(startResponse),
      startResponse.status,
      startResponse.statusText,
    );
  }

  const statusUrl = `${netlifyFunctionUrl(baseUrl, 'agent-job')}?jobId=${encodeURIComponent(jobId)}`;
  const deadline = Date.now() + 870_000;
  let deliveredEvents = 0;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new ApiClientError({
        error: { code: 'PROVIDER_ERROR', message: '后台 Agent 超过 14 分 30 秒仍未完成。' },
      });
    }
    const response = await fetch(statusUrl, {
      headers: clientIdentityHeader(),
      signal: options?.signal,
      cache: 'no-store',
    });
    if (response.status === 404) {
      await waitForPoll(750, options?.signal);
      continue;
    }
    if (!response.ok) {
      throw toApiClientError(await readBody(response), response.status, response.statusText);
    }
    const snapshot = (await response.json()) as AgentJobSnapshot;
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    for (const event of events.slice(deliveredEvents)) {
      options?.onProgress?.(event);
    }
    deliveredEvents = events.length;

    if (snapshot.state === 'completed' && snapshot.result !== undefined) {
      try {
        await request(baseUrl, 'GET', '/projects', undefined, {
          signal: options?.signal,
          refreshClientData: true,
        });
      } catch (error) {
        console.warn('[agent] 已完成，但刷新云端项目缓存失败：', error);
      }
      void fetch(statusUrl, {
        method: 'DELETE',
        headers: clientIdentityHeader(),
      }).catch(() => undefined);
      return snapshot.result;
    }
    if (snapshot.state === 'failed') {
      throw toApiClientError(snapshot.error, 200);
    }
    await waitForPoll(750, options?.signal);
  }
}

/** Run one planning decision in Netlify's 15-minute background runtime. */
export async function runPlanBackgroundJob(
  baseUrl: string,
  body: NovelPlanTurnRequest,
  signal?: AbortSignal,
): Promise<NovelPlanTurnResponse> {
  const jobId = globalThis.crypto.randomUUID();
  const startUrl = netlifyFunctionUrl(baseUrl, 'agent-job-background');
  const startResponse = await fetch(startUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...modelConfigHeader() },
    body: JSON.stringify({ jobId, kind: 'plan', request: body }),
    signal,
  });
  if (!startResponse.ok && startResponse.status !== 202) {
    throw toApiClientError(
      await readBody(startResponse),
      startResponse.status,
      startResponse.statusText,
    );
  }

  const statusUrl = `${netlifyFunctionUrl(baseUrl, 'agent-job')}?jobId=${encodeURIComponent(jobId)}`;
  const deadline = Date.now() + 870_000;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new ApiClientError({
        error: { code: 'PROVIDER_ERROR', message: '后台计划 Agent 超过 14 分 30 秒仍未完成。' },
      });
    }
    const response = await fetch(statusUrl, {
      headers: clientIdentityHeader(),
      signal,
      cache: 'no-store',
    });
    if (response.status === 404) {
      await waitForPoll(750, signal);
      continue;
    }
    if (!response.ok) {
      throw toApiClientError(await readBody(response), response.status, response.statusText);
    }
    const snapshot = (await response.json()) as PlanJobSnapshot;
    if (snapshot.state === 'completed' && snapshot.result !== undefined) {
      void fetch(statusUrl, {
        method: 'DELETE',
        headers: clientIdentityHeader(),
      }).catch(() => undefined);
      return snapshot.result;
    }
    if (snapshot.state === 'failed') {
      throw toApiClientError(snapshot.error, 200);
    }
    await waitForPoll(750, signal);
  }
}

function requestedBackgroundBatches(body: AgentRunRequest): number {
  if (!BACKGROUND_CHAPTER_TASKS.has(body.task)) return 1;
  const chapters = body.options?.chapters;
  return typeof chapters === 'number' && Number.isFinite(chapters)
    ? Math.min(500, Math.max(1, Math.floor(chapters)))
    : 1;
}

function mergeBackgroundResults(results: AgentRunResult[]): AgentRunResult {
  const last = results.at(-1)!;
  const artifacts = [...new Map(
    results.flatMap((result) => result.artifacts).map((artifact) => [`${artifact.kind}:${artifact.id}`, artifact]),
  ).values()];
  const metrics = results.some((result) => result.metrics !== undefined)
    ? results.reduce<NonNullable<AgentRunResult['metrics']>>(
        (sum, result) => {
          const next = result.metrics;
          if (next === undefined) return sum;
          sum.modelCalls += next.modelCalls;
          sum.promptTokens += next.promptTokens;
          sum.completionTokens += next.completionTokens;
          sum.cacheHitTokens += next.cacheHitTokens;
          sum.cacheMissTokens += next.cacheMissTokens;
          sum.localCacheHits += next.localCacheHits;
          sum.localCacheMisses += next.localCacheMisses;
          sum.completedChapters = (sum.completedChapters ?? 0) + (next.completedChapters ?? 0);
          sum.plannedWords = Math.max(sum.plannedWords ?? 0, next.plannedWords ?? 0);
          sum.estimatedCostUsd = (sum.estimatedCostUsd ?? 0) + (next.estimatedCostUsd ?? 0);
          return sum;
        },
        {
          modelCalls: 0,
          promptTokens: 0,
          completionTokens: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          cacheHitRatePct: 0,
          localCacheHits: 0,
          localCacheMisses: 0,
          localCacheHitRatePct: 0,
        },
      )
    : undefined;
  if (metrics !== undefined) {
    const remoteTotal = metrics.cacheHitTokens + metrics.cacheMissTokens;
    const localTotal = metrics.localCacheHits + metrics.localCacheMisses;
    metrics.cacheHitRatePct = remoteTotal > 0 ? (metrics.cacheHitTokens / remoteTotal) * 100 : 0;
    metrics.localCacheHitRatePct = localTotal > 0 ? (metrics.localCacheHits / localTotal) * 100 : 0;
  }
  return {
    ...last,
    summary: `长篇任务已分批完成 ${results.length}/${results.length} 章。${last.summary}`,
    steps: results.flatMap((result) => result.steps).slice(-100),
    artifacts,
    metrics,
  };
}

/**
 * Netlify 单个后台函数最多运行 15 分钟。多章任务拆成每批一章，上一批持久化后再启动
 * 下一批，避免在首章 ReviewAgent 附近被平台强制终止并永久显示“运行中”。
 */
export async function runAgentBackgroundJob(
  baseUrl: string,
  body: AgentRunRequest,
  options?: AgentRunStreamOptions,
): Promise<AgentRunResult> {
  const batches = requestedBackgroundBatches(body);
  if (batches === 1) return runSingleAgentBackgroundJob(baseUrl, body, options);

  const results: AgentRunResult[] = [];
  let projectId = body.projectId;
  const totalChapters = body.options?.totalChapters ?? body.options?.planSummary?.chapterCount ?? batches;
  for (let index = 0; index < batches; index += 1) {
    const result = await runSingleAgentBackgroundJob(
      baseUrl,
      {
        ...body,
        projectId,
        options: { ...body.options, chapters: 1, totalChapters },
      },
      {
        ...options,
        onProgress: (event) =>
          options?.onProgress?.({
            ...event,
            ...(event.current !== undefined ? { current: index + 1, total: batches } : {}),
          }),
      },
    );
    results.push(result);
    projectId = result.projectId;
  }
  return mergeBackgroundResults(results);
}

/** Run long work on the persistent Node backend; aborting only detaches polling. */
export async function runPersistentAgentJob(
  baseUrl: string,
  body: AgentRunRequest,
  options?: AgentRunStreamOptions,
): Promise<AgentRunResult> {
  const created = await request<PersistentAgentJobSnapshot>(baseUrl, 'POST', '/agent/jobs', body, {
    signal: options?.signal,
    includeModelConfig: true,
  });
  options?.onJobCreated?.(created.id);
  return watchPersistentAgentJob(baseUrl, created.id, options);
}

export async function watchPersistentAgentJob(
  baseUrl: string,
  jobId: string,
  options?: AgentRunStreamOptions,
): Promise<AgentRunResult> {
  let deliveredEvents = 0;
  let reconnecting = false;
  let resumedInterrupted = false;
  for (;;) {
    let snapshot: PersistentAgentJobSnapshot;
    try {
      snapshot = await request<PersistentAgentJobSnapshot>(
        baseUrl,
        'GET',
        `/agent/jobs/${seg(jobId)}`,
        undefined,
        { signal: options?.signal, includeModelConfig: true },
      );
    } catch (error) {
      if (!(error instanceof RequestTimeoutError) || options?.signal?.aborted === true) throw error;
      if (!reconnecting) {
        reconnecting = true;
        options?.onProgress?.({
          phase: 'info',
          message: '后台仍在生成，页面连接较慢，正在自动重连…',
        });
      }
      await waitForPoll(1_000, options?.signal);
      continue;
    }
    if (reconnecting) {
      reconnecting = false;
      options?.onProgress?.({ phase: 'info', message: '已恢复连接，任务继续运行。' });
    }
    for (const event of snapshot.events.slice(deliveredEvents)) options?.onProgress?.(event);
    deliveredEvents = snapshot.events.length;
    if (snapshot.status === 'completed' && snapshot.result) return snapshot.result;
    if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      throw new ApiClientError({
        error: {
          code: snapshot.error?.code === 'PROVIDER_ERROR' ? 'PROVIDER_ERROR' : 'STORE_ERROR',
          message: snapshot.error?.message ?? '后台 Agent 任务失败。',
        },
      });
    }
    if (snapshot.status === 'waiting_user') {
      if (snapshot.error?.code === 'RUN_INTERRUPTED' && !resumedInterrupted) {
        resumedInterrupted = true;
        options?.onProgress?.({
          phase: 'info',
          message: snapshot.error.message || '服务已重启，正在自动继续任务…',
        });
        await request(baseUrl, 'POST', `/agent/jobs/${seg(jobId)}/resume`, {}, {
          signal: options?.signal,
          includeModelConfig: true,
        });
        continue;
      }
      throw new ApiClientError({
        error: {
          code: snapshot.error?.code === 'PROVIDER_ERROR' ? 'PROVIDER_ERROR' : 'STORE_ERROR',
          message: snapshot.error?.message ?? '任务等待确认后才能继续。',
        },
      });
    }
    await waitForPoll(750, options?.signal);
  }
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
  if (USE_BACKGROUND_AGENT_JOBS) {
    return runAgentBackgroundJob(baseUrl, body, options);
  }
  if (BACKGROUND_CHAPTER_TASKS.has(body.task)) {
    return runPersistentAgentJob(baseUrl, body, options);
  }
  let result: AgentRunResult | undefined;
  let settleAfterResult: ReturnType<typeof setTimeout> | undefined;
  let resolveEarly: (() => void) | undefined;

  const earlyDone = new Promise<void>((resolve) => {
    resolveEarly = resolve;
  });

  const streamPromise = streamSse(
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
        // 已有最终结果时不再死等 done：部分代理会吞掉最后的 done/end，导致 UI 永久「生成中」。
        if (result !== undefined && settleAfterResult === undefined) {
          settleAfterResult = setTimeout(() => {
            resolveEarly?.();
          }, 800);
        }
        return true;
      }
      if (ev.event === 'done') {
        resolveEarly?.();
      }
      return false;
    },
  ).finally(() => {
    if (settleAfterResult !== undefined) {
      clearTimeout(settleAfterResult);
    }
    resolveEarly?.();
  });

  // Avoid unhandled rejection if we leave the stream running after early settle.
  void streamPromise.catch(() => undefined);

  // Wait for either the full stream, or a short grace period after `result`.
  await Promise.race([streamPromise, earlyDone]);

  if (result === undefined) {
    await streamPromise;
  }

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
    /** 开局计划模式：多轮追问 / 收束 brief。 */
    planTurn(body: NovelPlanTurnRequest, signal?: AbortSignal): Promise<NovelPlanTurnResponse>;
    getPlanSession(projectId: Id, signal?: AbortSignal): Promise<NovelPlanSession | null>;
    clearPlanSession(projectId: Id, signal?: AbortSignal): Promise<void>;
    listJobs(projectId: Id, signal?: AbortSignal): Promise<PersistentAgentJobSnapshot[]>;
    watchJob(jobId: string, options?: AgentRunStreamOptions): Promise<AgentRunResult>;
    cancelJob(jobId: string, signal?: AbortSignal): Promise<PersistentAgentJobSnapshot>;
  };
  projects: {
    list(signal?: AbortSignal): Promise<Array<Pick<Project, 'id' | 'name' | 'kind'>>>;
    get(id: Id, signal?: AbortSignal): Promise<Project>;
    create(name: string, kind?: Project['kind'], signal?: AbortSignal): Promise<{ id: Id }>;
    rename(id: Id, name: string, signal?: AbortSignal): Promise<void>;
    remove(id: Id, signal?: AbortSignal): Promise<void>;
  };
  script: {
    state: {
      /** Load the complete persisted short-drama state in one request. */
      get(projectId: Id, signal?: AbortSignal): Promise<ScriptProjectStateResponse>;
    };
    workspace: {
      /** Load the product workspace shell, summaries, batches and review state in one request. */
      get(projectId: Id, signal?: AbortSignal): Promise<ScriptWorkspaceSnapshot>;
    };
    plan: {
      get(projectId: Id, signal?: AbortSignal): Promise<ScriptPlan>;
      save(projectId: Id, value: ScriptPlan, expectedRevision: number, signal?: AbortSignal): Promise<ScriptPlan>;
      approve(projectId: Id, expectedRevision: number, signal?: AbortSignal): Promise<ScriptPlan>;
      turn(body: ScriptPlanTurnRequest, signal?: AbortSignal): Promise<ScriptPlanTurnResponse>;
      concepts(projectId: Id, seedPrompt?: string, signal?: AbortSignal): Promise<ScriptConceptResult>;
    };
    characters: {
      list(projectId: Id, signal?: AbortSignal): Promise<ScriptCharacter[]>;
      save(projectId: Id, items: ScriptCharacter[], expectedRevision: number, signal?: AbortSignal): Promise<ScriptCharacter[]>;
    };
    world: {
      get(projectId: Id, signal?: AbortSignal): Promise<ScriptWorldBible>;
      save(projectId: Id, value: ScriptWorldBible, expectedRevision: number, signal?: AbortSignal): Promise<ScriptWorldBible>;
    };
    outline: {
      get(projectId: Id, signal?: AbortSignal): Promise<ScriptSeriesOutline>;
      save(projectId: Id, value: ScriptSeriesOutline, expectedRevision: number, signal?: AbortSignal): Promise<ScriptSeriesOutline>;
    };
    episodeOutlines: {
      get(projectId: Id, episodeNumber: number, signal?: AbortSignal): Promise<ScriptEpisodeOutline>;
      save(projectId: Id, episodeNumber: number, value: ScriptEpisodeOutline, expectedRevision: number, signal?: AbortSignal): Promise<ScriptEpisodeOutline>;
    };
    episodes: {
      list(projectId: Id, signal?: AbortSignal): Promise<ScriptEpisodeSummary[]>;
      get(projectId: Id, episodeNumber: number, signal?: AbortSignal): Promise<ScriptEpisode>;
      save(projectId: Id, episodeNumber: number, value: ScriptEpisode, expectedRevision: number, signal?: AbortSignal): Promise<ScriptEpisode>;
      review(projectId: Id, episodeNumber: number, expectedRevision: number, signal?: AbortSignal): Promise<ScriptEpisodeReviewResult>;
    };
    reviews: {
      list(projectId: Id, filters?: { episodeNumber?: number; status?: ScriptReviewStatus }, signal?: AbortSignal): Promise<ScriptReviewIssueCollection>;
      save(projectId: Id, items: ScriptReviewIssue[], expectedRevision: number, signal?: AbortSignal): Promise<ScriptReviewIssueCollection>;
      updateStatus(projectId: Id, issueId: Id, status: ScriptReviewStatus, expectedRevision: number, signal?: AbortSignal): Promise<ScriptReviewIssueUpdateResult>;
    };
    jobs: {
      create(body: ScriptAgentJobRequest, signal?: AbortSignal): Promise<ScriptAgentJobSnapshot>;
      list(projectId: Id, signal?: AbortSignal): Promise<ScriptAgentJobSnapshot[]>;
      get(jobId: string, signal?: AbortSignal): Promise<ScriptAgentJobSnapshot>;
      resume(jobId: string, signal?: AbortSignal): Promise<ScriptAgentJobSnapshot>;
      cancel(jobId: string, signal?: AbortSignal): Promise<ScriptAgentJobSnapshot>;
    };
    export(projectId: Id, format: ScriptExportFormat, range?: ScriptExportRange, signal?: AbortSignal): Promise<string>;
    exportFile(projectId: Id, format: ScriptExportFormat, range?: ScriptExportRange, signal?: AbortSignal): Promise<ScriptExportFile>;
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
    test(signal?: AbortSignal): Promise<ModelConnectionResult>;
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
  references: {
    list(signal?: AbortSignal): Promise<ReferenceNovelSummary[]>;
    get(id: Id, signal?: AbortSignal): Promise<ReferenceNovelDetail>;
    import(body: ReferenceImportRequest, signal?: AbortSignal): Promise<ReferenceImportResult>;
    analyze(
      id: Id,
      body?: ReferenceAnalyzeRequest,
      signal?: AbortSignal,
    ): Promise<ReferenceAnalyzeResult>;
    transfer(
      projectId: Id,
      body: ReferenceTransferRequest,
      signal?: AbortSignal,
    ): Promise<ReferenceTransferResult>;
    checkSimilarity(
      projectId: Id,
      body: SimilarityCheckRequest,
      signal?: AbortSignal,
    ): Promise<SimilarityCheckResult>;
    purgeRaw(id: Id, signal?: AbortSignal): Promise<ReferenceNovelSummary>;
    remove(id: Id, signal?: AbortSignal): Promise<void>;
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
      run: (body, signal) =>
        request(b, 'POST', '/agent/run', body, { signal, includeModelConfig: true }),
      runStream: (body, options) => streamAgentRun(b, body, options),
      planTurn: (body, signal) =>
        USE_BACKGROUND_AGENT_JOBS
          ? runPlanBackgroundJob(b, body, signal)
          : streamPlanTurn(b, body, signal),
      getPlanSession: (projectId, signal) => getPlanSession(b, projectId, signal),
      clearPlanSession: (projectId, signal) =>
        request(b, 'DELETE', `/projects/${seg(projectId)}/plan-session`, undefined, { signal }),
      listJobs: (projectId, signal) =>
        request(b, 'GET', `/projects/${seg(projectId)}/agent-jobs`, undefined, { signal }),
      watchJob: (jobId, options) => watchPersistentAgentJob(b, jobId, options),
      cancelJob: (jobId, signal) =>
        request(b, 'POST', `/agent/jobs/${seg(jobId)}/cancel`, {}, { signal }),
    },
    projects: {
      list: (signal) => request(b, 'GET', '/projects', undefined, { signal }),
      get: (id, signal) => request(b, 'GET', `/projects/${seg(id)}`, undefined, { signal }),
      create: (name, kind, signal) =>
        request(b, 'POST', '/projects', kind === undefined ? { name } : { name, kind }, { signal }),
      rename: (id, name, signal) =>
        request(b, 'PATCH', `/projects/${seg(id)}`, { name }, { signal }),
      remove: (id, signal) => request(b, 'DELETE', `/projects/${seg(id)}`, undefined, { signal }),
    },
    script: {
      state: {
        get: (projectId, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/script-state`, undefined, { signal }),
      },
      workspace: {
        get: (projectId, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/script-workspace`, undefined, { signal }),
      },
      plan: {
        get: (projectId, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/script-plan`, undefined, { signal }),
        save: (projectId, value, expectedRevision, signal) =>
          request(b, 'PUT', `/projects/${seg(projectId)}/script-plan`, { expectedRevision, value }, { signal }),
        approve: (projectId, expectedRevision, signal) =>
          request(b, 'POST', `/projects/${seg(projectId)}/script-plan/approve`, { expectedRevision }, { signal }),
        turn: (body, signal) =>
          request(b, 'POST', '/plan/script/turn', body, { signal, includeModelConfig: true }),
        concepts: (projectId, seedPrompt = '', signal) =>
          request(b, 'POST', '/plan/script/concepts', { projectId, seedPrompt }, {
            signal,
            includeModelConfig: true,
          }),
      },
      characters: {
        list: (projectId, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/script-characters`, undefined, { signal }),
        save: (projectId, items, expectedRevision, signal) =>
          request(b, 'PUT', `/projects/${seg(projectId)}/script-characters`, { expectedRevision, items }, { signal }),
      },
      world: {
        get: (projectId, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/script-world`, undefined, { signal }),
        save: (projectId, value, expectedRevision, signal) =>
          request(b, 'PUT', `/projects/${seg(projectId)}/script-world`, { expectedRevision, value }, { signal }),
      },
      outline: {
        get: (projectId, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/script-outline`, undefined, { signal }),
        save: (projectId, value, expectedRevision, signal) =>
          request(b, 'PUT', `/projects/${seg(projectId)}/script-outline`, { expectedRevision, value }, { signal }),
      },
      episodeOutlines: {
        get: (projectId, episodeNumber, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/episode-outlines/${episodeNumber}`, undefined, { signal }),
        save: (projectId, episodeNumber, value, expectedRevision, signal) =>
          request(b, 'PUT', `/projects/${seg(projectId)}/episode-outlines/${episodeNumber}`, { expectedRevision, value }, { signal }),
      },
      episodes: {
        list: (projectId, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/script-episodes`, undefined, { signal }),
        get: (projectId, episodeNumber, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/script-episodes/${episodeNumber}`, undefined, { signal }),
        save: (projectId, episodeNumber, value, expectedRevision, signal) =>
          request(b, 'PUT', `/projects/${seg(projectId)}/script-episodes/${episodeNumber}`, { expectedRevision, value }, { signal }),
        review: (projectId, episodeNumber, expectedRevision, signal) =>
          request(b, 'POST', `/projects/${seg(projectId)}/script-episodes/${episodeNumber}/review`, { expectedRevision }, { signal }),
      },
      reviews: {
        list: (projectId, filters, signal) =>
          request(b, 'GET', scriptReviewIssuesPath(projectId, filters), undefined, { signal }),
        save: (projectId, items, expectedRevision, signal) =>
          request(b, 'PUT', `/projects/${seg(projectId)}/script-review-issues`, { expectedRevision, items }, { signal }),
        updateStatus: (projectId, issueId, status, expectedRevision, signal) =>
          request(b, 'PATCH', `/projects/${seg(projectId)}/script-review-issues/${seg(issueId)}`, { expectedRevision, status }, { signal }),
      },
      jobs: {
        create: (body, signal) =>
          request(b, 'POST', '/agent/jobs', body, { signal, includeModelConfig: true }),
        list: (projectId, signal) =>
          request(b, 'GET', `/projects/${seg(projectId)}/agent-jobs`, undefined, {
            signal,
            includeModelConfig: true,
          }),
        get: (jobId, signal) =>
          request(b, 'GET', `/agent/jobs/${seg(jobId)}`, undefined, {
            signal,
            includeModelConfig: true,
          }),
        resume: (jobId, signal) =>
          request(b, 'POST', `/agent/jobs/${seg(jobId)}/resume`, {}, { signal, includeModelConfig: true }),
        cancel: (jobId, signal) =>
          request(b, 'POST', `/agent/jobs/${seg(jobId)}/cancel`, {}, { signal }),
      },
      export: (projectId, format, range, signal) =>
        requestText(b, scriptExportPath(projectId, format, range), signal),
      exportFile: (projectId, format, range, signal) =>
        requestFile(
          b,
          scriptExportPath(projectId, format, range),
          `short-drama-${projectId}.${format}`,
          signal,
        ),
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
      get: async (_signal) => {
        if (volatileModelConfig === null) {
          volatileModelConfig = loadStoredModelConfig();
        }
        return toModelConfigView(volatileModelConfig);
      },
      save: async (config, _signal) => {
        volatileModelConfig = { ...config };
        persistModelConfig(volatileModelConfig);
        return toModelConfigView(volatileModelConfig);
      },
      test: (signal) =>
        request(b, 'POST', '/model-config/test', {}, {
          signal,
          includeModelConfig: true,
        }),
      clear: () => {
        volatileModelConfig = null;
        persistModelConfig(null);
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
    references: {
      list: (signal) => request(b, 'GET', '/references', undefined, { signal }),
      get: (id, signal) => request(b, 'GET', `/references/${seg(id)}`, undefined, { signal }),
      import: (body, signal) => request(b, 'POST', '/references/import', body, { signal }),
      analyze: (id, body, signal) =>
        streamReferenceAnalyze(b, id, body ?? {}, signal),
      transfer: (projectId, body, signal) =>
        request(b, 'POST', `/projects/${seg(projectId)}/reference-transfer`, body, {
          signal,
          includeModelConfig: true,
        }),
      checkSimilarity: (projectId, body, signal) =>
        request(b, 'POST', `/projects/${seg(projectId)}/similarity/check`, body, { signal }),
      purgeRaw: (id, signal) =>
        request(b, 'POST', `/references/${seg(id)}/purge-raw`, undefined, { signal }),
      remove: (id, signal) =>
        request(b, 'DELETE', `/references/${seg(id)}`, undefined, { signal }),
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
          { signal, includeModelConfig: true },
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
          request(b, 'POST', `/chapters/${seg(chapterId)}/pacing-check`, undefined, {
            signal,
            includeModelConfig: true,
          }),
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
