import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { DataStore } from '../../store/DataStore.js';
import type {
  AgentArtifact,
  AgentRunMetrics,
  AgentRunMode,
  AgentRunRequest,
  AgentRunResult,
  AgentProgressEvent,
  AgentTask,
  ChatMessage,
  Id,
  LongNovelAutomationLevel,
  LongNovelModeConfig,
  ModelConfig,
  NovelPlanChapterOutline,
  NovelPlanSummary,
} from '../../types/index.js';
import { getCacheStatsSummary, type CacheStatsSummary } from '../../proxy/cacheStats.js';
import { pythonBridge, type PythonBridgeResult } from '../../proxy/PythonBridge.js';
import type { BlueprintService } from '../blueprint/BlueprintService.js';
import type { ChapterWriter } from '../blueprint/ChapterWriter.js';
import { countActualWords, tokenBudgetForCharacterTarget } from '../blueprint/wordCount.js';
import { ServiceError } from '../ServiceError.js';
import { isProxyError } from '../../proxy/ProxyError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import type {
  CriticalStateIssue,
  CriticalStateUpdateInput,
  MemoryService,
} from '../memory/MemoryService.js';
import { scaledMemoryOptions } from '../memory/MemoryService.js';
import type { ReferenceAnalysisService } from '../reference/ReferenceAnalysisService.js';
import { MaterialResearchService } from '../research/MaterialResearchService.js';
import { stripReasoningArtifacts } from '../text/reasoningSanitizer.js';
import type { LongNovelConfigStorePort } from './longNovel/LongNovelConfigStore.js';
import {
  defaultLongNovelConfig,
  runChapterQualityGates,
  type GateFinding,
  type GateResult,
} from './longNovel/qualityGates.js';
import { inferDeterministicCriticalStateUpdates } from './longNovel/deterministicCriticalState.js';
import {
  ContinuityInspectorSubAgent,
  type InspectorReport,
} from './subagents/index.js';

const MAX_EMPTY_CHAPTER_ATTEMPTS = 3;
const RETRYABLE_CHAPTER_PROVIDER_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
export const BLUEPRINT_REQUIREMENT_MAX_CHARS = 5000;

function wordRangeDistance(
  content: string,
  range: { minWords: number; maxWords: number },
): number {
  const words = countActualWords(content);
  if (words < range.minWords) return range.minWords - words;
  if (words > range.maxWords) return words - range.maxWords;
  return 0;
}

export function revisionDoesNotWorsenWordRange(
  original: string,
  revision: string,
  range: { minWords: number; maxWords: number },
): boolean {
  return wordRangeDistance(revision, range) <= wordRangeDistance(original, range);
}

function isRetryableChapterError(error: unknown): boolean {
  if (!isProxyError(error)) return false;
  return error.status === undefined || RETRYABLE_CHAPTER_PROVIDER_STATUSES.has(error.status);
}

const TASK_MODES: Record<AgentTask, AgentRunMode | 'either'> = {
  novel: 'either',
  title: 'either',
  outline: 'reference',
  polish: 'either',
  diagnostic: 'reference',
  material_research: 'reference',
  trope_breakdown: 'reference',
  cliche_guard: 'reference',
  chapter_diagnosis: 'reference',
  workspace_review: 'reference',
  auto_next: 'draft',
  full_novel: 'draft',
  long_novel: 'draft',
  script_plan: 'draft',
  script_series_outline: 'draft',
  script_bible: 'draft',
  script_episode_batch: 'draft',
  plan_blueprint: 'draft',
  write_scene: 'draft',
  write_chapter_from_blueprint: 'draft',
};

interface GeneratedPack {
  title: string;
  world: string;
  characters: string;
  outline: string;
}

export const FULL_NOVEL_LIMITS = {
  minChapters: 1,
  maxChapters: 500,
  defaultChapters: 3,
  minTargetWords: 300,
  maxTargetWords: 8000,
  defaultTargetWords: 1500,
} as const;

const CONTROL_OUTLINE_CHUNK_SIZE = 50;

export interface NormalizedFullNovelOptions {
  chapterCount: number;
  wordsPerChapter: number;
  plannedWords: number;
}

export function normalizeFullNovelOptions(chapters: number, targetWords: number): NormalizedFullNovelOptions {
  const chapterCount = clampInteger(chapters, FULL_NOVEL_LIMITS.minChapters, FULL_NOVEL_LIMITS.maxChapters);
  const wordsPerChapter = clampInteger(
    targetWords,
    FULL_NOVEL_LIMITS.minTargetWords,
    FULL_NOVEL_LIMITS.maxTargetWords,
  );
  return {
    chapterCount,
    wordsPerChapter,
    plannedWords: chapterCount * wordsPerChapter,
  };
}

export function normalizeLongNovelTotalWords(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 200_000;
  return clampInteger(
    value,
    FULL_NOVEL_LIMITS.minTargetWords,
    FULL_NOVEL_LIMITS.maxChapters * FULL_NOVEL_LIMITS.maxTargetWords,
  );
}

export function remainingLongNovelBatch(
  requestedBatch: number,
  completedChapters: number,
  plannedTotalChapters: number,
): number {
  return Math.min(requestedBatch, Math.max(0, plannedTotalChapters - completedChapters));
}

export function longNovelBatchLimit(level: LongNovelAutomationLevel): number {
  return level === 'assistant' ? 1 : 5;
}

export function shouldAutoReviseChapter(input: {
  enabled: boolean;
  inspectorScore: number;
  recommendRevision: boolean;
  revisionHints: string[];
  fatalIssues: string[];
  findings: GateFinding[];
}): boolean {
  if (!input.enabled) return false;
  const fixableFormatFailure = input.findings.some(
    (finding) => finding.gate === 'format' && finding.autoFixable,
  );
  const materialContinuityFailure = input.fatalIssues.length > 0 || input.inspectorScore < 70;
  return (
    fixableFormatFailure ||
    (materialContinuityFailure && input.recommendRevision && input.revisionHints.length > 0)
  );
}

export function shouldInspectLongNovelChapter(
  chapterNumber: number,
  checkpointInterval: number,
  localGates: GateResult,
): boolean {
  return (
    chapterNumber === 1 ||
    (checkpointInterval > 0 && chapterNumber % checkpointInterval === 0) ||
    localGates.hardFail ||
    localGates.findings.some((finding) => finding.gate === 'format')
  );
}

