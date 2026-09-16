import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentOrchestrator } from './AgentOrchestrator.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import { captureNovelWriteBrief } from '../../store/NovelWriteGuard.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { MemoryService } from '../memory/MemoryService.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { hashWriteBriefValue } from '../writing/WriteBrief.js';
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { ChapterWriter } from '../blueprint/ChapterWriter.js';

const config = { baseUrl: 'https://unused.invalid', apiKey: 'unused', modelName: 'test' };
const pack = { title: '查账人', world: '旧城', characters: '调查员', outline: '第一章调查账本' };
const inspection = { score0to100: 95, verdict: 'pass', plotCoherence: '连贯', fatalIssues: [], earlyCharacterStatus: [], recommendRevision: false, revisionHints: [], structuralChecks: [], injectedMemoryChars: 0, injectedMemoryOptions: {} };
type Internals = {
  writeLongNovelChapter: (...args: unknown[]) => Promise<string>;
  processChapterDraft: (...args: unknown[]) => Promise<{ finalContent: string; finalInspection: { verdict: string; candidateHash: string; sourceFingerprint: string }; revised: boolean }>;
  inspectChapterDraft: (...args: unknown[]) => Promise<unknown>;
  reviseChapterWithHints: (...args: unknown[]) => Promise<string>;
  generateChapterWithMemory: (...args: unknown[]) => Promise<string>;
};

describe('Agent generated candidates keep their original writing sources', () => {
  let directory: string;
  let store: FileDataStore;
  let memory: MemoryService;
  let projectId: string;
  let chapterId: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-write-brief-'));
    store = await FileDataStore.create(join(directory, 'store.json'));
    memory = new MemoryService(await MemoryStore.create(join(directory, 'memory.json')));
    await store.saveModelConfig(config);
    projectId = (await store.createProject('查账人')).id;
    chapterId = (await store.createChapter(projectId, '第1章')).id;
    await store.createWorldSetting(projectId, '旧城', '旧城正在封锁');
    await store.createCharacter(projectId, '林岚', '调查员');
    await store.createOutline(projectId, '章纲', '第1章调查账本');
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
  function agent(proxy: ModelProxy, writer?: ChapterWriter): AgentOrchestrator {
    return new AgentOrchestrator(store, new ModelConfigService(store), proxy, undefined as never, writer as never, memory);
  }
  function process(internals: Internals, content: string) {
    return internals.processChapterDraft(config, projectId, pack, 1, chapterId, '第1章', '调查账本', content, 900, 3, new AbortController().signal, () => {}, { autoRevisionEnabled: true, qualityGates: null });
  }
  async function saveCandidate(content: string) {
    const brief = await captureNovelWriteBrief(store, chapterId);
    await store.updateChapterContent(chapterId, content, brief.target.revision, { brief });
  }

  it('does not fall back to unguarded chapter generation after a source changed during a scene failure', async () => {
    const stream = vi.fn(async function* () { yield { kind: 'content' as const, text: '不应调用' }; });
    await store.saveChapterBlueprint({ chapter_id: chapterId, title: '章纲', main_goal: '查账', target_words: 900, tone: '悬疑', pacing: '快', required_plot_points: [], forbidden_points: [], emotional_curve: '紧张', scenes: [], ending_hook: '线索' });
    const writer = { async *streamChapter() {
      yield { type: 'scene' as const, sceneId: 's1' };
      await store.createCharacter(projectId, '新证人', '知道真相');
      throw new Error('scene provider failed');
    } } as unknown as ChapterWriter;
    const orchestrator = agent({ streamCompletion: stream }, writer);
    const internals = orchestrator as unknown as Internals;
    await expect(internals.writeLongNovelChapter(config, projectId, chapterId, pack, 1, 3, '第1章', undefined, '调查账本', 900, new AbortController().signal, () => {}, { current: 1, total: 1 }, [])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(stream).not.toHaveBeenCalled();
    expect((await store.getChapter(chapterId))?.content).toBe('');
  });

  it('rejects a late polish result and preserves the concurrent manual body', async () => {
    await store.updateChapterContent(chapterId, '原稿');
    const proxy: ModelProxy = { async *streamCompletion() { await store.updateChapterContent(chapterId, '作者手工新稿'); yield { kind: 'content', text: '过时润写稿' }; } };
    await expect(agent(proxy).run({ task: 'polish', mode: 'draft', projectId, chapterId, prompt: '润写此章' }, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.getChapter(chapterId))?.content).toBe('作者手工新稿');
  });

  it('does not give a saved candidate new source provenance when review starts after a source edit', async () => {
    await saveCandidate('原始生成稿');
    await store.createCharacter(projectId, '后来的人物', '新来源');
    const internals = agent({ async *streamCompletion() { throw new Error('must not call'); } }) as unknown as Internals;
    const inspect = vi.spyOn(internals, 'inspectChapterDraft').mockResolvedValue(inspection);
    await expect(process(internals, '原始生成稿')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(inspect).not.toHaveBeenCalled();
    expect(memory.get(projectId).summaries).toHaveLength(0);
  });

  it('never applies the first review to a revised candidate when reinspection fails', async () => {
    await saveCandidate('原始生成稿');
    const internals = agent({ async *streamCompletion() { throw new Error('must not call'); } }) as unknown as Internals;
    vi.spyOn(internals, 'inspectChapterDraft').mockResolvedValueOnce({ ...inspection, recommendRevision: true, revisionHints: ['补足线索'] }).mockRejectedValueOnce(new Error('review unavailable'));
    vi.spyOn(internals, 'reviseChapterWithHints').mockResolvedValue('修订后内容已改变');
    const commit = vi.spyOn(memory, 'markChapterCommitted');
    const result = await process(internals, '原始生成稿');
    expect(result.finalInspection.verdict).toBe('inspection_unavailable');
    expect(result.finalInspection.candidateHash).toBe(hashWriteBriefValue('修订后内容已改变'));
    expect((await store.getChapter(chapterId))?.content).toBe('修订后内容已改变');
    expect(memory.get(projectId).summaries).toHaveLength(0);
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not inject later chapter bodies or unversioned global memory into historical generation and review', async () => {
    await store.renameChapter(chapterId, '第100章'); // Display numbering is not the chronological cutoff.
    const future = await store.createChapter(projectId, '第2章');
    await store.updateChapterContent(future.id, 'FUTURE_BODY_CANARY');
    await memory.recordFacts(projectId, [{ kind: 'plot', text: 'FUTURE_MEMORY_CANARY' }]);
    await memory.appendChapterSummary(projectId, { chapterId: future.id, title: future.title, summary: 'FUTURE_SUMMARY_CANARY' });
    const prompts: string[] = [];
    const proxy: ModelProxy = { async *streamCompletion(_config, messages) { prompts.push(messages.map((message) => message.content).join('\n')); yield { kind: 'content', text: JSON.stringify(inspection) }; } };
    const internals = agent(proxy) as unknown as Internals;
    const brief = await captureNovelWriteBrief(store, chapterId);
    await internals.generateChapterWithMemory(config, projectId, pack, 100, 103, '历史章重写', 900, new AbortController().signal, brief);
    await internals.inspectChapterDraft(config, projectId, chapterId, 100, '第100章', '历史正文', new AbortController().signal, brief);
    expect(prompts).toHaveLength(2);
    expect(prompts.join('\n')).not.toMatch(/FUTURE_(BODY|MEMORY|SUMMARY)_CANARY/);
  });
});
