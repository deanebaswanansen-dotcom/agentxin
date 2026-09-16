import { describe, expect, it } from 'vitest';
import type { AcceptedMemoryInput } from '../../types/SourceMemory.js';
import type { StoryControlCollection } from '../../types/StoryControl.js';
import { createFrozenMemoryProjection, hashSourceMemoryBlocks, projectSourceMemory } from './sourceMemoryContract.js';
import { composeStoryMemoryContext } from './StoryMemoryContext.js';

function fixture() {
  const text = '钥匙现在归甲保管。';
  const blocks = [{ id: 'b', text }];
  const acceptance: AcceptedMemoryInput = { schemaVersion: 1, source: { clientId: 'local', projectId: 'p', mode: 'novel',
    resourceId: 'c', unitNumber: 1, revision: 1, acceptanceId: 'a', contentHash: hashSourceMemoryBlocks(blocks) },
    title: '钥匙', acceptedAt: '2026-09-15T00:00:00.000Z', blocks,
    entries: [{ id: 's', kind: 'state', entity: 'key', key: 'holder', value: '甲', action: 'set', text, evidence: [{ blockId: 'b', start: 0, end: text.length, quote: text }] }] };
  const projection = createFrozenMemoryProjection({ clientId: 'local', projectId: 'p', mode: 'novel', revision: 1, acceptances: [acceptance] });
  const view = projectSourceMemory(projection, 2);
  const controls: StoryControlCollection = { schemaVersion: 1, revision: 1, items: [
    { id: 'tone', revision: 1, kind: 'preference', text: '对白不要说教', enabled: true, importance: 'required', fromUnit: 1, createdAt: '', updatedAt: '' },
    { id: 'thread', revision: 1, kind: 'thread', text: '在本章兑现钟楼约定', enabled: true, importance: 'advisory', fromUnit: 1,
      thread: { threadId: 'promise', title: '钟楼约定', status: 'planted', urgency: 'medium', requiredAtUnit: 2 }, createdAt: '', updatedAt: '' },
  ] };
  return { projection, view, controls };
}

describe('deterministic shared memory context budget', () => {
  it('preserves all required sources/author goals and reports the exact memory-section size without timing', () => {
    const input = fixture();
    const first = composeStoryMemoryContext({ ...input, query: '钥匙' });
    const second = composeStoryMemoryContext({ ...input, query: '钥匙' });
    expect(second).toEqual(first);
    expect(first.text).toContain('对白不要说教'); expect(first.text).toContain('本单元必须回收');
    expect(first.text).toContain('key:holder=甲'); expect(first.text).toContain('非语义证明');
    expect(first.text).toContain('历史正文观察'); expect(first.text).toContain('不代表当前状态');
    expect(first.statistics.usedChars).toBe(first.text.length);
    expect(first.statistics.estimatedTokens).toBe(Math.ceil(first.text.length / 2));
    expect(first.statistics.sourceChars + first.statistics.authorChars + first.statistics.threadChars + first.statistics.retrievalChars).toBe(first.text.length);
    expect(first.statistics).not.toHaveProperty('elapsedMs');
  });

  it('fails explicitly instead of dropping required author instructions or current matched state', () => {
    const input = fixture();
    expect(() => composeStoryMemoryContext({ ...input, maxChars: 100 })).toThrow('必需记忆依据超过');
    input.controls.items = [];
    expect(() => composeStoryMemoryContext({ ...input, maxChars: 30 })).toThrow('必需记忆依据超过');
  });

  it('spends optional budget after complete facts and tracks advisory truncation', () => {
    const input = fixture();
    input.controls.items = [{ ...input.controls.items[0]!, importance: 'advisory', text: '可选提示'.repeat(1000) }];
    const result = composeStoryMemoryContext({ ...input, maxChars: 400 });
    expect(result.text).toContain('钥匙现在归甲保管。');
    expect(result.statistics.usedChars).toBe(result.text.length);
    expect(result.statistics.usedChars).toBeLessThanOrEqual(400);
    expect(result.statistics.truncated).toBe(true); expect(result.statistics.omittedItems).toBeGreaterThan(0);
  });

  it('retains author adjudication after withdrawal as an author decision, not as a current source fact', () => {
    const input = fixture(), source = input.projection.acceptances[0]!.source;
    input.controls.items = [{ ...input.controls.items[0]!, kind: 'fact_correction', source, text: '此前钥匙归属设定作废' }];
    input.projection = createFrozenMemoryProjection({ ...input.projection, revision: 2, acceptances: [] });
    input.view = projectSourceMemory(input.projection, 2);
    const result = composeStoryMemoryContext(input);
    expect(result.text).toContain('原来源已撤回，仅供审计');
    expect(result.text).toContain('此前钥匙归属设定作废');
    expect(result.statistics.sourceChars).toBe(0);
  });

  it('includes the latest past accepted body tail without a query and accounts for it in the same budget', () => {
    const input = fixture();
    input.controls.items = [];
    const source = input.projection.acceptances[0]!;
    const make = (id: string, unitNumber: number, text: string): AcceptedMemoryInput => {
      const blocks = [{ id, text }];
      return { ...source, source: { ...source.source, resourceId: id, acceptanceId: id, unitNumber, contentHash: hashSourceMemoryBlocks(blocks) }, blocks, entries: [] };
    };
    const tail = '近前正文'.repeat(400) + '最后他推开了门。';
    input.projection = createFrozenMemoryProjection({ ...input.projection, acceptances: [source,
      make('near', 2, tail), make('future', 4, '未来秘密不得出现')] });
    input.view = projectSourceMemory(input.projection, 3);
    const result = composeStoryMemoryContext(input);
    expect(result.text).toContain(`near:${tail.length - 1200}-${tail.length}`);
    expect(result.text).toContain(tail.slice(-1200));
    expect(result.text).not.toContain('未来秘密');
    expect(result.statistics.retrievalChars).toBeGreaterThan(1200);
    expect(result.statistics.usedChars).toBe(result.text.length);
    const small = composeStoryMemoryContext({ ...input, maxChars: 350 });
    expect(small.text).toContain('key:holder=甲');
    expect(small.statistics.usedChars).toBeLessThanOrEqual(350);
    expect(small.statistics.truncated).toBe(true);
  });

  it('does not repeat a retrieved body already represented by the fallback or resurrect a withdrawn tail', () => {
    const input = fixture();
    input.controls.items = [];
    const result = composeStoryMemoryContext({ ...input, query: '钥匙' });
    expect(result.text.match(/钥匙现在归甲保管。/g)).toHaveLength(2); // One fact, one historical body.
    input.projection = createFrozenMemoryProjection({ ...input.projection, revision: 2, acceptances: [] });
    input.view = projectSourceMemory(input.projection, 2);
    expect(composeStoryMemoryContext(input).text).not.toContain('钥匙');
  });
});
