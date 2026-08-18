import { describe, expect, it } from 'vitest';

import type { CriticalStateEntry } from '../../memory/MemoryStore.js';
import { inferDeterministicCriticalStateUpdates } from './deterministicCriticalState.js';

function deadState(entity: string): CriticalStateEntry {
  return {
    id: 'state-1',
    kind: 'alive_status',
    entity,
    key: 'current',
    value: 'dead',
    evidence: `${entity}已经死亡。`,
    chapterId: 'chapter-1',
    chapterTitle: '第1章',
    updatedAt: '2026-08-17T00:00:00.000Z',
  };
}

describe('inferDeterministicCriticalStateUpdates', () => {
  it('extracts an explicit death without relying on model stateUpdates', () => {
    const updates = inferDeterministicCriticalStateUpdates({
      content: '顾棠俯身探查，沈砚没有脉搏，也没有呼吸。医师确认沈砚已经死亡。',
      existingStates: [],
    });

    expect(updates).toEqual([
      expect.objectContaining({ kind: 'alive_status', entity: '沈砚', value: 'dead' }),
    ]);
  });

  it('recognizes current physical action by an already dead character', () => {
    const updates = inferDeterministicCriticalStateUpdates({
      content: '宴会进行到一半，沈砚推门走进大厅，亲口说道：“我回来晚了。”',
      existingStates: [deadState('沈砚')],
    });

    expect(updates).toEqual([
      expect.objectContaining({ kind: 'alive_status', entity: '沈砚', value: 'alive' }),
    ]);
  });

  it('ignores hypothetical deaths, memories, dreams, and body references', () => {
    expect(inferDeterministicCriticalStateUpdates({
      content: '如果沈砚死亡，顾棠就会离开。',
      existingStates: [],
    })).toEqual([]);

    const existingStates = [deadState('沈砚')];
    for (const content of [
      '顾棠想起当年沈砚推门走进大厅。',
      '梦中，沈砚坐在窗边对她微笑。',
      '沈砚的遗体被抬进大厅。',
    ]) {
      expect(inferDeterministicCriticalStateUpdates({ content, existingStates })).toEqual([]);
    }
  });

  it('keeps an explicit resurrection explanation in the transition evidence', () => {
    const updates = inferDeterministicCriticalStateUpdates({
      content: '医师承认此前是假死。沈砚推门走进大厅。',
      existingStates: [deadState('沈砚')],
    });

    expect(updates[0]).toMatchObject({ entity: '沈砚', value: 'alive' });
    expect(updates[0]?.evidence).toContain('假死');
  });
});
