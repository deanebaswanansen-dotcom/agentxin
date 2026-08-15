import { describe, expect, it } from 'vitest';

import type {
  ScriptCharacter,
  ScriptContinuityState,
  ScriptEpisode,
  ScriptEpisodeOutline,
  ScriptPlan,
  ScriptProjectState,
  ScriptSeriesOutline,
  ScriptWorldBible,
} from '../domain.js';
import type { ScriptStore } from '../ScriptStore.js';
import {
  InMemoryScriptCheckpointStore,
  ScriptDirector,
  type ScriptModelAdapter,
} from './ScriptDirector.js';

class MemoryScriptStore implements ScriptStore {
  constructor(readonly state: ScriptProjectState) {}

  async getProjectState(projectId: string): Promise<ScriptProjectState | undefined> {
    return projectId === this.state.projectId ? structuredClone(this.state) : undefined;
  }

  async savePlan(plan: ScriptPlan): Promise<ScriptPlan> {
    const saved = { ...plan, revision: plan.revision + 1 };
    this.state.plan = saved;
    return structuredClone(saved);
  }

  async saveCharacters(_projectId: string, items: ScriptCharacter[]): Promise<ScriptCharacter[]> {
    this.state.characters = structuredClone(items);
    return structuredClone(items);
  }

  async saveWorldBible(value: ScriptWorldBible): Promise<ScriptWorldBible> {
    this.state.worldBible = { ...value, revision: value.revision + 1 };
    return structuredClone(this.state.worldBible);
  }

  async saveSeriesOutline(value: ScriptSeriesOutline): Promise<ScriptSeriesOutline> {
    this.state.seriesOutline = { ...value, revision: value.revision + 1 };
    return structuredClone(this.state.seriesOutline);
  }

  async saveEpisodeOutline(value: ScriptEpisodeOutline): Promise<ScriptEpisodeOutline> {
    const saved = { ...value, revision: value.revision + 1 };
    this.state.episodeOutlines = [
      ...this.state.episodeOutlines.filter((item) => item.episodeNumber !== saved.episodeNumber),
      saved,
    ];
    return structuredClone(saved);
  }

  async saveEpisode(value: ScriptEpisode): Promise<ScriptEpisode> {
    const saved = { ...value, revision: value.revision + 1 };
    this.state.episodes = [
      ...this.state.episodes.filter((item) => item.episodeNumber !== saved.episodeNumber),
      saved,
    ];
    return structuredClone(saved);
  }

  async saveContinuity(
    _projectId: string,
    value: ScriptContinuityState,
  ): Promise<ScriptContinuityState> {
    this.state.continuity = structuredClone(value);
    return structuredClone(value);
  }

  async deleteProject(): Promise<void> {}
}

function emptyState(): ScriptProjectState {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    characters: [],
    episodeOutlines: [],
    episodes: [],
    continuity: { currentState: [], openThreads: [], wardrobeLedger: [] },
    updatedAt: '2026-08-14T00:00:00.000Z',
  };
}

function approvedPlan(totalEpisodes = 10): ScriptPlan {
  return {
    id: 'plan-1',
    projectId: 'project-1',
    status: 'approved',
    revision: 1,
    title: '逆风新闻社',
    theme: '拒绝沉默',
    market: 'domestic',
    channel: 'female',
    genres: ['校园青春'],
    audience: '18—30 岁女性',
    coreConflict: '校报主编对抗霸凌势力',
    logline: '女主用校报揭开谎言。',
    highlights: ['调查', '反转'],
    totalEpisodes,
    episodeDurationSeconds: { min: 60, max: 90 },
    targetCharsPerEpisode: 300,
    maxPrimaryCharacters: 8,
    maxScenesPerEpisode: 3,
    dialogueDensityPercent: 60,
    language: 'zh-CN',
    format: 'cn_short_drama',
    coreRequirements: '校园真实感',
    forbiddenElements: ['超自然力量'],
    endingDirection: '真相公开',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  };
}

