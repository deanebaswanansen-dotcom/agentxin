import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptedMemoryInput, FrozenMemoryProjection } from '../../types/SourceMemory.js';
import { createClientScopedMemoryStore } from '../../store/ClientScopedAuxiliaryStores.js';
import { runWithClientId } from '../client/clientScope.js';
import { MemoryService } from './MemoryService.js';
import { MemoryStore } from './MemoryStore.js';
import { createFrozenMemoryProjection, hashSourceMemoryBlocks, projectSourceMemory, validateFrozenMemoryProjection } from './sourceMemoryContract.js';

function accepted(unitNumber: number, value = '甲', options: { acceptanceId?: string; revision?: number; clientId?: string; mode?: 'short_drama' | 'novel' } = {}): AcceptedMemoryInput {
  const text = `🔑钥匙由${value}持有。`;
  const blocks = [{ id: `block-${unitNumber}`, sceneId: `scene-${unitNumber}`, text }];
  return {
    schemaVersion: 1, source: { clientId: options.clientId ?? 'local', projectId: 'project', mode: options.mode ?? 'short_drama',
      resourceId: `episode-${unitNumber}`, unitNumber, revision: options.revision ?? 1,
      contentHash: hashSourceMemoryBlocks(blocks), acceptanceId: options.acceptanceId ?? `acceptance-${unitNumber}` },
    title: `第${unitNumber}集`, acceptedAt: '2026-09-15T00:00:00.000Z', blocks,
    entries: [{ id: `state-${unitNumber}`, kind: 'state', text, entity: 'prop-key', key: 'holder', value, action: 'set',
      evidence: [{ blockId: blocks[0]!.id, start: 2, end: text.length, quote: text.slice(2) }] }],
  };
}
function projection(revision: number, acceptances: AcceptedMemoryInput[] = [], clientId = 'local', mode: 'short_drama' | 'novel' = 'short_drama'): FrozenMemoryProjection {
  return createFrozenMemoryProjection({ clientId, projectId: 'project', mode, revision, acceptances });
}

