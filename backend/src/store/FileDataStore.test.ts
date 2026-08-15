/**
 * Unit tests for {@link FileDataStore} — storage engine plumbing and project
 * operations (task 2.2). The restart-recovery property test lives in task 2.5;
 * these are example/edge-case unit tests covering the project CRUD surface,
 * cascade delete (Requirement 1.3) and atomic startup load (Requirement 7.3).
 *
 * Each test uses a unique temp file under the OS temp dir and cleans it up.
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileDataStore } from './FileDataStore.js';
import { isStoreError } from './StoreError.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fds-test-'));
  file = join(dir, 'store.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileDataStore project operations', () => {
  it('persists the explicit project kind for a short-drama project', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('我的短剧', 'short_drama');

    expect(project.kind).toBe('short_drama');
    await expect(FileDataStore.create(file).then((reloaded) => reloaded.getProject(project.id)))
      .resolves.toMatchObject({ kind: 'short_drama' });
  });

  it('creates a project with a UUID, timestamps and returns id+name in list', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('我的小说');

    expect(project.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(project.name).toBe('我的小说');
    expect(project.createdAt).toBe(project.updatedAt);
    expect(new Date(project.createdAt).toISOString()).toBe(project.createdAt);

    const list = await store.listProjects();
    expect(list).toEqual([{ id: project.id, name: '我的小说', kind: 'novel' }]);
  });

  it('generates unique ids across multiple creations', async () => {
    const store = await FileDataStore.create(file);
    const a = await store.createProject('a');
    const b = await store.createProject('b');
    const c = await store.createProject('c');
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it('getProject returns a copy and undefined for unknown id', async () => {
    const store = await FileDataStore.create(file);
    const created = await store.createProject('p');
    const fetched = await store.getProject(created.id);
    expect(fetched).toEqual(created);
    expect(fetched).not.toBe(created); // defensive copy

    expect(await store.getProject('missing')).toBeUndefined();
  });

  it('renames a project and bumps updatedAt', async () => {
    const store = await FileDataStore.create(file);
    const created = await store.createProject('old');
    // Ensure a later timestamp is observable.
    await new Promise((r) => setTimeout(r, 2));
    const renamed = await store.renameProject(created.id, 'new');

    expect(renamed.name).toBe('new');
    expect(renamed.createdAt).toBe(created.createdAt);
    expect(
      new Date(renamed.updatedAt).getTime(),
    ).toBeGreaterThanOrEqual(new Date(created.updatedAt).getTime());
  });

  it('renameProject throws (defensive guard) for a non-existent id', async () => {
    const store = await FileDataStore.create(file);
    await expect(store.renameProject('missing', 'x')).rejects.toThrow();
  });

  it('deleteProject cascades to chapters/characters/worldSettings/outlines', async () => {
    const store = await FileDataStore.create(file);
    const keep = await store.createProject('keep');
    const drop = await store.createProject('drop');

    // Seed associated entities for both projects directly in the persisted
    // file, then reload so we exercise cascade against real loaded state.
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.chapters = [
      { id: 'c1', projectId: drop.id, title: 't', content: '', position: 0 },
      { id: 'c2', projectId: keep.id, title: 't', content: '', position: 0 },
    ];
    raw.characters = [{ id: 'ch1', projectId: drop.id, name: 'n', description: 'd' }];
    raw.worldSettings = [{ id: 'w1', projectId: drop.id, title: 't', content: 'c' }];
    raw.outlines = [
      { id: 'o1', projectId: drop.id, title: 't', content: 'c', position: 0 },
    ];
    await writeFile(file, JSON.stringify(raw), 'utf8');

    const reloaded = await FileDataStore.create(file);
    await reloaded.deleteProject(drop.id);

    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.projects.map((p: { id: string }) => p.id)).toEqual([keep.id]);
    expect(persisted.chapters).toEqual([
      { id: 'c2', projectId: keep.id, title: 't', content: '', position: 0 },
    ]);
    expect(persisted.characters).toEqual([]);
    expect(persisted.worldSettings).toEqual([]);
    expect(persisted.outlines).toEqual([]);
  });
});

describe('FileDataStore chapter operations', () => {
  it('creates a chapter with UUID, empty content, and incrementing positions', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');

    const c1 = await store.createChapter(project.id, '第一章');
    const c2 = await store.createChapter(project.id, '第二章');

    expect(c1.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(c1.projectId).toBe(project.id);
    expect(c1.title).toBe('第一章');
    expect(c1.content).toBe('');
    expect(c1.position).toBe(0);
    expect(c2.position).toBe(1);
    expect(c1.id).not.toBe(c2.id);
  });

  it('assigns positions per project independently', async () => {
    const store = await FileDataStore.create(file);
    const a = await store.createProject('a');
    const b = await store.createProject('b');

    const a1 = await store.createChapter(a.id, 'a1');
    const b1 = await store.createChapter(b.id, 'b1');
    const a2 = await store.createChapter(a.id, 'a2');

    expect(a1.position).toBe(0);
    expect(a2.position).toBe(1);
    expect(b1.position).toBe(0);
  });

  it('listChapters returns only the project chapters sorted by position ascending', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const other = await store.createProject('other');
    await store.createChapter(other.id, 'noise');

    const c1 = await store.createChapter(project.id, 'one');
    const c2 = await store.createChapter(project.id, 'two');
    const c3 = await store.createChapter(project.id, 'three');

    // Shuffle positions via reorder, then assert ascending list order.
    await store.reorderChapters(project.id, [c3.id, c1.id, c2.id]);

    const list = await store.listChapters(project.id);
    expect(list.map((c) => c.title)).toEqual(['three', 'one', 'two']);
    const positions = list.map((c) => c.position);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    // Other project's chapter is excluded.
    expect(list.every((c) => c.projectId === project.id)).toBe(true);
  });

  it('getChapter returns a copy and undefined for unknown id', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const created = await store.createChapter(project.id, 't');

    const fetched = await store.getChapter(created.id);
    expect(fetched).toEqual(created);
    expect(fetched).not.toBe(created); // defensive copy
    expect(await store.getChapter('missing')).toBeUndefined();
  });

  it('updateChapterContent persists arbitrary content and returns updated copy', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const created = await store.createChapter(project.id, 't');

    const content = '第一行\n  含空白与特殊字符 <>&"\t末尾';
    const updated = await store.updateChapterContent(created.id, content);
    expect(updated.content).toBe(content);

    // Reload from disk to confirm persistence.
    const reloaded = await FileDataStore.create(file);
    const fetched = await reloaded.getChapter(created.id);
    expect(fetched?.content).toBe(content);
  });

  it('updateChapterContent throws (defensive guard) for a non-existent id', async () => {
    const store = await FileDataStore.create(file);
    await expect(store.updateChapterContent('missing', 'x')).rejects.toThrow();
  });

  it('reorderChapters makes listChapters follow the provided id order', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const c1 = await store.createChapter(project.id, 'one');
    const c2 = await store.createChapter(project.id, 'two');
    const c3 = await store.createChapter(project.id, 'three');

    await store.reorderChapters(project.id, [c2.id, c3.id, c1.id]);

    const list = await store.listChapters(project.id);
    expect(list.map((c) => c.id)).toEqual([c2.id, c3.id, c1.id]);
  });

  it('reorderChapters appends unlisted chapters after listed ones, preserving relative order', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const c1 = await store.createChapter(project.id, 'one');
    const c2 = await store.createChapter(project.id, 'two');
    const c3 = await store.createChapter(project.id, 'three');

    // Only mention c3; c1 and c2 should trail in their existing order.
    await store.reorderChapters(project.id, [c3.id]);

    const list = await store.listChapters(project.id);
    expect(list.map((c) => c.id)).toEqual([c3.id, c1.id, c2.id]);
  });

  it('deleteChapter removes only the target and leaves others intact', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const c1 = await store.createChapter(project.id, 'one');
    const c2 = await store.createChapter(project.id, 'two');

    await store.deleteChapter(c1.id);

    expect(await store.getChapter(c1.id)).toBeUndefined();
    const remaining = await store.listChapters(project.id);
    expect(remaining.map((c) => c.id)).toEqual([c2.id]);

    // Idempotent for unknown ids.
    await expect(store.deleteChapter('missing')).resolves.toBeUndefined();
  });
});

describe('FileDataStore storage engine', () => {
  it('initializes empty structure when the file is missing', async () => {
    const store = await FileDataStore.create(file);
    expect(await store.listProjects()).toEqual([]);
  });

  it('persists atomically and reloads data across instances (startup load)', async () => {
    const first = await FileDataStore.create(file);
    const created = await first.createProject('persist-me');

    // No leftover temp files should remain after an atomic write.
    const second = await FileDataStore.create(file);
    const list = await second.listProjects();
    expect(list).toEqual([{ id: created.id, name: 'persist-me', kind: 'novel' }]);
  });

  it('migrates legacy projects without a kind to novel on load', async () => {
    await writeFile(file, JSON.stringify({
      projects: [{ id: 'legacy', name: '旧项目', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    }), 'utf8');

    const store = await FileDataStore.create(file);
    await expect(store.getProject('legacy')).resolves.toMatchObject({ kind: 'novel' });
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    expect(migrated.projects[0].kind).toBe('novel');
  });

  it('throws StoreError when the data file contains invalid JSON', async () => {
    await writeFile(file, '{ not valid json', 'utf8');
    await expect(FileDataStore.create(file)).rejects.toSatisfy(isStoreError);
  });

  it('returns undefined model config on a fresh store', async () => {
    const store = await FileDataStore.create(file);
    await expect(store.getModelConfig()).resolves.toBeUndefined();
  });
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('FileDataStore character operations', () => {
  it('creates a character with a UUID and returns it in the project list', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');

    const character = await store.createCharacter(project.id, '林夜', '沉默的剑客');
    expect(character.id).toMatch(UUID_RE);
    expect(character.projectId).toBe(project.id);
    expect(character.name).toBe('林夜');
    expect(character.description).toBe('沉默的剑客');

    const list = await store.listCharacters(project.id);
    expect(list).toEqual([character]);
  });

  it('listCharacters returns copies scoped to the project', async () => {
    const store = await FileDataStore.create(file);
    const a = await store.createProject('a');
    const b = await store.createProject('b');
    const ca = await store.createCharacter(a.id, 'A', 'da');
    await store.createCharacter(b.id, 'B', 'db');

    const list = await store.listCharacters(a.id);
    expect(list.map((c) => c.id)).toEqual([ca.id]);
    // Mutating a returned copy must not affect stored state.
    list[0].name = 'mutated';
    const reread = await store.listCharacters(a.id);
    expect(reread[0].name).toBe('A');
  });

  it('updateCharacter applies partial field updates and persists', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const created = await store.createCharacter(project.id, 'old', 'olddesc');

    const updatedName = await store.updateCharacter(created.id, { name: 'new' });
    expect(updatedName.name).toBe('new');
    expect(updatedName.description).toBe('olddesc'); // unchanged

    const updatedDesc = await store.updateCharacter(created.id, {
      description: 'newdesc',
    });
    expect(updatedDesc.name).toBe('new');
    expect(updatedDesc.description).toBe('newdesc');

    const reloaded = await FileDataStore.create(file);
    const [persisted] = await reloaded.listCharacters(project.id);
    expect(persisted.name).toBe('new');
    expect(persisted.description).toBe('newdesc');
  });

  it('updateCharacter throws (defensive guard) for a non-existent id', async () => {
    const store = await FileDataStore.create(file);
    await expect(store.updateCharacter('missing', { name: 'x' })).rejects.toThrow();
  });

  it('deleteCharacter removes only the target and is idempotent', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const c1 = await store.createCharacter(project.id, 'one', 'd');
    const c2 = await store.createCharacter(project.id, 'two', 'd');

    await store.deleteCharacter(c1.id);
    const remaining = await store.listCharacters(project.id);
    expect(remaining.map((c) => c.id)).toEqual([c2.id]);

    await expect(store.deleteCharacter('missing')).resolves.toBeUndefined();
  });
});

describe('FileDataStore world setting operations', () => {
  it('creates a world setting with a UUID and returns it in the project list', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');

    const ws = await store.createWorldSetting(project.id, '魔法体系', '以星辰为源');
    expect(ws.id).toMatch(UUID_RE);
    expect(ws.projectId).toBe(project.id);
    expect(ws.title).toBe('魔法体系');
    expect(ws.content).toBe('以星辰为源');

    const list = await store.listWorldSettings(project.id);
    expect(list).toEqual([ws]);
  });

  it('listWorldSettings is scoped per project and returns copies', async () => {
    const store = await FileDataStore.create(file);
    const a = await store.createProject('a');
    const b = await store.createProject('b');
    const wa = await store.createWorldSetting(a.id, 'A', 'ca');
    await store.createWorldSetting(b.id, 'B', 'cb');

    const list = await store.listWorldSettings(a.id);
    expect(list.map((w) => w.id)).toEqual([wa.id]);
    list[0].title = 'mutated';
    const reread = await store.listWorldSettings(a.id);
    expect(reread[0].title).toBe('A');
  });

  it('updateWorldSetting applies partial field updates and persists', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const created = await store.createWorldSetting(project.id, 'old', 'oldc');

    const updated = await store.updateWorldSetting(created.id, { content: 'newc' });
    expect(updated.title).toBe('old'); // unchanged
    expect(updated.content).toBe('newc');

    const reloaded = await FileDataStore.create(file);
    const [persisted] = await reloaded.listWorldSettings(project.id);
    expect(persisted.content).toBe('newc');
  });

  it('updateWorldSetting throws (defensive guard) for a non-existent id', async () => {
    const store = await FileDataStore.create(file);
    await expect(
      store.updateWorldSetting('missing', { title: 'x' }),
    ).rejects.toThrow();
  });

  it('deleteWorldSetting removes only the target and is idempotent', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const w1 = await store.createWorldSetting(project.id, 'one', 'c');
    const w2 = await store.createWorldSetting(project.id, 'two', 'c');

    await store.deleteWorldSetting(w1.id);
    const remaining = await store.listWorldSettings(project.id);
    expect(remaining.map((w) => w.id)).toEqual([w2.id]);

    await expect(store.deleteWorldSetting('missing')).resolves.toBeUndefined();
  });
});

describe('FileDataStore outline operations', () => {
  it('creates outlines with UUIDs and incrementing positions per project', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');

    const o1 = await store.createOutline(project.id, '第一幕', '起');
    const o2 = await store.createOutline(project.id, '第二幕', '承');
    expect(o1.id).toMatch(UUID_RE);
    expect(o1.position).toBe(0);
    expect(o2.position).toBe(1);
    expect(o1.id).not.toBe(o2.id);
  });

  it('assigns outline positions per project independently', async () => {
    const store = await FileDataStore.create(file);
    const a = await store.createProject('a');
    const b = await store.createProject('b');

    const a1 = await store.createOutline(a.id, 'a1', 'c');
    const b1 = await store.createOutline(b.id, 'b1', 'c');
    const a2 = await store.createOutline(a.id, 'a2', 'c');

    expect(a1.position).toBe(0);
    expect(a2.position).toBe(1);
    expect(b1.position).toBe(0);
  });

  it('listOutlines returns project outlines sorted by position ascending', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const other = await store.createProject('other');
    await store.createOutline(other.id, 'noise', 'c');

    const o1 = await store.createOutline(project.id, 'one', 'c');
    const o2 = await store.createOutline(project.id, 'two', 'c');
    const o3 = await store.createOutline(project.id, 'three', 'c');

    const list = await store.listOutlines(project.id);
    expect(list.map((o) => o.id)).toEqual([o1.id, o2.id, o3.id]);
    const positions = list.map((o) => o.position);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(list.every((o) => o.projectId === project.id)).toBe(true);
  });

  it('updateOutline applies partial field updates and persists', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const created = await store.createOutline(project.id, 'old', 'oldc');

    const updated = await store.updateOutline(created.id, { title: 'new' });
    expect(updated.title).toBe('new');
    expect(updated.content).toBe('oldc'); // unchanged
    expect(updated.position).toBe(created.position); // position untouched

    const reloaded = await FileDataStore.create(file);
    const [persisted] = await reloaded.listOutlines(project.id);
    expect(persisted.title).toBe('new');
  });

  it('updateOutline throws (defensive guard) for a non-existent id', async () => {
    const store = await FileDataStore.create(file);
    await expect(store.updateOutline('missing', { title: 'x' })).rejects.toThrow();
  });

  it('deleteOutline removes only the target and is idempotent', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const o1 = await store.createOutline(project.id, 'one', 'c');
    const o2 = await store.createOutline(project.id, 'two', 'c');

    await store.deleteOutline(o1.id);
    const remaining = await store.listOutlines(project.id);
    expect(remaining.map((o) => o.id)).toEqual([o2.id]);

    await expect(store.deleteOutline('missing')).resolves.toBeUndefined();
  });
});

describe('FileDataStore legacy Agent material migration', () => {
  it('deduplicates system materials on reload and keeps the latest content', async () => {
    const store = await FileDataStore.create(file);
    const project = await store.createProject('p');
    const firstRules = await store.createWorldSetting(
      project.id,
      '创作规则（计划采纳）',
      '旧规则',
    );
    await store.createWorldSetting(project.id, '创作规则（计划采纳）', '新规则');
    const firstPlan = await store.createOutline(
      project.id,
      '旧名：分章大纲（计划采纳）',
      '旧大纲',
    );
    await store.createOutline(project.id, '新名：分章大纲（计划采纳）', '新大纲');
    await store.createOutline(project.id, '作者自定义', '版本一');
    await store.createOutline(project.id, '作者自定义', '版本二');

    const reloaded = await FileDataStore.create(file);
    const worlds = await reloaded.listWorldSettings(project.id);
    const outlines = await reloaded.listOutlines(project.id);
    expect(worlds.filter((item) => item.title === '创作规则（计划采纳）')).toEqual([
      { ...firstRules, content: '新规则' },
    ]);
    expect(outlines.filter((item) => item.title.endsWith('：分章大纲（计划采纳）'))).toEqual([
      { ...firstPlan, title: '新名：分章大纲（计划采纳）', content: '新大纲' },
    ]);
    expect(outlines.filter((item) => item.title === '作者自定义')).toHaveLength(2);
  });
});

describe('FileDataStore model config operations', () => {
  it('returns undefined when no config has been saved', async () => {
    const store = await FileDataStore.create(file);
    expect(await store.getModelConfig()).toBeUndefined();
  });

  it('saves and reads back the model config across instances', async () => {
    const store = await FileDataStore.create(file);
    const config = {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-secret-1234',
      modelName: 'gpt-4o-mini',
    };
    await store.saveModelConfig(config);

    const read = await store.getModelConfig();
    expect(read).toEqual(config);

    // Persisted across a fresh instance (Requirement 7.3).
    const reloaded = await FileDataStore.create(file);
    expect(await reloaded.getModelConfig()).toEqual(config);
  });

  it('overwrites the previous config (single instance) on save', async () => {
    const store = await FileDataStore.create(file);
    await store.saveModelConfig({
      baseUrl: 'https://old.example.com',
      apiKey: 'sk-old',
      modelName: 'old-model',
    });
    await store.saveModelConfig({
      baseUrl: 'https://new.example.com',
      apiKey: 'sk-new',
      modelName: 'new-model',
    });

    expect(await store.getModelConfig()).toEqual({
      baseUrl: 'https://new.example.com',
      apiKey: 'sk-new',
      modelName: 'new-model',
    });
  });

  it('stores and returns defensive copies of the config', async () => {
    const store = await FileDataStore.create(file);
    const config = {
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-secret',
      modelName: 'm',
    };
    await store.saveModelConfig(config);

    // Mutating the source object after save must not affect stored state.
    config.apiKey = 'sk-tampered';
    const read = await store.getModelConfig();
    expect(read?.apiKey).toBe('sk-secret');

    // Mutating the returned copy must not affect stored state either.
    read!.apiKey = 'sk-tampered-2';
    const reread = await store.getModelConfig();
    expect(reread?.apiKey).toBe('sk-secret');
  });
});
