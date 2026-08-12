/**
 * Goal-driven novel planning agent.
 *
 * The planner treats every explicit user statement as durable story state. It
 * asks only for unresolved high-impact requirements and never walks a fixed survey.
 * When the available facts are sufficient, it chooses reversible defaults and
 * returns an executable brief plus chapter-level anchors immediately.
 */
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import { ProxyError } from '../../proxy/ProxyError.js';
import type {
  ChatMessage,
  ModelConfig,
  NovelPlanAnswer,
  NovelPlanChecklist,
  NovelPlanConfig,
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

const MAX_QUESTIONS_PER_TURN = 5;
const TOTAL_QUESTION_BUDGET = 10;
const MAX_OPTIONS_PER_QUESTION = 4;
const MAX_AGENT_ROUNDS = 5;
/** Maximum total chapters kept in a plan. Detailed chapter anchors are rolled out in batches. */
const MAX_PLAN_CHAPTERS = 1000;
/** Maximum chapter anchors requested in one model call, preventing 400-chapter prompt timeouts. */
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
  volumeCount?: number;
}

interface AgentDecision {
  status: 'asking' | 'ready';
  message: string;
  questions: NovelPlanQuestion[];
  planningChecklist?: NovelPlanChecklist;
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
  const totalWan = text.match(/(?:总|全书|一共|约)?\s*(\d+(?:\.\d+)?)\s*万\s*字?/);
  if (totalWan) scale.totalWords = Math.round(Number(totalWan[1]) * 10000);
  const totalPlain = text.match(/(?:总字数|全书|一共)[^\d]{0,8}(\d{4,8})\s*字?/);
  if (!scale.totalWords && totalPlain) scale.totalWords = Number(totalPlain[1]);
  const perChapter = text.match(/(?:每(?:一)?章|单章)[^\d\n]{0,20}(\d{3,5})\s*字?/);
  if (perChapter) scale.wordsPerChapter = Number(perChapter[1]);
  const volume = text.match(/(?:分成|共|目标)?\s*(\d{1,2})\s*卷/);
  if (volume) scale.volumeCount = Number(volume[1]);
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
    if (part.volumeCount) result.volumeCount = part.volumeCount;
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
    result.chapterCount = Math.min(MAX_PLAN_CHAPTERS, Math.max(1, result.chapterCount));
  }
  return result;
}

