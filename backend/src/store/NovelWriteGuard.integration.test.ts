import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProxy } from '../proxy/ModelProxy.js';
import type { ChapterBlueprint } from '../types/index.js';
import { FileDataStore } from './FileDataStore.js';
import { captureNovelWriteBrief, captureNovelWriteSnapshot, buildNovelWriteBrief } from './NovelWriteGuard.js';
import { SceneWriter } from '../services/blueprint/SceneWriter.js';
import { ChapterMerger } from '../services/blueprint/ChapterMerger.js';
import { ChapterWriter } from '../services/blueprint/ChapterWriter.js';
import { PacingChecker } from '../services/blueprint/PacingChecker.js';
import { WordCountChecker } from '../services/blueprint/WordCountChecker.js';
import { ModelConfigService } from '../services/modelConfig/ModelConfigService.js';
import { saveCurrentSceneDraft } from '../services/blueprint/sceneTestFixtures.js';
import { hashWriteBriefValue } from '../services/writing/WriteBrief.js';
import { ChapterService } from '../services/chapter/ChapterService.js';

function blueprint(chapterId: string): ChapterBlueprint {
  return { chapter_id: chapterId, title: '新城调查', main_goal: '发现被改写的账本', target_words: 900,
    tone: '悬疑', pacing: '递进', required_plot_points: ['发现账本'], forbidden_points: ['提前揭晓凶手'], emotional_curve: '渐紧', ending_hook: '新线索',
    authorRequirements: { requirement: '不得在本章揭晓凶手', targetWords: 900 },
    scenes: ['s1', 's2', 's3'].map((scene_id) => ({ scene_id, name: scene_id, target_words: 300, purpose: '查账', characters: [], location: '书房', emotion: '紧张', pacing: '适中', must_include: [], ending_state: '发现线索' })),
  };
}

