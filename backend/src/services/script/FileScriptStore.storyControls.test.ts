import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryControlInput } from '../../types/StoryControl.js';
import { FileScriptStore } from './FileScriptStore.js';
import { buildScriptAtomicCommitInput } from './ScriptContinuityCommit.js';
import { buildScriptWriteBrief, scriptWriteBriefSourcesCurrent } from './ScriptWriteBrief.js';
import type { ScriptEpisode, ScriptPlan, ScriptProjectState } from './domain.js';
import { renderWriteBrief } from '../writing/WriteBrief.js';
import { createFrozenMemoryProjection } from '../memory/sourceMemoryContract.js';

const preference: StoryControlInput = { kind: 'preference', text: '对白使用短句。', enabled: true, importance: 'required', fromUnit: 1 };
const plan: ScriptPlan = {
  id: 'plan', projectId: 'p', status: 'approved', revision: 0, title: '门外的钥匙', theme: '信任',
  market: 'domestic', channel: 'general', genres: ['剧情'], audience: '短剧观众', coreConflict: '钥匙去向不明',
  logline: '同伴寻找失踪的钥匙。', highlights: [], totalEpisodes: 3,
  episodeDurationSeconds: { min: 60, max: 90 }, targetCharsPerEpisode: 300, maxPrimaryCharacters: 5,
  maxScenesPerEpisode: 3, dialogueDensityPercent: 60, language: 'zh-CN', format: 'cn_short_drama',
  coreRequirements: '保留钥匙去向线索。', forbiddenElements: [], endingDirection: '揭开误会',
  createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
};

