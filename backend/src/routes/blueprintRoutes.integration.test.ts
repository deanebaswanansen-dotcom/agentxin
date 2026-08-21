/**
 * 路由集成测试（task 11.4）：章节蓝图与分场景写作路由组
 * （{@link registerBlueprintRoutes}），经真实接线的 {@link buildServer} 验证。
 *
 * 接线方式（与 `e2e.integration.test.ts` 一致，全程离线）：
 * - 注入一个临时文件 {@link FileDataStore}（走真实持久化路径，不污染仓库 data/）。
 * - 注入一个 FAKE {@link ModelProxy}，其 `streamCompletion` 按 system 提示词分流：
 *   蓝图生成调用产出预设的合法蓝图 JSON；场景写作 / 扩写 / 重写调用产出任意正文分片。
 * - 调用 `buildServer(store, fakeProxy)` 得到 app，用 `app.inject` 测试 REST 与 SSE。
 *
 * 覆盖的验收标准：
 * - 5.4：生成蓝图针对不存在章节 → NOT_FOUND；GET 无蓝图 → NOT_FOUND。
 * - 6.6：SSE 写作针对不存在场景 → `event: error`（NOT_FOUND）。
 * - 8.4：合并存在未写作场景 → VALIDATION_ERROR，不修改章节正文。
 * - 9.4：字数检查产出并持久化报告（POST 后 GET 可读回）。
 * - 10.5 / 13.5：报告读取路由在无报告时 → NOT_FOUND。
 * - 11.6 / 12.4：扩写 / 重写针对不存在场景 → `event: error`（NOT_FOUND）。
 * - 13.5：GET word-count-report 无报告 → NOT_FOUND。
 *
 * 关于 `app.inject` 与 SSE：SSE 路由 hijack 了响应并直接写入 `reply.raw`，inject 会在
 * 流结束后 resolve，因此对 SSE 的断言针对累计的 `res.body` 文本（解析其帧），与既有
 * `writingRoutes.test.ts` / `e2e.integration.test.ts` 的做法一致。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../index.js';
import { FileDataStore } from '../store/FileDataStore.js';
import type { ModelProxy } from '../proxy/ModelProxy.js';
import type { StreamDelta } from '../proxy/sseParser.js';
import type {
  ChapterBlueprint,
  ChatMessage,
  ModelConfig,
  Scene,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// 测试夹具：FAKE 模型代理 + 合法蓝图构造
// ---------------------------------------------------------------------------

/**
 * FAKE 模型代理：绝不发起网络请求。按 system 提示词分流产出：
 * - 蓝图生成（system 含「章节结构编辑」）→ 产出预设的合法蓝图 JSON。
 * - 其余（场景写作 / 扩写 / 重写，system 含「写作助手」）→ 逐段产出场景正文分片。
 */
function fakeModelProxy(opts: {
  blueprintJson: string;
  sceneChunks: string[];
}): ModelProxy {
  return {
    streamCompletion(
      _config: ModelConfig,
      messages: ChatMessage[],
      _signal: AbortSignal,
    ): AsyncIterable<StreamDelta> {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const isBlueprint = system.includes('章节结构编辑');
      async function* gen(): AsyncGenerator<StreamDelta> {
        if (isBlueprint) {
          yield { kind: 'content' as const, text: opts.blueprintJson };
        } else {
          for (const chunk of opts.sceneChunks) {
            yield { kind: 'content' as const, text: chunk };
          }
        }
      }
      return gen();
    },
  };
}

/** 构造单个合法场景（target_words 为正整数）。 */
function makeScene(sceneId: string, targetWords: number): Scene {
  return {
    scene_id: sceneId,
    name: `场景 ${sceneId}`,
    target_words: targetWords,
    location: '某地',
    characters: ['林'],
    purpose: '推进剧情',
    emotion: '紧张',
    pacing: '中速',
    must_include: ['关键道具登场'],
    ending_state: '悬念收尾',
  };
}