function truncatePromptSection(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  const suffix = '\n…（内容已截断）';
  return `${normalized.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

export function buildChapterBlueprintRequirement(input: {
  chapterNumber: number;
  chapterTitle: string;
  targetWords: number;
  chapterGoal?: string;
  seedPrompt: string;
  memoryContext: string;
}): string {
  const header = [
    `章节编号：${input.chapterNumber}`,
    `章节标题：${truncatePromptSection(input.chapterTitle, 200)}`,
    `目标字数：${input.targetWords}`,
    `本章目标：${truncatePromptSection(
      input.chapterGoal?.trim() || '承接前情，推进主线冲突，完成一次明确状态变化并留下章末钩子。',
      1200,
    )}`,
  ].join('\n\n');
  const seed = `整本题材与用户要求：${truncatePromptSection(input.seedPrompt, 1800)}`;
  const memoryLabel = '当前故事记忆（只提取事实，不要照抄摘要）：\n';
  const base = `${header}\n\n${seed}`;
  const memoryBudget = BLUEPRINT_REQUIREMENT_MAX_CHARS - base.length - 2 - memoryLabel.length;
  const memory = input.memoryContext.trim();
  if (memory.length === 0 || memoryBudget <= 0) {
    return base.slice(0, BLUEPRINT_REQUIREMENT_MAX_CHARS);
  }
  return `${base}\n\n${memoryLabel}${truncatePromptSection(memory, memoryBudget)}`.slice(
    0,
    BLUEPRINT_REQUIREMENT_MAX_CHARS,
  );
}

export function extractChapterOutline(outline: string, chapterNumber: number): string | undefined {
  if (!Number.isInteger(chapterNumber) || chapterNumber <= 0) return undefined;
  const lines = outline.replace(/\r\n/g, '\n').split('\n');
  const headings: Array<{ lineIndex: number; number: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const number = parseChapterHeading(lines[i] ?? '');
    if (number !== undefined) headings.push({ lineIndex: i, number });
  }
  const currentIndex = headings.findIndex((heading) => heading.number === chapterNumber);
  if (currentIndex < 0) return undefined;
  const start = headings[currentIndex]!.lineIndex;
  const end = headings[currentIndex + 1]?.lineIndex ?? lines.length;
  const section = lines.slice(start, end).join('\n').trim();
  return section.length > 0 ? section : undefined;
}

/**
 * LangGraph-style multi-step orchestrator: routes `task` to specialized sub-agents.
 */
export class AgentOrchestrator {
  private readonly inspector: ContinuityInspectorSubAgent;

  constructor(
    private readonly store: DataStore,
    private readonly modelConfigService: ModelConfigService,
    private readonly modelProxy: ModelProxy,
    private readonly blueprintService: BlueprintService,
    private readonly chapterWriter: ChapterWriter,
    private readonly memory: MemoryService,
    private readonly referenceService?: ReferenceAnalysisService,
    private readonly longNovelConfigStore?: LongNovelConfigStorePort,
  ) {
    this.inspector = new ContinuityInspectorSubAgent(modelProxy);
  }

  async run(
    request: AgentRunRequest,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    const task = request.task;
    const mode = this.resolveMode(task, request.mode);
    const prompt = request.prompt.trim();

    if (task !== 'auto_next' && task !== 'workspace_review' && task !== 'chapter_diagnosis' && prompt.length === 0) {
      throw ServiceError.validation('一句话需求不能为空。');
    }
    if (
      (task === 'auto_next' || task === 'workspace_review') &&
      (request.projectId === undefined || request.projectId.trim().length === 0)
    ) {
      throw ServiceError.validation(task === 'auto_next' ? '写下一章需要先选择左侧项目。' : '主动审阅需要先选择左侧项目。');
    }

    const config = await this.modelConfigService.getInternalConfig();
    if (config === undefined) {
      throw ServiceError.modelNotConfigured('尚未配置模型，请先在模型设置中保存 API 配置。');
    }

    const metricsBefore = getCacheStatsSummary();
    let result: AgentRunResult;
    switch (task) {
      case 'novel':
        result = await this.runOnboard(config, prompt, mode, request.projectId, signal, 'novel', onProgress);
        break;
      case 'title':
        result = await this.runOnboard(config, prompt, mode, request.projectId, signal, 'title', onProgress);
        break;
      case 'outline':
        result = await this.runOutlineOnly(config, prompt, request.projectId, signal, onProgress);
        break;
      case 'polish':
        result = await this.runPolish(config, prompt, mode, request.projectId, request.chapterId, signal, onProgress);
        break;
      case 'diagnostic':
        result = await this.runDiagnostic(config, prompt, request.projectId, signal, onProgress);
        break;
      case 'material_research':
        result = await this.runMaterialResearch(config, prompt, request.projectId, signal, onProgress);
        break;
      case 'trope_breakdown':
        result = await this.runIdeaSkill(
          config,
          task,
          prompt,
          request.projectId,
          signal,
          '拆梗报告',
          '你是小说桥段拆解 Agent。把用户给出的桥段或爆点拆成：核心承诺、冲突来源、人物动机、情绪节奏、爽点/反转、可原创改写的 3 个版本。禁止照搬已有小说剧情。',
          onProgress,
        );
        break;
      case 'cliche_guard':
        result = await this.runIdeaSkill(
          config,
          task,
          prompt,
          request.projectId,
          signal,
          '避俗报告',
          '你是小说俗套风险审查 Agent。检查用户构思里的老套点、动机漏洞、反派脸谱化、主角成长跳跃和假爽点，并给出更原创的替代方案。输出 Markdown。',
          onProgress,
        );
        break;
      case 'chapter_diagnosis':
        result = await this.runChapterDiagnosis(config, prompt, request.projectId, request.chapterId, signal, onProgress);
        break;
      case 'workspace_review':
        result = await this.runWorkspaceReview(config, request.projectId!, signal, onProgress);
        break;
      case 'auto_next':
        result = await this.runAutoNext(
          config,
          prompt,
          request.projectId!,
          request.options?.targetWords ?? 2000,
          signal,
          onProgress,
        );
        break;
      case 'full_novel':
        result = await this.runFullNovel(
          config,
          prompt,
          request.projectId,
          request.options?.chapters ?? FULL_NOVEL_LIMITS.defaultChapters,
          request.options?.targetWords ?? FULL_NOVEL_LIMITS.defaultTargetWords,
          request.options?.totalChapters,
          request.options?.planSummary,
          signal,
          onProgress,
        );
        break;
      case 'long_novel':
        result = await this.runLongNovel(
          config,
          prompt,
          request.projectId,
          request.options,
          signal,
          onProgress,
        );
        break;
      // Delegate blueprint / long chapter scene writing to Python LangGraph core
      case 'plan_blueprint':
      case 'write_scene':
      case 'write_chapter_from_blueprint':
        result = await this.runPythonDelegated(task, prompt, request.projectId, request.chapterId, request.options, signal, onProgress);
        break;
      default:
        throw ServiceError.validation(`未知 Agent 任务：${task as string}`);
    }
    result.metrics = {
      ...diffRunMetrics(metricsBefore, getCacheStatsSummary()),
      plannedWords: result.metrics?.plannedWords,
      completedChapters: result.metrics?.completedChapters,
    };
    result.metrics.estimatedCostUsd = estimateCostUsd(result.metrics);
    await this.memory.recordWorkflow(result.projectId, { task: result.task, summary: result.summary });
    return result;
  }

  private resolveMode(task: AgentTask, requested: AgentRunMode): AgentRunMode {
    const rule = TASK_MODES[task];
    if (rule === 'either') return requested;
    if (rule === 'reference' && requested === 'draft') {
      return 'reference';
    }
    return rule;
  }

  private emitProgress(
    onProgress: ((event: AgentProgressEvent) => void) | undefined,
    event: AgentProgressEvent,
  ): void {
    if (!onProgress) return;
    try {
      onProgress(event);
    } catch {
      // UI progress must never break the writing path.
    }
  }

  private async runOnboard(
    config: ModelConfig,
    prompt: string,
    mode: AgentRunMode,
    projectId: Id | undefined,
    signal: AbortSignal,
    variant: 'novel' | 'title',
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    const steps: string[] = [];
    const emit = (message: string, phase: AgentProgressEvent['phase'] = 'setup', current?: number, total?: number): void => {
      this.emitProgress(onProgress, { phase, message, current, total });
    };

    emit(variant === 'title' ? '正在按标题建项目…' : '正在创建小说项目…', 'setup', 1, 7);
    const { projectId: pid, projectCreated, projectTitle } = await this.resolveProject(
      projectId,
      variant === 'title' ? prompt : prompt,
    );
    steps.push(projectCreated ? '已自动创建小说项目。' : '已复用当前小说项目。');
    emit(projectCreated ? `已创建项目「${projectTitle}」` : `已复用项目「${projectTitle}」`, 'setup', 1, 7);

    const pack = await this.generatePack(config, prompt, mode, variant, signal, onProgress);
    steps.push('已生成控稿参考包（世界 / 人物 / 大纲分步写入）。');

    const artifacts: AgentArtifact[] = [{ kind: 'project', id: pid, title: projectTitle }];
    emit('正在保存世界观 / 人物 / 大纲…', 'setup', 5, 7);
    const world = await this.store.createWorldSetting(pid, pack.title, pack.world);
    artifacts.push({ kind: 'world', id: world.id, title: world.title });
    steps.push('已保存世界观。');

    await this.persistGeneratedCharacters(pid, pack.characters, artifacts);
    steps.push('已保存人物护栏。');

    const outline = await this.store.createOutline(pid, `${pack.title}：大纲`, pack.outline);
    artifacts.push({ kind: 'outline', id: outline.id, title: outline.title });
    steps.push('已保存章节大纲。');

    await this.seedMemoryFromPack(pid, pack);
    emit('设定已写入项目，正在准备首章…', 'setup', 5, 7);

    if (mode === 'reference') {
      emit('参考方案已完成。', 'info', 7, 7);
      return {
        task: variant,
        mode,
        projectId: pid,
        summary: '已生成可继续扩写的参考方案。',
        steps,
        artifacts,
      };
    }

    const chapterTitle = variant === 'title' ? prompt.slice(0, 40) : `第1章：${pack.title}`;
    const chapter = await this.store.createChapter(pid, chapterTitle);
    artifacts.push({ kind: 'chapter', id: chapter.id, title: chapter.title });
    steps.push('已创建首章。');

    emit(`正在写「${chapterTitle}」正文（这一步较久）…`, 'chapter', 6, 7);
    const draft = await this.generateDraft(config, prompt, pack, pid, signal);
    await this.store.updateChapterContent(chapter.id, draft);
    steps.push('已生成并保存首章正文。');
    emit(`首章正文已保存（约 ${draft.length} 字），正在反思记忆…`, 'chapter', 6, 7);

    emit('反思子 Agent 正在沉淀长期记忆…', 'reflect', 7, 7);
    await this.reflectAndRemember(config, pid, chapter.id, chapterTitle, draft, signal);
    steps.push('已反思首章并写入长期记忆（摘要 / 事实 / 风格 / 伏笔）。');
    emit('首章生成完成。', 'info', 7, 7);

    return {
      task: variant,
      mode,
      projectId: pid,
      chapterId: chapter.id,
      summary: variant === 'title' ? '已按标题生成项目资料与首章正文。' : '已从一句话需求生成首章正文。',
      steps,
      artifacts,
    };
  }

  private async runOutlineOnly(
    config: ModelConfig,
    prompt: string,
    projectId: Id | undefined,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    const steps: string[] = [];
    this.emitProgress(onProgress, { phase: 'setup', message: '正在准备大纲与设定…', current: 1, total: 4 });
    const { projectId: pid, projectCreated, projectTitle } = await this.resolveProject(projectId, prompt);
    steps.push(projectCreated ? '已自动创建小说项目。' : '已复用当前小说项目。');

    const pack = await this.generatePack(config, prompt, 'reference', 'novel', signal, onProgress);
    const artifacts: AgentArtifact[] = [{ kind: 'project', id: pid, title: projectTitle }];

    const world = await this.store.createWorldSetting(pid, pack.title, pack.world);
    artifacts.push({ kind: 'world', id: world.id, title: world.title });
    await this.persistGeneratedCharacters(pid, pack.characters, artifacts);
    const outline = await this.store.createOutline(pid, `${pack.title}：大纲`, pack.outline);
    artifacts.push({ kind: 'outline', id: outline.id, title: outline.title });
    steps.push('已落盘世界观、人物护栏和卷一大纲（仅参考，不写正文）。');

    await this.seedMemoryFromPack(pid, pack);

    return {
      task: 'outline',
      mode: 'reference',
      projectId: pid,
      summary: '已生成大纲与设定参考包，可在左侧「项目资料」继续编辑。',
      steps,
      artifacts,
    };
  }

  private async runPolish(
    config: ModelConfig,
    prompt: string,
    mode: AgentRunMode,
    projectId: Id | undefined,
    chapterId: Id | undefined,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    this.emitProgress(onProgress, { phase: 'setup', message: '正在润写…' });
    const steps: string[] = ['已解析润写需求。'];
    let pid = projectId;
    if (pid === undefined || pid.trim().length === 0) {
      const created = await this.store.createProject('润写草稿');
      pid = created.id;
      steps.push('未选项目，已创建临时项目存放结果。');
    } else {
      const existing = await this.store.getProject(pid);
      if (!existing) throw ServiceError.notFound(`项目不存在：${pid}`);
    }

    let sourceText = prompt;
    if (chapterId !== undefined) {
      const chapter = await this.store.getChapter(chapterId);
      if (chapter?.content) {
        sourceText = `${chapter.content}\n\n---\n润写要求：${prompt}`;
        steps.push(`已载入章节「${chapter.title}」正文。`);
      }
    }

    const system =
      mode === 'draft'
        ? '你是润写 Agent。根据用户要求直接输出润写后的正文，不要解释流程。'
        : '你是润写顾问 Agent。输出分条润写建议（场景、对白、节奏），不要直接替写整章。';

    const output = await this.generateText(
      config,
      [
        { role: 'system', content: system },
        { role: 'user', content: sourceText },
      ],
      signal,
    );

    const artifacts: AgentArtifact[] = [{ kind: 'project', id: pid, title: (await this.store.getProject(pid))!.name }];

    if (mode === 'draft' && chapterId !== undefined) {
      await this.store.updateChapterContent(chapterId, output);
      const chapter = await this.store.getChapter(chapterId);
      artifacts.push({ kind: 'chapter', id: chapterId, title: chapter?.title ?? '章节' });
      steps.push('已将润写结果写回当前章节。');
      return {
        task: 'polish',
        mode,
        projectId: pid,
        chapterId,
        summary: '已完成润写并保存到章节。',
        steps,
        artifacts,
      };
    }

    const note = await this.store.createOutline(pid, '润写建议', output);
    artifacts.push({ kind: 'outline', id: note.id, title: note.title });
    steps.push('已将润写建议保存为大纲条目。');

    return {
      task: 'polish',
      mode,
      projectId: pid,
      summary: mode === 'draft' ? '润写正文已生成。' : '润写建议已生成，可在大纲中查看。',
      steps,
      artifacts,
    };
  }

  private async runDiagnostic(
    config: ModelConfig,
    prompt: string,
    projectId: Id | undefined,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    if (projectId === undefined || projectId.trim().length === 0) {
      throw ServiceError.validation('综合测试需要先选择项目。');
    }
    const project = await this.store.getProject(projectId);
    if (!project) throw ServiceError.notFound(`项目不存在：${projectId}`);

    this.emitProgress(onProgress, { phase: 'inspect', message: '正在汇总项目并诊断…' });
    const steps: string[] = ['已汇总项目结构与章节进度。'];
    const chapters = await this.store.listChapters(projectId);
    const characters = await this.store.listCharacters(projectId);
    const worlds = await this.store.listWorldSettings(projectId);
    const outlines = await this.store.listOutlines(projectId);

    const snapshot = [
      `项目：${project.name}`,
      `章节数：${chapters.length}`,
      `人物条目：${characters.length}`,
      `世界观条目：${worlds.length}`,
      `大纲条目：${outlines.length}`,
      chapters.length > 0
        ? `最近章节：${chapters[chapters.length - 1]!.title}（${chapters[chapters.length - 1]!.content.length} 字）`
        : '尚无章节正文',
    ].join('\n');

    const report = await this.generateText(
      config,
      [
        {
          role: 'system',
          content:
            '你是小说项目诊断 Agent。根据项目快照和用户问题，输出：缺口清单、连贯性风险、下一步建议（Markdown 分节，不要寒暄）。',
        },
        { role: 'user', content: `${snapshot}\n\n用户问题：${prompt}` },
      ],
      signal,
    );

    const note = await this.store.createOutline(projectId, '诊断报告', report);
    steps.push('已生成诊断报告并写入大纲。');

    return {
      task: 'diagnostic',
      mode: 'reference',
      projectId,
      summary: '已完成项目诊断，报告已保存到「大纲」。',
      steps,
      artifacts: [
        { kind: 'project', id: projectId, title: project.name },
        { kind: 'outline', id: note.id, title: note.title },
      ],
    };
  }

  private async runMaterialResearch(
    config: ModelConfig,
    prompt: string,
    projectId: Id | undefined,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    const emit = (message: string): void => {
      try {
        onProgress?.({ phase: 'inspect', message });
      } catch {
        // 进度回调不影响主流程。
      }
    };
    emit('正在生成素材研究关键词。');
    const { projectId: pid, projectCreated, projectTitle } = await this.resolveProject(projectId, `素材研究：${prompt}`);
    const steps: string[] = [projectCreated ? '已自动创建素材研究项目。' : '已复用当前项目。'];

    const service = new MaterialResearchService();
    let report;
    try {
      emit('正在检索 Wikisource、HN API 和 RSS 公开来源。');
      report = await service.run({
        query: prompt,
        signal,
        complete: (messages, options) => this.generateText(config, messages, signal, options),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '素材研究请求无效。';
      throw ServiceError.validation(message);
    }

    steps.push(`已生成 ${report.keywords.length} 个检索关键词。`);
    steps.push(`已从公开来源筛选 ${report.sources.length} 条参考资料。`);
    emit(`已筛选 ${report.sources.length} 条公开资料，正在汇总写作建议。`);

    const title = `素材研究报告：${prompt.slice(0, 24)}`;
    const note = await this.store.createOutline(pid, title, report.markdown);
    steps.push('已保存 Markdown 素材研究报告到「大纲」。');

    return {
      task: 'material_research',
      mode: 'reference',
      projectId: pid,
      summary: '已完成素材研究，并把报告保存到「大纲」。',
      steps,
      artifacts: [
        { kind: 'project', id: pid, title: projectTitle },
        { kind: 'outline', id: note.id, title: note.title },
      ],
    };
  }

  private async runIdeaSkill(
    config: ModelConfig,
    task: 'trope_breakdown' | 'cliche_guard',
    prompt: string,
    projectId: Id | undefined,
    signal: AbortSignal,
    reportTitle: string,
    systemPrompt: string,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    this.emitProgress(onProgress, { phase: 'setup', message: `正在生成${reportTitle}…` });
    const { projectId: pid, projectCreated, projectTitle } = await this.resolveProject(projectId, prompt);
    const report = await this.generateText(
      config,
      [
        {
          role: 'system',
          content: [
            systemPrompt,
            '必须给出可执行写作建议，避免复述用户问题。',
            '不得输出大段受版权保护文本，不得建议复制角色、设定或剧情。',
          ].join('\n'),
        },
        { role: 'user', content: prompt },
      ],
      signal,
    );
    const note = await this.store.createOutline(pid, `${reportTitle}：${prompt.slice(0, 24)}`, report);
    return {
      task,
      mode: 'reference',
      projectId: pid,
      summary: `已生成${reportTitle}，并保存到「大纲」。`,
      steps: [
        projectCreated ? '已自动创建项目保存结果。' : '已复用当前项目。',
        `已完成${reportTitle}。`,
        '已保存 Markdown 报告到「大纲」。',
      ],
      artifacts: [
        { kind: 'project', id: pid, title: projectTitle },
        { kind: 'outline', id: note.id, title: note.title },
      ],
    };
  }

  private async runChapterDiagnosis(
    config: ModelConfig,
    prompt: string,
    projectId: Id | undefined,
    chapterId: Id | undefined,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    if (chapterId === undefined || chapterId.trim().length === 0) {
      throw ServiceError.validation('章节诊断需要先选择一个章节。');
    }
    const chapter = await this.store.getChapter(chapterId);
    if (!chapter) throw ServiceError.notFound(`章节不存在：${chapterId}`);
    this.emitProgress(onProgress, { phase: 'inspect', message: `正在诊断「${chapter.title}」…` });
    const pid = projectId ?? chapter.projectId;
    const project = await this.store.getProject(pid);
    if (!project) throw ServiceError.notFound(`项目不存在：${pid}`);

    const [characters, worlds, outlines] = await Promise.all([
      this.store.listCharacters(pid),
      this.store.listWorldSettings(pid),
      this.store.listOutlines(pid),
    ]);
    const context = {
      project: project.name,
      chapter: { title: chapter.title, content: chapter.content.slice(0, 10000) },
      userFocus: prompt.trim() || '请综合诊断当前章节。',
      characters: characters.slice(0, 8).map((item) => ({ name: item.name, desc: item.description.slice(0, 240) })),
      worlds: worlds.slice(0, 6).map((item) => ({ title: item.title, content: item.content.slice(0, 280) })),
      outlines: outlines.slice(0, 6).map((item) => ({ title: item.title, content: item.content.slice(0, 280) })),
    };

    const report = await this.generateText(
      config,
      [
        {
          role: 'system',
          content: [
            '你是小说章节诊断 Agent。阅读当前章节和项目资料，输出 Markdown。',
            '必须覆盖：最大问题、冲突强度、爽点兑现、人物动机、对白/节奏、可直接修改的 5 条建议。',
            '只诊断用户自己的章节，不引入外部小说正文，不替用户整章重写。',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify(context, null, 2) },
      ],
      signal,
    );

    const note = await this.store.createOutline(pid, `章节诊断：${chapter.title}`, report);
    return {
      task: 'chapter_diagnosis',
      mode: 'reference',
      projectId: pid,
      chapterId,
      summary: '已完成章节诊断，并保存到「大纲」。',
      steps: [
        `已读取章节「${chapter.title}」。`,
        '已汇总项目人物、世界观和大纲上下文。',
        '已生成章节诊断报告并保存到「大纲」。',
      ],
      artifacts: [
        { kind: 'project', id: pid, title: project.name },
        { kind: 'chapter', id: chapter.id, title: chapter.title },
        { kind: 'outline', id: note.id, title: note.title },
      ],
    };
  }

  private async runWorkspaceReview(
    config: ModelConfig,
    projectId: Id,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    const project = await this.store.getProject(projectId);
    if (!project) throw ServiceError.notFound(`项目不存在：${projectId}`);
    this.emitProgress(onProgress, { phase: 'inspect', message: `正在审阅项目「${project.name}」…` });

    const [chapters, characters, worlds, outlines] = await Promise.all([
      this.store.listChapters(projectId),
      this.store.listCharacters(projectId),
      this.store.listWorldSettings(projectId),
      this.store.listOutlines(projectId),
    ]);
    const latestChapters = chapters.slice(-5).map((chapter) => ({
      title: chapter.title,
      chars: chapter.content.length,
      excerpt: chapter.content.replace(/\s+/g, ' ').slice(0, 240),
    }));
    const memoryContext = this.memory.buildContext(projectId, scaledMemoryOptions(chapters.length));
    const snapshot = {
      project: project.name,
      counts: {
        chapters: chapters.length,
        characters: characters.length,
        worldSettings: worlds.length,
        outlines: outlines.length,
      },
      latestChapters,
      characters: characters.slice(0, 8).map((item) => ({ name: item.name, desc: item.description.slice(0, 180) })),
      worlds: worlds.slice(0, 6).map((item) => ({ title: item.title, content: item.content.slice(0, 240) })),
      outlines: outlines.slice(0, 6).map((item) => ({ title: item.title, content: item.content.slice(0, 240) })),
      memory: memoryContext.slice(0, 1200),
    };

    const report = await this.generateText(
      config,
      [
        {
          role: 'system',
          content:
            '你是小说项目后台审阅 Agent。你要主动读项目快照，输出 Markdown：1) 当前可继续写作程度；2) 设定/人物/章节缺口；3) 具体下一步动作；4) 最高风险。不要等待用户给细指令。',
        },
        { role: 'user', content: JSON.stringify(snapshot, null, 2) },
      ],
      signal,
    );

    const note = await this.store.createOutline(projectId, '主动审阅报告', report);
    return {
      task: 'workspace_review',
      mode: 'reference',
      projectId,
      summary: '已主动审阅当前项目，并把下一步建议保存到「大纲」。',
      steps: [
        '已读取项目、章节、人物、世界观、大纲和长期记忆。',
        '已评估连贯性风险、缺口和下一步写作动作。',
        '已保存主动审阅报告。',
      ],
      artifacts: [
        { kind: 'project', id: projectId, title: project.name },
        { kind: 'outline', id: note.id, title: note.title },
      ],
    };
  }

  private async runAutoNext(
    config: ModelConfig,
    prompt: string,
    projectId: Id,
    targetWords: number,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    const project = await this.store.getProject(projectId);
    if (!project) throw ServiceError.notFound(`项目不存在：${projectId}`);

    const steps: string[] = [];
    const chapters = await this.store.listChapters(projectId);
    const nextNum = chapters.length + 1;
    const newTitle = `第${nextNum}章`;
    steps.push(`已推断下一章：${newTitle}`);
    this.emitProgress(onProgress, {
      phase: 'setup',
      message: `正在准备「${newTitle}」…`,
      current: 1,
      total: 4,
    });

    const chapter = await this.store.createChapter(projectId, newTitle);
    steps.push('已创建章节骨架。');

    const baseRequirement =
      prompt.length > 0 ? prompt : '顺接上一章剧情，推进主线并留下章节钩子。';
    // 把长期记忆（前情 + 设定事实 + 风格）注入蓝图需求，保证跨章节连贯。
    const memoryContext = this.memory.buildContext(projectId, scaledMemoryOptions(nextNum));
    const transferPrompt = this.referenceService?.buildActiveTransferPrompt(projectId) ?? '';
    const extraBlocks = [
      memoryContext.length > 0 ? `=== 须严格遵循的故事记忆 ===\n${memoryContext}` : '',
      transferPrompt.length > 0 ? `=== 参考写作方法（禁止抄袭原文） ===\n${transferPrompt}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const requirement =
      extraBlocks.length > 0 ? `${baseRequirement}\n\n${extraBlocks}` : baseRequirement;
    if (memoryContext.length > 0) {
      steps.push('已回灌长期记忆（前情 / 设定 / 风格）到本章规划。');
    }
    if (transferPrompt.length > 0) {
      steps.push('已注入参考小说迁移方法（不含参考原文）。');
    }
    this.emitProgress(onProgress, {
      phase: 'setup',
      message: '正在生成章节蓝图…',
      current: 2,
      total: 4,
    });
    await this.blueprintService.generate(
      chapter.id,
      { targetWords, requirement },
      signal,
    );
    steps.push('已生成章节蓝图与场景列表。');

    this.emitProgress(onProgress, {
      phase: 'chapter',
      message: `正在分场景写「${newTitle}」正文…`,
      current: 3,
      total: 4,
    });
    for await (const _event of this.chapterWriter.streamChapter(chapter.id, signal)) {
      if (signal.aborted) break;
    }
    steps.push('已按场景顺序写完并合并整章正文。');

    const saved = await this.store.getChapter(chapter.id);
    this.emitProgress(onProgress, {
      phase: 'reflect',
      message: '正文完成，正在反思并更新记忆…',
      current: 4,
      total: 4,
    });
    await this.reflectAndRemember(
      config,
      projectId,
      chapter.id,
      saved?.title ?? newTitle,
      saved?.content ?? '',
      signal,
    );
    const openFs = this.memory.listOpenForeshadows(projectId).length;
    steps.push(
      openFs > 0
        ? `已反思本章并更新长期记忆与伏笔台账（未回收 ${openFs} 条）。`
        : '已反思本章并更新长期记忆与伏笔台账。',
    );
    this.emitProgress(onProgress, {
      phase: 'info',
      message: `「${newTitle}」已完成。`,
      current: 4,
      total: 4,
    });
    return {
      task: 'auto_next',
      mode: 'draft',
      projectId,
      chapterId: chapter.id,
      summary: `已全自动完成「${newTitle}」的蓝图规划与正文写作。`,
      steps,
      artifacts: [
        { kind: 'project', id: projectId, title: project.name },
        { kind: 'chapter', id: chapter.id, title: saved?.title ?? newTitle },
      ],
    };
  }

  private async resolveProject(
    projectId: Id | undefined,
    prompt: string,
  ): Promise<{ projectId: Id; projectCreated: boolean; projectTitle: string }> {
    if (projectId !== undefined && projectId.trim().length > 0) {
      const existing = await this.store.getProject(projectId);
      if (!existing) throw ServiceError.notFound(`项目不存在：${projectId}`);
      return { projectId: existing.id, projectCreated: false, projectTitle: existing.name };
    }
    const name = inferProjectName(prompt);
    const project = await this.store.createProject(name);
    return { projectId: project.id, projectCreated: true, projectTitle: project.name };
  }

  /**
   * 长篇小说模式（SPEC V1）：多子代理运行时。
   *
   * 子代理阶段：
   * PlanningDirector → Worldbuilding → Character → Outline
   * → Chapter 循环（写 → 格式/剧情/一致性 Gate → 可选自动修订 → 记忆/伏笔）
   *
   * 自动化等级控制本批章数、是否自动修订、硬冲突是否暂停。
   */
  private async runLongNovel(
    config: ModelConfig,
    prompt: string,
    projectId: Id | undefined,
    options: AgentRunRequest['options'] | undefined,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    const automationLevel: LongNovelAutomationLevel =
      options?.automationLevel === 'assistant' ||
      options?.automationLevel === 'semi_auto' ||
      options?.automationLevel === 'auto' ||
      options?.automationLevel === 'unattended'
        ? options.automationLevel
        : 'semi_auto';

    const perChapter = clampInteger(
      options?.targetWords ?? FULL_NOVEL_LIMITS.defaultTargetWords,
      FULL_NOVEL_LIMITS.minTargetWords,
      FULL_NOVEL_LIMITS.maxTargetWords,
    );
    const requestedBatch = clampInteger(
      options?.chapters ?? (automationLevel === 'assistant' ? 1 : 3),
      FULL_NOVEL_LIMITS.minChapters,
      FULL_NOVEL_LIMITS.maxChapters,
    );
    const totalWords = normalizeLongNovelTotalWords(options?.totalWords);
    const plannedTotalChapters = clampInteger(
      options?.totalChapters ?? options?.planSummary?.chapterCount ?? Math.ceil(totalWords / perChapter),
      FULL_NOVEL_LIMITS.minChapters,
      FULL_NOVEL_LIMITS.maxChapters,
    );

    const modeConfig: LongNovelModeConfig = defaultLongNovelConfig({
      automationLevel,
      targetWords: totalWords,
      targetChapters: plannedTotalChapters,
      targetWordsPerChapter: perChapter,
      minWordsPerChapter: options?.minWordsPerChapter,
      maxWordsPerChapter: options?.maxWordsPerChapter,
      maxChaptersPerRun: longNovelBatchLimit(automationLevel),
    });
    // assistant 强制单章；其余模式统一按五章检查点运行，避免超长任务丢失整批结果。
    let chapterCount = Math.min(requestedBatch, modeConfig.maxChaptersPerRun);

    const emit = (event: AgentProgressEvent): void => {
      this.emitProgress(onProgress, event);
    };
    const steps: string[] = [];
    const subAgents: string[] = [];

    emit({
      phase: 'setup',
      message: `【主 Agent】启动长篇小说模式（${automationLevel}）…`,
    });
    if (automationLevel === 'unattended') {
      steps.push('⚠ 无人值守模式：将连续生成多章并自动审校，可能消耗大量 Token。');
    }

    const projectSeed = options?.planSummary?.title?.trim() || prompt;
    const { projectId: pid, projectCreated, projectTitle } = await this.resolveProject(
      projectId,
      projectSeed,
    );
    await this.purgeEmptyChapterShells(pid);
    const existing = await this.store.listChapters(pid);
    const completedBefore = existing.filter(
      (ch) => ch.content.trim().length > 0 && !this.memory.isChapterRejected(pid, ch.id),
    ).length;
    const requestedChapterCount = chapterCount;
    chapterCount = remainingLongNovelBatch(
      requestedChapterCount,
      completedBefore,
      plannedTotalChapters,
    );
    steps.push(projectCreated ? '已创建长篇小说项目。' : '已复用当前项目。');
    steps.push(
      `长篇配置：自动化=${automationLevel}；本批 ${chapterCount} 章×${perChapter} 字；总计划 ${plannedTotalChapters} 章 / 约 ${totalWords.toLocaleString()} 字。`,
    );
    if (requestedBatch > modeConfig.maxChaptersPerRun) {
      steps.push(
        `为保证可恢复性，原请求 ${requestedBatch} 章已按单批安全上限裁剪为 ${modeConfig.maxChaptersPerRun} 章；完成后可继续下一批。`,
      );
    }
    if (chapterCount < requestedChapterCount) {
      steps.push(`检测到已完成 ${completedBefore} 章，本批按剩余总计划裁剪为 ${chapterCount} 章。`);
    }

    const artifacts: AgentArtifact[] = [{ kind: 'project', id: pid, title: projectTitle }];
    if (chapterCount === 0) {
      return {
        task: 'long_novel',
        mode: 'draft',
        projectId: pid,
        summary: `全书计划已完成：现有 ${completedBefore}/${plannedTotalChapters} 章，无需继续生成。`,
        steps,
        artifacts,
        metrics: emptyMetrics(totalWords, 0),
      };
    }

    if (this.longNovelConfigStore) {
      await this.longNovelConfigStore.save(pid, modeConfig);
      steps.push('已保存长篇小说模式配置。');
    }

    const packPrompt = appendPlanContextToPrompt(prompt, options?.planSummary);
    const transferPrompt = this.referenceService?.buildActiveTransferPrompt(pid) ?? '';
    const directorBrief = [
      packPrompt,
      transferPrompt ? `\n# 已启用参考方法（禁止抄原文）\n${transferPrompt}` : '',
      `\n# 长篇目标\n全书约 ${totalWords} 字，计划 ${plannedTotalChapters} 章，每章约 ${perChapter} 字。自动化：${automationLevel}。`,
    ]
      .filter(Boolean)
      .join('\n');

    // —— 多子代理规划阶段 ——
    emit({ phase: 'setup', message: '【PlanningDirector】确认故事核心与创作边界…' });
    subAgents.push('PlanningDirector');
    let pack = projectCreated ? undefined : await this.loadExistingPack(pid, directorBrief, artifacts);
    if (pack) {
      steps.push('【PlanningDirector】复用已有设定包，跳过完整规划。');
    } else if (modeConfig.planningEnabled) {
      emit({ phase: 'setup', message: '【WorldbuildingAgent】生成世界规则…' });
      subAgents.push('WorldbuildingAgent');
      emit({ phase: 'setup', message: '【CharacterAgent】生成人物护栏…' });
      subAgents.push('CharacterAgent');
      emit({ phase: 'setup', message: '【OutlineAgent】生成卷纲与章节锚点…' });
      subAgents.push('OutlineAgent');
      pack = await this.generatePack(config, directorBrief, 'draft', 'novel', signal, onProgress);
      if (options?.planSummary?.title?.trim()) {
        pack = { ...pack, title: options.planSummary.title.trim() };
      }
      const world = await this.store.createWorldSetting(pid, pack.title, pack.world);
      artifacts.push({ kind: 'world', id: world.id, title: world.title });
      await this.persistGeneratedCharacters(pid, pack.characters, artifacts);
      const outline = await this.store.createOutline(pid, `${pack.title}：大纲`, pack.outline);
      artifacts.push({ kind: 'outline', id: outline.id, title: outline.title });
      steps.push('已完成多子代理规划：世界 / 人物 / 大纲。');
    } else {
      pack = await this.generatePack(config, directorBrief, 'draft', 'novel', signal, onProgress);
      const world = await this.store.createWorldSetting(pid, pack.title, pack.world);
      artifacts.push({ kind: 'world', id: world.id, title: world.title });
      await this.persistGeneratedCharacters(pid, pack.characters, artifacts);
      const outline = await this.store.createOutline(pid, `${pack.title}：大纲`, pack.outline);
      artifacts.push({ kind: 'outline', id: outline.id, title: outline.title });
    }

    if (options?.planSummary) {
      emit({ phase: 'setup', message: '【PlanningDirector】采纳计划分章大纲与创作规则…' });
      pack = await this.adoptPlanMaterials(
        pid,
        pack,
        options.planSummary,
        plannedTotalChapters,
        perChapter,
        artifacts,
        steps,
      );
      await this.promoteLegacyCharacterRecords(
        pid,
        pack.characters,
        options.planSummary.protagonist,
        artifacts,
      );
    }
    pack = await this.ensureChapterOutfitPlan(pid, pack, artifacts);

    const plannedFinalChapter = Math.max(completedBefore + chapterCount, plannedTotalChapters);
    pack = await this.ensureFullNovelControlOutline(
      config,
      pid,
      pack,
      directorBrief,
      plannedFinalChapter,
      perChapter,
      signal,
      emit,
      artifacts,
      steps,
    );

    const seedResult = await this.seedProjectMemory(pid, pack, options?.planSummary, {
      seedPack: projectCreated || completedBefore === 0,
    });
    if (seedResult.seededPack) {
      steps.push('【MemoryAgent】已写入初始 Canon / 计划事实。');
      subAgents.push('MemoryAgent');
    } else if (seedResult.seededPlan) {
      steps.push('【MemoryAgent】已将计划约束写入故事记忆。');
      subAgents.push('MemoryAgent');
    }

    // 模式配置落档到大纲，便于作者查看
    const cfgDoc = await this.upsertOutlineByTitle(
      pid,
      '长篇小说模式配置',
      [
        '# 长篇小说模式配置',
        '',
        `- 自动化等级：${automationLevel}`,
        `- 全书目标：约 ${totalWords.toLocaleString()} 字 / ${plannedTotalChapters} 章`,
        `- 每章：${modeConfig.minWordsPerChapter}–${modeConfig.maxWordsPerChapter}（目标 ${perChapter}）`,
        `- 本批：${chapterCount} 章`,
        `- 自动修订：${modeConfig.autoRevisionEnabled ? '开' : '关'}`,
        `- 硬冲突暂停：${modeConfig.stopOnCanonConflict ? '开' : '关'}`,
        `- 子代理：${[...new Set(subAgents)].join(' → ')} → ChapterAgent → ContinuityAgent → MemoryAgent`,
      ].join('\n'),
    );
    artifacts.push({ kind: 'outline', id: cfgDoc.id, title: cfgDoc.title });

    if (!modeConfig.chapterLoopEnabled) {
      return {
        task: 'long_novel',
        mode: 'draft',
        projectId: pid,
        summary: '长篇规划已完成（章节循环未启用）。',
        steps,
        artifacts,
        metrics: emptyMetrics(plannedTotalChapters * perChapter, 0),
      };
    }

    // —— 章节循环 ——
    emit({ phase: 'setup', message: '【ChapterAgent】设定就绪，进入章节生成循环…' });
    subAgents.push('ChapterAgent', 'ContinuityAgent');
    const outlineByNumber = indexPlanChapterOutlines(options?.planSummary?.chapterOutlines);
    let lastChapterId: Id | undefined;
    let completedChapters = 0;
    let consecutiveFailures = 0;
    let stoppedReason: string | undefined;

    for (let i = 0; i < chapterCount; i += 1) {
      if (signal.aborted) {
        stoppedReason = '用户中止';
        break;
      }
      const num = completedBefore + i + 1;
      const planChapter = outlineByNumber.get(num);
      const title = planChapter?.title?.trim()
        ? `第${num}章 ${planChapter.title.trim()}`
        : `第${num}章`;

      emit({
        phase: 'chapter',
        message: `【ChapterAgent】装配上下文并撰写「${title}」…`,
        current: i + 1,
        total: chapterCount,
      });
      const chapter = await this.getOrCreateLongNovelChapter(pid, title);
      let content: string;
      try {
        content = await this.writeLongNovelChapter(
          config,
          pid,
          chapter.id,
          pack,
          num,
          plannedFinalChapter,
          title,
          planChapter?.goal,
          directorBrief,
          perChapter,
          signal,
          emit,
          { current: i + 1, total: chapterCount },
          steps,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        await this.discardEmptyChapterUnlessCheckpoint(chapter.id);
        const detail = error instanceof Error ? error.message.slice(0, 120) : '未知模型错误';
        stoppedReason = `第${num}章生成失败，检查点已保留，可从本章继续（${detail}）`;
        steps.push(`【ChapterAgent】「${title}」生成失败；前序章节与当前场景检查点均已保留。`);
        emit({
          phase: 'info',
          message: `【主 Agent】${stoppedReason}`,
          current: i + 1,
          total: chapterCount,
        });
        break;
      }

      // Empty prose is a writer failure, not a continuity conflict. Never send
      // it to ContinuityAgent/ReviewAgent, and remove the empty placeholder so
      // a later resume can generate the same chapter number cleanly.
      if (content.trim().length === 0) {
        await this.discardEmptyChapterUnlessCheckpoint(chapter.id);
        stoppedReason = `ChapterAgent 连续 ${MAX_EMPTY_CHAPTER_ATTEMPTS} 次返回空正文，已暂停（${title}）`;
        steps.push(`【ChapterAgent】「${title}」连续 ${MAX_EMPTY_CHAPTER_ATTEMPTS} 次未返回正文，未进入审校。`);
        emit({
          phase: 'info',
          message: `【主 Agent】${stoppedReason}`,
          current: i + 1,
          total: chapterCount,
        });
        break;
      }

      artifacts.push({ kind: 'chapter', id: chapter.id, title });
      lastChapterId = chapter.id;

      // Gate 1 格式（预检）
      let gates = runChapterQualityGates({
        content,
        minWords: modeConfig.minWordsPerChapter,
        maxWords: modeConfig.maxWordsPerChapter,
        targetWords: perChapter,
        chapterTitle: title,
      });
      // Slight word-count drift is advisory and must not discard a complete
      // scene pipeline draft. Re-run the expensive whole-chapter writer only
      // for hard format failures such as empty/meta output.
      const formatNeedsRewrite = gates.hardFail;
      if (modeConfig.autoRevisionEnabled && formatNeedsRewrite) {
        emit({
          phase: 'chapter',
          message: `【ChapterAgent】格式 Gate 未过，尝试重写「${title}」…`,
          current: i + 1,
          total: chapterCount,
        });
        const rewrittenContent = await this.generateChapterWithMemory(
          config,
          pid,
          pack,
          num,
          plannedFinalChapter,
          `${directorBrief}\n\n# 修订要求\n上一稿格式不合格：${gates.findings.map((f) => f.message).join('；')}`,
          perChapter,
          signal,
        );
        if (rewrittenContent.trim().length > 0) {
          content = rewrittenContent;
        } else {
          emit({
            phase: 'info',
            message: `【ChapterAgent】格式重写「${title}」返回空正文，已保留原稿继续审校。`,
            current: i + 1,
            total: chapterCount,
          });
        }
      }

      await this.store.updateChapterContent(chapter.id, content);

      // 审校 → 可选修订 → 再检 → 仅对终稿应用结论与反思
      const processed = await this.processChapterDraft(
        config,
        pid,
        pack,
        num,
        chapter.id,
        title,
        directorBrief,
        content,
        perChapter,
        plannedFinalChapter,
        signal,
        emit,
        {
          autoRevisionEnabled: modeConfig.autoRevisionEnabled,
          inspectChapter: shouldInspectLongNovelChapter(
            num,
            modeConfig.checkpointInterval,
            gates,
          ),
          qualityGates: {
            minWords: modeConfig.minWordsPerChapter,
            maxWords: modeConfig.maxWordsPerChapter,
            targetWords: perChapter,
          },
          labels: {
            inspect: (t) => `【ContinuityAgent】审校「${t}」…`,
            revise: (t) => `【ReviewAgent】自动修订「${t}」…`,
            reflect: (t) => `【MemoryAgent】提取「${t}」记忆与伏笔…`,
          },
          progress: { current: i + 1, total: chapterCount },
        },
      );
      const finalContent = processed.finalContent;
      const finalInspection = processed.finalInspection;
      gates = processed.gates ?? gates;
      if (processed.revised) {
        steps.push(`【ReviewAgent】已修订「${title}」。`);
      }

      // 检查点大纲（每 N 章）
      if (
        modeConfig.checkpointInterval > 0 &&
        (completedChapters + 1) % modeConfig.checkpointInterval === 0
      ) {
        const cp = await this.store.createOutline(
          pid,
          `检查点：第${num}章`,
          [
            `# 检查点`,
            `章：${title}`,
            `字数：${finalContent.length}`,
            `一致性分：${finalInspection.score0to100}`,
            `Gate：${gates.findings.map((f) => `[${f.gate}] ${f.message}`).join('；') || '通过'}`,
            `时间：${new Date().toISOString()}`,
          ].join('\n'),
        );
        artifacts.push({ kind: 'outline', id: cp.id, title: cp.title });
        steps.push(`已创建检查点（第${num}章）。`);
      }

      const hasP0Continuity = gates.findings.some(
        (finding) => finding.gate === 'continuity' && finding.severity === 'hard',
      );
      if (gates.hardFail && (modeConfig.stopOnCanonConflict || hasP0Continuity)) {
        consecutiveFailures += 1;
        steps.push(
          `【Gate】「${title}」硬冲突：${gates.findings
            .filter((f) => f.severity === 'hard')
            .map((f) => f.message)
            .join('；')}`,
        );
        if (
          hasP0Continuity ||
          consecutiveFailures >= modeConfig.maxConsecutiveFailures ||
          automationLevel === 'semi_auto' ||
          automationLevel === 'assistant'
        ) {
          stoppedReason = `一致性/格式硬冲突，已暂停（${title}）`;
          emit({
            phase: 'info',
            message: `【主 Agent】${stoppedReason}`,
            current: i + 1,
            total: chapterCount,
          });
          break;
        }
      } else {
        consecutiveFailures = 0;
      }

      completedChapters += 1;
      steps.push(
        `【ChapterAgent】完成「${title}」（${finalContent.length} 字，检测 ${finalInspection.score0to100}）。`,
      );
      emit({
        phase: 'chapter',
        message: `「${title}」已通过章节循环`,
        current: i + 1,
        total: chapterCount,
      });
    }

    const plannedWords = plannedTotalChapters * perChapter;
    const summary = stoppedReason
      ? `长篇小说模式已暂停：完成 ${completedChapters}/${chapterCount} 章。原因：${stoppedReason}`
      : `长篇小说模式本批完成 ${completedChapters}/${chapterCount} 章（自动化=${automationLevel}；多子代理：规划→写作→审校→记忆）。`;

    emit({ phase: 'info', message: summary });
    return {
      task: 'long_novel',
      mode: 'draft',
      projectId: pid,
      chapterId: lastChapterId,
      summary,
      steps: [
        `参与子代理：${[...new Set(subAgents)].join('、')}`,
        ...steps,
      ],
      artifacts,
      metrics: emptyMetrics(plannedWords, completedChapters),
    };
  }

  /**
   * 一键生成整本（小说）：建项目 → 设定包 → 循环写 N 章，每章都注入长期记忆并写完后反思。
   * 这是 Agent 的「长程自动循环」：上一章的反思沉淀会成为下一章的上下文，逐章累积连贯性。
   *
   * 若携带 planSummary（计划模式 / StoryForge 风格采纳），会先把分章大纲与创作规则写入项目资料，
   * 并作为章节锚点优先于再生成总控大纲。
   */
  private async runFullNovel(
    config: ModelConfig,
    prompt: string,
    projectId: Id | undefined,
    chapters: number,
    targetWords: number,
    totalChapters: number | undefined,
    planSummary: NovelPlanSummary | undefined,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    // 计划规模优先于 options 默认值（用户在计划模式里确认过的章数/字数）
    const planChapters = planSummary?.chapterCount;
    const planWords = planSummary?.wordsPerChapter;
    const { chapterCount, wordsPerChapter } = normalizeFullNovelOptions(
      planChapters ?? chapters,
      planWords ?? targetWords,
    );
    const plannedTotalChapters = clampInteger(
      planSummary?.chapterCount ?? totalChapters ?? chapterCount,
      FULL_NOVEL_LIMITS.minChapters,
      FULL_NOVEL_LIMITS.maxChapters,
    );
    const plannedWords =
      planSummary?.totalWords ?? plannedTotalChapters * wordsPerChapter;
    const emit = (event: AgentProgressEvent): void => {
      this.emitProgress(onProgress, event);
    };
    const steps: string[] = [];
    emit({ phase: 'setup', message: '正在准备项目…' });
    const projectSeedName = planSummary?.title?.trim() || prompt;
    const { projectId: pid, projectCreated, projectTitle } = await this.resolveProject(
      projectId,
      projectSeedName,
    );
    steps.push(projectCreated ? '已自动创建小说项目。' : '已复用当前小说项目。');
    steps.push(
      `长篇参数：本批 ${chapterCount} 章 x ${wordsPerChapter} 字；总计划 ${plannedTotalChapters} 章，约 ${plannedWords.toLocaleString()} 字。`,
    );

    const artifacts: AgentArtifact[] = [{ kind: 'project', id: pid, title: projectTitle }];
    const packPrompt = appendPlanContextToPrompt(prompt, planSummary);

    let pack = projectCreated ? undefined : await this.loadExistingPack(pid, packPrompt, artifacts);
    if (pack) {
      steps.push('已复用现有世界观 / 人物护栏 / 大纲，继续长篇批处理。');
      emit({ phase: 'setup', message: '已复用现有设定包，开始继续写作。' });
    } else {
      emit({ phase: 'setup', message: '正在生成世界观 / 人物 / 大纲设定包…' });
      pack = await this.generatePack(config, packPrompt, 'draft', 'novel', signal);
      // 计划书名覆盖模型生成的临时标题
      if (planSummary?.title?.trim()) {
        pack = { ...pack, title: planSummary.title.trim() };
      }
      const world = await this.store.createWorldSetting(pid, pack.title, pack.world);
      artifacts.push({ kind: 'world', id: world.id, title: world.title });
      await this.persistGeneratedCharacters(pid, pack.characters, artifacts);
      const outline = await this.store.createOutline(pid, `${pack.title}：大纲`, pack.outline);
      artifacts.push({ kind: 'outline', id: outline.id, title: outline.title });
      steps.push('已生成并保存世界观 / 人物护栏 / 大纲。');
    }

    // StoryForge 风格：把计划模式产出的分章大纲 / 创作规则写入项目，并注入 pack
    if (planSummary) {
      emit({ phase: 'setup', message: '正在采纳计划资料（分章大纲 / 创作规则）…' });
      pack = await this.adoptPlanMaterials(
        pid,
        pack,
        planSummary,
        plannedTotalChapters,
        wordsPerChapter,
        artifacts,
        steps,
      );
      await this.promoteLegacyCharacterRecords(
        pid,
        pack.characters,
        planSummary.protagonist,
        artifacts,
      );
    }
    pack = await this.ensureChapterOutfitPlan(pid, pack, artifacts);

    await this.purgeEmptyChapterShells(pid);
    const existing = await this.store.listChapters(pid);
    const completedBefore = existing.filter(
      (ch) => ch.content.trim().length > 0 && !this.memory.isChapterRejected(pid, ch.id),
    ).length;
    const plannedFinalChapter = Math.max(completedBefore + chapterCount, plannedTotalChapters);
    pack = await this.ensureFullNovelControlOutline(
      config,
      pid,
      pack,
      packPrompt,
      plannedFinalChapter,
      wordsPerChapter,
      signal,
      emit,
      artifacts,
      steps,
    );
    const seedResult = await this.seedProjectMemory(pid, pack, planSummary, {
      seedPack: projectCreated || completedBefore === 0,
    });
    if (seedResult.seededPack) {
      steps.push('已写入初始故事记忆（设定事实）。');
    } else if (seedResult.seededPlan) {
      steps.push('已将计划约束写入故事记忆。');
    }

    emit({ phase: 'setup', message: '设定、总控大纲与初始记忆就绪，开始逐章写作。' });
    const outlineByNumber = indexPlanChapterOutlines(planSummary?.chapterOutlines);
    let lastChapterId: Id | undefined;
    let completedChapters = 0;
    let stoppedOnP0Title: string | undefined;
    for (let i = 0; i < chapterCount; i += 1) {
      if (signal.aborted) break;
      const num = completedBefore + i + 1;
      const planChapter = outlineByNumber.get(num);
      const title = planChapter?.title?.trim()
        ? `第${num}章 ${planChapter.title.trim()}`
        : `第${num}章`;
      emit({ phase: 'chapter', message: `正在写「${title}」正文…`, current: i + 1, total: chapterCount });
      const chapter = await this.getOrCreateLongNovelChapter(pid, title);
      artifacts.push({ kind: 'chapter', id: chapter.id, title });
      lastChapterId = chapter.id;

      const content = await this.writeLongNovelChapter(
        config,
        pid,
        chapter.id,
        pack,
        num,
        plannedFinalChapter,
        title,
        planChapter?.goal,
        packPrompt,
        wordsPerChapter,
        signal,
        emit,
        { current: i + 1, total: chapterCount },
        steps,
      );
      if (content.trim().length === 0) {
        await this.discardEmptyChapterUnlessCheckpoint(chapter.id);
        steps.push(`【ChapterAgent】「${title}」未生成正文，已保留项目状态供重试。`);
        break;
      }
      // 审校 → 可选修订 → 再检 → 仅对终稿应用结论与反思
      const processed = await this.processChapterDraft(
        config,
        pid,
        pack,
        num,
        chapter.id,
        title,
        packPrompt,
        content,
        wordsPerChapter,
        plannedFinalChapter,
        signal,
        emit,
        {
          autoRevisionEnabled: true,
          qualityGates: null,
          labels: {
            inspect: (t) => `写作子 Agent 已完成「${t}」，检测子 Agent 审查中…`,
            revise: (t) => `检测子 Agent 要求修订「${t}」…`,
          },
          progress: { current: i + 1, total: chapterCount },
        },
      );
      const finalContent = processed.finalContent;
      const finalInspection = processed.finalInspection;
      if (processed.revised) {
        steps.push(`检测子 Agent 已触发修订「${title}」。`);
      }
      if (processed.gates?.hardFail) {
        steps.push(
          `【Gate】「${title}」P0 硬冲突：${processed.gates.findings
            .filter((finding) => finding.severity === 'hard')
            .map((finding) => finding.message)
            .join('；')}`,
        );
        emit({
          phase: 'info',
          message: `【主 Agent】P0 大 Bug 已拦截；「${title}」保留为待确认稿，未提交到后续记忆。`,
          current: i + 1,
          total: chapterCount,
        });
        stoppedOnP0Title = title;
        break;
      }
      completedChapters += 1;
      steps.push(
        `已写完「${title}」（${finalContent.length} 字）；检测评分 ${finalInspection.score0to100}。`,
      );
      emit({
        phase: 'chapter',
        message: `「${title}」已完成（${finalContent.length} 字）`,
        current: i + 1,
        total: chapterCount,
      });
    }

    emit({
      phase: 'info',
      message: stoppedOnP0Title
        ? `整本草稿已暂停：请先确认并修复「${stoppedOnP0Title}」。`
        : '整本草稿生成完成。',
    });
    return {
      task: 'full_novel',
      mode: 'draft',
      projectId: pid,
      chapterId: lastChapterId,
      summary: stoppedOnP0Title
        ? `整本草稿因 P0 大 Bug 暂停：完成 ${completedChapters}/${chapterCount} 章；「${stoppedOnP0Title}」保留为待确认稿，未提交记忆。`
        : planSummary
          ? `已按计划生成整本草稿：完成 ${completedChapters}/${chapterCount} 章（分章大纲与创作规则已采纳），全程带长期记忆与逐章反思。`
          : `已一键生成整本草稿：完成 ${completedChapters}/${chapterCount} 章，全程带长期记忆与逐章反思自我进化。`,
      steps,
      artifacts,
      metrics: {
        modelCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        cacheHitRatePct: 0,
        localCacheHits: 0,
        localCacheMisses: 0,
        localCacheHitRatePct: 0,
        plannedWords,
        completedChapters,
      },
    };
  }

  /**
   * Long-form chapter writer with a resumable scene pipeline.
   *
   * The blueprint module is the durable path: each scene is committed before
   * the next one starts, so a provider timeout resumes from the first missing
   * scene.  Existing projects or providers that cannot return valid blueprint
   * JSON still get a bounded direct-writer fallback; this keeps the feature
   * compatible with older models while making the normal path scene-sized.
   */
  private async writeLongNovelChapter(
    config: ModelConfig,
    projectId: Id,
    chapterId: Id,
    pack: GeneratedPack,
    chapterNumber: number,
    totalChapters: number,
    chapterTitle: string,
    chapterGoal: string | undefined,
    seedPrompt: string,
    targetWords: number,
    signal: AbortSignal,
    emit: (event: AgentProgressEvent) => void,
    progress: { current: number; total: number },
    steps: string[],
  ): Promise<string> {
    const existingRejectedDraft = await this.store.getChapter(chapterId);
    if (
      existingRejectedDraft?.content.trim() &&
      this.memory.isChapterRejected(projectId, chapterId)
    ) {
      steps.push(`【ChapterAgent】复用「${chapterTitle}」待确认稿，重新执行 P0 检查。`);
      return existingRejectedDraft.content.trim();
    }
    const memoryContext = this.memory.buildContext(projectId, scaledMemoryOptions(chapterNumber));
    const requirement = buildChapterBlueprintRequirement({
      chapterNumber,
      chapterTitle,
      targetWords,
      chapterGoal,
      seedPrompt,
      memoryContext,
    });

    try {
      emit({
        phase: 'setup',
        message: `【ChapterPlanner】为「${chapterTitle}」拆分场景蓝图…`,
        current: progress.current,
        total: progress.total,
      });
      const existingBlueprint = await this.store.getChapterBlueprintByChapter(chapterId);
      if (existingBlueprint) {
        const existingDrafts = await this.store.listSceneDrafts(chapterId);
        steps.push(
          `【ChapterPlanner】复用「${chapterTitle}」已有场景蓝图（已完成 ${existingDrafts.filter((draft) => draft.content.trim().length > 0).length}/${existingBlueprint.scenes.length} 个场景）。`,
        );
        emit({
          phase: 'setup',
          message: `【ChapterPlanner】检测到「${chapterTitle}」检查点，继续未完成场景…`,
          current: progress.current,
          total: progress.total,
        });
      } else {
        await this.blueprintService.generate(
          chapterId,
          { targetWords, requirement },
          signal,
        );
        steps.push(`【ChapterPlanner】已保存「${chapterTitle}」场景蓝图。`);
      }

      let sceneCount = 0;
      for await (const event of this.chapterWriter.streamChapter(chapterId, signal)) {
        if (event.type === 'scene') {
          sceneCount += 1;
          emit({
            phase: 'chapter',
            message: `【SceneWriter】正在写「${chapterTitle}」场景 ${event.sceneId}…`,
            current: progress.current,
            total: progress.total,
          });
        }
      }
      const saved = await this.store.getChapter(chapterId);
      const content = saved?.content?.trim() ?? '';
      if (content.length > 0) {
        steps.push(`【SceneWriter】已完成「${chapterTitle}」（${sceneCount} 个场景，${content.length} 字）。`);
        return content;
      }
      throw ServiceError.validation(`「${chapterTitle}」场景已结束但合并正文为空。`);
    } catch (error) {
      if (signal.aborted) throw error;
      const detail = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
      steps.push(`【ChapterPlanner】「${chapterTitle}」蓝图链路未完成，已降级为正文续写（${detail}）。`);
      emit({
        phase: 'info',
        message: `【主 Agent】「${chapterTitle}」场景链路暂不可用，保留已完成分场景并改用兼容写作链路。`,
        current: progress.current,
        total: progress.total,
      });
    }

    let content = '';
    let lastProviderError: unknown;
    for (let attempt = 1; attempt <= MAX_EMPTY_CHAPTER_ATTEMPTS; attempt += 1) {
      try {
        content = await this.generateChapterWithMemory(
          config,
          projectId,
          pack,
          chapterNumber,
          totalChapters,
          attempt === 1
            ? seedPrompt
            : `${seedPrompt}\n\n# 重试要求\n上一次模型返回了空正文或临时网关失败。本次必须直接输出完整章节正文，不得只输出思考、解释或空白。`,
          targetWords,
          signal,
        );
        lastProviderError = undefined;
      } catch (error) {
        if (signal.aborted || !isRetryableChapterError(error)) throw error;
        lastProviderError = error;
        if (attempt < MAX_EMPTY_CHAPTER_ATTEMPTS) {
          emit({
            phase: 'chapter',
            message: `【ChapterAgent】「${chapterTitle}」模型暂时失败，正在重试（${attempt + 1}/${MAX_EMPTY_CHAPTER_ATTEMPTS}）…`,
            current: progress.current,
            total: progress.total,
          });
          continue;
        }
        break;
      }
      if (content.trim().length > 0) break;
      if (attempt < MAX_EMPTY_CHAPTER_ATTEMPTS) {
        emit({
          phase: 'chapter',
          message: `【ChapterAgent】「${chapterTitle}」返回空正文，正在重试（${attempt + 1}/${MAX_EMPTY_CHAPTER_ATTEMPTS}）…`,
          current: progress.current,
          total: progress.total,
        });
      }
    }
    if (content.trim().length === 0 && lastProviderError !== undefined) {
      throw lastProviderError;
    }
    if (content.trim().length > 0) {
      await this.store.updateChapterContent(chapterId, content);
    }
    return content;
  }

  /** 用「设定包 + 长期记忆」生成单章正文（用于一键整本的长程循环）。 */
  private async generateChapterWithMemory(
    config: ModelConfig,
    projectId: Id,
    pack: GeneratedPack,
    chapterNumber: number,
    totalChapters: number,
    seedPrompt: string,
    targetWords: number,
    signal: AbortSignal,
  ): Promise<string> {
    const progressRatio = totalChapters > 0 ? chapterNumber / totalChapters : 0;
    const memoryContext = this.memory.buildContext(projectId, {
      ...scaledMemoryOptions(chapterNumber),
      progressRatio,
    });
    const transferPrompt = this.referenceService?.buildActiveTransferPrompt(projectId) ?? '';
    const memoryBlock = [
      memoryContext.length > 0 ? memoryContext : '',
      transferPrompt.length > 0 ? transferPrompt : '',
    ]
      .filter(Boolean)
      .map((block) => `\n\n${block}`)
      .join('');
    const chapterOutline = extractChapterOutline(pack.outline, chapterNumber);
    const chapterOutlineBlock =
      chapterOutline ??
      `总大纲未提供第 ${chapterNumber} 章独立条目。请按当前进度承接总大纲，不得提前回收后续重大伏笔。`;
    const positionHint =
      chapterNumber === 1
        ? '这是开篇第一章：交代主角与世界、抛出核心冲突与悬念；可埋设 1～2 条可回收伏笔。'
        : chapterNumber >= totalChapters
          ? '这是收尾章：推进到高潮并给出结局或强力收束，优先回收未决伏笔，呼应前情。'
          : progressRatio >= 0.75
            ? '这是后段章节：推进主线并开始自然回收高优先伏笔，章末仍可留轻钩子。'
            : '这是中段章节：顺接前情、推进主线、深化人物；可呼应旧伏笔并留下章末钩子。';
    const openCount = this.memory.listOpenForeshadows(projectId).length;
    const foreshadowHint =
      openCount > 0
        ? `当前未回收伏笔 ${openCount} 条，写作时须遵守记忆中的「伏笔台账」指引。`
        : '可按章纲适度埋设新伏笔，便于后文回收。';
    const system = [
      `你是长篇小说正文写作子 Agent，正在连续创作《${pack.title}》。`,
      '只输出本章正文，不要输出大纲、解释或总结。',
      '务必与下列设定、人物护栏、整卷大纲、章节锚点、伏笔台账和前情保持严格一致。',
      '本章必须优先执行「本章大纲锚点」；只能补足必要场景，不得跳到后续章节重大剧情。',
      foreshadowHint,
      '',
      pack.world,
      '',
      pack.characters,
      '',
      '# 整卷大纲',
      pack.outline,
      '',
      '# 本章控制',
      `当前进度：第 ${chapterNumber} / ${totalChapters} 章。${positionHint}`,
      `目标字数：约 ${targetWords} 字。`,
      '',
      '# 本章大纲锚点',
      chapterOutlineBlock,
      memoryBlock,
    ].join('\n');
    return this.generateText(
      config,
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            chapterNumber === 1
              ? `请严格按本章大纲锚点写第 ${chapterNumber} 章正文。整体题材需求：${seedPrompt}`
              : `请严格按本章大纲锚点顺接前情，写第 ${chapterNumber} 章正文，保持文风一致。`,
        },
      ],
      signal,
    );
  }

  private async ensureFullNovelControlOutline(
    config: ModelConfig,
    projectId: Id,
    pack: GeneratedPack,
    seedPrompt: string,
    totalChapters: number,
    targetWords: number,
    signal: AbortSignal,
    emit: (event: AgentProgressEvent) => void,
    artifacts: AgentArtifact[],
    steps: string[],
  ): Promise<GeneratedPack> {
    if (extractChapterOutline(pack.outline, totalChapters) !== undefined) return pack;

    const chunks: string[] = [];
    for (let start = 1; start <= totalChapters; start += CONTROL_OUTLINE_CHUNK_SIZE) {
      const end = Math.min(totalChapters, start + CONTROL_OUTLINE_CHUNK_SIZE - 1);
      emit({ phase: 'setup', message: `正在生成第 ${start}-${end} 章总控锚点…` });
      const raw = await this.generateControlOutlineChunk(
        config,
        pack,
        seedPrompt,
        start,
        end,
        totalChapters,
        targetWords,
        signal,
      );
      chunks.push(normalizeControlOutlineChunk(raw, start, end, totalChapters));
    }

    const controlOutline = [
      '# 长篇章节控制大纲',
      '',
      `总章数：${totalChapters}`,
      `每章目标：约 ${targetWords} 字`,
      '',
      chunks.join('\n\n'),
    ].join('\n');
    const saved = await this.store.createOutline(projectId, `${pack.title}：长篇章节控制大纲`, controlOutline);
    artifacts.push({ kind: 'outline', id: saved.id, title: saved.title });
    steps.push(`已生成并保存长篇章节控制大纲（1-${totalChapters} 章）。`);
    return {
      ...pack,
      outline: `${pack.outline.trim()}\n\n${controlOutline}`,
    };
  }

  private async generateControlOutlineChunk(
    config: ModelConfig,
    pack: GeneratedPack,
    seedPrompt: string,
    startChapter: number,
    endChapter: number,
    totalChapters: number,
    targetWords: number,
    signal: AbortSignal,
  ): Promise<string> {
    return this.generateText(
      config,
      [
        {
          role: 'system',
          content: [
            '你是长篇小说总控策划子 Agent，负责把整本小说拆成可执行章节锚点。',
            `整本目标：${totalChapters} 章，每章约 ${targetWords} 字。`,
            `当前只规划第 ${startChapter}-${endChapter} 章。`,
            '只输出 Markdown，不要写正文、解释或总结。',
            '必须连续覆盖当前范围内每一章，不得跳号、并章或提前回收后续重大伏笔。',
            '每章使用两行，格式严格为：',
            '### 第N章：短标题',
            '本章锚点：核心事件 + 人物状态变化 + 章末推进，不超过 60 个汉字。',
            '',
            `用户题材需求：${seedPrompt}`,
            '',
            '# 世界观摘要',
            pack.world.slice(0, 1600),
            '',
            '# 人物护栏摘要',
            pack.characters.slice(0, 1600),
            '',
            '# 既有卷纲摘要',
            pack.outline.slice(0, 2600),
          ].join('\n'),
        },
        { role: 'user', content: `请生成第 ${startChapter}-${endChapter} 章章节锚点。` },
      ],
      signal,
    );
  }

  /**
   * StoryForge 风格「计划采纳」：
   * 把计划模式产出的创作规则、分章大纲写入项目资料，并合并进当前设定包，
   * 使后续逐章写作优先执行用户确认过的章纲（而非再盲生成）。
   */
  private async adoptPlanMaterials(
    projectId: Id,
    pack: GeneratedPack,
    plan: NovelPlanSummary,
    totalChapters: number,
    wordsPerChapter: number,
    artifacts: AgentArtifact[],
    steps: string[],
  ): Promise<GeneratedPack> {
    let next = pack;
    const rulesText = formatPlanCreationRules(plan);
    if (rulesText) {
      const rules = await this.upsertWorldSettingByTitle(
        projectId,
        '创作规则（计划采纳）',
        rulesText,
      );
      artifacts.push({ kind: 'world', id: rules.id, title: rules.title });
      next = {
        ...next,
        world: `${next.world.trim()}\n\n${rulesText}`,
      };
      steps.push('已采纳并保存创作规则。');
    }

    if (plan.storyPlan) {
      const storyPlanText = JSON.stringify(plan.storyPlan, null, 2);
      const savedStoryPlan = await this.upsertWorldSettingByTitle(
        projectId,
        'Story Plan（计划锁定）',
        storyPlanText,
      );
      artifacts.push({
        kind: 'world',
        id: savedStoryPlan.id,
        title: savedStoryPlan.title,
      });
      steps.push('已保存结构化 Story Plan，供后续 Agent 共用。');
    }

    const outlines = plan.chapterOutlines ?? [];
    if (outlines.length > 0) {
      const controlOutline = buildControlOutlineFromPlan(outlines, totalChapters, wordsPerChapter);
      const saved = await this.upsertPlanOutline(
        projectId,
        `${plan.title?.trim() || next.title}：分章大纲（计划采纳）`,
        controlOutline,
      );
      artifacts.push({ kind: 'outline', id: saved.id, title: saved.title });
      next = {
        ...next,
        outline: `${next.outline.trim()}\n\n${controlOutline}`,
      };
      steps.push(`已采纳分章大纲（${outlines.length} 章锚点）。`);
    } else {
      steps.push('计划中无分章大纲，将继续生成总控锚点。');
    }

    return next;
  }

  private async upsertWorldSettingByTitle(
    projectId: Id,
    title: string,
    content: string,
  ) {
    const matches = (await this.store.listWorldSettings(projectId)).filter(
      (item) => item.title === title,
    );
    const keeper = matches[0];
    const saved = keeper
      ? await this.store.updateWorldSetting(keeper.id, { title, content })
      : await this.store.createWorldSetting(projectId, title, content);
    for (const duplicate of matches.slice(1)) {
      await this.store.deleteWorldSetting(duplicate.id);
    }
    return saved;
  }

  private async upsertOutlineByTitle(projectId: Id, title: string, content: string) {
    const matches = (await this.store.listOutlines(projectId)).filter(
      (item) => item.title === title,
    );
    const keeper = matches[0];
    const saved = keeper
      ? await this.store.updateOutline(keeper.id, { title, content })
      : await this.store.createOutline(projectId, title, content);
    for (const duplicate of matches.slice(1)) {
      await this.store.deleteOutline(duplicate.id);
    }
    return saved;
  }

  private async upsertPlanOutline(projectId: Id, title: string, content: string) {
    const matches = (await this.store.listOutlines(projectId)).filter((item) =>
      item.title.endsWith('：分章大纲（计划采纳）'),
    );
    const keeper = matches[0];
    const saved = keeper
      ? await this.store.updateOutline(keeper.id, { title, content })
      : await this.store.createOutline(projectId, title, content);
    for (const duplicate of matches.slice(1)) {
      await this.store.deleteOutline(duplicate.id);
    }
    return saved;
  }

  private async upsertCharacterByName(projectId: Id, name: string, description: string) {
    const matches = (await this.store.listCharacters(projectId)).filter(
      (item) => item.name === name,
    );
    const keeper = matches[0];
    const saved = keeper
      ? await this.store.updateCharacter(keeper.id, { name, description })
      : await this.store.createCharacter(projectId, name, description);
    for (const duplicate of matches.slice(1)) {
      await this.store.deleteCharacter(duplicate.id);
    }
    return saved;
  }

  private async persistGeneratedCharacters(
    projectId: Id,
    markdown: string,
    artifacts: AgentArtifact[],
  ): Promise<void> {
    const profiles = parseCharacterProfiles(markdown);
    if (profiles.length === 0) {
      const character = await this.upsertCharacterByName(
        projectId,
        '人物与口吻护栏',
        markdown,
      );
      artifacts.push({ kind: 'character', id: character.id, title: character.name });
    } else {
      for (const profile of profiles) {
        const character = await this.upsertCharacterByName(
          projectId,
          profile.name,
          profile.description,
        );
        artifacts.push({ kind: 'character', id: character.id, title: character.name });
      }
    }
    const outfitPlan = extractChapterOutfitPlan(markdown);
    if (outfitPlan) {
      const saved = await this.upsertOutlineByTitle(projectId, '分章人物服装表', outfitPlan);
      artifacts.push({ kind: 'outline', id: saved.id, title: saved.title });
    }
  }

  private async promoteLegacyCharacterRecords(
    projectId: Id,
    markdown: string,
    protagonist: string | undefined,
    artifacts: AgentArtifact[],
  ): Promise<void> {
    const characters = await this.store.listCharacters(projectId);
    const legacy = characters.find((item) => item.name === '人物与口吻护栏');
    if (!legacy) return;
    const profiles = parseCharacterProfiles(markdown);
    if (profiles.length > 0) {
      for (const profile of profiles) {
        const saved = await this.upsertCharacterByName(
          projectId,
          profile.name,
          profile.description,
        );
        artifacts.push({ kind: 'character', id: saved.id, title: saved.name });
      }
      await this.store.deleteCharacter(legacy.id);
      return;
    }
    const name = protagonist?.trim();
    if (!name || characters.some((item) => item.name === name)) return;
    const saved = await this.store.updateCharacter(legacy.id, {
      name,
      description: markdown,
    });
    artifacts.push({ kind: 'character', id: saved.id, title: saved.name });
  }

  private async ensureChapterOutfitPlan(
    projectId: Id,
    pack: GeneratedPack,
    artifacts: AgentArtifact[],
  ): Promise<GeneratedPack> {
    const embedded = extractChapterOutfitPlan(pack.characters);
    const existing = (await this.store.listOutlines(projectId)).find(
      (outline) => outline.title === '分章人物服装表',
    );
    const outfitPlan = embedded ?? existing?.content.trim();
    // 普通服装不属于大 Bug 硬状态。只复用用户或设定包已有的表，不再额外调用模型补全全书。
    if (!outfitPlan) return pack;
    const saved = await this.upsertOutlineByTitle(projectId, '分章人物服装表', outfitPlan);
    if (!artifacts.some((artifact) => artifact.kind === 'outline' && artifact.id === saved.id)) {
      artifacts.push({ kind: 'outline', id: saved.id, title: saved.title });
    }
    return pack.characters.includes(outfitPlan)
      ? pack
      : { ...pack, characters: `${pack.characters.trim()}\n\n${outfitPlan}` };
  }

  private async loadExistingPack(
    projectId: Id,
    prompt: string,
    artifacts: AgentArtifact[],
  ): Promise<GeneratedPack | undefined> {
    const [worlds, characters, outlines] = await Promise.all([
      this.store.listWorldSettings(projectId),
      this.store.listCharacters(projectId),
      this.store.listOutlines(projectId),
    ]);
    // 创作规则可能作为 world 条目；优先取非「创作规则」的世界观
    const world =
      [...worlds].reverse().find((w) => !w.title.includes('创作规则')) ?? worlds.at(-1);
    const characterText = characters
      .map((character) =>
        character.name === '人物与口吻护栏'
          ? character.description.trim()
          : `## 人物：${character.name}\n${character.description.trim()}`,
      )
      .join('\n\n');
    const outfitPlan = outlines.find((outline) => outline.title === '分章人物服装表');
    // 排除伏笔台账 / 诊断报告等非叙事大纲，再合并长篇控制大纲
    const storyOutlines = outlines.filter((o) => !isMetaOutlineTitle(o.title));
    if (!world || characterText.length === 0 || storyOutlines.length === 0) return undefined;

    const primary =
      storyOutlines.find((o) => o.title.includes('大纲') && !o.title.includes('控制')) ??
      storyOutlines[0]!;
    const control = [...storyOutlines]
      .reverse()
      .find((o) => o.title.includes('控制大纲') || o.title.includes('分章大纲'));
    const outlineBody =
      control && control.id !== primary.id
        ? `${primary.content.trim()}\n\n${control.content.trim()}`
        : primary.content;

    artifacts.push({ kind: 'world', id: world.id, title: world.title });
    for (const character of characters) {
      artifacts.push({ kind: 'character', id: character.id, title: character.name });
    }
    artifacts.push({ kind: 'outline', id: primary.id, title: primary.title });
    if (control && control.id !== primary.id) {
      artifacts.push({ kind: 'outline', id: control.id, title: control.title });
    }
    return {
      title: inferProjectName(prompt),
      world: withHeading('世界与规则', world.content),
      characters: [
        withHeading('人物与口吻护栏', characterText),
        outfitPlan?.content.trim() ?? '',
      ].filter(Boolean).join('\n\n'),
      outline: withHeading('第一卷大纲', outlineBody),
    };
  }

  /**
   * 统一初始记忆播种：新建/空项目写 pack（+可选 plan）；续写仅在有 plan 时补计划约束。
   * 调用方根据返回值自行拼装进度文案，保持 long/full 任务 UX 独立。
   */
  private async seedProjectMemory(
    projectId: Id,
    pack: GeneratedPack,
    planSummary: NovelPlanSummary | undefined,
    opts: { seedPack: boolean },
  ): Promise<{ seededPack: boolean; seededPlan: boolean }> {
    let seededPack = false;
    let seededPlan = false;
    if (opts.seedPack) {
      await this.seedMemoryFromPack(projectId, pack);
      seededPack = true;
      if (planSummary) {
        await this.seedMemoryFromPlan(projectId, planSummary);
        seededPlan = true;
      }
    } else if (planSummary) {
      await this.seedMemoryFromPlan(projectId, planSummary);
      seededPlan = true;
    }
    return { seededPack, seededPlan };
  }

  /**
   * 章节草稿后的共享后处理：审校 →（可选）修订 → 再检 → 应用结论 → 反思一次。
   * 不在修订前 reflect，避免草稿污染记忆；质量 Gate 仅在 qualityGates 提供时启用。
   */
  private async processChapterDraft(
    config: ModelConfig,
    projectId: Id,
    pack: GeneratedPack,
    chapterNumber: number,
    chapterId: Id,
    chapterTitle: string,
    seedPrompt: string,
    content: string,
    targetWords: number,
    totalChapters: number,
    signal: AbortSignal,
    emit: (event: AgentProgressEvent) => void,
    options: {
      autoRevisionEnabled: boolean;
      /** false 时仅使用本地 Gate；每批首章和检查点仍会执行模型一致性审校。 */
      inspectChapter?: boolean;
      /** 提供时走 long_novel Gate；null/undefined 走 full_novel（仅 recommendRevision+hints 修订）。 */
      qualityGates?: { minWords: number; maxWords: number; targetWords: number } | null;
      labels?: {
        inspect?: (title: string) => string;
        revise?: (title: string) => string;
        reflect?: (title: string) => string;
      };
      progress?: { current?: number; total?: number };
    },
  ): Promise<{
    finalContent: string;
    finalInspection: InspectorReport;
    gates?: GateResult;
    revised: boolean;
  }> {
    const progress = options.progress;
    const labels = options.labels;

    // 先只做审校，不反思：避免修订前草稿污染记忆/伏笔
    let inspection: InspectorReport;
    if (options.inspectChapter === false) {
      inspection = {
        score0to100: 100,
        verdict: 'local_gate_pass',
        plotCoherence: '本章通过本地质量 Gate；模型一致性审校留待批次检查点执行。',
        fatalIssues: [],
        earlyCharacterStatus: [],
        recommendRevision: false,
        revisionHints: [],
        structuralChecks: [],
        injectedMemoryChars: 0,
        injectedMemoryOptions: scaledMemoryOptions(chapterNumber),
      };
    } else {
      emit({
        phase: 'inspect',
        message: labels?.inspect?.(chapterTitle) ?? `审校「${chapterTitle}」…`,
        current: progress?.current,
        total: progress?.total,
      });
      try {
        inspection = await this.inspectChapterDraft(
          config,
          projectId,
          chapterNumber,
          chapterTitle,
          content,
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        // Review is an auxiliary worker.  A provider 502/timeout must not erase
        // a valid chapter or abort the whole novel; the next run can inspect it.
        emit({
          phase: 'info',
          message: `【ContinuityAgent】审校请求失败，已保留「${chapterTitle}」正文并继续。`,
          current: progress?.current,
          total: progress?.total,
        });
        inspection = {
          score0to100: 70,
          verdict: 'inspection_unavailable',
          plotCoherence: '审校服务暂不可用，正文已保存。',
          fatalIssues: [],
          earlyCharacterStatus: [],
          recommendRevision: false,
          revisionHints: [],
          structuralChecks: [],
          injectedMemoryChars: 0,
          injectedMemoryOptions: scaledMemoryOptions(chapterNumber),
        };
      }
    }

    let gates: GateResult | undefined;
    if (options.qualityGates) {
      gates = runChapterQualityGates({
        content,
        minWords: options.qualityGates.minWords,
        maxWords: options.qualityGates.maxWords,
        targetWords: options.qualityGates.targetWords,
        chapterTitle,
        inspectorScore: inspection.score0to100,
        recommendRevision: inspection.recommendRevision,
        revisionHints: inspection.revisionHints,
        fatalIssues: inspection.fatalIssues,
      });
    } else {
      const semanticGates = runChapterQualityGates({
        content,
        minWords: 1,
        maxWords: Number.MAX_SAFE_INTEGER,
        targetWords: Math.max(1, targetWords),
        chapterTitle,
        inspectorScore: inspection.score0to100,
        recommendRevision: inspection.recommendRevision,
        revisionHints: inspection.revisionHints,
        fatalIssues: inspection.fatalIssues,
      });
      if (semanticGates.hardFail) gates = semanticGates;
    }

    let finalContent = content;
    let finalInspection = inspection;
    let revised = false;

    let shouldRevise = false;
    let hints: string[] = [];
    if (options.qualityGates) {
      shouldRevise = shouldAutoReviseChapter({
        enabled: options.autoRevisionEnabled,
        inspectorScore: inspection.score0to100,
        recommendRevision: inspection.recommendRevision,
        revisionHints: inspection.revisionHints,
        fatalIssues: inspection.fatalIssues,
        findings: gates?.findings ?? [],
      });
      if (shouldRevise) {
        hints = [
          ...inspection.revisionHints,
          ...(gates?.findings.filter((f) => f.severity !== 'pass').map((f) => f.message) ?? []),
        ].slice(0, 8);
        shouldRevise = hints.length > 0;
      }
    } else if (
      options.autoRevisionEnabled &&
      inspection.recommendRevision &&
      inspection.revisionHints.length > 0
    ) {
      shouldRevise = true;
      hints = inspection.revisionHints;
    }

    if (shouldRevise) {
      emit({
        phase: 'chapter',
        message: labels?.revise?.(chapterTitle) ?? `修订「${chapterTitle}」…`,
        current: progress?.current,
        total: progress?.total,
      });
      let revisedContent: string | undefined;
      try {
        revisedContent = await this.reviseChapterWithHints(
          config,
          projectId,
          pack,
          chapterNumber,
          totalChapters,
          seedPrompt,
          targetWords,
          finalContent,
          hints,
          signal,
          options.qualityGates ?? undefined,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        emit({
          phase: 'info',
          message: `【ReviewAgent】修订请求失败，已保留「${chapterTitle}」原稿并继续。`,
          current: progress?.current,
          total: progress?.total,
        });
      }
      if (
        revisedContent !== undefined &&
        revisedContent.trim().length > 0 &&
        (!options.qualityGates ||
          revisionDoesNotWorsenWordRange(finalContent, revisedContent, options.qualityGates))
      ) {
        finalContent = revisedContent;
        await this.store.updateChapterContent(chapterId, finalContent);
        revised = true;
        // 修订后重检失败不撤销已保存的修订稿，继续使用首次审校结论。
        try {
          finalInspection = await this.inspectChapterDraft(
            config,
            projectId,
            chapterNumber,
            chapterTitle,
            finalContent,
            signal,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          emit({
            phase: 'info',
            message: `【ContinuityAgent】复检请求失败，已保留「${chapterTitle}」修订稿并继续。`,
            current: progress?.current,
            total: progress?.total,
          });
        }
        if (options.qualityGates) {
          gates = runChapterQualityGates({
            content: finalContent,
            minWords: options.qualityGates.minWords,
            maxWords: options.qualityGates.maxWords,
            targetWords: options.qualityGates.targetWords,
            chapterTitle,
            inspectorScore: finalInspection.score0to100,
            recommendRevision: finalInspection.recommendRevision,
            revisionHints: finalInspection.revisionHints,
            fatalIssues: finalInspection.fatalIssues,
          });
        } else {
          const semanticGates = runChapterQualityGates({
            content: finalContent,
            minWords: 1,
            maxWords: Number.MAX_SAFE_INTEGER,
            targetWords: Math.max(1, targetWords),
            chapterTitle,
            inspectorScore: finalInspection.score0to100,
            recommendRevision: finalInspection.recommendRevision,
            revisionHints: finalInspection.revisionHints,
            fatalIssues: finalInspection.fatalIssues,
          });
          gates = semanticGates.hardFail ? semanticGates : undefined;
        }
      } else if (revisedContent !== undefined && revisedContent.trim().length > 0) {
        emit({
          phase: 'info',
          message: `【ReviewAgent】修订「${chapterTitle}」后字数偏差更大，已保留更接近计划的原稿。`,
          current: progress?.current,
          total: progress?.total,
        });
      } else if (revisedContent !== undefined) {
        emit({
          phase: 'info',
          message: `【ReviewAgent】修订「${chapterTitle}」返回空正文，已保留原稿。`,
          current: progress?.current,
          total: progress?.total,
        });
      }
    }

    // 只让通过现有硬门的终稿进入状态提取，避免已知坏稿污染后续记忆。
    let criticalStateIssues: CriticalStateIssue[] = [];
    if (!gates?.hardFail) {
      if (labels?.reflect) {
        emit({
          phase: 'inspect',
          message: labels.reflect(chapterTitle),
          current: progress?.current,
          total: progress?.total,
        });
      }
      criticalStateIssues = await this.reflectAndRemember(
        config,
        projectId,
        chapterId,
        chapterTitle,
        finalContent,
        signal,
      );
    }
    if (criticalStateIssues.length > 0) {
      const stateFindings: GateFinding[] = criticalStateIssues.map((issue) => ({
        gate: 'continuity',
        severity: 'hard',
        message: `${issue.code}：${issue.message}`,
        autoFixable: true,
      }));
      gates = {
        ok: false,
        hardFail: true,
        findings: [...(gates?.findings ?? []), ...stateFindings],
      };
      finalInspection = {
        ...finalInspection,
        fatalIssues: [
          ...finalInspection.fatalIssues,
          ...criticalStateIssues.map((issue) => issue.message),
        ],
        recommendRevision: true,
        revisionHints: [
          ...finalInspection.revisionHints,
          ...criticalStateIssues.map((issue) => `修复：${issue.message}`),
        ].slice(0, 8),
      };
    }
    if (!gates?.hardFail) {
      await this.applyInspectorFindings(projectId, finalInspection);
      await this.memory.markChapterCommitted(projectId, chapterId);
    } else {
      await this.memory.markChapterRejected(projectId, chapterId);
      await this.memory.recordWorkflow(projectId, {
        task: 'big_bug_guard',
        summary: `「${chapterTitle}」存在 P0 大 Bug，未写入章节摘要、关键状态或伏笔台账。`,
      });
    }

    return { finalContent, finalInspection, gates, revised };
  }

  /** 从设定包抽取初始故事事实写入记忆（无需额外模型调用）。 */
  private async seedMemoryFromPack(projectId: Id, pack: GeneratedPack): Promise<void> {
    const trim = (text: string, n: number): string =>
      text.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, n);
    const facts: Array<{ kind: 'character' | 'world' | 'plot'; text: string }> = [];
    const world = trim(pack.world, 600);
    const characters = trim(pack.characters, 600);
    const outline = trim(pack.outline, 600);
    if (world.length > 0) facts.push({ kind: 'world', text: `世界观：${world}` });
    if (characters.length > 0) facts.push({ kind: 'character', text: `人物护栏：${characters}` });
    if (outline.length > 0) facts.push({ kind: 'plot', text: `主线大纲：${outline}` });
    if (facts.length > 0) await this.memory.recordFacts(projectId, facts);
  }

  /** 把计划摘要中的硬约束写入长期记忆（StoryForge 伏笔/设定级事实）。 */
  private async seedMemoryFromPlan(projectId: Id, plan: NovelPlanSummary): Promise<void> {
    const facts: Array<{ kind: 'character' | 'world' | 'plot'; text: string }> = [];
    const story = plan.storyPlan;
    if (plan.protagonist?.trim()) {
      facts.push({ kind: 'character', text: `主角设定：${plan.protagonist.trim()}` });
    }
    if (plan.genre?.trim()) {
      facts.push({ kind: 'world', text: `题材赛道：${plan.genre.trim()}` });
    }
    if (plan.tone?.trim()) {
      facts.push({ kind: 'world', text: `叙事基调：${plan.tone.trim()}` });
    }
    if (plan.hook?.trim()) {
      facts.push({ kind: 'plot', text: `核心钩子：${plan.hook.trim()}` });
    }
    if (plan.title?.trim()) {
      facts.push({ kind: 'plot', text: `书名向：${plan.title.trim()}` });
    }
    for (const c of plan.constraints ?? []) {
      const text = c.trim();
      if (text.length > 0) {
        facts.push({ kind: 'plot', text: `创作约束：${text}` });
      }
    }
    for (const ch of (plan.chapterOutlines ?? []).slice(0, 12)) {
      facts.push({
        kind: 'plot',
        text: `第${ch.number}章计划：${ch.title} — ${ch.goal}`.slice(0, 280),
      });
    }
    if (story?.world.overview.trim()) {
      facts.push({ kind: 'world', text: `Story Plan 世界：${story.world.overview.trim()}` });
    }
    for (const rule of story?.powerSystem.rules.slice(0, 6) ?? []) {
      facts.push({ kind: 'world', text: `力量规则：${rule}` });
    }
    for (const character of story?.characters.slice(0, 12) ?? []) {
      facts.push({
        kind: 'character',
        text: `${character.name}（${character.role}）：${[
          character.identity,
          character.goal,
          character.arc,
        ]
          .filter(Boolean)
          .join('；')}`.slice(0, 300),
      });
    }
    if (story) {
      facts.push({
        kind: 'plot',
        text: `主线四段：开端=${story.mainPlot.beginning}；发展=${story.mainPlot.development}；高潮=${story.mainPlot.climax}；结局=${story.mainPlot.ending}`.slice(0, 600),
      });
    }
    if (facts.length > 0) await this.memory.recordFacts(projectId, facts);

    // 核心钩子与章纲悬念预埋进伏笔台账，后续写作会回灌提醒
    const plants: Array<{
      title: string;
      detail: string;
      urgency: 'low' | 'medium' | 'high';
      suggestPayoffBy?: string;
    }> = [];
    if (plan.hook?.trim()) {
      plants.push({
        title: '核心钩子',
        detail: plan.hook.trim(),
        urgency: 'high',
        suggestPayoffBy: '全书高潮前必须兑现',
      });
    }
    for (const [index, detail] of (story?.foreshadowing ?? []).slice(0, 8).entries()) {
      plants.push({
        title: `Story Plan 伏笔 ${index + 1}`,
        detail: detail.slice(0, 240),
        urgency: 'medium',
        suggestPayoffBy: '按 Story Plan 的章节因果链兑现',
      });
    }
    for (const ch of (plan.chapterOutlines ?? []).slice(0, 8)) {
      const goal = ch.goal.trim();
      if (goal.length < 8) continue;
      // 仅把明显带悬念词的目标预埋，避免台账过噪
      if (/悬念|伏笔|秘密|真相|身份|失踪|背叛|预言|未知|谜|意外|隐藏/.test(goal)) {
        plants.push({
          title: `第${ch.number}章伏笔：${ch.title}`.slice(0, 40),
          detail: goal.slice(0, 200),
          urgency: 'medium',
          suggestPayoffBy: `第${Math.min((plan.chapterCount ?? ch.number) || ch.number, ch.number + 5)}章前后`,
        });
      }
    }
    if (plants.length > 0) {
      await this.memory.plantForeshadows(projectId, plants);
      await this.syncForeshadowLedgerOutline(projectId);
    }
  }

  /**
   * Reuse an incomplete chapter that already has a blueprint/checkpoint.  A
   * long run must not create a second "第 N 章" after a provider timeout: the
   * first chapter owns the scene drafts that make the run resumable.
   */
  private async getOrCreateLongNovelChapter(projectId: Id, title: string) {
    const chapters = await this.store.listChapters(projectId);
    for (const chapter of chapters) {
      if (chapter.title !== title) continue;
      if (this.memory.isChapterRejected(projectId, chapter.id)) return chapter;
      if (chapter.content.trim().length > 0) continue;
      const [blueprint, drafts] = await Promise.all([
        this.store.getChapterBlueprintByChapter(chapter.id),
        this.store.listSceneDrafts(chapter.id),
      ]);
      if (blueprint || drafts.some((draft) => draft.content.trim().length > 0)) {
        return chapter;
      }
    }
    return this.store.createChapter(projectId, title);
  }

  /** Delete a blank shell only when it owns no resumable scene work. */
  private async discardEmptyChapterUnlessCheckpoint(chapterId: Id): Promise<void> {
    const [blueprint, drafts] = await Promise.all([
      this.store.getChapterBlueprintByChapter(chapterId),
      this.store.listSceneDrafts(chapterId),
    ]);
    if (!blueprint && !drafts.some((draft) => draft.content.trim().length > 0)) {
      await this.store.deleteChapter(chapterId);
    }
  }

  /**
   * Remove only truly empty shells.  A shell with a blueprint or a non-empty
   * scene draft is a durable checkpoint and must survive the next run.
   */
  private async purgeEmptyChapterShells(projectId: Id): Promise<void> {
    const chapters = await this.store.listChapters(projectId);
    for (const chapter of chapters) {
      if (chapter.content.trim().length > 0) continue;
      const [blueprint, drafts] = await Promise.all([
        this.store.getChapterBlueprintByChapter(chapter.id),
        this.store.listSceneDrafts(chapter.id),
      ]);
      if (!blueprint && !drafts.some((draft) => draft.content.trim().length > 0)) {
        await this.store.deleteChapter(chapter.id);
      }
    }
  }

  private async inspectChapterDraft(
    config: ModelConfig,
    projectId: Id,
    chapterNumber: number,
    chapterTitle: string,
    content: string,
    signal: AbortSignal,
  ): Promise<InspectorReport> {
    const chapters = await this.store.listChapters(projectId);
    const memoryOptions = scaledMemoryOptions(chapterNumber);
    const injectedMemory = this.memory.buildContext(projectId, memoryOptions);
    const early = chapters.slice(0, 3);
    const recent = chapters.slice(-3);
    return this.inspector.inspectChapter(
      config,
      {
        projectId,
        atChapter: chapterNumber,
        chapterTitle,
        chapterContent: content,
        earlyChapterSamples: early.map((ch) => ({
          title: ch.title,
          excerpt: ch.content.replace(/\s+/g, ' ').slice(0, 600),
        })),
        recentChapterSamples: recent.map((ch) => ({
          title: ch.title,
          excerpt: ch.content.replace(/\s+/g, ' ').slice(0, 600),
        })),
        injectedMemory,
        injectedMemoryOptions: memoryOptions,
      },
      signal,
    );
  }

  private async applyInspectorFindings(projectId: Id, report: InspectorReport): Promise<void> {
    const facts = report.fatalIssues
      .slice(0, 6)
      .map((issue) => ({ kind: 'plot' as const, text: `检测子 Agent：${issue}` }));
    if (facts.length > 0) await this.memory.recordFacts(projectId, facts);
    if (report.recommendRevision && report.revisionHints.length > 0) {
      await this.memory.recordLearning(
        projectId,
        `检测子 Agent 修订建议：${report.revisionHints.slice(0, 3).join('；')}`,
      );
    }
    await this.memory.recordWorkflow(projectId, {
      task: 'continuity_inspector',
      summary: `检测子 Agent 评分 ${report.score0to100}：${report.verdict}`,
    });
  }

  private async reviseChapterWithHints(
    config: ModelConfig,
    projectId: Id,
    pack: GeneratedPack,
    chapterNumber: number,
    _totalChapters: number,
    seedPrompt: string,
    targetWords: number,
    original: string,
    hints: string[],
    signal: AbortSignal,
    wordRange?: { minWords: number; maxWords: number },
  ): Promise<string> {
    const memoryContext = this.memory.buildContext(projectId, scaledMemoryOptions(chapterNumber));
    const memoryBlock = memoryContext.length > 0 ? `\n\n${memoryContext}` : '';
    const rangeRequirement = wordRange
      ? `修订后的正文必须控制在 ${wordRange.minWords}-${wordRange.maxWords} 字；字数按去除空格和换行后的字符数计算，达到范围后立即收束，不得扩写超限。`
      : `修订后的正文保持约 ${targetWords} 字。`;
    return this.generateText(
      config,
      [
        {
          role: 'system',
          content: [
            `你是长篇小说「写作子 Agent」，正在修订《${pack.title}》第 ${chapterNumber} 章。`,
            '检测子 Agent 已发现连贯性问题，你必须按修订建议改稿，保持人设与世界观一致。',
            rangeRequirement,
            '只输出修订后的本章正文，不要解释。',
            pack.world.slice(0, 1200),
            pack.characters.slice(0, 1200),
            memoryBlock,
            '',
            '修订建议：',
            ...hints.map((h) => `- ${h}`),
          ].join('\n'),
        },
        {
          role: 'user',
          content: `原稿：\n${original.slice(0, 6000)}\n\n请在不新增支线的前提下输出修订后的第 ${chapterNumber} 章全文。${rangeRequirement}\n题材：${seedPrompt}`,
        },
      ],
      signal,
      {
        disableThinking: true,
        maxTokens: wordRange
          ? tokenBudgetForCharacterTarget(wordRange.maxWords, original)
          : Math.min(8192, Math.max(2048, targetWords * 2 + 1024)),
      },
    );
  }

  /**
   * 反思子 Agent（自我进化核心）：读章节正文，产出
   * { summary, facts[], stateUpdates[], learning, foreshadows[] } 并写入长期记忆。
   * 模型未按 JSON 返回时降级：用正文截断作摘要，保证记忆始终被更新、流程不中断。
   */
  private async reflectAndRemember(
    config: ModelConfig,
    projectId: Id,
    chapterId: Id,
    chapterTitle: string,
    content: string,
    signal: AbortSignal,
  ): Promise<CriticalStateIssue[]> {
    const text = content.trim();
    if (text.length === 0) return [];

    const fallbackSummary = text.replace(/\s+/g, ' ').slice(0, 200);
    let summary = fallbackSummary;
    let facts: Array<{ kind: 'character' | 'world' | 'plot'; text: string }> = [];
    let stateUpdates: ParsedCriticalStateUpdate[] = [];
    let learning = '';
    let foreshadowOps: ParsedForeshadowOp[] = [];

    const openLedger = this.memory.listOpenForeshadows(projectId);
    const openLedgerHint =
      openLedger.length === 0
        ? '（当前无未回收伏笔）'
        : openLedger
            .slice(0, 12)
            .map((f) => `- ${f.title}：${f.detail}`)
            .join('\n');
    const criticalStateHint =
      this.memory.formatCriticalStateLedger(projectId) || '（当前无关键状态）';
    const reflectionExcerpt =
      text.length <= 6000
        ? text
        : `${text.slice(0, 3000)}\n\n[中段省略]\n\n${text.slice(-3000)}`;

    try {
      const raw = await this.generateText(
        config,
        [
          {
            role: 'system',
            content: [
              '你是小说连贯性「反思子 Agent」。阅读给定章节正文，提炼可供后续章节复用的记忆与伏笔台账变更。',
              '只输出一个 JSON 对象，不要输出任何额外文字或代码块标记，结构：',
              '{"summary":"本章 100 字内剧情摘要","facts":[{"kind":"character|world|plot","text":"应保持一致的设定/状态，一句话"}],"stateUpdates":[{"kind":"alive_status|mobility_status|location|physical_state|ability_state|critical_knowledge|key_item|relationship_stage","entity":"人物名或唯一物品名","key":"current或能力/秘密/关系对象/holder","value":"规范值","evidence":"正文中明确发生的短证据"}],"learning":"一条可复用的写作风格经验","foreshadows":[{"action":"plant|echo|resolve","title":"短标题","detail":"一句话说明","urgency":"low|medium|high","suggestPayoffBy":"建议回收窗口可选"}]}',
              'facts 至多 5 条，聚焦人物状态变化、世界规则、关键剧情进展。',
              'stateUpdates 只记录本章结束时正文明确建立或改变、且会影响后文的状态；禁止脑补，最多 12 条。',
              '规范值：alive_status=alive|dead|missing；mobility_status=free|detained|unconscious|immobile；physical_state=healthy|injured|severely_injured；ability_state=available|unavailable|sealed|lost；critical_knowledge=known|unknown。',
              'key_item 的 entity 写唯一物品名、key 固定 holder、value 写章末持有人或 unheld/destroyed。普通衣服、饮食、短暂情绪不要记录。',
              'foreshadows 至多 4 条：',
              '- plant：本章新埋设的悬念/暗示/未解释物件或人物秘密；',
              '- echo：再次点到但未完全揭晓的旧伏笔（title 尽量对应下列未回收列表）；',
              '- resolve：本章明确回收/揭晓的旧伏笔。',
              '若本章无新伏笔也无呼应回收，foreshadows 可为 []。',
              '',
              '# 当前未回收伏笔',
              openLedgerHint,
              '',
              '# 当前关键状态账',
              criticalStateHint,
            ].join('\n'),
          },
          { role: 'user', content: `章节标题：${chapterTitle}\n\n正文：\n${reflectionExcerpt}` },
        ],
        signal,
        { jsonMode: true, disableThinking: true, maxTokens: 2048 },
      );
      const parsed = parseReflection(raw);
      if (parsed.summary.length > 0) summary = parsed.summary;
      facts = parsed.facts;
      stateUpdates = parsed.stateUpdates;
      learning = parsed.learning;
      foreshadowOps = parsed.foreshadows;
    } catch {
      // 反思失败：保留 fallback 摘要，记忆仍前进，不中断主流程。
    }

    // 反思模型偶尔会漏填 stateUpdates；用同一章现成文本做极保守的确定性兜底，
    // 不增加模型调用。模型已明确给出的同键状态优先，避免本地规则过度推断。
    const inferredStateUpdates = inferDeterministicCriticalStateUpdates({
      content: text,
      summary,
      facts,
      existingStates: this.memory.get(projectId).criticalStates,
    });
    const stateKey = (update: ParsedCriticalStateUpdate): string =>
      [update.kind, update.entity, update.key ?? 'current']
        .map((value) => value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN'))
        .join(':');
    const modelStateKeys = new Set(stateUpdates.map(stateKey));
    for (const update of inferredStateUpdates) {
      if (!modelStateKeys.has(stateKey(update))) stateUpdates.push(update);
    }

    const stateResult = await this.memory.applyCriticalStateUpdates(
      projectId,
      stateUpdates.map((update): CriticalStateUpdateInput => ({
        ...update,
        evidence: update.kind === 'key_item' && summary
          ? `${update.evidence}；本章摘要：${summary}`.slice(0, 400)
          : update.evidence,
        chapterId,
        chapterTitle,
      })),
    );
    if (stateResult.issues.length > 0) return stateResult.issues;

    await this.memory.appendChapterSummary(projectId, {
      chapterId,
      title: chapterTitle,
      summary,
    });
    if (facts.length > 0) await this.memory.recordFacts(projectId, facts);
    if (learning.length > 0) await this.memory.recordLearning(projectId, learning);

    // StoryForge 风格伏笔台账：埋设 / 呼应 / 回收
    const plants = foreshadowOps.filter((op) => op.action === 'plant');
    const touches = foreshadowOps.filter((op) => op.action === 'echo' || op.action === 'resolve');
    if (plants.length > 0) {
      await this.memory.plantForeshadows(
        projectId,
        plants.map((op) => ({
          title: op.title,
          detail: op.detail || op.title,
          urgency: op.urgency,
          suggestPayoffBy: op.suggestPayoffBy,
          plantedChapterId: chapterId,
          plantedChapterTitle: chapterTitle,
        })),
      );
    }
    if (touches.length > 0) {
      await this.memory.touchForeshadows(
        projectId,
        touches.map((op) => ({
          match: op.title || op.detail,
          note: op.detail,
          status: op.action === 'resolve' ? 'resolved' : 'echoed',
          chapterId,
          chapterTitle,
        })),
      );
    }
    await this.syncForeshadowLedgerOutline(projectId);
    return [];
  }

  /** 把伏笔台账同步到项目大纲资料，便于作者在 UI 侧边栏查看。 */
  private async syncForeshadowLedgerOutline(projectId: Id): Promise<void> {
    const content = this.memory.formatForeshadowLedger(projectId);
    const title = '伏笔台账';
    try {
      const outlines = await this.store.listOutlines(projectId);
      const existing = outlines.find((o) => o.title === title);
      if (existing) {
        await this.store.updateOutline(existing.id, { content });
      } else {
        await this.store.createOutline(projectId, title, content);
      }
    } catch {
      // 资料同步失败不阻断写作主流程。
    }
  }

  private async generatePack(
    config: ModelConfig,
    prompt: string,
    mode: AgentRunMode,
    variant: 'novel' | 'title',
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<GeneratedPack> {
    const title = inferProjectName(prompt);
    const modeHint = mode === 'draft' ? '直接成文前置控稿' : '参考方案';

    // Shared stable prefix for all 3 sub-agent calls — maximises DeepSeek prefix cache hits
    const sharedPrefix = [
      `你是一名小说策划子 Agent。模式：${modeHint}。`,
      `任务类型：${variant === 'title' ? '按书名/章节名扩展' : '一句话开书'}`,
      `用户需求：${prompt}`,
      '用户需求中明确出现的题材、时代、地域、文化和人物身份是最高优先级硬约束。',
      '不得以常见校园、都市、修仙或其他模板替换用户指定的核心类型。',
    ].join('\n');

    this.emitProgress(onProgress, {
      phase: 'setup',
      message: '子 Agent 正在写世界观（可能需数十秒）…',
      current: 2,
      total: 7,
    });
    const world = await this.generateText(
      config,
      [
        {
          role: 'system',
          content: sharedPrefix + '\n\n你负责「世界观策划」。只输出「世界与规则」Markdown 一节，不要输出人物或大纲。',
        },
        {
          role: 'user',
          content: '请开始生成世界观设定。',
        },
      ],
      signal,
    );

    this.emitProgress(onProgress, {
      phase: 'setup',
      message: '世界观完成，正在写人物护栏…',
      current: 3,
      total: 7,
    });
    const characters = await this.generateText(
      config,
      [
        {
          role: 'system',
          content: sharedPrefix + [
            '',
            '你负责「人物策划」。只输出人物设定 Markdown，严格使用以下结构：',
            '## 人物：姓名',
            '- 身份/年龄：',
            '- 外貌识别点：',
            '- 性格与说话方式：',
            '- 目标/动机/弱点：',
            '- 能力与限制：',
            '- 基础服装：款式、颜色、材质、鞋履、随身物；不得只写“校服”。',
            '每个具名主要角色各写一节，至少覆盖主角、主要同伴和主要对手。',
            '',
            '## 分章人物服装连续性表',
            '| 章节 | 人物 | 服装与配件 | 换装原因/连续性 |',
            '| --- | --- | --- | --- |',
            '按用户计划的全部章节逐章列出出场人物；连续场景注明“沿用上一章”，换装必须说明原因。',
            '',
            '已有世界观摘要：',
            world.slice(0, 800),
          ].join('\n'),
        },
        { role: 'user', content: '请开始生成人物设定。' },
      ],
      signal,
    );

    this.emitProgress(onProgress, {
      phase: 'setup',
      message: '人物完成，正在写第一卷大纲…',
      current: 4,
      total: 7,
    });
    const outline = await this.generateText(
      config,
      [
        {
          role: 'system',
          content: sharedPrefix + '\n\n你负责「大纲策划」。只输出「第一卷大纲」Markdown（6-10 章要点）。\n\n世界观：\n' + world.slice(0, 400) + '\n人物：\n' + characters.slice(0, 400),
        },
        { role: 'user', content: '请开始生成大纲。' },
      ],
      signal,
    );

    this.emitProgress(onProgress, {
      phase: 'setup',
      message: '设定包生成完毕。',
      current: 4,
      total: 7,
    });
    return {
      title,
      world: world.startsWith('#') ? world : `# 世界与规则\n\n${world}`,
      characters: characters.startsWith('#') ? characters : `# 人物与口吻护栏\n\n${characters}`,
      outline: outline.startsWith('#') ? outline : `# 第一卷大纲\n\n${outline}`,
    };
  }

  private async generateDraft(
    config: ModelConfig,
    prompt: string,
    pack: GeneratedPack,
    projectId: Id,
    signal: AbortSignal,
  ): Promise<string> {
    const chapters = await this.store.listChapters(projectId);
    const memoryContext = this.memory.buildContext(
      projectId,
      scaledMemoryOptions(chapters.length + 1),
    );
    const memoryBlock = memoryContext.length > 0 ? `\n\n${memoryContext}` : '';
    return this.generateText(
      config,
      [
        {
          role: 'system',
          content: [
            '你是正文写作子 Agent。直接输出第一章正文，不要输出总结或 Markdown 报告。',
            '',
            `控稿标题：${pack.title}`,
            '',
            pack.world,
            '',
            pack.characters,
            '',
            pack.outline,
            memoryBlock,
          ].join('\n'),
        },
        {
          role: 'user',
          content: `写作要求：完整第一章，具体场景、冲突、行动与结尾钩子。\n需求：${prompt}`,
        },
      ],
      signal,
    );
  }

  private async generateText(
    config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    options?: { jsonMode?: boolean; disableThinking?: boolean; maxTokens?: number },
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const delta of this.modelProxy.streamCompletion(config, messages, signal, options)) {
      if (delta.kind === 'content') {
        chunks.push(delta.text);
      }
    }
    return stripReasoningArtifacts(chunks.join(''));
  }

  /**
   * Delegate long-running / blueprint tasks to Python LangGraph (single truth engine).
   * Emits progress events for UX (real steps from result or synthetic).
   * Uses workspace inference for projectDir.
   */
  private async runPythonDelegated(
    task: AgentTask,
    prompt: string,
    projectId: Id | undefined,
    chapterId: Id | undefined,
    _options: { targetWords?: number; chapters?: number } | undefined,
    _signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    const emit = (phase: AgentProgressEvent['phase'], message: string, current?: number): void => {
      if (onProgress) {
        try { onProgress({ phase, message, current }); } catch { /* ignore */ }
      }
    };

    emit('setup', '正在调用 Python LangGraph Agent...');

    const effectiveChapter = chapterId || 'ch001';
    // Map to python task name
    const pyTask = task === 'plan_blueprint' ? 'plan_blueprint' : task === 'write_scene' ? 'write_scene' : 'write_chapter_from_blueprint';

    const bridgePayload = {
      task: pyTask,
      prompt,
      chapterId: effectiveChapter,
      // projectDir inferred inside bridge via workspace
    };

    emit('setup', `执行任务 ${pyTask} (章节 ${effectiveChapter})`);

    let pyRes: PythonBridgeResult;
    try {
      pyRes = await pythonBridge.call(bridgePayload);
    } catch (e: any) {
      throw ServiceError.validation(`Python agent 调用失败: ${e?.message || e}`);
    }

    if (!pyRes.ok) {
      throw ServiceError.validation('Python agent 返回失败');
    }

    // Map Python result to AgentRunResult (sync UI state later)
    const steps: string[] = [
      `已通过 Python LangGraph 执行 ${pyTask}`,
      pyRes.summary || '完成',
    ];
    if (pyRes.blueprint) {
      steps.push(`生成蓝图：${pyRes.blueprint.title}，共 ${pyRes.blueprint.scenes?.length || 0} 场景`);
    }
    if (pyRes.reports?.word_count) steps.push('已生成字数报告');
    if (pyRes.reports?.pacing) steps.push('已生成节奏报告');

    emit('reflect', 'Python 结果已返回，写入记忆与 UI 状态');

    const artifacts: AgentArtifact[] = projectId ? [{ kind: 'project', id: projectId, title: 'project' }] : [];
    if (chapterId) artifacts.push({ kind: 'chapter', id: chapterId, title: `ch ${chapterId}` });

    // If projectId missing, we still return; caller/UI handles.
    const pid = projectId || 'unknown';

    // Non-destructive note: Python currently writes to project files; Node may layer draft in future.
    return {
      task,
      mode: 'draft',
      projectId: pid,
      chapterId: chapterId || pyRes.chapterId,
      summary: pyRes.summary || `Python ${pyTask} 完成`,
      steps,
      artifacts,
      // include extra for clients aware of blueprint (not in strict type, but runtime ok)
    } as AgentRunResult;
  }
}

function emptyMetrics(plannedWords: number, completedChapters: number): AgentRunMetrics {
  return {
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheHitRatePct: 0,
    localCacheHits: 0,
    localCacheMisses: 0,
    localCacheHitRatePct: 0,
    plannedWords,
    completedChapters,
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function withHeading(title: string, content: string): string {
  const text = content.trim();
  if (text.startsWith('#')) return text;
  return `# ${title}\n\n${text}`;
}

function diffRunMetrics(before: CacheStatsSummary, after: CacheStatsSummary): AgentRunMetrics {
  const promptTokens = Math.max(0, after.promptTokens - before.promptTokens);
  const cacheHitTokens = Math.max(0, after.cacheHitTokens - before.cacheHitTokens);
  const localCacheHits = Math.max(0, after.localCache.hits - before.localCache.hits);
  const localCacheMisses = Math.max(0, after.localCache.misses - before.localCache.misses);
  const localLookups = localCacheHits + localCacheMisses;
  return {
    modelCalls: Math.max(0, after.calls - before.calls),
    promptTokens,
    completionTokens: Math.max(0, after.completionTokens - before.completionTokens),
    cacheHitTokens,
    cacheMissTokens: Math.max(0, after.cacheMissTokens - before.cacheMissTokens),
    cacheHitRatePct: promptTokens > 0 ? Math.round((cacheHitTokens / promptTokens) * 1000) / 10 : 0,
    localCacheHits,
    localCacheMisses,
    localCacheHitRatePct: localLookups > 0 ? Math.round((localCacheHits / localLookups) * 1000) / 10 : 0,
  };
}

function readPricePerMillion(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function estimateCostUsd(metrics: AgentRunMetrics): number | undefined {
  const missPromptPrice = readPricePerMillion('LLM_PROMPT_USD_PER_1M_TOKENS');
  const completionPrice = readPricePerMillion('LLM_COMPLETION_USD_PER_1M_TOKENS');
  if (missPromptPrice === undefined || completionPrice === undefined) return undefined;
  const hitPromptPrice = readPricePerMillion('LLM_CACHED_PROMPT_USD_PER_1M_TOKENS') ?? missPromptPrice;
  const promptCost =
    (metrics.cacheMissTokens * missPromptPrice + metrics.cacheHitTokens * hitPromptPrice) / 1_000_000;
  const completionCost = (metrics.completionTokens * completionPrice) / 1_000_000;
  return Math.round((promptCost + completionCost) * 1_000_000) / 1_000_000;
}

function inferProjectName(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  const chars = Array.from(compact);
  return chars.slice(0, 18).join('') || '未命名小说';
}

/** 侧边栏辅助资料（伏笔/报告/诊断/参考档案）不当作故事大纲加载。 */
function isMetaOutlineTitle(title: string): boolean {
  const t = title.trim();
  return (
    t === '伏笔台账' ||
    t.includes('诊断') ||
    t.includes('审阅') ||
    t.includes('报告') ||
    t.includes('润写建议') ||
    t.includes('拆梗') ||
    t.includes('避俗') ||
    t.includes('参考创作档案') ||
    t.includes('参考写作方法') ||
    t === '分章人物服装表'
  );
}

export interface ParsedCharacterProfile {
  name: string;
  description: string;
}

export function parseCharacterProfiles(markdown: string): ParsedCharacterProfile[] {
  const text = markdown.replace(/\r\n/g, '\n');
  const heading = /^##\s*(?:人物|角色|主角|配角|反派)\s*[:：]\s*(.+?)\s*$/gmu;
  const matches = [...text.matchAll(heading)];
  return matches.flatMap((match, index) => {
    const name = (match[1] ?? '').replace(/[*_`]/g, '').trim();
    if (!name || name.includes('服装连续性表')) return [];
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const raw = text.slice(start, end);
    const outfitHeading = raw.search(/^##\s*分章(?:人物)?服装/mu);
    const description = (outfitHeading >= 0 ? raw.slice(0, outfitHeading) : raw).trim();
    return description ? [{ name, description }] : [];
  });
}

export function extractChapterOutfitPlan(markdown: string): string | undefined {
  const text = markdown.replace(/\r\n/g, '\n');
  const match = /^##\s*分章(?:人物)?服装[^\n]*$/mu.exec(text);
  if (!match || match.index === undefined) return undefined;
  const start = match.index;
  const rest = text.slice(start + match[0].length);
  const nextHeading = /^##\s+/mu.exec(rest);
  const end = nextHeading?.index === undefined ? text.length : start + match[0].length + nextHeading.index;
  const section = text.slice(start, end).trim();
  return section.length > 0 ? section : undefined;
}

function normalizeControlOutlineChunk(raw: string, startChapter: number, endChapter: number, totalChapters: number): string {
  const text = raw.trim();
  const lines = text.length > 0 ? [text] : [];
  for (let chapter = startChapter; chapter <= endChapter; chapter += 1) {
    if (extractChapterOutline(text, chapter) !== undefined) continue;
    lines.push(fallbackChapterAnchor(chapter, totalChapters));
  }
  return lines.join('\n\n').trim();
}

function fallbackChapterAnchor(chapter: number, totalChapters: number): string {
  const phase =
    chapter === 1
      ? '开篇'
      : chapter >= totalChapters
        ? '收束'
        : chapter > Math.floor(totalChapters * 0.8)
          ? '高潮'
          : chapter > Math.floor(totalChapters * 0.45)
            ? '深化'
            : '发展';
  return [
    `### 第${chapter}章：第${chapter}章`,
    `本章锚点：${phase}阶段，承接前情推进主线，更新人物状态并保留后续伏笔。`,
  ].join('\n');
}

/** 把计划摘要拼进生成 prompt，设定包与正文共用同一份已确认意图。 */
function appendPlanContextToPrompt(prompt: string, plan: NovelPlanSummary | undefined): string {
  if (!plan) return prompt;
  const lines: string[] = ['# 已确认创作计划（必须严格遵守）'];
  if (plan.title?.trim()) lines.push(`- 书名向：${plan.title.trim()}`);
  if (plan.genre?.trim()) lines.push(`- 赛道：${plan.genre.trim()}`);
  if (plan.genres && plan.genres.length > 0) lines.push(`- 类型组合：${plan.genres.join(' + ')}`);
  if (plan.protagonist?.trim()) lines.push(`- 主角：${plan.protagonist.trim()}`);
  if (plan.hook?.trim()) lines.push(`- 钩子：${plan.hook.trim()}`);
  if (plan.tone?.trim()) lines.push(`- 基调：${plan.tone.trim()}`);
  if (plan.chapterCount) lines.push(`- 计划章数：${plan.chapterCount}`);
  if (plan.wordsPerChapter) lines.push(`- 每章字数：约 ${plan.wordsPerChapter}`);
  if (plan.totalWords) lines.push(`- 全书约：${plan.totalWords} 字`);
  if (plan.endingDirection?.trim()) lines.push(`- 结局方向：${plan.endingDirection.trim()}`);
  if (plan.writingRequirements?.trim()) lines.push(`- 额外要求：${plan.writingRequirements.trim()}`);
  if (plan.plannedThroughChapter && plan.chapterCount && plan.plannedThroughChapter < plan.chapterCount) {
    lines.push(`- 当前章节窗口：第 1-${plan.plannedThroughChapter} 章（全文 ${plan.chapterCount} 章，后续按阶段滚动展开）`);
  }
  if (plan.constraints && plan.constraints.length > 0) {
    lines.push(`- 约束：${plan.constraints.join('；')}`);
  }
  if (plan.chapterOutlines && plan.chapterOutlines.length > 0) {
    lines.push('', '## 分章大纲（写作时优先执行）');
    for (const ch of plan.chapterOutlines) {
      lines.push(
        `- 第${ch.number}章《${ch.title}》：${ch.goal}` +
          (ch.estimatedWords ? `（约${ch.estimatedWords}字）` : ''),
      );
    }
  }
  if (plan.storyPlan) {
    lines.push('', '## 结构化 Story Plan（所有下游 Agent 共用）');
    lines.push(JSON.stringify(plan.storyPlan, null, 2));
  }
  if (lines.length <= 1) return prompt;
  return `${prompt.trim()}\n\n${lines.join('\n')}`;
}

/** StoryForge 创作规则：风格、基调、禁忌、规模等可采纳结构。 */
function formatPlanCreationRules(plan: NovelPlanSummary): string | undefined {
  const lines: string[] = ['# 创作规则（计划采纳）', ''];
  if (plan.title?.trim()) lines.push(`- 书名向：${plan.title.trim()}`);
  if (plan.genre?.trim()) lines.push(`- 题材赛道：${plan.genre.trim()}`);
  if (plan.genres && plan.genres.length > 0) lines.push(`- 类型组合：${plan.genres.join(' + ')}`);
  if (plan.protagonist?.trim()) lines.push(`- 主角：${plan.protagonist.trim()}`);
  if (plan.hook?.trim()) lines.push(`- 核心钩子：${plan.hook.trim()}`);
  if (plan.tone?.trim()) lines.push(`- 叙事基调：${plan.tone.trim()}`);
  if (plan.endingDirection?.trim()) lines.push(`- 结局方向：${plan.endingDirection.trim()}`);
  if (plan.writingRequirements?.trim()) lines.push(`- 额外要求：${plan.writingRequirements.trim()}`);
  if (plan.chapterCount || plan.wordsPerChapter || plan.totalWords) {
    const parts = [
      plan.chapterCount ? `${plan.chapterCount} 章` : null,
      plan.wordsPerChapter ? `每章约 ${plan.wordsPerChapter} 字` : null,
      plan.totalWords ? `全书约 ${plan.totalWords.toLocaleString()} 字` : null,
    ].filter(Boolean);
    lines.push(`- 规模：${parts.join(' · ')}`);
  }
  if (plan.constraints && plan.constraints.length > 0) {
    lines.push('- 禁忌与一致性约束：');
    for (const c of plan.constraints) {
      if (c.trim()) lines.push(`  - ${c.trim()}`);
    }
  }
  if (plan.storyPlan) {
    lines.push('- Story Plan 已锁定：正文、人物、世界观、伏笔和分卷必须共同遵守。');
    lines.push('```json', JSON.stringify(plan.storyPlan, null, 2), '```');
  }
  lines.push('', '写作时必须遵守以上规则；不得偏离赛道、基调与已确认约束。');
  // 仅有标题行时视为空
  return lines.length > 3 ? lines.join('\n') : undefined;
}

/**
 * 将计划分章大纲格式化为 extractChapterOutline 可解析的控制大纲。
 * 缺失章节用 fallback 锚点补齐，避免 ensureFullNovelControlOutline 再调模型重做。
 */
export function buildControlOutlineFromPlan(
  outlines: NovelPlanChapterOutline[],
  totalChapters: number,
  wordsPerChapter: number,
): string {
  const byNum = indexPlanChapterOutlines(outlines);
  const sections: string[] = [];
  const end = Math.max(totalChapters, ...byNum.keys(), 0);
  for (let chapter = 1; chapter <= end; chapter += 1) {
    const o = byNum.get(chapter);
    if (o) {
      const wordsHint = o.estimatedWords
        ? `（约${o.estimatedWords}字）`
        : wordsPerChapter > 0
          ? `（约${wordsPerChapter}字）`
          : '';
      sections.push(
        [`### 第${chapter}章：${o.title.trim() || `第${chapter}章`}`, `本章锚点：${o.goal.trim()}${wordsHint}`].join(
          '\n',
        ),
      );
    } else {
      sections.push(fallbackChapterAnchor(chapter, totalChapters));
    }
  }
  return [
    '# 长篇章节控制大纲（计划采纳）',
    '',
    `总章数：${totalChapters}`,
    `每章目标：约 ${wordsPerChapter} 字`,
    '',
    sections.join('\n\n'),
  ].join('\n');
}

function indexPlanChapterOutlines(
  outlines: NovelPlanChapterOutline[] | undefined,
): Map<number, NovelPlanChapterOutline> {
  const map = new Map<number, NovelPlanChapterOutline>();
  for (const o of outlines ?? []) {
    if (Number.isInteger(o.number) && o.number > 0) {
      map.set(o.number, o);
    }
  }
  return map;
}

function parseChapterHeading(line: string): number | undefined {
  const text = line
    .replace(/^\s{0,3}#{1,6}\s*/, '')
    .replace(/^\s*[-*+]\s*/, '')
    .trim();
  const arabic = text.match(/(?:第\s*(\d{1,3})\s*[章节回]|chapter\s*(\d{1,3}))/i);
  const arabicValue = arabic?.[1] ?? arabic?.[2];
  if (arabicValue !== undefined) {
    const value = Number(arabicValue);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  const chinese = text.match(/第\s*([零〇一二两三四五六七八九十百]{1,8})\s*[章节回]/);
  if (!chinese?.[1]) return undefined;
  const value = chineseNumeralToNumber(chinese[1]);
  return value > 0 ? value : undefined;
}

function chineseNumeralToNumber(text: string): number {
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const units: Record<string, number> = { 十: 10, 百: 100 };
  let section = 0;
  let digit = 0;
  for (const char of text) {
    if (char in digits) {
      digit = digits[char] ?? 0;
      continue;
    }
    const unit = units[char];
    if (unit === undefined) continue;
    section += (digit || 1) * unit;
    digit = 0;
  }
  return section + digit;
}

interface ParsedForeshadowOp {
  action: 'plant' | 'echo' | 'resolve';
  title: string;
  detail: string;
  urgency: 'low' | 'medium' | 'high';
  suggestPayoffBy?: string;
}

interface ParsedCriticalStateUpdate {
  kind: CriticalStateUpdateInput['kind'];
  entity: string;
  key?: string;
  value: string;
  evidence: string;
}

interface ParsedReflection {
  summary: string;
  facts: Array<{ kind: 'character' | 'world' | 'plot'; text: string }>;
  stateUpdates: ParsedCriticalStateUpdate[];
  learning: string;
  foreshadows: ParsedForeshadowOp[];
}

/** 从反思子 Agent 的原始输出里稳健解析 JSON（容忍 ```json 包裹与前后噪声）。 */
export function parseReflection(raw: string): ParsedReflection {
  const empty: ParsedReflection = {
    summary: '',
    facts: [],
    stateUpdates: [],
    learning: '',
    foreshadows: [],
  };
  if (raw.trim().length === 0) return empty;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const learning = typeof obj.learning === 'string' ? obj.learning.trim() : '';
  const facts: ParsedReflection['facts'] = [];
  if (Array.isArray(obj.facts)) {
    for (const item of obj.facts.slice(0, 5)) {
      if (typeof item !== 'object' || item === null) continue;
      const f = item as Record<string, unknown>;
      const text = typeof f.text === 'string' ? f.text.trim() : '';
      if (text.length === 0) continue;
      const kind =
        f.kind === 'character' || f.kind === 'world' || f.kind === 'plot' ? f.kind : 'plot';
      facts.push({ kind, text });
    }
  }
  const stateUpdates: ParsedCriticalStateUpdate[] = [];
  const allowedStateKinds = new Set<ParsedCriticalStateUpdate['kind']>([
    'alive_status',
    'mobility_status',
    'location',
    'physical_state',
    'ability_state',
    'critical_knowledge',
    'key_item',
    'relationship_stage',
  ]);
  if (Array.isArray(obj.stateUpdates)) {
    for (const item of obj.stateUpdates.slice(0, 12)) {
      if (typeof item !== 'object' || item === null) continue;
      const state = item as Record<string, unknown>;
      if (!allowedStateKinds.has(state.kind as ParsedCriticalStateUpdate['kind'])) continue;
      const entity = typeof state.entity === 'string' ? state.entity.trim().slice(0, 80) : '';
      const key = typeof state.key === 'string' ? state.key.trim().slice(0, 160) : undefined;
      const value = typeof state.value === 'string' ? state.value.trim().slice(0, 120) : '';
      const evidence = typeof state.evidence === 'string' ? state.evidence.trim().slice(0, 400) : '';
      if (!entity || !value || !evidence) continue;
      stateUpdates.push({
        kind: state.kind as ParsedCriticalStateUpdate['kind'],
        entity,
        ...(key ? { key } : {}),
        value,
        evidence,
      });
    }
  }
  const foreshadows: ParsedForeshadowOp[] = [];
  if (Array.isArray(obj.foreshadows)) {
    for (const item of obj.foreshadows.slice(0, 4)) {
      if (typeof item !== 'object' || item === null) continue;
      const f = item as Record<string, unknown>;
      const action =
        f.action === 'plant' || f.action === 'echo' || f.action === 'resolve' ? f.action : null;
      if (!action) continue;
      const title = typeof f.title === 'string' ? f.title.trim() : '';
      const detail = typeof f.detail === 'string' ? f.detail.trim() : '';
      if (title.length === 0 && detail.length === 0) continue;
      const urgency =
        f.urgency === 'low' || f.urgency === 'medium' || f.urgency === 'high' ? f.urgency : 'medium';
      const suggestPayoffBy =
        typeof f.suggestPayoffBy === 'string' && f.suggestPayoffBy.trim().length > 0
          ? f.suggestPayoffBy.trim()
          : undefined;
      foreshadows.push({
        action,
        title: title || detail.slice(0, 24),
        detail: detail || title,
        urgency,
        suggestPayoffBy,
      });
    }
  }
  return { summary, facts, stateUpdates, learning, foreshadows };
}
