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
  NovelStoryPlan,
} from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { stripReasoningArtifacts } from '../text/reasoningSanitizer.js';

const MAX_QUESTIONS_PER_TURN = 3;
const TOTAL_QUESTION_BUDGET = 3;
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
  const rawScore = typeof raw.impactScore === 'number' ? raw.impactScore : undefined;
  const impactScore = rawScore === undefined ? undefined : Math.max(0, Math.min(10, rawScore));
  return { id, question, impactScore, multiSelect: raw.multiSelect === true, options };
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

function stringArray(raw: unknown): string[] {
  const itemText = (item: unknown): string => {
    if (typeof item === 'string') return item.trim();
    if (typeof item === 'number' || typeof item === 'boolean') return String(item);
    if (!isRecord(item)) return '';
    const parts: string[] = [];
    for (const value of Object.values(item)) {
      if (typeof value === 'string' && value.trim()) parts.push(value.trim());
      else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value));
      else if (Array.isArray(value)) {
        const nested = value.map(itemText).filter(Boolean).join('、');
        if (nested) parts.push(nested);
      }
    }
    return Array.from(new Set(parts)).join('；');
  };
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return values.map(itemText).filter(Boolean);
}

function recordText(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function recordTextAny(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = recordText(record, key);
    if (value) return value;
  }
  return '';
}