describe('source memory contract and historical projection', () => {
  it('hashes exact ordered block strings and canonical object fields', () => {
    const blocks = [{ id: '1', sceneId: 's', text: 'e\u0301\r\n甲' }, { id: '2', text: '乙' }];
    expect(hashSourceMemoryBlocks(blocks)).toBe(hashSourceMemoryBlocks([{ text: 'e\u0301\r\n甲', sceneId: 's', id: '1' }, { text: '乙', id: '2' }]));
    expect(hashSourceMemoryBlocks(blocks)).not.toBe(hashSourceMemoryBlocks([...blocks].reverse()));
    expect(hashSourceMemoryBlocks(blocks)).not.toBe(hashSourceMemoryBlocks([{ ...blocks[0]!, text: 'é\n甲' }, blocks[1]!]));
    const a = accepted(5), b = accepted(10, '乙');
    expect(projection(1, [a, b])).toEqual(projection(1, [b, a]));
  });

  it('freezes all acceptance metadata and isolates the caller input', () => {
    const a = accepted(5); const frozen = projection(1, [a]);
    a.entries[0]!.value = '伪造';
    expect(frozen.acceptances[0]!.entries[0]!.value).toBe('甲');
    const changed = structuredClone(frozen); changed.acceptances[0]!.title = '改名';
    expect(() => validateFrozenMemoryProjection(changed)).toThrow();
    expect(projection(2, [accepted(5)]).idempotencyKey).not.toBe(frozen.idempotencyKey);
    expect(projection(1, [{ ...accepted(5), acceptedAt: '2026-09-15T01:00:00.000Z' }]).contentHash).not.toBe(frozen.contentHash);
    expect(() => projection(1, [], 'arbitrary-client')).toThrow();
    expect(() => projection(1, [accepted(5, '甲', { clientId: 'a'.repeat(64) })])).toThrow();
  });

  it('accepts empty frozen blocks/entries without inventing facts', () => {
    const a = accepted(5); a.blocks = []; a.entries = []; a.source.contentHash = hashSourceMemoryBlocks([]);
    expect(projectSourceMemory(projection(1, [a]), 6).entries).toEqual([]);
  });

  it('matches exact UTF-16 citations without claiming semantic entailment', () => {
    const a = accepted(5); a.entries[0]!.text = '此陈述并不从引文推导';
    expect(projectSourceMemory(projection(1, [a]), 6).entries[0]).toMatchObject({ evidenceStatus: 'matched', text: '此陈述并不从引文推导' });
  });

  it.each(['missing', 'offset', 'quote', 'block', 'entity', 'key', 'value'] as const)('keeps %s evidence/identity failures unverified', (failure) => {
    const a = accepted(5), entry = a.entries[0]!;
    if (failure === 'missing') entry.evidence = [];
    if (failure === 'offset') entry.evidence[0]!.start = 1;
    if (failure === 'quote') entry.evidence[0]!.quote = '正文没有的话';
    if (failure === 'block') entry.evidence[0]!.blockId = 'missing';
    if (failure === 'entity') delete entry.entity;
    if (failure === 'key') delete entry.key;
    if (failure === 'value') delete entry.value;
    const view = projectSourceMemory(projection(1, [a]), 6);
    expect(view.entries).toEqual([]);
    expect(view.unverifiedReferences).toHaveLength(1);
  });

  it('queries chapter 7 as holding A and chapter 11 as holding B without future interval leakage', () => {
    const frozen = projection(1, [accepted(5), accepted(10, '乙')]);
    const early = projectSourceMemory(frozen, 7), late = projectSourceMemory(frozen, 11);
    expect(early.entries).toHaveLength(1);
    expect(early.entries[0]).toMatchObject({ value: '甲', status: 'active', effectiveFromUnit: 5 });
    expect(early.entries[0]).not.toHaveProperty('effectiveUntilUnit');
    expect(early.entries).toEqual(projectSourceMemory(projection(0, [accepted(5)]), 7).entries);
    expect(late.entries.map((entry) => entry.value)).toEqual(['乙']);
    expect(projectSourceMemory(frozen, 5).entries).toEqual([]);
  });

  it('does not let an unverified successor erase the previously matched state', () => {
    const b = accepted(10, '乙'); b.entries[0]!.evidence = [];
    const view = projectSourceMemory(projection(1, [accepted(5), b]), 11);
    expect(view.entries.map((entry) => entry.value)).toEqual(['甲']);
    expect(view.unverifiedReferences.map((entry) => entry.value)).toEqual(['乙']);
  });

  it('downgrades unordered same-unit conflicting states and keeps stable IDs case sensitive', () => {
    const b = accepted(10, '乙');
    b.entries.push({ ...structuredClone(b.entries[0]!), id: 'contradiction', value: '丙' });
    const view = projectSourceMemory(projection(1, [accepted(5), b]), 11);
    expect(view.entries.map((entry) => entry.value)).toEqual(['甲']);
    expect(view.unverifiedReferences).toHaveLength(2);
    expect(view.unverifiedReferences.every((entry) => entry.evidenceReason === 'conflicting_state_claims')).toBe(true);
    b.entries = b.entries.slice(0, 1); b.entries[0]!.entity = 'PROP-key';
    expect(projectSourceMemory(projection(1, [accepted(5), b]), 11).entries).toHaveLength(2);
  });

  it('projects thread lifecycle actions by stable identity at the requested time', () => {
    const a = accepted(5), b = accepted(10);
    a.entries[0] = { ...a.entries[0]!, kind: 'thread', entity: 'thread-1', key: 'thread', action: 'open' };
    b.entries[0] = { ...b.entries[0]!, kind: 'thread', entity: 'thread-1', key: 'thread', action: 'close' };
    expect(projectSourceMemory(projection(1, [a, b]), 7).entries[0]!.action).toBe('open');
    expect(projectSourceMemory(projection(1, [a, b]), 11).entries[0]!.action).toBe('close');
  });
});

