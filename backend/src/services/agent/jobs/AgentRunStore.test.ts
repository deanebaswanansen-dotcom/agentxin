import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentRunRequest } from '../../../types/index.js';
import { AgentRunConflictError, AgentRunStore } from './AgentRunStore.js';

const CLIENT_A = 'a'.repeat(64);
const CLIENT_B = 'b'.repeat(64);

function scriptRequest(
  task: 'script_series_outline' | 'script_bible',
  projectId = 'project-a',
): AgentRunRequest {
  return { task, mode: 'draft', prompt: '', projectId };
}

function batchRequest(startEpisode: number, episodeCount = 5): AgentRunRequest {
  return {
    task: 'script_episode_batch',
    mode: 'draft',
    prompt: '',
    projectId: 'project-a',
    scriptBatchOptions: { startEpisode, episodeCount, expectedPlanRevision: 1 },
  };
}

describe('AgentRunStore', () => {
  it('persists progress and terminal results without exposing another client job', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runs-'));
    const file = join(directory, 'runs.json');
    const store = await AgentRunStore.create(file);
    const run = await store.create(CLIENT_A, {
      task: 'long_novel',
      mode: 'draft',
      prompt: '写二十章校园小说',
      projectId: 'project-a',
    });
    await store.appendEvent(run.id, { phase: 'chapter', message: '第1章完成', current: 1, total: 20 });
    await store.complete(run.id, {
      task: 'long_novel',
      mode: 'draft',
      projectId: 'project-a',
      summary: '完成',
      steps: ['第1章完成'],
      artifacts: [],
    });

    const reloaded = await AgentRunStore.create(file);
    expect(reloaded.getForClient(CLIENT_A, run.id)).toMatchObject({
      status: 'completed',
      events: [{ message: '第1章完成' }],
      result: { summary: '完成' },
    });
    expect(reloaded.getForClient(CLIENT_B, run.id)).toBeUndefined();
  });

  it('turns an interrupted running job into waiting_user on restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runs-'));
    const file = join(directory, 'runs.json');
    const store = await AgentRunStore.create(file);
    const run = await store.create(CLIENT_A, {
      task: 'long_novel',
      mode: 'draft',
      prompt: '写二十章校园小说',
    });
    await store.markRunning(run.id);

    const reloaded = await AgentRunStore.create(file);

    expect(reloaded.getForClient(CLIENT_A, run.id)).toMatchObject({
      status: 'waiting_user',
      error: { message: expect.stringContaining('重新连接') },
    });
  });

  it('deletes only jobs owned by the selected client and project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runs-delete-'));
    const file = join(directory, 'runs.json');
    const store = await AgentRunStore.create(file);
    const target = await store.create(CLIENT_A, {
      task: 'script_episode_batch', mode: 'draft', prompt: '', projectId: 'project-a',
    });
    const otherProject = await store.create(CLIENT_A, {
      task: 'script_episode_batch', mode: 'draft', prompt: '', projectId: 'project-b',
    });
    const otherClient = await store.create(CLIENT_B, {
      task: 'script_episode_batch', mode: 'draft', prompt: '', projectId: 'project-a',
    });

    await store.deleteForProject(CLIENT_A, 'project-a');

    expect(store.get(target.id)).toBeUndefined();
    expect(store.get(otherProject.id)).toBeDefined();
    expect(store.get(otherClient.id)).toBeDefined();
    const reloaded = await AgentRunStore.create(file);
    expect(reloaded.get(target.id)).toBeUndefined();
  });

  it('atomically rejects active duplicate outline and bible jobs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runs-script-dedup-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));

    for (const task of ['script_series_outline', 'script_bible'] as const) {
      for (const status of ['queued', 'running', 'retrying', 'waiting_user'] as const) {
        const existing = await store.create(CLIENT_A, scriptRequest(task));
        if (status === 'running') await store.markRunning(existing.id);
        if (status === 'retrying') {
          await store.markRetrying(existing.id, { code: 'PROVIDER_ERROR', message: '稍后重试' });
        }
        if (status === 'waiting_user') {
          await store.markWaiting(existing.id, { code: 'RUN_INTERRUPTED', message: '等待恢复' });
        }

        await expect(store.create(CLIENT_A, scriptRequest(task))).rejects.toMatchObject({
          code: 'CONFLICT',
          existingJobId: existing.id,
        });
        await store.cancel(existing.id);
      }
    }

    const results = await Promise.allSettled([
      store.create(CLIENT_A, scriptRequest('script_bible', 'project-concurrent')),
      store.create(CLIENT_A, scriptRequest('script_bible', 'project-concurrent')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(AgentRunConflictError),
    });
  });

  it('rejects a second long-form novel job on the same project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runs-novel-dedup-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const existing = await store.create(CLIENT_A, {
      task: 'long_novel',
      mode: 'draft',
      prompt: '写二十章',
      projectId: 'project-a',
    });

    await expect(store.create(CLIENT_A, {
      task: 'full_novel',
      mode: 'draft',
      prompt: '再写十章',
      projectId: 'project-a',
    })).rejects.toMatchObject({
      code: 'CONFLICT',
      existingJobId: existing.id,
    });
  });

  it('rejects exact and partial episode-batch overlaps but allows adjacent ranges', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runs-batch-dedup-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const existing = await store.create(CLIENT_A, batchRequest(6));

    await expect(store.create(CLIENT_A, batchRequest(6))).rejects.toMatchObject({
      code: 'CONFLICT',
      existingJobId: existing.id,
    });
    await expect(store.create(CLIENT_A, batchRequest(10))).rejects.toMatchObject({
      code: 'CONFLICT',
      existingJobId: existing.id,
    });

    await expect(store.create(CLIENT_A, batchRequest(1))).resolves.toMatchObject({
      status: 'queued',
      request: { scriptBatchOptions: { startEpisode: 1, episodeCount: 5 } },
    });
    await expect(store.create(CLIENT_A, batchRequest(11))).resolves.toMatchObject({
      status: 'queued',
      request: { scriptBatchOptions: { startEpisode: 11, episodeCount: 5 } },
    });
  });

  it('allows a replacement after terminal script jobs and blocks overlapping long-form novels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runs-terminal-dedup-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));

    const completed = await store.create(CLIENT_A, scriptRequest('script_bible'));
    await store.complete(completed.id, {
      task: 'script_bible', mode: 'draft', projectId: 'project-a',
      summary: '完成', steps: [], artifacts: [],
    });
    const afterCompleted = await store.create(CLIENT_A, scriptRequest('script_bible'));
    await store.cancel(afterCompleted.id);

    const failed = await store.create(CLIENT_A, scriptRequest('script_bible'));
    await store.fail(failed.id, { message: '失败' });
    const afterFailed = await store.create(CLIENT_A, scriptRequest('script_bible'));
    await store.cancel(afterFailed.id);

    const cancelled = await store.create(CLIENT_A, scriptRequest('script_bible'));
    await store.cancel(cancelled.id);
    await expect(store.create(CLIENT_A, scriptRequest('script_bible'))).resolves.toMatchObject({
      status: 'queued',
    });

    const novelRequest: AgentRunRequest = {
      task: 'long_novel', mode: 'draft', prompt: '写一章', projectId: 'project-a',
    };
    const firstNovel = await store.create(CLIENT_A, novelRequest);
    await expect(store.create(CLIENT_A, novelRequest)).rejects.toMatchObject({
      code: 'CONFLICT',
      existingJobId: firstNovel.id,
    });
    await store.complete(firstNovel.id, {
      task: 'long_novel', mode: 'draft', projectId: 'project-a',
      summary: '完成', steps: [], artifacts: [],
    });
    await expect(store.create(CLIENT_A, novelRequest)).resolves.toMatchObject({ status: 'queued' });
  });

  it('does not overwrite completed, failed, or cancelled jobs via cancel or fail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runs-terminal-noop-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const novelRequest: AgentRunRequest = {
      task: 'long_novel', mode: 'draft', prompt: '写一章', projectId: 'project-a',
    };

    const completed = await store.create(CLIENT_A, novelRequest);
    await store.complete(completed.id, {
      task: 'long_novel', mode: 'draft', projectId: 'project-a',
      summary: '完成', steps: [], artifacts: [],
    });
    await store.cancel(completed.id);
    expect(store.get(completed.id)?.status).toBe('completed');
    await store.fail(completed.id, { message: '不应覆盖完成态' });
    expect(store.get(completed.id)).toMatchObject({
      status: 'completed',
      result: { summary: '完成' },
    });

    const failed = await store.create(CLIENT_A, {
      ...novelRequest, projectId: 'project-b',
    });
    await store.fail(failed.id, { message: '失败' });
    await store.cancel(failed.id);
    expect(store.get(failed.id)?.status).toBe('failed');
    await store.fail(failed.id, { message: '另一条失败' });
    expect(store.get(failed.id)).toMatchObject({
      status: 'failed',
      error: { message: '失败' },
    });

    const cancelled = await store.create(CLIENT_A, {
      ...novelRequest, projectId: 'project-c',
    });
    await store.cancel(cancelled.id);
    await store.fail(cancelled.id, { message: '不应覆盖取消态' });
    expect(store.get(cancelled.id)?.status).toBe('cancelled');
    await store.cancel(cancelled.id);
    expect(store.get(cancelled.id)?.status).toBe('cancelled');
  });
});
