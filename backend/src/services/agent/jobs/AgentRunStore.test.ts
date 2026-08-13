import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentRunStore } from './AgentRunStore.js';

const CLIENT_A = 'a'.repeat(64);
const CLIENT_B = 'b'.repeat(64);

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
});
