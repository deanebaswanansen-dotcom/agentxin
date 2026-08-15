import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithClientId } from '../client/clientScope.js';
import type { ScriptPipelineCheckpoint } from './agents/ScriptDirector.js';
import {
  FileScriptCheckpointStore,
  createClientScopedScriptCheckpointStore,
} from './FileScriptCheckpointStore.js';

function checkpoint(
  overrides: Partial<ScriptPipelineCheckpoint> = {},
): ScriptPipelineCheckpoint {
  return {
    projectId: 'project-1',
    runKey: 'script_episode_batch:1-5',
    node: 'draft',
    status: 'completed',
    attempt: 1,
    artifactRevision: 1,
    episodeNumber: 1,
    artifact: { title: '第一集' },
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('FileScriptCheckpointStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'script-checkpoints-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists saved checkpoints and restores them after restart', async () => {
    const store = await FileScriptCheckpointStore.create(root);
    const saved = checkpoint();

    await store.save(saved);

    expect(await store.list(saved.projectId, saved.runKey)).toEqual([saved]);
    const restarted = await FileScriptCheckpointStore.create(root);
    expect(await restarted.list(saved.projectId, saved.runKey)).toEqual([saved]);
  });

  it('upserts the same node, episode, and chunk checkpoint', async () => {
    const store = await FileScriptCheckpointStore.create(root);
    await store.save(
      checkpoint({ chunkStart: 1, status: 'running', artifactRevision: 0 }),
    );
    const completed = checkpoint({
      chunkStart: 1,
      status: 'completed',
      attempt: 2,
      artifactRevision: 2,
      artifact: { title: '修订后的第一集' },
      updatedAt: '2026-08-14T00:01:00.000Z',
    });

    await store.save(completed);

    expect(await store.list(completed.projectId, completed.runKey)).toEqual([completed]);
  });

  it('isolates checkpoints by project and run key', async () => {
    const store = await FileScriptCheckpointStore.create(root);
    const projectOnePlan = checkpoint({ runKey: 'script_plan', node: 'plan' });
    const projectOneBatch = checkpoint();
    const projectTwoBatch = checkpoint({ projectId: 'project-2' });

    await store.save(projectOnePlan);
    await store.save(projectOneBatch);
    await store.save(projectTwoBatch);

    expect(await store.list('project-1', 'script_plan')).toEqual([projectOnePlan]);
    expect(await store.list('project-1', 'script_episode_batch:1-5')).toEqual([
      projectOneBatch,
    ]);
    expect(await store.list('project-2', 'script_episode_batch:1-5')).toEqual([
      projectTwoBatch,
    ]);
  });

  it('deletes only the requested project checkpoint directory', async () => {
    const store = await FileScriptCheckpointStore.create(root);
    const projectOne = checkpoint();
    const projectTwo = checkpoint({ projectId: 'project-2' });
    await store.save(projectOne);
    await store.save(projectTwo);

    await store.deleteProject('project-1');

    await expect(store.list('project-1', projectOne.runKey)).resolves.toEqual([]);
    await expect(store.list('project-2', projectTwo.runKey)).resolves.toEqual([projectTwo]);
    await expect(readdir(join(root, 'project-1'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent saves without losing a checkpoint or leaving temp files', async () => {
    const store = await FileScriptCheckpointStore.create(root);
    const scenePlan = checkpoint({ node: 'scene_plan' });
    const draft = checkpoint({ node: 'draft' });

    await Promise.all([store.save(scenePlan), store.save(draft)]);

    expect(await store.list(draft.projectId, draft.runKey)).toEqual([
      scenePlan,
      draft,
    ]);
    const files = await readdir(join(root, draft.projectId));
    expect(files).toHaveLength(1);
    expect(files.some((file) => file.includes('.tmp-'))).toBe(false);
  });

  it('isolates identical project and run keys by browser client id', async () => {
    const store = createClientScopedScriptCheckpointStore(root);
    const clientA = 'a'.repeat(64);
    const clientB = 'b'.repeat(64);
    const checkpointA = checkpoint({ artifact: { title: 'A' } });
    const checkpointB = checkpoint({ artifact: { title: 'B' } });

    await runWithClientId(clientA, () => store.save(checkpointA));
    await runWithClientId(clientB, () => store.save(checkpointB));

    await expect(
      runWithClientId(clientA, () => store.list('project-1', checkpointA.runKey)),
    ).resolves.toEqual([checkpointA]);
    await expect(
      runWithClientId(clientB, () => store.list('project-1', checkpointB.runKey)),
    ).resolves.toEqual([checkpointB]);
    expect((await readdir(root)).sort()).toEqual([clientA, clientB]);
  });
});
