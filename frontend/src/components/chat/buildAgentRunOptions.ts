/**
 * 单一数据源：组装 Agent 运行请求的 options。
 * useAgentEngine（Chat 路径）与 AgentCommandCenter（遗留面板）共用，避免 long_novel 等参数分叉。
 */
import type {
  AgentRunRequest,
  AgentTask,
  LongNovelAutomationLevel,
  NovelPlanSummary,
} from '../../types/index.js';

export interface BuildAgentRunOptionsInput {
  task: AgentTask;
  chapters?: number;
  targetWords?: number;
  totalWords?: number;
  totalChapters?: number;
  automationLevel?: LongNovelAutomationLevel;
  planSummary?: NovelPlanSummary;
  /** auto_next 专用字数，默认 2000。 */
  autoNextTargetWords?: number;
  minWordsPerChapter?: number;
}

const FULL_NOVEL_DEFAULT_CHAPTERS = 3;
const FULL_NOVEL_DEFAULT_WORDS = 1500;
const LONG_NOVEL_DEFAULT_CHAPTERS = 3;
const LONG_NOVEL_DEFAULT_WORDS = 2000;
const LONG_NOVEL_DEFAULT_TOTAL_CHAPTERS = 10;
const LONG_NOVEL_DEFAULT_TOTAL_WORDS = 200_000;
const AUTO_NEXT_DEFAULT_WORDS = 2000;

export function buildAgentRunOptions(
  input: BuildAgentRunOptionsInput,
): AgentRunRequest['options'] | undefined {
  const { task, planSummary } = input;

  if (task === 'auto_next') {
    return {
      targetWords: input.autoNextTargetWords ?? input.targetWords ?? AUTO_NEXT_DEFAULT_WORDS,
    };
  }

  if (task === 'full_novel') {
    const chapters = input.chapters ?? FULL_NOVEL_DEFAULT_CHAPTERS;
    const targetWords = input.targetWords ?? FULL_NOVEL_DEFAULT_WORDS;
    return {
      chapters,
      targetWords,
      totalChapters: planSummary?.chapterCount ?? input.totalChapters ?? chapters,
      planSummary,
    };
  }

  if (task === 'long_novel') {
    const chapters = input.chapters ?? LONG_NOVEL_DEFAULT_CHAPTERS;
    const targetWords = input.targetWords ?? LONG_NOVEL_DEFAULT_WORDS;
    const totalChapters =
      planSummary?.chapterCount ??
      input.totalChapters ??
      input.chapters ??
      LONG_NOVEL_DEFAULT_TOTAL_CHAPTERS;
    // 优先显式 totalWords / 计划规模；否则 20 万字（Chat 路径默认）。
    // 调用方可传 chapters*targetWords 作为全书目标（AgentCommandCenter 即如此）。
    const totalWords =
      input.totalWords ??
      planSummary?.totalWords ??
      LONG_NOVEL_DEFAULT_TOTAL_WORDS;
    const options: NonNullable<AgentRunRequest['options']> = {
      chapters,
      targetWords,
      totalChapters,
      totalWords,
      automationLevel: input.automationLevel ?? 'semi_auto',
      planSummary,
    };
    if (input.minWordsPerChapter !== undefined) {
      options.minWordsPerChapter = input.minWordsPerChapter;
    }
    return options;
  }

  if (planSummary) {
    return { planSummary };
  }

  return undefined;
}
