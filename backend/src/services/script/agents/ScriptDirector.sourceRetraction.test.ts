import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileScriptStore } from '../FileScriptStore.js';
import { buildScriptAtomicCommitInput } from '../ScriptContinuityCommit.js';
import type { ScriptEpisode, ScriptPlan, ScriptProjectState } from '../domain.js';
import { InMemoryScriptCheckpointStore, ScriptDirector } from './ScriptDirector.js';

const now = '2026-09-15T00:00:00.000Z';
const plan: ScriptPlan = {
  id: 'plan', projectId: 'p', status: 'approved', revision: 0, title: '门外的钥匙', theme: '信任',
  market: 'domestic', channel: 'general', genres: ['剧情'], audience: '短剧观众', coreConflict: '钥匙去向不明',
  logline: '同伴寻找失踪的钥匙。', highlights: [], totalEpisodes: 2,
  episodeDurationSeconds: { min: 60, max: 90 }, targetCharsPerEpisode: 300, maxPrimaryCharacters: 5,
  maxScenesPerEpisode: 3, dialogueDensityPercent: 60, language: 'zh-CN', format: 'cn_short_drama',
  coreRequirements: '保留钥匙去向线索。', forbiddenElements: [], endingDirection: '揭开误会', createdAt: now, updatedAt: now,
};

describe('single episode rewrites respect withdrawn accepted sources', () => {
  let directory: string; let store: FileScriptStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'script-source-retraction-'));
    store = await FileScriptStore.create(directory);
    await store.savePlan(plan, 0);
    await store.saveCharacters('p', [{ id: 'lead', projectId: 'p', name: '林岚', aliases: [], role: 'lead', identity: '调查员',
      biography: '调查真相', motivation: '寻找钥匙', goal: '揭开误会', weakness: '多疑', arc: '信任同伴', appearance: '短发',
      hairstyle: '短发', physique: '普通', defaultOutfit: '风衣', personality: ['冷静'], skills: ['调查'], speechStyle: '简洁',
      catchphrases: [], relationships: [], revision: 0, updatedAt: now }], 0);
    await store.saveWorldBible({ projectId: 'p', era: '现代', primaryLocations: ['门外'], worldState: '现实', rules: [],
      transport: [], communication: [], organizations: [], recurringProps: ['钥匙'], forbiddenAnachronisms: [], revision: 0, updatedAt: now }, 0);
    await store.saveSeriesOutline({ projectId: 'p', synopsis: '追查钥匙', openingState: '遗失', midpointTurn: '线索', climax: '揭露',
      endingState: '和解', mainArc: [], subplotArcs: [], revision: 0, episodeCards: [1, 2].map((episodeNumber) => ({ episodeNumber,
        title: `第${episodeNumber}集`, logline: '寻找钥匙', mainEvent: '调查门外线索', endingHook: '谁来过门外？' })) }, 0);
    await accept(1); await accept(2);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

  async function accept(number: number) {
    const episode: ScriptEpisode = { id: `e${number}`, projectId: 'p', episodeNumber: number, title: `第${number}集`,
      outlineId: `o${number}`, status: 'reviewing', targetChars: 300, revision: 0,
      scenes: [{ id: `s${number}`, ordinal: 1, location: '门外', timeOfDay: 'day', interiorExterior: 'exterior', characterIds: ['lead'],
        blocks: [{ id: `b${number}`, type: 'action', text: `第${number}把钥匙在门外。` }] }],
      summary: `第${number}把钥匙在门外。`, newFacts: [`第${number}把钥匙在门外。`], openedThreads: [], closedThreads: [], createdAt: now, updatedAt: now };
    return store.commitEpisodeWithContinuity(buildScriptAtomicCommitInput((await store.getProjectState('p'))!, episode, {
      characterUpdates: [], props: [], threads: [], timelineEvents: [], nextEpisodeMustInherit: [],
      factsAdded: [{ factId: `f${number}`, text: episode.newFacts[0]!, evidenceBlockIds: [`b${number}`] }],
    }, { promptVersion: 'fixture', modelConfigFingerprint: 'no-model' }));
  }

  it.each(['correction', 'disabled-correction', 'deleted-correction', 'manual-edit'] as const)(
    'does not repair withdrawn episode one during an episode two rewrite after %s', async (change) => {
      const original = (await store.getProjectState('p'))!;
      if (change === 'manual-edit') {
        const first = structuredClone(original.episodes[0]!);
        first.scenes[0]!.blocks[0]!.text = '作者改稿：钥匙不在门外。';
        await store.saveEpisode(first, first.revision);
      } else {
        const input = { kind: 'fact_correction' as const, text: '钥匙从未在门外。', enabled: true, importance: 'required' as const,
          fromUnit: 1, source: original.continuityCommits![0]!.memoryInput!.source, resolutionConfirmed: true };
        const controls = await store.upsertStoryControl('p', input, 0);
        if (change === 'disabled-correction') await store.upsertStoryControl('p', { ...input, id: controls.items[0]!.id, enabled: false }, controls.revision);
        if (change === 'deleted-correction') await store.deleteStoryControl('p', controls.items[0]!.id, controls.revision);
      }
      store = await FileScriptStore.create(directory);
      const before = await readFile(join(directory, 'p.json'), 'utf8');
      const complete = vi.fn(async () => { throw new Error('must not call model'); });
      const director = new ScriptDirector({ store, checkpoints: new InMemoryScriptCheckpointStore(), model: { complete } });
      await expect(director.run({ task: 'script_episode_batch', projectId: 'p', startEpisode: 2, episodeCount: 1,
        regenerate: true, draftMode: 'direct_text', expectedPlanRevision: (await store.getProjectState('p'))!.plan!.revision })).rejects.toThrow('第 1 集必须完成');
      expect(complete).not.toHaveBeenCalled();
      expect(await readFile(join(directory, 'p.json'), 'utf8')).toBe(before);
      expect((await store.getMemorySync('p'))!.projection.acceptances).toEqual([]);
    },
  );

  it('still permits local repair for genuine legacy episodes with no frozen acceptance history', async () => {
    const state = (await store.getProjectState('p'))!;
    delete state.memorySync;
    for (const commit of state.continuityCommits!) { delete commit.memoryInput; commit.status = 'stale'; }
    await writeFile(join(directory, 'p.json'), JSON.stringify(state), 'utf8');
    store = await FileScriptStore.create(directory);
    const complete = vi.fn(async () => { throw new Error('must not call model'); });
    const director = new ScriptDirector({ store, checkpoints: new InMemoryScriptCheckpointStore(), model: { complete } });
    const legacy = (await store.getProjectState('p'))!;
    const repaired = await (director as unknown as { repairExistingContinuityThrough(projectId: string, through: number, plan: ScriptPlan, state: ScriptProjectState): Promise<ScriptProjectState> })
      .repairExistingContinuityThrough('p', 1, legacy.plan!, legacy);
    expect(repaired.episodes[0]!.status).toBe('completed');
    expect(repaired.memorySync!.projection.acceptances).toHaveLength(1);
    expect(complete).not.toHaveBeenCalled();
  });
});
