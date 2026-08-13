import type { FastifyInstance } from 'fastify';

import type { ReferenceAnalysisService } from '../services/reference/ReferenceAnalysisService.js';
import { corsResponseHeaders } from '../cors.js';
import type {
  Id,
  ReferenceAnalyzeRequest,
  ReferenceImportRequest,
  ReferenceTransferRequest,
  SimilarityCheckRequest,
} from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';
import { startSseHeartbeat } from './sseHeartbeat.js';

interface IdParams {
  id: Id;
}

interface ProjectParams {
  projectId: Id;
}

// Reference text is capped at 1.5 million characters by the service. UTF-8
// Chinese text can require roughly three bytes per character, so the default
// Fastify 1 MiB body limit rejects valid books before validation runs.
const REFERENCE_IMPORT_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

function sseFrame(event: string, data?: string): string {
  const head = `event: ${event}\n`;
  return data === undefined ? `${head}\n` : `${head}data: ${data}\n\n`;
}

export function registerReferenceRoutes(
  app: FastifyInstance,
  service: ReferenceAnalysisService,
): void {
  app.get('/api/references', async (_request, reply) => {
    try {
      return reply.code(200).send(service.list());
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

  app.post<{ Body: ReferenceImportRequest }>(
    '/api/references/import',
    { bodyLimit: REFERENCE_IMPORT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const result = await service.importText(request.body ?? { text: '' });
        return reply.code(201).send(result);
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.get<{ Params: IdParams }>('/api/references/:id', async (request, reply) => {
    try {
      return reply.code(200).send(service.get(request.params.id));
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

  app.post<{ Params: IdParams; Body: ReferenceAnalyzeRequest }>(
    '/api/references/:id/analyze',
    async (request, reply) => {
      try {
        const controller = new AbortController();
        const raw = reply.raw;
        const onClose = (): void => {
          if (!raw.writableEnded) controller.abort();
        };
        raw.on('close', onClose);
        try {
          const result = await service.analyze(
            request.params.id,
            controller.signal,
            request.body ?? {},
          );
          return reply.code(200).send(result);
        } finally {
          raw.removeListener('close', onClose);
        }
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  // Reference analysis may perform multiple model passes (summary, extraction,
  // and chapter outfit continuity). Keep the connection active while those
  // passes run so the browser and reverse proxies do not turn a healthy job
  // into a 45-second timeout.
  app.post<{ Params: IdParams; Body: ReferenceAnalyzeRequest }>(
    '/api/references/:id/analyze-stream',
    async (request, reply) => {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsResponseHeaders(),
      });
      const stopHeartbeat = startSseHeartbeat(raw);
      const controller = new AbortController();
      const onClose = (): void => {
        if (!raw.writableEnded) controller.abort();
      };
      raw.on('close', onClose);

      try {
        if (!raw.writableEnded) {
          raw.write(
            sseFrame(
              'progress',
              JSON.stringify({ message: '参考小说拆解已开始，正在提取剧情、人物与大纲…' }),
            ),
          );
        }
        const result = await service.analyze(
          request.params.id,
          controller.signal,
          request.body ?? {},
        );
        if (!controller.signal.aborted && !raw.writableEnded) {
          raw.write(sseFrame('result', JSON.stringify(result)));
          raw.write(sseFrame('done'));
        }
      } catch (error) {
        if (!controller.signal.aborted && !raw.writableEnded) {
          const { body } = toErrorResponse(error);
          raw.write(sseFrame('error', JSON.stringify(body)));
        }
      } finally {
        stopHeartbeat();
        raw.removeListener('close', onClose);
        if (!raw.writableEnded) raw.end();
      }
    },
  );

  app.post<{ Params: IdParams }>('/api/references/:id/purge-raw', async (request, reply) => {
    try {
      const result = await service.purgeRawText(request.params.id);
      return reply.code(200).send(result);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

  app.delete<{ Params: IdParams }>('/api/references/:id', async (request, reply) => {
    try {
      await service.remove(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

  app.post<{ Params: ProjectParams; Body: ReferenceTransferRequest }>(
    '/api/projects/:projectId/reference-transfer',
    async (request, reply) => {
      try {
        const controller = new AbortController();
        const raw = reply.raw;
        const onClose = (): void => {
          if (!raw.writableEnded) controller.abort();
        };
        raw.on('close', onClose);
        try {
          const result = await service.transferToProject(
            request.params.projectId,
            request.body ?? { referenceId: '', dimensions: [] },
            controller.signal,
          );
          return reply.code(200).send(result);
        } finally {
          raw.removeListener('close', onClose);
        }
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/api/projects/:projectId/reference-transfer',
    async (request, reply) => {
      try {
        const prompt = service.buildActiveTransferPrompt(request.params.projectId);
        return reply.code(200).send({
          projectId: request.params.projectId,
          active: prompt.length > 0,
          prompt,
        });
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.post<{ Params: ProjectParams; Body: SimilarityCheckRequest }>(
    '/api/projects/:projectId/similarity/check',
    async (request, reply) => {
      try {
        const result = await service.checkSimilarity(
          request.params.projectId,
          request.body ?? { referenceId: '' },
        );
        return reply.code(200).send(result);
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.post<{ Body: SimilarityCheckRequest }>('/api/similarity/check', async (request, reply) => {
    try {
      const result = await service.checkSimilarity(undefined, request.body ?? { referenceId: '' });
      return reply.code(200).send(result);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });
}
