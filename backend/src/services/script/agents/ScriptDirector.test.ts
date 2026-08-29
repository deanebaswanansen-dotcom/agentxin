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
import {
  computeScriptEpisodeCandidateHash,
  ScriptConflictError,
  type ScriptStore,
} from '../ScriptStore.js';
import { computeScriptCheckpointInputFingerprint } from './ScriptCheckpoint.js';
import {
  InMemoryScriptCheckpointStore,
  ScriptBatchPausedError,
  ScriptDirector,
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
    if (input.reviewUpdate) {
      const replacedSources = new Set(input.reviewUpdate.sources);
      this.state.reviewIssues = [
        ...this.state.reviewIssues.filter((item) => (
          item.episodeNumber !== input.episode.episodeNumber ||
          !replacedSources.has(item.source)
        )),
        ...structuredClone(input.reviewUpdate.items),
      ];
      this.state.reviewRevision += 1;
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

function directScriptText(options: {
  episodeNumber?: number;
  actionChars?: number;
  dialogueChars?: number;
  location?: string;
  dialogue?: string;
} = {}): string {
  const episodeNumber = options.episodeNumber ?? 1;
  const action = '沈清把录音笔和采访记录并排放在校报社的长桌上逐页核对。'
    .repeat(20)
    .slice(0, options.actionChars ?? 120);
  const dialogue = options.dialogue ?? '这份时间戳能证明证据从未离开档案室。'
    .repeat(20)
    .slice(0, options.dialogueChars ?? 150);
  return [
    `第${episodeNumber}集`,
    `${episodeNumber}-1 ${options.location ?? '校报社'} 日/内`,
    '人物：沈清',
    `△${action}`,
    `沈清：${dialogue}`,
  ].join('\n');
}

function directReviewJson(options: {
  verdict?: 'pass' | 'major_issue';
  issues?: unknown[];
  summary?: string;
} = {}): string {
  return JSON.stringify({
    verdict: options.verdict ?? 'pass',
    issues: options.issues ?? [],
    handoff: {
      summary: options.summary ?? '沈清核对记录并取得能推进调查的证据。',
      characterStates: [{ characterId: 'lead', location: '校报社', state: '继续调查', knows: ['证据时间戳有效'] }],
      props: [{ name: '录音笔', holder: 'lead', location: '校报社', state: '由沈清保管' }],
      openThreads: ['新证人的身份尚未公开'],
      ending: '门外的新证人敲响玻璃门。',
    },
  });
}

function exactScriptText(seed: string, length: number, variant?: number): string {
  if (seed.length > length) throw new Error(`seed is longer than ${length}: ${seed}`);
  const details = [
    '她把发黄的登记表压在台灯下逐行核对终于看见被涂改的日期',
    '门外脚步忽然停住众人同时望向磨砂玻璃上晃动的人影',
    '他将录音笔推到桌子中央要求对方当着所有人的面解释清楚',
    '走廊广播突然中断那句没有说完的警告反而让空气彻底凝固',
    '沈清翻开旧档案夹从订书钉留下的空洞判断关键一页被人取走',
    '对方攥紧钥匙拒绝开门却被监控画面里清楚的时间戳逼得沉默',
    '窗外警笛由远而近桌边几个人交换眼神谁也不敢先伸手拿证据',
    '她关掉直播声音只留下画面让藏在角落里的手势变得格外清楚',
    '保安推来落灰的纸箱封条编号恰好对应账本上消失的那次登记',
    '证人刚要签字手机便连续震动陌生号码发来的照片直指他的家人',
    '沈清没有争辩只是把两份合同并排摊开让相同笔迹暴露在灯光下',
    '电梯门缓缓合上时一只手突然挡住缝隙把沾血的工作牌递了进来',
    '她顺着咖啡渍找到撕毁票据的缺角确认昨晚还有第三个人在现场',
    '校报社的打印机自行吐出半页名单最下方那个名字被红笔重重圈住',
    '负责人拔掉电源试图终止播放备用投影却同步亮出完整的转账记录',
    '沈清让开门口没有追赶只提醒对方楼下记者已经等着同一个答案',
    '柜门锁芯残留的新划痕说明有人刚换过钥匙却来不及清理金属碎屑',
    '雨水沿着证人的袖口滴落他终于承认匿名邮件并非自己主动发出',
    '她把时间线写满白板最后一条箭头准确落在失踪档案管理员身上',
    '审讯室灯光骤暗备用录音仍在运转把那句低声威胁完整保存下来',
    '旧手机恢复出的定位轨迹绕过正门最终停在仓库背后的消防通道',
    '沈清抬手制止争吵要求每个人依次复述昨夜见到的那辆灰色轿车',
    '桌下滚出的袖扣刻着陌生缩写与监控中遮住镜头的男人完全吻合',
    '证据袋被重新封好之前她发现标签日期比案发时间整整早了一天',
  ];
  const seedHash = [...seed].reduce(
    (hash, character) => (hash * 33 + (character.codePointAt(0) ?? 0)) >>> 0,
    5381,
  );
  let text = `${seed}，`;
  let offset = 0;
  while (text.length < length) {
    text += `${details[((variant ?? seedHash) + offset * 7) % details.length]}。`;
    offset += 1;
  }
  return text.slice(0, length);
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

  it('locally completes a structurally incomplete plan without another model call', async () => {
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
    expect(calls).toBe(1);
  });

  it('builds an editable plan from confirmed choices when the model returns an empty object', async () => {
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
    })).resolves.toMatchObject({
      kind: 'plan_draft',
      plan: {
        projectId: 'project-1',
        genres: ['校园青春'],
        totalEpisodes: 10,
        coreConflict: '调查真相',
      },
    });
    expect(calls).toBe(1);
  });

  it('falls back to confirmed choices after the fixed plan JSON budget is exhausted', async () => {
    let calls = 0;
    const checkpoints = new InMemoryScriptCheckpointStore();
    const director = new ScriptDirector({
      model: { async complete() { calls += 1; return '这不是 JSON'; } },
      store: new MemoryScriptStore(emptyState()),
      checkpoints,
    });

    await expect(director.run({
      task: 'script_plan', projectId: 'project-1', seedPrompt: '雪灾中守住仓库',
      planningSession: {
        values: {
          genres: ['灾难'], coreConflict: '守住救援物资', audience: '大众观众',
          totalEpisodes: 12, episodeDurationSeconds: { min: 60, max: 90 },
          targetCharsPerEpisode: 1_000, maxScenesPerEpisode: 3,
          dialogueDensityPercent: 60, endingDirection: '救援成功',
        },
        delegatedFields: [], askedFields: [], questionCount: 0,
      },
    })).resolves.toMatchObject({
      kind: 'plan_draft',
      plan: { projectId: 'project-1', totalEpisodes: 12, coreConflict: '守住救援物资' },
    });
    expect(calls).toBe(2);
    await expect(checkpoints.list('project-1', 'script_plan')).resolves.toEqual([
      expect.objectContaining({
        status: 'succeeded',
        validationErrors: [expect.objectContaining({ code: 'script_plan.local_fallback' })],
      }),
    ]);
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
    const prompts: string[] = [];
    const model: ScriptModelAdapter = {
      async complete(request) {
        if (request.node !== 'series_outline') throw new Error('unexpected node');
        const start = request.chunkStart ?? 1;
        const end = request.chunkEnd ?? 12;
        chunkStarts.push(start);
        prompts.push(request.prompt);
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
    expect(prompts[0]).not.toContain('上一段最后两集');
    expect(prompts[0]).toContain('450—650 个汉字的全剧大纲');
    expect(prompts[0]).toContain('不要只写“调查真相”“冲突升级”这类空话');
    expect(prompts[1]).toContain('上一段最后两集');
    expect(prompts[1]).toContain('第9步');
    expect(prompts[1]).toContain('第10步');
    expect(prompts[1]).toContain('已经发生、取得或发现的关键事件不得重新当作首次发生');
    expect(store.state.seriesOutline?.episodeCards.map((card) => card.episodeNumber)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(store.state.seriesOutline?.synopsis.length).toBeGreaterThanOrEqual(450);

    const firstRevision = store.state.seriesOutline?.revision;
    const callsBeforeRegenerate = chunkStarts.length;
    const regenerated = await director.run({
      task: 'script_series_outline',
      projectId: 'project-1',
      regenerate: true,
    });
    expect(regenerated.kind).toBe('series_outline');
    expect(chunkStarts.slice(callsBeforeRegenerate)).toEqual([1, 11]);
    expect(store.state.seriesOutline?.revision).toBe((firstRevision ?? 0) + 1);
  });

  it('keeps the existing series outline when an explicit regeneration returns no usable structure', async () => {
    const state = readySingleEpisodeState();
    const original = structuredClone(state.seriesOutline);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const director = new ScriptDirector({
      model: { complete: async () => '这次没有返回可解析的大纲' },
      store: new MemoryScriptStore(state),
      checkpoints,
    });

    await expect(director.run({
      task: 'script_series_outline',
      projectId: 'project-1',
      regenerate: true,
    })).rejects.toMatchObject({ code: 'SCRIPT_STRUCTURED_NEEDS_REVIEW' });

    expect(state.seriesOutline).toEqual(original);
    expect(await checkpoints.list('project-1', 'script_series_outline')).toEqual(
      expect.arrayContaining([expect.objectContaining({
        node: 'series_outline',
        status: 'needs_review',
        validationErrors: [expect.objectContaining({ code: 'series_outline.regenerate_failed' })],
      })]),
    );
  });

  it('reuses completed outline chunks when the same regeneration run retries', async () => {
    const state = readySingleEpisodeState();
    state.plan = approvedPlan(12);
    state.seriesOutline = {
      ...state.seriesOutline!,
      episodeCards: Array.from({ length: 12 }, (_, index) => ({
        episodeNumber: index + 1,
        title: `旧第${index + 1}集`,
        logline: '旧剧情。',
        mainEvent: '旧事件。',
        endingHook: '旧卡点。',
      })),
    };
    const starts: number[] = [];
    let failSecondChunk = true;
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          const start = request.chunkStart ?? 1;
          const end = request.chunkEnd ?? start;
          starts.push(start);
          if (start === 11 && failSecondChunk) {
            failSecondChunk = false;
            throw new Error('provider disconnected');
          }
          return JSON.stringify({
            synopsis: '新总纲。', openingState: '新开局。', midpointTurn: '新中点。',
            climax: '新高潮。', endingState: '新结局。', mainArc: ['新主线'], subplotArcs: [],
            episodeCards: Array.from({ length: end - start + 1 }, (_, index) => ({
              episodeNumber: start + index,
              title: `新第${start + index}集`,
              logline: '新剧情。', mainEvent: '新事件。', endingHook: '新卡点。',
            })),
          });
        },
      },
      store: new MemoryScriptStore(state),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });
    const request = {
      task: 'script_series_outline' as const,
      projectId: 'project-1',
      regenerate: true,
      regenerationRunId: 'outline-rewrite-1',
    };

    await expect(director.run(request)).rejects.toThrow('已完整保留原大纲');
    expect(state.seriesOutline?.episodeCards[0]?.title).toBe('旧第1集');
    await expect(director.run(request)).resolves.toMatchObject({ kind: 'series_outline' });
    expect(starts).toEqual([1, 11, 11]);
    expect(state.seriesOutline?.episodeCards[0]?.title).toBe('新第1集');
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

    const regenerated = await director.run({ task: 'script_bible', projectId: 'project-1', regenerate: true });
    expect(regenerated.kind).toBe('bible');
    expect(nodes).toEqual(['character_bible', 'world_bible', 'character_bible', 'world_bible']);
  });

  it('keeps existing character ids stable during bible regeneration', async () => {
    const state = readySingleEpisodeState();
    const existing = state.characters[0]!;
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          if (request.node === 'character_bible') {
            return JSON.stringify({
              characters: [{ ...existing, id: 'replacement-lead', appearance: '更新后的利落形象' }],
            });
          }
          if (request.node === 'world_bible') {
            return JSON.stringify({ ...state.worldBible, era: '2027年' });
          }
          throw new Error('unexpected node');
        },
      },
      store: new MemoryScriptStore(state),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await director.run({ task: 'script_bible', projectId: 'project-1', regenerate: true });

    expect(state.characters).toEqual([
      expect.objectContaining({ id: 'lead', name: '沈清', appearance: '更新后的利落形象' }),
    ]);
    expect(state.episodeOutlines[0]?.characterIds).toEqual(['lead']);
  });

  it('keeps an old card and gives a genuinely new regenerated character its own id', async () => {
    const state = readySingleEpisodeState();
    const existing = structuredClone(state.characters[0]!);
    const replacement = {
      ...existing,
      id: 'new-lead',
      name: '李然',
      aliases: ['小李'],
      biography: '新加入调查组的记者。',
      relationships: [],
    };
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          if (request.node === 'character_bible') {
            return JSON.stringify({ characters: [replacement] });
          }
          if (request.node === 'world_bible') return JSON.stringify(state.worldBible);
          throw new Error('unexpected node');
        },
      },
      store: new MemoryScriptStore(state),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await director.run({ task: 'script_bible', projectId: 'project-1', regenerate: true });

    expect(state.characters).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'new-lead', name: '李然' }),
      expect.objectContaining({ id: 'lead', name: '沈清' }),
    ]));
    expect(state.characters).not.toContainEqual(expect.objectContaining({ id: 'lead', name: '李然' }));
    expect(state.episodeOutlines[0]?.characterIds).toEqual(['lead']);
  });

  it('rolls back the successful half when combined bible regeneration fails', async () => {
    const state = readySingleEpisodeState();
    const originalCharacters = structuredClone(state.characters);
    const originalWorld = structuredClone(state.worldBible);
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          if (request.node === 'character_bible') {
            return JSON.stringify({
              characters: [{ ...state.characters[0]!, biography: '不应留下的半成品人物小传' }],
            });
          }
          return '世界设定无法解析';
        },
      },
      store: new MemoryScriptStore(state),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({
      task: 'script_bible', projectId: 'project-1', regenerate: true,
    })).rejects.toMatchObject({ code: 'SCRIPT_STRUCTURED_NEEDS_REVIEW' });

    expect(state.characters).toEqual(originalCharacters);
    expect(state.worldBible).toEqual(originalWorld);
  });

  it('reports an explicit error when a combined bible rollback cannot be persisted', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const saveCharacters = store.saveCharacters.bind(store);
    let saveCharacterCalls = 0;
    store.saveCharacters = async (...args) => {
      saveCharacterCalls += 1;
      if (saveCharacterCalls === 2) throw new Error('rollback disk failure');
      return saveCharacters(...args);
    };
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          if (request.node === 'character_bible') {
            return JSON.stringify({
              characters: [{ ...state.characters[0]!, biography: '已经写入的新人物小传' }],
            });
          }
          return '世界设定无法解析';
        },
      },
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({
      task: 'script_bible', projectId: 'project-1', regenerate: true,
    })).rejects.toThrow('人物与世界重新生成失败，且恢复旧设定时写入失败：rollback disk failure');
    expect(saveCharacterCalls).toBe(2);
  });

  it('locally supplies a missing hairstyle before saving the character bible', async () => {
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
    expect(prompts).toHaveLength(1);
    expect(store.state.characters[0]?.hairstyle).toBe('符合人物身份的日常发型');
  });

  it('creates a minimal editable cast when the model returns an empty cast', async () => {
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

    await expect(generation).resolves.toMatchObject({ kind: 'bible' });
    expect(calls).toBe(1);
  });

  it('finishes both bibles locally when neither response contains JSON', async () => {
    const state = readySingleEpisodeState();
    state.characters = [];
    state.worldBible = undefined;
    const calls: string[] = [];
    const checkpoints = new InMemoryScriptCheckpointStore();
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          calls.push(request.node);
          return '没有结构化内容';
        },
      },
      store: new MemoryScriptStore(state),
      checkpoints,
    });

    await expect(director.run({ task: 'script_bible', projectId: 'project-1' }))
      .resolves.toMatchObject({
        kind: 'bible',
        characters: expect.arrayContaining([expect.objectContaining({ projectId: 'project-1' })]),
        worldBible: expect.objectContaining({ projectId: 'project-1' }),
      });
    expect(calls.filter((node) => node === 'character_bible')).toHaveLength(2);
    expect(calls.filter((node) => node === 'world_bible')).toHaveLength(2);
    await expect(checkpoints.list('project-1', 'script_bible')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node: 'character_bible', status: 'succeeded',
          validationErrors: [expect.objectContaining({ code: 'character_bible.local_fallback' })],
        }),
        expect.objectContaining({
          node: 'world_bible', status: 'succeeded',
          validationErrors: [expect.objectContaining({ code: 'world_bible.local_fallback' })],
        }),
      ]),
    );
  });

  it('locally completes a partial character while also checkpointing the world bible', async () => {
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
      .resolves.toMatchObject({ kind: 'bible' });

    expect(calls.filter((node) => node === 'character_bible')).toHaveLength(1);
    expect(calls.filter((node) => node === 'world_bible')).toHaveLength(1);
    expect(store.state.worldBible).toMatchObject({ era: '2026年' });
    await expect(checkpoints.list('project-1', 'script_bible')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ node: 'character_bible', status: 'succeeded' }),
        expect.objectContaining({ node: 'world_bible', status: 'succeeded' }),
      ]),
    );
  });

  it('uses one model call and locally completes all character candidates', async () => {
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
    expect(calls).toBe(1);
    expect(store.state.characters.map((character) => character.name)).toEqual(['沈清', '证人']);
    expect(store.state.characters[1]?.hairstyle).toBe('符合人物身份的日常发型');
  });

  it('does not spend configured fallback calls on an empty character array', async () => {
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
    expect(calls).toBe(1);
  });

  it('demotes surplus primary characters instead of pausing for manual review', async () => {
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
      .resolves.toMatchObject({ kind: 'bible' });
    expect(characterCalls).toBe(1);
    expect(store.state.characters[4]?.role).toBe('minor');

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

    expect(characterCalls).toBe(1);
    expect(store.state.characters).toHaveLength(5);
    const history = await checkpoints.list('project-1', 'script_bible');
    expect(history.filter((checkpoint) => checkpoint.node === 'character_bible'))
      .toEqual([expect.objectContaining({ status: 'succeeded', artifactRevision: 0 })]);
  });

  it.each(['issues', 'newFacts', 'openedThreads', 'closedThreads', 'wardrobe'] as const)(
    'defaults missing review.%s locally without a repair call',
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
      expect(reviewCalls).toBe(1);
    },
  );

  it('uses the confirmed outline goal when review summary is missing', async () => {
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
    expect(reviewPrompts).toHaveLength(1);
    expect(store.state.episodes[0]?.summary).toBe(store.state.episodeOutlines[0]?.goal);
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
    expect(scenePlanCalls).toBe(1);
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

  it('stales an episode-draft-v3 checkpoint after the dialogue-safe v12 prompt upgrade', async () => {
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
      promptVersion: 'episode-draft-v3',
      configRevision: sourceDraft.configRevision,
    });
    const checkpoints = new InMemoryScriptCheckpointStore();
    await checkpoints.save(sourceScenePlan);
    await checkpoints.save({
      ...sourceDraft,
      artifact: {
        ...(sourceDraft.artifact as Record<string, unknown>),
        promptVersion: 'episode-draft-v3',
        inputFingerprint: legacyInputFingerprint,
      },
      promptVersion: 'episode-draft-v3',
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
        artifactRevision: 0, promptVersion: 'episode-draft-v3', status: 'stale',
      }),
      expect.objectContaining({
        artifactRevision: 1, promptVersion: 'episode-draft-v12', status: 'succeeded',
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
              code: 'CONTINUITY_CONTRADICTION',
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
        code: 'CONTINUITY_CONTRADICTION',
        severity: 'hard',
        source: 'ai',
        status: 'open',
      }),
    ]));
  });

  it('keeps at most three focused sanity issues and drops style noise and duplicates', async () => {
    const state = readySingleEpisodeState();
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
              summary: '', newFacts: [], openedThreads: [], closedThreads: [],
            });
          }
          if (request.node === 'review') {
            expect(request.prompt).toContain('issues 最多返回 3 条');
            expect(request.prompt).toContain('不要评价文风');
            return JSON.stringify({
              issues: [
                { code: 'CHARACTER_PRESENCE', severity: 'hard', message: '证人不在场却递出文件。', sceneId: 'scene-1' },
                { code: 'CHARACTER_PRESENCE', severity: 'hard', message: '证人不在场却递出文件。', sceneId: 'scene-1' },
                { code: 'STYLE_WEAK', severity: 'soft', message: '台词还可以更有网感。' },
                { code: 'PROP_CUSTODY', severity: 'hard', message: '账本交出后又回到原持有人手中。', sceneId: 'scene-1' },
                { code: 'KNOWLEDGE_TIMING', severity: 'hard', message: '主角提前知道尚未公开的密码。', sceneId: 'scene-1' },
                { code: 'CAUSAL_ORDER', severity: 'hard', message: '报警发生在发现尸体之前。', sceneId: 'scene-1' },
              ],
              summary: '沈清在校报社核查证据。',
              newFacts: [], openedThreads: [], closedThreads: [], wardrobe: [],
            });
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
      expectedPlanRevision: state.plan!.revision,
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    const aiIssues = store.state.reviewIssues.filter((issue) => issue.source === 'ai');
    expect(aiIssues.map((issue) => issue.code)).toEqual([
      'CHARACTER_PRESENCE',
      'PROP_CUSTODY',
      'KNOWLEDGE_TIMING',
    ]);
  });

  it('keeps safe partial writing and fixes up the only continuation when it is still too short', async () => {
    const state = readySingleEpisodeState();
    state.plan = {
      ...state.plan!,
      targetCharsPerEpisode: 1_200,
      dialogueDensityPercent: 60,
    };
    let baseDraftCalls = 0;
    let continuationCalls = 0;
    let reviewCalls = 0;
    const continuationLengths = [100, 500];
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            if (request.prompt.includes('episode_draft_continuation@v2')) {
              const length = continuationLengths[continuationCalls] ?? 100;
              continuationCalls += 1;
              return JSON.stringify({
                blocks: [{
                  sceneOrdinal: 1,
                  type: 'action',
                  text: exactScriptText(`续写推进${continuationCalls}`, length),
                }],
              });
            }
            baseDraftCalls += 1;
            expect(request.prompt).toContain('未登记的路人、记者、警察');
            expect(request.prompt).toContain('同一证据、照片、电话或动作在本集只能首次发现一次');
            expect(request.prompt).toContain('触发—反应—结果');
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
                  { type: 'action', text: exactScriptText('初稿调查动作', 277) },
                  {
                    type: 'dialogue',
                    characterId: 'lead',
                    speaker: '沈清',
                    text: exactScriptText('初稿调查对白', 228),
                  },
                  { type: 'action', text: '门外传来急促脚步声' },
                ],
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
              summary: '沈清核查证据，门外有人逼近。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    const result = await director.run({
      task: 'script_episode_batch',
      projectId: state.projectId,
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: state.plan.revision,
    });

    expect(result).toMatchObject({ kind: 'episode_batch' });
    if (result.kind !== 'episode_batch') throw new Error('expected episode batch');
    expect(result.callSummary).toMatchObject({
      totalCalls: 4,
      primaryCalls: 3,
      fixupCalls: 1,
      fallbackCalls: 0,
      byNode: { draft: 3, review: 1 },
      byEpisode: [{ episodeNumber: 1, calls: 4 }],
    });
    expect({ baseDraftCalls, continuationCalls, reviewCalls }).toEqual({
      baseDraftCalls: 1,
      continuationCalls: 2,
      reviewCalls: 1,
    });
    expect(result.callSummary.fixupCalls).toBe(1);
    const completed = store.state.episodes[0]!;
    const visibleChars = completed.scenes
      .flatMap((scene) => scene.blocks)
      .reduce((total, block) => total + block.text.replace(/\s/gu, '').length, 0);
    expect(visibleChars).toBeGreaterThanOrEqual(900);
    expect(visibleChars).toBeLessThan(1_200);
    expect(completed.status).toBe('completed');
    const draftHistory = (await checkpoints.list(
      state.projectId,
      'script_episode_batch:1:1',
    )).filter((checkpoint) => checkpoint.node === 'draft');
    expect(draftHistory.filter((checkpoint) => checkpoint.status === 'stale'))
      .toHaveLength(1);
    expect(draftHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifactRevision: 1,
        status: 'succeeded',
        promptVersion: 'episode-draft-v12',
      }),
    ]));
  });

  it('treats dialogue density and moderate length variation as advisory', async () => {
    const state = readySingleEpisodeState();
    let draftCalls = 0;
    let reviewCalls = 0;
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
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
                blocks: [{ type: 'action', text: exactScriptText('纯动作调查推进', 280) }],
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
              summary: '沈清在校报社独自核查证据。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    const result = await director.run({
      task: 'script_episode_batch',
      projectId: state.projectId,
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: state.plan!.revision,
    });

    expect({ draftCalls, reviewCalls }).toEqual({ draftCalls: 1, reviewCalls: 1 });
    expect(result).toMatchObject({ kind: 'episode_batch' });
    if (result.kind !== 'episode_batch') throw new Error('expected episode batch');
    expect(result.reports[0]?.report.blockingIssues).toEqual([]);
    expect(result.reports[0]?.report.advisoryIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DIALOGUE_DENSITY', severity: 'soft' }),
    ]));
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

  it('resumes from a saved base draft when the only continuation is interrupted', async () => {
    const state = readySingleEpisodeState();
    state.plan = { ...state.plan!, targetCharsPerEpisode: 1_200 };
    const checkpoints = new InMemoryScriptCheckpointStore();
    const store = new MemoryScriptStore(state);
    let baseDraftCalls = 0;
    let continuationCalls = 0;
    let reviewCalls = 0;
    let interruptFirstContinuation = true;
    const controller = new AbortController();
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            if (request.prompt.includes('episode_draft_continuation@v2')) {
              continuationCalls += 1;
              if (interruptFirstContinuation && continuationCalls === 1) {
                interruptFirstContinuation = false;
                controller.abort();
                const error = new Error('cancelled during continuation');
                error.name = 'AbortError';
                throw error;
              }
              const length = 450;
              return JSON.stringify({
                blocks: [{
                  sceneOrdinal: 1,
                  type: 'action',
                  text: exactScriptText(`续写断点${continuationCalls}`, length),
                }],
              });
            }
            baseDraftCalls += 1;
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
                  { type: 'action', text: exactScriptText('可恢复基稿动作', 280) },
                  {
                    type: 'dialogue',
                    characterId: 'lead',
                    speaker: '沈清',
                    text: exactScriptText('可恢复基稿对白', 220),
                  },
                ],
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
              summary: '沈清保留证据并继续推进调查。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });
    const request = {
      task: 'script_episode_batch' as const,
      projectId: state.projectId,
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: state.plan.revision,
    };

    await expect(director.run({ ...request, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect({ baseDraftCalls, continuationCalls, reviewCalls }).toEqual({
      baseDraftCalls: 1,
      continuationCalls: 1,
      reviewCalls: 0,
    });
    expect(store.state.episodes).toEqual([]);

    await expect(director.run(request)).resolves.toMatchObject({ kind: 'episode_batch' });
    expect({ baseDraftCalls, continuationCalls, reviewCalls }).toEqual({
      baseDraftCalls: 1,
      continuationCalls: 2,
      reviewCalls: 1,
    });
    const completed = store.state.episodes[0]!;
    const combined = completed.scenes
      .flatMap((scene) => scene.blocks)
      .map((block) => block.text)
      .join('');
    expect(combined).not.toContain('续写断点1');
    expect(combined).toContain('续写断点2');
    expect(completed.status).toBe('completed');
  });

  it('keeps a valid base draft when continuation output is unusable', async () => {
    const state = readySingleEpisodeState();
    state.plan = { ...state.plan!, targetCharsPerEpisode: 1_200 };
    let baseDraftCalls = 0;
    let continuationCalls = 0;
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            if (request.prompt.includes('episode_draft_continuation@v2')) {
              continuationCalls += 1;
              return JSON.stringify({ blocks: [] });
            }
            baseDraftCalls += 1;
            return JSON.stringify({
              episodeNumber: 1,
              title: '第一集',
              scenes: [{
                ordinal: 1,
                location: '校报社',
                timeOfDay: 'day',
                interiorExterior: 'interior',
                characterIds: ['lead'],
                blocks: balancedDraftBlocks(500),
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
              summary: '沈清开始调查。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    const result = await director.run({
      task: 'script_episode_batch',
      projectId: state.projectId,
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: state.plan.revision,
    });

    expect({ baseDraftCalls, continuationCalls }).toEqual({
      baseDraftCalls: 1,
      continuationCalls: 2,
    });
    expect(result).toMatchObject({ kind: 'episode_batch' });
    if (result.kind !== 'episode_batch') throw new Error('expected episode batch');
    expect(result.reports[0]?.report.advisoryIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TOO_SHORT', severity: 'soft' }),
    ]));
    expect(store.state.episodes[0]?.status).toBe('completed');
    expect(store.state.episodes[0]?.scenes.flatMap((scene) => scene.blocks))
      .toHaveLength(2);
  });
  it('keeps a missing scene-cast entry advisory without spending revision calls', async () => {
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
              operations: revisionCalls === 1 ? [] : [{
                  op: 'updateSceneCharacters',
                  sceneId: current.scenes[0]!.id,
                  characterIds: ['lead', 'witness'],
                }],
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

    expect({ revisionCalls, reviewCalls }).toEqual({ revisionCalls: 0, reviewCalls: 1 });
    expect(revisionPrompts).toEqual([]);
    expect(store.state.episodes[0]?.scenes[0]?.characterIds).toEqual(['lead']);
    expect(store.state.episodes[0]?.status).toBe('completed');
  });

  it('keeps wrapper pollution advisory and completes without a revision', async () => {
    const state = readySingleEpisodeState();
    const candidate = reviewingEpisode(state, '△沈清闯进校报社。');
    state.episodes = [candidate];
    let reviewCalls = 0;
    let revisionCalls = 0;
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          if (request.node === 'revision') {
            revisionCalls += 1;
            return JSON.stringify({
              operations: [{
                op: 'replaceBlockText',
                sceneId: candidate.scenes[0]!.id,
                blockId: candidate.scenes[0]!.blocks[0]!.id,
                text: '沈清推门闯进校报社，把录音笔按在桌面上。',
              }],
            });
          }
          if (request.node === 'review') {
            reviewCalls += 1;
            return JSON.stringify({
              issues: [],
              summary: '沈清带着录音证据闯进校报社。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          if (request.node === 'draft') throw new Error('reviewing fixture must skip draft');
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    const result = await director.run({
      task: 'script_episode_batch',
      projectId: state.projectId,
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: state.plan!.revision,
    });

    expect(result).toMatchObject({ kind: 'episode_batch' });
    expect({ reviewCalls, revisionCalls }).toEqual({ reviewCalls: 1, revisionCalls: 0 });
    expect(store.state.episodes[0]?.status).toBe('completed');
    expect(store.state.episodes[0]?.scenes[0]?.blocks[0]?.text)
      .toBe('△沈清闯进校报社。');
    expect(store.saveEpisodeCalls).toHaveLength(0);
    expect(store.atomicCommitCalls).toHaveLength(1);
  });
  it('keeps an overlong but structurally valid episode as advisory instead of rewriting it', async () => {
    const state = readySingleEpisodeState();
    state.episodes = [reviewingEpisode(state, '超长'.repeat(300), { title: '偏长候选' })];
    let reviewCalls = 0;
    let revisionCalls = 0;
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
              summary: '沈清详细梳理了全部证据。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            throw new Error('length advice must not trigger revision');
          }
          if (request.node === 'draft') throw new Error('reviewing fixture must skip draft');
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
    });

    const result = await director.run({
      task: 'script_episode_batch',
      projectId: state.projectId,
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: state.plan!.revision,
    });

    expect({ reviewCalls, revisionCalls }).toEqual({ reviewCalls: 1, revisionCalls: 0 });
    expect(result).toMatchObject({ kind: 'episode_batch' });
    if (result.kind !== 'episode_batch') throw new Error('expected episode batch');
    expect(result.reports[0]?.report.advisoryIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TOO_LONG', severity: 'soft' }),
    ]));
    expect(result.reports[0]?.report.blockingIssues).toEqual([]);
    expect(store.state.episodes[0]?.status).toBe('completed');
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

  it('does not enter revision for advisory wrapper pollution', async () => {
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
    })).resolves.toMatchObject({ kind: 'episode_batch' });
    expect(store.state.episodes[0]?.status).toBe('completed');
    expect(store.atomicCommitCalls).toHaveLength(1);
    const history = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    expect(history.some((checkpoint) => checkpoint.node === 'revision')).toBe(false);
  });

  it('commits usable content without invoking an invalid advisory revision', async () => {
    const state = readySingleEpisodeState();
    const candidate = reviewingEpisode(state, '△沈清冲进校报社。');
    state.episodes = [structuredClone(candidate)];
    let revisionCalls = 0;
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          if (request.node === 'review') {
            return JSON.stringify({
              issues: [],
              summary: '沈清闯进校报社。',
              newFacts: [],
              openedThreads: [],
              closedThreads: [],
              wardrobe: [],
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            return JSON.stringify({
              operations: [{
                op: 'appendBlock',
                sceneId: candidate.scenes[0]!.id,
                block: { type: 'action', text: '无关补写' },
              }],
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

    expect(revisionCalls).toBe(0);
    expect(store.state.episodes[0]?.status).toBe('completed');
    expect(store.atomicCommitCalls).toHaveLength(1);
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

  it('preserves the completed episode and review ledger when an explicit rewrite returns no body', async () => {
    const state = readySingleEpisodeState();
    const oldEpisode: ScriptEpisode = {
      ...reviewingEpisode(state, '这是必须保留的旧正文。'.repeat(20), { revision: 3 }),
      status: 'completed',
      summary: '旧稿摘要',
    };
    state.episodes = [oldEpisode];
    state.reviewRevision = 1;
    state.reviewIssues = [{
      id: 'old-review-1',
      projectId: 'project-1',
      episodeNumber: 1,
      code: 'OLD_NOTE',
      severity: 'soft',
      category: 'continuity',
      message: '旧稿上的人工备注。',
      status: 'open',
      source: 'user',
      createdAt: state.updatedAt,
      updatedAt: state.updatedAt,
    }];
    const originalEpisode = structuredClone(oldEpisode);
    const originalIssues = structuredClone(state.reviewIssues);
    const director = new ScriptDirector({
      model: { complete: async () => '' },
      store: new MemoryScriptStore(state),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
      draftMode: 'direct_text',
      regenerate: true,
    })).rejects.toMatchObject({ code: 'SCRIPT_MODEL_OUTPUT_INVALID' });

    expect(state.episodes).toEqual([originalEpisode]);
    expect(state.reviewRevision).toBe(1);
    expect(state.reviewIssues).toEqual(originalIssues);
  });

  it('uses the current series card and user instruction instead of blindly repeating an old episode', async () => {
    const state = readySingleEpisodeState();
    state.episodeOutlines[0] = {
      ...state.episodeOutlines[0]!,
      goal: '旧详细大纲目标：寻找旧账本',
      conflict: '旧详细大纲冲突：保安锁门',
      beats: ['旧详细大纲节拍'],
      endingHook: '旧详细大纲钩子',
    };
    state.seriesOutline = {
      ...state.seriesOutline!,
      revision: 2,
      episodeCards: [{
        episodeNumber: 1,
        title: '新总纲第一集',
        logline: '新总纲目标：追查直播证据',
        mainEvent: '新总纲事件：证人在直播前交出手机',
        endingHook: '新总纲钩子：手机自动播放录音',
      }],
    };
    state.episodes = [{
      ...reviewingEpisode(state, '旧正文必须在新稿成功前保留。'.repeat(20), { revision: 3 }),
      status: 'completed',
      summary: '旧稿摘要',
    }];
    const draftPrompts: string[] = [];
    const modelNodes: string[] = [];
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          modelNodes.push(request.node);
          if (request.node === 'draft') {
            draftPrompts.push(request.prompt);
            return directScriptText();
          }
          if (request.node === 'review') return directReviewJson();
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
      store: new MemoryScriptStore(state),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
      draftMode: 'direct_text',
      regenerate: true,
      rewriteInstruction: '保留第一场，只把结尾改成沈清发现手机里的录音。',
    });

    expect(modelNodes).toEqual(['draft', 'review']);
    expect(draftPrompts).toHaveLength(1);
    expect(draftPrompts[0]).toContain('新总纲事件：证人在直播前交出手机');
    expect(draftPrompts[0]).toContain('新总纲钩子：手机自动播放录音');
    expect(draftPrompts[0]).toContain('保留第一场，只把结尾改成沈清发现手机里的录音。');
    expect(draftPrompts[0]).toContain('旧正文必须在新稿成功前保留。');
    expect(draftPrompts[0]).not.toContain('旧详细大纲目标：寻找旧账本');
    expect(draftPrompts[0]).not.toContain('旧详细大纲冲突：保安锁门');
  });

  it('rewrites one existing episode outside a five-episode boundary', async () => {
    const state = readySingleEpisodeState();
    state.plan = approvedPlan(2);
    state.seriesOutline = {
      ...state.seriesOutline!,
      episodeCards: [
        state.seriesOutline!.episodeCards[0]!,
        { episodeNumber: 2, title: '第二集', logline: '核验证词。', mainEvent: '沈清找到矛盾证词。', endingHook: '证人改口。' },
      ],
    };
    state.episodeOutlines.push({
      ...state.episodeOutlines[0]!,
      id: 'outline-2',
      episodeNumber: 2,
      title: '第二集',
      goal: '核验证词',
      endingHook: '证人改口',
    });
    const firstEpisode = {
      ...reviewingEpisode(state, '第一集已经发生的调查。'.repeat(20), { revision: 1 }),
      status: 'completed' as const,
      summary: '沈清取得第一份证据。',
    };
    const secondEpisode = {
      ...reviewingEpisode(state, '第二集需要修改的旧正文。'.repeat(20), { revision: 2 }),
      id: 'candidate-episode-2',
      episodeNumber: 2,
      outlineId: 'outline-2',
      title: '第二集',
      status: 'completed' as const,
      summary: '旧稿里证人直接认罪。',
      scenes: reviewingEpisode(state, '第二集需要修改的旧正文。'.repeat(20)).scenes.map((scene) => ({
        ...scene,
        id: 'candidate-scene-2',
        blocks: scene.blocks.map((block) => ({ ...block, id: 'candidate-block-2' })),
      })),
    };
    state.episodes = [firstEpisode, secondEpisode];
    state.continuityCommits = [{
      id: 'continuity-1',
      schemaVersion: 1,
      projectId: state.projectId,
      episodeNumber: 1,
      episodeRevision: 1,
      revision: 1,
      status: 'current',
      inputFingerprint: 'a'.repeat(64),
      characterUpdates: [], factsAdded: [], props: [], threads: [], timelineEvents: [],
      nextEpisodeMustInherit: [],
      createdAt: state.updatedAt,
      updatedAt: state.updatedAt,
    }];
    const prompts: string[] = [];
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            prompts.push(request.prompt);
            return directScriptText({ episodeNumber: 2 });
          }
          if (request.node === 'review') return directReviewJson({ summary: '沈清找到证词矛盾，证人突然改口。' });
          throw new Error(`unexpected node: ${request.node}`);
        },
      },
      store: new MemoryScriptStore(state),
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 2,
      episodeCount: 1,
      expectedPlanRevision: 1,
      draftMode: 'direct_text',
      regenerate: true,
      rewriteInstruction: '保留调查结果，把证人认罪改成证人突然改口。',
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect(prompts[0]).toContain('把证人认罪改成证人突然改口');
    expect(prompts[0]).toContain('第二集需要修改的旧正文');
    expect(state.episodes.find((episode) => episode.episodeNumber === 2)?.revision).toBe(3);
  });

  it('does not replace the review ledger when the episode CAS fails', async () => {
    const state = readySingleEpisodeState();
    const oldEpisode: ScriptEpisode = {
      ...reviewingEpisode(state, '这是并发冲突时必须保留的旧正文。'.repeat(20), { revision: 3 }),
      status: 'completed',
      summary: '并发前旧稿摘要',
    };
    state.episodes = [oldEpisode];
    state.reviewRevision = 1;
    state.reviewIssues = [{
      id: 'old-ai-review-1',
      projectId: 'project-1',
      episodeNumber: 1,
      code: 'OLD_AI_NOTE',
      severity: 'soft',
      category: 'continuity',
      message: '旧稿的 AI 审查记录。',
      status: 'open',
      source: 'ai',
      createdAt: state.updatedAt,
      updatedAt: state.updatedAt,
    }];
    const originalIssues = structuredClone(state.reviewIssues);
    class ConflictBeforeCommitStore extends MemoryScriptStore {
      override async commitEpisodeWithContinuity(
        input: ScriptCommitEpisodeWithContinuityInput,
      ): Promise<ScriptCommitEpisodeWithContinuityResult> {
        const current = this.state.episodes.find(
          (episode) => episode.episodeNumber === input.episode.episodeNumber,
        );
        if (current) current.revision += 1;
        return super.commitEpisodeWithContinuity(input);
      }
    }
    const store = new ConflictBeforeCommitStore(state);
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          return request.node === 'review' ? directReviewJson() : directScriptText();
        },
      },
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await expect(director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
      draftMode: 'direct_text',
      regenerate: true,
    })).rejects.toBeInstanceOf(ScriptConflictError);

    expect(state.reviewRevision).toBe(1);
    expect(state.reviewIssues).toEqual(originalIssues);
    expect(state.episodes[0]).toMatchObject({
      summary: '并发前旧稿摘要',
      scenes: oldEpisode.scenes,
    });
  });

  it('writes directly from the existing episode card without generating a detailed outline', async () => {
    const state = readySingleEpisodeState();
    state.episodeOutlines = [];
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const calls: Array<{ node: string; responseFormat?: string }> = [];
    const model: ScriptModelAdapter = {
      async complete(request) {
        calls.push({ node: request.node, responseFormat: request.responseFormat });
        return request.node === 'review' ? directReviewJson() : directScriptText();
      },
      async getModelConfigFingerprint() { return 'direct-model-v1'; },
    };
    const director = new ScriptDirector({ model, store, checkpoints });

    const result = await director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(result.kind).toBe('episode_batch');
    if (result.kind !== 'episode_batch') throw new Error('unexpected result');
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]).toMatchObject({
      status: 'completed',
      episodeNumber: 1,
      summary: '沈清核对记录并取得能推进调查的证据。',
    });
    expect(calls).toEqual([
      { node: 'draft', responseFormat: 'text' },
      { node: 'review', responseFormat: 'json' },
    ]);
    expect(result.callSummary.totalCalls).toBe(2);
    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(store.saveEpisodeCalls).toHaveLength(0);
    const savedCheckpoints = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    expect(savedCheckpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ node: 'direct_draft', status: 'succeeded' }),
      expect.objectContaining({ node: 'handoff_review', status: 'succeeded' }),
      expect.objectContaining({ node: 'completed', status: 'succeeded' }),
    ]));
  });

  it('asks the model to rewrite a complete overlong episode instead of clipping it', async () => {
    const state = readySingleEpisodeState();
    state.plan = { ...state.plan!, targetCharsPerEpisode: 1_200 };
    const store = new MemoryScriptStore(state);
    const calls: Array<{ node: string; prompt: string }> = [];
    const overlongDraft = [
      '第1集',
      '1-1 校报社 日/内',
      '人物：沈清',
      `△${'沈清核对桌上的采访记录。'.repeat(40)}`,
      `沈清：${'证据还差最后一环，现在不能停。'.repeat(100)}`,
      `△${'门外的新证人敲响玻璃门。'.repeat(35)}`,
    ].join('\n');
    const conciseCompleteDraft = [
      '第1集',
      '1-1 校报社 日/内',
      '人物：沈清',
      `△${'沈清核对桌上的采访记录。'.repeat(25)}`,
      `沈清：${'证据还差最后一环，现在不能停。'.repeat(30)}`,
      `△${'门外的新证人敲响玻璃门。'.repeat(25)}`,
    ].join('\n');
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          calls.push({ node: request.node, prompt: request.prompt });
          if (request.node === 'review') return directReviewJson();
          if (request.node === 'revision') return conciseCompleteDraft;
          return overlongDraft;
        },
      },
    });

    const result = await director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(result.kind).toBe('episode_batch');
    const saved = store.state.episodes[0]!;
    const visibleChars = saved.scenes
      .flatMap((scene) => scene.blocks)
      .map((block) => block.text)
      .join('')
      .replace(/\s/gu, '').length;
    expect(visibleChars).toBeGreaterThanOrEqual(1_000);
    expect(visibleChars).toBeLessThanOrEqual(1_400);
    expect(saved.scenes[0]?.blocks.every((block) => !block.text.endsWith('…'))).toBe(true);
    expect(calls.map((call) => call.node)).toEqual(['draft', 'review', 'revision', 'review']);
    expect(calls[0]?.prompt).toContain('1000—1400 字');
    expect(calls[0]?.prompt).toContain('绝不能把一句话写一半后用省略号代替未写内容');
    expect(calls[2]?.prompt).toContain('LENGTH_OUT_OF_RANGE');
    expect(calls[2]?.prompt).toContain('禁止截断原稿');
  });

  it('repairs duplicate scene ordinals and saves the direct draft without a format-repair call', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const calls: string[] = [];
    const repeatedSceneText = [
      '第1集',
      '1-1 校报社 日/内',
      '人物：沈清',
      `△${'沈清核对录音笔里的原始时间戳。'.repeat(6)}`,
      `沈清：${'这份记录能证明证据从未离开档案室。'.repeat(6)}`,
      '1-1 档案室 日/内',
      '人物：沈清',
      `△${'沈清找到与时间戳对应的纸质登记表。'.repeat(6)}`,
      `沈清：${'登记表和录音能够相互印证。'.repeat(6)}`,
      '1-2 校报社走廊 夜/内',
      '人物：沈清',
      `△${'沈清把两份证据装进档案袋并贴好封条。'.repeat(6)}`,
      `沈清：${'明天公开之前不能让原件离开视线。'.repeat(6)}`,
    ].join('\n');
    const director = new ScriptDirector({
      model: {
        async complete(request) {
          calls.push(request.node);
          return request.node === 'review' ? directReviewJson() : repeatedSceneText;
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
      store,
      checkpoints,
    });

    const result = await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(result.kind).toBe('episode_batch');
    expect(calls).toEqual(['draft', 'review', 'revision', 'review']);
    expect(store.state.episodes[0]?.scenes.map((scene) => scene.ordinal)).toEqual([1, 2, 3]);
    expect(store.atomicCommitCalls).toHaveLength(1);
    const directDraft = (await checkpoints.list('project-1', 'script_episode_batch:1:1'))
      .find((checkpoint) => checkpoint.node === 'direct_draft');
    expect(directDraft).toMatchObject({
      status: 'succeeded',
      validationErrors: [
        expect.objectContaining({ code: 'SCENE_ORDINAL_REPAIRED' }),
        expect.objectContaining({ code: 'SCENE_ORDINAL_REPAIRED' }),
      ],
    });
  });

  it('stores an unparseable direct draft and changes the prompt on explicit resume', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const draftPrompts: string[] = [];
    let draftCalls = 0;
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'review') return directReviewJson();
          draftCalls += 1;
          draftPrompts.push(request.prompt);
          return draftCalls <= 4
            ? '这是创作说明，没有剧本场景头。'
            : directScriptText();
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    const request = {
      task: 'script_episode_batch' as const,
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
      draftMode: 'direct_text' as const,
    };
    await expect(director.run(request)).resolves.toMatchObject({ kind: 'episode_batch' });
    expect(draftCalls).toBe(2);
    expect(store.atomicCommitCalls).toHaveLength(1);
    const directDraftHistory = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    expect(directDraftHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: 'direct_draft', status: 'succeeded', artifactRevision: 0,
      }),
    ]));
  });

  it('uses a recovery prompt for a legacy failed job that has no rejected checkpoint', async () => {
    const state = readySingleEpisodeState();
    const checkpoints = new InMemoryScriptCheckpointStore();
    const prompts: string[] = [];
    let draftCalls = 0;
    const director = new ScriptDirector({
      store: new MemoryScriptStore(state),
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'review') return directReviewJson();
          draftCalls += 1;
          prompts.push(request.prompt);
          return draftCalls <= 2
            ? '这是创作说明，没有剧本场景头。'
            : directScriptText();
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    const request = {
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
      draftMode: 'direct_text',
      resumeRejectedCandidates: true,
    } as const;
    await expect(director.run(request)).resolves.toMatchObject({ kind: 'episode_batch' });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('显式恢复重写（第 1 次）');
    expect(new Set(prompts)).toHaveLength(2);
  });

  it('advances recovery for a rejected checkpoint written before recovery metadata existed', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const seededCheckpoints = new InMemoryScriptCheckpointStore();
    const request = {
      task: 'script_episode_batch' as const,
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
      draftMode: 'direct_text' as const,
      resumeRejectedCandidates: true,
    };
    const seedDirector = new ScriptDirector({
      store,
      checkpoints: seededCheckpoints,
      model: {
        async complete() { return '这是创作说明，没有剧本场景头。'; },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });
    await expect(seedDirector.run(request)).resolves.toMatchObject({ kind: 'episode_batch' });
    const seededHistory = await seededCheckpoints.list('project-1', 'script_episode_batch:1:1');
    expect(seededHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ node: 'direct_draft', status: 'succeeded' }),
    ]));
  });

  it('finishes with a local editable draft and handoff when draft and review calls fail', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          throw new Error(`${request.node} provider timeout`);
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch',
      projectId: 'project-1',
      startEpisode: 1,
      episodeCount: 1,
      expectedPlanRevision: 1,
      draftMode: 'direct_text',
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect(store.state.episodes[0]).toMatchObject({
      episodeNumber: 1,
      status: 'completed',
      scenes: [expect.objectContaining({ blocks: expect.arrayContaining([
        expect.objectContaining({ type: 'action' }),
      ]) })],
    });
    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(await checkpoints.list('project-1', 'script_episode_batch:1:1'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ node: 'direct_draft', status: 'succeeded' }),
        expect.objectContaining({ node: 'handoff_review', status: 'succeeded' }),
        expect.objectContaining({ node: 'completed', status: 'succeeded' }),
      ]));
  });

  it('writes a five-episode direct-text batch in order with ten model calls and a continuity chain', async () => {
    const state = readySingleEpisodeState();
    state.plan = approvedPlan(5);
    state.seriesOutline = {
      ...state.seriesOutline!,
      episodeCards: Array.from({ length: 5 }, (_, index) => ({
        episodeNumber: index + 1,
        title: `第${index + 1}集`,
        logline: `调查推进到第${index + 1}步。`,
        mainEvent: `取得第${index + 1}份证据。`,
        endingHook: `第${index + 1}条新线索出现。`,
      })),
    };
    state.episodeOutlines = [];
    const calls: Array<{ node: string; episodeNumber?: number }> = [];
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          calls.push({ node: request.node, episodeNumber: request.episodeNumber });
          return request.node === 'review'
            ? directReviewJson({ summary: `第${request.episodeNumber}集调查完成。` })
            : directScriptText({ episodeNumber: request.episodeNumber });
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    const result = await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 5, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(result.kind).toBe('episode_batch');
    if (result.kind !== 'episode_batch') throw new Error('unexpected result');
    expect(result.episodes.map((episode) => episode.episodeNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(result.callSummary.totalCalls).toBe(10);
    expect(calls.map((call) => call.node)).toEqual([
      'draft', 'review', 'draft', 'review', 'draft', 'review', 'draft', 'review', 'draft', 'review',
    ]);
    const continuityCommits = store.state.continuityCommits ?? [];
    expect(continuityCommits).toHaveLength(5);
    expect(continuityCommits.map((commit) => commit.episodeNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(store.atomicCommitCalls).toHaveLength(5);
  });

  it('continues a clearly short direct draft exactly once without rewriting the base', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    let draftCalls = 0;
    const model: ScriptModelAdapter = {
      async complete(request) {
        if (request.node === 'review') return directReviewJson();
        draftCalls += 1;
        return draftCalls === 1
          ? directScriptText({ actionChars: 45, dialogueChars: 55 })
          : [
              '1-1 校报社 日/内',
              '人物：沈清',
              `△${'沈清继续比对备份记录确认时间戳没有被替换。'.repeat(4)}`,
              `沈清：${'这条线索还缺最后一名证人的签字。'.repeat(5)}`,
            ].join('\n');
      },
      async getModelConfigFingerprint() { return 'direct-model-v1'; },
    };
    const director = new ScriptDirector({ model, store, checkpoints });

    const result = await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(result.kind).toBe('episode_batch');
    expect(draftCalls).toBe(2);
    expect(store.state.episodes[0]?.scenes[0]?.blocks.length).toBe(4);
    const savedCheckpoints = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    expect(savedCheckpoints.filter((item) => item.node === 'continuation')).toHaveLength(1);
  });

  it('rewrites an obvious genre drift once and rechecks the rewritten episode', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const calls: string[] = [];
    let reviewCalls = 0;
    const model: ScriptModelAdapter = {
      async complete(request) {
        calls.push(request.node);
        if (request.node === 'draft') {
          return directScriptText({ location: '市体育馆篮球场', dialogue: '这场篮球赛我们一定要赢。'.repeat(14) });
        }
        if (request.node === 'review') {
          reviewCalls += 1;
          if (reviewCalls > 1) return directReviewJson();
          return directReviewJson({
            verdict: 'major_issue',
            issues: [{
              code: 'WRONG_GENRE_OR_SETTING',
              sceneNumber: 1,
              evidence: '正文把校园调查写成篮球比赛。',
              expected: '本集应在校报社调查证据。',
            }],
          });
        }
        return directScriptText({ location: '校报社', dialogue: '时间戳和采访记录能够相互印证。'.repeat(14) });
      },
      async getModelConfigFingerprint() { return 'direct-model-v1'; },
    };
    const director = new ScriptDirector({
      model,
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(calls).toEqual(['draft', 'review', 'revision', 'review']);
    expect(store.state.episodes[0]?.scenes[0]?.location).toBe('校报社');
    expect(JSON.stringify(store.state.episodes[0])).not.toContain('篮球');
    expect(store.atomicCommitCalls).toHaveLength(1);
  });

  it('rewrites a repeated prop-action chain once even when the AI review passes', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const calls: string[] = [];
    const revisionPrompts: string[] = [];
    const repeatedDraft = [
      '第1集',
      '1-1 校报社 日/内',
      '人物：沈清',
      '△沈清打开档案柜抽屉，取出一张旧照片。',
      '△她检查照片和旁边的登记表，随后把照片放回并关上抽屉。',
      `沈清：${'这张照片能证明当年还有第三个人在场。'.repeat(10)}`,
      '△沈清接到电话后走到窗边，背对长桌。',
      '△校报记者走到桌前，重新打开档案柜抽屉，拿出同一张照片。',
      '△他盯着照片和登记表看了许久，又把照片收回抽屉。',
      `沈清：${'先查清登记表上的日期，再去找照片里的人。'.repeat(10)}`,
    ].join('\n');
    const model: ScriptModelAdapter = {
      async complete(request) {
        calls.push(request.node);
        if (request.node === 'draft') return repeatedDraft;
        if (request.node === 'revision') {
          revisionPrompts.push(request.prompt);
          return directScriptText({ dialogue: '登记表上的日期指向了下一名证人。'.repeat(14) });
        }
        return directReviewJson();
      },
      async getModelConfigFingerprint() { return 'direct-model-v1'; },
    };
    const director = new ScriptDirector({
      model,
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
    });

    await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(calls).toEqual(['draft', 'review', 'revision', 'review']);
    expect(revisionPrompts[0]).toContain('DUPLICATE_MAJOR_EVENT');
    expect(revisionPrompts[0]).toContain('保留第一次完整动作链');
    expect(JSON.stringify(store.state.episodes[0])).not.toContain('重新打开档案柜抽屉');
    expect(store.atomicCommitCalls).toHaveLength(1);
  });

  it('rewrites a scene replayed from an earlier episode without adding a review call', async () => {
    const state = readySingleEpisodeState();
    state.plan = { ...state.plan!, totalEpisodes: 6 };
    state.seriesOutline = {
      ...state.seriesOutline!,
      episodeCards: Array.from({ length: 6 }, (_, index) => ({
        episodeNumber: index + 1,
        title: `第${index + 1}集`,
        logline: index === 5 ? '继续调查。' : '推进已有调查。',
        mainEvent: index === 5 ? '找到新证人。' : `取得第${index + 1}份证据。`,
        endingHook: index === 5 ? '证人现身。' : `第${index + 1}条线索出现。`,
      })),
    };
    state.episodeOutlines = [{
      ...state.episodeOutlines[0]!,
      id: 'outline-6',
      episodeNumber: 6,
      title: '第六集',
      goal: '找到新证人',
      endingHook: '证人现身',
    }];
    state.episodes = Array.from({ length: 5 }, (_, index): ScriptEpisode => {
      const episodeNumber = index + 1;
      const baseEpisode = reviewingEpisode(state, `第${episodeNumber}集旧正文`);
      return {
        ...baseEpisode,
        id: `episode-${episodeNumber}`,
        episodeNumber,
        title: `第${episodeNumber}集`,
        outlineId: `outline-${episodeNumber}`,
        status: 'completed',
        summary: episodeNumber === 1
          ? '沈清从档案柜取出旧照片和登记表，确认照片上的时间。'
          : `第${episodeNumber}集推进新的调查。`,
        scenes: [{
          ...baseEpisode.scenes[0]!,
          id: `old-scene-${episodeNumber}`,
          blocks: episodeNumber === 1
            ? [
                { id: 'old-1', type: 'action', text: '沈清打开档案柜抽屉，取出一张旧照片。' },
                { id: 'old-2', type: 'action', text: '她检查照片和旁边的登记表，随后把照片放回并关上抽屉。' },
              ]
            : [{ id: `old-${episodeNumber}`, type: 'action', text: `沈清完成第${episodeNumber}步调查并前往新地点。` }],
        }],
      };
    });
    state.continuityCommits = state.episodes.map((episode, index) => ({
      id: `continuity-${episode.episodeNumber}`,
      schemaVersion: 1 as const,
      projectId: state.projectId,
      episodeNumber: episode.episodeNumber,
      episodeRevision: episode.revision,
      revision: index + 1,
      status: 'current' as const,
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
    const store = new MemoryScriptStore(state);
    const calls: string[] = [];
    const revisionPrompts: string[] = [];
    const replayedDraft = [
      '第6集',
      '6-1 校报社 日/内',
      '人物：沈清',
      '△沈清重新打开档案柜抽屉，拿出那张旧照片。',
      '△她再次查看照片和登记表，随后把照片收回并关上抽屉。',
      `沈清：${'照片上的时间能证明当晚还有其他人在场。'.repeat(12)}`,
    ].join('\n');
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          calls.push(request.node);
          if (request.node === 'draft') return replayedDraft;
          if (request.node === 'revision') {
            revisionPrompts.push(request.prompt);
            return directScriptText({
              episodeNumber: 6,
              dialogue: '沿着登记表的新地址，我们现在去找证人。'.repeat(14),
            });
          }
          return directReviewJson();
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 6, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(calls).toEqual(['draft', 'review', 'revision', 'review']);
    expect(revisionPrompts[0]).toContain('重复了第 1 集');
    expect(revisionPrompts[0]).toContain('priorEpisodeHistory');
    expect(JSON.stringify(store.state.episodes.find((item) => item.episodeNumber === 6)))
      .not.toContain('重新打开档案柜抽屉');
    expect(store.atomicCommitCalls).toHaveLength(1);
  });

  it('records a remaining post-rewrite issue as advisory and still commits', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const calls: string[] = [];
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          calls.push(request.node);
          if (request.node === 'draft') {
            return directScriptText({ location: '市体育馆篮球场', dialogue: '这场篮球赛我们一定要赢。'.repeat(14) });
          }
          if (request.node === 'revision') {
            return directScriptText({ location: '校报社', dialogue: '时间戳和采访记录能够相互印证。'.repeat(14) });
          }
          return directReviewJson({
            verdict: 'major_issue',
            issues: [{
              code: 'CAUSAL_CONTRADICTION',
              sceneNumber: 1,
              evidence: '重写稿仍然先宣布结论，后展示证据。',
              expected: '必须先核验证据再得出结论。',
            }],
          });
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect(calls).toEqual(['draft', 'review', 'revision', 'review']);
    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(store.state.episodes[0]?.status).toBe('completed');
  });

  it('keeps a still-imperfect rewrite editable without a rejected-resume loop', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    let draftCalls = 0;
    let revisionCalls = 0;
    let reviewCalls = 0;
    const revisionPrompts: string[] = [];
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            draftCalls += 1;
            return directScriptText({
              location: '市体育馆篮球场',
              dialogue: '这场篮球赛我们一定要赢。'.repeat(14),
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            revisionPrompts.push(request.prompt);
            return revisionCalls === 1
              ? directScriptText({
                  location: '市体育馆篮球场',
                  dialogue: '这场篮球赛我们一定要赢。'.repeat(14),
                })
              : directScriptText({
                  location: '校报社',
                  dialogue: '时间戳和采访记录能够相互印证。'.repeat(14),
                });
          }
          reviewCalls += 1;
          if (reviewCalls === 3) return directReviewJson();
          return directReviewJson({
            verdict: 'major_issue',
            issues: [{
              code: 'WRONG_GENRE_OR_SETTING',
              sceneNumber: 1,
              evidence: '正文仍然写成篮球比赛。',
              expected: '本集应在校报社调查证据。',
            }],
          });
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    const result = await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(result.kind).toBe('episode_batch');
    expect(draftCalls).toBe(1);
    expect(revisionCalls).toBe(1);
    expect(reviewCalls).toBe(2);
    expect(revisionPrompts[0]).toContain('原正文');
    expect(store.state.episodes[0]?.scenes[0]?.location).toBe('市体育馆篮球场');
    expect(store.atomicCommitCalls).toHaveLength(1);
  });

  it('formats and adopts a recognizable rewrite instead of silently keeping the rejected draft', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    let revisionCalls = 0;
    let reviewCalls = 0;
    const fixed = directScriptText({
      location: '校报社',
      dialogue: '时间戳和采访记录能够相互印证。'.repeat(14),
    });
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            return directScriptText({
              location: '市体育馆篮球场',
              dialogue: '这场篮球赛我们一定要赢。'.repeat(14),
            });
          }
          if (request.node === 'revision') {
            revisionCalls += 1;
            return revisionCalls === 1 ? `以下是改写稿：\n${fixed}` : fixed;
          }
          reviewCalls += 1;
          return reviewCalls === 1
            ? directReviewJson({
                verdict: 'major_issue',
                issues: [{
                  code: 'WRONG_GENRE_OR_SETTING',
                  sceneNumber: 1,
                  evidence: '正文写成篮球比赛。',
                  expected: '本集应在校报社调查证据。',
                }],
              })
            : directReviewJson();
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(revisionCalls).toBe(1);
    expect(store.state.episodes[0]?.scenes.some((scene) => scene.location === '校报社')).toBe(true);
    expect(store.atomicCommitCalls).toHaveLength(1);
  });

  it('keeps a headingless rewrite as editable text instead of pausing', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const calls: string[] = [];
    let reviewCalls = 0;
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          calls.push(request.node);
          if (request.node === 'draft') return directScriptText();
          if (request.node === 'revision') return '这不是可识别的剧本场景。';
          reviewCalls += 1;
          return reviewCalls === 1
            ? directReviewJson({
                verdict: 'major_issue',
                issues: [{
                  code: 'OFF_OUTLINE',
                  evidence: '正文遗漏了一项次要线索。',
                  expected: '补充次要线索但不要改变主事件。',
                }],
              })
            : directReviewJson();
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect(calls).toEqual(['draft', 'review', 'revision', 'review']);
    expect(reviewCalls).toBe(2);
    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(store.state.episodes[0]?.status).toBe('completed');
    expect(store.state.reviewIssues.some((item) => item.severity === 'hard')).toBe(false);
  });

  it('normalizes an invalid review verdict to a local pass handoff', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') return directScriptText();
          return JSON.stringify({ verdict: 'looks_good' });
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(store.state.episodes[0]?.status).toBe('completed');
    const savedCheckpoints = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    expect(savedCheckpoints.filter((item) =>
      item.node === 'handoff_review' && item.status === 'succeeded',
    )).toHaveLength(1);
  });

  it('uses a local handoff when the post-rewrite review is unparseable', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    let reviewCalls = 0;
    const director = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            return directScriptText({
              location: '市体育馆篮球场',
              dialogue: '这场篮球赛我们一定要赢。'.repeat(14),
            });
          }
          if (request.node === 'revision') {
            return directScriptText({
              location: '校报社',
              dialogue: '时间戳和采访记录能够相互印证。'.repeat(14),
            });
          }
          reviewCalls += 1;
          if (reviewCalls === 1) {
            return directReviewJson({
              verdict: 'major_issue',
              issues: [{
                code: 'WRONG_GENRE_OR_SETTING',
                sceneNumber: 1,
                evidence: '正文写成篮球比赛。',
                expected: '本集应在校报社调查证据。',
              }],
            });
          }
          return '这不是可解析的复核 JSON。';
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect(reviewCalls).toBe(2);
    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(store.state.episodes[0]?.status).toBe('completed');
    const savedCheckpoints = await checkpoints.list('project-1', 'script_episode_batch:1:1');
    expect(savedCheckpoints.filter((item) =>
      item.node === 'handoff_review' && item.status === 'succeeded',
    )).toHaveLength(2);
  });

  it('accepts up to five scenes in direct mode even when the planning preference is three', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const fourSceneText = [
      '第1集',
      ...Array.from({ length: 4 }, (_, index) => [
        `1-${index + 1} 校报社${index + 1}区 日/内`,
        '人物：沈清',
        `△${'沈清依次核对采访记录并标出关键时间。'.repeat(4)}`,
        `沈清：${'证据必须按照发生顺序公开才能说服所有人。'.repeat(4)}`,
      ].join('\n')),
    ].join('\n');
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          return request.node === 'review' ? directReviewJson() : fourSceneText;
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(store.state.episodes[0]?.scenes).toHaveLength(4);
    expect(store.atomicCommitCalls).toHaveLength(1);
  });

  it('keeps a temporary role under its own speaker name instead of relabeling it as the lead', async () => {
    const state = readySingleEpisodeState();
    state.characters.push({
      ...state.characters[0]!,
      id: 'supporting-driver',
      name: '程野',
      role: 'supporting',
    });
    const store = new MemoryScriptStore(state);
    const text = [
      '第1集',
      '1-1 校报社前台 日/内',
      '人物：沈清 前台 黑夹克男甲 周技师 报名员 电话里的声音 金丝眼镜 程野',
      `△${'沈清把采访申请递到窗口并等待核验。'.repeat(8)}`,
      `前台：${'登记表需要负责人签字，我先替你查一下今天的值班记录。'.repeat(8)}`,
      `黑夹克男甲：${'老板让我来取走登记册，你们最好别多问。'.repeat(5)}`,
      `周技师：${'这份检测记录的编号和原件对不上。'.repeat(4)}`,
      `老周：${'我只在这一集作证，讲清楚那天看到的车辆和时间。'.repeat(4)}`,
      `报名员：${'请先核对姓名和车辆编号，再领取地下资格赛号码牌。'.repeat(4)}`,
      `电话里的声音（VO）：${'资格赛名单已经确认，请所有参赛者按时到场检录。'.repeat(4)}`,
      `金丝眼镜：${'宏远车队只想提醒你，继续参赛不会有任何好处。'.repeat(4)}`,
      `程野：${'我只负责这一场资格赛，过了终点我们各凭成绩说话。'.repeat(4)}`,
      `沈清：${'请重点核对下午三点前后的访客名单。'.repeat(6)}`,
    ].join('\n');
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          return request.node === 'review' ? directReviewJson() : text;
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    const temporaryLine = store.state.episodes[0]?.scenes[0]?.blocks.find(
      (block) => block.type === 'dialogue' && block.speaker === '前台',
    );
    expect(temporaryLine).toMatchObject({ type: 'dialogue', speaker: '前台' });
    expect(temporaryLine).not.toHaveProperty('characterId');
    expect(store.state.episodes[0]?.scenes[0]?.blocks).toContainEqual(expect.objectContaining({
      type: 'dialogue',
      speaker: '黑夹克男甲',
    }));
    expect(store.state.episodes[0]?.scenes[0]?.blocks).toContainEqual(expect.objectContaining({
      type: 'dialogue',
      speaker: '周技师',
    }));
    expect(store.state.episodes[0]?.scenes[0]?.blocks).toContainEqual(expect.objectContaining({
      type: 'dialogue',
      speaker: '老周',
    }));
    expect(store.state.episodes[0]?.scenes[0]?.blocks).toContainEqual(expect.objectContaining({
      type: 'dialogue',
      speaker: '报名员',
    }));
    expect(store.state.episodes[0]?.scenes[0]?.blocks).toContainEqual(expect.objectContaining({
      type: 'dialogue',
      speaker: '电话里的声音',
    }));
    expect(store.state.episodes[0]?.scenes[0]?.blocks).toContainEqual(expect.objectContaining({
      type: 'dialogue',
      speaker: '金丝眼镜',
    }));
    expect(store.state.episodes[0]?.scenes[0]?.blocks).toContainEqual(expect.objectContaining({
      type: 'dialogue',
      speaker: '程野',
    }));
    expect(store.atomicCommitCalls).toHaveLength(1);
  });

  it('repairs a scene cast list when a registered dialogue speaker was omitted from the heading', async () => {
    const state = readySingleEpisodeState();
    state.characters.push({
      ...structuredClone(state.characters[0]!),
      id: 'reporter',
      name: '王玲',
      role: 'supporting',
      aliases: [],
      relationships: [],
    });
    state.episodeOutlines[0]!.characterIds.push('reporter');
    const store = new MemoryScriptStore(state);
    const text = [
      '第1集',
      '1-1 校报社 日/内',
      '人物：沈清',
      `△${'沈清把采访记录按时间顺序铺在桌面上。'.repeat(8)}`,
      `王玲：${'我已经核对过原始录音，下午三点的证词确实被人替换。'.repeat(7)}`,
      `沈清：${'先保留原件，我们按证据出现的顺序公开。'.repeat(7)}`,
    ].join('\n');
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          return request.node === 'review' ? directReviewJson() : text;
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(store.state.episodes[0]?.scenes[0]?.characterIds).toEqual(['lead', 'reporter']);
    expect(store.atomicCommitCalls).toHaveLength(1);
  });

  it('keeps an invented named character advisory instead of blocking the whole batch', async () => {
    const state = readySingleEpisodeState();
    state.plan!.coreRequirements += ' 未登记人物禁止对白。';
    const store = new MemoryScriptStore(state);
    const text = [
      '第1集',
      '1-1 校报社前台 日/内',
      '人物：沈清 陈大勇',
      `△${'沈清把采访申请递到窗口并等待核验。'.repeat(8)}`,
      `陈大勇：${'我认识所有证人，事情就是我刚才说的那样。'.repeat(8)}`,
      `沈清：${'请先拿出能够核验身份和时间的记录。'.repeat(6)}`,
    ].join('\n');
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          return request.node === 'review' ? directReviewJson() : text;
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    await expect(director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    })).resolves.toMatchObject({ kind: 'episode_batch' });

    expect(store.atomicCommitCalls).toHaveLength(1);
    expect(store.state.reviewIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNKNOWN_SPEAKER', severity: 'soft' }),
    ]));
  });

  it('caps a format-repair plus major-rewrite and recheck episode at five model calls', async () => {
    const state = readySingleEpisodeState();
    const calls: string[] = [];
    let draftCalls = 0;
    let reviewCalls = 0;
    const store = new MemoryScriptStore(state);
    const director = new ScriptDirector({
      store,
      checkpoints: new InMemoryScriptCheckpointStore(),
      model: {
        async complete(request) {
          calls.push(request.node);
          if (request.node === 'draft') {
            draftCalls += 1;
            return draftCalls === 1
              ? '下面是剧本，但我先解释一下创作思路。'
              : directScriptText({ actionChars: 45, dialogueChars: 55 });
          }
          if (request.node === 'review') {
            reviewCalls += 1;
            if (reviewCalls > 1) return directReviewJson();
            return directReviewJson({
              verdict: 'major_issue',
              issues: [{
                code: 'OFF_OUTLINE',
                evidence: '正文没有完成取得证据的主要事件。',
                expected: '本集必须取得证据。',
              }],
            });
          }
          return directScriptText();
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });

    const result = await director.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(result.kind).toBe('episode_batch');
    if (result.kind !== 'episode_batch') throw new Error('unexpected result');
    expect(calls).toEqual(['draft', 'draft', 'review', 'revision', 'review']);
    expect(result.callSummary.totalCalls).toBe(5);
    expect(store.atomicCommitCalls).toHaveLength(1);
  });

  it('reuses a durable direct draft after an interrupted review without charging for the writer again', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    let writerCalls = 0;
    const interrupted = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            writerCalls += 1;
            return directScriptText();
          }
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });
    await expect(interrupted.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(writerCalls).toBe(1);
    expect(store.atomicCommitCalls).toHaveLength(0);

    const resumed = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            writerCalls += 1;
            return directScriptText();
          }
          return directReviewJson();
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });
    await resumed.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(writerCalls).toBe(1);
    expect(store.atomicCommitCalls).toHaveLength(1);
  });

  it('repairs shot directions already stored as dialogue in an older direct-draft checkpoint', async () => {
    const state = readySingleEpisodeState();
    const store = new MemoryScriptStore(state);
    const checkpoints = new InMemoryScriptCheckpointStore();
    let writerCalls = 0;
    const interrupted = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            writerCalls += 1;
            return directScriptText();
          }
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });
    await expect(interrupted.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    })).rejects.toMatchObject({ name: 'AbortError' });

    const directDraft = (await checkpoints.list('project-1', 'script_episode_batch:1:1'))
      .find((checkpoint) => checkpoint.node === 'direct_draft');
    if (!directDraft?.artifact || typeof directDraft.artifact !== 'object') {
      throw new Error('missing direct draft checkpoint');
    }
    const artifact = structuredClone(directDraft.artifact) as {
      episode: ScriptEpisode;
      candidateHash: string;
    };
    const originalBlock = artifact.episode.scenes[0]?.blocks[0];
    if (!originalBlock) throw new Error('missing direct draft block');
    const screenValue = '007。'.repeat(40);
    artifact.episode.scenes[0]!.blocks[0] = {
      id: originalBlock.id,
      type: 'dialogue',
      speaker: '【特写】屏幕上，门禁记录滚动刷新，最后一条记录显示',
      mode: 'normal',
      text: screenValue,
    };
    artifact.episode.scenes[0]!.blocks.splice(1, 0, {
      id: `${originalBlock.id}-plain-shot`,
      type: 'dialogue',
      speaker: '特写',
      mode: 'normal',
      text: '王强的嘴角微微上扬。',
    });
    artifact.candidateHash = computeScriptEpisodeCandidateHash(artifact.episode);
    await checkpoints.save({
      ...directDraft,
      artifactRevision: directDraft.artifactRevision + 1,
      artifact,
    });

    const resumed = new ScriptDirector({
      store,
      checkpoints,
      model: {
        async complete(request) {
          if (request.node === 'draft') {
            writerCalls += 1;
            return directScriptText();
          }
          return directReviewJson();
        },
        async getModelConfigFingerprint() { return 'direct-model-v1'; },
      },
    });
    await resumed.run({
      task: 'script_episode_batch', projectId: 'project-1',
      startEpisode: 1, episodeCount: 1, expectedPlanRevision: 1,
      draftMode: 'direct_text',
    });

    expect(writerCalls).toBe(1);
    expect(store.state.episodes[0]?.scenes[0]?.blocks[0]).toMatchObject({
      type: 'action',
      text: `【特写】屏幕上，门禁记录滚动刷新，最后一条记录显示：${screenValue}`,
    });
    expect(store.state.episodes[0]?.scenes[0]?.blocks[1]).toMatchObject({
      type: 'action',
      text: '特写：王强的嘴角微微上扬。',
    });
    expect(store.atomicCommitCalls).toHaveLength(1);
  });
});
