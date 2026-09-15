import type { FastifyInstance, FastifyReply } from 'fastify';
import type { MemorySyncRunner } from '../services/memory/MemorySyncRunner.js';
import { toErrorResponse } from './errorMapping.js';

interface ProjectParams { projectId: string }

async function send(reply: FastifyReply, operation: () => Promise<unknown>) {
  try { return reply.send(await operation()); }
  catch (error) {
    const response = toErrorResponse(error);
    return reply.code(response.status).send(response.body);
  }
}

export function registerMemorySyncRoutes(app: FastifyInstance, runner: MemorySyncRunner): void {
  app.get<{ Params: ProjectParams }>('/api/projects/:projectId/memory-sync', (request, reply) =>
    send(reply, () => runner.getStatus(request.params.projectId)));
  // Scope always comes from the validated request header, never a retry payload.
  app.post<{ Params: ProjectParams }>('/api/projects/:projectId/memory-sync/retry', (request, reply) =>
    send(reply, () => runner.retry(request.params.projectId)));
  app.get<{ Params: ProjectParams; Querystring: { beforeUnit?: string } }>('/api/projects/:projectId/source-memory', (request, reply) =>
    send(reply, () => runner.query(request.params.projectId, Number(request.query.beforeUnit))));
}
