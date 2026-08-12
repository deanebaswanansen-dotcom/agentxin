/**
 * Fastify route module for conversational writing over Server-Sent-Events
 * (design: "HTTP API（REST + SSE）"; Requirements 5.3, 5.4, 5.5, 7.4).
 *
 * | 方法 & 路径                                              | 说明              | 需求 |
 * |----------------------------------------------------------|-------------------|------|
 * | `POST /api/projects/:id/chapters/:chapterId/write`       | 写作请求（SSE）   | 5.x  |
 *
 * Unlike the CRUD route groups this endpoint streams its response. The handler
 * therefore commits to an `text/event-stream` response up-front — it calls
 * {@link import('fastify').FastifyReply.hijack} and writes frames directly to
 * `reply.raw` — and surfaces *every* failure (including the ones
 * {@link WritingService.streamWriting} throws *before* the first byte streams)
 * as an SSE `event: error` frame rather than an HTTP status code. This matches
 * the frontend `apiClient` contract: once the response is `200 OK` it consumes
 * the stream and turns an `event: error` frame back into an `ApiError`.
 *
 * ## SSE wire contract (must match `frontend/src/api/apiClient.ts`)
 *
 * Every frame is a block of `field: value` lines terminated by a blank line.
 * The API key is NEVER present in any frame (Requirement 5.6).
 *
 * | 事件          | 帧                                              | 说明                              |
 * |---------------|-------------------------------------------------|-----------------------------------|
 * | 文本增量      | `event: delta\ndata: <JSON 字符串>\n\n`         | 逐段转发提供商增量 (5.3)          |
 * | 完成          | `event: done\n\n`                               | 流正常结束（前端据此 resolve）    |
 * | 失败          | `event: error\ndata: <JSON ApiError>\n\n`       | 携带统一 {@link ApiError} (5.4/5.5/7.4) |
 *
 * Deltas are JSON-encoded (`JSON.stringify`) so chunks containing newlines or
 * other control characters survive the line-oriented SSE framing intact; the
 * frontend `decodeDelta` decodes them with `JSON.parse`.
 *
 * ## Error mapping (Requirements 5.4, 5.5, 7.4)
 *
 * All errors flow through the shared {@link toErrorResponse} helper so the
 * emitted `ApiError` body is identical to the REST routes':
 *   - `MODEL_NOT_CONFIGURED` (would be HTTP 409) — thrown before streaming (5.4)
 *   - `NOT_FOUND` (404) — chapter does not exist
 *   - `PROVIDER_ERROR` (502) — `ProxyError` raised mid-iteration (5.5)
 *   - `STORE_ERROR` (500) — storage failure / unexpected error (7.4)
 *   - `VALIDATION_ERROR` (400) — malformed request body
 * Only the `ApiError` body is forwarded; the mapped HTTP status is irrelevant
 * once we have committed to the `200` event-stream response.
 *
 * Cancellation: an {@link AbortController} is wired to the request's `close`
 * event so that a client disconnect aborts the {@link WritingService} signal
 * (which in turn aborts the outbound provider request).
 */
import type { FastifyInstance } from 'fastify';

import { corsResponseHeaders } from '../cors.js';
import { startSseHeartbeat } from './sseHeartbeat.js';
import type { WritingService } from '../services/writing/WritingService.js';
import { ServiceError } from '../services/ServiceError.js';
import type { Id, WritingRequestBody } from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';
import { ReasoningArtifactFilter } from '../services/text/reasoningSanitizer.js';

interface WriteParams {
  id: Id;
  chapterId: Id;
}

/** Operations accepted by the writing endpoint (mirrors {@link WritingRequestBody}). */
const VALID_OPERATIONS = new Set(['continue', 'rewrite', 'polish']);

/**
 * Serialize a single SSE event into its on-the-wire frame. A frame is a set of
 * `field: value` lines terminated by a blank line. `data` is omitted entirely
 * for payload-less events (e.g. `done`).
 */
function sseFrame(event: string, data?: string): string {
  const lines = `event: ${event}\n`;
  return data === undefined ? `${lines}\n` : `${lines}data: ${data}\n\n`;
}

