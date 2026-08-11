/**
 * Goal-driven novel planning agent.
 *
 * The planner treats every explicit user statement as durable story state. It
 * asks at most two blocking questions per turn and never walks a fixed survey.
 * When the available facts are sufficient, it chooses reversible defaults and
 * returns an executable brief plus chapter-level anchors immediately.
 */
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import { ProxyError } from '../../proxy/ProxyError.js';
import type {
  ChatMessage,
  ModelConfig,
  NovelPlanAnswer,
  NovelPlanChapterOutline,
  NovelPlanDepth,
  NovelPlanHistoryTurn,
  NovelPlanQuestion,
  NovelPlanSummary,
  NovelPlanTargetTask,
  NovelPlanTurnRequest,
  NovelPlanTurnResponse,
} from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { stripReasoningArtifacts } from '../text/reasoningSanitizer.js';

const MAX_QUESTIONS_PER_TURN = 2;
const MAX_OPTIONS_PER_QUESTION = 4;
const MAX_AGENT_ROUNDS = 3;
export const MAX_OUTLINE_CHAPTERS = 50;
const DEFAULT_WORDS_PER_CHAPTER = 2000;
const DEFAULT_CHAPTER_COUNT = 10;

/** Kept for transport compatibility; these are decision budgets, not surveys. */
export const DEPTH_LIMITS: Record<NovelPlanDepth, { min: number; max: number; label: string }> = {
  light: { min: 0, max: 1, label: '快速决策' },
  standard: { min: 0, max: 2, label: '自主策划' },
  deep: { min: 0, max: 3, label: '深度策划' },
};

const TARGET_LABELS: Record<NovelPlanTargetTask, string> = {
  novel: '设定与首章',
  full_novel: '快速整本草稿',
  long_novel: '持续按章创作',
  outline: '只生成设定与大纲',
  title: '从标题扩展故事',
};

const GENRE_PATTERNS: Array<[RegExp, string]> = [
  [/(?:西方玄幻|西幻|欧美奇幻)/, '西方玄幻'],
  [/(?:东方玄幻|中式玄幻)/, '东方玄幻'],
  [/(?:克苏鲁|洛夫克拉夫特)/i, '克苏鲁'],
  [/(?:赛博朋克|赛博)/, '赛博朋克'],
  [/(?:太空歌剧)/, '太空歌剧'],
  [/(?:硬科幻)/, '硬科幻'],
  [/(?:科幻)/, '科幻'],
  [/(?:仙侠|修仙)/, '仙侠'],
  [/(?:武侠)/, '武侠'],
  [/(?:玄幻)/, '玄幻'],
  [/(?:奇幻)/, '奇幻'],
  [/(?:末世|废土)/, '末世'],
  [/(?:悬疑|推理)/, '悬疑'],
  [/(?:恐怖|惊悚)/, '恐怖'],
  [/(?:历史)/, '历史'],
  [/(?:言情|爱情)/, '言情'],
  [/(?:都市)/, '都市'],
  [/(?:校园)/, '校园'],
];

interface Scale {
  totalWords?: number;
  wordsPerChapter?: number;
  chapterCount?: number;
}

