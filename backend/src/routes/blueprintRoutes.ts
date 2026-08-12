/**
 * Fastify 路由模块：章节蓝图与分场景写作（design.md「HTTP API（REST + SSE）」，
 * 任务 11.1 / 11.2 / 11.3）。
 *
 * 本模块沿用既有 `registerXxxRoutes(app, service)` 注入模式（见 `projectRoutes.ts` /
 * `writingRoutes.ts`），由入口在 `buildServer` 中统一注册（任务 13.1）。蓝图领域服务
 * 一律通过依赖注入传入（从不在此构造），使传输层与持久化 / 模型代理解耦，便于测试。
 *
 * 路由分三组：
 *
 * 【REST：蓝图（任务 11.1）】
 * | 方法 & 路径                                                   | 说明           | 需求 |
 * |---------------------------------------------------------------|----------------|------|
 * | `POST /api/projects/:id/chapters/:chapterId/blueprint`        | 生成蓝图       | 1–5  |
 * | `GET  /api/chapters/:chapterId/blueprint`                     | 读取最新蓝图   | 5.2/5.4/5.6 |
 *
 * 【REST：合并与检查（任务 11.2）】
 * | 方法 & 路径                                          | 说明               | 需求 |
 * |------------------------------------------------------|--------------------|------|
 * | `POST /api/chapters/:chapterId/merge`                | 合并场景为整章正文 | 8    |
 * | `POST /api/chapters/:chapterId/word-count-check`     | 触发字数检查       | 9    |
 * | `GET  /api/chapters/:chapterId/word-count-report`    | 读取最新字数报告   | 13.3/13.5 |
 * | `POST /api/chapters/:chapterId/pacing-check`         | 触发节奏检查       | 10   |
 * | `GET  /api/chapters/:chapterId/pacing-report`        | 读取最新节奏报告   | 13.3/13.5 |
 *
 * 【SSE：分场景写作 / 扩写 / 重写 / 整章生成（任务 11.3）】
 * | 方法 & 路径                                                  | 说明           | 需求 |
 * |--------------------------------------------------------------|----------------|------|
 * | `POST /api/chapters/:chapterId/scenes/:sceneId/write`        | 分场景写作     | 6    |
 * | `POST /api/chapters/:chapterId/scenes/:sceneId/expand`       | 场景扩写       | 11   |
 * | `POST /api/chapters/:chapterId/scenes/:sceneId/rewrite`      | 场景重写       | 12   |
 * | `POST /api/chapters/:chapterId/generate`                     | 整章生成       | 7    |
 *
 * ## 错误映射
 *
 * REST 路由经共享 {@link toErrorResponse} 映射为统一 {@link ApiError} 与 HTTP 状态码
 * （与其他路由组一致）。SSE 路由严格沿用 `writingRoutes.ts` 的契约：一旦提交 `200`
 * 事件流响应，所有失败（含流前抛出的 `MODEL_NOT_CONFIGURED` / `NOT_FOUND` /
 * `VALIDATION_ERROR`）均经 `toErrorResponse` 取其 `ApiError` 主体，以 `event: error`
 * 帧输出，而非 HTTP 状态码。
 *
 * ## SSE 线缆契约（与 `frontend/src/api/apiClient.ts` 既有解析器逐字节一致）
 *
 * | 事件     | 帧                                              | 说明                          |
 * |----------|-------------------------------------------------|-------------------------------|
 * | 场景开始 | `event: scene\ndata: <JSON {sceneId}>\n\n`      | 仅整章生成，标记后续 delta 归属（7.1） |
 * | 文本增量 | `event: delta\ndata: <JSON 字符串>\n\n`         | 逐段转发提供商增量            |
 * | 完成     | `event: done\n\n`                               | 流正常结束（前端 resolve）    |
 * | 失败     | `event: error\ndata: <JSON ApiError>\n\n`       | 统一 {@link ApiError}         |
 *
 * delta / scene 数据均以 `JSON.stringify` 编码，保证含换行 / 控制字符的文本块在行式
 * SSE 中无损传输；API Key 绝不出现在任何帧中（需求 15.3）。
 *
 * 持久化与中止（需求 6.8 / 7.4 / 11.5 / 12.3）：分场景写作 / 扩写 / 重写在 `for await`
 * 中累加完整文本，**仅当未中止且流正常结束** 时调用对应编排的 `finalizeDraft` 写入完整
 * 场景正文；整章生成的持久化（逐场景 finalizeDraft + 合并写回章节正文）由
 * {@link ChapterWriter} 内部完成，路由不再额外持久化。
 */
