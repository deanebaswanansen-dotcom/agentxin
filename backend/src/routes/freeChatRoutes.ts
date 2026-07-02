/**
 * Fastify route module for free chat over Server-Sent-Events.
 *
 * | 方法 & 路径                                   | 说明              |
 * |-----------------------------------------------|-------------------|
 * | `POST /api/projects/:projectId/chat`          | 自由对话（SSE）   |
 *
 * SSE wire contract (same as writingRoutes):
 * - `event: delta\ndata: <JSON string chunk>\n\n`
 * - `event: done\n\n`
 * - `event: error\ndata: <JSON ApiError>\n\n`
 */
import type { FastifyInstance } from 'fastify';

import type { FreeChatService } from '../services/freeChat/FreeChatService.js';
import { ServiceError } from '../services/ServiceError.js';
import type { FreeChatRequestBody, Id } from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';

interface ChatParams {
  projectId: Id;
}

/**
 * Serialize a single SSE event into its on-the-wire frame.
 */
function sseFrame(event: string, data?: string): string {
  const lines = `event: ${event}\n`;
  return data === undefined ? `${lines}\n` : `${lines}data: ${data}\n\n`;
}

/** Valid context values for the free chat request. */
const VALID_CONTEXTS = new Set(['plot', 'character', 'world', 'writing']);

/**
 * Validate and narrow the raw request body to a {@link FreeChatRequestBody}.
 */
function parseChatBody(raw: unknown): FreeChatRequestBody {
  if (typeof raw !== 'object' || raw === null) {
    throw ServiceError.validation('对话请求体必须为 JSON 对象。');
  }
  const { message, context, chapterId, attachedSettingIds, sessionHistory } =
    raw as Record<string, unknown>;

  if (typeof message !== 'string' || message.trim().length === 0) {
    throw ServiceError.validation('message 不能为空。');
  }

  // Validate context (optional)
  if (
    context !== undefined &&
    context !== null &&
    (typeof context !== 'string' || !VALID_CONTEXTS.has(context))
  ) {
    throw ServiceError.validation(
      'context 必须为 plot、character、world、writing 或 null。',
    );
  }

  // Validate chapterId (optional)
  if (chapterId !== undefined && typeof chapterId !== 'string') {
    throw ServiceError.validation('chapterId 必须为字符串。');
  }

  // Validate attachedSettingIds (optional)
  if (attachedSettingIds !== undefined && !Array.isArray(attachedSettingIds)) {
    throw ServiceError.validation('attachedSettingIds 必须为字符串数组。');
  }

  // Validate sessionHistory (optional)
  if (sessionHistory !== undefined && !Array.isArray(sessionHistory)) {
    throw ServiceError.validation('sessionHistory 必须为数组。');
  }

  return raw as FreeChatRequestBody;
}

/**
 * Register the free chat SSE route on the given Fastify instance.
 */
export function registerFreeChatRoutes(
  app: FastifyInstance,
  freeChatService: FreeChatService,
): void {
  app.post<{ Params: ChatParams; Body: unknown }>(
    '/api/projects/:projectId/chat',
    async (request, reply) => {
      // Commit to an event-stream response
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Abort on client disconnect
      const controller = new AbortController();
      const onClose = (): void => {
        if (!raw.writableEnded) {
          controller.abort();
        }
      };
      raw.on('close', onClose);

      try {
        const body = parseChatBody(request.body);
        const stream = await freeChatService.streamChat(
          request.params.projectId,
          body,
          controller.signal,
        );

        for await (const delta of stream) {
          if (delta.kind === 'content' && delta.text.length > 0) {
            raw.write(sseFrame('delta', JSON.stringify(delta.text)));
          } else if (delta.kind === 'thinking' && delta.text.length > 0) {
            raw.write(sseFrame('thinking', JSON.stringify(delta.text)));
          }
        }

        raw.write(sseFrame('done'));
      } catch (err) {
        if (!controller.signal.aborted && !raw.writableEnded) {
          const { body: apiError } = toErrorResponse(err);
          raw.write(sseFrame('error', JSON.stringify(apiError)));
        }
      } finally {
        raw.removeListener('close', onClose);
        if (!raw.writableEnded) {
          raw.end();
        }
      }
    },
  );
}

export default registerFreeChatRoutes;
