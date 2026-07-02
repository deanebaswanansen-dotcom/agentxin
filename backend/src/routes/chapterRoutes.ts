/**
 * Fastify route module for chapter management (design: "HTTP API"; Requirements
 * 2.1–2.5). Exposes the章节 CRUD + reorder endpoints on top of the injected
 * {@link ChapterService}:
 *
 * | 方法 & 路径                              | 说明                | 需求 |
 * |------------------------------------------|---------------------|------|
 * | `POST   /api/projects/:id/chapters`      | 创建章节 `{title}`  | 2.1  |
 * | `GET    /api/projects/:id/chapters`      | 列表（position 升序）| 2.2  |
 * | `PATCH  /api/chapters/:id/content`       | 更新正文 `{content}`| 2.3  |
 * | `PATCH  /api/chapters/:id`               | 重命名标题 `{title}`| 新  |
 * | `DELETE /api/chapters/:id`               | 删除章节            | 2.4  |
 * | `PUT    /api/projects/:id/chapters/order`| 章节排序 `{orderedIds}` | 2.5 |
 *
 * The {@link ChapterService} is injected (never constructed here) so the
 * transport layer stays decoupled from persistence and the wiring in the
 * Fastify entrypoint (task 13.1) can supply a single shared instance.
 *
 * Error handling: every handler delegates domain/storage failures to the shared
 * {@link toErrorResponse} helper, which maps `VALIDATION_ERROR` → 400,
 * `NOT_FOUND` → 404, `STORE_ERROR` → 500, etc., into the unified
 * {@link import('../types/index.js').ApiError} response. Malformed request
 * bodies are rejected up-front with a `VALIDATION_ERROR` (400) before reaching
 * the service.
 */
import type { FastifyInstance } from 'fastify';

import type { ChapterService } from '../services/chapter/ChapterService.js';
import { ServiceError } from '../services/ServiceError.js';
import type { Id } from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';

interface ProjectParams {
  id: Id;
}

interface ChapterParams {
  id: Id;
}

interface CreateChapterBody {
  title?: unknown;
}

interface UpdateContentBody {
  content?: unknown;
}

interface ReorderBody {
  orderedIds?: unknown;
}

/** Narrow an unknown value to a string array (used for `orderedIds`). */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Register the chapter routes on the given Fastify instance using the injected
 * {@link ChapterService}. Mirrors `registerProjectRoutes` (task 11.1) so the
 * entrypoint can register all route groups uniformly.
 */
export function registerChapterRoutes(
  app: FastifyInstance,
  chapterService: ChapterService,
): void {
  // 2.1 创建章节
  app.post<{ Params: ProjectParams; Body: CreateChapterBody }>(
    '/api/projects/:id/chapters',
    async (request, reply) => {
      try {
        const { title } = request.body ?? {};
        if (typeof title !== 'string') {
          throw ServiceError.validation('章节标题不能为空。');
        }
        const chapter = await chapterService.create(request.params.id, title);
        return await reply.code(201).send(chapter);
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        return reply.code(status).send(body);
      }
    },
  );

  // 2.2 章节列表（按 position 升序，由服务/存储层保证）
  app.get<{ Params: ProjectParams }>(
    '/api/projects/:id/chapters',
    async (request, reply) => {
      try {
        const chapters = await chapterService.list(request.params.id);
        return await reply.code(200).send(chapters);
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        return reply.code(status).send(body);
      }
    },
  );

  // 2.3 更新章节正文
  app.patch<{ Params: ChapterParams; Body: UpdateContentBody }>(
    '/api/chapters/:id/content',
    async (request, reply) => {
      try {
        const { content } = request.body ?? {};
        if (typeof content !== 'string') {
          throw ServiceError.validation('章节正文必须为字符串。');
        }
        const chapter = await chapterService.updateContent(request.params.id, content);
        return await reply.code(200).send(chapter);
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        return reply.code(status).send(body);
      }
    },
  );

  // 新增：PATCH /api/chapters/:id 重命名标题（UI 章节管理）
  interface RenameChapterBody {
    title?: unknown;
  }
  app.patch<{ Params: ChapterParams; Body: RenameChapterBody }>(
    '/api/chapters/:id',
    async (request, reply) => {
      try {
        const title = request.body?.title;
        if (typeof title !== 'string') {
          throw ServiceError.validation('章节标题不能为空。');
        }
        const chapter = await chapterService.rename(request.params.id, title);
        return await reply.code(200).send(chapter);
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        return reply.code(status).send(body);
      }
    },
  );

  // 2.4 删除章节
  app.delete<{ Params: ChapterParams }>(
    '/api/chapters/:id',
    async (request, reply) => {
      try {
        await chapterService.remove(request.params.id);
        return await reply.code(204).send();
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        return reply.code(status).send(body);
      }
    },
  );

  // 2.5 章节排序
  app.put<{ Params: ProjectParams; Body: ReorderBody }>(
    '/api/projects/:id/chapters/order',
    async (request, reply) => {
      try {
        const orderedIds = request.body?.orderedIds;
        if (!isStringArray(orderedIds)) {
          throw ServiceError.validation('orderedIds 必须为字符串数组。');
        }
        await chapterService.reorder(request.params.id, orderedIds);
        return await reply.code(204).send();
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        return reply.code(status).send(body);
      }
    },
  );
}

export default registerChapterRoutes;