import type { FastifyInstance } from 'fastify';

import { corsResponseHeaders } from '../cors.js';
import { startSseHeartbeat } from './sseHeartbeat.js';
import type { BlueprintService } from '../services/blueprint/BlueprintService.js';
import type { ChapterMerger } from '../services/blueprint/ChapterMerger.js';
import type { ChapterWriter } from '../services/blueprint/ChapterWriter.js';
import type { PacingChecker } from '../services/blueprint/PacingChecker.js';
import type { SceneExpander } from '../services/blueprint/SceneExpander.js';
import type { SceneRewriter } from '../services/blueprint/SceneRewriter.js';
import type { SceneWriter } from '../services/blueprint/SceneWriter.js';
import type { StreamDelta } from '../proxy/sseParser.js';
import type { WordCountChecker } from '../services/blueprint/WordCountChecker.js';
import { ServiceError } from '../services/ServiceError.js';
import type { DataStore } from '../store/DataStore.js';
import type {
  ExpandSceneBody,
  GenerateBlueprintBody,
  Id,
  RewriteSceneBody,
} from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';
import { ReasoningArtifactFilter } from '../services/text/reasoningSanitizer.js';

/**
 * 注入本路由组所需的全部蓝图领域服务与持久化抽象。
 *
 * 全部依赖均由入口（任务 13.1）实例化后注入，路由层从不在此构造，使其与具体存储 /
 * 模型代理解耦，便于在集成测试中替换。
 */
export interface BlueprintRouteServices {
  /** 蓝图生成 / 读取编排（任务 11.1）。 */
  blueprintService: BlueprintService;
  /** 单场景流式写作编排（SSE write，任务 11.3）。 */
  sceneWriter: SceneWriter;
  /** 整章流式生成编排（SSE generate，任务 11.3）。 */
  chapterWriter: ChapterWriter;
  /** 场景合并为整章正文编排（REST merge，任务 11.2）。 */
  chapterMerger: ChapterMerger;
  /** 字数检查编排（REST word-count-check，任务 11.2）。 */
  wordCountChecker: WordCountChecker;
  /** 节奏检查编排（REST pacing-check / pacing-report，任务 11.2）。 */
  pacingChecker: PacingChecker;
  /** 场景流式扩写编排（SSE expand，任务 11.3）。 */
  sceneExpander: SceneExpander;
  /** 场景流式重写编排（SSE rewrite，任务 11.3）。 */
  sceneRewriter: SceneRewriter;
  /**
   * 持久化抽象。`GET /word-count-report` 直接经 `getWordCountReportByChapter`
   * 读取最新已持久化的字数报告（WordCountChecker 不提供 getReport，需求 13.3/13.5）。
   */
  store: DataStore;
}

/** `POST /api/projects/:id/chapters/:chapterId/blueprint` 的路径参数。 */
interface ProjectChapterParams {
  id: Id;
  chapterId: Id;
}

/** 仅携带章节标识符的路径参数（合并 / 检查 / 整章生成）。 */
interface ChapterParams {
  chapterId: Id;
}

/** 携带章节 + 场景标识符的路径参数（分场景写作 / 扩写 / 重写）。 */
interface SceneParams {
  chapterId: Id;
  sceneId: string;
}