function recordArrayAny(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string[] {
  for (const key of keys) {
    const values = stringArray(record?.[key]);
    if (values.length > 0) return values;
  }
  return [];
}

export function normalizeStoryPlan(raw: unknown): NovelStoryPlan | undefined {
  if (!isRecord(raw)) return undefined;
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  const premise = isRecord(raw.premise) ? raw.premise : undefined;
  const premiseText = typeof raw.premise === 'string' ? raw.premise.trim() : '';
  const protagonist = isRecord(raw.protagonist) ? raw.protagonist : undefined;
  const world = isRecord(raw.world) ? raw.world : undefined;
  const powerSystem = isRecord(raw.powerSystem)
    ? raw.powerSystem
    : isRecord(raw.power_system)
      ? raw.power_system
      : undefined;
  const mainPlot = isRecord(raw.mainPlot)
    ? raw.mainPlot
    : isRecord(raw.main_plot)
      ? raw.main_plot
      : undefined;
  const mainPlotStages = mainPlot ? [] : stringArray(raw.mainPlot ?? raw.main_plot);
  const constraints = isRecord(raw.constraints) ? raw.constraints : undefined;
  const characters = Array.isArray(raw.characters)
    ? raw.characters
        .filter(isRecord)
        .map((character) => ({
          name: recordText(character, 'name'),
          role: recordText(character, 'role'),
          identity: recordTextAny(character, 'identity', 'type', 'background') || undefined,
          traits: stringArray(character.traits ?? character.abilities),
          motivation: recordTextAny(character, 'motivation', 'goal') || undefined,
          goal: recordText(character, 'goal') || undefined,
          weakness: recordText(character, 'weakness') || undefined,
          arc: recordTextAny(character, 'arc', 'growthArc', 'growth_arc') || undefined,
        }))
        .filter((character) => character.name && character.role)
    : [];
  const volumes = Array.isArray(raw.volumes)
    ? raw.volumes
        .filter(isRecord)
        .map((volume, index) => ({
          number: parsePositiveInt(volume.number) ?? index + 1,
          title: recordText(volume, 'title'),
          goal: recordText(volume, 'goal'),
          chapterStart: parsePositiveInt(volume.chapterStart ?? volume.chapter_start) ?? 1,
          chapterEnd: parsePositiveInt(volume.chapterEnd ?? volume.chapter_end) ?? 1,
        }))
        .filter((volume) => volume.title && volume.goal)
    : [];
  const plan: NovelStoryPlan = {
    metadata: {
      title: recordText(metadata, 'title') || undefined,
      genre: recordText(metadata, 'genre') || undefined,
      targetLength: parsePositiveInt(metadata?.targetLength ?? metadata?.target_length),
      tone: recordText(metadata, 'tone') || undefined,
    },
    premise: {
      oneSentence: recordTextAny(premise, 'oneSentence', 'one_sentence') || premiseText,
      coreConflict:
        recordTextAny(premise, 'coreConflict', 'core_conflict') ||
        premiseText ||
        mainPlotStages[0] ||
        '',
      theme: recordText(premise, 'theme') || undefined,
    },
    protagonist: {
      name: recordText(protagonist, 'name') || undefined,
      age: parsePositiveInt(protagonist?.age),
      identity: recordTextAny(protagonist, 'identity', 'type', 'background'),
      personality: stringArray(protagonist?.personality),
      motivation: recordTextAny(protagonist, 'motivation', 'goal'),
      goal: recordText(protagonist, 'goal'),
      weakness: recordText(protagonist, 'weakness'),
      growthArc: recordTextAny(protagonist, 'growthArc', 'growth_arc', 'arc'),
    },
    world: {
      overview: recordText(world, 'overview'),
      regions: stringArray(world?.regions ?? world?.geography),
      countries: stringArray(world?.countries),
      races: stringArray(world?.races),
      religions: stringArray(world?.religions),
      factions: stringArray(world?.factions),
      history: stringArray(world?.history ?? world?.culture),
    },
    powerSystem: {
      rules: stringArray(powerSystem?.rules),
      levels: stringArray(powerSystem?.levels),
      limitations: stringArray(powerSystem?.limitations ?? powerSystem?.cost),
      specialCases: recordArrayAny(powerSystem, 'specialCases', 'special_cases'),
    },
    characters,
    factions: stringArray(raw.factions),
    mainPlot: {
      beginning: recordText(mainPlot, 'beginning') || mainPlotStages[0] || '',
      development:
        recordText(mainPlot, 'development') || mainPlotStages[1] || mainPlotStages[0] || '',
      climax:
        recordText(mainPlot, 'climax') ||
        mainPlotStages[Math.max(0, mainPlotStages.length - 2)] ||
        '',
      ending: recordText(mainPlot, 'ending') || mainPlotStages.at(-1) || '',
    },
    subplots: stringArray(raw.subplots),
    characterArcs: stringArray(raw.characterArcs ?? raw.character_arcs),
    volumes,
    foreshadowing: stringArray(raw.foreshadowing),
    mysteries: stringArray(raw.mysteries),
    constraints: {
      mustInclude: recordArrayAny(constraints, 'mustInclude', 'must_include'),
      mustAvoid: recordArrayAny(constraints, 'mustAvoid', 'must_avoid'),
    },
  };
  const hasContent = Boolean(
    plan.metadata.title ||
      plan.metadata.genre ||
      plan.premise.oneSentence ||
      plan.premise.coreConflict ||
      plan.protagonist.identity ||
      plan.world.overview ||
      plan.characters.length > 0 ||
      plan.mainPlot.beginning,
  );
  return hasContent ? plan : undefined;
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
    storyPlan: normalizeStoryPlan(raw.storyPlan),
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

const LOW_VALUE_QUESTION_PATTERN =
  /(?:几个国家|国家叫(?:什么|啥)|城市叫(?:什么|啥)|主角叫(?:什么|啥)|货币|公会.{0,8}分级|魔法.{0,8}(?:几级|等级名)|等级.{0,8}名称|精灵.{0,8}住|第一卷.{0,8}(?:Boss|反派)|第一次去.{0,8}城市)/i;

function isHighValueQuestion(question: NovelPlanQuestion): boolean {
  if (LOW_VALUE_QUESTION_PATTERN.test(question.question)) return false;
  return (question.impactScore ?? 8) >= 7;
}

function askedQuestionIds(
  history: NovelPlanHistoryTurn[],
  answers: NovelPlanAnswer[] | undefined,
): Set<string> {
  const ids = new Set((answers ?? []).map((answer) => answer.questionId).filter(Boolean));
  const pattern = /(?:PLAN_QUESTION|计划问题)\[([a-z0-9_:-]+)\]/gi;
  for (const turn of history) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(turn.content)) !== null) ids.add(match[1]!);
    if (turn.role === 'user') {
      for (const line of turn.content.split('\n')) {
        const answerId = line.match(/^\s*-\s*([a-z0-9_:-]+)\s*:/i)?.[1];
        if (answerId) ids.add(answerId);
      }
    }
  }
  return ids;
}

