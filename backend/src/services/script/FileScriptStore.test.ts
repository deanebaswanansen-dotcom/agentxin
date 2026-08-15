import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithClientId } from '../client/clientScope.js';
import type { ScriptPlan } from './domain.js';
import {
  FileScriptStore,
  createClientScopedScriptStore,
} from './FileScriptStore.js';
import { ScriptConflictError } from './ScriptStore.js';

function plan(projectId = 'project-1'): ScriptPlan {
  return {
    id: 'plan-1',
    projectId,
    status: 'draft',
    revision: 0,
    title: '沈家风云',
    theme: '打破旧规',
    market: 'domestic',
    channel: 'female',
    genres: ['都市', '家庭'],
    audience: '女性观众',
    coreConflict: '新旧规则冲突',
    logline: '新媳妇用现代方式打破家族绑架。',
    highlights: ['反向打脸'],
    totalEpisodes: 10,
    episodeDurationSeconds: { min: 60, max: 90 },
    targetCharsPerEpisode: 1_200,
    maxPrimaryCharacters: 8,
    maxScenesPerEpisode: 3,
    dialogueDensityPercent: 65,
    language: 'zh-CN',
    format: 'cn_short_drama',
    coreRequirements: '快节奏',
    forbiddenElements: [],
    endingDirection: '和解',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  };
}

describe('FileScriptStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'script-store-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('atomically persists a project and restores it after restart', async () => {
    const store = await FileScriptStore.create(root);
    const saved = await store.savePlan(plan(), 0);

    expect(saved.revision).toBe(1);
    const files = await readdir(root);
    expect(files).toEqual(['project-1.json']);
    expect(files.some((file) => file.includes('.tmp-'))).toBe(false);

    const restarted = await FileScriptStore.create(root);
    expect((await restarted.getProjectState('project-1'))?.plan).toEqual(saved);
  });

  it('rejects a stale revision without overwriting the current artifact', async () => {
    const store = await FileScriptStore.create(root);
    const first = await store.savePlan(plan(), 0);

    await expect(
      store.savePlan({ ...first, title: '过期修改' }, 0),
    ).rejects.toBeInstanceOf(ScriptConflictError);
    expect((await store.getProjectState('project-1'))?.plan?.title).toBe('沈家风云');
  });

  it('serializes concurrent compare-and-save operations so only one wins', async () => {
    const store = await FileScriptStore.create(root);

    const results = await Promise.allSettled([
      store.savePlan({ ...plan(), title: 'A' }, 0),
      store.savePlan({ ...plan(), title: 'B' }, 0),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await store.getProjectState('project-1'))?.plan?.revision).toBe(1);
  });

  it('isolates identical project ids by the request client id', async () => {
    const store = createClientScopedScriptStore(root);
    const clientA = 'a'.repeat(64);
    const clientB = 'b'.repeat(64);

    await runWithClientId(clientA, () => store.savePlan({ ...plan(), title: 'A' }, 0));
    await runWithClientId(clientB, () => store.savePlan({ ...plan(), title: 'B' }, 0));

    const titleA = await runWithClientId(
      clientA,
      async () => (await store.getProjectState('project-1'))?.plan?.title,
    );
    const titleB = await runWithClientId(
      clientB,
      async () => (await store.getProjectState('project-1'))?.plan?.title,
    );
    expect([titleA, titleB]).toEqual(['A', 'B']);
    expect(await readdir(root)).toEqual([clientA, clientB]);
  });

  it('deletes the project file without touching another project', async () => {
    const store = await FileScriptStore.create(root);
    await store.savePlan(plan('project-1'), 0);
    await store.savePlan(plan('project-2'), 0);

    await store.deleteProject('project-1');

    expect(await store.getProjectState('project-1')).toBeUndefined();
    expect((await store.getProjectState('project-2'))?.plan).toBeDefined();
    expect(await readdir(root)).toEqual(['project-2.json']);
  });

  it('atomically saves continuity ledgers without exposing mutable store state', async () => {
    const store = await FileScriptStore.create(root);
    const saved = await store.saveContinuity('project-1', {
      currentState: ['沈清已发现泡面桶'],
      openThreads: ['太奶奶的绝食谎言'],
      wardrobeLedger: [
        { episodeNumber: 1, characterId: 'character-1', outfit: '白衬衫与黑色西装裤' },
      ],
    });
    saved.currentState.push('外部篡改');

    const restarted = await FileScriptStore.create(root);
    expect((await restarted.getProjectState('project-1'))?.continuity).toEqual({
      currentState: ['沈清已发现泡面桶'],
      openThreads: ['太奶奶的绝食谎言'],
      wardrobeLedger: [
        { episodeNumber: 1, characterId: 'character-1', outfit: '白衬衫与黑色西装裤' },
      ],
    });
  });

  it('rejects unknown schema versions instead of overwriting them', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'project-1.json'),
      JSON.stringify({ schemaVersion: 99, projectId: 'project-1' }),
      'utf8',
    );
    const store = await FileScriptStore.create(root);

    await expect(store.getProjectState('project-1')).rejects.toMatchObject({
      code: 'STORE_ERROR',
    });
    expect(JSON.parse(await readFile(join(root, 'project-1.json'), 'utf8'))).toMatchObject({
      schemaVersion: 99,
    });
  });
});