/**
 * 将单个 SSE 事件序列化为线缆帧。一帧为若干 `field: value` 行 + 末尾空行；payload-less
 * 事件（如 `done`）省略 `data` 行。与 `writingRoutes.ts` 的 `sseFrame` 完全一致。
 */
function sseFrame(event: string, data?: string): string {
  const lines = `event: ${event}\n`;
  return data === undefined ? `${lines}\n` : `${lines}data: ${data}\n\n`;
}

/**
 * 校验并收窄场景扩写请求体为 {@link ExpandSceneBody}。
 *
 * 仅做「必须为对象」的传输层守卫；`addWords` 的取值范围（1–100000 正整数）由
 * {@link SceneExpander.streamExpand} 校验（需求 11.2），保持领域服务为唯一校验源。
 * 在 SSE 处理器内（hijack 之后）调用，抛出的 `VALIDATION_ERROR` 经 `event: error` 帧输出。
 */
function parseExpandBody(raw: unknown): ExpandSceneBody {
  if (typeof raw !== 'object' || raw === null) {
    throw ServiceError.validation('扩写请求体必须为 JSON 对象。');
  }
  return { addWords: (raw as { addWords?: unknown }).addWords as number };
}

/**
 * 校验并收窄场景重写请求体为 {@link RewriteSceneBody}。
 *
 * 守卫 `instruction` 必须为字符串（避免下游对非字符串调用 `.trim()` 抛出非受控错误）；
 * 「非空」语义仍由 {@link SceneRewriter.streamRewrite} 校验（需求 12.5）。在 SSE 处理器内
 * （hijack 之后）调用，抛出的 `VALIDATION_ERROR` 经 `event: error` 帧输出。
 */
function parseRewriteBody(raw: unknown): RewriteSceneBody {
  if (typeof raw !== 'object' || raw === null) {
    throw ServiceError.validation('重写请求体必须为 JSON 对象。');
  }
  const { instruction } = raw as { instruction?: unknown };
  if (typeof instruction !== 'string') {
    throw ServiceError.validation('重写的修改要求不能为空');
  }
  return { instruction };
}

/**
 * 单场景流式 SSE 处理器（分场景写作 / 扩写 / 重写共用，需求 6 / 11 / 12）。
 *
 * 严格沿用 `writingRoutes.ts` 的 SSE 模式：
 * 1. `reply.hijack()` 接管原始套接字，写出 `200` 事件流响应头。
 * 2. 以 {@link AbortController} 监听 **`reply.raw` 的 `close`**（非 `request.raw`）：
 *    仅在 `!raw.writableEnded` 时 `abort`，从而区分正常结束与真实断开，避免请求体
 *    读完即误判为客户端断开。
 * 3. 调用 `start(signal)` 取得 `{ stream }`（流前的配置 / 存在性 / 请求体校验失败会在此
 *    抛出，被下方 catch 捕获并以 `event: error` 帧输出）。
 * 4. 在 `for await` 中累加完整正文并逐段 `event: delta` 转发（delta 经 `JSON.stringify`
 *    编码以无损传输换行 / 控制字符）。
 * 5. **仅当未中止且流正常结束** 时调用 `finalize(fullText)` 持久化完整场景正文
 *    （需求 6.8 / 11.5 / 12.3）；随后写 `event: done`。
 * 6. 任一阶段失败 → 经 {@link toErrorResponse} 取 `ApiError` 主体以 `event: error` 帧输出
 *    （客户端主动中止时套接字已不可写，无需输出）。
 *
 * @param reply Fastify 响应对象（将被 hijack）。
 * @param start 以取消信号发起流式补全，返回携带 `stream` 增量序列的对象。
 * @param finalize 流正常结束后持久化完整场景正文的回调（仅成功路径调用）。
 */