/**
 * 构造一份通过 `validateBlueprint` 的合法蓝图核心（3 个场景，字数之和等于章节
 * target_words，偏差比例 0，scene_id 唯一且为正整数字数）。`chapter_id` 是占位符，
 * 生成路由会将其覆盖为目标章节标识符。
 */
function makeValidBlueprint(chapterId: string): ChapterBlueprint {
  return {
    chapter_id: chapterId,
    title: '测试章节',
    target_words: 300,
    main_goal: '推进主线冲突',
    tone: '紧张',
    pacing: '中速推进',
    required_plot_points: ['主角登场', '冲突爆发'],
    forbidden_points: ['主角意外死亡'],
    emotional_curve: '由平静到紧张',
    scenes: [
      makeScene('scene-1', 100),
      makeScene('scene-2', 100),
      makeScene('scene-3', 100),
    ],
    ending_hook: '留下悬念',
  };
}

/** 合法的模型配置（含 API Key，仅服务端存储）。 */
const MODEL_CONFIG: ModelConfig = {
  baseUrl: 'https://provider.example.com/v1',
  apiKey: 'sk-secret-key-1234',
  modelName: 'gpt-test',
};

function modelConfigHeaders(config: ModelConfig = MODEL_CONFIG): Record<string, string> {
  return { 'X-Agentxin-Model-Config': encodeURIComponent(JSON.stringify(config)) };
}

/** 从累计的 SSE 文本中解析所有 `delta` 事件并 JSON 解码其 data。 */
function parseDeltaEvents(body: string): string[] {
  return [...body.matchAll(/event: delta\ndata: (.*)\n\n/g)].map(
    (m) => JSON.parse(m[1]) as string,
  );
}

/** 从累计的 SSE 文本中解析首个 `error` 事件的 ApiError 主体（无则返回 null）。 */
function parseErrorEvent(
  body: string,
): { error: { code: string; message: string } } | null {
  const match = body.match(/event: error\ndata: (.*)\n\n/);
  return match ? (JSON.parse(match[1]) as { error: { code: string; message: string } }) : null;
}

// ---------------------------------------------------------------------------
// 测试套件
// ---------------------------------------------------------------------------

