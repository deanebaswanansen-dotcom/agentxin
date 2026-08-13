import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerClientScope } from '../services/client/clientScope.js';
import { AgentJobRunner } from '../services/agent/jobs/AgentJobRunner.js';
import { AgentRunStore } from '../services/agent/jobs/AgentRunStore.js';
import { registerRequestModelConfig } from '../services/modelConfig/requestModelConfig.js';
import { registerAgentJobRoutes } from './agentJobRoutes.js';

const CLIENT_A = 'a'.repeat(64);
const CLIENT_B = 'b'.repeat(64);
const MODEL = encodeURIComponent(JSON.stringify({
  baseUrl: 'https://example.com', apiKey: 'secret-key', modelName: 'model',
}));

describe('agent job routes', () => {
  it('creates, polls, filters by project, and isolates jobs by client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-job-route-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const run = vi.fn(async (request, _signal, onProgress) => {
      onProgress?.({ phase: 'chapter', message: '第1章完成', current: 1, total: 1 });
      return { task: request.task, mode: request.mode, projectId: request.projectId, summary: '完成', steps: [], artifacts: [] };
    });
    const runner = new AgentJobRunner(store, { run });
    const app = Fastify();
    registerClientScope(app);
    registerRequestModelConfig(app);
    registerAgentJobRoutes(app, store, runner);

    const created = await app.inject({
      method: 'POST', url: '/api/agent/jobs',
      headers: { 'x-agentxin-client-id': CLIENT_A, 'x-agentxin-model-config': MODEL },
      payload: { task: 'long_novel', mode: 'draft', prompt: '写一章', projectId: 'project-a' },
    });
    expect(created.statusCode).toBe(202);
    const id = created.json().id as string;
    await runner.waitUntilIdle(id);

    const polled = await app.inject({ method: 'GET', url: `/api/agent/jobs/${id}`, headers: { 'x-agentxin-client-id': CLIENT_A } });
    expect(polled.json()).toMatchObject({ status: 'completed', result: { summary: '完成' } });
    const listed = await app.inject({ method: 'GET', url: '/api/projects/project-a/agent-jobs', headers: { 'x-agentxin-client-id': CLIENT_A } });
    expect(listed.json()).toHaveLength(1);
    const hidden = await app.inject({ method: 'GET', url: `/api/agent/jobs/${id}`, headers: { 'x-agentxin-client-id': CLIENT_B } });
    expect(hidden.statusCode).toBe(404);
    await app.close();
  });

  it('does not expose unexpected storage or runtime errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-job-route-error-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const runner = {
      start: vi.fn().mockRejectedValue(new Error('C:\\private\\agent-runs.json failed')),
    } as unknown as AgentJobRunner;
    const app = Fastify();
    registerClientScope(app);
    registerRequestModelConfig(app);
    registerAgentJobRoutes(app, store, runner);

    const response = await app.inject({
      method: 'POST', url: '/api/agent/jobs',
      headers: { 'x-agentxin-client-id': CLIENT_A },
      payload: { task: 'long_novel', mode: 'draft', prompt: '写一章' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private');
    expect(response.json()).toEqual({ error: { code: 'STORE_ERROR', message: '服务器内部错误。' } });
    await app.close();
  });
});