async function runSceneStream(
  reply: import('fastify').FastifyReply,
  start: (signal: AbortSignal) => Promise<{ stream: AsyncIterable<StreamDelta> }>,
  finalize: (content: string) => Promise<void>,
): Promise<void> {
  // 提交事件流响应：接管套接字并写出 SSE 响应头。
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsResponseHeaders(),
  });
  const stopHeartbeat = startSseHeartbeat(raw);

  // 客户端断开时取消编排（及出站提供商请求）。监听 RESPONSE 套接字的 'close'，
  // 以 writableEnded 区分正常结束与真实断开（与 writingRoutes 一致）。
  const controller = new AbortController();
  const onClose = (): void => {
    if (!raw.writableEnded) {
      controller.abort();
    }
  };
  raw.on('close', onClose);

  try {
    const { stream } = await start(controller.signal);
    const filter = new ReasoningArtifactFilter();

    // 累加完整正文并逐段转发增量（需求 6.4 等）。
    let fullText = '';
    for await (const delta of stream) {
      if (delta.kind === 'content' && delta.text.length > 0) {
        const cleaned = filter.push(delta.text);
        if (cleaned.length > 0) {
          fullText += cleaned;
          raw.write(sseFrame('delta', JSON.stringify(cleaned)));
        }
      } else if (delta.kind === 'thinking' && delta.text.length > 0) {
        raw.write(sseFrame('thinking', JSON.stringify(delta.text)));
      }
    }
    const tail = filter.flush();
    if (tail.length > 0) {
      fullText += tail;
      raw.write(sseFrame('delta', JSON.stringify(tail)));
    }

    // 仅当流正常结束且未被中止时持久化完整场景正文（需求 6.8 / 11.5 / 12.3）。
    if (!controller.signal.aborted) {
      await finalize(fullText);
    }

    // 正常完成哨兵（前端据此 resolve）。
    raw.write(sseFrame('done'));
  } catch (err) {
    // 流前抛出（MODEL_NOT_CONFIGURED / NOT_FOUND / VALIDATION_ERROR）与流中失败
    // （ProxyError → PROVIDER_ERROR、StoreError → STORE_ERROR）统一经 toErrorResponse
    // 取 ApiError 主体输出。客户端主动中止时套接字已不可写，无需输出。
    if (!controller.signal.aborted && !raw.writableEnded) {
      const { body: apiError } = toErrorResponse(err);
      raw.write(sseFrame('error', JSON.stringify(apiError)));
    }
  } finally {
    stopHeartbeat();
    raw.removeListener('close', onClose);
    if (!raw.writableEnded) {
      raw.end();
    }
  }
}

/**
 * 注册全部章节蓝图路由（REST + SSE）到给定 Fastify 实例。
 *
 * 与其他 `registerXxxRoutes` 模块对称，便于入口（任务 13.1）统一注册各路由组。
 *
 * @param app 目标 Fastify 实例（或封装的插件作用域）。
 * @param services 注入的蓝图领域服务与持久化抽象集合，见 {@link BlueprintRouteServices}。
 */