type CoreRequirement = 'genre' | 'main_direction' | 'protagonist_type' | 'tone';

function missingCoreRequirements(text: string): CoreRequirement[] {
  const missing: CoreRequirement[] = [];
  if (!inferExplicitGenre(text)) missing.push('genre');
  if (!/(?:冒险|成长|争霸|战争|领地|经营|学院|复仇|求生|探案|权谋|救世|成神|主线|目标)/.test(text)) {
    missing.push('main_direction');
  }
  if (!/(?:主角|冒险者|贵族|骑士|魔法师|法师|平民|穿越者|佣兵|猎人|王子|公主|领主|刺客|祭司)/.test(text)) {
    missing.push('protagonist_type');
  }
  if (!/(?:轻松|爽文|史诗|正统|黑暗|轻小说|群像|治愈|压抑|幽默|热血|基调|风格)/.test(text)) {
    missing.push('tone');
  }
  return missing;
}

function fallbackCoreQuestions(seed: string, limit: number): NovelPlanQuestion[] {
  const questions: Record<CoreRequirement, NovelPlanQuestion> = {
    genre: {
      id: 'genre_direction',
      question: '这本小说的核心题材希望是哪一种？',
      impactScore: 10,
      options: [
        { id: 'western_fantasy', label: '西方玄幻' },
        { id: 'eastern_fantasy', label: '东方玄幻' },
        { id: 'science_fiction', label: '科幻' },
        { id: 'agent_decides', label: 'Agent 自己决定' },
      ],
    },
    main_direction: {
      id: 'main_direction',
      question: '主线更偏向哪种方向？',
      impactScore: 9,
      options: [
        { id: 'adventure_growth', label: '冒险成长' },
        { id: 'war_conquest', label: '战争争霸' },
        { id: 'territory_building', label: '领地经营' },
        { id: 'agent_decides', label: 'Agent 自己决定' },
      ],
    },
    protagonist_type: {
      id: 'protagonist_type',
      question: '主角更偏哪种核心身份？',
      impactScore: 9,
      options: [
        { id: 'wanderer', label: '流浪冒险者' },
        { id: 'knight', label: '骑士或贵族' },
        { id: 'mage', label: '魔法师' },
        { id: 'agent_decides', label: 'Agent 自己决定' },
      ],
    },
    tone: {
      id: 'story_tone',
      question: '整体阅读风格希望偏哪种？',
      impactScore: 8,
      options: [
        { id: 'epic', label: '正统史诗' },
        { id: 'dark', label: '黑暗奇幻' },
        { id: 'light', label: '轻松爽文' },
        { id: 'agent_decides', label: 'Agent 自己决定' },
      ],
    },
  };
  return missingCoreRequirements(seed)
    .slice(0, Math.max(0, limit))
    .map((key) => questions[key]);
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

export function hasExplicitPlanningBypass(text: string): boolean {
  return /(?:你|由你|让你)?(?:自己|自行|全权)决定|无需(?:再)?提问|不用(?:再)?问|别问|直接(?:开始|生成|写)|跳过(?:提问|询问)/.test(
    text,
  );
}

function ensureStructuredStoryPlan(summary: NovelPlanSummary): NovelPlanSummary {
  const current = summary.storyPlan;
  const protagonist = current?.protagonist;
  const plan: NovelStoryPlan = {
    metadata: {
      ...current?.metadata,
      title: summary.title ?? current?.metadata.title,
      genre: summary.genre ?? current?.metadata.genre,
      targetLength: summary.totalWords ?? current?.metadata.targetLength,
      tone: summary.tone ?? current?.metadata.tone,
    },
    premise: {
      oneSentence: current?.premise.oneSentence || summary.hook || summary.title || '待正文展开',
      coreConflict: current?.premise.coreConflict || summary.hook || '主角必须在核心冲突中作出不可逆选择',
      theme: current?.premise.theme,
    },
    protagonist: {
      name: protagonist?.name,
      age: protagonist?.age,
      identity: protagonist?.identity || summary.protagonist || '由 Agent 在设定阶段完成',
      personality: protagonist?.personality ?? [],
      motivation: protagonist?.motivation || '推动核心目标',
      goal: protagonist?.goal || summary.hook || '完成主线目标',
      weakness: protagonist?.weakness || '会在主线中付出代价的内在缺陷',
      growthArc: protagonist?.growthArc || '在冲突中修正缺陷并完成成长',
    },
    world: {
      overview:
        current?.world.overview ||
        `${summary.genre ?? '小说'}类型世界，由 Agent 按类型约定自动补全。`,
      regions: current?.world.regions ?? [],
      countries: current?.world.countries ?? [],
      races: current?.world.races ?? [],
      religions: current?.world.religions ?? [],
      factions: current?.world.factions ?? [],
      history: current?.world.history ?? [],
    },
    powerSystem: {
      rules:
        current?.powerSystem.rules.length
          ? current.powerSystem.rules
          : ['力量的获得、使用、代价和上限必须在全书保持一致'],
      levels: current?.powerSystem.levels ?? [],
      limitations: current?.powerSystem.limitations ?? [],
      specialCases: current?.powerSystem.specialCases ?? [],
    },
    characters: current?.characters ?? [],
    factions: current?.factions ?? [],
    mainPlot: {
      beginning:
        current?.mainPlot.beginning ||
        summary.chapterOutlines?.[0]?.goal ||
        summary.hook ||
        '建立主角与导火索',
      development:
        current?.mainPlot.development || '冲突升级，主角获得线索并承担更高代价',
      climax: current?.mainPlot.climax || '核心矛盾正面爆发，主角作出不可逆选择',
      ending: current?.mainPlot.ending || '兑现核心钩子并完成本阶段人物弧光',
    },
    subplots: current?.subplots ?? [],
    characterArcs: current?.characterArcs ?? [],
    volumes: current?.volumes ?? [],
    foreshadowing: current?.foreshadowing ?? [],
    mysteries: current?.mysteries ?? [],
    constraints: {
      mustInclude: current?.constraints.mustInclude ?? [],
      mustAvoid: Array.from(
        new Set([...(current?.constraints.mustAvoid ?? []), ...(summary.constraints ?? [])]),
      ),
    },
  };
  return { ...summary, storyPlan: plan };
}

function storyPlanQualityIssues(plan: NovelStoryPlan | undefined): string[] {
  if (!plan) return ['Story Plan 根对象'];
  const issues: string[] = [];
  if (plan.premise.oneSentence.length < 8) issues.push('一句话前提');
  if (plan.premise.coreConflict.length < 8) issues.push('核心冲突');
  if (plan.protagonist.identity.length < 2) issues.push('主角身份');
  if (plan.protagonist.goal.length < 4) issues.push('主角目标');
  if (plan.world.overview.length < 80) issues.push(`世界概述(${plan.world.overview.length}/80)`);
  if (plan.powerSystem.rules.length < 3) issues.push(`力量规则(${plan.powerSystem.rules.length}/3)`);
  if (plan.characters.length < 4) issues.push(`人物(${plan.characters.length}/4)`);
  const plotParts = [
    plan.mainPlot.beginning,
    plan.mainPlot.development,
    plan.mainPlot.climax,
    plan.mainPlot.ending,
  ].filter((part) => part.length >= 4).length;
  if (plotParts < 4) issues.push(`主线四段(${plotParts}/4)`);
  if (plan.foreshadowing.length < 3) issues.push(`伏笔(${plan.foreshadowing.length}/3)`);
  return issues;
}

function isCompleteStoryPlan(plan: NovelStoryPlan | undefined): boolean {
  return storyPlanQualityIssues(plan).length === 0;
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
    const isFirstTurn = history.length === 0 && (request.answers?.length ?? 0) === 0;
    const bypass = hasExplicitPlanningBypass(seed);
    const askedIds = askedQuestionIds(history, request.answers);
    const questionBudget = Math.max(0, TOTAL_QUESTION_BUDGET - askedIds.size);
    const knownText = sessionText(seed, history, request.answers);
    const coreFallback = isFirstTurn && !bypass ? fallbackCoreQuestions(knownText, questionBudget) : [];
    const round = Math.min(
      MAX_AGENT_ROUNDS,
      1 + history.filter((turn) => turn.role === 'user').length,
    );
    const mustFinish = bypass || request.forceReady === true || questionBudget === 0 || round >= MAX_AGENT_ROUNDS;
    if (!mustFinish && coreFallback.length > 0) {
      return {
        status: 'asking',
        round,
        message: '只确认会改变整本小说方向的决定；其他设定由 Agent 自动完成。',
        questions: coreFallback,
      };
    }
    let decision = await this.generateDecision(
      config,
      seed,
      target,
      history,
      request.answers,
      mustFinish,
      questionBudget,
      missingCoreRequirements(knownText),
      signal,
    );

    if (!mustFinish && decision.status === 'asking') {
      const questions = decision.questions
        .filter(isHighValueQuestion)
        .filter((question) => !alreadyAsked(question, history))
        .slice(0, questionBudget);
      if (questions.length > 0) {
        return {
          status: 'asking',
          round,
          message: decision.message,
          questions,
        };
      }
    }

    if (decision.status !== 'ready' || !decision.planSummary) {
      decision = await this.generateDecision(
        config,
        seed,
        target,
        history,
        request.answers,
        true,
        0,
        [],
        signal,
      );
    }

    if (decision.status !== 'ready' || !decision.planSummary) {
      throw new ProxyError('策划 Agent 没有形成可执行方案，请重试本轮。');
    }
    decision = enforceUserIntent(decision, seed, history, request.answers, target);
    const [storyDecision, outlineDecision] = await Promise.all([
      this.ensureStoryPlan(config, decision, seed, history, request.answers, signal),
      this.ensureChapterOutlines(
        config,
        decision,
        seed,
        history,
        request.answers,
        target,
        signal,
      ),
    ]);
    const mergedSummary = ensureStructuredStoryPlan({
      ...outlineDecision.planSummary,
      storyPlan: storyDecision.planSummary?.storyPlan,
    });
    decision = {
      ...decision,
      planSummary: mergedSummary,
      brief: this.buildFinalBrief(seed, decision.brief, mergedSummary),
    };
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
    questionBudget: number,
    missingCore: CoreRequirement[],
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
      `主动提问总预算剩余 ${questionBudget} 题；asking 时不得超过该预算，每题 2-${MAX_OPTIONS_PER_QUESTION} 个具体选项，必须含 impactScore（0-10）与稳定英文 snake_case id。`,
      '只有 impactScore >= 7 且同时满足“无法合理推断、显著改变主线、后期修改成本高”的问题才允许询问。',
      '国家/城市/人物姓名、货币、等级名称、普通配角、普通反派、支线和世界细节由你直接创造，禁止询问。',
      'ready 时 questions 必须为空，并返回完整 brief 与 planSummary。',
      'planSummary JSON 字段：title, genre, protagonist, hook, tone, constraints, totalWords, wordsPerChapter, chapterCount, chapterOutlines。',
      '本模块只做是否追问与方向收束，不生成 storyPlan；完整 Story Plan 由后续专用 Agent 一次生成。',
      'chapterOutlines 每项字段：number, title, goal, estimatedWords；goal 必须含行动、冲突/变化、章末推进。',
      `下游目标：${TARGET_LABELS[target]}。`,
      forceReady
        ? '本轮必须 ready。信息不足时采用清晰、可修改的专业默认值，不得继续提问。'
        : '信息足以形成方向时可以 0 问并立即 ready；不要为了凑轮数而提问。',
      missingCore.length > 0
        ? `Requirement State 尚缺核心方向：${missingCore.join('、')}。只从这些缺口中选择真正高影响的问题。`
        : 'Requirement State 的核心方向已足够；除非存在新的不可逆重大分叉，否则直接 ready。',
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

  private async ensureStoryPlan(
    config: ModelConfig,
    decision: AgentDecision,
    seed: string,
    history: NovelPlanHistoryTurn[],
    answers: NovelPlanAnswer[] | undefined,
    signal: AbortSignal,
  ): Promise<AgentDecision> {
    const summary = decision.planSummary!;
    if (isCompleteStoryPlan(summary.storyPlan)) return decision;
    const data = await this.collectJson(
      config,
      [
        {
          role: 'system',
          content: [
            '你是 Story Plan 架构 Agent。只输出 JSON：{"storyPlan":{...}}，不要输出分章大纲或正文。',
            '用户已决定“想看什么”，你负责完整决定“怎么写”；禁止向用户追加问题。',
            '自动创造国家、城市、历史、种族、宗教、派系、力量体系、配角、反派、支线、伏笔和谜团。',
            'storyPlan 使用 camelCase，必须完整包含 metadata、premise、protagonist、world、powerSystem、characters、factions、mainPlot、subplots、characterArcs、volumes、foreshadowing、mysteries、constraints。',
            '质量下限：world.overview 至少 80 字；powerSystem.rules 至少 3 条；characters 至少 4 人；mainPlot 四段完整；foreshadowing 至少 3 条。',
            '控制篇幅：整个 JSON 不超过 3500 个汉字；世界概述 80-160 字；人物 4-6 人；每个数组 3-6 项；每项只保留可执行信息。',
            '所有内容必须服从用户明确题材、人物方向、风格、禁忌与规模，不得套用其他题材模板。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            sessionText(seed, history, answers),
            '已确认策划摘要：',
            JSON.stringify({ ...summary, storyPlan: undefined }, null, 2),
          ].join('\n\n'),
        },
      ],
      signal,
      6000,
    );
    if (!isRecord(data)) throw new ProxyError('Story Plan Agent 未返回有效 JSON。');
    const nestedSummary = isRecord(data.planSummary)
      ? data.planSummary
      : isRecord(data.plan_summary)
        ? data.plan_summary
        : undefined;
    const normalizedStoryPlan = normalizeStoryPlan(
      data.storyPlan ??
        data.story_plan ??
        nestedSummary?.storyPlan ??
        nestedSummary?.story_plan,
    );
    const storyPlan = ensureStructuredStoryPlan({
      ...summary,
      storyPlan: normalizedStoryPlan,
    }).storyPlan;
    if (!isCompleteStoryPlan(storyPlan)) {
      throw new ProxyError(
        `Story Plan Agent 返回的信息不完整：${storyPlanQualityIssues(storyPlan).join('、')}。`,
      );
    }
    return { ...decision, planSummary: { ...summary, storyPlan } };
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
      const planSummary = ensureStructuredStoryPlan({
        ...summary,
        ...scale,
        chapterOutlines: outlines,
      });
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
    const planSummary = ensureStructuredStoryPlan({
      ...summary,
      ...scale,
      chapterOutlines: outlines,
    });
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
      '【结构化 Story Plan】',
      JSON.stringify(summary.storyPlan, null, 2),
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
    maxTokens?: number,
  ): Promise<unknown> {
    let firstRaw = '';
    try {
      firstRaw = await this.collectText(config, messages, signal, true, maxTokens);
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
        return extractJsonObject(
          await this.collectText(config, repairMessages, signal, true, maxTokens),
        );
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
    maxTokens?: number,
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const delta of this.modelProxy.streamCompletion(config, messages, signal, {
      jsonMode,
      disableThinking: jsonMode,
      maxTokens,
    })) {
      if (delta.kind === 'content') chunks.push(delta.text);
    }
    const text = stripReasoningArtifacts(chunks.join('')).trim();
    if (!text) throw new ProxyError('模型完成了请求，但没有返回可用内容。');
    return text;
  }
}