describe('ScriptDirector', () => {
  it('returns planning questions before invoking the model or writing artifacts', async () => {
    const calls: string[] = [];
    const model: ScriptModelAdapter = {
      async complete(request) {
        calls.push(request.node);
        return '{}';
      },
    };
    const store = new MemoryScriptStore(emptyState());
    const director = new ScriptDirector({
      model,
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    const result = await director.run({
      task: 'script_plan',
      projectId: 'project-1',
      planningSession: {
        values: { genres: ['校园青春'] },
        delegatedFields: [],
        askedFields: [],
        questionCount: 0,
      },
    });

    expect(result.kind).toBe('planning_questions');
    expect(calls).toEqual([]);
    expect(store.state.plan).toBeUndefined();
  });

  it('creates a draft plan only after confirmation fields are complete and preserves user choices', async () => {
    const model: ScriptModelAdapter = {
      async complete() {
        return JSON.stringify({
          title: '逆风新闻社',
          theme: '拒绝沉默',
          market: 'domestic',
          channel: 'female',
          genres: ['西方玄幻'],
          audience: '18—30 岁女性',
          coreConflict: '新闻社主编与校园霸凌势力对抗',
          logline: '女主用校报揭开谎言。',
          highlights: ['调查', '反转'],
          totalEpisodes: 10,
          episodeDurationSeconds: { min: 60, max: 90 },
          targetCharsPerEpisode: 1_000,
          maxPrimaryCharacters: 8,
          maxScenesPerEpisode: 3,
          dialogueDensityPercent: 60,
          language: 'zh-CN',
          format: 'cn_short_drama',
          coreRequirements: '校园真实感',
          forbiddenElements: ['超自然力量'],
          endingDirection: '真相公开',
        });
      },
    };
    const store = new MemoryScriptStore(emptyState());
    const director = new ScriptDirector({
      model,
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      now: () => '2026-08-14T00:00:00.000Z',
      id: () => 'plan-1',
    });

    const result = await director.run({
      task: 'script_plan',
      projectId: 'project-1',
      planningSession: {
        values: {
          genres: ['校园青春'],
          coreConflict: '新闻社主编与校园霸凌势力对抗',
          audience: '18—30 岁女性',
          totalEpisodes: 10,
          episodeDurationSeconds: { min: 60, max: 90 },
          targetCharsPerEpisode: 1_000,
          maxScenesPerEpisode: 3,
          dialogueDensityPercent: 60,
          endingDirection: '真相公开',
        },
        delegatedFields: [],
        askedFields: [],
        questionCount: 0,
      },
    });

    expect(result.kind).toBe('plan_draft');
    expect(store.state.plan).toMatchObject({
      status: 'draft',
      genres: ['校园青春'],
      totalEpisodes: 10,
      projectId: 'project-1',
    });
  });

  it('generates the complete series outline in ten-episode chunks and preserves continuous numbering', async () => {
    const chunkStarts: number[] = [];
    const model: ScriptModelAdapter = {
      async complete(request) {
        if (request.node !== 'series_outline') throw new Error('unexpected node');
        const start = request.chunkStart ?? 1;
        const end = request.chunkEnd ?? 12;
        chunkStarts.push(start);
        return JSON.stringify({
          synopsis: '女主从沉默到公开真相。',
          openingState: '新闻社被压制。',
          midpointTurn: '关键证人倒戈。',
          climax: '直播公开证据。',
          endingState: '校园建立新制度。',
          mainArc: ['调查', '反击'],
          subplotArcs: ['友情'],
          episodeCards: Array.from({ length: end - start + 1 }, (_, index) => {
            const episodeNumber = start + index;
            return {
              episodeNumber,
              title: `第${episodeNumber}步`,
              logline: `第${episodeNumber}集推进调查。`,
              mainEvent: `找到证据${episodeNumber}。`,
              endingHook: `新线索${episodeNumber}出现。`,
            };
          }),
        });
      },
    };
    const state = emptyState();
    state.plan = approvedPlan(12);
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      model,
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    const result = await director.run({ task: 'script_series_outline', projectId: 'project-1' });

    expect(result.kind).toBe('series_outline');
    expect(chunkStarts).toEqual([1, 11]);
    expect(store.state.seriesOutline?.episodeCards.map((card) => card.episodeNumber)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });

  it('generates and saves character and world bibles as independent structured artifacts', async () => {
    const nodes: string[] = [];
    const model: ScriptModelAdapter = {
      async complete(request) {
        nodes.push(request.node);
        if (request.node === 'character_bible') {
          return JSON.stringify({
            characters: [
              {
                id: 'lead',
                name: '沈清',
                aliases: [],
                role: 'lead',
                age: 25,
                occupation: '校报主编',
                identity: '新闻系学生',
                biography: '坚持调查真相。',
                motivation: '保护受害者',
                goal: '公开证据',
                weakness: '不愿求助',
                arc: '学会信任同伴',
                appearance: '利落短发',
                hairstyle: '齐肩短发',
                physique: '高挑',
                defaultOutfit: '白衬衫与黑色长裤',
                personality: ['冷静', '坚韧'],
                skills: ['采访'],
                speechStyle: '简洁直接',
                catchphrases: [],
                relationships: [],
              },
            ],
          });
        }
        if (request.node === 'world_bible') {
          return JSON.stringify({
            era: '2026年',
            primaryLocations: ['沧南大学'],
            worldState: '当代校园。',
            rules: ['遵守现实法律'],
            transport: ['公交'],
            communication: ['手机'],
            organizations: ['校报社'],
            recurringProps: ['录音笔'],
            forbiddenAnachronisms: ['超自然力量'],
          });
        }
        throw new Error('unexpected node');
      },
    };
    const state = emptyState();
    state.plan = approvedPlan();
    state.seriesOutline = {
      projectId: 'project-1',
      synopsis: '调查真相。',
      openingState: '受压制。',
      midpointTurn: '证人倒戈。',
      climax: '直播证据。',
      endingState: '制度改变。',
      mainArc: ['调查'],
      subplotArcs: [],
      episodeCards: Array.from({ length: 10 }, (_, index) => ({
        episodeNumber: index + 1,
        title: `第${index + 1}集`,
        logline: '推进调查。',
        mainEvent: '取得证据。',
        endingHook: '新线索。',
      })),
      revision: 1,
    };
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      model,
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      now: () => '2026-08-14T00:00:00.000Z',
    });

    const result = await director.run({ task: 'script_bible', projectId: 'project-1' });

    expect(result.kind).toBe('bible');
    expect(nodes).toEqual(['character_bible', 'world_bible']);
    expect(store.state.characters[0]).toMatchObject({ name: '沈清', defaultOutfit: '白衬衫与黑色长裤' });
    expect(store.state.worldBible).toMatchObject({ era: '2026年', communication: ['手机'] });
  });

  it('generates a resumable episode batch and skips completed episodes on a second run', async () => {
    const state = emptyState();
    state.plan = approvedPlan(2);
    state.seriesOutline = {
      projectId: 'project-1',
      synopsis: '调查真相。',
      openingState: '受压制。',
      midpointTurn: '证人倒戈。',
      climax: '直播证据。',
      endingState: '制度改变。',
      mainArc: ['调查'],
      subplotArcs: [],
      episodeCards: [1, 2].map((episodeNumber) => ({
        episodeNumber,
        title: `第${episodeNumber}集`,
        logline: '推进调查。',
        mainEvent: '取得证据。',
        endingHook: '新线索。',
      })),
      revision: 1,
    };
    state.characters = [
      {
        id: 'lead',
        projectId: 'project-1',
        name: '沈清',
        aliases: [],
        role: 'lead',
        identity: '校报主编',
        biography: '坚持调查真相。',
        motivation: '保护受害者',
        goal: '公开证据',
        weakness: '不愿求助',
        arc: '学会信任同伴',
        appearance: '利落短发',
        hairstyle: '齐肩短发',
        physique: '高挑',
        defaultOutfit: '白衬衫与黑色长裤',
        personality: ['冷静'],
        skills: ['采访'],
        speechStyle: '简洁直接',
        catchphrases: [],
        relationships: [],
        revision: 1,
        updatedAt: '2026-08-14T00:00:00.000Z',
      },
    ];
    state.worldBible = {
      projectId: 'project-1',
      era: '2026年',
      primaryLocations: ['沧南大学'],
      worldState: '当代校园。',
      rules: ['遵守现实法律'],
      transport: ['公交'],
      communication: ['手机'],
      organizations: ['校报社'],
      recurringProps: ['录音笔'],
      forbiddenAnachronisms: [],
      revision: 1,
      updatedAt: '2026-08-14T00:00:00.000Z',
    };
    const calls: Array<{ node: string; episodeNumber?: number }> = [];
    const model: ScriptModelAdapter = {
      async complete(request) {
        calls.push({ node: request.node, episodeNumber: request.episodeNumber });
        if (request.node === 'episode_outline') {
          return JSON.stringify({
            outlines: [1, 2].map((episodeNumber) => ({
              episodeNumber,
              title: `第${episodeNumber}集`,
              goal: '取得证据',
              conflict: '对方阻止调查',
              beats: ['发现线索', '遭遇阻止'],
              characterIds: ['lead'],
              plannedScenes: [],
              endingHook: '新证人出现',
              requiredFacts: [],
              forbiddenFacts: [],
            })),
          });
        }
        if (request.node === 'scene_plan') {
          return JSON.stringify({
            plannedScenes: [
              {
                ordinal: 1,
                location: '校报社',
                timeOfDay: 'day',
                interiorExterior: 'interior',
                purpose: '推进调查',
              },
            ],
          });
        }
        if (request.node === 'draft') {
          return JSON.stringify({
            episodeNumber: request.episodeNumber,
            title: `第${request.episodeNumber}集`,
            scenes: [
              {
                ordinal: 1,
                location: '校报社',
                timeOfDay: 'day',
                interiorExterior: 'interior',
                characterIds: ['lead'],
                blocks: [{ type: 'action', text: '剧情'.repeat(150) }],
              },
            ],
            summary: '',
            newFacts: [],
            openedThreads: [],
            closedThreads: [],
          });
        }
        if (request.node === 'review') {
          return JSON.stringify({
            issues: [],
            summary: '沈清继续调查。',
            newFacts: ['沈清找到新线索'],
            openedThreads: ['新证人是谁'],
            closedThreads: [],
            wardrobe: [{ characterId: 'lead', outfit: '白衬衫与黑色长裤' }],
          });
        }
        throw new Error('unexpected node');
      },
    };
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const progress: string[] = [];
    const director = new ScriptDirector({ model, store, checkpoints });

    const result = await director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 2,
      expectedPlanRevision: 1,
      onProgress: (event) => progress.push(event.scriptCheckpoint.node),
    });

    expect(result.kind).toBe('episode_batch');
    expect(store.state.episodes.map((item) => item.status)).toEqual(['completed', 'completed']);
    expect(store.state.continuity.wardrobeLedger).toHaveLength(2);
    expect(progress).toContain('completed');
    expect(calls.filter((call) => call.node === 'draft')).toHaveLength(2);

    const callCount = calls.length;
    await director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 2,
      expectedPlanRevision: store.state.plan?.revision ?? 2,
    });
    expect(calls).toHaveLength(callCount);
  });
});
