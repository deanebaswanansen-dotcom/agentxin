import { describe, expect, it, vi } from 'vitest';
import type { ModelProxy, StreamCompletionOptions } from '../../proxy/ModelProxy.js';
import { ProxyError } from '../../proxy/ProxyError.js';
import type { ChatMessage, ModelConfig } from '../../types/index.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import {
  collectScaleFromSession,
  extractScaleFromText,
  hasExplicitPlanningBypass,
  inferExplicitGenre,
  MAX_OUTLINE_CHAPTERS,
  NovelPlanService,
  normalizeStoryPlan,
} from './NovelPlanService.js';

const CONFIG: ModelConfig = {
  baseUrl: 'https://api.example.com',
  apiKey: 'test-key',
  modelName: 'test-model',
};

function mockConfigService(config: ModelConfig | undefined = CONFIG): ModelConfigService {
  return {
    getInternalConfig: vi.fn().mockResolvedValue(config),
  } as unknown as ModelConfigService;
}

class QueueProxy implements ModelProxy {
  readonly calls: ChatMessage[][] = [];
  readonly options: Array<StreamCompletionOptions | undefined> = [];

  constructor(private readonly outputs: Array<string | Error>) {}

  async *streamCompletion(
    _config: ModelConfig,
    messages: ChatMessage[],
    _signal: AbortSignal,
    options?: StreamCompletionOptions,
  ) {
    this.calls.push(messages);
    this.options.push(options);
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    yield { kind: 'content' as const, text: output ?? '' };
  }
}

function outlines(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `灰烬之路 ${index + 1}`,
    goal: `骑士寻找第 ${index + 1} 枚符文，与教廷冲突并获得下一章线索。`,
    estimatedWords: 1200,
  }));
}

function readyDecision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'ready',
    message: '方向明确，开始执行。',
    questions: [],
    brief: '一名流亡骑士追查失落王冠。',
    planSummary: {
      title: '灰烬王冠',
      genre: '西方玄幻',
      protagonist: '流亡骑士艾琳',
      hook: '王冠会吞噬每一位继承者的记忆。',
      tone: '史诗、阴郁',
      constraints: [],
      totalWords: 2400,
      wordsPerChapter: 1200,
      chapterCount: 2,
      chapterOutlines: outlines(2),
      storyPlan: {
        metadata: { title: '灰烬王冠', genre: '西方玄幻', targetLength: 2400, tone: '史诗、阴郁' },
        premise: { oneSentence: '流亡骑士寻找吞噬记忆的王冠。', coreConflict: '守住记忆与夺回王权的目标彼此冲突。' },
        protagonist: {
          name: '艾琳', identity: '流亡骑士', personality: ['克制'], motivation: '追查故国真相',
          goal: '封印诅咒王冠', weakness: '拒绝信任同伴', growthArc: '从独行复仇者成长为共同命运的守护者',
        },
        world: {
          overview: '旧帝国覆灭后，教会、边境诸侯与遗迹猎人争夺失落王权，魔法以人的记忆作为不可逆代价。北境矿城供给封印材料，南方港邦垄断遗迹航路，教会则借清剿诅咒扩张审判权；王冠重现使三方脆弱盟约崩解，也迫使流亡者重新面对故国历史。',
          regions: [], countries: [], races: [], religions: [], factions: [], history: [],
        },
        powerSystem: { rules: ['施法消耗记忆', '王冠放大代价', '遗忘的记忆无法恢复'], levels: [], limitations: [], specialCases: [] },
        characters: [
          { name: '艾琳', role: '主角', traits: ['克制'] },
          { name: '罗兰', role: '对手', traits: ['虔诚'] },
          { name: '米拉', role: '盟友', traits: ['敏锐'] },
          { name: '格雷', role: '导师', traits: ['隐忍'] },
        ],
        factions: [],
        mainPlot: { beginning: '接下遗迹任务', development: '被教会追杀', climax: '争夺王冠', ending: '封印王冠' },
        subplots: [], characterArcs: [], volumes: [],
        foreshadowing: ['王冠内侧刻着主角的旧名', '教堂壁画缺少一位圣徒', '导师认得王冠的封印'],
        mysteries: [],
        constraints: { mustInclude: [], mustAvoid: [] },
      },
      ...overrides,
    },
  });
}