describe('durable accepted-source memory', () => {
  let directory: string, file: string, store: MemoryStore, service: MemoryService;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'source-memory-')); file = join(directory, 'memory.json');
    store = await MemoryStore.create(file); service = new MemoryService(store);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

  it('applies idempotently, retains intervals/audit without frozen body copies, and survives restart', async () => {
    const frozen = projection(1, [accepted(5), accepted(10, '乙')]);
    await service.applySourceProjection(frozen);
    const bytes = await readFile(file, 'utf8');
    await service.applySourceProjection(frozen);
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect(bytes).not.toContain('"blocks"');
    expect(service.get('project').sourceMemory!.short_drama!.entries[0]).toMatchObject({ status: 'superseded', effectiveUntilUnit: 10 });
    service = new MemoryService(await MemoryStore.create(file));
    expect(service.querySourceMemory(frozen, 7)).toMatchObject({ origin: 'projection', entries: [{ value: '甲', status: 'active' }] });
    expect(service.querySourceMemory(frozen, 7).entries[0]).not.toHaveProperty('effectiveUntilUnit');
    const read = service.get('project'); read.sourceMemory!.short_drama!.entries[0]!.value = 'pollution';
    expect(service.querySourceMemory(frozen, 7).entries[0]!.value).toBe('甲');
  });

  it('uses only current accepted sources while cache lags; rejects older input after cache advances', async () => {
    const old = projection(1, [accepted(5)]), next = projection(2, [accepted(10, '乙')]);
    await service.applySourceProjection(old);
    expect(service.querySourceMemory(next, 11)).toMatchObject({ origin: 'accepted_sources', entries: [{ value: '乙' }] });
    expect(service.get('project').sourceMemory!.short_drama!.revision).toBe(1);
    await service.applySourceProjection(next);
    expect(() => service.querySourceMemory(old, 11)).toThrow(expect.objectContaining({ sourceMemoryCode: 'SOURCE_MEMORY_STALE' }));
    await expect(service.applySourceProjection(old)).rejects.toMatchObject({ code: 'CONFLICT', sourceMemoryCode: 'SOURCE_MEMORY_STALE' });
    await expect(service.applySourceProjection(projection(2, []))).rejects.toMatchObject({ sourceMemoryCode: 'SOURCE_MEMORY_CONFLICT' });
  });

  it('withdraws effects permanently, preserves source audit, and permits a new acceptance at the same body revision', async () => {
    await service.applySourceProjection(projection(1, [accepted(5)]));
    await service.applySourceProjection(projection(2, []));
    expect(service.querySourceMemory(projection(2, []), 11).entries).toEqual([]);
    const audit = service.get('project').sourceMemory!.short_drama!;
    expect(audit.sources[0]).toMatchObject({ status: 'stale', withdrawnAtRevision: 2 });
    expect(audit.entries[0]!.status).toBe('stale');
    await expect(service.applySourceProjection(projection(3, [accepted(5)]))).rejects.toMatchObject({ sourceMemoryCode: 'SOURCE_MEMORY_STALE' });
    expect(() => service.querySourceMemory(projection(3, [accepted(5)]), 11)).toThrow();
    const reaccepted = projection(3, [accepted(5, '甲', { acceptanceId: 'new-acceptance' })]);
    await service.applySourceProjection(reaccepted);
    expect(service.querySourceMemory(reaccepted, 7).entries[0]!.source.acceptanceId).toBe('new-acceptance');
    expect(service.get('project').sourceMemory!.short_drama!.sources).toHaveLength(2);
  });

  it('rejects mutable reuse of an acceptance ID and lower source revisions', async () => {
    await service.applySourceProjection(projection(1, [accepted(5, '甲', { revision: 4 })]));
    await expect(service.applySourceProjection(projection(2, [accepted(5, '乙', { revision: 4 })])))
      .rejects.toMatchObject({ sourceMemoryCode: 'SOURCE_MEMORY_CONFLICT' });
    await expect(service.applySourceProjection(projection(2, [accepted(5, '乙', { revision: 3, acceptanceId: 'new' })])))
      .rejects.toMatchObject({ sourceMemoryCode: 'SOURCE_MEMORY_STALE' });
  });

  it('serializes competing versions so a late old writer cannot overwrite a newer projection', async () => {
    const newest = projection(2, [accepted(5, '乙')]);
    const results = await Promise.allSettled([service.applySourceProjection(newest), service.applySourceProjection(projection(1, [accepted(5)]))]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(service.querySourceMemory(newest, 7).entries[0]!.value).toBe('乙');
  });

  it('keeps modes independent and rejects a forged client scope before reading', async () => {
    const drama = projection(1, [accepted(5)]), novel = projection(1, [accepted(5, '小说甲', { mode: 'novel' })], 'local', 'novel');
    await service.applySourceProjection(drama); await service.applySourceProjection(novel);
    await service.applySourceProjection(projection(2));
    expect(service.querySourceMemory(novel, 7).entries[0]!.value).toBe('小说甲');
    const forged = projection(10, [], 'a'.repeat(64));
    const read = vi.spyOn(store, 'read');
    expect(() => service.querySourceMemory(forged, 7)).toThrow();
    expect(read).not.toHaveBeenCalled();
    await expect(service.applySourceProjection(forged)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('isolates client tombstones for identical project IDs across restart', async () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64), scopedDir = join(directory, 'clients');
    let scoped = new MemoryService(await createClientScopedMemoryStore(scopedDir));
    const pa = projection(1, [accepted(5, '甲', { clientId: a })], a), pb = projection(1, [accepted(5, '乙', { clientId: b })], b);
    await Promise.all([runWithClientId(a, () => scoped.applySourceProjection(pa)), runWithClientId(b, () => scoped.applySourceProjection(pb))]);
    await runWithClientId(a, () => scoped.clearProject('project'));
    scoped = new MemoryService(await createClientScopedMemoryStore(scopedDir));
    await expect(runWithClientId(a, () => scoped.applySourceProjection(pa))).rejects.toMatchObject({ sourceMemoryCode: 'SOURCE_MEMORY_DELETED' });
    expect(runWithClientId(b, () => scoped.querySourceMemory(pb, 7)).entries[0]!.value).toBe('乙');
  });

  it('never publishes failed projection persistence, and a retry can recover', async () => {
    const old = projection(1, [accepted(5)]), next = projection(2, [accepted(10, '乙')]);
    await service.applySourceProjection(old);
    const bytes = await readFile(file, 'utf8'), before = service.get('project');
    vi.spyOn(store as unknown as { persist(candidate: unknown): Promise<void> }, 'persist').mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(service.applySourceProjection(next)).rejects.toThrow('ENOSPC');
    expect(service.get('project')).toEqual(before);
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect(new MemoryService(await MemoryStore.create(file)).querySourceMemory(old, 7).origin).toBe('projection');
    await service.applySourceProjection(next);
    expect(service.querySourceMemory(next, 11).origin).toBe('projection');
  });

  it('persists deletion even without a bucket and blocks already queued late writes', async () => {
    const deleting = service.clearProject('project');
    const late = service.applySourceProjection(projection(1, [accepted(5)]));
    await deleting;
    await expect(late).rejects.toMatchObject({ sourceMemoryCode: 'SOURCE_MEMORY_DELETED' });
    store = await MemoryStore.create(file); service = new MemoryService(store);
    await expect(store.update('project', (memory) => { memory.facts.push({ id: 'late', kind: 'plot', text: 'late', at: '' }); }))
      .rejects.toMatchObject({ sourceMemoryCode: 'SOURCE_MEMORY_DELETED' });
    await expect(store.write('project', store.read('another'))).rejects.toThrow();
    expect(() => service.querySourceMemory(projection(1), 7)).toThrow();
    await service.recordFacts('another', [{ kind: 'plot', text: 'unaffected' }]);
    expect(service.get('another').facts).toHaveLength(1);
  });

  it('does not publish a failed clear or generic write', async () => {
    await service.applySourceProjection(projection(1, [accepted(5)]));
    const before = service.get('project');
    const persist = vi.spyOn(store as unknown as { persist(candidate: unknown): Promise<void> }, 'persist');
    persist.mockRejectedValueOnce(new Error('failed delete'));
    await expect(service.clearProject('project')).rejects.toThrow();
    expect(service.get('project')).toEqual(before);
    persist.mockRejectedValueOnce(new Error('failed write'));
    await expect(store.write('project', store.read('empty'))).rejects.toThrow();
    expect(service.get('project')).toEqual(before);
  });

  it('migrates v1 additively without inventing provenance or treating legacy facts as accepted', async () => {
    await writeFile(file, JSON.stringify({ version: 1, projects: { project: { summaries: [], facts: [{ id: 'old', kind: 'plot', text: 'legacy assertion', at: '' }], learnings: [], workflow: [], updatedAt: '' } } }));
    service = new MemoryService(await MemoryStore.create(file));
    expect(service.get('project')).toMatchObject({ legacyUntracked: true, facts: [{ text: 'legacy assertion' }] });
    expect(service.querySourceMemory(projection(1), 7)).toMatchObject({ entries: [], unverifiedReferences: [] });
    await service.applySourceProjection(projection(1));
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2);
    service = new MemoryService(await MemoryStore.create(file));
    expect(service.get('project').facts[0]!.text).toBe('legacy assertion');
  });

  it.each(['{broken json', JSON.stringify({ version: 3, projects: {} }), JSON.stringify({ version: 1, projects: [] }), JSON.stringify({ version: 1, projects: { project: { facts: 'broken' } } })])('fails explicitly on damaged or unsupported files', async (data) => {
    await writeFile(file, data);
    await expect(MemoryStore.create(file)).rejects.toMatchObject({ code: 'STORE_ERROR' });
    expect(await readFile(file, 'utf8')).toBe(data);
  });

  it('rejects damaged cache audit and unreadable paths rather than resetting to empty', async () => {
    await service.applySourceProjection(projection(1, [accepted(5)]));
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.projects.project.sourceMemory.short_drama.entries[0].value = 'damaged';
    await writeFile(file, JSON.stringify(data));
    await expect(MemoryStore.create(file)).rejects.toMatchObject({ code: 'STORE_ERROR' });
    await expect(MemoryStore.create(directory)).rejects.toMatchObject({ code: 'STORE_ERROR' });
  });
});