interface AgentDecision {
  status: 'asking' | 'ready';
  message: string;
  questions: NovelPlanQuestion[];
  brief?: string;
  planSummary?: NovelPlanSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  if (typeof raw !== 'string') return undefined;
  const match = raw.replace(/[,，\s]/g, '').match(/\d+/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function inferExplicitGenre(text: string): string | undefined {
  for (const [pattern, genre] of GENRE_PATTERNS) {
    if (pattern.test(text)) return genre;
  }
  return undefined;
}

export function extractScaleFromText(text: string): Scale {
  const scale: Scale = {};
  const totalWan = text.match(/(?:总|全书|一共|约)?\s*(\d+(?:\.\d+)?)\s*万\s*字/);
  if (totalWan) scale.totalWords = Math.round(Number(totalWan[1]) * 10000);
  const totalPlain = text.match(/(?:总字数|全书|一共)[^\d]{0,8}(\d{4,8})\s*字?/);
  if (!scale.totalWords && totalPlain) scale.totalWords = Number(totalPlain[1]);
  const perChapter = text.match(/(?:每(?:一)?章|单章)[^\d\n]{0,20}(\d{3,5})\s*字?/);
  if (perChapter) scale.wordsPerChapter = Number(perChapter[1]);
  const chapterPatterns = [
    /(?:总章数|计划章节数|章节数|章数)[^\d]{0,8}(\d{1,3})/,
    /(?:计划写|先规划写?|一共|共写?|约写?)\s*(\d{1,3})\s*章/,
    /(?:计划写多少章|先规划写多少章)[^\d]{0,8}(\d{1,3})\s*章?/,
    /(?:^|[\s，。；;：:])写\s*(\d{1,3})\s*章(?!内)/,
    /(\d{1,3})\s*章\s*(?:左右|大纲|计划)/,
  ];
  for (const pattern of chapterPatterns) {
    const match = text.match(pattern);
    if (match) {
      scale.chapterCount = Number(match[1]);
      break;
    }
  }
  return scale;
}

function mergeScale(...parts: Scale[]): Scale {
  const result: Scale = {};
  for (const part of parts) {
    if (part.totalWords) result.totalWords = part.totalWords;
    if (part.wordsPerChapter) result.wordsPerChapter = part.wordsPerChapter;
    if (part.chapterCount) result.chapterCount = part.chapterCount;
  }
  if (result.totalWords && result.wordsPerChapter && !result.chapterCount) {
    result.chapterCount = Math.round(result.totalWords / result.wordsPerChapter);
  }
  if (result.totalWords && result.chapterCount && !result.wordsPerChapter) {
    result.wordsPerChapter = Math.round(result.totalWords / result.chapterCount);
  }
  if (result.wordsPerChapter && result.chapterCount && !result.totalWords) {
    result.totalWords = result.wordsPerChapter * result.chapterCount;
  }
  if (result.chapterCount) {
    result.chapterCount = Math.min(MAX_OUTLINE_CHAPTERS, Math.max(1, result.chapterCount));
  }
  return result;
}

function answerText(answer: NovelPlanAnswer): string {
  const labels = answer.selectedOptionLabels?.filter(Boolean) ?? [];
  const selections = labels.length > 0 ? labels : answer.selectedOptionIds;
  return [answer.questionId, selections.join('、'), answer.customText?.trim() ?? '']
    .filter(Boolean)
    .join('：');
}

function sessionText(
  seed: string,
  history: NovelPlanHistoryTurn[],
  answers?: NovelPlanAnswer[],
): string {
  const lines = [`原始需求：${seed}`];
  for (const turn of history) {
    lines.push(`${turn.role === 'user' ? '用户' : 'Agent'}：${turn.content}`);
  }
  for (const answer of answers ?? []) lines.push(`用户本轮回答：${answerText(answer)}`);
  return lines.join('\n');
}

export function collectScaleFromSession(
  history: NovelPlanHistoryTurn[],
  answers?: NovelPlanAnswer[],
  summary?: NovelPlanSummary,
  seed = '',
): Scale {
  const parts: Scale[] = [extractScaleFromText(seed)];
  for (const turn of history) parts.push(extractScaleFromText(turn.content));
  for (const answer of answers ?? []) {
    parts.push(extractScaleFromText(answerText(answer)));
    for (const id of answer.selectedOptionIds) {
      const total = id.match(/^total_(\d+)k$/);
      const wpc = id.match(/^wpc_(\d+)$/);
      const chapters = id.match(/^ch_(\d+)$/);
      if (total) parts.push({ totalWords: Number(total[1]) * 1000 });
      if (wpc) parts.push({ wordsPerChapter: Number(wpc[1]) });
      if (chapters) parts.push({ chapterCount: Number(chapters[1]) });
    }
  }
  if (summary) {
    parts.push({
      totalWords: summary.totalWords,
      wordsPerChapter: summary.wordsPerChapter,
      chapterCount: summary.chapterCount,
    });
  }
  return mergeScale(...parts);
}

function extractJsonObject(raw: string): unknown {
  const text = stripReasoningArtifacts(raw).trim();
  if (!text) throw new Error('empty model output');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('invalid json');
  }
}

function normalizeQuestion(raw: unknown, index: number): NovelPlanQuestion | undefined {
  if (!isRecord(raw)) return undefined;
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  if (!question) return undefined;
  const baseId = typeof raw.id === 'string' ? raw.id.trim() : '';
  const id = baseId || `blocking_${index + 1}`;
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map((item, optionIndex) => {
      if (!isRecord(item)) return undefined;
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      if (!label) return undefined;
      return {
        id:
          typeof item.id === 'string' && item.id.trim()
            ? item.id.trim()
            : `option_${optionIndex + 1}`,
        label,
        description:
          typeof item.description === 'string' && item.description.trim()
            ? item.description.trim()
            : undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .slice(0, MAX_OPTIONS_PER_QUESTION);
  if (options.length < 2) return undefined;
  return { id, question, multiSelect: raw.multiSelect === true, options };
}

function normalizeOutlines(
  raw: unknown,
  chapterCount: number,
  wordsPerChapter: number,
): NovelPlanChapterOutline[] {
  if (!Array.isArray(raw)) return [];
  const result: NovelPlanChapterOutline[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const goal = typeof item.goal === 'string' ? item.goal.trim() : '';
    if (!title || !goal) continue;
    result.push({
      number: result.length + 1,
      title,
      goal,
      estimatedWords: parsePositiveInt(item.estimatedWords) ?? wordsPerChapter,
    });
    if (result.length >= chapterCount) break;
  }
  return result;
}

function normalizeSummary(raw: unknown): NovelPlanSummary | undefined {
  if (!isRecord(raw)) return undefined;
  const text = (field: string): string | undefined => {
    const value = raw[field];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const constraints = Array.isArray(raw.constraints)
    ? raw.constraints
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    : undefined;
  const scale = mergeScale({
    totalWords: parsePositiveInt(raw.totalWords),
    wordsPerChapter: parsePositiveInt(raw.wordsPerChapter),
    chapterCount: parsePositiveInt(raw.chapterCount),
  });
  const chapterCount = scale.chapterCount ?? 0;
  const wordsPerChapter = scale.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER;
  const summary: NovelPlanSummary = {
    title: text('title'),
    genre: text('genre'),
    protagonist: text('protagonist'),
    hook: text('hook'),
    tone: text('tone'),
    constraints,
    totalWords: scale.totalWords,
    wordsPerChapter: scale.wordsPerChapter,
    chapterCount: scale.chapterCount,
    chapterOutlines:
      chapterCount > 0
        ? normalizeOutlines(raw.chapterOutlines, chapterCount, wordsPerChapter)
        : undefined,
  };
  return Object.values(summary).some((value) => value !== undefined) ? summary : undefined;
}

function normalizeDecision(raw: unknown): AgentDecision {
  if (!isRecord(raw)) throw new ProxyError('策划 Agent 未返回有效 JSON。');
  const summary = normalizeSummary(raw.planSummary);
  const requestedStatus = raw.status === 'asking' ? 'asking' : raw.status === 'ready' ? 'ready' : undefined;
  if (!requestedStatus) throw new ProxyError('策划 Agent 返回了未知状态。');
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .map(normalizeQuestion)
    .filter((item): item is NovelPlanQuestion => item !== undefined)
    .slice(0, MAX_QUESTIONS_PER_TURN);
  const message =
    typeof raw.message === 'string' && raw.message.trim()
      ? raw.message.trim()
      : requestedStatus === 'ready'
        ? '已根据现有信息形成可执行方案。'
        : '还缺少会改变故事方向的关键信息。';
  return {
    status: requestedStatus,
    message,
    questions,
    brief: typeof raw.brief === 'string' && raw.brief.trim() ? raw.brief.trim() : undefined,
    planSummary: summary,
  };
}

function questionSignature(value: string): string {
  return value
    .toLowerCase()
    .replace(/这本书|这个故事|小说|故事|请问|你希望|更偏向|更接近|什么|哪种|如何|怎么|是否/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function alreadyAsked(question: NovelPlanQuestion, history: NovelPlanHistoryTurn[]): boolean {
  const idPattern = new RegExp(`(?:^|\\b)${question.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|:)`, 'i');
  const signature = questionSignature(question.question);
  return history.some((turn) => {
    if (idPattern.test(turn.content)) return true;
    const contentSignature = questionSignature(turn.content);
    return signature.length >= 4 && contentSignature.includes(signature);
  });
}

function completeScale(scale: Scale, target: NovelPlanTargetTask): Required<Scale> {
  const defaultChapters = target === 'novel' || target === 'title' ? 1 : DEFAULT_CHAPTER_COUNT;
  const chapterCount = Math.min(
    MAX_OUTLINE_CHAPTERS,
    Math.max(1, scale.chapterCount ?? defaultChapters),
  );
  const wordsPerChapter = Math.max(500, scale.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER);
  const totalWords = Math.max(wordsPerChapter * chapterCount, scale.totalWords ?? 0);
  return { totalWords, wordsPerChapter, chapterCount };
}

function formatOutlines(outlines: NovelPlanChapterOutline[]): string {
  return outlines
    .map(
      (chapter) =>
        `### 第${chapter.number}章 ${chapter.title}\n- 目标字数：约 ${chapter.estimatedWords ?? '?'} 字\n- 本章任务：${chapter.goal}`,
    )
    .join('\n\n');
}

function enforceUserIntent(
  decision: AgentDecision,
  seed: string,
  history: NovelPlanHistoryTurn[],
  answers: NovelPlanAnswer[] | undefined,
  target: NovelPlanTargetTask,
): AgentDecision {
  if (decision.status !== 'ready' || !decision.planSummary) return decision;
  const grounding = sessionText(seed, history, answers);
  const explicitGenre = inferExplicitGenre(
    [seed, ...history.filter((turn) => turn.role === 'user').map((turn) => turn.content)].join('\n'),
  );
  const scale = completeScale(
    collectScaleFromSession(history, answers, decision.planSummary, seed),
    target,
  );
  const constraints = [...(decision.planSummary.constraints ?? [])];
  if (explicitGenre) {
    const rule = `题材固定为${explicitGenre}，不得替换成其他题材或时代背景`;
    if (!constraints.includes(rule)) constraints.unshift(rule);
  }
  const planSummary: NovelPlanSummary = {
    ...decision.planSummary,
    genre: explicitGenre ?? decision.planSummary.genre,
    constraints,
    ...scale,
    chapterOutlines: decision.planSummary.chapterOutlines,
    title: decision.planSummary.title ?? seed.slice(0, 24),
    hook: decision.planSummary.hook ?? seed,
  };
  const hardFacts = [
    '【用户硬约束（最高优先级）】',
    `- 原始需求：${seed}`,
    explicitGenre ? `- 明确题材：${explicitGenre}` : '',
    '- 后续生成不得用模板题材覆盖这些事实。',
  ]
    .filter(Boolean)
    .join('\n');
  const brief = decision.brief?.trim()
    ? `${hardFacts}\n\n${decision.brief.trim()}`
    : [
        hardFacts,
        '【策划状态】',
        grounding,
        '【规模】',
        `${scale.chapterCount} 章；每章约 ${scale.wordsPerChapter} 字；全书约 ${scale.totalWords} 字。`,
        '【分章大纲】',
        formatOutlines(planSummary.chapterOutlines ?? []),
      ].join('\n\n');
  return { ...decision, brief, planSummary };
}

export class NovelPlanService {
  constructor(
    private readonly modelConfigService: ModelConfigService,
    private readonly modelProxy: ModelProxy,
  ) {}

  async turn(request: NovelPlanTurnRequest, signal: AbortSignal): Promise<NovelPlanTurnResponse> {
    const seed = request.seedPrompt?.trim() ?? '';
    if (!seed) throw ServiceError.validation('seedPrompt 不能为空。');
    const config = await this.modelConfigService.getInternalConfig();
    if (!config) {
      throw ServiceError.modelNotConfigured('计划 Agent 需要真实模型，请先在设置中保存并测试 API。');
    }
    const history = Array.isArray(request.history) ? request.history : [];
    const target = request.targetTask ?? 'long_novel';
    const round = Math.min(
      MAX_AGENT_ROUNDS,
      1 + history.filter((turn) => turn.role === 'user').length,
    );
    const mustFinish = request.forceReady === true || round >= MAX_AGENT_ROUNDS;
    let decision = await this.generateDecision(
      config,
      seed,
      target,
      history,
      request.answers,
      mustFinish,
      signal,
    );

    if (decision.status === 'asking' && !mustFinish) {
      const questions = decision.questions.filter((question) => !alreadyAsked(question, history));
      if (questions.length > 0) {
        return {
          status: 'asking',
          round,
          message: decision.message,
          questions,
        };
      }
      decision = await this.generateDecision(
        config,
        seed,
        target,
        history,
        request.answers,
        true,
        signal,
      );
    }

    if (decision.status !== 'ready' || !decision.planSummary) {
      throw new ProxyError('策划 Agent 没有形成可执行方案，请重试本轮。');
    }
    decision = enforceUserIntent(decision, seed, history, request.answers, target);
    decision = await this.ensureChapterOutlines(
      config,
      decision,
      seed,
      history,
      request.answers,
      target,
      signal,
    );
    return {
      status: 'ready',
      round,
      message: decision.message,
      brief: decision.brief,
      planSummary: decision.planSummary,
    };
  }

  private async generateDecision(
    config: ModelConfig,
    seed: string,
    target: NovelPlanTargetTask,
    history: NovelPlanHistoryTurn[],
    answers: NovelPlanAnswer[] | undefined,
    forceReady: boolean,
    signal: AbortSignal,
  ): Promise<AgentDecision> {
    const explicitGenre = inferExplicitGenre(
      [seed, ...history.filter((turn) => turn.role === 'user').map((turn) => turn.content)].join('\n'),
    );
    const knownScale = collectScaleFromSession(history, answers, undefined, seed);
    const system = [
      '你是拥有决策权的小说总策划 Agent，不是固定问卷或工作流。只输出 JSON。',
      '循环：理解目标与已确认事实 → 判断是否存在真正阻塞创作的缺口 → 选择追问或直接形成方案。',
      '用户明确说过的题材、时代、地域、文化、人物、禁忌和规模都是不可覆盖的硬约束。',
      '禁止重复询问已明确的信息；禁止把西方玄幻改成校园、都市、修仙等其他核心类型。',
      '可安全推断的细节由你做专业决定，不向用户转嫁；只有答案会导致两种根本不同故事时才提问。',
      `asking 时最多 ${MAX_QUESTIONS_PER_TURN} 个阻塞问题，每题 2-${MAX_OPTIONS_PER_QUESTION} 个具体选项，id 使用稳定英文 snake_case。`,
      'ready 时 questions 必须为空，并返回完整 brief 与 planSummary。',
      'planSummary JSON 字段：title, genre, protagonist, hook, tone, constraints, totalWords, wordsPerChapter, chapterCount, chapterOutlines。',
      'chapterOutlines 每项字段：number, title, goal, estimatedWords；goal 必须含行动、冲突/变化、章末推进。',
      `下游目标：${TARGET_LABELS[target]}。`,
      forceReady
        ? '本轮必须 ready。信息不足时采用清晰、可修改的专业默认值，不得继续提问。'
        : '信息足以形成方向时立即 ready；不要为了凑轮数而提问。',
      explicitGenre ? `已识别硬约束题材：${explicitGenre}。planSummary.genre 必须完全保持。` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const user = [
      sessionText(seed, history, answers),
      `已识别规模：总字数=${knownScale.totalWords ?? '未指定'}；每章=${knownScale.wordsPerChapter ?? '未指定'}；章数=${knownScale.chapterCount ?? '未指定'}。`,
      '输出示例结构：{"status":"asking|ready","message":"...","questions":[],"brief":"...","planSummary":{}}',
    ].join('\n\n');
    const data = await this.collectJson(
      config,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      signal,
    );
    return normalizeDecision(data);
  }

  private async ensureChapterOutlines(
    config: ModelConfig,
    decision: AgentDecision,
    seed: string,
    history: NovelPlanHistoryTurn[],
    answers: NovelPlanAnswer[] | undefined,
    target: NovelPlanTargetTask,
    signal: AbortSignal,
  ): Promise<AgentDecision> {
    const summary = decision.planSummary!;
    const scale = completeScale(
      collectScaleFromSession(history, answers, summary, seed),
      target,
    );
    if ((summary.chapterOutlines?.length ?? 0) >= scale.chapterCount) {
      const outlines = normalizeOutlines(
        summary.chapterOutlines,
        scale.chapterCount,
        scale.wordsPerChapter,
      );
      const planSummary = { ...summary, ...scale, chapterOutlines: outlines };
      return {
        ...decision,
        planSummary,
        brief: this.buildFinalBrief(seed, decision.brief, planSummary),
      };
    }

    const explicitGenre = inferExplicitGenre(
      [seed, ...history.filter((turn) => turn.role === 'user').map((turn) => turn.content)].join('\n'),
    );
    const data = await this.collectJson(
      config,
      [
        {
          role: 'system',
          content: [
            '你是分章策划 Agent。只输出 JSON：{"chapterOutlines":[...]}。',
            `必须连续生成 ${scale.chapterCount} 章，每章约 ${scale.wordsPerChapter} 字，不得缺章、跳号或写正文。`,
            '每章 goal 必须写明：角色行动、具体冲突/状态变化、章末推进；相邻章节必须有因果关系。',
            '用户硬约束优先级最高，不得换题材、换时代、换文化背景。',
            explicitGenre ? `题材必须是：${explicitGenre}。` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        {
          role: 'user',
          content: [
            sessionText(seed, history, answers),
            '当前策划摘要：',
            JSON.stringify({ ...summary, chapterOutlines: undefined }, null, 2),
          ].join('\n\n'),
        },
      ],
      signal,
    );
    if (!isRecord(data)) throw new ProxyError('分章策划 Agent 未返回有效 JSON。');
    const outlines = normalizeOutlines(
      data.chapterOutlines,
      scale.chapterCount,
      scale.wordsPerChapter,
    );
    if (outlines.length !== scale.chapterCount) {
      throw new ProxyError(`分章策划 Agent 只返回 ${outlines.length}/${scale.chapterCount} 章，请重试。`);
    }
    const planSummary: NovelPlanSummary = { ...summary, ...scale, chapterOutlines: outlines };
    return {
      ...decision,
      planSummary,
      brief: this.buildFinalBrief(seed, decision.brief, planSummary),
    };
  }

  private buildFinalBrief(
    seed: string,
    modelBrief: string | undefined,
    summary: NovelPlanSummary,
  ): string {
    const hardFacts = [
      '【用户硬约束（最高优先级）】',
      `- 原始需求：${seed}`,
      summary.genre ? `- 题材：${summary.genre}` : '',
      ...(summary.constraints ?? []).map((constraint) => `- ${constraint}`),
    ]
      .filter(Boolean)
      .join('\n');
    return [
      hardFacts,
      modelBrief?.trim() ?? '',
      '【执行规模】',
      `${summary.chapterCount} 章；每章约 ${summary.wordsPerChapter} 字；全书约 ${summary.totalWords} 字。`,
      '【分章大纲】',
      formatOutlines(summary.chapterOutlines ?? []),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private async collectJson(
    config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<unknown> {
    let firstRaw = '';
    try {
      firstRaw = await this.collectText(config, messages, signal, true);
      return extractJsonObject(firstRaw);
    } catch (firstError) {
      if (signal.aborted) throw firstError;
      // Transport/provider failures already carry actionable diagnostics. A JSON
      // repair request would repeat the same failed network call and hide the cause.
      if (firstError instanceof ProxyError) throw firstError;
      const repairMessages: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: firstRaw.slice(0, 6000) || '（空响应）' },
        {
          role: 'user',
          content: '上一次不是有效 JSON。保留全部用户硬约束，只重新输出一个完整 JSON 对象，不要 Markdown。',
        },
      ];
      try {
        return extractJsonObject(await this.collectText(config, repairMessages, signal, true));
      } catch (repairError) {
        if (repairError instanceof ProxyError) throw repairError;
        throw new ProxyError('模型连续两次未返回有效 JSON，请重试。', { cause: repairError });
      }
    }
  }

  private async collectText(
    config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    jsonMode: boolean,
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const delta of this.modelProxy.streamCompletion(config, messages, signal, {
      jsonMode,
    })) {
      if (delta.kind === 'content') chunks.push(delta.text);
    }
    const text = stripReasoningArtifacts(chunks.join('')).trim();
    if (!text) throw new ProxyError('模型完成了请求，但没有返回可用内容。');
    return text;
  }
}
