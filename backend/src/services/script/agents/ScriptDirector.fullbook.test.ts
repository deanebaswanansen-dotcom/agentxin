import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileScriptCheckpointStore } from '../FileScriptCheckpointStore.js';
import { FileScriptStore } from '../FileScriptStore.js';
import { currentScriptContinuityCommits } from '../ScriptContinuityCommit.js';
import type {
  ScriptCharacter,
  ScriptPlan,
  ScriptSeriesOutline,
  ScriptWorldBible,
} from '../domain.js';
import {
  ScriptDirector,
  type ScriptModelAdapter,
  type ScriptModelNode,
  type ScriptModelRequest,
} from './ScriptDirector.js';

const PROJECT_ID = 'fullbook-10';
const NOW = '2026-08-15T08:00:00.000Z';

function episodeNumbersFromOutlinePrompt(prompt: string): number[] {
  const value = /需要集号：([^\n]+)/u.exec(prompt)?.[1];
  if (!value) throw new Error('episode_outline prompt 缺少需要集号');
  return value
    .split('、')
    .map((item) => Number.parseInt(item, 10))
    .filter(Number.isInteger);
}

class DeterministicFullBookModel implements ScriptModelAdapter {
  readonly calls: Array<{
    node: ScriptModelNode;
    episodeNumber?: number;
    prompt: string;
  }> = [];

  private reviewFailureConsumed = false;

  constructor(private readonly failFirstReviewForEpisode?: number) {}

  async getModelConfigFingerprint(): Promise<string> {
    return 'offline-fullbook-model-v1';
  }

  async complete(request: ScriptModelRequest): Promise<string> {
    this.calls.push({
      node: request.node,
      ...(request.episodeNumber === undefined ? {} : { episodeNumber: request.episodeNumber }),
      prompt: request.prompt,
    });
    if (request.node === 'episode_outline') {
      return JSON.stringify({
        outlines: episodeNumbersFromOutlinePrompt(request.prompt).map((episodeNumber) => ({
          episodeNumber,
          title: `第${episodeNumber}集：证据推进`,
          goal: `完成第${episodeNumber}阶段调查`,
          conflict: '沈清取证时遭到对手阻挠',
          beats: ['核验证据', '遭遇阻挠', '拿到新线索'],
          characterIds: ['lead'],
          plannedScenes: [],
          endingHook: `第${episodeNumber}集新证据出现`,
          requiredFacts: [],
          forbiddenFacts: [],
        })),
      });
    }
    const episodeNumber = request.episodeNumber;
    if (!episodeNumber) throw new Error(`${request.node} 缺少 episodeNumber`);
    if (request.node === 'scene_plan') {
      return JSON.stringify({
        plannedScenes: [{
          ordinal: 1,
          location: '校报社资料室',
          timeOfDay: 'day',
          interiorExterior: 'interior',
          purpose: `推进第${episodeNumber}集调查并以新证据收尾`,
        }],
      });
    }
    if (request.node === 'draft') {
      return JSON.stringify({
        episodeNumber,
        title: `第${episodeNumber}集：证据推进`,
        scenes: [{
          ordinal: 1,
          location: '校报社资料室',
          timeOfDay: 'day',
          interiorExterior: 'interior',
          characterIds: ['lead'],
        blocks: [{ type: 'action', text: '沈清握紧录音笔核验证据推进调查'.repeat(20) }],
        }],
        summary: '',
        newFacts: [],
        openedThreads: [],
        closedThreads: [],
      });
    }
    if (request.node === 'review') {
      if (
        episodeNumber === this.failFirstReviewForEpisode &&
        !this.reviewFailureConsumed
      ) {
        this.reviewFailureConsumed = true;
        throw new Error(`模拟第${episodeNumber}集候选检查点后的进程中断`);
      }
      return JSON.stringify({
        issues: [],
        summary: `第${episodeNumber}集沈清在资料室完成本阶段取证并发现下一条线索。`,
        newFacts: [`第${episodeNumber}集证据已登记`],
        openedThreads: [`第${episodeNumber}集待解线索`],
        closedThreads: [],
        wardrobe: [{ characterId: 'lead', outfit: '白衬衫与黑色长裤' }],
      });
    }
    throw new Error(`unexpected model node: ${request.node}`);
  }
}

