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
    await runner.cancel(CLIENT_ID, created.id);
    finish();
    await runner.waitUntilIdle(created.id);

    expect(store.get(created.id)?.status).toBe('cancelled');
    expect(store.get(created.id)?.result).toBeUndefined();
  });
});