/**
 * Validate and narrow the raw request body to a {@link WritingRequestBody}.
 * Throws a `VALIDATION_ERROR` for clearly malformed input so it is surfaced as
 * an `event: error` frame instead of producing a confusing prompt downstream.
 */
function parseWritingBody(raw: unknown): WritingRequestBody {
  if (typeof raw !== 'object' || raw === null) {
    throw ServiceError.validation('写作请求体必须为 JSON 对象。');
  }
  const { operation, instruction } = raw as Record<string, unknown>;
  if (typeof operation !== 'string' || !VALID_OPERATIONS.has(operation)) {
    throw ServiceError.validation('operation 必须为 continue、rewrite 或 polish。');
  }
  if (typeof instruction !== 'string') {
    throw ServiceError.validation('instruction 必须为字符串。');
  }
  return raw as WritingRequestBody;
}

/**
 * Register the writing SSE route on the given Fastify instance using the
 * injected {@link WritingService}. Mirrors the other `registerXxxRoutes`
 * modules so the entrypoint (task 13.1) can register all route groups
 * uniformly. The service is injected (never constructed here) to keep the
 * transport layer decoupled from persistence and the model proxy.
 */
export function registerWritingRoutes(
  app: FastifyInstance,
  writingService: WritingService,
): void {
  app.post<{ Params: WriteParams; Body: unknown }>(
    '/api/projects/:id/chapters/:chapterId/write',
    async (request, reply) => {
      // Commit to an event-stream response: take over the raw socket so Fastify
      // does not also try to serialize/send a body, and flush the SSE headers.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsResponseHeaders(),
      });
      const stopHeartbeat = startSseHeartbeat(raw);

      // Abort the WritingService (and the outbound provider request) when the
      // client disconnects mid-stream. We listen on the RESPONSE socket
      // (`reply.raw`), NOT `request.raw`: the request stream emits 'close' as
      // soon as its body has been fully read, which would abort the provider
      // call immediately (before any tokens stream back). The response socket
      // only closes on real client disconnect or after we finish — and we guard
      // with `writableEnded` so normal completion does not look like an abort.
      const controller = new AbortController();
      const onClose = (): void => {
        if (!raw.writableEnded) {
          controller.abort();
        }
      };
      raw.on('close', onClose);

      try {
        const body = parseWritingBody(request.body);
        const stream = await writingService.streamWriting(
          request.params.id,
          request.params.chapterId,
          body,
          controller.signal,
        );
        const filter = new ReasoningArtifactFilter();

        // Forward each provider increment immediately as it arrives (5.3).
        for await (const delta of stream) {
          if (delta.kind === 'content' && delta.text.length > 0) {
            const cleaned = filter.push(delta.text);
            if (cleaned.length > 0) {
              raw.write(sseFrame('delta', JSON.stringify(cleaned)));
            }
          } else if (delta.kind === 'thinking' && delta.text.length > 0) {
            raw.write(sseFrame('thinking', JSON.stringify(delta.text)));
          }
        }
        const tail = filter.flush();
        if (tail.length > 0) {
          raw.write(sseFrame('delta', JSON.stringify(tail)));
        }

        // Normal completion sentinel the frontend resolves on.
        raw.write(sseFrame('done'));
      } catch (err) {
        // Pre-stream rejections (MODEL_NOT_CONFIGURED/NOT_FOUND) and mid-stream
        // failures (ProxyError → PROVIDER_ERROR, StoreError → STORE_ERROR) are
        // all forwarded as a single `event: error` frame carrying the unified
        // ApiError body (Requirements 5.4, 5.5, 7.4). A client-initiated abort
        // means the socket is gone, so there is nothing to emit.
        if (!controller.signal.aborted && !raw.writableEnded) {
          const { body: apiError } = toErrorResponse(err);
          raw.write(sseFrame('error', JSON.stringify(apiError)));
        }
      } finally {
        stopHeartbeat();
        raw.removeListener('close', onClose);
        if (!raw.writableEnded) {
          raw.end();
        }
      }
    },
  );
}

export default registerWritingRoutes;
