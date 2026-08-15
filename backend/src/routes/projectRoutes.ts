/**
 * Fastify route group for the project endpoints (design: HTTP API table —
 * `POST/GET /api/projects`, `PATCH/DELETE /api/projects/:id`).
 *
 * Routes (task 11.1):
 *   - `POST   /api/projects`     — create a project from `{ name }`. On success
 *     returns HTTP 201 with the new {@link Project} (its `id` included)
 *     (Requirement 1.1). An empty / whitespace-only name is rejected by the
 *     service with `VALIDATION_ERROR` → HTTP 400 (Requirement 1.5).
 *   - `GET    /api/projects`     — list all projects' `{ id, name }` with HTTP
 *     200 (Requirement 1.2).
 *   - `PATCH  /api/projects/:id` — rename a project from `{ name }`. Returns the
 *     updated {@link Project} with HTTP 200 (Requirement 1.4). Unknown id →
 *     `NOT_FOUND` (HTTP 404, Requirement 1.6); empty name → `VALIDATION_ERROR`
 *     (HTTP 400).
 *   - `DELETE /api/projects/:id` — delete a project and its associated entities
 *     (cascade handled by the store), returning HTTP 204 with no body
 *     (Requirement 1.3). Unknown id → `NOT_FOUND` (HTTP 404, Requirement 1.6).
 *
 * The {@link ProjectService} is injected (dependency injection) rather than
 * constructed here, so wiring (task 13.1) controls the concrete store-backed
 * instance and tests can supply their own. Errors are funneled through the
 * shared {@link toErrorResponse} helper so this group emits the unified
 * {@link ApiError} shape with the correct HTTP status.
 */
import type { FastifyInstance } from 'fastify';
import type { ProjectService } from '../services/project/ProjectService.js';
import type { ProjectKind } from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';

/** Request body accepted by `POST /api/projects` and `PATCH /api/projects/:id`. */
interface ProjectNameBody {
  name?: unknown;
  kind?: unknown;
}

/** Route params carrying a project id. */
interface ProjectIdParams {
  id: string;
}

/**
 * Coerce an unknown body field into a string. Missing/non-string values become
 * the empty string so they fail the service's non-empty validation
 * (`VALIDATION_ERROR` → 400) rather than throwing a generic type error.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Register the project routes on the given Fastify instance.
 *
 * @param app - the Fastify instance (or encapsulated plugin scope) to register on.
 * @param projectService - injected domain service performing validation,
 *   existence checks and cascade deletion.
 */
export function registerProjectRoutes(
  app: FastifyInstance,
  projectService: ProjectService,
): void {
  // POST /api/projects — create a project (Requirements 1.1, 1.5).
  app.post<{ Body: ProjectNameBody }>('/api/projects', async (request, reply) => {
    try {
      const name = asString(request.body?.name);
      const rawKind = request.body?.kind;
      const kind = (rawKind === undefined ? 'novel' : asString(rawKind)) as ProjectKind;
      const project = await projectService.create(name, kind);
      return reply.code(201).send(project);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

  // GET /api/projects — list all projects' id + name (Requirement 1.2).
  app.get('/api/projects', async (_request, reply) => {
    try {
      const projects = await projectService.list();
      return reply.code(200).send(projects);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

  app.get<{ Params: ProjectIdParams }>('/api/projects/:id', async (request, reply) => {
    try {
      return reply.code(200).send(await projectService.get(request.params.id));
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

  // PATCH /api/projects/:id — rename a project (Requirements 1.4, 1.6).
  app.patch<{ Params: ProjectIdParams; Body: ProjectNameBody }>(
    '/api/projects/:id',
    async (request, reply) => {
      try {
        const name = asString(request.body?.name);
        const project = await projectService.rename(request.params.id, name);
        return reply.code(200).send(project);
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  // DELETE /api/projects/:id — delete a project and cascade (Requirements 1.3, 1.6).
  app.delete<{ Params: ProjectIdParams }>('/api/projects/:id', async (request, reply) => {
    try {
      await projectService.remove(request.params.id);
      // 204 No Content: deletion succeeded, nothing to return.
      return reply.code(204).send();
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });
}

export default registerProjectRoutes;
