import type { FastifyInstance, FastifyReply } from 'fastify';
import type { StoryControlInput } from '../types/StoryControl.js';
import type { StoryMemoryService } from '../services/memory/StoryMemoryService.js';
import { ServiceError } from '../services/ServiceError.js';
import { toErrorResponse } from './errorMapping.js';

interface ProjectParams { projectId: string }
interface ControlParams extends ProjectParams { controlId: string }
interface ControlBody { expectedRevision: number; control: StoryControlInput }

async function send(reply: FastifyReply, operation: () => Promise<unknown>) {
  try { return reply.send(await operation()); }
  catch (error) { const response = toErrorResponse(error); return reply.code(response.status).send(response.body); }
}
function controlBody(body: ControlBody | undefined): ControlBody {
  if (!body || !body.control || typeof body.control !== 'object' || Array.isArray(body.control)) throw ServiceError.validation('缺少作者记录。');
  return body;
}

export function registerStoryMemoryRoutes(app: FastifyInstance, service: StoryMemoryService): void {
  app.get<{ Params: ProjectParams; Querystring: { beforeUnit?: string; q?: string; topK?: string; maxContextChars?: string } }>(
    '/api/projects/:projectId/story-memory', (request, reply) => send(reply, () => service.query(request.params.projectId, {
      ...(request.query.beforeUnit !== undefined ? { beforeUnit: Number(request.query.beforeUnit) } : {}),
      ...(request.query.q !== undefined ? { q: request.query.q } : {}),
      ...(request.query.topK !== undefined ? { topK: Number(request.query.topK) } : {}),
      ...(request.query.maxContextChars !== undefined ? { maxContextChars: Number(request.query.maxContextChars) } : {}),
    })));
  app.post<{ Params: ProjectParams; Body: ControlBody }>('/api/projects/:projectId/story-controls', (request, reply) => send(reply, () => {
    const body = controlBody(request.body);
    if (body.control.id !== undefined) throw ServiceError.validation('新作者记录不能指定已有标识。');
    return service.upsert(request.params.projectId, body.control, body.expectedRevision);
  }));
  app.put<{ Params: ControlParams; Body: ControlBody }>('/api/projects/:projectId/story-controls/:controlId', (request, reply) => send(reply, () => {
    const body = controlBody(request.body);
    if (body.control.id !== undefined && body.control.id !== request.params.controlId) throw ServiceError.validation('作者记录标识不匹配。');
    return service.upsert(request.params.projectId, { ...body.control, id: request.params.controlId }, body.expectedRevision);
  }));
  app.delete<{ Params: ControlParams; Body: { expectedRevision: number } }>('/api/projects/:projectId/story-controls/:controlId', (request, reply) =>
    send(reply, () => service.remove(request.params.projectId, request.params.controlId, request.body?.expectedRevision)));
}
