/**
 * 端到端集成测试（task 13.3）。
 *
 * 通过真实接线的 Fastify 应用（{@link buildServer}）以 `app.inject` 串联验证
 * 「创建项目 → 创建章节 → 设置/读取正文 → 写作（mock 提供商，SSE 流式）→
 * 采用生成文本回写章节」的完整流程，不触达网络。
 *
 * 接线方式：
 * - 注入一个临时文件 {@link FileDataStore}（走真实持久化路径，不污染仓库 data/）。
 * - 注入一个 FAKE {@link ModelProxy}，其 `streamCompletion` 产出预设增量，
 *   因此写作流程使用 mock 提供商，全程离线（Req 5.x 之 mock 提供商）。
 *
 * 覆盖的验收标准：
 * - Req 7.2：写入正文后再次读取，后端返回最新已持久化内容。
 * - Req 6.4：将对话生成的文本「采用」到章节目标位置（此处为追加到末尾的
 *   insert），并验证采用后的文本被持久化（end-to-end create→chapter→write→adopt）。
 * - Req 8.2：列出项目章节，使工作台视图可展示该章节。
 *
 * 关于 `app.inject` 与 SSE：写作路由 hijack 了响应并直接写入 `reply.raw`，
 * inject 会在流结束后 resolve，因此断言针对累计的 `res.body` 文本（解析其帧）。
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
import type { ChatMessage, ModelConfig } from './types/index.js';

/**
 * 自包含的「采用」逻辑（对应 frontend/src/lib/applyAdoption 的纯函数语义）。
 * 不跨项目 import（会破坏 backend tsc 的 rootDir），在测试内联实现：
 * - insert：在 position 处嵌入 generated（position 钳制到 [0, length]）。
 * - replace：以 generated 替换半开区间 [start, end)。
 */
type AdoptionTarget =
  | { mode: 'insert'; position: number }
  | { mode: 'replace'; start: number; end: number };

function applyAdoption(
  original: string,
  generated: string,
  target: AdoptionTarget,
): string {
  const length = original.length;
  if (target.mode === 'insert') {
    const position = Math.min(Math.max(Math.trunc(target.position), 0), length);
    return original.slice(0, position) + generated + original.slice(position);
  }
  const start = Math.min(Math.max(Math.trunc(target.start), 0), length);
  const end = Math.min(Math.max(Math.trunc(target.end), start), length);
  return original.slice(0, start) + generated + original.slice(end);
}

/**
 * FAKE 模型代理：产出预设增量，绝不发起网络请求。模拟提供商逐段返回的
 * 增量文本，供写作流程拼装为完整生成结果。
 */
function fakeModelProxy(deltas: string[]): ModelProxy {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    streamCompletion(
      _config: ModelConfig,
      _messages: ChatMessage[],
      _signal: AbortSignal,
    ): AsyncIterable<StreamDelta> {
      async function* gen(): AsyncGenerator<StreamDelta> {
        for (const delta of deltas) {
          yield { kind: 'content' as const, text: delta };
        }
      }
      return gen();
    },
  };
}

/** 从累计的 SSE 文本中解析所有 `delta` 事件并 JSON 解码其 data。 */
function parseDeltaEvents(body: string): string[] {
  return [...body.matchAll(/event: delta\ndata: (.*)\n\n/g)].map(
    (m) => JSON.parse(m[1]) as string,
  );
}