describe('NovelPlanService goal-driven agent', () => {
  it('requires a real model instead of returning a scripted questionnaire', async () => {
    const service = new NovelPlanService(
      { getInternalConfig: vi.fn().mockResolvedValue(undefined) } as unknown as ModelConfigService,
      new QueueProxy([]),
    );
    await expect(
      service.turn({ seedPrompt: '写一本西方玄幻' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
  });

  it('calls the agent immediately and preserves the Agent-selected high-impact questions', async () => {
    const proxy = new QueueProxy([
      JSON.stringify({
        status: 'asking',
        message: '只补充会改变主线的选择。',
        questions: [
          {
            id: 'protagonist_goal',
            question: '主角最优先追求什么？',
            options: [
              { id: 'revenge', label: '复仇' },
              { id: 'throne', label: '夺回王位' },
            ],
          },
          {
            id: 'magic_cost',
            question: '魔法代价采用哪一种？',
            options: [
              { id: 'memory', label: '消耗记忆' },
              { id: 'life', label: '消耗寿命' },
            ],
          },
          {
            id: 'extra',
            question: '不应出现的第三题？',
            options: [
              { id: 'a', label: '甲' },
              { id: 'b', label: '乙' },
            ],
          },
        ],
      }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '写一本西方玄幻，流亡骑士寻找王冠，走冒险成长主线，正统史诗风格' },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    expect(result.questions).toHaveLength(3);
    const prompt = proxy.calls[0].map((message) => message.content).join('\n');
    expect(prompt).toContain('不是固定问卷或工作流');
    expect(prompt).toContain('已识别硬约束题材：西方玄幻');
    expect(prompt).toContain('信息足以形成方向时可以 0 问并立即 ready');
    expect(prompt).toContain('主动提问总预算剩余 10 题');
    expect(proxy.options[0]).toMatchObject({ jsonMode: true, disableThinking: true });
  });

  it('lets the Agent design first-turn questions instead of returning a fixed questionnaire', async () => {
    const proxy = new QueueProxy([
      JSON.stringify({
        status: 'asking',
        message: '先确认一个真正改变故事结构的选择。',
        questions: [
          {
            id: 'moral_boundary',
            question: '主角为了完成目标最不能跨越哪条底线？',
            impactScore: 9,
            options: [
              { id: 'protect_innocents', label: '不能牺牲无辜者' },
              { id: 'never_submit', label: '不能向神权屈服' },
            ],
          },
        ],
      }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '写本西方玄幻小说' },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    expect(result.questions?.map((question) => question.id)).toContain('moral_boundary');
    expect(result.questions?.map((question) => question.id)).toContain('core_main_direction');
    expect(result.questions?.map((question) => question.id)).toContain('core_protagonist_type');
    expect(result.planSummary).toBeUndefined();
    expect(proxy.calls).toHaveLength(1);
  });

  it('does not lock the plan after one answer while unresolved core decisions remain', async () => {
    const proxy = new QueueProxy([
      readyDecision(),
      JSON.stringify({
        status: 'asking',
        message: '主线已经明确，还需确认主角大方向。',
        questions: [
          {
            id: 'protagonist_identity',
            question: '主角更适合从哪一种身份进入这场冒险？',
            impactScore: 9,
            options: [
              { id: 'exiled_knight', label: '流亡骑士' },
              { id: 'wandering_mage', label: '流浪法师' },
            ],
          },
        ],
      }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      {
        seedPrompt: '写本西方玄幻小说',
        history: [
          { role: 'assistant', content: 'PLAN_QUESTION[main_direction] score=9: 主线走什么方向？' },
          { role: 'user', content: '- main_direction: adventure | 主线走什么方向？ → 冒险成长' },
        ],
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    expect(result.questions?.map((question) => question.id)).toContain('protagonist_identity');
    expect(result.questions?.map((question) => question.id)).toContain('core_protagonist_type');
    expect(result.questions?.map((question) => question.id)).toContain('target_total_words');
    expect(proxy.calls).toHaveLength(2);
  });

  it('rejects an invalid asking shape and asks the agent for a valid confirmation', async () => {
    const service = new NovelPlanService(
      mockConfigService(),
      new QueueProxy([
        JSON.stringify({
          status: 'asking',
          message: '需要确认方向。',
          questions: [{ id: 'direction', question: '想写什么方向？', options: [] }],
        }),
        JSON.stringify({
          status: 'asking',
          message: '开写前确认主线。',
          questions: [{
            id: 'main_direction',
            question: '主线最偏向哪一种核心体验？',
            impactScore: 9,
            options: [{ id: 'quest', label: '冒险远征' }, { id: 'war', label: '王国战争' }],
          }],
        }),
      ]),
    );
    const result = await service.turn(
      {
        seedPrompt: '写西方玄幻，主角是流浪骑士，走冒险成长主线，正统史诗风格',
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
  });

  it('lets the Agent finish immediately when the request already contains enough direction', async () => {
    const proxy = new QueueProxy([
      readyDecision(),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      {
        seedPrompt:
          '写西方玄幻，主角是流浪骑士，走冒险成长主线，正统史诗风格；总字数30万字，总章节数100，每章3000字，5卷，苦尽甘来，慢热群像不后宫',
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('ready');
    expect(result.questions).toEqual([]);
    expect(proxy.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('stops arbitrary core defaults when the provider ignores a required clarification', async () => {
    const proxy = new QueueProxy([readyDecision(), readyDecision()]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '写本小说' },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    expect(result.questions?.map((question) => question.id)).toEqual([
      'core_genre',
      'core_main_direction',
      'core_protagonist_type',
      'target_total_words',
      'target_total_chapters',
    ]);
    expect(result.questions?.[0]?.question).toContain('题材类型');
    expect(result.questions?.[1]?.options.map((option) => option.id)).toContain('adventure_growth');
    expect(proxy.calls).toHaveLength(2);
  });

  it('keeps model questions inside the explicit campus topic', async () => {
    const proxy = new QueueProxy([
      JSON.stringify({
        status: 'asking',
        message: '先确认校园故事的核心矛盾和主角起点。',
        planningChecklist: {
          confirmedFacts: ['题材是校园故事'],
          unresolvedDecisions: ['校园冲突类型', '主角在学校的身份'],
          safeDefaults: ['学校名称和城市'],
          hardConstraints: ['不得改成玄幻或修仙'],
        },
        questions: [
          {
            id: 'campus_conflict',
            question: '这所学校的核心矛盾更接近哪一种？',
            impactScore: 10,
            options: [
              { id: 'exam', label: '升学与竞赛压力' },
              { id: 'club', label: '社团荣誉与团队竞争' },
            ],
          },
          {
            id: 'campus_role',
            question: '主角以哪一种校园身份开始故事？',
            impactScore: 9,
            options: [
              { id: 'transfer', label: '转学生' },
              { id: 'club_member', label: '社团成员' },
            ],
          },
        ],
      }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '写一个校园故事' },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    expect(result.questions?.map((question) => question.id)).toContain('campus_conflict');
    expect(result.questions?.map((question) => question.id)).toContain('campus_role');
    expect(result.questions?.flatMap((question) => question.options.map((option) => option.label)).join(''))
      .not.toMatch(/魔法|修仙|骑士|王国/);
    expect(result.planningChecklist?.unresolvedDecisions).toContain('校园冲突类型');
  });

  it('uses a topic-aware fallback when the model ignores a campus clarification', async () => {
    const service = new NovelPlanService(
      mockConfigService(),
      new QueueProxy([readyDecision(), readyDecision()]),
    );
    const result = await service.turn(
      { seedPrompt: '写一个校园故事' },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    const text = result.questions?.map((question) => `${question.question} ${question.options.map((option) => option.label).join(' ')}`).join('\n') ?? '';
    expect(text).toContain('校园');
    expect(text).not.toMatch(/魔法|修仙|骑士|王国/);
  });

  it('asks the scale fields instead of allowing a one-question provider response to start planning', async () => {
    const proxy = new QueueProxy([
      JSON.stringify({
        status: 'asking',
        message: '先确认故事方向。',
        questions: [{
          id: 'mystery_hook',
          question: '案件的核心谜团是什么？',
          impactScore: 10,
          options: [{ id: 'missing_person', label: '失踪案' }, { id: 'closed_room', label: '密室案' }],
        }],
      }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '写一个校园推理故事' },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    const ids = result.questions?.map((question) => question.id) ?? [];
    expect(ids).toContain('mystery_hook');
    expect(ids).toContain('target_total_words');
    expect(ids).toContain('target_total_chapters');
    expect(result.planningChecklist?.unresolvedDecisions.join(' ')).toMatch(/总字数|章节数/);
  });

  it('uses genre-specific protagonist and hook questions for western fantasy', async () => {
    const service = new NovelPlanService(
      mockConfigService(),
      new QueueProxy([JSON.stringify({ status: 'asking', message: '补充方向。', questions: [] })]),
    );
    const result = await service.turn(
      { seedPrompt: '写一本西方玄幻小说' },
      new AbortController().signal,
    );
    const text = result.questions?.map((q) => `${q.question} ${q.options.map((o) => o.label).join(' ')}`).join('\n') ?? '';
    expect(text).toMatch(/奇幻|魔法|遗迹|王国|流亡|冒险/);
    expect(text).not.toMatch(/校园竞赛|班主任|社团活动/);
  });

  it('rejects generic core questions that drift away from hard sci-fi', async () => {
    const generic = JSON.stringify({
      status: 'asking',
      message: '先确认主线。',
      questions: [{
        id: 'core_main_direction',
        question: '主线冲突优先围绕哪一种目标展开？',
        impactScore: 10,
        options: [
          { id: 'adventure', label: '冒险成长' },
          { id: 'war', label: '战争与争霸' },
        ],
      }],
    });
    const service = new NovelPlanService(
      mockConfigService(),
      new QueueProxy([generic, readyDecision()]),
    );
    const result = await service.turn(
      { seedPrompt: '写一本硬科幻小说，火星殖民地发生资源危机，主角是维修工程师' },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    expect(result.questions?.[0]?.id).toBe('core_main_direction');
    expect(result.questions?.[0]?.question).toContain('科幻');
    expect(result.questions?.flatMap((question) => question.options.map((option) => option.label)).join(''))
      .not.toContain('冒险成长');
  });

  it('keeps scale and ending decisions in separate resumable turns', async () => {
    const seed = '写一本西方玄幻，主角是流亡骑士，主线是复仇与真相';
    const firstProxy = new QueueProxy([
      JSON.stringify({
        status: 'asking',
        message: '先确认创作规模。',
        questions: [
          { id: 'target_total_words', question: '全书目标总字数大约是多少？', impactScore: 8, options: [{ id: 'total_100k', label: '约10万字' }, { id: 'total_300k', label: '约30万字' }] },
          { id: 'target_total_chapters', question: '全书计划写多少章？', impactScore: 8, options: [{ id: 'ch_50', label: '约50章' }, { id: 'ch_100', label: '约100章' }] },
          { id: 'target_words_per_chapter', question: '每章目标字数是多少？', impactScore: 8, options: [{ id: 'wpc_2000', label: '约2000字' }, { id: 'wpc_3000', label: '约3000字' }] },
          { id: 'target_volume_count', question: '全书分几卷？', impactScore: 8, options: [{ id: 'volumes_3', label: '三卷' }, { id: 'volumes_5', label: '五卷' }] },
        ],
      }),
    ]);
    const first = new NovelPlanService(mockConfigService(), firstProxy);
    const firstResult = await first.turn({ seedPrompt: seed }, new AbortController().signal);
    expect(firstResult.status).toBe('asking');
    expect(firstResult.questions).toHaveLength(4);
    expect(firstResult.questions?.map((question) => question.id)).toEqual([
      'target_total_words',
      'target_total_chapters',
      'target_words_per_chapter',
      'target_volume_count',
    ]);

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: `灵感：${seed}` },
      {
        role: 'assistant',
        content: firstResult.questions
          ?.map((question) => `PLAN_QUESTION[${question.id}]: ${question.question}`)
          .join('\n') ?? '',
      },
    ];
    const second = new NovelPlanService(
      mockConfigService(),
      new QueueProxy([readyDecision(), readyDecision()]),
    );
    const secondResult = await second.turn({
      seedPrompt: seed,
      history,
      answers: [
        { questionId: 'target_total_words', selectedOptionIds: ['total_100k'], selectedOptionLabels: ['约10万字'] },
        { questionId: 'target_total_chapters', selectedOptionIds: ['ch_50'], selectedOptionLabels: ['约50章'] },
        { questionId: 'target_words_per_chapter', selectedOptionIds: ['wpc_2000'], selectedOptionLabels: ['约2000字'] },
        { questionId: 'target_volume_count', selectedOptionIds: ['volumes_3'], selectedOptionLabels: ['三卷'] },
      ],
    }, new AbortController().signal);

    expect(secondResult.status).toBe('asking');
    expect(secondResult.questions?.map((question) => question.id)).toEqual([
      'ending_direction',
      'writing_requirements',
    ]);
    expect(secondResult.questions?.map((question) => question.id)).not.toContain('target_total_words');
  });

  it('does not start while the Agent checklist still has unresolved decisions', async () => {
    const proxy = new QueueProxy([
      JSON.stringify({
        ...JSON.parse(readyDecision()),
        planningChecklist: {
          confirmedFacts: ['题材已确定'],
          unresolvedDecisions: ['结局是否开放式'],
          safeDefaults: [],
          hardConstraints: [],
        },
      }),
      JSON.stringify({
        status: 'asking',
        message: '先确认结局形态。',
        planningChecklist: {
          confirmedFacts: ['题材已确定'],
          unresolvedDecisions: ['结局是否开放式'],
          safeDefaults: [],
          hardConstraints: [],
        },
        questions: [{
          id: 'ending_shape',
          question: '结局采用哪种形态？',
          impactScore: 9,
          options: [{ id: 'closed', label: '完整收束' }, { id: 'open', label: '开放式' }],
        }],
      }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '写西方玄幻，主角是流浪骑士，主线是复仇与真相，总字数10万字，总章节数40，每章2500字' },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    expect(result.questions?.map((question) => question.id)).toContain('ending_shape');
    expect(result.questions?.map((question) => question.id)).toContain('target_volume_count');
    expect(result.questions?.map((question) => question.id)).toContain('ending_direction');
    expect(proxy.calls).toHaveLength(2);
  });

  it('rejects low-value world-detail questions and asks a high-impact confirmation instead', async () => {
    const lowValue = JSON.stringify({
      status: 'asking',
      message: '确认细节。',
      questions: [
        {
          id: 'country_name',
          question: '第一个国家叫什么？',
          impactScore: 9,
          options: [
            { id: 'a', label: '阿斯塔' },
            { id: 'b', label: '洛伦' },
          ],
        },
      ],
    });
    const proxy = new QueueProxy([lowValue, JSON.stringify({
      status: 'asking',
      message: '改问会改变故事结构的选择。',
      questions: [{
        id: 'main_direction',
        question: '主线最偏向哪一种核心体验？',
        impactScore: 9,
        options: [{ id: 'quest', label: '冒险远征' }, { id: 'war', label: '王国战争' }],
      }],
    })]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '写西方玄幻，主角是流浪骑士，走冒险成长主线，正统史诗风格' },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    expect(proxy.calls).toHaveLength(2);
  });

  it('keeps explicit western fantasy even when the model drifts to campus fiction', async () => {
    const proxy = new QueueProxy([
      readyDecision({
        genre: '校园青春',
        title: '校园夏日',
        chapterOutlines: outlines(2),
      }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '西方玄幻，两章，每章1200字，流亡女骑士寻找诅咒王冠，直接开始' },
      new AbortController().signal,
    );

    expect(result.status).toBe('ready');
    expect(result.planSummary?.genre).toBe('西方玄幻');
    expect(result.planSummary?.constraints).toContain(
      '题材固定为西方玄幻，不得替换成其他题材或时代背景',
    );
    expect(result.brief).toContain('原始需求：西方玄幻');
  });

  it('honors structured SPEC fields and rolls a long plan out in a chapter window', async () => {
    const proxy = new QueueProxy([
      readyDecision({
        totalWords: 1_000_000,
        wordsPerChapter: 2500,
        chapterCount: 400,
        chapterOutlines: [],
      }),
      JSON.stringify({ chapterOutlines: outlines(50) }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      {
        seedPrompt: '请开始计划',
        planConfig: {
          targetTotalWords: 1_000_000,
          targetTotalChapters: 400,
          targetWordsPerChapter: { min: 2500, max: 3000 },
          targetVolumeCount: 10,
          genres: ['东方玄幻', '学院', '冒险'],
          coreStory: '主角进入学院后发现世界隐藏的秘密，最终卷入战争。',
          endingDirection: '苦尽甘来',
          writingRequirements: '慢热、群像、不后宫',
        },
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('ready');
    expect(result.planSummary?.chapterCount).toBe(400);
    expect(result.planSummary?.planConfig?.targetVolumeCount).toBe(10);
    expect(result.planSummary?.endingDirection).toBe('苦尽甘来');
    expect(result.planSummary?.plannedThroughChapter).toBe(50);
    expect(result.planSummary?.chapterOutlines).toHaveLength(50);
    expect(proxy.calls[1][0].content).toContain('当前滚动窗口');
  });

  it('filters repeated questions and asks the Agent to reconsider unresolved core decisions', async () => {
    const repeated = JSON.stringify({
      status: 'asking',
      message: '还想再问一次。',
      questions: [
        {
          id: 'magic_cost',
          question: '魔法代价采用哪一种？',
          options: [
            { id: 'memory', label: '消耗记忆' },
            { id: 'life', label: '消耗寿命' },
          ],
        },
      ],
    });
    const proxy = new QueueProxy([repeated, readyDecision()]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      {
        seedPrompt: '写西方玄幻，总字数2400字，总章节数2，每章1200字，主角是流浪骑士，冒险成长，5卷，苦尽甘来，慢热群像不后宫',
        history: [
          { role: 'assistant', content: 'magic_cost: 魔法代价采用哪一种？' },
          { role: 'user', content: 'magic_cost：消耗记忆' },
        ],
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('ready');
    expect(proxy.calls).toHaveLength(2);
    expect(proxy.calls[1][0].content).toContain('本轮必须 asking');
    expect(proxy.calls[1][0].content).toContain('尚未问过的高影响问题');
  });

  it('creates missing chapter outlines with a dedicated agent call', async () => {
    const first = readyDecision({ chapterOutlines: [] });
    const second = JSON.stringify({ chapterOutlines: outlines(2) });
    const proxy = new QueueProxy([first, second]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '西方玄幻，计划写2章，每章1200字，直接开始' },
      new AbortController().signal,
    );

    expect(result.planSummary?.chapterOutlines).toHaveLength(2);
    expect(proxy.calls[1][0].content).toContain('必须连续生成 2 章');
    expect(result.brief).toContain('第2章 灰烬之路 2');
  });

  it('normalizes 50 chapter provider aliases instead of reporting 0/50', async () => {
    const aliasedOutlines = Array.from({ length: 50 }, (_, index) => ({
      chapter: index + 1,
      chapter_title: `远征 ${index + 1}`,
      summary: `骑士推进第 ${index + 1} 个目标，与教会发生冲突，并在章末得到下一条线索。`,
      estimated_words: 2000,
    }));
    const proxy = new QueueProxy([
      readyDecision({
        totalWords: 100000,
        wordsPerChapter: 2000,
        chapterCount: 50,
        chapterOutlines: [],
      }),
      JSON.stringify({ chapters: aliasedOutlines }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '西方玄幻，50章，每章2000字，流浪骑士冒险成长，直接开始' },
      new AbortController().signal,
    );

    expect(result.planSummary?.chapterOutlines).toHaveLength(50);
    expect(result.planSummary?.chapterOutlines?.[49]).toMatchObject({
      number: 50,
      title: '远征 50',
      estimatedWords: 2000,
    });
  });

  it('requests only the missing range when a provider truncates a long outline', async () => {
    const firstBatch = outlines(40);
    const lastBatch = outlines(10).map((item, index) => ({
      ...item,
      number: 41 + index,
      title: `灰烬之路 ${41 + index}`,
    }));
    const proxy = new QueueProxy([
      readyDecision({
        totalWords: 100000,
        wordsPerChapter: 2000,
        chapterCount: 50,
        chapterOutlines: [],
      }),
      JSON.stringify({ chapterOutlines: firstBatch }),
      JSON.stringify({ chapter_outlines: lastBatch }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '西方玄幻，50章，每章2000字，流浪骑士冒险成长，直接开始' },
      new AbortController().signal,
    );

    expect(result.planSummary?.chapterOutlines).toHaveLength(50);
    expect(proxy.calls[2][0].content).toContain('只生成第 41-50 章');
    expect(result.planSummary?.chapterOutlines?.[49].number).toBe(50);
  });

  it('recovers once when the first long-outline response parses as 0/50', async () => {
    const proxy = new QueueProxy([
      readyDecision({
        totalWords: 100000,
        wordsPerChapter: 2000,
        chapterCount: 50,
        chapterOutlines: [],
      }),
      JSON.stringify({ chapterPlan: { note: 'provider-specific shape' } }),
      JSON.stringify({ chapterOutlines: outlines(50) }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '西方玄幻，50章，每章2000字，流浪骑士冒险成长，直接开始' },
      new AbortController().signal,
    );

    expect(result.planSummary?.chapterOutlines).toHaveLength(50);
    expect(proxy.calls[2][0].content).toContain('只生成第 1-50 章');
    expect(proxy.calls[2][1].content).toContain('首次返回无法解析');
  });

  it('builds a complete Story Plan with a dedicated agent call when the draft is shallow', async () => {
    const storyPlan = JSON.parse(readyDecision()).planSummary.storyPlan;
    const proxy = new QueueProxy([
      readyDecision({ storyPlan: undefined }),
      JSON.stringify({ storyPlan }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '西方玄幻，两章，每章1200字，流浪骑士，冒险成长，正统史诗，直接开始' },
      new AbortController().signal,
    );

    expect(proxy.calls).toHaveLength(2);
    expect(proxy.calls[1][0].content).toContain('Story Plan 架构 Agent');
    expect(result.planSummary?.storyPlan?.world.overview.length).toBeGreaterThanOrEqual(80);
  });

  it('accepts snake_case Story Plan envelopes from model providers', async () => {
    const storyPlan = JSON.parse(readyDecision()).planSummary.storyPlan;
    const proxy = new QueueProxy([
      readyDecision({ storyPlan: undefined }),
      JSON.stringify({ story_plan: storyPlan }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '西方玄幻，两章，每章1200字，流浪骑士，冒险成长，直接开始' },
      new AbortController().signal,
    );

    expect(result.status).toBe('ready');
    expect(result.planSummary?.storyPlan?.characters.length).toBeGreaterThanOrEqual(4);
  });

  it('fills omitted protagonist fields from the confirmed planning summary', async () => {
    const storyPlan = JSON.parse(readyDecision()).planSummary.storyPlan;
    storyPlan.protagonist = { personality: [] };
    const proxy = new QueueProxy([
      readyDecision({ storyPlan: undefined }),
      JSON.stringify({ storyPlan }),
    ]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      { seedPrompt: '西方玄幻，两章，每章1200字，流浪骑士，冒险成长，直接开始' },
      new AbortController().signal,
    );

    expect(result.planSummary?.storyPlan?.protagonist.identity).toBe('流亡骑士艾琳');
    expect(result.planSummary?.storyPlan?.protagonist.goal).toContain('王冠');
  });

  it('repairs malformed JSON once and fails clearly after two invalid responses', async () => {
    const service = new NovelPlanService(
      mockConfigService(),
      new QueueProxy(['not-json', 'still-not-json']),
    );
    await expect(
      service.turn(
        { seedPrompt: '写西方玄幻，主角是流浪骑士，冒险成长，正统史诗风格' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('模型连续两次未返回有效 JSON');
  });

  it('does not silently replace provider failures with templates', async () => {
    const service = new NovelPlanService(
      mockConfigService(),
      new QueueProxy([new ProxyError('provider unavailable')]),
    );
    await expect(
      service.turn(
        { seedPrompt: '写西方玄幻，主角是流浪骑士，冒险成长，正统史诗风格' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('provider unavailable');
  });

  it('does not treat the structured-plan fallback seed as a core story', async () => {
    const proxy = new QueueProxy([readyDecision(), readyDecision()]);
    const service = new NovelPlanService(mockConfigService(), proxy);
    const result = await service.turn(
      {
        seedPrompt: '请根据结构化计划配置自动生成小说计划',
        planConfig: {
          targetTotalWords: 100_000,
          targetTotalChapters: 40,
          targetWordsPerChapter: { min: 2000, max: 2500 },
          targetVolumeCount: 5,
          genres: ['西方玄幻'],
          coreStory: '',
          endingDirection: '苦尽甘来',
          writingRequirements: '慢热、群像、不后宫',
        },
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    expect(result.questions?.some((question) => question.id === 'core_story')).toBe(true);
  });

  it('rejects an empty seed', async () => {
    const service = new NovelPlanService(mockConfigService(), new QueueProxy([]));
    await expect(
      service.turn({ seedPrompt: '   ' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('planning facts', () => {
  it('normalizes flexible provider shapes into the canonical Story Plan', () => {
    const plan = normalizeStoryPlan({
      metadata: { title: '灰烬远征', genre: '西方玄幻' },
      premise: '流浪冒险者必须在拯救边境与保住自身记忆之间作出不可逆选择。',
      protagonist: { name: '伊莱', type: '流浪冒险者', goal: '终止灰潮', arc: '从独行者成长为盟约守护者' },
      world: {
        overview: '旧帝国崩溃后，北境矿城、南方港邦与圣辉教会争夺封印遗产。灰潮每十年吞没一片领地，施法者必须献出记忆换取力量，各族因此形成互相依赖又彼此猜忌的盟约；失落王冠重现后，边境秩序与教会权威同时开始瓦解。',
        geography: ['北境矿城', '南方港邦'],
      },
      powerSystem: { rules: [{ rule: '施法消耗记忆' }, { rule: '代价不可逆' }, { rule: '王冠放大法术' }], cost: '永久遗忘' },
      characters: [
        { name: '伊莱', role: '主角', type: '流浪者' },
        { name: '赛琳', role: '盟友', affiliation: '港邦' },
        { name: '奥德', role: '导师', affiliation: '教会' },
        { name: '维克', role: '对手', affiliation: '北境' },
      ],
      mainPlot: [
        { phase: '开端', event: '主角接受护送任务' },
        { phase: '发展', event: '灰潮逼近并暴露教会阴谋' },
        { phase: '高潮', event: '盟约在王冠前决裂' },
        { phase: '结局', event: '主角献出记忆重建封印' },
      ],
      foreshadowing: [
        { setup: '王冠刻着主角旧名', payoff: '揭示其血统' },
        { setup: '壁画缺失圣徒', payoff: '揭示教会篡史' },
        { setup: '导师害怕钟声', payoff: '揭示灰潮起源' },
      ],
      constraints: { mustInclude: [], mustAvoid: [] },
    });

    expect(plan?.premise.coreConflict).toContain('不可逆选择');
    expect(plan?.protagonist.identity).toBe('流浪冒险者');
    expect(plan?.powerSystem.rules).toHaveLength(3);
    expect(plan?.mainPlot.ending).toContain('结局');
    expect(plan?.foreshadowing[0]).toContain('揭示其血统');
  });

  it('only skips first-turn consultation when the user explicitly authorizes it', () => {
    expect(hasExplicitPlanningBypass('题材你自己决定，直接开始')).toBe(true);
    expect(hasExplicitPlanningBypass('写一本西方玄幻小说')).toBe(false);
  });

  it('recognizes explicit genres without collapsing western fantasy into generic fantasy', () => {
    expect(inferExplicitGenre('写一本西方玄幻')).toBe('西方玄幻');
    expect(inferExplicitGenre('中式修仙门派')).toBe('仙侠');
    expect(inferExplicitGenre('校园现实成长，不要玄幻元素')).toBe('校园');
    expect(inferExplicitGenre('题材是校园，不得改成玄幻或修仙')).toBe('校园');
  });

  it('does not repeat a high-impact requirement after the user answers it', async () => {
    const service = new NovelPlanService(
      mockConfigService(),
      new QueueProxy([readyDecision(), readyDecision()]),
    );
    const result = await service.turn(
      {
        seedPrompt: '校园现实成长：县城高中女生组建广播站，不要玄幻元素',
        history: [
          {
            role: 'assistant',
            content: 'PLAN_QUESTION[core_protagonist_type] score=9: 主角以哪一种校园身份进入故事？',
          },
        ],
        answers: [
          {
            questionId: 'core_protagonist_type',
            selectedOptionIds: ['campus_transfer'],
            selectedOptionLabels: ['转学生 / 刚入学的新生'],
          },
        ],
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('asking');
    expect(result.questions?.map((question) => question.id)).not.toContain('core_protagonist_type');
    expect(result.questions?.map((question) => question.question).join(' ')).not.toMatch(/奇幻|魔法|骑士|王国/);
  });

  it('collects explicit scale labels and ids without treating 前N章 as total chapters', () => {
    expect(
      collectScaleFromSession([
        {
          role: 'user',
          content:
            '全书目标总字数大约多少？ → 约 10 万字\n每一章目标字数？ → 约 2000 字\n先规划写多少章？ → 10 章',
        },
      ]),
    ).toEqual({ totalWords: 100000, wordsPerChapter: 2000, chapterCount: 10 });
    expect(
      collectScaleFromSession([], [
        { questionId: 'chapter_count', selectedOptionIds: ['ch_50'] },
      ]).chapterCount,
    ).toBe(MAX_OUTLINE_CHAPTERS);
    expect(
      collectScaleFromSession([], [
        { questionId: 'target_volume_count', selectedOptionIds: ['volumes_5'] },
      ]).volumeCount,
    ).toBe(5);
    expect(extractScaleFromText('全书30万字，分成5卷').volumeCount).toBe(5);
    expect(extractScaleFromText('前3章要精彩，第1章内解决冲突').chapterCount).toBeUndefined();
  });

  it('accepts explicit chapter-count phrases', () => {
    expect(extractScaleFromText('计划写30章').chapterCount).toBe(30);
    expect(extractScaleFromText('写 10 章').chapterCount).toBe(10);
    expect(extractScaleFromText('10章大纲').chapterCount).toBe(10);
  });
});
