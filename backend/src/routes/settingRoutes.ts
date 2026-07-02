/**
 * Fastify route module for structured settings — 人物 / 世界观 / 大纲
 * (Characters / WorldSettings / Outlines). Implements task 11.3 / Requirements
 * 3.1–3.6 by exposing the create / list / update / delete endpoints from the
 * design's HTTP API table on top of an injected {@link SettingService}.
 *
 * Dependency injection: the {@link SettingService} is passed in by the caller
 * (entrypoint wiring is task 13.1) rather than constructed here, so the same
 * routes can be registered against an in-memory/file-backed service in tests.
 *
 * Routes (base path `/api`; segments aligned with the frontend `apiClient`):
 *
 *   Characters     POST   /api/projects/:id/characters   {name, description}     → 201
 *                  GET    /api/projects/:id/characters                            → 200
 *                  PATCH  /api/characters/:id             {name?, description?}    → 200
 *                  DELETE /api/characters/:id                                      → 204
 *   WorldSettings  POST   /api/projects/:id/worldSettings {title, content}        → 201
 *                  GET    /api/projects/:id/worldSettings                          → 200
 *                  PATCH  /api/worldSettings/:id          {title?, content?}       → 200
 *                  DELETE /api/worldSettings/:id                                   → 204
 *   Outlines       POST   /api/projects/:id/outlines      {title, content}        → 201
 *                  GET    /api/projects/:id/outlines                               → 200
 *                  PATCH  /api/outlines/:id               {title?, content?}       → 200
 *                  DELETE /api/outlines/:id                                        → 204
 *
 * NOTE on path naming: the world-settings segment is `worldSettings` (camelCase)
 * to match `frontend/src/api/apiClient.ts`, which issues requests against
 * `/projects/:id/worldSettings` and `/worldSettings/:id`. Keeping the backend
 * aligned with the existing client avoids a breaking mismatch at wiring time.
 *
 * Error handling: domain errors thrown by the service (notably `NOT_FOUND` for
 * a missing entity id on update/delete → HTTP 404, and request-shape
 * `VALIDATION_ERROR` → HTTP 400) plus storage failures are converted to the
 * unified {@link ApiError} response via the shared {@link toErrorResponse}
 * helper (design: "Error Handling").
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Id } from '../types/index.js';
import { ServiceError } from '../services/ServiceError.js';
import type { SettingService } from '../services/setting/SettingService.js';
import { toErrorResponse } from './errorMapping.js';

/** Params shape for collection routes scoped under a project. */
interface ProjectParams {
  id: Id;
}

/** Params shape for item routes addressed by entity id. */
interface ItemParams {
  id: Id;
}

/**
 * Adapter describing one settings entity type for the generic route builder.
 * The three entity APIs on {@link SettingService} are structurally identical
 * (two string fields + create/list/update/remove), so each is wrapped into this
 * uniform shape to avoid triplicating the route handlers.
 */
interface EntityRouteConfig {
  /** URL path segment, e.g. `characters` / `worldSettings` / `outlines`. */
  segment: string;
  /** The two body field names in order, e.g. `['name', 'description']`. */
  fields: [string, string];
  create(projectId: Id, field1: string, field2: string): Promise<unknown>;
  list(projectId: Id): Promise<unknown[]>;
  update(id: Id, fields: Record<string, string>): Promise<unknown>;
  remove(id: Id): Promise<void>;
}

/** Narrow a request body to a plain JSON object or reject with VALIDATION_ERROR. */
function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ServiceError.validation('请求体必须为 JSON 对象。');
  }
  return body as Record<string, unknown>;
}

/** Read a required string field; reject with VALIDATION_ERROR if missing/non-string. */
function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string') {
    throw ServiceError.validation(`字段 ${field} 为必填字符串。`);
  }
  return value;
}

/** Read an optional string field; reject with VALIDATION_ERROR if present but non-string. */
function optionalString(obj: Record<string, unknown>, field: string): string | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw ServiceError.validation(`字段 ${field} 必须为字符串。`);
  }
  return value;
}

/**
 * Wrap a route handler so any thrown error (domain / storage / unexpected) is
 * mapped to the unified {@link ApiError} response with the matching HTTP status.
 */
function wrap(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      reply.code(status);
      return body;
    }
  };
}

/** Register the four CRUD routes for a single settings entity type. */
function registerEntityRoutes(app: FastifyInstance, config: EntityRouteConfig): void {
  const { segment, fields } = config;
  const [field1, field2] = fields;

  // Create — POST /api/projects/:id/<segment> → 201 with the created entity.
  app.post(
    `/api/projects/:id/${segment}`,
    wrap(async (request, reply) => {
      const { id: projectId } = request.params as ProjectParams;
      const body = asObject(request.body);
      const value1 = requireString(body, field1);
      const value2 = requireString(body, field2);
      const created = await config.create(projectId, value1, value2);
      reply.code(201);
      return created;
    }),
  );

  // List — GET /api/projects/:id/<segment> → 200 with the entity array.
  app.get(
    `/api/projects/:id/${segment}`,
    wrap(async (request) => {
      const { id: projectId } = request.params as ProjectParams;
      return await config.list(projectId);
    }),
  );

  // Update — PATCH /api/<segment>/:id → 200 with the updated entity (404 if absent).
  app.patch(
    `/api/${segment}/:id`,
    wrap(async (request) => {
      const { id } = request.params as ItemParams;
      const body = asObject(request.body);
      const patch: Record<string, string> = {};
      const v1 = optionalString(body, field1);
      if (v1 !== undefined) patch[field1] = v1;
      const v2 = optionalString(body, field2);
      if (v2 !== undefined) patch[field2] = v2;
      return await config.update(id, patch);
    }),
  );

  // Delete — DELETE /api/<segment>/:id → 204 no content (404 if absent).
  app.delete(
    `/api/${segment}/:id`,
    wrap(async (request, reply) => {
      const { id } = request.params as ItemParams;
      await config.remove(id);
      return reply.code(204).send();
    }),
  );
}

/**
 * Register all settings routes (characters / world settings / outlines) on the
 * given Fastify instance, backed by the injected {@link SettingService}.
 */
export function registerSettingRoutes(
  app: FastifyInstance,
  settingService: SettingService,
): void {
  const configs: EntityRouteConfig[] = [
    {
      segment: 'characters',
      fields: ['name', 'description'],
      create: (projectId, name, description) =>
        settingService.characters.create(projectId, name, description),
      list: (projectId) => settingService.characters.list(projectId),
      update: (id, patch) => settingService.characters.update(id, patch),
      remove: (id) => settingService.characters.remove(id),
    },
    {
      segment: 'worldSettings',
      fields: ['title', 'content'],
      create: (projectId, title, content) =>
        settingService.worldSettings.create(projectId, title, content),
      list: (projectId) => settingService.worldSettings.list(projectId),
      update: (id, patch) => settingService.worldSettings.update(id, patch),
      remove: (id) => settingService.worldSettings.remove(id),
    },
    {
      segment: 'outlines',
      fields: ['title', 'content'],
      create: (projectId, title, content) =>
        settingService.outlines.create(projectId, title, content),
      list: (projectId) => settingService.outlines.list(projectId),
      update: (id, patch) => settingService.outlines.update(id, patch),
      remove: (id) => settingService.outlines.remove(id),
    },
  ];

  for (const config of configs) {
    registerEntityRoutes(app, config);
  }
}
