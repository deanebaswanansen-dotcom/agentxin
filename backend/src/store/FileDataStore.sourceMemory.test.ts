import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileDataStore, type FileDataStoreState } from './FileDataStore.js';
import { createClientScopedDataStore } from './ClientScopedDataStore.js';
import { runWithStoredClientId } from '../services/client/clientScope.js';
import { hashWriteBriefValue } from '../services/writing/WriteBrief.js';
import { captureNovelWriteBrief } from './NovelWriteGuard.js';
import { projectSourceMemory } from '../services/memory/sourceMemoryContract.js';
import { ChapterService } from '../services/chapter/ChapterService.js';
import { registerChapterRoutes } from '../routes/chapterRoutes.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const lease = () => ({ owner: 'novel-worker', now: new Date().toISOString(), leaseMs: 60_000 });

describe('novel atomic accepted sources', () => {
  let root: string; let file: string; let store: FileDataStore; let projectId: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'novel-accepted-')); file = join(root, 'store.json'); store = await FileDataStore.create(file); projectId = (await store.createProject('旧城')).id; });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  async function chapter(title = '第1章') { const created = await store.createChapter(projectId, title); return store.updateChapterContent(created.id, `😀${title}：钥匙留在门外。\r\n门锁没有损坏。`, 0); }
  async function accept(id: string) { const current = (await store.getChapter(id))!; return store.acceptChapter({ chapterId: id, expectedRevision: current.revision!, contentHash: hashWriteBriefValue(current.content) }); }
  function failPersist() { return vi.spyOn(store as unknown as { persist(state: FileDataStoreState): Promise<void> }, 'persist').mockRejectedValueOnce(new Error('disk-failed')); }

  it('keeps manual temporary saves unaccepted, then atomically accepts exact saved content and an outbox', async () => {
    const draft = await chapter();
    expect(await store.getMemorySync(projectId)).toBeUndefined();
    const saved = await accept(draft.id);
    expect(saved.content).toBe(draft.content); expect(saved.revision).toBe(draft.revision);
    expect(saved.acceptance?.status).toBe('current');
    const state = JSON.parse(await readFile(file, 'utf8')) as FileDataStoreState;
    const source = state.projects[0]!.novelAcceptances![0]!;
    expect(state.chapters[0]!.acceptance!.id).toBe(source.id);
    expect(source.memoryInput.blocks.map((block) => block.text).join('')).toBe(draft.content);
    expect(state.projects[0]!.memorySync).toMatchObject({ status: 'pending', attempts: 0, projection: { acceptances: [source.memoryInput] } });
    expect(projectSourceMemory(state.projects[0]!.memorySync!.projection, 1).entries).toEqual([]);
  });

  it('accepts a generated candidate with source/revision/hash gates in the same write and remains idempotent for author acceptance', async () => {
    const draft = await chapter(); const brief = await captureNovelWriteBrief(store, draft.id);
    const content = '新稿中钥匙留在门外。';
    const accepted = await store.acceptChapter({ chapterId: draft.id, content, contentHash: hashWriteBriefValue(content), expectedRevision: draft.revision!, guard: { brief } });
    expect(accepted.revision).toBe(draft.revision! + 1); expect(accepted.generatedCandidate?.candidateHash).toBe(hashWriteBriefValue(content));
    await accept(draft.id);
    expect((await store.getProject(projectId))!.novelAcceptances).toHaveLength(1);
  });

  it('keeps the replacement intent stable when chapters were accepted out of order', async () => {
    const first = await chapter(); const second = await chapter('第2章');
    await accept(second.id); await accept(first.id);
    const before = await store.getMemorySync(projectId);
    expect(before!.projection.acceptances.map((input) => input.source.unitNumber)).toEqual([1, 2]);
    await store.createCharacter(projectId, '作者新增人物', '不改已接受正文');
    expect(await store.getMemorySync(projectId)).toEqual(before);
    store = await FileDataStore.create(file);
    expect(await store.getMemorySync(projectId)).toEqual(before);
  });

  it.each(['revision', 'hash', 'source'] as const)('rejects a stale %s before publishing any body or acceptance', async (change) => {
    const draft = await chapter(); const brief = await captureNovelWriteBrief(store, draft.id);
    if (change === 'source') await store.createCharacter(projectId, '新人', '在生成期间新增');
    const before = await readFile(file, 'utf8');
    await expect(store.acceptChapter({ chapterId: draft.id, content: 'new', contentHash: change === 'hash' ? 'bad' : hashWriteBriefValue('new'),
      expectedRevision: change === 'revision' ? 0 : draft.revision!, guard: { brief } })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before); expect((await store.getChapter(draft.id))!.content).toBe(draft.content);
  });

  it('does not publish failed manual saves or failed acceptance to readers or disk', async () => {
    const draft = await chapter(); const before = await readFile(file, 'utf8');
    failPersist(); await expect(store.updateChapterContent(draft.id, 'lost', draft.revision)).rejects.toThrow('disk-failed');
    expect(await store.getChapter(draft.id)).toEqual(draft); expect(await readFile(file, 'utf8')).toBe(before);
    failPersist(); await expect(accept(draft.id)).rejects.toThrow('disk-failed');
    expect(await store.getChapter(draft.id)).toEqual(draft); expect(await store.getMemorySync(projectId)).toBeUndefined();
  });

  it.each(['edit', 'rename', 'delete', 'reorder'] as const)('withdraws the changed source and manuscript-dependent successors after %s', async (change) => {
    const first = await chapter(); const second = await chapter('第2章');
    await accept(first.id); await accept(second.id);
    if (change === 'edit') await store.updateChapterContent(first.id, '作者手改', first.revision);
    if (change === 'rename') await store.renameChapter(first.id, '作者改标题');
    if (change === 'delete') await store.deleteChapter(first.id);
    if (change === 'reorder') await store.reorderChapters(projectId, [second.id, first.id]);
    const project = (await store.getProject(projectId))!;
    expect(project.novelAcceptances!.every((item) => item.status === 'stale')).toBe(true);
    expect(project.memorySync!.projection.acceptances).toEqual([]);
    expect(project.memorySync!.status).toBe('pending');
    if (change !== 'delete') { await store.reorderChapters(projectId, [first.id, second.id]); expect((await store.getMemorySync(projectId))!.projection.acceptances).toEqual([]); }
  });

  it('persists a confirmed fact correction and retraction together, and deleting it never revives old sources', async () => {
    const first = await chapter(); await accept(first.id); const second = await chapter('第2章'); await accept(second.id);
    const source = (await store.getMemorySync(projectId))!.projection.acceptances[0]!.source;
    const input = { kind: 'fact_correction' as const, text: '钥匙实际上在作者指定的新位置', enabled: true, importance: 'required' as const, fromUnit: 1, source };
    await expect(store.upsertStoryControl(projectId, input, 0)).rejects.toThrow();
    const controls = await store.upsertStoryControl(projectId, { ...input, resolutionConfirmed: true }, 0);
    expect((await store.getMemorySync(projectId))!.projection.acceptances).toEqual([]);
    expect((await store.getChapter(first.id))!.content).toBe(first.content);
    const brief = await captureNovelWriteBrief(store, second.id);
    expect(brief.required.some((item) => item.text.includes(input.text)) || JSON.stringify(brief).includes(input.text)).toBe(true);
    await store.deleteStoryControl(projectId, controls.items[0]!.id, controls.revision);
    expect((await store.getMemorySync(projectId))!.projection.acceptances).toEqual([]);
    await expect(store.upsertStoryControl(projectId, { ...input, resolutionConfirmed: true }, 2)).rejects.toThrow();
  });

  it('freezes only provided candidate entries, with missing/misquoted evidence unverified', async () => {
    const draft = await chapter();
    await store.acceptChapter({ chapterId: draft.id, expectedRevision: draft.revision!, contentHash: hashWriteBriefValue(draft.content), entries: [
      { id: 'unsupported', kind: 'fact', text: '国王死亡', evidence: [] },
      { id: 'wrong-quote', kind: 'state', entity: '国王', key: 'alive_status:current', value: 'dead', action: 'set', text: '国王死亡', evidence: [{ blockId: 'paragraph-1', start: 0, end: 2, quote: '国王' }] },
    ] });
    const view = projectSourceMemory((await store.getMemorySync(projectId))!.projection, 2);
    expect(view.entries).toEqual([]); expect(view.unverifiedReferences).toHaveLength(2);
  });

  it('reclaims expired leases, ignores old owners, and requires explicit failed retry with no raw error', async () => {
    const draft = await chapter(); await accept(draft.id);
    const old = (await store.claimMemorySync(projectId, { ...lease(), now: new Date(Date.now() - 2000).toISOString(), leaseMs: 1000 }))!;
    const current = (await store.claimMemorySync(projectId, lease()))!;
    const write = vi.fn(async () => {}); expect(await store.applyMemorySync(projectId, old, write)).toBeUndefined(); expect(write).not.toHaveBeenCalled();
    await store.applyMemorySync(projectId, current, async () => { throw new Error('secret-api-key'); });
    expect(JSON.stringify(await store.getMemorySync(projectId))).not.toContain('secret-api-key');
    expect(await store.claimMemorySync(projectId, lease())).toBeUndefined();
    expect(await store.claimMemorySync(projectId, { ...lease(), retryFailed: true })).toBeDefined();
    expect((await store.getChapter(draft.id))!.acceptance!.status).toBe('current');
  });

  it('leaves an unpersisted ACK replayable across restart using the identical frozen projection', async () => {
    const draft = await chapter(); await accept(draft.id);
    const claim = (await store.claimMemorySync(projectId, lease()))!; const projection = (await store.getMemorySync(projectId))!.projection;
    const write = vi.fn(async () => {}); failPersist(); await expect(store.applyMemorySync(projectId, claim, write)).rejects.toThrow('disk-failed');
    expect((await store.getMemorySync(projectId))!.status).toBe('running');
    store = await FileDataStore.create(file);
    const retry = (await store.claimMemorySync(projectId, { ...lease(), now: new Date(Date.parse(claim.lease.expiresAt) + 1).toISOString() }))!;
    await store.applyMemorySync(projectId, retry, write);
    expect(write.mock.calls).toEqual([[projection], [projection]]);
  });

  it('serializes a projection callback with all data mutations, and deletion blocks late ACK resurrection', async () => {
    const draft = await chapter(); await accept(draft.id); const claim = (await store.claimMemorySync(projectId, lease()))!;
    const entered = deferred(); const release = deferred();
    const applying = store.applyMemorySync(projectId, claim, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const editing = store.updateChapterContent(draft.id, '作者新稿', draft.revision);
    expect((await store.getChapter(draft.id))!.content).toBe(draft.content);
    release.resolve(); await applying; await editing;
    expect((await store.getMemorySync(projectId))!.projection.acceptances).toEqual([]);
    await store.deleteProject(projectId);
    const write = vi.fn(async () => {});
    expect(await store.applyMemorySync(projectId, claim, write)).toBeUndefined(); expect(write).not.toHaveBeenCalled();
    expect(await store.claimMemorySync(projectId, lease())).toBeUndefined(); expect(await store.getProject(projectId)).toBeUndefined();
  });

  it('repairs source/body mismatch on restart without reaccepting changed content, while legacy remains untracked', async () => {
    const draft = await chapter(); await accept(draft.id);
    const disk = JSON.parse(await readFile(file, 'utf8')) as FileDataStoreState; disk.chapters[0]!.content = '盘上变文';
    await writeFile(file, JSON.stringify(disk), 'utf8'); store = await FileDataStore.create(file);
    expect((await store.getMemorySync(projectId))!.projection.acceptances).toEqual([]);
    const legacy = await chapter('旧导入章'); expect(legacy.acceptance).toBeUndefined();
  });

  it('discovers all client libraries and never applies a cross-client claim', async () => {
    const directory = join(root, 'clients'); const scoped = createClientScopedDataStore(directory);
    const clients = ['local', 'a'.repeat(64), 'b'.repeat(64)]; const ids: string[] = [];
    for (const clientId of clients) await runWithStoredClientId(clientId, async () => {
      const project = await scoped.createProject('client'); ids.push(project.id);
      const draft = await scoped.createChapter(project.id, '第一章'); const saved = await scoped.updateChapterContent(draft.id, '原文', 0);
      await scoped.acceptChapter!({ chapterId: saved.id, expectedRevision: saved.revision!, contentHash: hashWriteBriefValue(saved.content) });
    });
    await writeFile(join(directory, `${'c'.repeat(64)}.json`), '{broken', 'utf8');
    const fresh = createClientScopedDataStore(directory); expect(await fresh.listMemorySyncTargets!()).toHaveLength(3);
    const claim = (await runWithStoredClientId(clients[1]!, () => fresh.claimMemorySync!(ids[1]!, lease())))!;
    const write = vi.fn(async () => {});
    expect(await runWithStoredClientId(clients[2]!, () => fresh.applyMemorySync!(ids[1]!, claim, write))).toBeUndefined(); expect(write).not.toHaveBeenCalled();
  });

  it('requires a current full-body confirmation through the author HTTP endpoint', async () => {
    const draft = await chapter(); const app = Fastify(); registerChapterRoutes(app, new ChapterService(store));
    try {
      const preview = (await app.inject({ method: 'GET', url: `/api/chapters/${draft.id}/accept-source` })).json();
      expect(preview.content).toBe(draft.content);
      const accepted = await app.inject({ method: 'POST', url: `/api/chapters/${draft.id}/accept-source`, payload: { expectedRevision: preview.revision, expectedContentHash: preview.contentHash } });
      expect(accepted.statusCode).toBe(200); expect(accepted.json().acceptance.status).toBe('current');
      await store.updateChapterContent(draft.id, '作者另一次编辑', draft.revision);
      expect((await app.inject({ method: 'POST', url: `/api/chapters/${draft.id}/accept-source`, payload: { expectedRevision: preview.revision, expectedContentHash: preview.contentHash } })).statusCode).toBe(409);
    } finally { await app.close(); }
  });

  it('fails closed on corrupt persisted author controls without rewriting the library', async () => {
    const disk = JSON.parse(await readFile(file, 'utf8')) as FileDataStoreState;
    disk.projects[0]!.storyControls = { schemaVersion: 1, revision: -1, items: [] };
    await writeFile(file, JSON.stringify(disk), 'utf8'); const before = await readFile(file, 'utf8');
    await expect(FileDataStore.create(file)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});