describe('blueprintRoutes 集成（buildServer + app.inject）', () => {
  let dir: string;
  let store: FileDataStore;
  let app: FastifyInstance;

  /** 场景写作分片，拼接后为完整场景正文。 */
  const SCENE_CHUNKS = ['这是', '场景', '正文'];
  const SCENE_TEXT = SCENE_CHUNKS.join(''); // '这是场景正文'

  /**
   * 每个用例使用全新的临时 store 与 app；蓝图 JSON 由 fake proxy 在蓝图生成调用时产出。
   * 占位 chapter_id 会被生成路由覆盖为目标章节标识符。
   */
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nwa-blueprint-routes-'));
    store = await FileDataStore.create(join(dir, 'store.json'));
    const blueprintJson = JSON.stringify(makeValidBlueprint('placeholder'));
    app = buildServer(store, fakeModelProxy({ blueprintJson, sceneChunks: SCENE_CHUNKS }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** 创建项目 + 章节，返回章节标识符。 */
  async function seedChapter(): Promise<string> {
    const project = await store.createProject('我的小说');
    const chapter = await store.createChapter(project.id, '第一章');
    return chapter.id;
  }

  // =========================================================================
  // 1. REST 蓝图生成成功（需求 1–5）
  // =========================================================================

  it('POST blueprint：合法请求 + fake 蓝图 → 200 且 chapter_id 绑定目标章节', async () => {
    await store.saveModelConfig(MODEL_CONFIG);
    const chapterId = await seedChapter();

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/_/chapters/${chapterId}/blueprint`,
      headers: modelConfigHeaders(),
      payload: { targetWords: 300, requirement: '主角在雨夜揭开真相。' },
    });

    expect(res.statusCode).toBe(200);
    const blueprint = res.json() as ChapterBlueprint;
    // chapter_id 被服务覆盖为目标章节标识符（占位符被替换）。
    expect(blueprint.chapter_id).toBe(chapterId);
    expect(blueprint.scenes).toHaveLength(3);
    expect(blueprint.scenes.map((s) => s.scene_id)).toEqual([
      'scene-1',
      'scene-2',
      'scene-3',
    ]);
    // 安全：响应不含 API Key 原文（需求 15.3）。
    expect(res.body).not.toContain(MODEL_CONFIG.apiKey);
  });

  // =========================================================================
  // 2. GET blueprint：无 → 404；有 → 200（需求 5.2 / 5.4）
  // =========================================================================

  it('GET blueprint：尚无蓝图 → 404 NOT_FOUND', async () => {
    const chapterId = await seedChapter();

    const res = await app.inject({
      method: 'GET',
      url: `/api/chapters/${chapterId}/blueprint`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('GET blueprint：已持久化 → 200 且返回该蓝图', async () => {
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));

    const res = await app.inject({
      method: 'GET',
      url: `/api/chapters/${chapterId}/blueprint`,
    });

    expect(res.statusCode).toBe(200);
    const blueprint = res.json() as ChapterBlueprint;
    expect(blueprint.chapter_id).toBe(chapterId);
    expect(blueprint.scenes).toHaveLength(3);
  });

  // =========================================================================
  // 3. 错误状态映射（需求 5.4 / 2.5 / 1.3）
  // =========================================================================

  it('POST blueprint：不存在章节 → 404 NOT_FOUND（已配置模型）', async () => {
    await store.saveModelConfig(MODEL_CONFIG);

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/_/chapters/does-not-exist/blueprint',
      headers: modelConfigHeaders(),
      payload: { targetWords: 300, requirement: '任意需求。' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('POST blueprint：未配置模型 → 409 MODEL_NOT_CONFIGURED', async () => {
    const chapterId = await seedChapter();

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/_/chapters/${chapterId}/blueprint`,
      payload: { targetWords: 300, requirement: '任意需求。' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MODEL_NOT_CONFIGURED');
  });

  it('POST blueprint：targetWords 越界 → 400 VALIDATION_ERROR', async () => {
    await store.saveModelConfig(MODEL_CONFIG);
    const chapterId = await seedChapter();

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/_/chapters/${chapterId}/blueprint`,
      headers: modelConfigHeaders(),
      payload: { targetWords: 50, requirement: '任意需求。' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('POST blueprint：chapter 不属于路径中的 project → 404 NOT_FOUND', async () => {
    await store.saveModelConfig(MODEL_CONFIG);
    const chapterId = await seedChapter();
    const other = await store.createProject('另一个项目');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${other.id}/chapters/${chapterId}/blueprint`,
      headers: modelConfigHeaders(),
      payload: { targetWords: 300, requirement: '任意需求。' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(await store.getChapterBlueprintByChapter(chapterId)).toBeUndefined();
  });

  // =========================================================================
  // 4. merge 路由（需求 8.2 / 8.4）
  // =========================================================================

  it('POST merge：存在未写作场景 → 400 VALIDATION_ERROR 且不改章节正文', async () => {
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));
    // 仅写入前两个场景，缺 scene-3 的正文。
    const now = new Date().toISOString();
    await store.saveSceneDraft({ chapterId, sceneId: 'scene-1', content: 'A', updatedAt: now });
    await store.saveSceneDraft({ chapterId, sceneId: 'scene-2', content: 'B', updatedAt: now });

    const res = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/merge`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    // 章节正文未被修改（仍为创建时的空字符串）。
    const chapter = await store.getChapter(chapterId);
    expect(chapter?.content).toBe('');
  });

  it('POST merge：全部场景已写作 → 200 且 {content} 为升序双换行拼接', async () => {
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));
    const now = new Date().toISOString();
    // 故意乱序写入，验证合并按 scene_id 升序拼接。
    await store.saveSceneDraft({ chapterId, sceneId: 'scene-3', content: 'C', updatedAt: now });
    await store.saveSceneDraft({ chapterId, sceneId: 'scene-1', content: 'A', updatedAt: now });
    await store.saveSceneDraft({ chapterId, sceneId: 'scene-2', content: 'B', updatedAt: now });

    const res = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/merge`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe('A\n\nB\n\nC');
    // 合并后的整章正文已写回章节（需求 8.3）。
    const chapter = await store.getChapter(chapterId);
    expect(chapter?.content).toBe('A\n\nB\n\nC');
  });

  it('POST merge：按 blueprint.scenes 数组顺序拼接，不按 scene_id 再排序', async () => {
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint({
      ...makeValidBlueprint(chapterId),
      scenes: [
        makeScene('scene-3', 100),
        makeScene('scene-2', 100),
        makeScene('scene-1', 100),
      ],
    });
    const now = new Date().toISOString();
    await store.saveSceneDraft({ chapterId, sceneId: 'scene-1', content: 'A', updatedAt: now });
    await store.saveSceneDraft({ chapterId, sceneId: 'scene-2', content: 'B', updatedAt: now });
    await store.saveSceneDraft({ chapterId, sceneId: 'scene-3', content: 'C', updatedAt: now });

    const res = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/merge`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe('C\n\nB\n\nA');
  });

  // =========================================================================
  // 5. 字数检查 / 报告读取（需求 9.4 / 13.5）
  // =========================================================================

  it('POST word-count-check → 200 报告；随后 GET word-count-report → 200 读回', async () => {
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));
    const now = new Date().toISOString();
    await store.saveSceneDraft({ chapterId, sceneId: 'scene-1', content: '短', updatedAt: now });

    const checkRes = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/word-count-check`,
    });
    expect(checkRes.statusCode).toBe(200);
    const report = checkRes.json() as {
      chapterId: string;
      scenes: { sceneId: string; actualWords: number }[];
      chapterTargetWords: number;
    };
    expect(report.chapterId).toBe(chapterId);
    expect(report.scenes).toHaveLength(3);
    expect(report.chapterTargetWords).toBe(300);
    // 未写作场景的实际字数计为 0（需求 9.1）。
    const scene2 = report.scenes.find((s) => s.sceneId === 'scene-2');
    expect(scene2?.actualWords).toBe(0);

    // 报告已持久化，可读回（需求 13.3）。
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/chapters/${chapterId}/word-count-report`,
    });
    expect(getRes.statusCode).toBe(200);
    expect((getRes.json() as { chapterId: string }).chapterId).toBe(chapterId);
  });

  it('GET word-count-report：尚无报告 → 404 NOT_FOUND（需求 13.5）', async () => {
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));

    const res = await app.inject({
      method: 'GET',
      url: `/api/chapters/${chapterId}/word-count-report`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  // =========================================================================
  // 6. SSE 写作路由（需求 6.4 / 6.6）
  // =========================================================================

  it('POST scenes/:sceneId/write：合法 → text/event-stream 含 delta 与 done 帧并持久化', async () => {
    await store.saveModelConfig(MODEL_CONFIG);
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));

    const res = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/scenes/scene-1/write`,
      headers: modelConfigHeaders(),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // delta 帧逐段转发，拼接等于完整场景正文（需求 6.4）。
    const deltas = parseDeltaEvents(res.body);
    expect(deltas).toEqual(SCENE_CHUNKS);
    expect(deltas.join('')).toBe(SCENE_TEXT);
    // 正常结束哨兵帧，无 error 帧。
    expect(res.body).toContain('event: done\n\n');
    expect(res.body).not.toContain('event: error');
    // 流正常结束后持久化完整场景正文（需求 6.5）。
    const draft = await store.getSceneDraft(chapterId, 'scene-1');
    expect(draft?.content).toBe(SCENE_TEXT);
    // 安全：帧中不含 API Key 原文（需求 15.3）。
    expect(res.body).not.toContain(MODEL_CONFIG.apiKey);
  });

  it('POST scenes/:sceneId/write：场景不存在 → event: error（NOT_FOUND）且不持久化', async () => {
    await store.saveModelConfig(MODEL_CONFIG);
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));

    const res = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/scenes/scene-404/write`,
      headers: modelConfigHeaders(),
      payload: {},
    });

    // 一旦提交事件流响应，失败经 event: error 帧输出而非 HTTP 状态码（需求 6.6）。
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const apiError = parseErrorEvent(res.body);
    expect(apiError?.error.code).toBe('NOT_FOUND');
    expect(res.body).not.toContain('event: done');
    // 未写作场景未被持久化。
    const draft = await store.getSceneDraft(chapterId, 'scene-404');
    expect(draft).toBeUndefined();
  });

  // =========================================================================
  // 7. SSE 扩写 / 重写路由错误映射（需求 11.6 / 12.4）
  // =========================================================================

  it('POST scenes/:sceneId/expand：场景不存在 → event: error（NOT_FOUND）', async () => {
    await store.saveModelConfig(MODEL_CONFIG);
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));

    const res = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/scenes/scene-404/expand`,
      headers: modelConfigHeaders(),
      payload: { addWords: 100 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(parseErrorEvent(res.body)?.error.code).toBe('NOT_FOUND');
    expect(res.body).not.toContain('event: done');
  });

  it('POST scenes/:sceneId/write：空正文 → event: error 且不持久化空草稿', async () => {
    await app.close();
    app = buildServer(
      store,
      fakeModelProxy({
        blueprintJson: JSON.stringify(makeValidBlueprint('placeholder')),
        sceneChunks: ['   ', '\n\t'],
      }),
    );
    await app.ready();

    await store.saveModelConfig(MODEL_CONFIG);
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));

    const res = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/scenes/scene-1/write`,
      headers: modelConfigHeaders(),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(parseErrorEvent(res.body)?.error.code).toBe('VALIDATION_ERROR');
    expect(res.body).not.toContain('event: done');
    expect(await store.getSceneDraft(chapterId, 'scene-1')).toBeUndefined();
  });

  it('POST scenes/:sceneId/expand：空白草稿视为尚未写作', async () => {
    await store.saveModelConfig(MODEL_CONFIG);
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));
    await store.saveSceneDraft({
      chapterId,
      sceneId: 'scene-1',
      content: '   \n',
      updatedAt: new Date().toISOString(),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/scenes/scene-1/expand`,
      headers: modelConfigHeaders(),
      payload: { addWords: 100 },
    });

    expect(res.statusCode).toBe(200);
    expect(parseErrorEvent(res.body)?.error.code).toBe('VALIDATION_ERROR');
    expect(res.body).not.toContain('event: done');
  });

  it('POST scenes/:sceneId/rewrite：空白草稿视为尚未写作', async () => {
    await store.saveModelConfig(MODEL_CONFIG);
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));
    await store.saveSceneDraft({
      chapterId,
      sceneId: 'scene-1',
      content: '\t  ',
      updatedAt: new Date().toISOString(),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/scenes/scene-1/rewrite`,
      headers: modelConfigHeaders(),
      payload: { instruction: '让节奏更紧凑' },
    });

    expect(res.statusCode).toBe(200);
    expect(parseErrorEvent(res.body)?.error.code).toBe('VALIDATION_ERROR');
    expect(res.body).not.toContain('event: done');
  });

  it('POST scenes/:sceneId/rewrite：场景不存在 → event: error（NOT_FOUND）', async () => {
    await store.saveModelConfig(MODEL_CONFIG);
    const chapterId = await seedChapter();
    await store.saveChapterBlueprint(makeValidBlueprint(chapterId));

    const res = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/scenes/scene-404/rewrite`,
      headers: modelConfigHeaders(),
      payload: { instruction: '让节奏更紧凑' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(parseErrorEvent(res.body)?.error.code).toBe('NOT_FOUND');
    expect(res.body).not.toContain('event: done');
  });
});
