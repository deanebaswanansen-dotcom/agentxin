/**
 * 章节蓝图模块端到端集成测试（task 13.3）。
 *
 * 通过真实接线的 Fastify 应用（{@link buildServer}）以 `app.inject` 串联验证蓝图
 * 模块的完整工作流，不触达网络：
 *
 *   创建项目 → 创建章节 → 保存模型配置 → 生成蓝图（mock 提供商）→
 *   分场景写作（SSE）→ 合并整章 → 字数检查
 *
 * 接线方式（与 `e2e.integration.test.ts` / `blueprintRoutes.integration.test.ts` 一致）：
 * - 注入一个临时文件 {@link FileDataStore}（走真实持久化路径，不污染仓库 data/），
 *   每个用例 `mkdtemp` 新建、`afterEach` `rm` 清理。
 * - 注入一个 FAKE {@link ModelProxy}，其 `streamCompletion` 按 system 提示词分流：
 *   蓝图生成调用（system 含「章节结构编辑」）产出预设的合法蓝图 JSON；
 *   场景写作调用（system 含「写作助手」）按目标场景逐段产出该场景的正文分片。
 * - 调用 `buildServer(store, fakeProxy)` 得到 app，用 `app.inject` 串联 REST 与 SSE。
 *
 * 覆盖的验收标准：
 * - 5.1：生成蓝图持久化并关联章节，蓝图含 3 个场景。
 * - 6.5：每个场景流式写作正常结束后，完整场景正文被持久化。
 * - 7.3 / 8.3：合并按 scene_id 升序拼接各场景正文，并写回章节正文字段。
 * - 9.4：字数检查产出报告（场景级 + 整章级）。
 * - 14.5：合并后的整章正文可被读回（前端据此「采用」写入章节编辑器的数据来源）。
 * - 15.3：全程响应体不含 API Key 原文。
 *
 * 关于 `app.inject` 与 SSE：SSE 路由 hijack 了响应并直接写入 `reply.raw`，inject 会在
 * 流结束后 resolve，因此对 SSE 的断言针对累计的 `res.body` 文本（解析其帧），与既有
 * `e2e.integration.test.ts` / `blueprintRoutes.integration.test.ts` 的做法一致。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from './index.js';
import { FileDataStore } from './store/FileDataStore.js';
import type { ModelProxy } from './proxy/ModelProxy.js';
import type { StreamDelta } from './proxy/sseParser.js';
import type {
  ChapterBlueprint,
  ChatMessage,
  ModelConfig,
  Scene,
  WordCountReport,
} from './types/index.js';

// ---------------------------------------------------------------------------
// 测试夹具：场景文本、FAKE 模型代理、合法蓝图、SSE 解析助手
// ---------------------------------------------------------------------------

/** 三个场景的写作分片；拼接后即各场景完整正文。内容互不相同以便验证合并顺序。 */
const SCENE_CHUNKS: Record<string, string[]> = {
  'scene-1': ['场景一', '的正文'],
  'scene-2': ['场景二', '的正文'],
  'scene-3': ['场景三', '的正文'],
};

/** scene_id → 完整场景正文（分片拼接）。 */
const SCENE_TEXT: Record<string, string> = Object.fromEntries(
  Object.entries(SCENE_CHUNKS).map(([id, chunks]) => [id, chunks.join('')]),
);

/** 合法的模型配置（含 API Key，仅服务端存储，绝不外泄）。 */
const MODEL_CONFIG: ModelConfig = {
  baseUrl: 'https://provider.example.com/v1',
  apiKey: 'sk-secret-key-1234',
  modelName: 'gpt-test',
};

/**
 * 从写作调用的对话消息中识别目标场景标识符。
 *
 * 仅目标场景的「场景蓝图约束」段会带出其 `scene_id`（经场景名「场景 scene-N」），
 * 上一场景正文为纯散文不含 `scene-N` 字样，因此扫描可唯一确定目标场景。
 */
function pickSceneId(messages: ChatMessage[]): string | undefined {
  const user = messages.find((m) => m.role === 'user')?.content ?? '';
  return Object.keys(SCENE_CHUNKS).find((id) => user.includes(id));
}

/**
 * FAKE 模型代理：绝不发起网络请求。按 system 提示词分流产出：
 * - 蓝图生成（system 含「章节结构编辑」）→ 产出预设的合法蓝图 JSON。
 * - 场景写作（system 含「写作助手」）→ 依据目标场景逐段产出该场景的正文分片。
 */
