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

  it('keeps long-novel memory injection bounded as chapter count grows', () => {
    expect(scaledMemoryOptions(1)).toMatchObject({ maxSummaries: 2, maxChars: 16_000 });
    expect(scaledMemoryOptions(30)).toMatchObject({ maxSummaries: 2, maxChars: 16_000 });
    expect(scaledMemoryOptions(250)).toMatchObject({ maxSummaries: 2, maxChars: 16_000 });
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

  it('buildContext never exceeds the explicit prompt budget', async () => {
    const { svc } = await service();
    await svc.recordFacts(
      'p1',
      Array.from({ length: 30 }, (_, index) => ({
        kind: 'plot' as const,
        text: `关键剧情${index}：${'不可重复的长设定'.repeat(30)}`,
      })),
    );
    for (let index = 1; index <= 8; index += 1) {
      await svc.appendChapterSummary('p1', {
        chapterId: `c${index}`,
        title: `第${index}章`,
        summary: `摘要${index}：${'本章状态变化'.repeat(30)}`,
      });
    }

    const ctx = svc.buildContext('p1', { ...scaledMemoryOptions(250), maxChars: 800 });
    expect(ctx.length).toBeLessThanOrEqual(800);
    expect(ctx).toContain('第8章');
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

  it('clearProject drops all memory for that project only', async () => {
    const { svc } = await service();
    await svc.recordFacts('p1', [{ kind: 'plot', text: 'A 项目剧情' }]);
    await svc.appendChapterSummary('p1', { chapterId: 'c1', title: '第1章', summary: '开端' });
    await svc.recordFacts('p2', [{ kind: 'plot', text: 'B 项目剧情' }]);
    await svc.clearProject('p1');
    expect(svc.get('p1').facts).toHaveLength(0);
    expect(svc.get('p1').summaries).toHaveLength(0);
    expect(svc.get('p2').facts).toHaveLength(1);
  });

  it('removeChapterSummary drops only that chapter summary', async () => {
    const { svc } = await service();
    await svc.appendChapterSummary('p1', { chapterId: 'c1', title: '第1章', summary: '开端' });
    await svc.appendChapterSummary('p1', { chapterId: 'c2', title: '第2章', summary: '发展' });
    await svc.recordFacts('p1', [{ kind: 'plot', text: '主线推进' }]);
    await svc.removeChapterSummary('p1', 'c1');
    expect(svc.get('p1').summaries.map((item) => item.chapterId)).toEqual(['c2']);
    expect(svc.get('p1').facts).toHaveLength(1);
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

  it('loads legacy memory without foreshadows, critical states or rejection markers as empty arrays', async () => {
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
    expect(svc.get('p1').criticalStates).toEqual([]);
    expect(svc.get('p1').rejectedChapterIds).toEqual([]);
    expect(svc.listOpenForeshadows('p1')).toEqual([]);
  });

  it('tracks rejected chapter drafts separately from committed chapters', async () => {
    const { svc } = await service();
    await svc.markChapterRejected('p1', 'c2');
    await svc.markChapterRejected('p1', 'c2');
    expect(svc.isChapterRejected('p1', 'c2')).toBe(true);
    expect(svc.get('p1').rejectedChapterIds).toEqual(['c2']);

    await svc.markChapterCommitted('p1', 'c2');
    expect(svc.isChapterRejected('p1', 'c2')).toBe(false);
  });

  it('commits explicit critical states and injects them into later chapter context', async () => {
    const { svc } = await service();
    const applied = await svc.applyCriticalStateUpdates('p1', [
      {
        kind: 'alive_status',
        entity: '陆闲',
        value: 'alive',
        evidence: '陆闲从祭坛旁站起。',
        chapterId: 'c1',
        chapterTitle: '第1章',
      },
      {
        kind: 'key_item',
        entity: '归墟钥匙·北',
        key: 'holder',
        value: '陆闲',
        evidence: '陆闲把归墟钥匙收进贴身口袋。',
        chapterId: 'c1',
        chapterTitle: '第1章',
      },
    ]);

    expect(applied).toEqual({ applied: 2, issues: [] });
    expect(svc.get('p1').criticalStates).toHaveLength(2);
    const context = svc.buildContext('p1');
    expect(context).toContain('关键状态账');
    expect(context).toContain('归墟钥匙·北 · holder = 陆闲');
  });

  it('rejects a dead character reappearing without an explanation and keeps the prior state', async () => {
    const { svc } = await service();
    await svc.applyCriticalStateUpdates('p1', [{
      kind: 'alive_status',
      entity: '师父',
      value: 'dead',
      evidence: '众人确认师父已经死亡并安葬。',
      chapterId: 'c1',
      chapterTitle: '第1章',
    }]);

    const rejected = await svc.applyCriticalStateUpdates('p1', [{
      kind: 'alive_status',
      entity: '师父',
      value: 'alive',
      evidence: '师父推门走进宴会厅。',
      chapterId: 'c2',
      chapterTitle: '第2章',
    }]);

    expect(rejected.applied).toBe(0);
    expect(rejected.issues).toEqual([
      expect.objectContaining({ severity: 'P0', code: 'DEAD_CHARACTER_REAPPEARS' }),
    ]);
    expect(svc.get('p1').criticalStates).toEqual([
      expect.objectContaining({ entity: '师父', value: 'dead', chapterId: 'c1' }),
    ]);
  });

  it('allows an otherwise forbidden state transition when the chapter explicitly explains it', async () => {
    const { svc } = await service();
    await svc.applyCriticalStateUpdates('p1', [{
      kind: 'ability_state',
      entity: '陆闲',
      key: '万法归闲',
      value: 'sealed',
      evidence: '封印落下，万法归闲无法使用。',
      chapterId: 'c1',
      chapterTitle: '第1章',
    }]);

    const applied = await svc.applyCriticalStateUpdates('p1', [{
      kind: 'ability_state',
      entity: '陆闲',
      key: '万法归闲',
      value: 'available',
      evidence: '苏晚璃解封万法归闲，陆闲重新获得这股力量。',
      chapterId: 'c2',
      chapterTitle: '第2章',
    }]);

    expect(applied).toEqual({ applied: 1, issues: [] });
    expect(svc.get('p1').criticalStates[0]).toMatchObject({
      value: 'available',
      chapterId: 'c2',
    });
  });

  it('allows a key-item transfer when the text explicitly says it was put back and taken', async () => {
    const { svc } = await service();
    await svc.applyCriticalStateUpdates('p1', [{
      kind: 'key_item',
      entity: '黄铜牌（赣航清6号·阿贵）',
      key: 'holder',
      value: '顾棠',
      evidence: '顾棠将黄铜牌收进外套内袋。',
      chapterId: 'c15',
      chapterTitle: '第15章',
    }]);

    const applied = await svc.applyCriticalStateUpdates('p1', [{
      kind: 'key_item',
      entity: '黄铜牌（赣航清6号·阿贵）',
      key: 'holder',
      value: '取牌人',
      evidence: '顾棠将黄铜牌放回砖缝，取牌人随后取走。',
      chapterId: 'c16',
      chapterTitle: '第16章',
    }]);

    expect(applied).toEqual({ applied: 1, issues: [] });
    expect(svc.get('p1').criticalStates[0]).toMatchObject({
      value: '取牌人',
      chapterId: 'c16',
    });
  });

  it('rejects reacquiring the same key item from an external hiding place while it is still held', async () => {
    const { svc } = await service();
    await svc.applyCriticalStateUpdates('p1', [{
      kind: 'key_item',
      entity: '横线纸（停电记录）',
      key: 'holder',
      value: '顾棠',
      evidence: '顾棠从机柜底座深处取出横线纸，折好放入衬衣口袋。',
      chapterId: 'c14',
      chapterTitle: '第14章',
    }]);

    const rejected = await svc.applyCriticalStateUpdates('p1', [{
      kind: 'key_item',
      entity: '横线纸（停电记录）',
      key: 'holder',
      value: '顾棠',
      evidence: '她将横线纸收进防水袋；本章摘要：顾棠在铁栅门后的砖缝中再次取得横线纸。',
      chapterId: 'c17',
      chapterTitle: '第17章',
    }]);

    expect(rejected.applied).toBe(0);
    expect(rejected.issues).toEqual([
      expect.objectContaining({ severity: 'P0', code: 'KEY_ITEM_DUPLICATE_ACQUISITION' }),
    ]);
    expect(svc.get('p1').criticalStates[0]).toMatchObject({ chapterId: 'c14' });

    const ordinaryUse = await svc.applyCriticalStateUpdates('p1', [{
      kind: 'key_item',
      entity: '横线纸（停电记录）',
      key: 'holder',
      value: '顾棠',
      evidence: '顾棠从外套内袋抽出横线纸查看，随后仍收在内袋。',
      chapterId: 'c15',
      chapterTitle: '第15章',
    }]);
    expect(ordinaryUse).toEqual({ applied: 1, issues: [] });
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
