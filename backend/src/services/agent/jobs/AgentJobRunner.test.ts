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