export function registerBlueprintRoutes(
  app: FastifyInstance,
  services: BlueprintRouteServices,
): void {
  const {
    blueprintService,
    sceneWriter,
    chapterWriter,
    chapterMerger,
    wordCountChecker,
    pacingChecker,
    sceneExpander,
    sceneRewriter,
    store,
  } = services;

  // =========================================================================
  // 11.1 蓝图 REST（需求 1.x, 2.x, 3.x, 4.x, 5.1, 5.2, 5.3, 5.4, 5.6）
  // =========================================================================

  // POST /api/projects/:id/chapters/:chapterId/blueprint —— 生成并持久化蓝图。
  // body 为 GenerateBlueprintBody（目标字数 + 章节需求文本）；请求体的字段 / 类型 /
  // 取值校验全部由 BlueprintService.generate 完成（需求 1.3/1.4/1.5）。
  // 以 AbortController 在客户端断开时取消向提供商的出站请求（需求 2.6 链路）。
  app.post<{ Params: ProjectChapterParams; Body: unknown }>(
    '/api/projects/:id/chapters/:chapterId/blueprint',
    async (request, reply) => {
      // 仅在客户端真正中途断开时取消向提供商的出站请求。监听 RESPONSE 套接字
      // （reply.raw）的 'close' 并以 writableEnded 守卫：`request.raw` 的 'close'
      // 在请求体读完后即触发，会在等待模型（尤其推理模型思考较久）期间误判为断开
      // 而提前 abort，导致 ProxyError「请求模型提供商超时或已被取消」。
      const controller = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableEnded) {
          controller.abort();
        }
      };
      reply.raw.on('close', onClose);
      try {
        const blueprint = await blueprintService.generate(
          request.params.chapterId,
          request.body as GenerateBlueprintBody,
          controller.signal,
        );
        return reply.code(200).send(blueprint);
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      } finally {
        reply.raw.removeListener('close', onClose);
      }
    },
  );

  // GET /api/chapters/:chapterId/blueprint —— 读取最新蓝图（需求 5.2/5.4/5.6）。
  app.get<{ Params: ChapterParams }>(
    '/api/chapters/:chapterId/blueprint',
    async (request, reply) => {
      try {
        const blueprint = await blueprintService.getByChapter(
          request.params.chapterId,
        );
        return reply.code(200).send(blueprint);
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  // =========================================================================
  // 11.2 合并与检查 REST（需求 8.x, 9.x, 10.x, 13.3, 13.5）
  // =========================================================================

  // POST /api/chapters/:chapterId/merge —— 合并场景为整章正文（需求 8）。
  app.post<{ Params: ChapterParams }>(
    '/api/chapters/:chapterId/merge',
    async (request, reply) => {
      try {
        const content = await chapterMerger.merge(request.params.chapterId);
        return reply.code(200).send({ content });
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  // POST /api/chapters/:chapterId/word-count-check —— 触发字数检查并持久化（需求 9）。
  app.post<{ Params: ChapterParams }>(
    '/api/chapters/:chapterId/word-count-check',
    async (request, reply) => {
      try {
        const report = await wordCountChecker.check(request.params.chapterId);
        return reply.code(200).send(report);
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  // GET /api/chapters/:chapterId/word-count-report —— 读取最新字数报告（需求 13.3/13.5）。
  // WordCountChecker 不提供 getReport，故直接经 store 读取；缺失 → NOT_FOUND。
  app.get<{ Params: ChapterParams }>(
    '/api/chapters/:chapterId/word-count-report',
    async (request, reply) => {
      try {
        const report = await store.getWordCountReportByChapter(
          request.params.chapterId,
        );
        if (!report) {
          throw ServiceError.notFound(
            `字数检查报告不存在：${request.params.chapterId}`,
          );
        }
        return reply.code(200).send(report);
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  // POST /api/chapters/:chapterId/pacing-check —— 触发节奏检查并持久化（需求 10）。
  app.post<{ Params: ChapterParams }>(
    '/api/chapters/:chapterId/pacing-check',
    async (request, reply) => {
      try {
        const report = await pacingChecker.check(request.params.chapterId);
        return reply.code(200).send(report);
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  // GET /api/chapters/:chapterId/pacing-report —— 读取最新节奏报告（需求 13.3/13.5）。
  app.get<{ Params: ChapterParams }>(
    '/api/chapters/:chapterId/pacing-report',
    async (request, reply) => {
      try {
        const report = await pacingChecker.getReport(request.params.chapterId);
        return reply.code(200).send(report);
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        return reply.code(status).send(body);
      }
    },
  );

  // =========================================================================
  // 11.3 SSE 路由（需求 6.x, 7.x, 11.x, 12.x）
  // =========================================================================

  // POST /api/chapters/:chapterId/scenes/:sceneId/write —— 分场景写作（流式，需求 6）。
  app.post<{ Params: SceneParams; Body: unknown }>(
    '/api/chapters/:chapterId/scenes/:sceneId/write',
    async (request, reply) => {
      const { chapterId, sceneId } = request.params;
      await runSceneStream(
        reply,
        (signal) => sceneWriter.streamScene(chapterId, sceneId, signal),
        (content) => sceneWriter.finalizeDraft(chapterId, sceneId, content),
      );
    },
  );

  // POST /api/chapters/:chapterId/scenes/:sceneId/expand —— 场景扩写（流式，需求 11）。
  app.post<{ Params: SceneParams; Body: unknown }>(
    '/api/chapters/:chapterId/scenes/:sceneId/expand',
    async (request, reply) => {
      const { chapterId, sceneId } = request.params;
      await runSceneStream(
        reply,
        (signal) =>
          sceneExpander.streamExpand(
            chapterId,
            sceneId,
            parseExpandBody(request.body),
            signal,
          ),
        (content) => sceneExpander.finalizeDraft(chapterId, sceneId, content),
      );
    },
  );

  // POST /api/chapters/:chapterId/scenes/:sceneId/rewrite —— 场景重写（流式，需求 12）。
  app.post<{ Params: SceneParams; Body: unknown }>(
    '/api/chapters/:chapterId/scenes/:sceneId/rewrite',
    async (request, reply) => {
      const { chapterId, sceneId } = request.params;
      await runSceneStream(
        reply,
        (signal) =>
          sceneRewriter.streamRewrite(
            chapterId,
            sceneId,
            parseRewriteBody(request.body),
            signal,
          ),
        (content) => sceneRewriter.finalizeDraft(chapterId, sceneId, content),
      );
    },
  );

  // POST /api/chapters/:chapterId/generate —— 整章生成（按序流式 + 合并，需求 7）。
  // 持久化（逐场景 finalizeDraft + 合并写回章节正文）由 ChapterWriter 内部完成，
  // 路由仅负责转发事件并以 scene / delta / done / error 帧输出。
  app.post<{ Params: ChapterParams }>(
    '/api/chapters/:chapterId/generate',
    async (request, reply) => {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsResponseHeaders(),
      });
      const stopHeartbeat = startSseHeartbeat(raw);

      // 客户端断开时取消整章生成。监听 RESPONSE 套接字（reply.raw）的 'close'，
      // 并以 writableEnded 区分正常结束与真实断开（与 writingRoutes 一致）。
      const controller = new AbortController();
      const onClose = (): void => {
        if (!raw.writableEnded) {
          controller.abort();
        }
      };
      raw.on('close', onClose);

      try {
        const events = chapterWriter.streamChapter(
          request.params.chapterId,
          controller.signal,
        );
        for await (const event of events) {
          if (event.type === 'scene') {
            // 场景边界：标记后续 delta 归属该场景（7.1）。
            raw.write(sseFrame('scene', JSON.stringify({ sceneId: event.sceneId })));
          } else if (event.text.length > 0) {
            // 当前场景的一段文本增量（7.2）。
            raw.write(sseFrame('delta', JSON.stringify(event.text)));
          }
        }
        // 全部场景生成并合并完成（7.3）。
        raw.write(sseFrame('done'));
      } catch (err) {
        // 流前 / 流中失败统一经 toErrorResponse 取 ApiError 主体输出（7.4）。
        // 客户端主动中止时套接字已不可写，无需输出。
        if (!controller.signal.aborted && !raw.writableEnded) {
          const { body: apiError } = toErrorResponse(err);
          raw.write(sseFrame('error', JSON.stringify(apiError)));
        }
      } finally {
        stopHeartbeat();
        raw.removeListener('close', onClose);
        if (!raw.writableEnded) {
          raw.end();
        }
      }
    },
  );
}

export default registerBlueprintRoutes;
