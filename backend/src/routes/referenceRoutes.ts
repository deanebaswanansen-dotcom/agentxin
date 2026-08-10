import type { FastifyInstance } from 'fastify';

import type { ReferenceAnalysisService } from '../services/reference/ReferenceAnalysisService.js';
import type {
  Id,
  ReferenceAnalyzeRequest,
  ReferenceImportRequest,
  ReferenceTransferRequest,
  SimilarityCheckRequest,
} from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';

interface IdParams {
  id: Id;
}

interface ProjectParams {
  projectId: Id;
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

  app.post<{ Body: ReferenceImportRequest }>('/api/references/import', async (request, reply) => {
    try {
      const result = await service.importText(request.body ?? { text: '' });
      return reply.code(201).send(result);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

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
