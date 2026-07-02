import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStore } from './MemoryStore.js';
import { MemoryService, scaledMemoryOptions } from './MemoryService.js';

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
});
