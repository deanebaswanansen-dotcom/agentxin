import type { FastifyInstance } from 'fastify';

import type { ScriptExportFormat } from '../services/script/domain.js';
import {
  ScriptService,
  ScriptServiceError,
} from '../services/script/ScriptService.js';
import { ScriptConflictError } from '../services/script/ScriptStore.js';
import { StoreError } from '../store/StoreError.js';

interface ProjectParams { id: string }
interface EpisodeParams extends ProjectParams { number: string }
interface PutValueBody { expectedRevision?: unknown; value?: unknown }
interface PutItemsBody { expectedRevision?: unknown; items?: unknown }
interface RevisionBody { expectedRevision?: unknown }
interface ExportQuery {
  format?: string;
  startEpisode?: string;
  episodeCount?: string;
}

function revision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw ScriptServiceError.validation('expectedRevision必须是大于等于0的整数');
  }
  return value as number;
}

function episodeNumber(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 200) {
    throw ScriptServiceError.validation('集号必须是1到200的整数');
  }
  return number;
}

function positiveQueryInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 200) {
    throw ScriptServiceError.validation(`${label}必须是1到200的整数`);
  }
  return number;
}

function mapScriptError(error: unknown): {
  status: number;
  body: { error: { code: string; message: string; details?: unknown } };
} {
  if (error instanceof ScriptConflictError) {
    return {
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: error.message,
          details: {
            expectedRevision: error.expectedRevision,
            actualRevision: error.actualRevision,
          },
        },
      },
    };
  }
  if (error instanceof ScriptServiceError) {
    return {
      status: error.code === 'NOT_FOUND' ? 404 : 400,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
    };
  }
  if (error instanceof StoreError) {
    return {
      status: 500,
      body: { error: { code: 'STORE_ERROR', message: '短剧资料存储失败。' } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'STORE_ERROR', message: '服务器内部错误。' } },
  };
}

async function send<T>(reply: import('fastify').FastifyReply, operation: () => Promise<T>) {
  try {
    return reply.code(200).send(await operation());
  } catch (error) {
    const mapped = mapScriptError(error);
    return reply.code(mapped.status).send(mapped.body);
  }
}

export function registerScriptRoutes(app: FastifyInstance, service: ScriptService): void {
  app.get<{ Params: ProjectParams }>('/api/projects/:id/script-state', (request, reply) =>
    send(reply, async () => (await service.getState(request.params.id)) ?? {
      schemaVersion: 1,
      projectId: request.params.id,
      characters: [],
      episodeOutlines: [],
      episodes: [],
      continuity: { currentState: [], openThreads: [], wardrobeLedger: [] },
      updatedAt: new Date(0).toISOString(),
    }),
  );

  app.get<{ Params: ProjectParams }>('/api/projects/:id/script-plan', (request, reply) =>
    send(reply, () => service.getPlan(request.params.id)),
  );
  app.put<{ Params: ProjectParams; Body: PutValueBody }>('/api/projects/:id/script-plan', (request, reply) =>
    send(reply, () => service.savePlan(request.params.id, request.body?.value, revision(request.body?.expectedRevision))),
  );
  app.post<{ Params: ProjectParams; Body: RevisionBody }>('/api/projects/:id/script-plan/approve', (request, reply) =>
    send(reply, () => service.approvePlan(request.params.id, revision(request.body?.expectedRevision))),
  );

  app.get<{ Params: ProjectParams }>('/api/projects/:id/script-characters', (request, reply) =>
    send(reply, () => service.getCharacters(request.params.id)),
  );
  app.put<{ Params: ProjectParams; Body: PutItemsBody }>('/api/projects/:id/script-characters', (request, reply) =>
    send(reply, () => service.saveCharacters(request.params.id, request.body?.items, revision(request.body?.expectedRevision))),
  );

  app.get<{ Params: ProjectParams }>('/api/projects/:id/script-world', (request, reply) =>
    send(reply, () => service.getWorld(request.params.id)),
  );
  app.put<{ Params: ProjectParams; Body: PutValueBody }>('/api/projects/:id/script-world', (request, reply) =>
    send(reply, () => service.saveWorld(request.params.id, request.body?.value, revision(request.body?.expectedRevision))),
  );

  app.get<{ Params: ProjectParams }>('/api/projects/:id/script-outline', (request, reply) =>
    send(reply, () => service.getSeriesOutline(request.params.id)),
  );
  app.put<{ Params: ProjectParams; Body: PutValueBody }>('/api/projects/:id/script-outline', (request, reply) =>
    send(reply, () => service.saveSeriesOutline(request.params.id, request.body?.value, revision(request.body?.expectedRevision))),
  );

  app.get<{ Params: EpisodeParams }>('/api/projects/:id/episode-outlines/:number', (request, reply) =>
    send(reply, () => service.getEpisodeOutline(request.params.id, episodeNumber(request.params.number))),
  );
  app.put<{ Params: EpisodeParams; Body: PutValueBody }>('/api/projects/:id/episode-outlines/:number', (request, reply) =>
    send(reply, () => service.saveEpisodeOutline(request.params.id, episodeNumber(request.params.number), request.body?.value, revision(request.body?.expectedRevision))),
  );

  app.get<{ Params: ProjectParams }>('/api/projects/:id/script-episodes', (request, reply) =>
    send(reply, () => service.listEpisodes(request.params.id)),
  );
  app.get<{ Params: EpisodeParams }>('/api/projects/:id/script-episodes/:number', (request, reply) =>
    send(reply, () => service.getEpisode(request.params.id, episodeNumber(request.params.number))),
  );
  app.put<{ Params: EpisodeParams; Body: PutValueBody }>('/api/projects/:id/script-episodes/:number', (request, reply) =>
    send(reply, () => service.saveEpisode(request.params.id, episodeNumber(request.params.number), request.body?.value, revision(request.body?.expectedRevision))),
  );

  app.get<{ Params: ProjectParams; Querystring: ExportQuery }>('/api/projects/:id/script-export', async (request, reply) => {
    try {
      const format = request.query.format;
      if (format !== 'txt' && format !== 'md') {
        throw ScriptServiceError.validation('format必须是txt或md');
      }
      const result = await service.export(
        request.params.id,
        format as ScriptExportFormat,
        positiveQueryInteger(request.query.startEpisode, 'startEpisode'),
        positiveQueryInteger(request.query.episodeCount, 'episodeCount'),
      );
      reply.header('Content-Type', result.contentType);
      reply.header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
      );
      return reply.code(200).send(result.content);
    } catch (error) {
      const mapped = mapScriptError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
}

export default registerScriptRoutes;

