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
    expect(prompts[1]).toContain('上一段最后两集');
    expect(prompts[1]).toContain('第9步');
    expect(prompts[1]).toContain('第10步');
    expect(prompts[1]).toContain('已经发生、取得或发现的关键事件不得重新当作首次发生');
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

  it('stales an episode-draft-v3 checkpoint after the lightweight v6 prompt upgrade', async () => {
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
        artifactRevision: 1, promptVersion: 'episode-draft-v6', status: 'succeeded',
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
        promptVersion: 'episode-draft-v6',
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
  it('uses a bounded fixup when the first revision leaves a speaker outside the scene', async () => {
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

    expect({ revisionCalls, reviewCalls }).toEqual({ revisionCalls: 2, reviewCalls: 2 });
    expect(revisionPrompts[1]).toContain('array.non_empty');
    expect(revisionPrompts[1]).toContain('SPEAKER_NOT_IN_SCENE');
    expect(store.state.episodes[0]?.scenes[0]?.characterIds).toEqual(['lead', 'witness']);
    expect(store.state.episodes[0]?.status).toBe('completed');
  });

  it('revises an obvious structural error and completes after the follow-up review', async () => {
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
    expect({ reviewCalls, revisionCalls }).toEqual({ reviewCalls: 2, revisionCalls: 1 });
    expect(store.state.episodes[0]?.status).toBe('completed');
    expect(store.state.episodes[0]?.scenes[0]?.blocks[0]?.text)
      .toBe('沈清推门闯进校报社，把录音笔按在桌面上。');
    expect(store.saveEpisodeCalls).toHaveLength(0);
    expect(store.atomicCommitCalls).toHaveLength(1);
  });
  it('keeps an overlong but structurally valid episode as advisory instead of rewriting it', async () => {
    const state = readySingleEpisodeState();
    state.episodes = [reviewingEpisode(state, '超长'.repeat(200), { title: '偏长候选' })];
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

  it('keeps the formal episode unchanged when an obvious-bug revision remains invalid', async () => {
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
    })).rejects.toMatchObject({
      code: 'SCRIPT_BATCH_NEEDS_REVIEW',
      recoverable: true,
    });

    expect(revisionCalls).toBe(2);
    expect(store.state.episodes).toEqual([candidate]);
    expect(store.state.continuityCommits ?? []).toEqual([]);
    expect(store.atomicCommitCalls).toHaveLength(0);
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

  it('pauses instead of committing when the rewritten episode still has an obvious major error', async () => {
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
    })).rejects.toBeInstanceOf(ScriptBatchPausedError);

    expect(calls).toEqual(['draft', 'review', 'revision', 'review']);
    expect(store.atomicCommitCalls).toHaveLength(0);
    expect(store.state.episodes).toHaveLength(0);
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
    const store = new MemoryScriptStore(state);
    const text = [
      '第1集',
      '1-1 校报社前台 日/内',
      '人物：沈清 前台 黑夹克男甲 周技师',
      `△${'沈清把采访申请递到窗口并等待核验。'.repeat(8)}`,
      `前台：${'登记表需要负责人签字，我先替你查一下今天的值班记录。'.repeat(8)}`,
      `黑夹克男甲：${'老板让我来取走登记册，你们最好别多问。'.repeat(5)}`,
      `周技师：${'这份检测记录的编号和原件对不上。'.repeat(4)}`,
      `老周：${'我只在这一集作证，讲清楚那天看到的车辆和时间。'.repeat(4)}`,
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

  it('still blocks an invented named character that is not in the character bible', async () => {
    const state = readySingleEpisodeState();
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
    })).rejects.toBeInstanceOf(ScriptBatchPausedError);

    expect(store.atomicCommitCalls).toHaveLength(0);
    expect(store.state.episodes).toHaveLength(0);
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
});
