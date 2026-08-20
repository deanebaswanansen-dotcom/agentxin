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
    expect(polled.json()).toMatchObject({
      projectId: 'project-a',
      task: 'long_novel',
      status: 'completed',
      continuable: false,
      result: { summary: '完成' },
    });
    const listed = await app.inject({ method: 'GET', url: '/api/projects/project-a/agent-jobs', headers: { 'x-agentxin-client-id': CLIENT_A } });
    expect(listed.json()).toHaveLength(1);
    const hidden = await app.inject({ method: 'GET', url: `/api/agent/jobs/${id}`, headers: { 'x-agentxin-client-id': CLIENT_B } });
    expect(hidden.statusCode).toBe(404);

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${id}/resume`,
      headers: { 'x-agentxin-client-id': CLIENT_A, 'x-agentxin-model-config': MODEL },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ id, projectId: 'project-a', task: 'long_novel' });
    await app.close();
  });

  it('keeps an interrupted project job paused until the user explicitly resumes it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-job-route-restart-'));
    const file = join(directory, 'runs.json');
    const beforeRestart = await AgentRunStore.create(file);
    const interrupted = await beforeRestart.create(CLIENT_A, {
      task: 'script_episode_batch',
      mode: 'draft',
      prompt: '',
      projectId: 'project-a',
      scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 1 },
    });
    await beforeRestart.markRunning(interrupted.id);

    const store = await AgentRunStore.create(file);
    expect(store.get(interrupted.id)?.status).toBe('waiting_user');
    const run = vi.fn(async (request) => ({
      task: request.task,
      mode: request.mode,
      projectId: request.projectId,
      summary: '从检查点恢复完成',
      steps: [],
      artifacts: [],
    }));
    const runner = new AgentJobRunner(store, { run });
    const app = Fastify();
    registerClientScope(app);
    registerRequestModelConfig(app);
    registerAgentJobRoutes(app, store, runner);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/projects/project-a/agent-jobs',
      headers: { 'x-agentxin-client-id': CLIENT_A, 'x-agentxin-model-config': MODEL },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      expect.objectContaining({ id: interrupted.id, status: 'waiting_user', continuable: true }),
    ]);
    const polled = await app.inject({
      method: 'GET',
      url: `/api/agent/jobs/${interrupted.id}`,
      headers: { 'x-agentxin-client-id': CLIENT_A, 'x-agentxin-model-config': MODEL },
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toMatchObject({ id: interrupted.id, status: 'waiting_user' });
    expect(run).not.toHaveBeenCalled();

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${interrupted.id}/resume`,
      headers: { 'x-agentxin-client-id': CLIENT_A, 'x-agentxin-model-config': MODEL },
    });
    expect(resumed.statusCode).toBe(200);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await runner.waitUntilIdle(interrupted.id);
    expect(store.get(interrupted.id)).toMatchObject({
      status: 'completed',
      result: { summary: '从检查点恢复完成' },
    });
    await app.close();
  });

  it('marks interrupted long-form novel jobs as continuable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-job-route-novel-resume-'));
    const file = join(directory, 'runs.json');
    const beforeRestart = await AgentRunStore.create(file);
    const interrupted = await beforeRestart.create(CLIENT_A, {
      task: 'long_novel',
      mode: 'draft',
      prompt: '写十章',
      projectId: 'project-a',
    });
    await beforeRestart.markRunning(interrupted.id);

    const store = await AgentRunStore.create(file);
    const runner = new AgentJobRunner(store, {
      run: async (request) => ({
        task: request.task,
        mode: request.mode,
        projectId: request.projectId ?? 'project-a',
        summary: '继续完成',
        steps: [],
        artifacts: [],
      }),
    });
    const app = Fastify();
    registerClientScope(app);
    registerRequestModelConfig(app);
    registerAgentJobRoutes(app, store, runner);

    const polled = await app.inject({
      method: 'GET',
      url: `/api/agent/jobs/${interrupted.id}`,
      headers: { 'x-agentxin-client-id': CLIENT_A },
    });
    expect(polled.json()).toMatchObject({
      task: 'long_novel',
      status: 'waiting_user',
      continuable: true,
    });
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

  it('returns 409 and the existing job id for an active duplicate script job', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-job-route-conflict-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const existing = await store.create(CLIENT_A, {
      task: 'script_series_outline',
      mode: 'draft',
      prompt: '',
      projectId: 'project-a',
    });
    await store.markWaiting(existing.id, { code: 'RUN_INTERRUPTED', message: '等待恢复' });
    const runner = new AgentJobRunner(store, {
      run: vi.fn(async (request) => ({
        task: request.task,
        mode: request.mode,
        projectId: request.projectId,
        summary: '完成',
        steps: [],
        artifacts: [],
      })),
    });
    const app = Fastify();
    registerClientScope(app);
    registerRequestModelConfig(app);
    registerAgentJobRoutes(app, store, runner);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/jobs',
      headers: { 'x-agentxin-client-id': CLIENT_A },
      payload: { task: 'script_series_outline', projectId: 'project-a' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'CONFLICT',
        message: expect.stringContaining('相同短剧任务'),
        existingJobId: existing.id,
      },
    });
    expect(store.listForClient(CLIENT_A, 'project-a')).toHaveLength(1);
    await app.close();
  });
});