describe('author controls in the screenplay acceptance boundary', () => {
  let directory: string;
  let store: FileScriptStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'script-story-controls-'));
    store = await FileScriptStore.create(directory);
    await store.savePlan(plan, 0);
    await store.saveSeriesOutline({ projectId: 'p', synopsis: '同伴追查钥匙。', openingState: '钥匙遗失',
      midpointTurn: '发现新线索', climax: '揭露误会', endingState: '和解', mainArc: [], subplotArcs: [], revision: 0,
      episodeCards: [1, 2, 3].map((episodeNumber) => ({ episodeNumber, title: `第${episodeNumber}集`,
        logline: '寻找钥匙', mainEvent: '调查门外线索', endingHook: '谁来过门外？' })) }, 0);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

  async function accept(number: number) {
    const episode: ScriptEpisode = { id: `e${number}`, projectId: 'p', episodeNumber: number,
      title: `第${number}集`, outlineId: `o${number}`, status: 'reviewing', targetChars: 300, revision: 0,
      scenes: [{ id: `s${number}`, ordinal: 1, location: '门外', timeOfDay: 'day', interiorExterior: 'exterior', characterIds: [],
        blocks: [{ id: `b${number}`, type: 'action', text: `第${number}把钥匙在门外。` }] }],
      summary: `第${number}把钥匙在门外。`, newFacts: [`第${number}把钥匙在门外。`], openedThreads: [], closedThreads: [],
      createdAt: plan.createdAt, updatedAt: plan.updatedAt };
    const state = (await store.getProjectState('p'))!;
    return store.commitEpisodeWithContinuity(buildScriptAtomicCommitInput(state, episode, {
      characterUpdates: [], props: [], threads: [], timelineEvents: [], nextEpisodeMustInherit: [],
      factsAdded: [{ factId: `f${number}`, text: episode.newFacts[0]!, evidenceBlockIds: [`b${number}`] }],
    }, { promptVersion: 'author-control-fixture', modelConfigFingerprint: 'no-model' }));
  }

  it('binds enabled author instructions to the same brief that is checked at acceptance', async () => {
    const prior = buildScriptWriteBrief((await store.getProjectState('p'))!, 1)!;
    const saved = await store.upsertStoryControl('p', preference, 0);
    const state = (await store.getProjectState('p'))!;
    const brief = buildScriptWriteBrief(state, 1)!;
    expect(renderWriteBrief(brief)).toContain(preference.text);
    expect(scriptWriteBriefSourcesCurrent(state, prior)).toBe(false);
    await store.upsertStoryControl('p', { ...preference, id: saved.items[0]!.id, enabled: false }, saved.revision);
    const disabled = (await store.getProjectState('p'))!;
    expect(renderWriteBrief(buildScriptWriteBrief(disabled, 1)!)).not.toContain(preference.text);
    expect(scriptWriteBriefSourcesCurrent(disabled, brief)).toBe(false);
    expect((await (await FileScriptStore.create(directory)).getStoryControls('p')).items[0]!.enabled).toBe(false);
  });

  it('requires explicit adjudication, preserves both bodies and retracts the source chain atomically', async () => {
    const first = await accept(1), second = await accept(2);
    const source = first.continuity.memoryInput!.source;
    const correction: StoryControlInput = { ...preference, kind: 'fact_correction', text: '钥匙从未在门外。', source };
    const file = join(directory, 'p.json');
    const before = await readFile(file, 'utf8');
    await expect(store.upsertStoryControl('p', correction, 0)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await readFile(file, 'utf8')).toBe(before);
    const saved = await store.upsertStoryControl('p', { ...correction, resolutionConfirmed: true }, 0);
    store = await FileScriptStore.create(directory);
    const state = (await store.getProjectState('p'))!;
    expect(state.episodes.map((episode) => episode.scenes)).toEqual([first.episode.scenes, second.episode.scenes]);
    expect(state.episodes.every((episode) => episode.status === 'reviewing')).toBe(true);
    expect(state.continuityCommits!.every((commit) => commit.status === 'stale')).toBe(true);
    expect(state.memorySync).toMatchObject({ status: 'pending', projection: { acceptances: [] } });
    await store.deleteStoryControl('p', saved.items[0]!.id, saved.revision);
    expect((await store.getMemorySync('p'))!.projection.acceptances).toEqual([]);
  });

  it('does not allow two concurrent editors to overwrite the same collection revision', async () => {
    const results = await Promise.allSettled([
      store.upsertStoryControl('p', preference, 0), store.upsertStoryControl('p', { ...preference, text: '保留长句。' }, 0),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((await store.getStoryControls('p')).items).toHaveLength(1);
  });

  it('rejects forged source scope and leaves controls and accepted content intact', async () => {
    const { continuity } = await accept(1);
    const input: StoryControlInput = { ...preference, kind: 'fact_correction', resolutionConfirmed: true,
      source: { ...continuity.memoryInput!.source, projectId: 'another-project' } };
    await expect(store.upsertStoryControl('p', input, 0)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.getStoryControls('p')).revision).toBe(0);
    expect((await store.getMemorySync('p'))!.projection.acceptances).toHaveLength(1);
  });

  it('publishes no author changes on disk failure and cannot recreate a deleted project', async () => {
    vi.spyOn(store as unknown as { persist(state: ScriptProjectState): Promise<void> }, 'persist').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.upsertStoryControl('p', preference, 0)).rejects.toThrow();
    expect((await store.getStoryControls('p')).items).toEqual([]);
    await store.deleteProject('p');
    await expect(store.upsertStoryControl('p', preference, 0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.getProjectState('p')).toBeUndefined();
  });

  it('keeps future instructions outside the current unit without exposing their text', async () => {
    await store.upsertStoryControl('p', { ...preference, fromUnit: 3, text: '未来场景的作者要求' }, 0);
    const brief = buildScriptWriteBrief((await store.getProjectState('p'))!, 2)!;
    expect(JSON.stringify(brief)).not.toContain('未来场景的作者要求');
  });

  it('keeps the generated source identity current after accepting the first episode', async () => {
    const before = buildScriptWriteBrief((await store.getProjectState('p'))!, 1)!;
    await accept(1);
    expect(scriptWriteBriefSourcesCurrent((await store.getProjectState('p'))!, before)).toBe(true);
  });

  it('does not retain an old legacy thread when a later sourced commit closes it', async () => {
    await accept(1); await accept(2);
    const state = (await store.getProjectState('p'))!;
    const [first, second] = state.continuityCommits!;
    delete first!.memoryInput;
    first!.threads = [{ threadId: 'legacy-thread', action: 'opened', description: '过期的旧钥匙悬念', evidenceBlockIds: [] }];
    second!.threads = [{ threadId: 'legacy-thread', action: 'closed', description: '钥匙悬念已解开', evidenceBlockIds: ['b2'] }];
    const memoryInput = second!.memoryInput!;
    const block = memoryInput.blocks[0]!;
    memoryInput.entries.push({ id: 'thread:legacy-thread', kind: 'thread', entity: 'legacy-thread', key: 'thread', action: 'close',
      text: block.text, evidence: [{ blockId: block.id, start: 0, end: block.text.length, quote: block.text }] });
    state.memorySync!.projection = createFrozenMemoryProjection({ clientId: 'local', projectId: 'p', mode: 'short_drama',
      revision: state.memorySync!.projection.revision, acceptances: [memoryInput] });
    const brief = buildScriptWriteBrief(state, 3)!;
    expect(brief.required.map((item) => item.text).join('\n')).not.toContain('过期的旧钥匙悬念');
    expect(brief.memoryContext!.statistics.maxChars).toBe(5500);
  });

  it('fails closed on malformed stored author decisions instead of dropping them on reopen', async () => {
    await store.upsertStoryControl('p', preference, 0);
    const file = join(directory, 'p.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.storyControls.items[0].fromUnit = -1;
    const raw = JSON.stringify(saved);
    await writeFile(file, raw, 'utf8');
    const reopened = await FileScriptStore.create(directory);
    await expect(reopened.getProjectState('p')).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(raw);
  });
});
