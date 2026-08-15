import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  ScriptCharacter,
  ScriptCommitEpisodeWithContinuityInput,
  ScriptCommitEpisodeWithContinuityResult,
  ScriptContinuityState,
  ScriptEpisode,
  ScriptEpisodeOutline,
  ScriptPlan,
  ScriptProjectState,
  ScriptReviewIssue,
  ScriptReviewSource,
  ScriptSeriesOutline,
  ScriptWorldBible,
} from '../domain.js';
import { FileScriptStore } from '../FileScriptStore.js';
import { buildScriptInputRevisionRefs } from '../ScriptContinuityCommit.js';
import { ScriptConflictError, type ScriptStore } from '../ScriptStore.js';
import { computeScriptCheckpointInputFingerprint } from './ScriptCheckpoint.js';
import {
  InMemoryScriptCheckpointStore,
  ScriptBatchPausedError,
  ScriptDirector,
  ScriptStructuredNeedsReviewError,
  type ScriptModelAdapter,
} from './ScriptDirector.js';

class MemoryScriptStore implements ScriptStore {
  readonly saveEpisodeCalls: ScriptEpisode[] = [];
  readonly atomicCommitCalls: ScriptCommitEpisodeWithContinuityInput[] = [];

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
    this.saveEpisodeCalls.push(structuredClone(value));
    const saved = { ...value, revision: value.revision + 1 };
    this.state.episodes = [
      ...this.state.episodes.filter((item) => item.episodeNumber !== saved.episodeNumber),
      saved,
    ];
    return structuredClone(saved);
  }

  async commitEpisodeWithContinuity(
    input: ScriptCommitEpisodeWithContinuityInput,
  ): Promise<ScriptCommitEpisodeWithContinuityResult> {
    this.atomicCommitCalls.push(structuredClone(input));
    const current = this.state.episodes.find(
      (item) => item.episodeNumber === input.episode.episodeNumber,
    );
    if ((current?.revision ?? 0) !== input.expectedEpisodeRevision) {
      throw new ScriptConflictError(input.expectedEpisodeRevision, current?.revision ?? 0);
    }
    if (this.state.reviewRevision !== input.expectedReviewRevision) {
      throw new ScriptConflictError(input.expectedReviewRevision, this.state.reviewRevision);
    }
    const currentInputRevisionRefs = buildScriptInputRevisionRefs(
      this.state,
      input.episode.episodeNumber,
    );
    for (const reference of input.inputRevisionRefs) {
      const actualRevision = currentInputRevisionRefs.find((candidate) =>
        candidate.resource === reference.resource && candidate.id === reference.id,
      )?.revision ?? 0;
      if (actualRevision !== reference.revision) {
        throw new ScriptConflictError(reference.revision, actualRevision);
      }
    }
    const updatedAt = '2026-08-15T12:00:00.000Z';
    const episode = {
      ...structuredClone(input.episode),
      status: 'completed' as const,
      revision: (current?.revision ?? 0) + 1,
      updatedAt,
    };
    this.state.episodes = [
      ...this.state.episodes.filter((item) => item.episodeNumber !== episode.episodeNumber),
      episode,
    ].sort((left, right) => left.episodeNumber - right.episodeNumber);
    for (const commit of this.state.continuityCommits ?? []) {
      if (commit.episodeNumber === episode.episodeNumber && commit.status === 'current') {
        commit.status = 'stale';
        commit.updatedAt = updatedAt;
      }
    }
    const previous = (this.state.continuityCommits ?? [])
      .filter((commit) =>
        commit.status === 'current' && commit.episodeNumber === episode.episodeNumber - 1,
      )
      .sort((left, right) => right.revision - left.revision)[0];
    const continuity = {
      ...structuredClone(input.continuity),
      id: `continuity-${episode.episodeNumber}-${this.atomicCommitCalls.length}`,
      schemaVersion: 1 as const,
      projectId: this.state.projectId,
      episodeNumber: episode.episodeNumber,
      episodeRevision: episode.revision,
      revision: Math.max(0, ...(this.state.continuityCommits ?? []).map((item) => item.revision)) + 1,
      status: 'current' as const,
      inputFingerprint: input.inputFingerprint,
      ...(previous
        ? {
            previousContinuityCommitId: previous.id,
            previousContinuityRevision: previous.revision,
          }
        : {}),
      createdAt: updatedAt,
      updatedAt,
    };
    (this.state.continuityCommits ??= []).push(continuity);
    return structuredClone({ episode, continuity });
  }

  async saveContinuity(
    _projectId: string,
    value: ScriptContinuityState,
  ): Promise<ScriptContinuityState> {
    this.state.continuity = structuredClone(value);
    return structuredClone(value);
  }

  async saveReviewIssues(
    _projectId: string,
    items: ScriptReviewIssue[],
  ): Promise<{ revision: number; items: ScriptReviewIssue[] }> {
    this.state.reviewRevision += 1;
    this.state.reviewIssues = structuredClone(items);
    return { revision: this.state.reviewRevision, items: structuredClone(items) };
  }

  async replaceEpisodeReviewIssues(
    projectId: string,
    episodeNumber: number,
    sources: readonly ScriptReviewSource[],
    items: ScriptReviewIssue[],
  ): Promise<{ revision: number; items: ScriptReviewIssue[] }> {
    const sourceSet = new Set(sources);
    return this.saveReviewIssues(projectId, [
      ...this.state.reviewIssues.filter(
        (item) => item.episodeNumber !== episodeNumber || !sourceSet.has(item.source),
      ),
      ...items,
    ]);
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
    reviewRevision: 0,
    reviewIssues: [],
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

function readySingleEpisodeState(): ScriptProjectState {
  const state = emptyState();
  state.plan = approvedPlan(1);
  state.seriesOutline = {
    projectId: 'project-1',
    synopsis: '调查真相。',
    openingState: '受压制。',
    midpointTurn: '证人倒戈。',
    climax: '直播证据。',
    endingState: '制度改变。',
    mainArc: ['调查'],
    subplotArcs: [],
    episodeCards: [{
      episodeNumber: 1,
      title: '第一集',
      logline: '推进调查。',
      mainEvent: '取得证据。',
      endingHook: '新线索。',
    }],
    revision: 1,
  };
  state.characters = [{
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
  }];
  state.worldBible = {
    projectId: 'project-1',
    era: '2026年',
    primaryLocations: ['校报社'],
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
  state.episodeOutlines = [{
    id: 'outline-1',
    projectId: 'project-1',
    episodeNumber: 1,
    title: '第一集',
    goal: '取得证据',
    conflict: '对方阻止调查',
    beats: ['发现线索', '遭遇阻止'],
    characterIds: ['lead'],
    plannedScenes: [{
      ordinal: 1,
      location: '校报社',
      timeOfDay: 'day',
      interiorExterior: 'interior',
      purpose: '推进调查',
    }],
    endingHook: '新证人出现',
    requiredFacts: [],
    forbiddenFacts: [],
    status: 'approved',
    revision: 1,
  }];
  return state;
}

function reviewingEpisode(
  state: ScriptProjectState,
  text: string,
  options: {
    title?: string;
    revision?: number;
    blockTextPrefix?: string;
  } = {},
): ScriptEpisode {
  return {
    id: 'candidate-episode-1',
    projectId: state.projectId,
    episodeNumber: 1,
    title: options.title ?? '第一集',
    outlineId: 'outline-1',
    status: 'reviewing',
    targetChars: state.plan?.targetCharsPerEpisode ?? 300,
    scenes: [{
      id: 'candidate-scene-1',
      ordinal: 1,
      location: '校报社',
      timeOfDay: 'day',
      interiorExterior: 'interior',
      characterIds: ['lead'],
      blocks: [{
        id: 'candidate-block-1',
        type: 'action',
        text: `${options.blockTextPrefix ?? ''}${text}`,
      }],
    }],
    summary: '',
    newFacts: [],
    openedThreads: [],
    closedThreads: [],
    revision: options.revision ?? 0,
    createdAt: state.updatedAt,
    updatedAt: state.updatedAt,
  };
}

function balancedDraftBlocks(totalChars = 300) {
  const dialogueChars = Math.round(totalChars * 0.6);
  return [
    { type: 'action' as const, text: '动'.repeat(totalChars - dialogueChars) },
    {
      type: 'dialogue' as const,
      characterId: 'lead',
      speaker: '沈清',
      text: '话'.repeat(dialogueChars),
    },
  ];
}

describe('ScriptDirector', () => {
  it('summarizes only blocking issues and puts revision rejection first', () => {
    const ordinaryBlocking = {
      code: 'TOO_SHORT', severity: 'hard' as const, source: 'deterministic' as const,
      blocking: true, message: '正文偏短。', path: 'scenes',
    };
    const revisionRejected = {
      code: 'REVISION_PATCH_REJECTED', severity: 'hard' as const,
      source: 'deterministic' as const, blocking: true,
      message: '补丁越权。', path: 'revision.operations',
    };
    const nonBlockingHard = {
      code: 'AI_HARD_ADVISORY', severity: 'hard' as const, source: 'ai' as const,
      blocking: false, message: '不得出现在暂停摘要。', path: 'scenes',
    };

    const error = new ScriptBatchPausedError(3, {
      hardFailed: true,
      issues: [nonBlockingHard, ordinaryBlocking, revisionRejected],
      blockingIssues: [ordinaryBlocking, revisionRejected],
      advisoryIssues: [nonBlockingHard],
      visibleChars: 200,
      dialogueDensityPercent: 50,
    });

    expect(error.message).toContain('REVISION_PATCH_REJECTED：补丁越权。；TOO_SHORT：正文偏短。');
    expect(error.message).not.toContain('AI_HARD_ADVISORY');
    expect(error.message).not.toContain('不得出现在暂停摘要');
  });

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

  it('routes a structurally incomplete plan through one fixup before saving it', async () => {
    let calls = 0;
    const director = new ScriptDirector({
      model: {
        async complete() {
          calls += 1;
          const value = { ...approvedPlan(), theme: calls === 1 ? undefined : '拒绝沉默' };
          return JSON.stringify(value);
        },
      },
      store: new MemoryScriptStore(emptyState()),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({
      task: 'script_plan', projectId: 'project-1',
      planningSession: {
        values: {
          genres: ['校园青春'], coreConflict: '调查真相', audience: '女性观众',
          totalEpisodes: 10, episodeDurationSeconds: { min: 60, max: 90 },
          targetCharsPerEpisode: 1_000, maxScenesPerEpisode: 3,
          dialogueDensityPercent: 60, endingDirection: '真相公开',
        },
        delegatedFields: [], askedFields: [], questionCount: 0,
      },
    })).resolves.toMatchObject({ kind: 'plan_draft' });
    expect(calls).toBe(2);
  });

  it('returns recoverable needs-review when plan fixup exhausts without fallback', async () => {
    let calls = 0;
    const director = new ScriptDirector({
      model: { async complete() { calls += 1; return '{}'; } },
      store: new MemoryScriptStore(emptyState()),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({
      task: 'script_plan', projectId: 'project-1',
      planningSession: {
        values: {
          genres: ['校园青春'], coreConflict: '调查真相', audience: '女性观众',
          totalEpisodes: 10, episodeDurationSeconds: { min: 60, max: 90 },
          targetCharsPerEpisode: 1_000, maxScenesPerEpisode: 3,
          dialogueDensityPercent: 60, endingDirection: '真相公开',
        },
        delegatedFields: [], askedFields: [], questionCount: 0,
      },
    })).rejects.toMatchObject({
      code: 'SCRIPT_STRUCTURED_NEEDS_REVIEW', recoverable: true, node: 'plan',
    });
    expect(calls).toBe(2);
  });

  it('does not overwrite a plan edited while the model is generating', async () => {
    const root = await mkdtemp(join(tmpdir(), 'script-director-conflict-'));
    try {
      const store = await FileScriptStore.create(root);
      let releaseModel!: () => void;
      let markModelStarted!: () => void;
      const modelStarted = new Promise<void>((resolve) => {
        markModelStarted = resolve;
      });
      const modelGate = new Promise<void>((resolve) => {
        releaseModel = resolve;
      });
      const model: ScriptModelAdapter = {
        async complete() {
          markModelStarted();
          await modelGate;
          return JSON.stringify(approvedPlan());
        },
      };
      const director = new ScriptDirector({
        model,
        store,
        checkpoints: new InMemoryScriptCheckpointStore(),
      });
      const generation = director.run({
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

      await modelStarted;
      await store.savePlan({ ...approvedPlan(), title: '用户刚刚修改的标题' }, 0);
      releaseModel();

      await expect(generation).rejects.toBeInstanceOf(ScriptConflictError);
      await expect(store.getProjectState('project-1')).resolves.toMatchObject({
        plan: { title: '用户刚刚修改的标题', revision: 1 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not write a formally generated plan after its request is cancelled', async () => {
    const controller = new AbortController();
    const store = new MemoryScriptStore(emptyState());
    const director = new ScriptDirector({
      model: {
        async complete() {
          controller.abort();
          return JSON.stringify(approvedPlan());
        },
      },
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({
      task: 'script_plan',
      projectId: 'project-1',
      planningSession: {
        values: {
          genres: ['校园青春'], coreConflict: '调查真相', audience: '女性观众',
          totalEpisodes: 10, episodeDurationSeconds: { min: 60, max: 90 },
          targetCharsPerEpisode: 1_000, maxScenesPerEpisode: 3,
          dialogueDensityPercent: 60, endingDirection: '真相公开',
        },
        delegatedFields: [], askedFields: [], questionCount: 0,
      },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.state.plan).toBeUndefined();
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

  it('fixes only a missing hairstyle before saving the character bible', async () => {
    const state = readySingleEpisodeState();
    const [completeCharacter] = state.characters;
    if (!completeCharacter) throw new Error('fixture character missing');
    state.characters = [];
    const { hairstyle: _hairstyle, projectId: _projectId, revision: _revision, updatedAt: _updatedAt, ...missingHairstyle } = completeCharacter;
    const prompts: string[] = [];
    const model: ScriptModelAdapter = {
      async complete(request) {
        if (request.node !== 'character_bible') throw new Error('unexpected node');
        prompts.push(request.prompt);
        return JSON.stringify({
          characters: [prompts.length === 1
            ? missingHairstyle
            : { ...missingHairstyle, hairstyle: '齐肩短发' }],
        });
      },
    };
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      model,
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    const result = await director.run({ task: 'script_bible', projectId: 'project-1' });

    expect(result.kind).toBe('bible');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('path=$.characters[0].hairstyle');
    expect(store.state.characters[0]?.hairstyle).toBe('齐肩短发');
  });

  it('maps an exhausted structured node without fallback to a recoverable review error', async () => {
    const state = readySingleEpisodeState();
    state.characters = [];
    let calls = 0;
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          if (request.node !== 'character_bible') throw new Error('unexpected node');
          calls += 1;
          return JSON.stringify({ characters: [] });
        },
      },
      store: new MemoryScriptStore(state),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    const generation = director.run({ task: 'script_bible', projectId: 'project-1' });

    await expect(generation).rejects.toMatchObject({
      code: 'SCRIPT_STRUCTURED_NEEDS_REVIEW',
      recoverable: true,
      node: 'character_bible',
    });
    await expect(generation).rejects.toBeInstanceOf(ScriptStructuredNeedsReviewError);
    expect(calls).toBe(2);
  });

  it('still completes and checkpoints the world bible when the character bible needs review', async () => {
    const state = readySingleEpisodeState();
    const [base] = state.characters;
    if (!base) throw new Error('fixture character missing');
    const valid = { ...base, projectId: undefined, revision: undefined, updatedAt: undefined };
    const invalid = { ...valid, id: 'witness', name: '证人', hairstyle: undefined };
    state.characters = [];
    state.worldBible = undefined;
    const calls: string[] = [];
    const checkpoints = new InMemoryScriptCheckpointStore();
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          calls.push(request.node);
          if (request.node === 'character_bible') {
            return JSON.stringify({ characters: [valid, invalid] });
          }
          if (request.node === 'world_bible') {
            return JSON.stringify({
              era: '2026年', primaryLocations: ['校报社'], worldState: '当代校园。',
              rules: [], transport: [], communication: ['手机'], organizations: ['校报社'],
              recurringProps: ['录音笔'], forbiddenAnachronisms: [],
            });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
      store,
      checkpoints,
    });

    await expect(director.run({ task: 'script_bible', projectId: 'project-1' }))
      .rejects.toBeInstanceOf(ScriptStructuredNeedsReviewError);

    expect(calls.filter((node) => node === 'character_bible')).toHaveLength(2);
    expect(calls.filter((node) => node === 'world_bible')).toHaveLength(1);
    expect(store.state.worldBible).toMatchObject({ era: '2026年' });
    await expect(checkpoints.list('project-1', 'script_bible')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node: 'character_bible',
          status: 'needs_review',
          artifact: expect.objectContaining({
            validCharacters: [expect.objectContaining({ id: 'lead', name: '沈清' })],
            failedCharacterIndexes: [1],
          }),
        }),
        expect.objectContaining({ node: 'world_bible', status: 'succeeded' }),
      ]),
    );
  });

  it('uses one bounded character workflow and ignores rewrites of already-valid characters', async () => {
    const state = readySingleEpisodeState();
    const [base] = state.characters;
    if (!base) throw new Error('fixture character missing');
    state.characters = [];
    const valid = {
      ...base,
      projectId: undefined,
      revision: undefined,
      updatedAt: undefined,
    };
    const invalid = {
      ...valid,
      id: 'witness',
      name: '证人',
      role: 'supporting',
      relationships: [],
      hairstyle: undefined,
    };
    let calls = 0;
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          if (request.node !== 'character_bible') throw new Error('unexpected node');
          calls += 1;
          return calls === 1
            ? JSON.stringify({ characters: [valid, invalid] })
            : JSON.stringify({ characters: [
                { ...valid, name: '不应覆盖的改名' },
                { ...invalid, hairstyle: '齐肩短发' },
              ] });
        },
      },
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({ task: 'script_bible', projectId: 'project-1' }))
      .resolves.toMatchObject({ kind: 'bible' });
    expect(calls).toBe(2);
    expect(store.state.characters.map((character) => character.name)).toEqual(['沈清', '证人']);
    expect(store.state.characters[1]?.hairstyle).toBe('齐肩短发');
  });

  it('caps character generation at primary, targeted fixup, and one configured fallback', async () => {
    const state = readySingleEpisodeState();
    const [base] = state.characters;
    if (!base) throw new Error('fixture character missing');
    state.characters = [];
    let calls = 0;
    const director = new ScriptDirector({
      model: {
        async getStructuredFallbackModelName() { return 'fallback-model'; },
        async complete(request) {
          if (request.node !== 'character_bible') throw new Error('unexpected node');
          calls += 1;
          if (request.modelNameOverride === 'fallback-model') {
            return JSON.stringify({ characters: [{
              ...base, projectId: undefined, revision: undefined, updatedAt: undefined,
            }] });
          }
          return JSON.stringify({ characters: [] });
        },
      },
      store: new MemoryScriptStore(state),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({ task: 'script_bible', projectId: 'project-1' }))
      .resolves.toMatchObject({ kind: 'bible' });
    expect(calls).toBe(3);
  });

  it('regenerates a rejected character candidate against the latest plan on explicit resume', async () => {
    const state = readySingleEpisodeState();
    const [base] = state.characters;
    if (!base || !state.plan) throw new Error('fixture character or plan missing');
    state.characters = [];
    state.plan = { ...state.plan, maxPrimaryCharacters: 4 };
    const generatedCharacters = Array.from({ length: 5 }, (_, index) => ({
      ...base,
      id: `character-${index + 1}`,
      name: `人物${index + 1}`,
      role: index === 0 ? 'lead' as const : 'supporting' as const,
      projectId: undefined,
      revision: undefined,
      updatedAt: undefined,
      relationships: [],
    }));
    let characterCalls = 0;
    const checkpoints = new InMemoryScriptCheckpointStore();
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node !== 'character_bible') throw new Error('unexpected node');
          characterCalls += 1;
          return JSON.stringify({ characters: generatedCharacters });
        },
      },
    });

    await expect(director.run({ task: 'script_bible', projectId: 'project-1' }))
      .rejects.toBeInstanceOf(ScriptStructuredNeedsReviewError);
    expect(characterCalls).toBe(2);
    expect(store.state.characters).toEqual([]);

    store.state.plan = {
      ...store.state.plan!,
      maxPrimaryCharacters: 5,
      revision: store.state.plan!.revision + 1,
    };
    await expect(director.run({
      task: 'script_bible',
      projectId: 'project-1',
      resumeRejectedCandidates: true,
    })).resolves.toMatchObject({ kind: 'bible' });

    expect(characterCalls).toBe(3);
    expect(store.state.characters).toHaveLength(5);
    const history = await checkpoints.list('project-1', 'script_bible');
    expect(history.filter((checkpoint) => checkpoint.node === 'character_bible'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'stale', artifactRevision: 0 }),
        expect.objectContaining({ status: 'succeeded', artifactRevision: 1 }),
      ]));
    const fingerprints = history
      .filter((checkpoint) => checkpoint.node === 'character_bible')
      .map((checkpoint) => checkpoint.inputFingerprint);
    expect(new Set(fingerprints).size).toBe(2);
  });

  it.each(['issues', 'newFacts', 'openedThreads', 'closedThreads', 'wardrobe'] as const)(
    'requires review.%s explicitly and repairs the missing array before committing',
    async (missingField) => {
      const state = readySingleEpisodeState();
      let reviewCalls = 0;
      const completeReview = {
        issues: [], summary: '沈清完成录音证据核验。', newFacts: [],
        openedThreads: [], closedThreads: [], wardrobe: [],
      };
      const director = new ScriptDirector({
        model: {
          async complete(request) {
            if (request.node === 'draft') {
              return JSON.stringify({
                episodeNumber: 1, title: '第一集',
                scenes: [{
                  ordinal: 1, location: '校报社', timeOfDay: 'day',
                  interiorExterior: 'interior', characterIds: ['lead'],
                  blocks: balancedDraftBlocks(),
                }],
                summary: '', newFacts: [], openedThreads: [], closedThreads: [],
              });
            }
            if (request.node === 'review') {
              reviewCalls += 1;
              if (reviewCalls === 1) {
                const incomplete = { ...completeReview } as Record<string, unknown>;
                delete incomplete[missingField];
                return JSON.stringify(incomplete);
              }
              return JSON.stringify(completeReview);
            }
            throw new Error(`unexpected node: ${request.node}`);
          },
        },
        store: new MemoryScriptStore(state),
        checkpoints: new InMemoryScriptCheckpointStore(),
      });

      await expect(director.run({
        task: 'script_episode_batch', projectId: 'project-1',
        startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      })).resolves.toMatchObject({ kind: 'episode_batch' });
      expect(reviewCalls).toBe(2);
    },
  );

  it('fixes a missing review summary and otherwise keeps the episode flow unchanged', async () => {
    const state = readySingleEpisodeState();
    const reviewPrompts: string[] = [];
    const model: ScriptModelAdapter = {
      async complete(request) {
        if (request.node === 'draft') {
          return JSON.stringify({
            episodeNumber: 1,
            title: '第一集',
            scenes: [{
              ordinal: 1,
              location: '校报社',
              timeOfDay: 'day',
              interiorExterior: 'interior',
              characterIds: ['lead'],
              blocks: balancedDraftBlocks(),
            }],
            summary: '',
            newFacts: [],
            openedThreads: [],
            closedThreads: [],
          });
        }
        if (request.node === 'review') {
          reviewPrompts.push(request.prompt);
          return JSON.stringify({
            issues: [],
            ...(reviewPrompts.length > 1 ? { summary: '沈清完成录音证据核验。' } : {}),
            newFacts: [],
            openedThreads: [],
            closedThreads: [],
            wardrobe: [],
          });
        }
        throw new Error('unexpected node');
      },
    };
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      model,
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    const result = await director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
    });

    expect(result.kind).toBe('episode_batch');
    expect(reviewPrompts).toHaveLength(2);
    expect(reviewPrompts[1]).toContain('path=$.summary');
    expect(store.state.episodes[0]?.summary).toBe('沈清完成录音证据核验。');
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
    const calls: Array<{ node: string; episodeNumber?: number; prompt: string }> = [];
    const model: ScriptModelAdapter = {
      async complete(request) {
        calls.push({ node: request.node, episodeNumber: request.episodeNumber, prompt: request.prompt });
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
                blocks: balancedDraftBlocks(),
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
      onProgress: (event) => {
        progress.push(event.scriptCheckpoint.node);
      },
    });

    expect(result.kind).toBe('episode_batch');
    expect(store.state.episodes.map((item) => item.status)).toEqual(['completed', 'completed']);
    expect(store.state.continuityCommits).toEqual([
      expect.objectContaining({ episodeNumber: 1, status: 'current' }),
      expect.objectContaining({
        episodeNumber: 2,
        status: 'current',
        previousContinuityCommitId: expect.any(String),
      }),
    ]);
    expect(store.atomicCommitCalls).toHaveLength(2);
    expect(store.saveEpisodeCalls).toHaveLength(0);
    expect(store.state.reviewRevision).toBe(2);
    expect(store.state.reviewIssues.some((issue) => issue.code === 'DIALOGUE_DENSITY'))
      .toBe(false);
    expect(progress).toContain('completed');
    expect(calls.filter((call) => call.node === 'draft')).toHaveLength(2);
    expect(calls.find(
      (call) => call.node === 'draft' && call.episodeNumber === 2,
    )?.prompt).toContain('沈清找到新线索');

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

  it('repairs non-consecutive scene ordinals before persisting the planned scenes', async () => {
    const state = readySingleEpisodeState();
    state.episodeOutlines[0] = { ...state.episodeOutlines[0]!, plannedScenes: [] };
    let scenePlanCalls = 0;
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          if (request.node === 'scene_plan') {
            scenePlanCalls += 1;
            return JSON.stringify({ plannedScenes: [{
              ordinal: scenePlanCalls === 1 ? 2 : 1,
              location: '校报社', timeOfDay: 'day', interiorExterior: 'interior',
              purpose: '推进调查',
            }] });
          }
          if (request.node === 'draft') {
            return JSON.stringify({
              episodeNumber: 1, title: '第一集',
              scenes: [{
                ordinal: 1, location: '校报社', timeOfDay: 'day',
                interiorExterior: 'interior', characterIds: ['lead'],
                blocks: balancedDraftBlocks(),
              }],
              summary: '', newFacts: [], openedThreads: [], closedThreads: [],
            });
          }
          if (request.node === 'review') {
            return JSON.stringify({
              issues: [], summary: '沈清继续调查。', newFacts: [],
              openedThreads: [], closedThreads: [], wardrobe: [],
            });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
    })).resolves.toMatchObject({ kind: 'episode_batch' });
    expect(scenePlanCalls).toBe(2);
    expect(store.state.episodeOutlines[0]?.plannedScenes.map((scene) => scene.ordinal))
      .toEqual([1]);
  });

  it('stales draft and review lineage after the scene plan changes', async () => {
    const state = readySingleEpisodeState();
    state.reviewRevision = 1;
    state.reviewIssues = [{
      id: 'temporary-user-blocker',
      projectId: state.projectId,
      episodeNumber: 1,
      code: 'USER_TEMPORARY_BLOCKER',
      severity: 'hard',
      category: 'continuity',
      message: '先暂停提交，以便验证场景计划变更后的检查点血缘。',
      status: 'open',
      source: 'user',
      createdAt: state.updatedAt,
      updatedAt: state.updatedAt,
    }];
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            return JSON.stringify({
              episodeNumber: 1, title: '第一集',
              scenes: [{
                ordinal: 1, location: '校报社', timeOfDay: 'day',
                interiorExterior: 'interior', characterIds: ['lead'],
                blocks: balancedDraftBlocks(),
              }],
              summary: '', newFacts: [], openedThreads: [], closedThreads: [],
            });
          }
          if (request.node === 'review') {
            return JSON.stringify({
              issues: [], summary: '沈清继续推进调查。', newFacts: [],
              openedThreads: [], closedThreads: [], wardrobe: [],
            });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });
    const request = {
      task: 'script_episode_batch' as const,
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
    };

    await expect(director.run(request)).rejects.toBeInstanceOf(ScriptBatchPausedError);
    const firstHistory = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    expect(firstHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ node: 'draft', status: 'succeeded' }),
      expect.objectContaining({ node: 'review', chunkStart: 1, status: 'succeeded' }),
    ]));

    const currentOutline = store.state.episodeOutlines[0]!;
    store.state.episodeOutlines[0] = {
      ...currentOutline,
      revision: currentOutline.revision + 1,
      plannedScenes: [{
        ...currentOutline.plannedScenes[0]!,
        location: '校报社直播间',
        purpose: '改为直播公开证据',
      }],
    };
    store.state.reviewIssues = [];
    store.state.reviewRevision += 1;
    await expect(director.run({
      ...request,
      expectedPlanRevision: store.state.plan!.revision,
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    const history = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    for (const selector of [
      { node: 'scene_plan' },
      { node: 'draft' },
      { node: 'review', chunkStart: 1 },
    ] as const) {
      const lineage = history.filter((checkpoint) =>
        checkpoint.node === selector.node &&
        ('chunkStart' in selector ? checkpoint.chunkStart === selector.chunkStart : true));
      expect(lineage.some((checkpoint) => checkpoint.status === 'stale')).toBe(true);
      expect(lineage.some((checkpoint) => checkpoint.status === 'succeeded')).toBe(true);
      expect(new Set(lineage.map((checkpoint) => checkpoint.artifactRevision)).size)
        .toBe(lineage.length);
    }
  });

  it('stales an episode-draft-v2 checkpoint after the v3 prompt upgrade', async () => {
    const state = readySingleEpisodeState();
    let draftCalls = 0;
    const store = new MemoryScriptStore(state);
    const model: ScriptModelAdapter = {
      async complete(request) {
        if (request.node === 'draft') {
          draftCalls += 1;
          return JSON.stringify({
            episodeNumber: 1,
            title: '第一集',
            scenes: [{
              ordinal: 1,
              location: '校报社',
              timeOfDay: 'day',
              interiorExterior: 'interior',
              characterIds: ['lead'],
              blocks: balancedDraftBlocks(),
            }],
            summary: '', newFacts: [], openedThreads: [], closedThreads: [],
          });
        }
        if (request.node === 'review') {
          return JSON.stringify({
            issues: [], summary: '沈清取得证据并继续调查。', newFacts: [],
            openedThreads: [], closedThreads: [], wardrobe: [],
          });
        }
        throw new Error(`unexpected node: ${request.node}`);
      },
    };
    const sourceCheckpoints = new InMemoryScriptCheckpointStore();
    const sourceDirector = new ScriptDirector({ store, checkpoints: sourceCheckpoints, model });
    const request = {
      task: 'script_episode_batch' as const,
      projectId: state.projectId,
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: state.plan!.revision,
    };

    await expect(sourceDirector.run(request)).resolves.toMatchObject({ kind: 'episode_batch' });
    const sourceHistory = await sourceCheckpoints.list(
      state.projectId,
      'script_episode_batch:1:1',
    );
    const sourceScenePlan = sourceHistory.find((checkpoint) =>
      checkpoint.node === 'scene_plan' && checkpoint.status === 'succeeded');
    const sourceDraft = sourceHistory.find((checkpoint) =>
      checkpoint.node === 'draft' && checkpoint.status === 'succeeded');
    expect(sourceScenePlan).toBeDefined();
    expect(sourceDraft).toBeDefined();
    if (!sourceScenePlan || !sourceDraft) throw new Error('source checkpoints missing');

    // Seed a reusable checkpoint whose only lineage difference is the old prompt version.
    const legacyInputFingerprint = computeScriptCheckpointInputFingerprint({
      node: sourceDraft.node,
      inputRevisionRefs: sourceDraft.inputRevisionRefs,
      upstreamArtifactRefs: sourceDraft.upstreamArtifactRefs,
      promptVersion: 'episode-draft-v2',
      configRevision: sourceDraft.configRevision,
    });
    const checkpoints = new InMemoryScriptCheckpointStore();
    await checkpoints.save(sourceScenePlan);
    await checkpoints.save({
      ...sourceDraft,
      artifact: {
        ...(sourceDraft.artifact as Record<string, unknown>),
        promptVersion: 'episode-draft-v2',
        inputFingerprint: legacyInputFingerprint,
      },
      promptVersion: 'episode-draft-v2',
      inputFingerprint: legacyInputFingerprint,
    });

    store.state.episodes = [];
    store.state.continuityCommits = [];
    store.state.reviewIssues = [];
    draftCalls = 0;
    const director = new ScriptDirector({ store, checkpoints, model });

    await expect(director.run({
      ...request,
      expectedPlanRevision: store.state.plan!.revision,
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect(draftCalls).toBe(1);
    const draftHistory = (await checkpoints.list(state.projectId, 'script_episode_batch:1:1'))
      .filter((checkpoint) => checkpoint.node === 'draft');
    expect(draftHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifactRevision: 0, promptVersion: 'episode-draft-v2', status: 'stale',
      }),
      expect.objectContaining({
        artifactRevision: 1, promptVersion: 'episode-draft-v3', status: 'succeeded',
      }),
    ]));
  });

  it('persists an AI hard finding as advisory without rewriting or blocking completion', async () => {
    const state = readySingleEpisodeState();
    let reviewCalls = 0;
    let revisionCalls = 0;
    const episodePayload = {
      episodeNumber: 1,
      title: '第一集',
      scenes: [{
        ordinal: 1,
        location: '校报社',
        timeOfDay: 'day',
        interiorExterior: 'interior',
        characterIds: ['lead'],
        blocks: balancedDraftBlocks(),
      }],
      summary: '',
      newFacts: [],
      openedThreads: [],
      closedThreads: [],
    };
    const model: ScriptModelAdapter = {
      async complete(request) {
        if (request.node === 'draft') return JSON.stringify(episodePayload);
        if (request.node === 'revision') {
          revisionCalls += 1;
          return JSON.stringify(episodePayload);
        }
        if (request.node === 'review') {
          reviewCalls += 1;
          return JSON.stringify({
            issues: [{
              code: 'AI_CHARACTER_LOGIC',
              severity: 'hard',
              message: '人物动机仍与上一集冲突。',
              path: 'summary',
            }],
            summary: '沈清继续调查。',
            newFacts: [],
            openedThreads: [],
            closedThreads: [],
            wardrobe: [],
          });
        }
        throw new Error(`unexpected node: ${request.node}`);
      },
    };
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      model,
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    const result = await director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
    });

    expect(result.kind).toBe('episode_batch');
    expect(reviewCalls).toBe(1);
    expect(revisionCalls).toBe(0);
    expect(store.state.episodes[0]?.status).toBe('completed');
    expect(store.state.reviewIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AI_CHARACTER_LOGIC',
        severity: 'hard',
        source: 'ai',
        status: 'open',
      }),
    ]));
  });

  it('rewrites a 515-char 1200-target draft as a complete episode before review', async () => {
    const state = readySingleEpisodeState();
    state.plan = { ...state.plan!, targetCharsPerEpisode: 1_200, dialogueDensityPercent: 60 };
    state.characters.push({
      ...structuredClone(state.characters[0]!),
      id: 'witness',
      name: '证人',
    });
    const draftPrompts: string[] = [];
    let draftCalls = 0;
    let reviewCalls = 0;
    let revisionCalls = 0;
    const draftPayload = (
      actionChars: number,
      dialogueChars: number,
      characterIds: string[],
    ) => ({
      episodeNumber: 1,
      title: '第一集',
      scenes: [{
        ordinal: 1,
        location: '校报社',
        timeOfDay: 'day',
        interiorExterior: 'interior',
        characterIds,
        blocks: [
          { type: 'action', text: '动'.repeat(actionChars) },
          {
            type: 'dialogue',
            characterId: 'witness',
            speaker: '证人',
            text: '证'.repeat(dialogueChars),
          },
        ],
      }],
      summary: '',
      newFacts: [],
      openedThreads: [],
      closedThreads: [],
    });
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            draftCalls += 1;
            draftPrompts.push(request.prompt);
            return JSON.stringify(draftCalls === 1
              ? draftPayload(500, 15, ['lead'])
              : draftPayload(472, 708, ['lead', 'witness']));
          }
          if (request.node === 'review') {
            reviewCalls += 1;
            return JSON.stringify({
              issues: [],
              summary: '证人带着证据进入校报社，沈清决定继续调查。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            throw new Error('fresh draft fixup must not enter revision');
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch',
      projectId: state.projectId,
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: state.plan.revision,
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect({ draftCalls, reviewCalls, revisionCalls }).toEqual({
      draftCalls: 2,
      reviewCalls: 1,
      revisionCalls: 0,
    });
    expect(draftPrompts[0]).toContain('约包含 30 个');
    expect(draftPrompts[0]).toContain('36—44 个可见字符');
    expect(draftPrompts[0]).toContain('平均每场约 1200 字');
    expect(draftPrompts[0]).toContain('目标约占正文 60%');
    expect(draftPrompts[0]).toContain('episode_draft@v2');
    expect(draftPrompts[1]).toContain('TOO_SHORT');
    expect(draftPrompts[1]).toContain('SPEAKER_NOT_IN_SCENE');
    expect(store.state.episodes[0]?.scenes.flatMap((scene) => scene.blocks)
      .reduce((total, block) => total + block.text.replace(/\s/gu, '').length, 0))
      .toBe(1_180);
    expect(store.state.episodes[0]?.status).toBe('completed');
  });

  it('rewrites a length-valid fresh draft when dialogue density misses by over 15 points', async () => {
    const state = readySingleEpisodeState();
    let draftCalls = 0;
    let reviewCalls = 0;
    const draftPrompts: string[] = [];
    const payload = (dialogueChars: number) => ({
      episodeNumber: 1,
      title: '第一集',
      scenes: [{
        ordinal: 1,
        location: '校报社',
        timeOfDay: 'day',
        interiorExterior: 'interior',
        characterIds: ['lead'],
        blocks: dialogueChars === 0
          ? [{ type: 'action', text: '动'.repeat(300) }]
          : [
              { type: 'action', text: '动'.repeat(300 - dialogueChars) },
              {
                type: 'dialogue', characterId: 'lead', speaker: '沈清',
                text: '话'.repeat(dialogueChars),
              },
            ],
      }],
      summary: '', newFacts: [], openedThreads: [], closedThreads: [],
    });
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            draftCalls += 1;
            draftPrompts.push(request.prompt);
            return JSON.stringify(draftCalls === 1 ? payload(0) : payload(180));
          }
          if (request.node === 'review') {
            reviewCalls += 1;
            return JSON.stringify({
              issues: [], summary: '沈清取得证据并继续调查。', newFacts: [],
              openedThreads: [], closedThreads: [], wardrobe: [],
            });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch', projectId: state.projectId,
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: state.plan!.revision,
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect({ draftCalls, reviewCalls }).toEqual({ draftCalls: 2, reviewCalls: 1 });
    expect(draftPrompts[1]).toContain('DIALOGUE_DENSITY');
    expect(store.state.episodes[0]?.status).toBe('completed');
  });

  it.each(['plan', 'characters'] as const)(
    'atomically rejects a candidate when %s changes while the review model is running',
    async (resource) => {
      const state = readySingleEpisodeState();
      const store = new MemoryScriptStore(state);
      const checkpoints = new InMemoryScriptCheckpointStore();
      let draftRefsObservedAtReview: ScriptCommitEpisodeWithContinuityInput['inputRevisionRefs'] = [];
      let planRevisionAtReviewEntry = 0;
      let externalMutationApplied = false;
      const director = new ScriptDirector({
        store,
        checkpoints,
        model: {
          async complete(request) {
            if (request.node === 'draft') {
              return JSON.stringify({
                episodeNumber: 1,
                title: '第一集',
                scenes: [{
                  ordinal: 1,
                  location: '校报社',
                  timeOfDay: 'day',
                  interiorExterior: 'interior',
                  characterIds: ['lead'],
                  blocks: [
                    { type: 'action', text: '动'.repeat(120) },
                    {
                      type: 'dialogue', characterId: 'lead', speaker: '沈清',
                      text: '话'.repeat(180),
                    },
                  ],
                }],
                summary: '', newFacts: [], openedThreads: [], closedThreads: [],
              });
            }
            if (request.node === 'review') {
              if (!externalMutationApplied) {
                planRevisionAtReviewEntry = store.state.plan!.revision;
                draftRefsObservedAtReview = structuredClone((await checkpoints.list(
                  state.projectId,
                  'script_episode_batch:1:1',
                )).find((checkpoint) => checkpoint.node === 'draft')?.inputRevisionRefs ?? []);
                externalMutationApplied = true;
                if (resource === 'plan') {
                  store.state.plan = {
                    ...store.state.plan!,
                    title: '并发更新后的策划',
                    revision: store.state.plan!.revision + 1,
                  };
                } else {
                  store.state.characters[0] = {
                    ...store.state.characters[0]!,
                    biography: '模型运行期间被外部编辑。',
                    revision: store.state.characters[0]!.revision + 1,
                  };
                }
              }
              return JSON.stringify({
                issues: [], summary: '沈清取得证据并继续调查。', newFacts: [],
                openedThreads: [], closedThreads: [], wardrobe: [],
              });
            }
            throw new Error(`unexpected node: ${request.node}`);
          },
        },
      });

      await expect(director.run({
        task: 'script_episode_batch', projectId: state.projectId,
        startEpisode: 1, episodeCount: 1, expectedPlanRevision: state.plan!.revision,
      })).rejects.toBeInstanceOf(ScriptConflictError);

      expect(store.state.episodes).toEqual([]);
      expect(store.state.continuityCommits ?? []).toEqual([]);
      expect(store.atomicCommitCalls).toHaveLength(1);
      expect(planRevisionAtReviewEntry).toBe(2);
      expect(draftRefsObservedAtReview).toEqual(expect.arrayContaining([
        expect.objectContaining({ resource: 'plan', revision: 2 }),
      ]));
      const draftCheckpoint = (await checkpoints.list(
        state.projectId,
        'script_episode_batch:1:1',
      )).find((checkpoint) => checkpoint.node === 'draft' && checkpoint.status === 'succeeded');
      expect(draftCheckpoint?.inputRevisionRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({ resource: 'plan', revision: 2 }),
      ]));
      const expectedResource = resource === 'plan' ? 'plan' : 'characters';
      expect(store.atomicCommitCalls[0]?.inputRevisionRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          resource: expectedResource,
          revision: resource === 'plan' ? 2 : 1,
        }),
      ]));
    },
  );

  it('stops at draft when primary, fixup, and fallback remain below the hard range', async () => {
    const state = readySingleEpisodeState();
    state.plan = { ...state.plan!, targetCharsPerEpisode: 1_200 };
    const lengths = [515, 656, 693];
    let draftCalls = 0;
    let reviewCalls = 0;
    const checkpoints = new InMemoryScriptCheckpointStore();
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async getStructuredFallbackModelName() { return 'fallback-model'; },
        async complete(request) {
          if (request.node === 'draft') {
            const visibleChars = lengths[draftCalls++] ?? lengths.at(-1)!;
            return JSON.stringify({
              episodeNumber: 1,
              title: '第一集',
              scenes: [{
                ordinal: 1,
                location: '校报社',
                timeOfDay: 'day',
                interiorExterior: 'interior',
                characterIds: ['lead'],
                blocks: [{ type: 'action', text: '短'.repeat(visibleChars) }],
              }],
              summary: '',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
            });
          }
          if (request.node === 'review') {
            reviewCalls += 1;
            throw new Error('invalid draft must not reach review');
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    let rejected: unknown;
    try {
      await director.run({
        task: 'script_episode_batch',
        projectId: state.projectId,
        startEpisode: 1,
        episodeCount: 1,
        expectedPlanRevision: state.plan.revision,
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(ScriptStructuredNeedsReviewError);
    expect(rejected).toMatchObject({ node: 'draft', recoverable: true });
    expect((rejected as Error).message).toContain('TOO_SHORT');
    expect({ draftCalls, reviewCalls }).toEqual({ draftCalls: 3, reviewCalls: 0 });
    expect(store.state.episodes).toEqual([]);
    expect((await checkpoints.list(state.projectId, 'script_episode_batch:1:1'))
      .some((checkpoint) => checkpoint.node === 'draft' && checkpoint.status === 'succeeded'))
      .toBe(false);
  });

  it('rejects a revision that fixes length but leaves a speaker outside the scene', async () => {
    const state = readySingleEpisodeState();
    state.characters.push({
      ...structuredClone(state.characters[0]!),
      id: 'witness',
      name: '证人',
    });
    const candidate = reviewingEpisode(state, 'unused');
    candidate.scenes[0]!.blocks = [
      { id: 'candidate-action', type: 'action', text: '短'.repeat(190) },
      {
        id: 'candidate-dialogue',
        type: 'dialogue',
        characterId: 'witness',
        speaker: '证人',
        text: '话'.repeat(10),
      },
    ];
    state.episodes = [candidate];
    const revisionPrompts: string[] = [];
    let revisionCalls = 0;
    let reviewCalls = 0;
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          if (request.node === 'review') {
            reviewCalls += 1;
            return JSON.stringify({
              issues: [],
              summary: '证人交出证据，沈清决定核查。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            revisionPrompts.push(request.prompt);
            const taskPrompt = request.prompt.split('\n结构契约：')[0] ?? request.prompt;
            const current = JSON.parse(taskPrompt.split('当前候选：').at(-1) ?? '{}') as {
              scenes: Array<{ id: string }>;
            };
            return JSON.stringify({
              operations: [
                ...(revisionCalls === 1 ? [] : [{
                  op: 'updateSceneCharacters',
                  sceneId: current.scenes[0]!.id,
                  characterIds: ['lead', 'witness'],
                }]),
                {
                  op: 'appendBlock',
                  sceneId: current.scenes[0]!.id,
                  block: { type: 'action', text: '补'.repeat(100) },
                },
              ],
            });
          }
          if (request.node === 'draft') throw new Error('reviewing fixture must skip draft');
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch',
      projectId: state.projectId,
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: state.plan!.revision,
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect({ revisionCalls, reviewCalls }).toEqual({ revisionCalls: 2, reviewCalls: 2 });
    expect(revisionPrompts[1]).toContain('revision.quality');
    expect(revisionPrompts[1]).toContain('SPEAKER_NOT_IN_SCENE');
    expect(store.state.episodes[0]?.scenes[0]?.characterIds).toEqual(['lead', 'witness']);
    expect(store.state.episodes[0]?.status).toBe('completed');
  });

  it('revises a deterministic blocking issue and completes after the follow-up review', async () => {
    const state = readySingleEpisodeState();
    state.episodes = [reviewingEpisode(state, '剧情'.repeat(100))];
    let reviewCalls = 0;
    const episodePayload = {
      episodeNumber: 1,
      title: '第一集',
      scenes: [{
        ordinal: 1,
        location: '校报社',
        timeOfDay: 'day',
        interiorExterior: 'interior',
        characterIds: ['lead'],
        blocks: [{ type: 'action', text: '剧情'.repeat(150) }],
      }],
      summary: '',
      newFacts: [],
      openedThreads: [],
      closedThreads: [],
    };
    const shortEpisodePayload = {
      ...episodePayload,
      scenes: [{
        ...episodePayload.scenes[0],
        blocks: [{ type: 'action', text: '剧情'.repeat(100) }],
      }],
    };
    const model: ScriptModelAdapter = {
      async complete(request) {
        if (request.node === 'draft') return JSON.stringify(shortEpisodePayload);
        if (request.node === 'revision') {
          const taskPrompt = request.prompt.split('\n结构契约：')[0] ?? request.prompt;
          const current = JSON.parse(taskPrompt.split('当前候选：').at(-1) ?? '{}') as {
            scenes: Array<{ id: string }>;
          };
          return JSON.stringify({
            operations: [{
              op: 'appendBlock',
              sceneId: current.scenes[0]?.id,
              block: { type: 'action', text: '补充'.repeat(30) },
            }],
          });
        }
        if (request.node === 'review') {
          reviewCalls += 1;
          return JSON.stringify({
            issues: [],
            summary: '沈清继续调查。',
            newFacts: [],
            openedThreads: [],
            closedThreads: [],
            wardrobe: [],
          });
        }
        throw new Error(`unexpected node: ${request.node}`);
      },
    };
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      model,
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    const result = await director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
    });

    expect(result.kind).toBe('episode_batch');
    if (result.kind !== 'episode_batch') throw new Error('预期 episode_batch');
    expect(reviewCalls).toBe(2);
    expect(store.state.episodes[0]?.status).toBe('completed');
    expect(store.state.episodes[0]?.scenes[0]?.blocks).toHaveLength(2);
    expect(store.state.episodes[0]?.scenes[0]?.blocks[0]?.text).toBe('剧情'.repeat(100));
    expect(store.saveEpisodeCalls).toHaveLength(0);
    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(result.reports[0]?.report.hardFailed).toBe(false);
  });

  it('repairs TOO_LONG through text-only reduction and commits once inside the target range', async () => {
    const state = readySingleEpisodeState();
    state.episodes = [reviewingEpisode(state, '超长'.repeat(180), { title: '超长候选' })];
    let reviewCalls = 0;
    let revisionCalls = 0;
    let revisionPrompt = '';
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            return JSON.stringify({
              episodeNumber: 1,
              title: '超长候选',
              scenes: [{
                ordinal: 1,
                location: '校报社',
                timeOfDay: 'day',
                interiorExterior: 'interior',
                characterIds: ['lead'],
                blocks: [{ type: 'action', text: '超长'.repeat(180) }],
              }],
              summary: '', newFacts: [], openedThreads: [], closedThreads: [],
            });
          }
          if (request.node === 'review') {
            reviewCalls += 1;
            return JSON.stringify({
              issues: [], summary: '沈清精简证据说明。', newFacts: [],
              openedThreads: [], closedThreads: [], wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            revisionPrompt = request.prompt;
            const taskPrompt = request.prompt.split('\n结构契约：')[0] ?? request.prompt;
            const current = JSON.parse(taskPrompt.split('当前候选：').at(-1) ?? '{}') as {
              scenes: Array<{ id: string; blocks: Array<{ id: string }> }>;
            };
            return JSON.stringify({ operations: [{
              op: 'replaceBlockText',
              sceneId: current.scenes[0]!.id,
              blockId: current.scenes[0]!.blocks[0]!.id,
              text: '精简'.repeat(150),
            }] });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    const result = await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
    });

    expect(result.kind).toBe('episode_batch');
    expect(reviewCalls).toBe(2);
    expect(revisionCalls).toBe(1);
    expect(revisionPrompt).toContain('修订后必须落在 255—345 个可见字符');
    expect(revisionPrompt).toContain('精确 revisionPolicy（唯一授权来源）');
    expect(revisionPrompt).toContain('唯一允许的操作与锚点（未列出的一律禁止）');
    expect(revisionPrompt).toContain('每块当前可见字数');
    expect(revisionPrompt).toContain('"idealNetChange":-60');
    expect(revisionPrompt).not.toContain('恰好包含');
    expect(store.state.episodes[0]?.scenes[0]?.blocks[0]?.text).toBe('精简'.repeat(150));
    expect(store.atomicCommitCalls).toHaveLength(1);
  });

  it.each([
    { label: 'still too long', replacement: '仍长'.repeat(175), expected: '变为 350 字' },
    { label: 'over-reduced', replacement: '过短'.repeat(125), expected: '变为 250 字' },
  ])('rejects a TOO_LONG patch that is $label', async ({ replacement, expected }) => {
    const state = readySingleEpisodeState();
    state.episodes = [reviewingEpisode(state, '超长'.repeat(180), { title: '超长候选' })];
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            return JSON.stringify({
              episodeNumber: 1, title: '超长候选',
              scenes: [{
                ordinal: 1, location: '校报社', timeOfDay: 'day',
                interiorExterior: 'interior', characterIds: ['lead'],
                blocks: [{ type: 'action', text: '超长'.repeat(180) }],
              }],
              summary: '', newFacts: [], openedThreads: [], closedThreads: [],
            });
          }
          if (request.node === 'review') {
            return JSON.stringify({
              issues: [], summary: '沈清精简证据说明。', newFacts: [],
              openedThreads: [], closedThreads: [], wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            const taskPrompt = request.prompt.split('\n结构契约：')[0] ?? request.prompt;
            const current = JSON.parse(taskPrompt.split('当前候选：').at(-1) ?? '{}') as {
              scenes: Array<{ id: string; blocks: Array<{ id: string }> }>;
            };
            return JSON.stringify({ operations: [{
              op: 'replaceBlockText',
              sceneId: current.scenes[0]!.id,
              blockId: current.scenes[0]!.blocks[0]!.id,
              text: replacement,
            }] });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
    })).rejects.toMatchObject({ code: 'SCRIPT_BATCH_NEEDS_REVIEW', recoverable: true });
    expect(store.state.episodes).toEqual([
      expect.objectContaining({ id: 'candidate-episode-1', status: 'reviewing' }),
    ]);
    expect(store.atomicCommitCalls).toEqual([]);
    const history = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: 'revision', status: 'needs_review',
        validationErrors: [expect.objectContaining({ message: expect.stringContaining(expected) })],
      }),
    ]));
  });

  it('fixes a 361-to-350 TOO_LONG semantic miss to 300 in the same run', async () => {
    const state = readySingleEpisodeState();
    state.episodes = [reviewingEpisode(state, `${'超长'.repeat(180)}甲`, {
      title: '超长候选',
    })];
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    let draftCalls = 0;
    let reviewCalls = 0;
    let revisionCalls = 0;
    const revisionPrompts: string[] = [];
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            draftCalls += 1;
            return JSON.stringify({
              episodeNumber: 1, title: '超长候选',
              scenes: [{
                ordinal: 1, location: '校报社', timeOfDay: 'day',
                interiorExterior: 'interior', characterIds: ['lead'],
                blocks: [{ type: 'action', text: `${'超长'.repeat(180)}甲` }],
              }],
              summary: '', newFacts: [], openedThreads: [], closedThreads: [],
            });
          }
          if (request.node === 'review') {
            reviewCalls += 1;
            return JSON.stringify({
              issues: [], summary: '沈清精简证据说明。', newFacts: [],
              openedThreads: [], closedThreads: [], wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            revisionPrompts.push(request.prompt);
            const taskPrompt = request.prompt.split('\n结构契约：')[0] ?? request.prompt;
            const current = JSON.parse(taskPrompt.split('当前候选：').at(-1) ?? '{}') as {
              scenes: Array<{ id: string; blocks: Array<{ id: string }> }>;
            };
            return JSON.stringify({ operations: [{
              op: 'replaceBlockText',
              sceneId: current.scenes[0]!.id,
              blockId: current.scenes[0]!.blocks[0]!.id,
              text: revisionCalls === 1 ? '仍长'.repeat(175) : '精简'.repeat(150),
            }] });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });
    const request = {
      task: 'script_episode_batch' as const,
      projectId: 'project-1', startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
    };

    await expect(director.run(request)).resolves.toMatchObject({ kind: 'episode_batch' });
    expect({ draftCalls, reviewCalls, revisionCalls }).toEqual({
      draftCalls: 0, reviewCalls: 2, revisionCalls: 2,
    });
    expect(revisionPrompts[0]).toContain('"current":361');
    expect(revisionPrompts[0]).toContain('"idealNetChange":-61');
    expect(revisionPrompts[1]).toContain('code=revision.length');
    expect(revisionPrompts[1]).toContain('变为 350 字');
    expect(store.state.episodes[0]?.scenes[0]?.blocks[0]?.text).toBe('精简'.repeat(150));
    expect(store.atomicCommitCalls).toHaveLength(1);
    const history = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    expect(history.filter((checkpoint) => checkpoint.node === 'revision')).toEqual([
      expect.objectContaining({ artifactRevision: 0, status: 'succeeded' }),
    ]);
    expect(history.some((checkpoint) => checkpoint.status === 'needs_review')).toBe(false);
  });

  it('repairs a truncated review response through the bounded Fixup call', async () => {
    const state = readySingleEpisodeState();
    let reviewCalls = 0;
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            return JSON.stringify({
              episodeNumber: 1,
              title: '第一集',
              scenes: [{
                ordinal: 1,
                location: '校报社',
                timeOfDay: 'day',
                interiorExterior: 'interior',
                characterIds: ['lead'],
                blocks: balancedDraftBlocks(),
              }],
              summary: '',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
            });
          }
          if (request.node === 'review') {
            reviewCalls += 1;
            if (reviewCalls === 1) return '{"issues":[],"summary":"被截断';
            return JSON.stringify({
              issues: [],
              summary: '沈清完成证据核验并拿到下一条线索。',
              newFacts: ['证据已经核验'],
              openedThreads: ['证人身份待确认'],
              closedThreads: [],
              wardrobe: [],
            });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
    })).resolves.toMatchObject({ kind: 'episode_batch' });
    expect(reviewCalls).toBe(2);
    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(store.state.episodes[0]?.summary).toContain('证据核验');
  });

  it('rejects an otherwise authorized non-TOO_LONG patch that shrinks the candidate', async () => {
    const state = readySingleEpisodeState();
    const official: ScriptEpisode = {
      id: 'official-episode-1',
      projectId: 'project-1',
      episodeNumber: 1,
      title: '正式旧稿',
      outlineId: 'outline-1',
      status: 'failed',
      targetChars: 300,
      scenes: [{
        id: 'official-scene-1',
        ordinal: 1,
        location: '校报社',
        timeOfDay: 'day',
        interiorExterior: 'interior',
        characterIds: ['lead'],
        blocks: [{ id: 'official-block-1', type: 'action', text: '正式内容'.repeat(75) }],
      }],
      summary: '旧稿保留。',
      newFacts: [],
      openedThreads: [],
      closedThreads: [],
      revision: 4,
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    };
    const candidate = reviewingEpisode(state, '剧情'.repeat(150), {
      title: '候选稿',
      revision: official.revision,
      blockTextPrefix: '△',
    });
    state.episodes = [structuredClone(official), candidate];
    const checkpoints = new InMemoryScriptCheckpointStore();
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            return JSON.stringify({
              episodeNumber: 1,
              title: '候选稿',
              scenes: [{
                ordinal: 1,
                location: '校报社',
                timeOfDay: 'day',
                interiorExterior: 'interior',
                characterIds: ['lead'],
                blocks: [{ type: 'action', text: `△${'剧情'.repeat(150)}` }],
              }],
              summary: '',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
            });
          }
          if (request.node === 'review') {
            return JSON.stringify({
              issues: [],
              summary: '候选稿等待结构修复。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            const taskPrompt = request.prompt.split('\n结构契约：')[0] ?? request.prompt;
            const current = JSON.parse(taskPrompt.split('当前候选：').at(-1) ?? '{}') as {
              scenes: Array<{ id: string; blocks: Array<{ id: string }> }>;
            };
            return JSON.stringify({
              operations: [{
                op: 'replaceBlockText',
                sceneId: current.scenes[0]!.id,
                blockId: current.scenes[0]!.blocks[0]!.id,
                text: '修复'.repeat(122),
              }],
            });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
    })).rejects.toMatchObject({ code: 'SCRIPT_BATCH_NEEDS_REVIEW', recoverable: true });
    expect(store.state.episodes.find((episode) => episode.id === official.id)).toEqual(official);
    expect(store.atomicCommitCalls).toHaveLength(0);
    const history = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: 'revision',
        status: 'needs_review',
        validationErrors: [expect.objectContaining({
          code: 'revision.length',
          message: expect.stringContaining('无权缩短'),
        })],
      }),
    ]));
  });

  it('keeps the formal episode unchanged when TOO_SHORT fixup exhausts below range', async () => {
    const state = readySingleEpisodeState();
    const official: ScriptEpisode = {
      id: 'official-episode-1', projectId: 'project-1', episodeNumber: 1,
      title: '正式旧稿', outlineId: 'outline-1', status: 'failed', targetChars: 300,
      scenes: [{
        id: 'official-scene-1', ordinal: 1, location: '校报社', timeOfDay: 'day',
        interiorExterior: 'interior', characterIds: ['lead'],
        blocks: [{ id: 'official-block-1', type: 'action', text: '正式内容'.repeat(75) }],
      }],
      summary: '旧稿保留。', newFacts: [], openedThreads: [], closedThreads: [],
      revision: 6, createdAt: state.updatedAt, updatedAt: state.updatedAt,
    };
    const candidate = reviewingEpisode(state, '候选'.repeat(100), {
      title: '候选短稿',
      revision: official.revision,
    });
    state.episodes = [structuredClone(official), candidate];
    let reviewCalls = 0;
    let revisionCalls = 0;
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            return JSON.stringify({
              episodeNumber: 1, title: '候选短稿',
              scenes: [{
                ordinal: 1, location: '校报社', timeOfDay: 'day',
                interiorExterior: 'interior', characterIds: ['lead'],
                blocks: [{ type: 'action', text: '候选'.repeat(100) }],
              }],
              summary: '', newFacts: [], openedThreads: [], closedThreads: [],
            });
          }
          if (request.node === 'review') {
            reviewCalls += 1;
            return JSON.stringify({
              issues: [], summary: `第${reviewCalls}次复检仍需扩写。`, newFacts: [],
              openedThreads: [], closedThreads: [], wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            const taskPrompt = request.prompt.split('\n结构契约：')[0] ?? request.prompt;
            const current = JSON.parse(taskPrompt.split('当前候选：').at(-1) ?? '{}') as {
              scenes: Array<{ id: string; blocks: Array<{ id: string }> }>;
            };
            return JSON.stringify({ operations: [{
              op: 'insertBlockAfter',
              sceneId: current.scenes[0]!.id,
              afterBlockId: current.scenes[0]!.blocks.at(-1)!.id,
              block: { type: 'action', text: '补'.repeat(5) },
            }] });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
    })).rejects.toMatchObject({ code: 'SCRIPT_BATCH_NEEDS_REVIEW' });
    expect(reviewCalls).toBe(1);
    expect(revisionCalls).toBe(2);
    expect(store.state.episodes.find((episode) => episode.id === official.id)).toEqual(official);
    expect(store.atomicCommitCalls).toHaveLength(0);
    const rejectedRevision = (await checkpoints.list('project-1', 'script_episode_batch:1:1'))
      .find((checkpoint) => checkpoint.node === 'revision' && checkpoint.status === 'needs_review');
    expect(rejectedRevision?.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'revision.length',
        message: expect.stringContaining('TOO_SHORT 修订必须增加正文并一次落入'),
      }),
    ]));
  });

  it('checkpoints sanitized structured exhaustion and gives its feedback to resume', async () => {
    const state = readySingleEpisodeState();
    const official: ScriptEpisode = {
      id: 'official-episode-1',
      projectId: 'project-1',
      episodeNumber: 1,
      title: '正式旧稿',
      outlineId: 'outline-1',
      status: 'failed',
      targetChars: 300,
      scenes: [{
        id: 'official-scene-1',
        ordinal: 1,
        location: '校报社',
        timeOfDay: 'day',
        interiorExterior: 'interior',
        characterIds: ['lead'],
        blocks: [{ id: 'official-block-1', type: 'action', text: '正式旧稿'.repeat(50) }],
      }],
      summary: '需要继续修订。',
      newFacts: [],
      openedThreads: [],
      closedThreads: [],
      revision: 7,
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    };
    const candidate = reviewingEpisode(state, '候选短稿'.repeat(50), {
      title: '内存候选',
      revision: official.revision,
    });
    state.episodes = [structuredClone(official), candidate];
    let revisionCalls = 0;
    const revisionPrompts: string[] = [];
    const leakedSecret = 'sk-this-must-never-be-persisted';
    const fullEpisodeResponse = {
      episodeNumber: 1,
      title: `错误的整集返回-${leakedSecret}`,
      scenes: [{
        ordinal: 1,
        location: '校报社',
        timeOfDay: 'day',
        interiorExterior: 'interior',
        characterIds: ['lead'],
        blocks: [{ type: 'action', text: '替换内容'.repeat(80) }],
      }],
      summary: '',
      newFacts: [],
      openedThreads: [],
      closedThreads: [],
    };
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            return JSON.stringify({
              ...fullEpisodeResponse,
              title: '内存候选',
              scenes: [{
                ...fullEpisodeResponse.scenes[0],
                blocks: [{ type: 'action', text: '候选短稿'.repeat(50) }],
              }],
            });
          }
          if (request.node === 'review') {
            return JSON.stringify({
              issues: [],
              summary: '候选等待受限修订。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            revisionPrompts.push(request.prompt);
            if (revisionCalls <= 2) return JSON.stringify(fullEpisodeResponse);
            const taskPrompt = request.prompt.split('\n结构契约：')[0] ?? request.prompt;
            const candidate = JSON.parse(taskPrompt.split('当前候选：').at(-1) ?? '{}') as {
              scenes: Array<{ id: string }>;
            };
            return JSON.stringify({ operations: [{
              op: 'appendBlock',
              sceneId: candidate.scenes[0]!.id,
              block: { type: 'action', text: '补写'.repeat(30) },
            }] });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    const request = {
      task: 'script_episode_batch' as const,
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
    };
    let paused: unknown;
    try {
      await director.run(request);
    } catch (error) {
      paused = error;
    }
    expect(paused).toBeInstanceOf(ScriptBatchPausedError);
    expect((paused as Error).message).toContain('REVISION_PATCH_REJECTED');

    expect(revisionCalls).toBe(2);
    expect(store.state.episodes.find((episode) => episode.id === official.id)).toEqual(official);
    expect(store.saveEpisodeCalls).toHaveLength(0);
    expect(store.atomicCommitCalls).toHaveLength(0);
    const rejectedHistory = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    const serializedHistory = JSON.stringify(rejectedHistory);
    expect(serializedHistory).not.toContain(leakedSecret);
    expect(serializedHistory).not.toContain('替换内容');
    expect(rejectedHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: 'revision', status: 'needs_review',
        validationErrors: [expect.objectContaining({
          code: 'array.non_empty',
          message: expect.stringContaining('operations 必须是非空数组'),
        })],
      }),
    ]));

    await expect(director.run({
      ...request,
      resumeRejectedCandidates: true,
    })).resolves.toMatchObject({ kind: 'episode_batch' });
    expect(revisionCalls).toBe(3);
    expect(revisionPrompts[2]).toContain('上次候选被系统拒绝');
    expect(revisionPrompts[2]).toContain('array.non_empty');
    expect(revisionPrompts[2]).not.toContain(leakedSecret);
    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(store.state.episodes[0]).toMatchObject({ status: 'completed', episodeNumber: 1 });
  });

  it('fixes mixed TOO_SHORT blockers from a non-tail anchor without leaking dry-run IDs', async () => {
    const state = readySingleEpisodeState();
    state.episodes = [{
      ...reviewingEpisode(state, 'unused'),
      id: 'candidate-episode',
      scenes: [{
        id: 'candidate-scene',
        ordinal: 1,
        location: '校报社',
        timeOfDay: 'day',
        interiorExterior: 'interior',
        characterIds: ['lead'],
        blocks: [
          { id: 'candidate-block-first', type: 'action', text: '△短' },
          { id: 'candidate-block-last', type: 'action', text: '尾' },
        ],
      }],
    }];
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    let revisionCalls = 0;
    const revisionPrompts: string[] = [];
    const allocatedIds: string[] = [];
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            return JSON.stringify({
              id: 'candidate-episode', episodeNumber: 1, title: '第一集',
              scenes: [{
                id: 'candidate-scene',
                ordinal: 1, location: '校报社', timeOfDay: 'day',
                interiorExterior: 'interior', characterIds: ['lead'],
                blocks: [
                  { id: 'candidate-block-first', type: 'action', text: '△短' },
                  { id: 'candidate-block-last', type: 'action', text: '尾' },
                ],
              }],
              summary: '', newFacts: [], openedThreads: [], closedThreads: [],
            });
          }
          if (request.node === 'review') {
            return JSON.stringify({
              issues: [], summary: '沈清继续调查。', newFacts: [],
              openedThreads: [], closedThreads: [], wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            revisionPrompts.push(request.prompt);
            const taskPrompt = request.prompt.split('\n结构契约：')[0] ?? request.prompt;
            const candidate = JSON.parse(taskPrompt.split('当前候选：').at(-1) ?? '{}') as {
              scenes: Array<{ id: string; blocks: Array<{ id: string }> }>;
            };
            return JSON.stringify({ operations: [
              {
                op: 'replaceBlockText',
                sceneId: candidate.scenes[0]!.id,
                blockId: candidate.scenes[0]!.blocks[0]!.id,
                text: '修',
              },
              {
                op: 'insertBlockAfter',
                sceneId: candidate.scenes[0]!.id,
                afterBlockId: revisionCalls === 1
                  ? candidate.scenes[0]!.blocks[0]!.id
                  : candidate.scenes[0]!.blocks.at(-1)!.id,
                block: { type: 'action', text: '补'.repeat(298) },
              },
            ] });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
      store,
      checkpoints,
      id: () => {
        const id = `real-id-${allocatedIds.length + 1}`;
        allocatedIds.push(id);
        return id;
      },
    });

    await expect(director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
    })).resolves.toMatchObject({ kind: 'episode_batch' });
    expect(revisionCalls).toBe(2);
    expect(revisionPrompts[0]).toContain('精确 revisionPolicy（唯一授权来源）');
    expect(revisionPrompts[0]).toContain('"allowedAfterBlockIds"');
    expect(revisionPrompts[0]).toContain('ACTION_STRUCTURE_POLLUTION');
    expect(revisionPrompts[0]).toContain('TOO_SHORT');
    expect(revisionPrompts[0]).toContain('"visibleChars":2');
    expect(revisionPrompts[0]).toContain('"visibleChars":1');
    expect(revisionPrompts[0]).toContain('"idealNetChange":297');
    expect(revisionPrompts[0].match(/精确 revisionPolicy（唯一授权来源）/gu)).toHaveLength(1);
    expect(revisionPrompts[0]).toContain('ScriptRevisionPatch@v2');
    expect(revisionPrompts[1]).toContain('code=revision.policy');
    expect(revisionPrompts[1]).toContain('candidate-block-first');
    expect(store.state.episodes).toEqual([
      expect.objectContaining({ episodeNumber: 1, status: 'completed' }),
    ]);
    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(allocatedIds).toEqual(['real-id-1']);
    expect(JSON.stringify(store.state)).not.toContain('revision-validation-');
    expect(JSON.stringify(await checkpoints.list('project-1', 'script_episode_batch:1:1')))
      .not.toContain('revision-validation-');
    expect((await checkpoints.list('project-1', 'script_episode_batch:1:1'))
      .some((checkpoint) => checkpoint.status === 'needs_review')).toBe(false);
  });

  it('resumes after two semantic failures and reuses the reviewing episode', async () => {
    const state = readySingleEpisodeState();
    state.episodes = [reviewingEpisode(state, `${'超长'.repeat(180)}甲`, {
      title: '超长候选',
    })];
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    let draftCalls = 0;
    let reviewCalls = 0;
    let revisionCalls = 0;
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          const taskPrompt = request.prompt.split('\n结构契约：')[0] ?? request.prompt;
          if (request.node === 'draft') {
            draftCalls += 1;
            return JSON.stringify({
              episodeNumber: 1,
              title: '第一集',
              scenes: [{
                ordinal: 1,
                location: '校报社',
                timeOfDay: 'day',
                interiorExterior: 'interior',
                characterIds: ['lead'],
                blocks: [{ type: 'action', text: `${'超长'.repeat(180)}甲` }],
              }],
              summary: '',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
            });
          }
          if (request.node === 'review') {
            reviewCalls += 1;
            return JSON.stringify({
              issues: [],
              summary: '沈清在校报社取得关键证据。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            const candidate = JSON.parse(taskPrompt.split('当前候选：').at(-1) ?? '{}') as {
              scenes: Array<{ id: string; blocks: Array<{ id: string }> }>;
            };
            return JSON.stringify({
              operations: [{
                op: 'replaceBlockText',
                sceneId: candidate.scenes[0]!.id,
                blockId: candidate.scenes[0]!.blocks[0]!.id,
                text: revisionCalls <= 2
                  ? '仍长'.repeat(175)
                  : '修'.repeat(300),
              }],
            });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });
    const request = {
      task: 'script_episode_batch' as const,
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
    };

    await expect(director.run(request)).rejects.toMatchObject({
      code: 'SCRIPT_BATCH_NEEDS_REVIEW',
      recoverable: true,
    });
    expect({ draftCalls, reviewCalls, revisionCalls }).toEqual({
      draftCalls: 0,
      reviewCalls: 1,
      revisionCalls: 2,
    });
    expect(store.state.episodes).toEqual([
      expect.objectContaining({ id: 'candidate-episode-1', status: 'reviewing' }),
    ]);
    expect(store.state.continuityCommits ?? []).toEqual([]);

    await expect(director.run({
      ...request,
      resumeRejectedCandidates: true,
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect({ draftCalls, reviewCalls, revisionCalls }).toEqual({
      draftCalls: 0,
      reviewCalls: 3,
      revisionCalls: 3,
    });
    expect(store.state.episodes).toEqual([
      expect.objectContaining({ episodeNumber: 1, status: 'completed' }),
    ]);
    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(store.state.continuityCommits).toHaveLength(1);
    const history = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: 'revision', artifactRevision: 0, status: 'stale',
      }),
      expect.objectContaining({
        node: 'revision', artifactRevision: 1, status: 'succeeded',
      }),
    ]));
    const rejectedRevision = history.find((checkpoint) =>
      checkpoint.node === 'revision' && checkpoint.artifactRevision === 0);
    const succeededRevision = history.find((checkpoint) =>
      checkpoint.node === 'revision' && checkpoint.artifactRevision === 1);
    expect(rejectedRevision?.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'revision.length' }),
    ]));
    expect((rejectedRevision?.artifact as { candidateHash?: string } | undefined)?.candidateHash)
      .not.toBe((succeededRevision?.artifact as { candidateHash?: string } | undefined)?.candidateHash);
  });

  it('does not bypass a retained user-authored open hard issue when the director saves completed', async () => {
    const state = readySingleEpisodeState();
    state.reviewRevision = 1;
    state.reviewIssues = [{
      id: 'user-hard-1',
      projectId: 'project-1',
      episodeNumber: 1,
      code: 'USER_CONTINUITY_BLOCKER',
      severity: 'hard',
      category: 'continuity',
      message: '人工确认的连续性冲突尚未解决。',
      status: 'open',
      source: 'user',
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    }];
    const model: ScriptModelAdapter = {
      async complete(request) {
        if (request.node === 'draft') {
          return JSON.stringify({
            episodeNumber: 1,
            title: '第一集',
            scenes: [{
              ordinal: 1,
              location: '校报社',
              timeOfDay: 'day',
              interiorExterior: 'interior',
              characterIds: ['lead'],
              blocks: balancedDraftBlocks(),
            }],
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
            newFacts: [],
            openedThreads: [],
            closedThreads: [],
            wardrobe: [],
          });
        }
        throw new Error(`unexpected node: ${request.node}`);
      },
    };
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      model,
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
    })).rejects.toBeInstanceOf(ScriptBatchPausedError);
    expect(store.state.episodes).toHaveLength(0);
    expect(store.saveEpisodeCalls).toHaveLength(0);
    expect(store.atomicCommitCalls).toHaveLength(0);
    expect(store.state.reviewIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'user-hard-1', status: 'open' }),
    ]));
  });

  it.each(['missing', 'stale'] as const)(
    'rejects the 6-10 batch without a model call when an earlier canonical link is %s',
    async (brokenLink) => {
    const state = readySingleEpisodeState();
    state.plan = approvedPlan(10);
    state.seriesOutline = {
      ...state.seriesOutline!,
      episodeCards: Array.from({ length: 10 }, (_, index) => ({
        episodeNumber: index + 1,
        title: `第${index + 1}集`,
        logline: '推进调查。',
        mainEvent: '取得证据。',
        endingHook: '新线索。',
      })),
    };
    state.episodes = Array.from({ length: 5 }, (_, index): ScriptEpisode => ({
      id: `episode-${index + 1}`,
      projectId: 'project-1',
      episodeNumber: index + 1,
      title: `第${index + 1}集`,
      outlineId: `outline-${index + 1}`,
      status: 'completed',
      targetChars: 300,
      scenes: [{
        id: `scene-${index + 1}`,
        ordinal: 1,
        location: '校报社',
        timeOfDay: 'day',
        interiorExterior: 'interior',
        characterIds: ['lead'],
        blocks: [{ id: `block-${index + 1}`, type: 'action', text: '推进调查。' }],
      }],
      summary: '推进调查。',
      newFacts: [], openedThreads: [], closedThreads: [],
      revision: 1,
      createdAt: state.updatedAt,
      updatedAt: state.updatedAt,
    }));
    state.continuityCommits = state.episodes.map((episode, index) => ({
      id: `continuity-${episode.episodeNumber}`,
      schemaVersion: 1 as const,
      projectId: state.projectId,
      episodeNumber: episode.episodeNumber,
      episodeRevision: episode.revision,
      revision: index + 1,
      status: brokenLink === 'stale' && index === 0 ? 'stale' as const : 'current' as const,
      inputFingerprint: `${index + 1}`.repeat(64).slice(0, 64),
      ...(index > 0 ? {
        previousContinuityCommitId: `continuity-${index}`,
        previousContinuityRevision: index,
      } : {}),
      characterUpdates: [], factsAdded: [], props: [], threads: [], timelineEvents: [],
      nextEpisodeMustInherit: [],
      createdAt: state.updatedAt,
      updatedAt: state.updatedAt,
    }));
    if (brokenLink === 'missing') state.continuityCommits.splice(2, 1);
    let modelCalls = 0;
    const director = new ScriptDirector({
      model: { async complete() { modelCalls += 1; return '{}'; } },
      store: new MemoryScriptStore(state),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 6, episodeCount: 5, expectedPlanRevision: 1,
    })).rejects.toThrow('必须完成且具有匹配正文版本的连续性提交');
    expect(modelCalls).toBe(0);
    },
  );
});
