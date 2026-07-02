/**
 * SSE route tests for {@link registerAgentRoutes} streaming endpoint
 * (`POST /api/agent/run-stream`).
 *
 * Uses `app.inject` with a MOCK {@link AgentService}: the hijacked streaming
 * response resolves once the stream ends, so assertions run against the fully
 * accumulated SSE body.
 *
 * Wire contract under test (must match frontend apiClient.agent.runStream):
 *   - progress: `event: progress\ndata: <JSON AgentProgressEvent>\n\n`
 *   - result:   `event: result\ndata: <JSON AgentRunResult>\n\n`
 *   - done:     `event: done\n\n`
 *   - error:    `event: error\ndata: <JSON ApiError>\n\n`
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { ServiceError } from '../services/ServiceError.js';
import type { AgentService } from '../services/agent/AgentService.js';
import type { AgentProgressEvent, AgentRunRequest, AgentRunResult } from '../types/index.js';
import { registerAgentRoutes } from './agentRoutes.js';

function mockAgentService(
  impl: (
    request: AgentRunRequest,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ) => Promise<AgentRunResult>,
): AgentService {
  return { run: impl } as unknown as AgentService;
}

const RESULT: AgentRunResult = {
  task: 'full_novel',
  mode: 'draft',
  projectId: 'p1',
  chapterId: 'c2',
  summary: '已生成整本草稿。',
  steps: ['已写完第1章。', '已写完第2章。'],
  artifacts: [{ kind: 'project', id: 'p1', title: '测试书' }],
};

describe('agentRoutes run-stream (SSE)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  async function buildApp(service: AgentService): Promise<void> {
    app = Fastify({ logger: false });
    registerAgentRoutes(app, service);
    await app.ready();
  }

  it('streams progress events then a result and done sentinel', async () => {
    await buildApp(
      mockAgentService(async (_request, _signal, onProgress) => {
        onProgress?.({ phase: 'setup', message: '准备中' });
        onProgress?.({ phase: 'chapter', message: '写第1章', current: 1, total: 2 });
        onProgress?.({ phase: 'chapter', message: '写第2章', current: 2, total: 2 });
        return RESULT;
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/run-stream',
      payload: { task: 'full_novel', mode: 'draft', prompt: '废土机械师', options: { chapters: 2 } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const body = res.body;
    expect(body).toContain('event: progress');
    expect(body).toContain('写第1章');
    expect(body).toContain('写第2章');
    expect(body).toContain('event: result');
    expect(body).toContain('已生成整本草稿。');
    expect(body.trimEnd().endsWith('event: done')).toBe(true);

    // 最终 result 帧应能解析回 AgentRunResult。
    const resultLine = body.split('\n').find((l) => l.startsWith('data: {"task"'));
    expect(resultLine).toBeDefined();
    const parsed = JSON.parse(resultLine!.slice('data: '.length)) as AgentRunResult;
    expect(parsed.chapterId).toBe('c2');
  });

  it('emits an error frame when the service rejects before streaming', async () => {
    await buildApp(
      mockAgentService(async () => {
        throw ServiceError.validation('一句话需求不能为空。');
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/run-stream',
      payload: { task: 'novel', mode: 'draft', prompt: '题材' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: error');
    expect(res.body).toContain('VALIDATION_ERROR');
  });

  it('emits a validation error frame for an invalid task', async () => {
    await buildApp(mockAgentService(async () => RESULT));

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/run-stream',
      payload: { task: 'not-a-task', mode: 'draft', prompt: 'x' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: error');
    expect(res.body).toContain('VALIDATION_ERROR');
  });
});
