import { describe, expect, it } from 'vitest';
import type { StoryControl, StoryControlCollection } from '../../types/StoryControl.js';
import type { SourceMemoryEntry } from '../../types/SourceMemory.js';
import { buildStoryThreads, renderStoryThreadPriorities, sortStoryThreads } from './StoryThreads.js';

function control(id: string, deadlineUnit?: number, status: 'planted' | 'echoed' | 'resolved' | 'dropped' = 'planted'): StoryControl {
  return { id, revision: 1, kind: 'thread', text: `${id}的伏笔`, enabled: true, importance: 'advisory', fromUnit: 1,
    thread: { threadId: id, title: id, status, urgency: 'medium', deadlineUnit }, createdAt: '', updatedAt: '' };
}
function collection(items: StoryControl[]): StoryControlCollection { return { schemaVersion: 1, revision: 1, items }; }

describe('shared story thread priorities', () => {
  it('orders overdue, near-deadline, important and older threads consistently', () => {
    const important = control('important'); important.importance = 'required';
    const threads = buildStoryThreads({ entries: [] }, collection([control('normal'), control('soon', 8), control('late', 3), important, control('closed', 1, 'resolved')]), 7);
    expect(threads.map((thread) => thread.id)).toEqual(['late', 'soon', 'important', 'normal', 'closed']);
    expect(sortStoryThreads(threads, 7)).toEqual(threads);
    const rendered = renderStoryThreadPriorities(threads, 7);
    expect(rendered.indexOf('late')).toBeLessThan(rendered.indexOf('soon'));
    expect(rendered).not.toContain('closed');
    expect(threads.every((thread) => !thread.requiredNow)).toBe(true);
  });

  it('requires explicit requiredAtUnit and only for enabled, in-range open records', () => {
    const must = control('must'); must.thread!.requiredAtUnit = 7;
    const disabled = control('disabled'); disabled.enabled = false; disabled.thread!.requiredAtUnit = 7;
    const future = control('future'); future.fromUnit = 8; future.thread!.requiredAtUnit = 7;
    const resolved = control('resolved', 7, 'resolved'); resolved.thread!.requiredAtUnit = 7;
    const expired = control('expired'); expired.throughUnit = 6; expired.thread!.requiredAtUnit = 7;
    const controls = collection([must, disabled, future, resolved, expired]);
    expect(buildStoryThreads({ entries: [] }, controls, 7).filter((thread) => thread.requiredNow).map((thread) => thread.id)).toEqual(['must']);
    expect(buildStoryThreads({ entries: [] }, controls, 8).filter((thread) => thread.requiredNow)).toEqual([]);
    expect(() => renderStoryThreadPriorities(buildStoryThreads({ entries: [] }, controls, 7), 7, 3)).toThrow('超过上下文预算');
  });

  it('keeps author origins honest and overlays accepted thread events by stable identity', () => {
    const entry = { id: 'thread-fact', kind: 'thread', text: '钟楼旧约', entity: 'promise', key: 'thread', action: 'open', evidence: [],
      source: { clientId: 'local', projectId: 'p', mode: 'novel', resourceId: 'c', unitNumber: 2, revision: 1, contentHash: 'a'.repeat(64), acceptanceId: 'accepted' },
      evidenceStatus: 'matched', status: 'active', effectiveFromUnit: 2 } as SourceMemoryEntry;
    expect(buildStoryThreads({ entries: [entry] }, collection([]), 3)[0]).toMatchObject({ origin: 'accepted_source', source: entry.source });
    const author = control('author-close', 3, 'dropped'); author.thread!.threadId = 'promise';
    author.source = entry.source;
    const threads = buildStoryThreads({ entries: [entry] }, collection([author]), 3);
    expect(threads).toHaveLength(1); expect(threads[0]).toMatchObject({ origin: 'author', status: 'dropped' });
    expect(threads[0]!.source).toEqual(entry.source);
    expect(renderStoryThreadPriorities(threads, 3)).toBe('');
    expect(buildStoryThreads({ entries: [{ ...entry, evidenceStatus: 'unverified' }] }, collection([]), 3)).toEqual([]);
    const later = { ...entry, action: 'close' as const, source: { ...entry.source, acceptanceId: 'later', unitNumber: 4 } };
    author.thread!.status = 'planted';
    expect(buildStoryThreads({ entries: [later] }, collection([author]), 5, [entry.source, later.source])).toMatchObject([{ status: 'resolved', origin: 'accepted_source' }]);
    expect(buildStoryThreads({ entries: [] }, collection([author]), 5, [])).toEqual([]);
    expect(buildStoryThreads({ entries: [] }, collection([author]), 2, [entry.source])).toEqual([]);
    delete author.source;
    const independent = buildStoryThreads({ entries: [later] }, collection([author]), 5, [later.source]);
    expect(independent).toHaveLength(2);
    expect(independent.find((thread) => thread.origin === 'author')).not.toHaveProperty('source');
  });
});
