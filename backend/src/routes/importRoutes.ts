import type { FastifyInstance } from 'fastify';
import type { NovelImportService } from '../services/import/NovelImportService.js';
import type { Id, ImportNovelRequest } from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';

interface ImportParams {
  id: Id;
}

const NOVEL_IMPORT_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export function registerImportRoutes(
  app: FastifyInstance,
  importService: NovelImportService,
): void {
  app.post<{ Params: ImportParams; Body: ImportNovelRequest }>(
    '/api/projects/:id/import/novel',
    { bodyLimit: NOVEL_IMPORT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const result = await importService.organizeIntoProject(
          request.params.id,
          request.body,
        );
        return reply.code(200).send(result);
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );
}

export default registerImportRoutes;