function fakeModelProxy(blueprintJson: string): ModelProxy {
  return {
    streamCompletion(
      _config: ModelConfig,
      messages: ChatMessage[],
      _signal: AbortSignal,
    ): AsyncIterable<StreamDelta> {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const isBlueprint = system.includes('章节结构编辑');
      const sceneId = pickSceneId(messages);
      async function* gen(): AsyncGenerator<StreamDelta> {
        if (isBlueprint) {
          yield { kind: 'content' as const, text: blueprintJson };
          return;
        }
        // 场景写作：逐段产出目标场景正文（未识别场景则不产出任何增量）。
        const chunks = sceneId ? SCENE_CHUNKS[sceneId] : [];
        for (const chunk of chunks) {
          yield { kind: 'content' as const, text: chunk };
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
 * 构造一份通过 `validateBlueprint` 的合法蓝图（3 个场景，各场景 target_words 之和
 * 等于章节 target_words，偏差比例 0，scene_id 唯一且为正整数字数）。`chapter_id`
 * 为占位符，生成路由会将其覆盖为目标章节标识符（需求 5.1）。
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

/** 从累计的 SSE 文本中解析所有 `delta` 事件并 JSON 解码其 data。 */
function parseDeltaEvents(body: string): string[] {
  return [...body.matchAll(/event: delta\ndata: (.*)\n\n/g)].map(
    (m) => JSON.parse(m[1]) as string,
  );
}

// ---------------------------------------------------------------------------
// 测试套件
// ---------------------------------------------------------------------------

describe('端到端集成：项目→章节→蓝图（mock 提供商）→分场景写作→合并→字数检查', () => {
  let dir: string;
  let store: FileDataStore;
  let app: FastifyInstance;

  /** 蓝图中场景的 scene_id 升序，分场景写作与合并均按此顺序。 */
  const SCENE_IDS = ['scene-1', 'scene-2', 'scene-3'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nwa-blueprint-e2e-'));
    store = await FileDataStore.create(join(dir, 'store.json'));
    const blueprintJson = JSON.stringify(makeValidBlueprint('placeholder'));
    app = buildServer(store, fakeModelProxy(blueprintJson));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('完整流程贯通且全程响应不含 API Key 原文（Req 5.1, 6.5, 7.3, 8.3, 9.4, 14.5, 15.3）', async () => {
    // === 1) 创建项目 → 拿 id ===
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '我的小说' },
    });
    expect(projRes.statusCode).toBe(201);
    const projectId = projRes.json().id as string;
    expect(projectId).toBeTruthy();
    expect(projRes.body).not.toContain(MODEL_CONFIG.apiKey);

    // === 2) 创建章节 → 拿 chapterId ===
    const chapRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      payload: { title: '第一章' },
    });
    expect(chapRes.statusCode).toBe(201);
    const chapterId = chapRes.json().id as string;
    expect(chapterId).toBeTruthy();

    // === 3) 保存模型配置（蓝图生成 / 场景写作的前置条件）===
    const cfgRes = await app.inject({
      method: 'PUT',
      url: '/api/model-config',
      payload: {
        baseUrl: MODEL_CONFIG.baseUrl,
        apiKey: MODEL_CONFIG.apiKey,
        modelName: MODEL_CONFIG.modelName,
      },
    });
    expect(cfgRes.statusCode).toBe(200);
    // 安全：响应只返回掩码视图，绝不含原始 API Key（需求 15.3）。
    expect(cfgRes.body).not.toContain(MODEL_CONFIG.apiKey);

    // === 4) 生成蓝图（mock 提供商）→ 200，蓝图含 3 场景（需求 5.1）===
    const bpRes = await app.inject({
      method: 'POST',
      url: `/api/projects/_/chapters/${chapterId}/blueprint`,
      payload: { targetWords: 300, requirement: '主角在雨夜揭开真相。' },
    });
    expect(bpRes.statusCode).toBe(200);
    const blueprint = bpRes.json() as ChapterBlueprint;
    // chapter_id 被服务覆盖为目标章节标识符（占位符被替换）。
    expect(blueprint.chapter_id).toBe(chapterId);
    expect(blueprint.scenes).toHaveLength(3);
    expect(blueprint.scenes.map((s) => s.scene_id)).toEqual(SCENE_IDS);
    expect(bpRes.body).not.toContain(MODEL_CONFIG.apiKey);

    // 蓝图已持久化并关联章节（需求 5.1）：可经 GET 读回。
    const getBpRes = await app.inject({
      method: 'GET',
      url: `/api/chapters/${chapterId}/blueprint`,
    });
    expect(getBpRes.statusCode).toBe(200);
    expect((getBpRes.json() as ChapterBlueprint).chapter_id).toBe(chapterId);

    // === 5) 分场景写作（SSE）→ 验证 delta + done 帧，且场景正文被持久化（需求 6.5）===
    for (const sceneId of SCENE_IDS) {
      const writeRes = await app.inject({
        method: 'POST',
        url: `/api/chapters/${chapterId}/scenes/${sceneId}/write`,
        payload: {},
      });
      expect(writeRes.statusCode).toBe(200);
      expect(writeRes.headers['content-type']).toContain('text/event-stream');

      // delta 帧逐段转发，拼接等于该场景完整正文（需求 6.4）。
      const deltas = parseDeltaEvents(writeRes.body);
      expect(deltas).toEqual(SCENE_CHUNKS[sceneId]);
      expect(deltas.join('')).toBe(SCENE_TEXT[sceneId]);
      // 正常结束哨兵帧，无 error 帧。
      expect(writeRes.body).toContain('event: done\n\n');
      expect(writeRes.body).not.toContain('event: error');
      // 安全：帧中不含 API Key 原文（需求 15.3）。
      expect(writeRes.body).not.toContain(MODEL_CONFIG.apiKey);

      // 流正常结束后完整场景正文被持久化（需求 6.5）。
      const draft = await store.getSceneDraft(chapterId, sceneId);
      expect(draft?.content).toBe(SCENE_TEXT[sceneId]);
    }

    // === 6) 合并整章 → 200 + {content}，GET 章节确认 content 已写入（需求 7.3 / 8.3）===
    // 期望合并正文：按 scene_id 升序以双换行拼接各场景正文。
    const expectedMerged = SCENE_IDS.map((id) => SCENE_TEXT[id]).join('\n\n');

    const mergeRes = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/merge`,
    });
    expect(mergeRes.statusCode).toBe(200);
    expect(mergeRes.json().content).toBe(expectedMerged);
    expect(mergeRes.body).not.toContain(MODEL_CONFIG.apiKey);

    // 合并后的整章正文已写回章节（需求 8.3），可经章节列表读回（需求 14.5 数据来源）。
    const chaptersRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/chapters`,
    });
    expect(chaptersRes.statusCode).toBe(200);
    const chapters = chaptersRes.json() as Array<{ id: string; content: string }>;
    const persisted = chapters.find((c) => c.id === chapterId);
    expect(persisted).toBeDefined();
    expect(persisted!.content).toBe(expectedMerged);

    // === 7) 字数检查 → 200 报告（需求 9.4）===
    const wcRes = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/word-count-check`,
    });
    expect(wcRes.statusCode).toBe(200);
    const report = wcRes.json() as WordCountReport;
    expect(report.chapterId).toBe(chapterId);
    expect(report.chapterTargetWords).toBe(300);
    expect(report.scenes).toHaveLength(3);
    // 每个场景已写作，实际字数 = 去空白后的码点数（'场景X的正文' = 6）。
    for (const sceneId of SCENE_IDS) {
      const sceneWc = report.scenes.find((s) => s.sceneId === sceneId);
      expect(sceneWc?.actualWords).toBe([...SCENE_TEXT[sceneId]].length);
    }
    // 整章实际字数 = 各场景实际字数之和（合并后正文去空白码点数与之一致）。
    const expectedChapterActual = SCENE_IDS.reduce(
      (sum, id) => sum + [...SCENE_TEXT[id]].length,
      0,
    );
    expect(report.chapterActualWords).toBe(expectedChapterActual);
    expect(wcRes.body).not.toContain(MODEL_CONFIG.apiKey);

    // 报告已持久化，可读回（需求 9.4 / 13.3）。
    const getWcRes = await app.inject({
      method: 'GET',
      url: `/api/chapters/${chapterId}/word-count-report`,
    });
    expect(getWcRes.statusCode).toBe(200);
    expect((getWcRes.json() as WordCountReport).chapterId).toBe(chapterId);
  });
});