describe('novel generated-write store gates', () => {
  let directory: string;
  let file: string;
  let store: FileDataStore;
  let chapterId: string;
  let previousId: string;
  let projectId: string;
  let config: ModelConfigService;
  const proxy: ModelProxy = { async *streamCompletion() { yield { kind: 'content', text: '账本的墨迹尚未干透。' }; } };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'novel-source-gate-')); file = join(directory, 'store.json');
    store = await FileDataStore.create(file);
    projectId = (await store.createProject('查账人')).id;
    previousId = (await store.createChapter(projectId, '前章')).id;
    await store.updateChapterContent(previousId, '她在城门认出旧友。');
    chapterId = (await store.createChapter(projectId, '第二章')).id;
    await store.saveChapterBlueprint(blueprint(chapterId));
    await store.saveModelConfig({ baseUrl: 'https://unused.invalid', apiKey: 'unused', modelName: 'test' });
    config = new ModelConfigService(store);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

  it('rejects a late scene after a replacement blueprint reuses its scene id, without writing bytes', async () => {
    const writer = new SceneWriter(store, config, proxy);
    const pending = await writer.streamScene(chapterId, 's1', new AbortController().signal);
    const replacement = blueprint(chapterId); replacement.scenes[0]!.purpose = '销毁账本';
    await store.saveChapterBlueprint(replacement);
    const before = await readFile(file, 'utf8');
    await expect(writer.finalizeDraft(chapterId, 's1', '旧蓝图迟到正文', pending.guard)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await store.getSceneDraft(chapterId, 's1')).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await (await FileDataStore.create(file)).getSceneDraft(chapterId, 's1')).toBeUndefined();
  });

  it.each(['previous body', 'chapter order', 'chapter membership', 'author requirement'])(
    'rejects a late generated chapter after changing %s', async (change) => {
      const brief = await captureNovelWriteBrief(store, chapterId);
      if (change === 'previous body') await store.updateChapterContent(previousId, '前章现在确认旧友已经死亡。');
      if (change === 'chapter order') await store.reorderChapters(projectId, [chapterId, previousId]);
      if (change === 'chapter membership') await store.createChapter(projectId, '新前情单元');
      if (change === 'author requirement') { const bp = blueprint(chapterId); bp.authorRequirements!.requirement = '必须当场揭晓凶手'; await store.saveChapterBlueprint(bp); }
      const before = await readFile(file, 'utf8');
      await expect(store.updateChapterContent(chapterId, '迟到正文', brief.target.revision, { brief })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await readFile(file, 'utf8')).toBe(before);
    },
  );

  it('rejects a second scene when its preceding draft changed during generation', async () => {
    await saveCurrentSceneDraft(store, { chapterId, sceneId: 's1', content: '前景旧正文', updatedAt: 'same' });
    const writer = new SceneWriter(store, config, proxy);
    const pending = await writer.streamScene(chapterId, 's2', new AbortController().signal);
    await saveCurrentSceneDraft(store, { chapterId, sceneId: 's1', content: '前景新正文', updatedAt: 'same' });
    await expect(writer.finalizeDraft(chapterId, 's2', '迟到第二景', pending.guard)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await store.getSceneDraft(chapterId, 's2')).toBeUndefined();
  });

  it('rejects finalization after cancellation even when the provider ignores abort', async () => {
    const writer = new SceneWriter(store, config, proxy); const controller = new AbortController();
    const pending = await writer.streamScene(chapterId, 's1', controller.signal);
    controller.abort();
    await expect(writer.finalizeDraft(chapterId, 's1', '迟到场景', pending.guard)).rejects.toThrow();
    expect(await store.getSceneDraft(chapterId, 's1')).toBeUndefined();
  });

  it('checks merge revision at the actual store mutation and preserves a concurrent manual save', async () => {
    for (const sceneId of ['s1', 's2', 's3']) await saveCurrentSceneDraft(store, { chapterId, sceneId, content: `正文${sceneId}`, updatedAt: 'same' });
    const original = store.updateChapterContent.bind(store);
    vi.spyOn(store, 'updateChapterContent').mockImplementationOnce(async (...args) => {
      await original(chapterId, '作者刚手工保存的正文');
      return original(...args);
    });
    await expect(new ChapterMerger(store).merge(chapterId)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.getChapter(chapterId))?.content).toBe('作者刚手工保存的正文');
  });

  it('never reuses a reinserted old scene checkpoint after replacing its blueprint', async () => {
    const oldDraft = await saveCurrentSceneDraft(store, { chapterId, sceneId: 's1', content: '旧场景', updatedAt: 'same' });
    const replacement = blueprint(chapterId); replacement.main_goal = '寻找证人'; await store.saveChapterBlueprint(replacement);
    await store.saveSceneDraft(oldDraft);
    const provider = vi.spyOn(proxy, 'streamCompletion');
    const writer = new ChapterWriter(store, config, new SceneWriter(store, config, proxy), new ChapterMerger(store));
    const run = async () => { for await (const _ of writer.streamChapter(chapterId, new AbortController().signal)) { /* consume */ } };
    await expect(run()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(provider).not.toHaveBeenCalled();
    expect((await store.getChapter(chapterId))?.content).toBe('');
  });

  it('binds pacing review to body and sources and refuses a late report', async () => {
    await store.updateChapterContent(chapterId, '原始待审正文');
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const reviewProxy: ModelProxy = { async *streamCompletion() { entered(); await gate; yield { kind: 'content', text: JSON.stringify({ plotPoints: [], violatedForbiddenPoints: [], sceneIssues: [] }) }; } };
    const checker = new PacingChecker(store, config, reviewProxy);
    const pending = checker.check(chapterId).catch((error: unknown) => error);
    await started; await store.updateChapterContent(chapterId, '作者的新正文'); release();
    expect(await pending).toMatchObject({ code: 'CONFLICT' });
    expect(await store.getPacingReportByChapter(chapterId)).toBeUndefined();
    const report = await checker.check(chapterId);
    expect(report.candidateHash).toBe(hashWriteBriefValue('作者的新正文'));
    expect((await checker.getReport(chapterId)).candidateHash).toBe(report.candidateHash);
    await store.createCharacter(projectId, '证人', '拒绝说谎');
    await expect(checker.getReport(chapterId)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('invalidates word counts when an existing or previously missing scene changes without a chapter merge', async () => {
    await saveCurrentSceneDraft(store, { chapterId, sceneId: 's1', content: '第一景', updatedAt: 'same' });
    const checker = new WordCountChecker(store);
    await checker.check(chapterId);
    await saveCurrentSceneDraft(store, { chapterId, sceneId: 's1', content: '第一景增加更多内容', updatedAt: 'same' });
    await expect(checker.getReport(chapterId)).rejects.toMatchObject({ code: 'CONFLICT' });
    await checker.check(chapterId);
    await saveCurrentSceneDraft(store, { chapterId, sceneId: 's2', content: '新写第二景', updatedAt: 'same' });
    await expect(checker.getReport(chapterId)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.getChapter(chapterId))?.content).toBe('');
  });

  it('returns isolated nested provenance from generated writes, reads and chapter listings', async () => {
    const brief = await captureNovelWriteBrief(store, chapterId);
    const saved = await store.updateChapterContent(chapterId, '生成的正文', 0, { brief });
    saved.generatedCandidate!.brief.required.push({ text: '伪造条目', sourceKeys: [] });
    const first = (await store.getChapter(chapterId))!;
    first.generatedCandidate!.brief.sources[0]!.contentHash = 'tampered';
    const listed = (await store.listChapters(projectId)).find((chapter) => chapter.id === chapterId)!;
    listed.generatedCandidate!.brief.target.revision = 99;
    expect((await store.getChapter(chapterId))?.generatedCandidate?.brief).toEqual(brief);
  });

  it('invalidates the full subsequent-scene chain after an earlier scene is rewritten', async () => {
    const writer = new SceneWriter(store, config, proxy);
    for (const sceneId of ['s1', 's2', 's3']) {
      const { guard } = await writer.streamScene(chapterId, sceneId, new AbortController().signal);
      await writer.finalizeDraft(chapterId, sceneId, `原始正文${sceneId}`, guard);
    }
    const rewrite = await writer.streamScene(chapterId, 's1', new AbortController().signal);
    await writer.finalizeDraft(chapterId, 's1', '前景剧情已改变', rewrite.guard);
    await expect(writer.streamScene(chapterId, 's3', new AbortController().signal)).rejects.toMatchObject({ code: 'CONFLICT' });
    const chapterWriter = new ChapterWriter(store, config, writer, new ChapterMerger(store));
    await expect((async () => { for await (const _ of chapterWriter.streamChapter(chapterId, new AbortController().signal)) { /* consume */ } })()).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(new ChapterMerger(store).merge(chapterId)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.getChapter(chapterId))?.content).toBe('');
  });

  it('marks merged chapter provenance stale when one of its actual scene inputs changes', async () => {
    const sceneWriter = new SceneWriter(store, config, proxy);
    const chapterWriter = new ChapterWriter(store, config, sceneWriter, new ChapterMerger(store));
    for await (const _ of chapterWriter.streamChapter(chapterId, new AbortController().signal)) { /* consume */ }
    const service = new ChapterService(store);
    expect((await service.getWriteBrief(chapterId)).status).toBe('current');
    const draft = (await store.getSceneDraft(chapterId, 's1'))!;
    await store.saveSceneDraft({ ...draft, content: '独立改写后的场景', candidateHash: hashWriteBriefValue('独立改写后的场景') });
    expect((await service.getWriteBrief(chapterId)).status).toBe('stale');
  });

  it('does not relabel an old generated blueprint with current sources in any writing entry', async () => {
    const current = blueprint(chapterId);
    current.writeBrief = buildNovelWriteBrief({ ...await captureNovelWriteSnapshot(store, chapterId), blueprint: current });
    await store.saveChapterBlueprint(current);
    await store.createCharacter(projectId, '新增证人', '来自新版人物资料');
    expect((await new ChapterService(store).getWriteBrief(chapterId)).status).toBe('stale');
    await expect(captureNovelWriteBrief(store, chapterId)).rejects.toMatchObject({ code: 'CONFLICT' });
    const writer = new SceneWriter(store, config, proxy);
    await expect(writer.streamScene(chapterId, 's1', new AbortController().signal)).rejects.toMatchObject({ code: 'CONFLICT' });
    const chapterWriter = new ChapterWriter(store, config, writer, new ChapterMerger(store));
    await expect((async () => { for await (const _ of chapterWriter.streamChapter(chapterId, new AbortController().signal)) { /* consume */ } })()).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
