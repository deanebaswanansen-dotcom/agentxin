import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithClientId } from '../client/clientScope.js';
import type {
  ScriptPipelineCheckpoint,
  ScriptPipelineCheckpointWrite,
} from './agents/ScriptCheckpoint.js';
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
    schemaVersion: 2,
    status: 'succeeded',
    attempt: 1,
    artifactRevision: 1,
    episodeNumber: 1,
    inputRevisionRefs: [{ resource: 'plan', id: 'plan-1', revision: 3 }],
    upstreamArtifactRefs: [],
    promptVersion: 'draft-v1',
    configRevision: 'model-config-v1',
    inputFingerprint: 'a'.repeat(64),
    validationErrors: [],
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
      status: 'succeeded',
      attempt: 2,
      artifactRevision: 2,
      artifact: { title: '修订后的第一集' },
      updatedAt: '2026-08-14T00:01:00.000Z',
    });

    await store.save(completed);

    expect(await store.list(completed.projectId, completed.runKey)).toEqual([completed]);
  });

  it('normalizes an unversioned legacy call-site write to a non-reusable v2 record', async () => {
    const store = await FileScriptCheckpointStore.create(root);
    const legacyWrite: ScriptPipelineCheckpointWrite = {
      projectId: 'project-1',
      runKey: 'legacy-write',
      node: 'draft',
      status: 'completed',
      attempt: 1,
      artifactRevision: 1,
      episodeNumber: 1,
      artifact: { title: '旧调用方候选' },
      updatedAt: '2026-08-14T00:00:00.000Z',
    };

    await store.save(legacyWrite);

    await expect(store.list(legacyWrite.projectId, legacyWrite.runKey)).resolves.toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        status: 'succeeded',
        inputRevisionRefs: [],
        upstreamArtifactRefs: [],
        promptVersion: 'legacy-unversioned',
        configRevision: 'legacy-unversioned',
        inputFingerprint: '',
        validationErrors: [],
      }),
    ]);
  });

  it('migrates a v1 file in memory and persists v2 idempotently on the next save', async () => {
    const projectId = 'project-1';
    const runKey = 'legacy-run';
    const encodedRunKey = Buffer.from(runKey, 'utf8').toString('base64url');
    const filePath = join(root, projectId, `${encodedRunKey}.json`);
    const v1 = {
      schemaVersion: 1,
      projectId,
      runKey,
      checkpoints: [
        {
          projectId,
          runKey,
          node: 'draft',
          status: 'completed',
          attempt: 1,
          artifactRevision: 1,
          episodeNumber: 1,
          artifact: { title: '旧候选' },
          updatedAt: '2026-08-14T00:00:00.000Z',
        },
        {
          projectId,
          runKey,
          node: 'review',
          status: 'running',
          attempt: 2,
          artifactRevision: 1,
          episodeNumber: 1,
          updatedAt: '2026-08-14T00:01:00.000Z',
        },
      ],
    };
    await mkdir(join(root, projectId), { recursive: true });
    await writeFile(filePath, JSON.stringify(v1), 'utf8');
    const store = await FileScriptCheckpointStore.create(root);

    const firstRead = await store.list(projectId, runKey);
    expect(firstRead.map((item) => item.status)).toEqual(['succeeded', 'pending']);
    expect(firstRead.every((item) => item.schemaVersion === 2)).toBe(true);
    expect(JSON.parse(await readFile(filePath, 'utf8')).schemaVersion).toBe(1);

    await store.save(firstRead[0]!);
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      schemaVersion: number;
      checkpoints: ScriptPipelineCheckpoint[];
    };
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.checkpoints).toEqual(firstRead);

    const restarted = await FileScriptCheckpointStore.create(root);
    expect(await restarted.list(projectId, runKey)).toEqual(firstRead);
  });

  it('rejects an unknown outer schema without overwriting the file', async () => {
    const projectId = 'project-1';
    const runKey = 'future-run';
    const encodedRunKey = Buffer.from(runKey, 'utf8').toString('base64url');
    const filePath = join(root, projectId, `${encodedRunKey}.json`);
    const futureFile = JSON.stringify({
      schemaVersion: 99,
      projectId,
      runKey,
      checkpoints: [],
    });
    await mkdir(join(root, projectId), { recursive: true });
    await writeFile(filePath, futureFile, 'utf8');
    const store = await FileScriptCheckpointStore.create(root);

    await expect(store.list(projectId, runKey)).rejects.toThrow(/不支持.*版本 99/);
    await expect(store.save(checkpoint({ runKey }))).rejects.toThrow(/不支持.*版本 99/);
    expect(await readFile(filePath, 'utf8')).toBe(futureFile);
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
