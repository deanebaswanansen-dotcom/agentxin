import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { getCurrentClientId } from '../../client/clientScope.js';
import { getRequestModelConfig } from '../../modelConfig/requestModelConfig.js';
import { AgentJobRunner } from './AgentJobRunner.js';
import { AgentRunStore } from './AgentRunStore.js';

const CLIENT_ID = 'a'.repeat(64);

describe('AgentJobRunner', () => {
  it('continues independently, persists progress, and restores request scopes without storing the API key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-'));
    const file = join(directory, 'runs.json');
    const store = await AgentRunStore.create(file);
    const run = vi.fn(async (request, _signal, onProgress) => {
      expect(getCurrentClientId()).toBe(CLIENT_ID);
      expect(getRequestModelConfig()?.apiKey).toBe('secret-key');
      onProgress?.({ phase: 'chapter', message: '第1章完成', current: 1, total: 2 });
      return {
        task: request.task,
        mode: request.mode,
        projectId: request.projectId ?? 'created-project',
        summary: '完成',
        steps: [],
        artifacts: [],
      };
    });
    const runner = new AgentJobRunner(store, { run });

    const created = await runner.start(
      CLIENT_ID,
      { task: 'long_novel', mode: 'draft', prompt: '写两章', projectId: 'project-a' },
      { baseUrl: 'https://example.com', apiKey: 'secret-key', modelName: 'model' },
    );
    expect(created.status).toBe('queued');
    await runner.waitUntilIdle(created.id);

    expect(store.getForClient(CLIENT_ID, created.id)).toMatchObject({
      status: 'completed',
      events: [{ message: '第1章完成' }],
      result: { summary: '完成' },
    });
    expect(await readFile(file, 'utf8')).not.toContain('secret-key');
  });

  it('persists progress before exposing the job as completed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-progress-order-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const originalAppendEvent = store.appendEvent.bind(store);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const appendEvent = vi.spyOn(store, 'appendEvent').mockImplementation(async (id, event) => {
      await writeGate;
      return originalAppendEvent(id, event);
    });
    const runner = new AgentJobRunner(store, {
      run: async (request, _signal, onProgress) => {
        onProgress?.({
          phase: 'info',
          message: '草稿检查点完成',
          scriptCheckpoint: {
            episodeNumber: 1,
            node: 'draft',
            attempt: 1,
            artifactRevision: 1,
          },
        });
        return {
          task: request.task,
          mode: request.mode,
          projectId: request.projectId ?? 'p1',
          summary: '完成',
          steps: [],
          artifacts: [],
        };
      },
    });

    const created = await runner.start(
      CLIENT_ID,
      { task: 'script_episode_batch', mode: 'draft', prompt: '', projectId: 'p1' },
      undefined,
    );
    await vi.waitFor(() => expect(appendEvent).toHaveBeenCalledOnce());
    expect(store.get(created.id)?.status).toBe('running');

    releaseWrite();
    await runner.waitUntilIdle(created.id);
    expect(store.get(created.id)).toMatchObject({
      status: 'completed',
      events: [{ scriptCheckpoint: { node: 'draft', artifactRevision: 1 } }],
    });
  });

  it('retries temporary provider failures before marking a job failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-retry-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    let attempts = 0;
    const runner = new AgentJobRunner(store, {
      run: async (request) => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('网关暂时不可用'), { code: 'PROVIDER_ERROR', status: 503 });
        return { task: request.task, mode: request.mode, projectId: 'p1', summary: '完成', steps: [], artifacts: [] };
      },
    }, { retryDelayMs: 1 });
    const created = await runner.start(CLIENT_ID, { task: 'long_novel', mode: 'draft', prompt: '写两章' }, undefined);
    await runner.waitUntilIdle(created.id);

    expect(attempts).toBe(3);
    expect(store.getForClient(CLIENT_ID, created.id)?.status).toBe('completed');
  });

  it('parks a structured needs-review error for the user and resumes the same request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-needs-review-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    let attempts = 0;
    const run = vi.fn(async (request, _signal, _onProgress, context) => {
      attempts += 1;
      if (attempts === 1) {
        expect(context).toBeUndefined();
        throw Object.assign(new Error('episode_draft 结构契约不匹配'), {
          code: 'SCRIPT_STRUCTURED_NEEDS_REVIEW',
          recoverable: true,
          // Even if a nested provider error contributed this status, schema
          // recovery belongs to the Director rather than the job retry loop.
          status: 503,
        });
      }
      expect(context).toEqual({ resumeRejectedCandidates: true });
      return {
        task: request.task,
        mode: request.mode,
        projectId: request.projectId ?? 'p1',
        summary: '从原任务检查点恢复完成',
        steps: [],
        artifacts: [],
      };
    });
    const runner = new AgentJobRunner(store, { run }, { maxAttempts: 3, retryDelayMs: 1 });
    const request = {
      task: 'script_episode_batch' as const,
      mode: 'draft' as const,
      prompt: '',
      projectId: 'p1',
      scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 1 },
    };

    const created = await runner.start(CLIENT_ID, request, undefined);
    await runner.waitUntilIdle(created.id);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual(request);
    expect(store.get(created.id)).toMatchObject({
      status: 'waiting_user',
      attempts: 1,
      error: {
        code: 'SCRIPT_STRUCTURED_NEEDS_REVIEW',
        message: 'episode_draft 结构契约不匹配',
      },
    });

    await expect(runner.resume(CLIENT_ID, created.id, undefined)).resolves.toMatchObject({
      status: 'queued',
    });
    await runner.waitUntilIdle(created.id);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toEqual(request);
    expect(store.get(created.id)).toMatchObject({
      status: 'completed',
      attempts: 2,
      result: { summary: '从原任务检查点恢复完成' },
    });
  });

  it('does not invalidate exact checkpoints when resuming an interrupted process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-interrupted-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const request = {
      task: 'script_episode_batch' as const,
      mode: 'draft' as const,
      prompt: '',
      projectId: 'p1',
      scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 1 },
    };
    const stored = await store.create(CLIENT_ID, request);
    await store.markWaiting(stored.id, {
      code: 'RUN_INTERRUPTED',
      message: '后台进程重启，等待继续。',
    });
    const run = vi.fn(async (received, _signal, _onProgress, context) => {
      expect(context).toBeUndefined();
      return {
        task: received.task,
        mode: received.mode,
        projectId: received.projectId ?? 'p1',
        summary: '从精确检查点恢复完成',
        steps: [],
        artifacts: [],
      };
    });
    const runner = new AgentJobRunner(store, { run });

    await expect(runner.resume(CLIENT_ID, stored.id, undefined)).resolves.toMatchObject({
      status: 'queued',
    });
    await runner.waitUntilIdle(stored.id);

    expect(run).toHaveBeenCalledOnce();
    expect(store.get(stored.id)?.status).toBe('completed');
  });

  it('marks an ordinary non-recoverable execution error as failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-non-recoverable-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const run = vi.fn(async () => {
      throw Object.assign(new Error('结构节点实现错误'), {
        code: 'SCRIPT_SCHEMA_MISMATCH',
        recoverable: false,
      });
    });
    const runner = new AgentJobRunner(store, { run }, { maxAttempts: 3, retryDelayMs: 1 });

    const created = await runner.start(
      CLIENT_ID,
      { task: 'script_episode_batch', mode: 'draft', prompt: '', projectId: 'p1' },
      undefined,
    );
    await runner.waitUntilIdle(created.id);

    expect(run).toHaveBeenCalledTimes(1);
    expect(store.get(created.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: { code: 'SCRIPT_SCHEMA_MISMATCH', message: '结构节点实现错误' },
    });
  });

  it('redacts API keys before persisting a failed job', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-redact-'));
    const file = join(directory, 'runs.json');
    const store = await AgentRunStore.create(file);
    const runner = new AgentJobRunner(store, {
      run: async () => {
        throw new Error('provider rejected sk-live-secret-1234567890');
      },
    });

    const created = await runner.start(
      CLIENT_ID,
      { task: 'long_novel', mode: 'draft', prompt: '写两章' },
      { baseUrl: 'https://example.com', apiKey: 'sk-live-secret-1234567890', modelName: 'model' },
    );
    await runner.waitUntilIdle(created.id);

    const persisted = await readFile(file, 'utf8');
    expect(persisted).not.toContain('sk-live-secret-1234567890');
    expect(persisted).toContain('[API_KEY]');
  });

  it('can resume a failed script job so its executor restores persisted checkpoints', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-resume-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    let shouldFail = true;
    const runner = new AgentJobRunner(store, {
      run: async (request) => {
        if (shouldFail) throw new Error('structured output incomplete');
        return {
          task: request.task,
          mode: request.mode,
          projectId: request.projectId ?? 'p1',
          summary: '从检查点完成',
          steps: [],
          artifacts: [],
        };
      },
    });
    const created = await runner.start(
      CLIENT_ID,
      {
        task: 'script_episode_batch',
        mode: 'draft',
        prompt: '',
        projectId: 'p1',
        scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 1 },
      },
      undefined,
    );
    await runner.waitUntilIdle(created.id);
    expect(store.get(created.id)?.status).toBe('failed');

    shouldFail = false;
    await runner.resume(CLIENT_ID, created.id, undefined);
    await runner.waitUntilIdle(created.id);

    expect(store.get(created.id)).toMatchObject({
      status: 'completed',
      result: { summary: '从检查点完成' },
    });
  });

  it('parks unparseable script drafts for resume instead of marking them failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-script-invalid-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    let attempts = 0;
    const run = vi.fn(async (request, _signal, _onProgress, context) => {
      attempts += 1;
      if (attempts === 1) {
        expect(context).toBeUndefined();
        throw Object.assign(new Error('第 1 集没有返回可识别的剧本场景。'), {
          code: 'SCRIPT_MODEL_OUTPUT_INVALID',
        });
      }
      expect(context).toEqual({ resumeRejectedCandidates: true });
      return {
        task: request.task,
        mode: request.mode,
        projectId: request.projectId ?? 'p1',
        summary: '从检查点重写完成',
        steps: [],
        artifacts: [],
      };
    });
    const runner = new AgentJobRunner(store, { run }, { maxAttempts: 3, retryDelayMs: 1 });
    const created = await runner.start(
      CLIENT_ID,
      {
        task: 'script_episode_batch',
        mode: 'draft',
        prompt: '',
        projectId: 'p1',
        scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 1 },
      },
      undefined,
    );
    await runner.waitUntilIdle(created.id);
    expect(store.get(created.id)?.status).toBe('waiting_user');

    await runner.resume(CLIENT_ID, created.id, undefined);
    await runner.waitUntilIdle(created.id);
    expect(store.get(created.id)).toMatchObject({
      status: 'completed',
      result: { summary: '从检查点重写完成' },
    });
  });

  it('binds a created project id before retrying a full_novel job', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-bind-project-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const projectIds: Array<string | undefined> = [];
    let attempts = 0;
    const runner = new AgentJobRunner(store, {
      run: async (request, _signal, onProgress) => {
        attempts += 1;
        projectIds.push(request.projectId);
        onProgress?.({
          phase: 'setup',
          message: '已创建项目',
          projectId: 'created-project',
        });
        if (attempts === 1) {
          throw Object.assign(new Error('网关暂时不可用'), { code: 'PROVIDER_ERROR', status: 503 });
        }
        return {
          task: request.task,
          mode: request.mode,
          projectId: request.projectId ?? 'created-project',
          summary: '完成',
          steps: [],
          artifacts: [],
        };
      },
    }, { retryDelayMs: 1 });

    const created = await runner.start(
      CLIENT_ID,
      { task: 'full_novel', mode: 'draft', prompt: '写三章' },
      undefined,
    );
    await runner.waitUntilIdle(created.id);

    expect(projectIds).toEqual([undefined, 'created-project']);
    expect(store.get(created.id)).toMatchObject({
      status: 'completed',
      request: { projectId: 'created-project' },
    });
  });

  it('keeps a cancelled job cancelled when an executor returns late', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-cancel-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    let finish!: () => void;
    const runner = new AgentJobRunner(store, {
      run: (request) => new Promise((resolve) => {
        finish = () => resolve({
          task: request.task, mode: request.mode, projectId: 'p1',
          summary: '迟到的完成结果', steps: [], artifacts: [],
        });
      }),
    });

    const created = await runner.start(
      CLIENT_ID,
      { task: 'long_novel', mode: 'draft', prompt: '写两章' },
      undefined,
    );
    await vi.waitFor(() => expect(store.get(created.id)?.status).toBe('running'));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await runner.cancel(CLIENT_ID, created.id);
    finish();
    await runner.waitUntilIdle(created.id);

    expect(store.get(created.id)?.status).toBe('cancelled');
    expect(store.get(created.id)?.result).toBeUndefined();
  });

  it('does not resurrect a cancelled structured job as waiting_user', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-cancel-structured-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    let rejectRun!: (error: unknown) => void;
    const runner = new AgentJobRunner(store, {
      run: () => new Promise((_resolve, reject) => {
        rejectRun = reject;
      }),
    });

    const created = await runner.start(
      CLIENT_ID,
      { task: 'script_episode_batch', mode: 'draft', prompt: '', projectId: 'p1' },
      undefined,
    );
    await vi.waitFor(() => expect(store.get(created.id)?.status).toBe('running'));
    await vi.waitFor(() => expect(rejectRun).toBeTypeOf('function'));
    await runner.cancel(CLIENT_ID, created.id);
    rejectRun(Object.assign(new Error('候选等待人工检查'), {
      code: 'SCRIPT_STRUCTURED_NEEDS_REVIEW',
      recoverable: true,
    }));
    await runner.waitUntilIdle(created.id);

    expect(store.get(created.id)?.status).toBe('cancelled');
  });

  it('fails instead of staying running when an executor never settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-watchdog-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    let executorSignal: AbortSignal | undefined;
    const runner = new AgentJobRunner(store, {
      run: (_request, signal) => {
        executorSignal = signal;
        return new Promise(() => undefined);
      },
    }, { idleTimeoutMs: 20, maxAttemptDurationMs: 100, maxAttempts: 1 });

    const created = await runner.start(
      CLIENT_ID,
      { task: 'script_series_outline', mode: 'draft', prompt: '', projectId: 'p1' },
      undefined,
    );
    await runner.waitUntilIdle(created.id);

    expect(executorSignal?.aborted).toBe(true);
    expect(store.get(created.id)).toMatchObject({
      status: 'failed',
      error: { code: 'RUN_TIMEOUT' },
    });
  });

  it('uses an absolute limit even while progress keeps resetting the idle watchdog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-absolute-watchdog-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const runner = new AgentJobRunner(store, {
      run: (_request, _signal, onProgress) => new Promise(() => {
        const timer = setInterval(() => onProgress?.({ phase: 'info', message: '仍在处理' }), 10);
        timer.unref?.();
      }),
    }, { idleTimeoutMs: 100, maxAttemptDurationMs: 45, maxAttempts: 1 });

    const created = await runner.start(
      CLIENT_ID,
      { task: 'script_series_outline', mode: 'draft', prompt: '', projectId: 'p1' },
      undefined,
    );
    await runner.waitUntilIdle(created.id);

    expect(store.get(created.id)).toMatchObject({
      status: 'failed',
      error: { code: 'RUN_TIMEOUT' },
    });
  });

  it('releases a cancelled active slot even when the old executor ignores abort', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-cancel-overlap-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    let finishFirst!: () => void;
    let calls = 0;
    const runner = new AgentJobRunner(store, {
      run: (request) => {
        calls += 1;
        if (calls > 1) return Promise.resolve({
          task: request.task, mode: request.mode, projectId: request.projectId ?? 'project-a',
          summary: '替代任务完成', steps: [], artifacts: [],
        });
        return new Promise((resolve) => {
          finishFirst = () => resolve({
            task: request.task, mode: request.mode, projectId: request.projectId ?? 'project-a',
            summary: '迟到的完成结果', steps: [], artifacts: [],
          });
        });
      },
    });

    const created = await runner.start(
      CLIENT_ID,
      { task: 'long_novel', mode: 'draft', prompt: '写两章', projectId: 'project-a' },
      undefined,
    );
    await vi.waitFor(() => expect(store.get(created.id)?.status).toBe('running'));
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    await runner.cancel(CLIENT_ID, created.id);
    await runner.waitUntilIdle(created.id);
    expect(store.get(created.id)?.status).toBe('cancelled');

    const replacement = await runner.start(
      CLIENT_ID,
      { task: 'full_novel', mode: 'draft', prompt: '再写十章', projectId: 'project-a' },
      undefined,
    );
    await runner.waitUntilIdle(replacement.id);
    expect(store.get(replacement.id)?.status).toBe('completed');

    finishFirst();
    await Promise.resolve();
    expect(store.get(created.id)?.status).toBe('cancelled');
  });

  it('fails a newly reserved job instead of leaving it queued when its first persistence write stalls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-create-write-timeout-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const persist = vi.spyOn(
      store as unknown as { persist: () => Promise<void> },
      'persist',
    ).mockImplementation(() => new Promise(() => undefined));
    const execute = vi.fn();
    const runner = new AgentJobRunner(store, { run: execute }, {
      storageWriteTimeoutMs: 20,
    });

    await expect(runner.start(
      CLIENT_ID,
      { task: 'script_series_outline', mode: 'draft', prompt: '', projectId: 'p1' },
      undefined,
    )).rejects.toMatchObject({ code: 'RUN_STORAGE_TIMEOUT' });

    expect(persist).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(store.listForClient(CLIENT_ID, 'p1')).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'RUN_STORAGE_TIMEOUT' }),
      }),
    ]);
  });

  it('restores waiting_user instead of leaving a runner-less queued job when resume persistence stalls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-runner-resume-write-timeout-'));
    const store = await AgentRunStore.create(join(directory, 'runs.json'));
    const request = {
      task: 'script_episode_batch' as const,
      mode: 'draft' as const,
      prompt: '',
      projectId: 'p1',
      scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 1 },
    };
    const stored = await store.create(CLIENT_ID, request);
    await store.markWaiting(stored.id, {
      code: 'RUN_INTERRUPTED',
      message: '后台进程重启，等待继续。',
    });
    vi.spyOn(
      store as unknown as { persist: () => Promise<void> },
      'persist',
    ).mockImplementation(() => new Promise(() => undefined));
    const execute = vi.fn();
    const runner = new AgentJobRunner(store, { run: execute }, {
      storageWriteTimeoutMs: 20,
    });

    await expect(runner.resume(CLIENT_ID, stored.id, undefined))
      .rejects.toMatchObject({ code: 'RUN_STORAGE_TIMEOUT' });

    expect(execute).not.toHaveBeenCalled();
    expect(store.get(stored.id)).toMatchObject({
      status: 'waiting_user',
      error: { code: 'RUN_STORAGE_TIMEOUT' },
    });
  });
});