function planConfigText(config: NovelPlanConfig | undefined): string {
  if (!config) return '';
  return [
    '结构化计划配置（用户明确填写的字段优先级最高）：',
    config.targetTotalWords ? `- 全文目标字数：${config.targetTotalWords}` : '',
    config.targetTotalChapters ? `- 总章节数：${config.targetTotalChapters}` : '',
    config.targetWordsPerChapter
      ? `- 单章目标字数：${config.targetWordsPerChapter.min}-${config.targetWordsPerChapter.max}`
      : '',
    config.targetVolumeCount ? `- 目标卷数：${config.targetVolumeCount}` : '',
    config.genres?.length ? `- 小说类型：${config.genres.join(' + ')}` : '',
    config.coreStory ? `- 核心剧情：${config.coreStory}` : '',
    config.endingDirection ? `- 结局方向：${config.endingDirection}` : '',
    config.writingRequirements ? `- 额外要求：${config.writingRequirements}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function scaleFromPlanConfig(config: NovelPlanConfig | undefined): Scale {
  return {
    totalWords: config?.targetTotalWords,
    chapterCount: config?.targetTotalChapters,
    wordsPerChapter: config?.targetWordsPerChapter?.max,
    volumeCount: config?.targetVolumeCount,
  };
}

function planConfigConflict(config: NovelPlanConfig | undefined): string | undefined {
  if (!config?.targetTotalWords || !config.targetTotalChapters || !config.targetWordsPerChapter) {
    return undefined;
  }
  const { min, max } = config.targetWordsPerChapter;
  const lower = config.targetTotalChapters * min;
  const upper = config.targetTotalChapters * max;
  if (config.targetTotalWords >= lower && config.targetTotalWords <= upper) return undefined;
  return `字数约束存在数学冲突：${config.targetTotalChapters}章×${min}-${max}字的可行范围为${lower}-${upper}字；请以全文目标或单章范围为准并在后续计划中调整。`;
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
      const totalMillions = id.match(/^total_(\d+)m$/);
      const wpc = id.match(/^wpc_(\d+)$/);
      const chapters = id.match(/^ch_(\d+)$/);
      const volumes = id.match(/^volumes_(\d+)$/);
      if (total) parts.push({ totalWords: Number(total[1]) * 1000 });
      if (totalMillions) parts.push({ totalWords: Number(totalMillions[1]) * 1_000_000 });
      if (wpc) parts.push({ wordsPerChapter: Number(wpc[1]) });
      if (chapters) parts.push({ chapterCount: Number(chapters[1]) });
      if (volumes) parts.push({ volumeCount: Number(volumes[1]) });
    }
  }
  if (summary) {
    parts.push({
      totalWords: summary.totalWords,
      wordsPerChapter: summary.wordsPerChapter,
      chapterCount: summary.chapterCount,
      volumeCount: summary.volumeCount,
    });
    parts.push(scaleFromPlanConfig(summary.planConfig));
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
  startNumber = 1,
): NovelPlanChapterOutline[] {
  const rows = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? Object.values(raw).filter(isRecord)
      : [];
  const result: NovelPlanChapterOutline[] = [];
  for (const item of rows) {
    if (!isRecord(item)) continue;
    const title = recordTextAny(item, 'title', 'name', 'chapterTitle', 'chapter_title', '章节标题');
    const goal = recordTextAny(
      item,
      'goal',
      'summary',
      'outline',
      'plot',
      'objective',
      'content',
      'chapterGoal',
      'chapter_goal',
      '本章任务',
      '章节概要',
    );
    if (!title || !goal) continue;
    result.push({
      number: startNumber + result.length,
      title,
      goal,
      estimatedWords:
        parsePositiveInt(
          item.estimatedWords ??
            item.estimated_words ??
            item.wordCount ??
            item.word_count ??
            item.targetWords ??
            item.target_words ??
            item.目标字数,
        ) ?? wordsPerChapter,
    });
    if (result.length >= chapterCount) break;
  }
  return result;
}

function outlinePayload(data: Record<string, unknown>): unknown {
  const summary = isRecord(data.planSummary)
    ? data.planSummary
    : isRecord(data.plan_summary)
      ? data.plan_summary
      : undefined;
  return (
    data.chapterOutlines ??
    data.chapter_outlines ??
    data.chapters ??
    data.outlines ??
    data.分章大纲 ??
    summary?.chapterOutlines ??
    summary?.chapter_outlines ??
    summary?.chapters
  );
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
          targetWords: parsePositiveInt(volume.targetWords ?? volume.target_words),
          mainConflict: recordTextAny(volume, 'mainConflict', 'main_conflict') || undefined,
          climax: recordText(volume, 'climax') || undefined,
          endingHook: recordTextAny(volume, 'endingHook', 'ending_hook') || undefined,
          stages: Array.isArray(volume.stages)
            ? volume.stages
                .filter(isRecord)
                .map((stage) => ({
                  title: recordText(stage, 'title'),
                  chapterStart: parsePositiveInt(stage.chapterStart ?? stage.chapter_start) ?? 1,
                  chapterEnd: parsePositiveInt(stage.chapterEnd ?? stage.chapter_end) ?? 1,
                  goal: recordText(stage, 'goal'),
                  climax: recordText(stage, 'climax') || undefined,
                  endingState: recordTextAny(stage, 'endingState', 'ending_state') || undefined,
                }))
                .filter((stage) => stage.title && stage.goal)
            : undefined,
        }))
        .filter((volume) => volume.title && volume.goal)
    : [];
  const plan: NovelStoryPlan = {
    metadata: {
      title: recordText(metadata, 'title') || undefined,
      genre: recordText(metadata, 'genre') || undefined,
      targetLength: parsePositiveInt(metadata?.targetLength ?? metadata?.target_length),
      tone: recordText(metadata, 'tone') || undefined,
      targetTotalChapters: parsePositiveInt(
        metadata?.targetTotalChapters ?? metadata?.target_total_chapters,
      ),
      targetWordsPerChapterMin: parsePositiveInt(
        metadata?.targetWordsPerChapterMin ?? metadata?.target_words_per_chapter_min,
      ),
      targetWordsPerChapterMax: parsePositiveInt(
        metadata?.targetWordsPerChapterMax ?? metadata?.target_words_per_chapter_max,
      ),
      targetVolumeCount: parsePositiveInt(
        metadata?.targetVolumeCount ?? metadata?.target_volume_count,
      ),
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
  const genres = Array.isArray(raw.genres)
    ? raw.genres
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    : undefined;
  const scale = mergeScale({
    totalWords: parsePositiveInt(raw.totalWords),
    wordsPerChapter: parsePositiveInt(raw.wordsPerChapter),
    chapterCount: parsePositiveInt(raw.chapterCount),
    volumeCount: parsePositiveInt(raw.volumeCount ?? raw.targetVolumeCount ?? raw.target_volume_count),
  });
  const chapterCount = scale.chapterCount ?? 0;
  const wordsPerChapter = scale.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER;
  const summary: NovelPlanSummary = {
    title: text('title'),
    genre: text('genre'),
    genres,
    protagonist: text('protagonist'),
    hook: text('hook'),
    tone: text('tone'),
    constraints,
    totalWords: scale.totalWords,
    wordsPerChapter: scale.wordsPerChapter,
    chapterCount: scale.chapterCount,
    volumeCount: scale.volumeCount,
    plannedThroughChapter: parsePositiveInt(
      raw.plannedThroughChapter ?? raw.planned_through_chapter,
    ),
    chapterOutlines:
      chapterCount > 0
        ? normalizeOutlines(raw.chapterOutlines, chapterCount, wordsPerChapter)
        : undefined,
    storyPlan: normalizeStoryPlan(raw.storyPlan),
  };
  return Object.values(summary).some((value) => value !== undefined) ? summary : undefined;
}

function normalizeChecklist(raw: unknown): NovelPlanChecklist | undefined {
  if (!isRecord(raw)) return undefined;
  const read = (...keys: string[]): string[] => {
    for (const key of keys) {
      const value = raw[key];
      if (Array.isArray(value)) {
        return value
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
          .slice(0, 8);
      }
    }
    return [];
  };
  const checklist: NovelPlanChecklist = {
    confirmedFacts: read('confirmedFacts', 'confirmed_facts', 'confirmed'),
    unresolvedDecisions: read('unresolvedDecisions', 'unresolved_decisions', 'unresolved'),
    safeDefaults: read('safeDefaults', 'safe_defaults', 'defaults'),
    hardConstraints: read('hardConstraints', 'hard_constraints', 'constraints'),
  };
  return Object.values(checklist).some((items) => items.length > 0) ? checklist : undefined;
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
    planningChecklist: normalizeChecklist(raw.planningChecklist ?? raw.planning_checklist),
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

type CoreRequirement = 'genre' | 'main_direction' | 'protagonist_type';
type PlanRequirement =
  | CoreRequirement
  | 'core_story'
  | 'target_total_words'
  | 'target_total_chapters'
  | 'target_words_per_chapter'
  | 'target_volume_count'
  | 'ending_direction'
  | 'writing_requirements';

function missingCoreRequirements(text: string): CoreRequirement[] {
  const missing: CoreRequirement[] = [];
  if (!inferExplicitGenre(text)) missing.push('genre');
  if (!/(?:冒险|成长|争霸|战争|领地|经营|学院|复仇|求生|探案|权谋|救世|成神|主线|目标|学业|竞赛|社团|恋爱|友情|秘密|调查|生存|阴谋|文明|探索|案件|失踪|职业|事业|家庭|关系|科技|灾难)/.test(text)) {
    missing.push('main_direction');
  }
  if (!/(?:主角|冒险者|贵族|骑士|魔法师|法师|平民|穿越者|佣兵|猎人|王子|公主|领主|刺客|祭司|学生|转学生|新生|社团成员|竞赛选手|老师|教师|校长|班主任|研究员|工程师|探险者|幸存者)/.test(text)) {
    missing.push('protagonist_type');
  }
  return missing;
}

function missingPlanRequirements(text: string, config: NovelPlanConfig | undefined, scale: Scale): PlanRequirement[] {
  const missing: PlanRequirement[] = [...missingCoreRequirements(text)];
  const hasCoreStory = Boolean(config?.coreStory?.trim()) || text.replace(/原始需求：|写本小说|请开始计划|计划模式/gu, '').trim().length >= 18;
  if (!scale.totalWords) missing.push('target_total_words');
  if (!scale.chapterCount) missing.push('target_total_chapters');
  if (!scale.wordsPerChapter) missing.push('target_words_per_chapter');
  if (!scale.volumeCount && !config?.targetVolumeCount) missing.push('target_volume_count');
  if (!hasCoreStory) missing.push('core_story');
  if (!config?.endingDirection?.trim() && !/(大团圆|圆满|悲剧|苦涩|苦尽甘来|开放式|开放结局|好结局|坏结局)/.test(text)) {
    missing.push('ending_direction');
  }
  if (!config?.writingRequirements?.trim() && !/(慢热|快节奏|轻松|压抑|群像|不后宫|无后宫|第一人称|第三人称|克制|爽文|严肃|幽默)/.test(text)) {
    missing.push('writing_requirements');
  }
  return missing;
}

function planRequirementsQuestions(missing: PlanRequirement[], topicText = ''): NovelPlanQuestion[] {
  const genre = inferExplicitGenre(topicText);
  const topicMainDirection: NovelPlanQuestion = genre === '校园'
    ? {
        id: 'core_main_direction',
        question: '在校园环境中，主线冲突优先围绕哪种核心体验展开？',
        impactScore: 10,
        options: [
          { id: 'campus_growth', label: '学业 / 能力成长与自我突破' },
          { id: 'campus_competition', label: '社团、竞赛或校园荣誉争夺' },
          { id: 'campus_relationships', label: '友情、恋爱与关系选择' },
          { id: 'campus_secret', label: '校园秘密、调查与真相' },
        ],
      }
    : genre === '科幻'
      ? {
          id: 'core_main_direction',
          question: '在科幻世界中，主线冲突优先围绕哪种核心问题展开？',
          impactScore: 10,
          options: [
            { id: 'science_exploration', label: '探索未知与科学突破' },
            { id: 'science_survival', label: '灾难环境中的生存与迁徙' },
            { id: 'science_conspiracy', label: '科技垄断、阴谋与反抗' },
            { id: 'science_civilization', label: '文明存亡与第一接触' },
          ],
        }
      : genre === '悬疑'
        ? {
            id: 'core_main_direction',
            question: '在悬疑故事中，主线调查优先围绕哪种谜团展开？',
            impactScore: 10,
            options: [
              { id: 'mystery_case', label: '追查一桩具体案件' },
              { id: 'mystery_missing', label: '寻找失踪者或失落之物' },
              { id: 'mystery_identity', label: '揭开人物身份与过去' },
              { id: 'mystery_conspiracy', label: '拆穿组织阴谋或连环事件' },
            ],
          }
        : genre === '都市'
          ? {
              id: 'core_main_direction',
              question: '在现实 / 都市环境中，主线冲突优先围绕哪种目标展开？',
              impactScore: 10,
              options: [
                { id: 'urban_career', label: '职业选择与事业突破' },
                { id: 'urban_relationships', label: '家庭、友情或亲密关系' },
                { id: 'urban_revenge', label: '现实困境中的反击与翻身' },
                { id: 'urban_secret', label: '调查身边秘密并改变生活' },
              ],
            }
          : {
              id: 'core_main_direction',
              question: '主线冲突优先围绕哪一种目标展开？',
              impactScore: 10,
              options: [
                { id: 'adventure_growth', label: '冒险成长' },
                { id: 'war_and_kingdom', label: '战争与争霸' },
                { id: 'revenge_and_truth', label: '复仇与真相' },
                { id: 'survival_escape', label: '求生与逃亡' },
              ],
            };
  const topicProtagonist: NovelPlanQuestion | undefined = genre === '校园'
    ? {
        id: 'core_protagonist_type',
        question: '主角以哪一种校园身份或人生起点进入故事？',
        impactScore: 9,
        options: [
          { id: 'campus_transfer', label: '转学生 / 刚入学的新生' },
          { id: 'campus_achiever', label: '资优生 / 竞赛选手' },
          { id: 'campus_troublemaker', label: '问题学生 / 留级生' },
          { id: 'campus_club_member', label: '普通学生 / 社团成员' },
        ],
      }
    : genre === '科幻'
      ? {
          id: 'core_protagonist_type',
          question: '主角以哪一种科幻身份或处境进入故事？',
          impactScore: 9,
          options: [
            { id: 'science_engineer', label: '工程师 / 科研人员' },
            { id: 'science_explorer', label: '探险者 / 舰船成员' },
            { id: 'science_survivor', label: '灾难幸存者 / 普通人' },
            { id: 'science_ai', label: '人工智能或改造人' },
          ],
        }
      : undefined;
  const topicStory: NovelPlanQuestion | undefined = genre === '校园'
    ? {
        id: 'core_story',
        question: '这所校园里最值得展开的一句话故事钩子是什么？',
        impactScore: 10,
        options: [
          { id: 'campus_hidden_rule', label: '学校有一条不能触碰的隐藏规则' },
          { id: 'campus_competition', label: '一场比赛或选拔改变了主角的人生' },
          { id: 'campus_relationship', label: '一段关系迫使主角作出选择' },
          { id: 'campus_past', label: '校园旧案或秘密重新浮出水面' },
        ],
      }
    : genre === '悬疑'
      ? {
          id: 'core_story',
          question: '这起案件最核心的一句话故事钩子是什么？',
          impactScore: 10,
          options: [
            { id: 'mystery_impossible', label: '一桩看似不可能发生的案件' },
            { id: 'mystery_missing_truth', label: '失踪者留下改变全局的线索' },
            { id: 'mystery_unreliable', label: '所有证词都可能不可信' },
            { id: 'mystery_personal', label: '案件与主角过去有直接关系' },
          ],
        }
      : undefined;
  const questions: Record<PlanRequirement, NovelPlanQuestion> = {
    genre: {
      id: 'core_genre',
      question: '这本小说的题材类型是什么？',
      impactScore: 10,
      options: [
        { id: 'eastern_fantasy', label: '东方玄幻 / 仙侠' },
        { id: 'western_fantasy', label: '西方玄幻' },
        { id: 'science_fiction', label: '科幻' },
        { id: 'mystery', label: '悬疑 / 推理' },
      ],
    },
    main_direction: topicMainDirection,
    protagonist_type: topicProtagonist ?? {
      id: 'core_protagonist_type',
      question: '主角以哪一种身份或起点进入故事？',
      impactScore: 9,
      options: [
        { id: 'ordinary_person', label: '普通人 / 平民' },
        { id: 'knight_warrior', label: '骑士 / 战士' },
        { id: 'mage_scholar', label: '法师 / 学者' },
        { id: 'noble_heir', label: '贵族 / 继承人' },
      ],
    },
    core_story: topicStory ?? {
      id: 'core_story',
      question: '这本小说最核心的一句话设定或故事钩子是什么？',
      impactScore: 10,
      options: [
        { id: 'discovery_secret', label: '主角发现一个会改变世界的秘密' },
        { id: 'protect_someone', label: '主角必须保护某人或某个家园' },
        { id: 'seek_truth', label: '主角为了真相踏上危险旅程' },
        { id: 'custom_premise', label: '我自己补充' },
      ],
    },
    target_total_words: {
      id: 'target_total_words',
      question: '全书目标总字数大约是多少？',
      impactScore: 8,
      options: [
        { id: 'total_30k', label: '约 3 万字（短篇 / 试读）' },
        { id: 'total_100k', label: '约 10 万字（中篇）' },
        { id: 'total_300k', label: '约 30 万字（常规长篇）' },
        { id: 'total_1m', label: '约 100 万字（超长篇）' },
      ],
    },
    target_total_chapters: {
      id: 'target_total_chapters',
      question: '全书计划写多少章？',
      impactScore: 8,
      options: [
        { id: 'ch_20', label: '约 20 章' },
        { id: 'ch_50', label: '约 50 章' },
        { id: 'ch_100', label: '约 100 章' },
        { id: 'ch_300', label: '约 300 章' },
      ],
    },
    target_words_per_chapter: {
      id: 'target_words_per_chapter',
      question: '每一章希望保持多少字？',
      impactScore: 8,
      options: [
        { id: 'wpc_1500', label: '约 1500 字' },
        { id: 'wpc_2500', label: '约 2500 字' },
        { id: 'wpc_4000', label: '约 4000 字' },
        { id: 'wpc_6000', label: '约 6000 字' },
      ],
    },
    target_volume_count: {
      id: 'target_volume_count',
      question: '全书准备分成多少卷？',
      impactScore: 8,
      options: [
        { id: 'volumes_1', label: '一卷完结' },
        { id: 'volumes_3', label: '三卷' },
        { id: 'volumes_5', label: '五卷' },
        { id: 'volumes_10', label: '十卷或更多' },
      ],
    },
    ending_direction: {
      id: 'ending_direction',
      question: '你希望最终结局采用哪种方向？',
      impactScore: 8,
      options: [
        { id: 'ending_happy', label: '圆满 / 大团圆' },
        { id: 'ending_bittersweet', label: '苦尽甘来但有代价' },
        { id: 'ending_tragic', label: '悲剧或牺牲结局' },
        { id: 'ending_open', label: '开放式结局' },
      ],
    },
    writing_requirements: {
      id: 'writing_requirements',
      question: '写作节奏和限制更偏向哪种要求？',
      impactScore: 7,
      options: [
        { id: 'style_fast', label: '快节奏，尽快推进冲突' },
        { id: 'style_slow', label: '慢热，重视铺垫和氛围' },
        { id: 'style_ensemble', label: '群像，不限制为单主角视角' },
        { id: 'style_no_harem', label: '不后宫 / 感情线克制' },
      ],
    },
  };
  return missing.map((item) => questions[item]);
}

function selectPlanningQuestions(
  modelQuestions: NovelPlanQuestion[],
  missingRequirements: PlanRequirement[],
  history: NovelPlanHistoryTurn[],
  questionBudget: number,
  topicText = '',
): NovelPlanQuestion[] {
  const selected = modelQuestions
    .filter(isHighValueQuestion)
    .filter((question) => !alreadyAsked(question, history));
  const selectedIds = new Set(selected.map((question) => question.id));
  // A valid Agent question is authoritative. Do not append a generic survey
  // just to fill the visual card; this is what previously turned campus ideas
  // into fantasy-style prompts.
  if (selected.length > 0) return selected.slice(0, Math.min(questionBudget, MAX_QUESTIONS_PER_TURN));
  const fallback = planRequirementsQuestions(missingRequirements, topicText)
    .filter((question) => !selectedIds.has(question.id))
    .filter((question) => !alreadyAsked(question, history));
  return [...selected, ...fallback].slice(0, Math.min(questionBudget, MAX_QUESTIONS_PER_TURN));
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
    MAX_PLAN_CHAPTERS,
    Math.max(1, scale.chapterCount ?? defaultChapters),
  );
  const wordsPerChapter = Math.max(500, scale.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER);
  const totalWords = Math.max(wordsPerChapter * chapterCount, scale.totalWords ?? 0);
  const volumeCount = Math.min(
    50,
    Math.max(1, scale.volumeCount ?? Math.ceil(chapterCount / 40)),
  );
  return { totalWords, wordsPerChapter, chapterCount, volumeCount };
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
  const conflict = planConfigConflict(decision.planSummary.planConfig);
  if (conflict && !constraints.includes(conflict)) constraints.push(conflict);
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
      targetTotalChapters:
        summary.planConfig?.targetTotalChapters ?? current?.metadata.targetTotalChapters,
      targetWordsPerChapterMin:
        summary.planConfig?.targetWordsPerChapter?.min ?? current?.metadata.targetWordsPerChapterMin,
      targetWordsPerChapterMax:
        summary.planConfig?.targetWordsPerChapter?.max ?? current?.metadata.targetWordsPerChapterMax,
      targetVolumeCount:
        summary.planConfig?.targetVolumeCount ?? summary.volumeCount ?? current?.metadata.targetVolumeCount,
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
    const bypass = hasExplicitPlanningBypass(seed);
    const askedIds = askedQuestionIds(history, request.answers);
    const questionBudget = Math.max(0, TOTAL_QUESTION_BUDGET - askedIds.size);
    const knownText = [
      sessionText(seed, history.filter((turn) => turn.role === 'user'), request.answers),
      planConfigText(request.planConfig),
    ]
      .filter(Boolean)
      .join('\n');
    const knownScale = mergeScale(
      scaleFromPlanConfig(request.planConfig),
      collectScaleFromSession(history, request.answers, undefined, seed),
    );
    const missingRequirements = missingPlanRequirements(knownText, request.planConfig, knownScale);
    const round = Math.min(
      MAX_AGENT_ROUNDS,
      1 + history.filter((turn) => turn.role === 'user').length,
    );
    // The total question budget is the only automatic finish gate. A session
    // that asks one question per turn must still be able to use its remaining
    // budget instead of being forced ready by the UI round number.
    const mustFinish = bypass || request.forceReady === true || questionBudget === 0;
    let decision = await this.generateDecision(
      config,
      seed,
      target,
      history,
      request.answers,
      mustFinish,
      questionBudget,
      missingRequirements,
      signal,
      false,
      request.planConfig,
    );

    const acceptedModelQuestionCount = decision.status === 'asking'
      ? decision.questions
          .filter(isHighValueQuestion)
          .filter((question) => !alreadyAsked(question, history)).length
      : 0;
    const hasUnresolvedChecklist = (decision.planningChecklist?.unresolvedDecisions.length ?? 0) > 0;
    if (!mustFinish && decision.status === 'asking' && (acceptedModelQuestionCount > 0 || missingRequirements.length === 0)) {
      const questions = selectPlanningQuestions(
        decision.questions,
        missingRequirements,
        history,
        questionBudget,
        knownText,
      );
      if (questions.length > 0) {
        return {
          status: 'asking',
          round,
          message: decision.message,
          questions,
          planningChecklist: decision.planningChecklist,
        };
      }
    }

    // A provider can ignore the Requirement State, or return an invalid/low-value
    // question. Give the planning Agent one strict correction turn first.
    const filteredQuestionCount = decision.status === 'asking'
      ? selectPlanningQuestions(decision.questions, [], history, questionBudget, knownText).length
      : 0;
    if (!mustFinish && (missingRequirements.length > 0 || hasUnresolvedChecklist || (decision.status === 'asking' && filteredQuestionCount === 0))) {
      decision = await this.generateDecision(
        config,
        seed,
        target,
        history,
        request.answers,
        false,
        questionBudget,
        missingRequirements,
        signal,
        true,
        request.planConfig,
      );
      if (decision.status === 'asking') {
        const questions = selectPlanningQuestions(
          decision.questions,
          missingRequirements,
          history,
          questionBudget,
          knownText,
        );
        if (questions.length > 0) {
          return {
            status: 'asking',
            round,
            message: decision.message,
            questions,
            planningChecklist: decision.planningChecklist,
          };
        }
      }
    }

    // If the model ignored the Requirement State, expose only unresolved
    // high-impact choices with free-text supplements instead of silently
    // inventing the missing plan parameters.
    if (!mustFinish && missingRequirements.length > 0) {
      return {
        status: 'asking',
        round,
        message: '开始生成完整计划前，需要确认故事方向和规模等高影响参数。',
        questions: planRequirementsQuestions(missingRequirements, knownText).slice(
          0,
          Math.min(questionBudget, MAX_QUESTIONS_PER_TURN),
        ),
        planningChecklist: decision.planningChecklist,
      };
    }

    if (!mustFinish && (decision.planningChecklist?.unresolvedDecisions.length ?? 0) > 0) {
      throw new ProxyError('策划 Agent 的自检清单仍有未决策项，请重试本轮。');
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
        false,
        request.planConfig,
      );
    }

    if (decision.status !== 'ready' || !decision.planSummary) {
      throw new ProxyError('策划 Agent 没有形成可执行方案，请重试本轮。');
    }
    decision = {
      ...decision,
      planSummary: {
        ...decision.planSummary,
        planConfig: request.planConfig ?? decision.planSummary.planConfig,
        genres: request.planConfig?.genres ?? decision.planSummary.genres,
        endingDirection:
          request.planConfig?.endingDirection ?? decision.planSummary.endingDirection,
        writingRequirements:
          request.planConfig?.writingRequirements ?? decision.planSummary.writingRequirements,
      },
    };
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
      questions: [],
      brief: decision.brief,
      planSummary: decision.planSummary,
      planningChecklist: decision.planningChecklist,
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
    missingRequirements: PlanRequirement[],
    signal: AbortSignal,
    requireQuestion = false,
    planConfig?: NovelPlanConfig,
  ): Promise<AgentDecision> {
    const explicitGenre = inferExplicitGenre(
      [seed, ...history.filter((turn) => turn.role === 'user').map((turn) => turn.content), planConfigText(planConfig)].join('\n'),
    );
    const knownScale = mergeScale(
      scaleFromPlanConfig(planConfig),
      collectScaleFromSession(history, answers, undefined, seed),
    );
    const system = [
      '你是拥有决策权的小说总策划 Agent，不是固定问卷或工作流。只输出 JSON。',
      '循环：理解目标与已确认事实 → 判断是否存在真正阻塞创作的缺口 → 选择追问或直接形成方案。',
      '每轮先输出一份 planningChecklist（这是可审计的工作清单，不是隐藏思维链）：confirmedFacts 只列用户明确说过或已回答的事实；unresolvedDecisions 只列会改变主线、人物弧光、结局或篇幅结构的未决项；safeDefaults 列出你可以自行决定的低风险细节；hardConstraints 列出绝不能违背的题材、时代、人物和禁忌。每项写短句，最多各 8 条。',
      '用户明确说过的题材、时代、地域、文化、人物、禁忌和规模都是不可覆盖的硬约束。',
      '禁止重复询问已明确的信息；禁止把西方玄幻改成校园、都市、修仙等其他核心类型。',
      '问题与选项必须从 planningChecklist.unresolvedDecisions 和当前题材推导；禁止复用固定题库。已识别校园时，问题必须围绕学校类型、学业/社团/竞赛、校园关系、校园秘密等现实校园要素；禁止出现魔法、修仙、骑士、王国等不属于用户题材的选项。其他题材同理，问题必须使用该题材自己的冲突、角色身份和场景词汇。',
      '可安全推断的细节由你做专业决定，不向用户转嫁；只有答案会导致两种根本不同故事时才提问。',
      `主动提问总预算剩余 ${questionBudget} 题；asking 时不得超过该预算，每轮可提出 2-${MAX_QUESTIONS_PER_TURN} 个具体问题，每题 2-${MAX_OPTIONS_PER_QUESTION} 个选项，必须含 impactScore（0-10）与稳定英文 snake_case id。`,
      '只有 impactScore >= 7 且同时满足“无法合理推断、显著改变主线、后期修改成本高”的问题才允许询问。',
      '国家/城市/人物姓名、货币、等级名称、普通配角、普通反派、支线和世界细节由你直接创造，禁止询问。',
      'ready 时 questions 必须为空，并返回完整 brief 与 planSummary；asking 时 questions 必须来自 unresolvedDecisions，优先提出 2-5 个互不重复且同一题材内的高影响问题。',
      'planSummary JSON 字段：title, genre, protagonist, hook, tone, constraints, totalWords, wordsPerChapter, chapterCount, volumeCount, chapterOutlines。',
      '本模块只做是否追问与方向收束，不生成 storyPlan；完整 Story Plan 由后续专用 Agent 一次生成。',
      'chapterOutlines 每项字段：number, title, goal, estimatedWords；goal 必须含行动、冲突/变化、章末推进。',
      '计划配置中的全文、卷数、单章字数、类型、核心剧情、结局方向和额外要求必须进入最终方案；未填写的细节由你自动补全，不得用固定问卷替代策划。',
      planConfigText(planConfig),
      `下游目标：${TARGET_LABELS[target]}。`,
      forceReady
        ? '本轮必须 ready。信息不足时采用清晰、可修改的专业默认值，不得继续提问。'
        : requireQuestion
          ? `本轮必须 asking：提出 2-${MAX_QUESTIONS_PER_TURN} 个尚未问过的高影响问题，不得返回 ready；优先覆盖 Requirement State 中尚未确认的规模、主线和结局参数。`
        : '信息足以形成方向时可以 0 问并立即 ready；不要为了凑轮数而提问。',
      missingRequirements.length > 0
        ? `服务端观察到尚未确认的高影响字段：${missingRequirements.join('、')}。把它们作为检查提示，先由你自行判断哪些真的阻塞当前创作；不要把这些字段机械地变成固定问卷。`
        : 'Requirement State 的高影响参数已足够；除非存在新的不可逆重大分叉，否则直接 ready。',
      explicitGenre ? `已识别硬约束题材：${explicitGenre}。planSummary.genre 必须完全保持。` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const user = [
      sessionText(seed, history, answers),
      planConfigText(planConfig),
      `已识别规模：总字数=${knownScale.totalWords ?? '未指定'}；每章=${knownScale.wordsPerChapter ?? '未指定'}；章数=${knownScale.chapterCount ?? '未指定'}。`,
      '输出示例结构：{"status":"asking|ready","message":"...","planningChecklist":{"confirmedFacts":[],"unresolvedDecisions":[],"safeDefaults":[],"hardConstraints":[]},"questions":[],"brief":"...","planSummary":{}}',
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
            '你是 Story Plan 架构 Agent。只输出 JSON：{"storyPlan":{...}}，不要输出正文。',
            '用户已决定“想看什么”，你负责完整决定“怎么写”；禁止向用户追加问题。',
            '自动创造国家、城市、历史、种族、宗教、派系、力量体系、配角、反派、支线、伏笔和谜团。',
            'storyPlan 使用 camelCase，必须完整包含 metadata、premise、protagonist、world、powerSystem、characters、factions、mainPlot、subplots、characterArcs、volumes、foreshadowing、mysteries、constraints。',
            'metadata 必须回写 targetTotalChapters、targetWordsPerChapterMin、targetWordsPerChapterMax、targetVolumeCount；volumes 必须按全文目标分配章节范围，每卷包含 stages，形成“全文→分卷→阶段”的层级。',
            '每个 volume 至少包含 number、title、goal、chapterStart、chapterEnd、targetWords、mainConflict、climax、endingHook、stages；每个 stage 至少包含 title、chapterStart、chapterEnd、goal、endingState。',
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
    // 长篇只展开当前滚动窗口；全文目标仍保存在 chapterCount/Story Plan 中。
    const outlineTargetCount = Math.min(scale.chapterCount, MAX_OUTLINE_CHAPTERS);
    if ((summary.chapterOutlines?.length ?? 0) >= outlineTargetCount) {
      const outlines = normalizeOutlines(
        summary.chapterOutlines,
        outlineTargetCount,
        scale.wordsPerChapter,
      );
      const planSummary = ensureStructuredStoryPlan({
        ...summary,
        ...scale,
        plannedThroughChapter: Math.min(scale.chapterCount, outlines.at(-1)?.number ?? 0),
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
            '你是分章策划 Agent。只输出 JSON，不要 Markdown。根对象只能有 chapterOutlines 字段。',
            '严格结构：{"chapterOutlines":[{"number":1,"title":"章节标题","goal":"角色行动；具体冲突或状态变化；章末推进","estimatedWords":2000}]}。',
            scale.chapterCount > outlineTargetCount
              ? `本轮只生成第 1-${outlineTargetCount} 章（当前滚动窗口），每章约 ${scale.wordsPerChapter} 字；全文目标共 ${scale.chapterCount} 章，后续由 Plan Mode 按阶段继续展开。不得缺章、跳号或写正文。`
              : `必须连续生成 ${outlineTargetCount} 章，每章约 ${scale.wordsPerChapter} 字，不得缺章、跳号或写正文。`,
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
      16384,
    );
    if (!isRecord(data)) throw new ProxyError('分章策划 Agent 未返回有效 JSON。');
    let outlines = normalizeOutlines(
      outlinePayload(data),
      outlineTargetCount,
      scale.wordsPerChapter,
    );
    if (outlines.length < outlineTargetCount) {
      const missing = outlineTargetCount - outlines.length;
      const start = outlines.length + 1;
      const continuation = await this.collectJson(
        config,
        [
          {
            role: 'system',
            content: [
              '你是分章策划补全 Agent。只输出 JSON，不要 Markdown。根对象只能有 chapterOutlines 字段。',
              `只生成第 ${start}-${outlineTargetCount} 章，共 ${missing} 章；不得重复已有章节。全文目标共 ${scale.chapterCount} 章，本轮只补齐当前窗口。`,
              `每章约 ${scale.wordsPerChapter} 字；字段固定为 number、title、goal、estimatedWords。`,
              'goal 必须包含角色行动、具体冲突或状态变化、章末推进，并承接已有最后章节。',
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
              outlines.length > 0 ? '已有最后三章：' : '首次返回无法解析，请按严格结构重新生成全部章节：',
              outlines.length > 0 ? JSON.stringify(outlines.slice(-3), null, 2) : '无',
            ].join('\n\n'),
          },
        ],
        signal,
        Math.min(16384, Math.max(4096, missing * 320)),
      );
      if (isRecord(continuation)) {
        outlines = [
          ...outlines,
          ...normalizeOutlines(
            outlinePayload(continuation),
            missing,
            scale.wordsPerChapter,
            start,
          ),
        ];
      }
    }
    if (outlines.length !== outlineTargetCount) {
      const keys = Object.keys(data).slice(0, 8).join('、') || '无';
      throw new ProxyError(
        `分章策划 Agent 只返回 ${outlines.length}/${outlineTargetCount} 章（全文目标 ${scale.chapterCount} 章；返回字段：${keys}），请重试。`,
      );
    }
    const planSummary = ensureStructuredStoryPlan({
      ...summary,
      ...scale,
      plannedThroughChapter: Math.min(scale.chapterCount, outlines.at(-1)?.number ?? 0),
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
      summary.plannedThroughChapter && summary.chapterCount && summary.plannedThroughChapter < summary.chapterCount
        ? `当前已展开第 1-${summary.plannedThroughChapter} 章；后续章节按卷内阶段滚动规划。`
        : '',
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
