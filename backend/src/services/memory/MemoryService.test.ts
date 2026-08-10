import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStore } from './MemoryStore.js';
import { MemoryService, scaledMemoryOptions } from './MemoryService.js';

/** Distinct strings that stay well below fact/foreshadow Jaccard merge threshold. */
function uniqueText(prefix: string, i: number): string {
  return `${prefix}:${i}:${String.fromCharCode(0x4e00 + i * 37)}${String.fromCharCode(0x9000 - i * 41)}:k${(i * 104729) % 999983}`;
}

describe('MemoryService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-memory-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function service(): Promise<{ store: MemoryStore; svc: MemoryService; file: string }> {
    const file = join(dir, 'mem.json');
    return MemoryStore.create(file).then((store) => ({ store, svc: new MemoryService(store), file }));
  }

  it('scaledMemoryOptions grows with chapter count for long novels', () => {
    expect(scaledMemoryOptions(1).maxSummaries).toBe(8);
    expect(scaledMemoryOptions(30).maxSummaries).toBeGreaterThanOrEqual(8);
    expect(scaledMemoryOptions(250).maxSummaries).toBe(32);
    expect(scaledMemoryOptions(250).maxFacts).toBe(63);
  });

  it('returns empty context when there is no memory', async () => {
    const { svc } = await service();
    expect(svc.buildContext('p1')).toBe('');
  });

  it('appends chapter summaries and keeps one per chapterId (latest wins)', async () => {
    const { svc } = await service();
    await svc.appendChapterSummary('p1', { chapterId: 'c1', title: '第1章', summary: '旧摘要' });
    await svc.appendChapterSummary('p1', { chapterId: 'c1', title: '第1章', summary: '新摘要' });
    const mem = svc.get('p1');
    expect(mem.summaries).toHaveLength(1);
    expect(mem.summaries[0]!.summary).toBe('新摘要');
  });

  it('records facts and dedupes by normalized text, returning added count', async () => {
    const { svc } = await service();
    const first = await svc.recordFacts('p1', [
      { kind: 'character', text: '主角叫林辰' },
      { kind: 'world', text: '灵气复苏的现代' },
    ]);
    expect(first).toBe(2);
    const second = await svc.recordFacts('p1', [
      { kind: 'character', text: '  主角叫林辰  ' }, // 归一后重复
      { kind: 'plot', text: '林辰觉醒能力' },
    ]);
    expect(second).toBe(1);
    expect(svc.get('p1').facts).toHaveLength(3);
  });

  it('records learnings and dedupes', async () => {
    const { svc } = await service();
    expect(await svc.recordLearning('p1', '多用短句对白')).toBe(true);
    expect(await svc.recordLearning('p1', '多用短句对白')).toBe(false);
    expect(svc.get('p1').learnings).toHaveLength(1);
  });

  it('records workflow events and feeds them back into context', async () => {
    const { svc } = await service();
    await svc.recordWorkflow('p1', { task: 'workspace_review', summary: '已生成主动审阅报告' });
    const mem = svc.get('p1');
    expect(mem.workflow).toHaveLength(1);
    expect(mem.workflow[0]!.task).toBe('workspace_review');
    const ctx = svc.buildContext('p1');
    expect(ctx).toContain('最近工作流轨迹');
    expect(ctx).toContain('workspace_review：已生成主动审阅报告');
  });

  it('buildContext composes facts / summaries / learnings into a stable block', async () => {
    const { svc } = await service();
    await svc.recordFacts('p1', [{ kind: 'character', text: '主角叫林辰' }]);
    await svc.appendChapterSummary('p1', { chapterId: 'c1', title: '第1章', summary: '林辰觉醒' });
    await svc.recordLearning('p1', '多用短句');
    const ctx = svc.buildContext('p1');
    expect(ctx).toContain('故事设定记忆');
    expect(ctx).toContain('主角叫林辰');
    expect(ctx).toContain('前情提要');
    expect(ctx).toContain('第1章：林辰觉醒');
    expect(ctx).toContain('写作风格沉淀');
    expect(ctx).toContain('多用短句');
  });

  it('persists to disk and reloads across store instances', async () => {
    const { svc, file } = await service();
    await svc.recordFacts('p1', [{ kind: 'world', text: '末世废土' }]);
    await svc.appendChapterSummary('p1', { chapterId: 'c1', title: '第1章', summary: '开端' });

    // 文件应已落盘
    const raw = await readFile(file, 'utf8');
    expect(raw).toContain('末世废土');

    // 用新实例从同一文件加载，记忆应恢复
    const reloaded = new MemoryService(await MemoryStore.create(file));
    expect(reloaded.get('p1').facts).toHaveLength(1);
    expect(reloaded.get('p1').summaries[0]!.summary).toBe('开端');
  });

  it('isolates memory per project', async () => {
    const { svc } = await service();
    await svc.recordFacts('p1', [{ kind: 'plot', text: 'A 项目剧情' }]);
    expect(svc.buildContext('p2')).toBe('');
    expect(svc.get('p2').facts).toHaveLength(0);
  });

  it('ephemeral store does not write to disk', async () => {
    const svc = new MemoryService(MemoryStore.ephemeral());
    await svc.recordFacts('p1', [{ kind: 'world', text: '内存态' }]);
    // 仍可在进程内读取
    expect(svc.get('p1').facts).toHaveLength(1);
  });

  it('merges near-duplicate facts of the same kind and keeps the more detailed text', async () => {
    const { svc } = await service();
    const a = await svc.recordFacts('p1', [{ kind: 'character', text: '林辰能看见隐藏的裂隙' }]);
    expect(a).toBe(1);
    // 仅标点不同的近重复事实：应合并而非新增，并保留更长（更详细）的文本。
    const b = await svc.recordFacts('p1', [{ kind: 'character', text: '林辰能看见隐藏的裂隙。' }]);
    expect(b).toBe(0);
    const facts = svc.get('p1').facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.text).toBe('林辰能看见隐藏的裂隙。');
  });

  it('does not merge similar text across different kinds', async () => {
    const { svc } = await service();
    await svc.recordFacts('p1', [{ kind: 'character', text: '黑龙会掌控全城' }]);
    const added = await svc.recordFacts('p1', [{ kind: 'world', text: '黑龙会掌控全城' }]);
    expect(added).toBe(1);
    expect(svc.get('p1').facts).toHaveLength(2);
  });

  it('keeps clearly distinct facts separate', async () => {
    const { svc } = await service();
    await svc.recordFacts('p1', [{ kind: 'plot', text: '林辰能看见隐藏的裂隙' }]);
    const added = await svc.recordFacts('p1', [{ kind: 'plot', text: '反派是黑龙会会长赵武' }]);
    expect(added).toBe(1);
    expect(svc.get('p1').facts).toHaveLength(2);
  });

  it('plants foreshadows, echoes/resolves them, and injects open ledger into context', async () => {
    const { svc } = await service();
    const added = await svc.plantForeshadows('p1', [
      {
        title: '热数据坟场',
        detail: '学院封锁了一片热数据坟场',
        urgency: 'high',
        suggestPayoffBy: '中后期',
        plantedChapterTitle: '第1章',
      },
      {
        title: '导师的芯片',
        detail: '导师袖口闪过非法芯片',
        urgency: 'medium',
        plantedChapterTitle: '第1章',
      },
    ]);
    expect(added).toBe(2);
    expect(svc.listOpenForeshadows('p1')).toHaveLength(2);

    // 近重复埋设应合并
    const again = await svc.plantForeshadows('p1', [
      { title: '热数据坟场', detail: '学院封锁了一片热数据坟场。', urgency: 'high' },
    ]);
    expect(again).toBe(0);
    expect(svc.listOpenForeshadows('p1')).toHaveLength(2);

    const echoed = await svc.touchForeshadows('p1', [
      { match: '热数据坟场', status: 'echoed', chapterTitle: '第2章', note: '主角再次梦到坟场坐标' },
    ]);
    expect(echoed).toBe(1);
    expect(svc.listOpenForeshadows('p1').find((f) => f.title.includes('热数据'))?.status).toBe(
      'echoed',
    );

    const resolved = await svc.touchForeshadows('p1', [
      { match: '导师的芯片', status: 'resolved', chapterTitle: '第3章', note: '芯片是监工信标' },
    ]);
    expect(resolved).toBe(1);
    expect(svc.listOpenForeshadows('p1')).toHaveLength(1);

    const ctxEarly = svc.buildContext('p1', { progressRatio: 0.2 });
    expect(ctxEarly).toContain('伏笔台账');
    expect(ctxEarly).toContain('热数据坟场');
    expect(ctxEarly).not.toContain('临近收束');

    const ctxLate = svc.buildContext('p1', { progressRatio: 0.9 });
    expect(ctxLate).toContain('临近收束');
    expect(ctxLate).toContain('至少推进或回收');

    const ledger = svc.formatForeshadowLedger('p1');
    expect(ledger).toContain('未回收');
    expect(ledger).toContain('已回收');
    expect(ledger).toContain('导师的芯片');
  });

  it('loads legacy memory without foreshadows field as empty array', async () => {
    const file = join(dir, 'legacy.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        projects: {
          p1: {
            summaries: [],
            facts: [],
            learnings: [],
            workflow: [],
            updatedAt: new Date().toISOString(),
          },
        },
      }),
      'utf8',
    );
    const svc = new MemoryService(await MemoryStore.create(file));
    expect(svc.get('p1').foreshadows).toEqual([]);
    expect(svc.listOpenForeshadows('p1')).toEqual([]);
  });

  it('serializes concurrent mutators so unique facts / summaries / foreshadows are not lost', async () => {
    const { svc } = await service();
    const N = 40;
    const expectedFacts = Array.from({ length: N }, (_, i) => uniqueText('fact', i));
    const expectedForeshadowTitles = Array.from({ length: N }, (_, i) => uniqueText('fs-title', i));

    const factOps = Array.from({ length: N }, (_, i) =>
      svc.recordFacts('p1', [{ kind: 'plot', text: expectedFacts[i]! }]),
    );
    const summaryOps = Array.from({ length: N }, (_, i) =>
      svc.appendChapterSummary('p1', {
        chapterId: `c-${i}`,
        title: `第${i}章`,
        summary: uniqueText('summary', i),
      }),
    );
    const foreshadowOps = Array.from({ length: N }, (_, i) =>
      svc.plantForeshadows('p1', [
        {
          title: expectedForeshadowTitles[i]!,
          detail: uniqueText('fs-detail', i),
          urgency: 'medium',
        },
      ]),
    );

    const [factAdds, , foreshadowAdds] = await Promise.all([
      Promise.all(factOps),
      Promise.all(summaryOps),
      Promise.all(foreshadowOps),
    ]);

    expect(factAdds.reduce((a, b) => a + b, 0)).toBe(N);
    expect(foreshadowAdds.reduce((a, b) => a + b, 0)).toBe(N);

    const mem = svc.get('p1');
    expect(mem.facts).toHaveLength(N);
    expect(mem.summaries).toHaveLength(N);
    expect(mem.foreshadows).toHaveLength(N);

    const factTexts = new Set(mem.facts.map((f) => f.text));
    for (const text of expectedFacts) {
      expect(factTexts.has(text)).toBe(true);
    }
    const chapterIds = new Set(mem.summaries.map((s) => s.chapterId));
    for (let i = 0; i < N; i += 1) {
      expect(chapterIds.has(`c-${i}`)).toBe(true);
    }
    const foreshadowTitles = new Set(mem.foreshadows.map((f) => f.title));
    for (const title of expectedForeshadowTitles) {
      expect(foreshadowTitles.has(title)).toBe(true);
    }
  });

  it('keeps concurrent writes to two projectIds isolated and complete', async () => {
    const { svc } = await service();
    const N = 25;
    const factsA = Array.from({ length: N }, (_, i) => uniqueText('projA', i));
    const factsB = Array.from({ length: N }, (_, i) => uniqueText('projB', i));

    await Promise.all([
      ...Array.from({ length: N }, (_, i) =>
        svc.recordFacts('proj-a', [{ kind: 'character', text: factsA[i]! }]),
      ),
      ...Array.from({ length: N }, (_, i) =>
        svc.recordFacts('proj-b', [{ kind: 'world', text: factsB[i]! }]),
      ),
      ...Array.from({ length: N }, (_, i) =>
        svc.appendChapterSummary('proj-a', {
          chapterId: `a-${i}`,
          title: `A${i}`,
          summary: uniqueText('sumA', i),
        }),
      ),
      ...Array.from({ length: N }, (_, i) =>
        svc.appendChapterSummary('proj-b', {
          chapterId: `b-${i}`,
          title: `B${i}`,
          summary: uniqueText('sumB', i),
        }),
      ),
    ]);

    const a = svc.get('proj-a');
    const b = svc.get('proj-b');
    expect(a.facts).toHaveLength(N);
    expect(b.facts).toHaveLength(N);
    expect(a.summaries).toHaveLength(N);
    expect(b.summaries).toHaveLength(N);
    expect(new Set(a.facts.map((f) => f.text))).toEqual(new Set(factsA));
    expect(new Set(b.facts.map((f) => f.text))).toEqual(new Set(factsB));
  });

  it('MemoryStore.update applies mutator atomically under the write queue', async () => {
    const { store } = await service();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        store.update('p1', (memory) => {
          memory.workflow.push({
            id: `w-${i}`,
            task: 't',
            summary: `s-${i}`,
            at: new Date().toISOString(),
          });
        }),
      ),
    );
    expect(store.read('p1').workflow).toHaveLength(30);
  });
});