describe('端到端集成：创建项目→章节→写作（mock 提供商）→采用文本', () => {
  let dir: string;
  let app: FastifyInstance;

  // 预设的提供商增量；拼接后为完整生成文本。
  const DELTAS = ['续写', '的', '内容'];
  const GENERATED = DELTAS.join(''); // '续写的内容'
  const INITIAL_CONTENT = '初始正文。';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nwa-e2e-'));
    const store = await FileDataStore.create(join(dir, 'store.json'));
    app = buildServer(store, fakeModelProxy(DELTAS));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('完整流程：写作流式生成并采用回写后持久化（Req 6.4, 7.2, 8.2）', async () => {
    // 1) 保存模型配置（使写作被允许，Req 4.1 → 写作前置条件）。
    const cfgRes = await app.inject({
      method: 'PUT',
      url: '/api/model-config',
      payload: {
        baseUrl: 'https://provider.example.com/v1',
        apiKey: 'sk-secret-key-1234',
        modelName: 'gpt-test',
      },
    });
    expect(cfgRes.statusCode).toBe(200);
    // 安全：响应只返回掩码视图，绝不含原始 API Key（Req 4.2/5.6）。
    expect(cfgRes.body).not.toContain('sk-secret-key-1234');

    // 2) 创建项目（Req 1.1）。
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '我的小说' },
    });
    expect(projRes.statusCode).toBe(201);
    const projectId = projRes.json().id as string;
    expect(projectId).toBeTruthy();

    // 3) 创建章节（Req 2.1）。
    const chapRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      payload: { title: '第一章' },
    });
    expect(chapRes.statusCode).toBe(201);
    const chapterId = chapRes.json().id as string;
    expect(chapterId).toBeTruthy();

    // 4) 设置章节正文（Req 2.3 / 7.1）。
    const setContentRes = await app.inject({
      method: 'PATCH',
      url: `/api/chapters/${chapterId}/content`,
      payload: { content: INITIAL_CONTENT },
    });
    expect(setContentRes.statusCode).toBe(200);

    // 5) 读取章节列表，断言正文已持久化（Req 7.2：返回最新已持久化内容）。
    const afterSet = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/chapters`,
    });
    expect(afterSet.statusCode).toBe(200);
    const chaptersAfterSet = afterSet.json() as Array<{
      id: string;
      content: string;
    }>;
    const persisted = chaptersAfterSet.find((c) => c.id === chapterId);
    expect(persisted).toBeDefined();
    expect(persisted!.content).toBe(INITIAL_CONTENT);

    // 6) 写作请求（mock 提供商，SSE 流式）。解析 delta 帧并断言拼接结果与
    //    done 终止帧（Req 5.3 流式转发 + 流程串联）。
    const writeRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters/${chapterId}/write`,
      payload: { operation: 'continue', instruction: '继续写' },
    });
    expect(writeRes.statusCode).toBe(200);
    expect(writeRes.headers['content-type']).toContain('text/event-stream');
    const decodedDeltas = parseDeltaEvents(writeRes.body);
    expect(decodedDeltas).toEqual(DELTAS);
    expect(decodedDeltas.join('')).toBe(GENERATED);
    expect(writeRes.body).toContain('event: done\n\n');
    expect(writeRes.body).not.toContain('event: error');

    // 7) 采用生成文本：在原正文末尾插入（insert at end），回写章节（Req 6.4）。
    const newContent = applyAdoption(INITIAL_CONTENT, GENERATED, {
      mode: 'insert',
      position: INITIAL_CONTENT.length,
    });
    // 末尾插入等价于追加。
    expect(newContent).toBe(INITIAL_CONTENT + GENERATED);

    const adoptRes = await app.inject({
      method: 'PATCH',
      url: `/api/chapters/${chapterId}/content`,
      payload: { content: newContent },
    });
    expect(adoptRes.statusCode).toBe(200);

    // 采用后的文本已被持久化：再次读取章节断言内容相等（end-to-end 闭环）。
    const afterAdopt = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/chapters`,
    });
    expect(afterAdopt.statusCode).toBe(200);
    const chaptersAfterAdopt = afterAdopt.json() as Array<{
      id: string;
      title: string;
      content: string;
    }>;

    // 8) 工作台视图可展示该章节：列表中存在该章节（Req 8.2）。
    const adopted = chaptersAfterAdopt.find((c) => c.id === chapterId);
    expect(adopted).toBeDefined();
    expect(adopted!.title).toBe('第一章');
    expect(adopted!.content).toBe(newContent);
  });
});