function plan(): ScriptPlan {
  return {
    id: 'plan-fullbook-10',
    projectId: PROJECT_ID,
    status: 'approved',
    revision: 0,
    title: '十集离线连续性诊断',
    theme: '用证据击破操控',
    market: 'domestic',
    channel: 'female',
    genres: ['都市', '悬疑'],
    audience: '女性短剧观众',
    coreConflict: '沈清调查幕后操控者并保护证人',
    logline: '校报主编沈清用连续十集的取证击破操控网络。',
    highlights: ['逐集证据升级', '连续性追踪'],
    totalEpisodes: 10,
    episodeDurationSeconds: { min: 60, max: 90 },
    targetCharsPerEpisode: 300,
    maxPrimaryCharacters: 6,
    maxScenesPerEpisode: 3,
    dialogueDensityPercent: 0,
    language: 'zh-CN',
    format: 'cn_short_drama',
    coreRequirements: '每集推进调查并留下下一集线索',
    forbiddenElements: [],
    endingDirection: '操控网络被公开',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function character(): ScriptCharacter {
  return {
    id: 'lead',
    projectId: PROJECT_ID,
    name: '沈清',
    aliases: [],
    role: 'lead',
    age: 26,
    occupation: '校报主编',
    identity: '坚持核验证据的调查者',
    biography: '长期负责校园调查报道。',
    motivation: '保护证人并公开真相',
    goal: '查清操控网络',
    weakness: '习惯独自承担风险',
    arc: '学会与同伴协作',
    appearance: '神情冷静，行动利落',
    hairstyle: '齐肩短发',
    physique: '高挑',
    defaultOutfit: '白衬衫与黑色长裤',
    personality: ['冷静', '坚定'],
    skills: ['采访', '证据核验'],
    speechStyle: '简洁直接',
    catchphrases: [],
    relationships: [],
    revision: 0,
    updatedAt: NOW,
  };
}

function worldBible(): ScriptWorldBible {
  return {
    projectId: PROJECT_ID,
    era: '2026年',
    primaryLocations: ['校报社资料室'],
    worldState: '当代校园调查环境',
    rules: ['证据必须经过核验'],
    transport: ['步行', '公交'],
    communication: ['手机', '校内通讯'],
    organizations: ['校报社'],
    recurringProps: ['录音笔', '证据文件夹'],
    forbiddenAnachronisms: [],
    revision: 0,
    updatedAt: NOW,
  };
}

function seriesOutline(): ScriptSeriesOutline {
  return {
    projectId: PROJECT_ID,
    synopsis: '沈清沿十条连续线索逐步查清操控网络。',
    openingState: '第一条证据刚刚出现。',
    midpointTurn: '关键证人确认幕后组织。',
    climax: '完整证据链被公开。',
    endingState: '操控网络瓦解，证人获得保护。',
    mainArc: ['发现线索', '建立证据链', '公开真相'],
    subplotArcs: ['沈清学会与团队协作'],
    episodeCards: Array.from({ length: 10 }, (_, index) => {
      const episodeNumber = index + 1;
      return {
        episodeNumber,
        title: `第${episodeNumber}集：证据推进`,
        logline: `沈清完成第${episodeNumber}阶段调查。`,
        mainEvent: `登记第${episodeNumber}条证据。`,
        endingHook: `第${episodeNumber}集新证据出现。`,
      };
    }),
    revision: 0,
  };
}

async function seedProject(store: FileScriptStore): Promise<ScriptPlan> {
  const savedPlan = await store.savePlan(plan(), 0);
  await store.saveSeriesOutline(seriesOutline(), 0);
  await store.saveCharacters(PROJECT_ID, [character()], 0);
  await store.saveWorldBible(worldBible(), 0);
  return savedPlan;
}

describe('ScriptDirector offline ten-episode full-book diagnostic', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  it('finishes fixed 1-5 and 6-10 batches with canonical continuity and idempotent reruns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-fullbook-'));
    directories.push(directory);
    const store = await FileScriptStore.create(join(directory, 'projects'));
    const checkpoints = await FileScriptCheckpointStore.create(join(directory, 'checkpoints'));
    const savedPlan = await seedProject(store);

    const model = new DeterministicFullBookModel();
    let nextId = 0;
    const director = new ScriptDirector({
      model,
      store,
      checkpoints,
      now: () => NOW,
      id: () => `fullbook-id-${++nextId}`,
    });

    const firstBatch = await director.run({
      task: 'script_episode_batch',
      projectId: PROJECT_ID,
      startEpisode: 1,
      episodeCount: 5,
      expectedPlanRevision: savedPlan.revision,
    });
    expect(firstBatch.kind).toBe('episode_batch');
    if (firstBatch.kind !== 'episode_batch') throw new Error('预期 episode_batch');
    expect(firstBatch.episodes.map((episode) => episode.episodeNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(firstBatch.skippedEpisodeNumbers).toEqual([]);

    const afterFirstBatch = await store.getProjectState(PROJECT_ID);
    expect(afterFirstBatch?.plan?.status).toBe('locked');
    expect(currentScriptContinuityCommits(afterFirstBatch!).map((commit) => commit.episodeNumber))
      .toEqual([1, 2, 3, 4, 5]);

    const secondBatch = await director.run({
      task: 'script_episode_batch',
      projectId: PROJECT_ID,
      startEpisode: 6,
      episodeCount: 5,
      expectedPlanRevision: afterFirstBatch!.plan!.revision,
    });
    expect(secondBatch.kind).toBe('episode_batch');
    if (secondBatch.kind !== 'episode_batch') throw new Error('预期 episode_batch');
    expect(secondBatch.episodes.map((episode) => episode.episodeNumber)).toEqual([6, 7, 8, 9, 10]);
    expect(secondBatch.skippedEpisodeNumbers).toEqual([]);

    const state = await store.getProjectState(PROJECT_ID);
    expect(state?.episodes).toHaveLength(10);
    expect(state?.episodes.map((episode) => episode.status)).toEqual(Array(10).fill('completed'));
    const commits = currentScriptContinuityCommits(state!);
    expect(commits).toHaveLength(10);
    for (const episode of state!.episodes) {
      const matching = commits.filter((commit) => (
        commit.episodeNumber === episode.episodeNumber &&
        commit.episodeRevision === episode.revision &&
        commit.status === 'current'
      ));
      expect(matching, `第 ${episode.episodeNumber} 集应有唯一 current continuity`).toHaveLength(1);
    }
    for (let index = 1; index < commits.length; index += 1) {
      expect(commits[index]?.previousContinuityCommitId).toBe(commits[index - 1]?.id);
      expect(commits[index]?.previousContinuityRevision).toBe(commits[index - 1]?.revision);
    }

    const episodeSixPrompt = model.calls.find(
      (call) => call.node === 'draft' && call.episodeNumber === 6,
    )?.prompt;
    expect(episodeSixPrompt).toContain('第5集证据已登记');
    expect(episodeSixPrompt).toContain('第5集待解线索');
    expect(episodeSixPrompt).toContain('录音笔');
    expect(episodeSixPrompt).toContain('causeEventIds');
    expect(episodeSixPrompt).toContain('props');
    expect(episodeSixPrompt).toContain('recentCommits');
    expect(model.calls.filter((call) => call.node === 'revision')).toHaveLength(0);
    expect(model.calls).toHaveLength(32);

    const firstCheckpoints = await checkpoints.list(PROJECT_ID, 'script_episode_batch:1:5');
    const secondCheckpoints = await checkpoints.list(PROJECT_ID, 'script_episode_batch:6:5');
    expect(firstCheckpoints.filter((checkpoint) => checkpoint.node === 'draft')).toHaveLength(5);
    expect(secondCheckpoints.filter((checkpoint) => checkpoint.node === 'draft')).toHaveLength(5);
    expect([...firstCheckpoints, ...secondCheckpoints].filter(
      (checkpoint) => checkpoint.node === 'completed',
    )).toHaveLength(10);

    const callsBeforeRerun = model.calls.length;
    const latestPlanRevision = state!.plan!.revision;
    const rerunFirst = await director.run({
      task: 'script_episode_batch',
      projectId: PROJECT_ID,
      startEpisode: 1,
      episodeCount: 5,
      expectedPlanRevision: latestPlanRevision,
    });
    const rerunSecond = await director.run({
      task: 'script_episode_batch',
      projectId: PROJECT_ID,
      startEpisode: 6,
      episodeCount: 5,
      expectedPlanRevision: latestPlanRevision,
    });
    expect(rerunFirst.kind).toBe('episode_batch');
    expect(rerunSecond.kind).toBe('episode_batch');
    if (rerunFirst.kind !== 'episode_batch' || rerunSecond.kind !== 'episode_batch') {
      throw new Error('预期 episode_batch');
    }
    expect(rerunFirst.skippedEpisodeNumbers).toEqual([1, 2, 3, 4, 5]);
    expect(rerunSecond.skippedEpisodeNumbers).toEqual([6, 7, 8, 9, 10]);
    expect(model.calls).toHaveLength(callsBeforeRerun);
  });

  it('resumes after a durable draft candidate without calling the draft model again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-fullbook-resume-'));
    directories.push(directory);
    const store = await FileScriptStore.create(join(directory, 'projects'));
    const checkpoints = await FileScriptCheckpointStore.create(join(directory, 'checkpoints'));
    const savedPlan = await seedProject(store);
    const model = new DeterministicFullBookModel(3);
    let nextId = 0;
    const director = new ScriptDirector({
      model,
      store,
      checkpoints,
      now: () => NOW,
      id: () => `resume-id-${++nextId}`,
    });
    const request = {
      task: 'script_episode_batch' as const,
      projectId: PROJECT_ID,
      startEpisode: 1,
      episodeCount: 5,
      expectedPlanRevision: savedPlan.revision,
    };

    await expect(director.run(request)).rejects.toMatchObject({
      code: 'SCRIPT_STRUCTURED_NEEDS_REVIEW',
      recoverable: true,
    });
    const interruptedState = await store.getProjectState(PROJECT_ID);
    expect(interruptedState?.episodes.map((episode) => episode.episodeNumber)).toEqual([1, 2]);
    const interruptedCheckpoints = await checkpoints.list(
      PROJECT_ID,
      'script_episode_batch:1:5',
    );
    expect(interruptedCheckpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: 'draft',
        episodeNumber: 3,
        status: 'succeeded',
        artifact: expect.objectContaining({ stage: 'draft', episodeNumber: 3 }),
      }),
    ]));
    expect(model.calls.filter(
      (call) => call.node === 'draft' && call.episodeNumber === 3,
    )).toHaveLength(1);

    const resumed = await director.run({
      ...request,
      expectedPlanRevision: interruptedState!.plan!.revision,
    });
    expect(resumed.kind).toBe('episode_batch');
    if (resumed.kind !== 'episode_batch') throw new Error('预期 episode_batch');
    expect(resumed.episodes.map((episode) => episode.episodeNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(resumed.skippedEpisodeNumbers).toEqual([1, 2]);
    expect(model.calls.filter(
      (call) => call.node === 'draft' && call.episodeNumber === 3,
    )).toHaveLength(1);
    expect(model.calls.filter(
      (call) => call.node === 'review' && call.episodeNumber === 3,
    )).toHaveLength(2);

    const finalState = await store.getProjectState(PROJECT_ID);
    expect(finalState?.episodes.map((episode) => episode.status)).toEqual(Array(5).fill('completed'));
    expect(currentScriptContinuityCommits(finalState!)).toHaveLength(5);
  });
});
