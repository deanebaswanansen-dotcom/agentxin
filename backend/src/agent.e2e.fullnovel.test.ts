/**
 * 真·端到端测试：一键生成整本（full_novel）流式生成全链路。
 *
 * 与其它使用 `app.inject` 的集成测试不同，本测试：
 *   1. 用真实 {@link FileDataStore}（临时文件）+ 真实 {@link MemoryService}（临时文件）；
 *   2. 用真实默认 proxy 链（CachingModelProxy → OpenAiCompatibleModelProxy 的 mock 分支）；
 *   3. `app.listen` 监听真实端口；
 *   4. 用真实 `fetch` 发起 HTTP 请求并逐帧解析 SSE 流；
 *   5. 断言：收到 progress 进度事件、收到最终 result、章节真的落盘、长期记忆真的写入。
 *
 * 这模拟「真实用户在浏览器里点一键整本」时后端实际发生的事，而非仅测函数。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from './index.js';
import { FileDataStore } from './store/FileDataStore.js';
import { MemoryStore } from './services/memory/MemoryStore.js';
import { MemoryService } from './services/memory/MemoryService.js';

interface SseEvent {
  event: string;
  data: string;
}

/** 极简 SSE 帧解析（逐块累积，按空行切分）。 */
function parseFrames(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) data += line.slice('data: '.length);
    }
    events.push({ event, data });
  }
  return { events, rest };
}

describe('E2E: full_novel streaming over real HTTP', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'e2e-fullnovel-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams progress + result, persists chapters and long-term memory', async () => {
    const storeFile = join(dir, 'store.json');
    const memFile = join(dir, 'agent-memory.json');

    const store = await FileDataStore.create(storeFile);
    // 配置 Mock 提供商：无需任何 API Key，即可走真实 proxy 链的 mock 分支。
    await store.saveModelConfig({ baseUrl: 'mock', apiKey: 'mock-key', modelName: 'mock-model' });

    const memory = new MemoryService(await MemoryStore.create(memFile));
    const app = buildServer(store, undefined, memory);

    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetch(`${address}/api/agent/run-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          task: 'full_novel',
          mode: 'draft',
          prompt: '赛博修仙学院，主角靠写代码御剑',
          options: { chapters: 2, targetWords: 600 },
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.body).not.toBeNull();

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const progress: Array<{ phase: string; message: string; current?: number; total?: number }> = [];
      let result:
        | {
            projectId: string;
            chapterId?: string;
            steps: string[];
            artifacts: unknown[];
            metrics?: { plannedWords?: number; completedChapters?: number; promptTokens: number; completionTokens: number };
          }
        | undefined;
      let gotDone = false;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseFrames(buffer);
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          if (ev.event === 'progress') progress.push(JSON.parse(ev.data));
          else if (ev.event === 'result') result = JSON.parse(ev.data);
          else if (ev.event === 'done') gotDone = true;
          else if (ev.event === 'error') throw new Error(`unexpected error frame: ${ev.data}`);
        }
      }

      // 1) 收到实时进度事件，且包含逐章进度（current/total）。
      expect(progress.length).toBeGreaterThan(0);
      const chapterEvents = progress.filter((p) => p.phase === 'chapter' && p.total === 2);
      expect(chapterEvents.length).toBeGreaterThan(0);

      // 2) 收到最终结果与完成帧。
      expect(gotDone).toBe(true);
      expect(result).toBeDefined();
      expect(result!.steps.length).toBeGreaterThan(0);
      expect(result!.metrics).toMatchObject({
        plannedWords: 1200,
        completedChapters: 2,
        promptTokens: 0,
        completionTokens: 0,
      });

      // 3) 章节真的落盘（2 章正文非空）。
      const chapters = await store.listChapters(result!.projectId);
      expect(chapters).toHaveLength(2);
      for (const ch of chapters) {
        expect(ch.content.length).toBeGreaterThan(0);
      }

      // 4) 长期记忆真的写入：磁盘文件含本项目的章节摘要。
      const mem = memory.get(result!.projectId);
      expect(mem.summaries.length).toBeGreaterThan(0);
      const raw = await readFile(memFile, 'utf8');
      expect(raw).toContain(result!.projectId);

      // 5) 缓存统计端点可用（mock 不计本地缓存，但结构应正确）。
      const statsRes = await fetch(`${address}/api/cache-stats`);
      const stats = (await statsRes.json()) as { localCache: { hits: number; misses: number } };
      expect(stats.localCache).toBeDefined();
    } finally {
      await app.close();
    }
  }, 30000);
});
