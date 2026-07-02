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
  ModelConfig,
} from '../../types/index.js';
import { getCacheStatsSummary, type CacheStatsSummary } from '../../proxy/cacheStats.js';
import { pythonBridge, type PythonBridgeResult } from '../../proxy/PythonBridge.js';
import type { BlueprintService } from '../blueprint/BlueprintService.js';
import type { ChapterWriter } from '../blueprint/ChapterWriter.js';
import { ServiceError } from '../ServiceError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import type { MemoryService } from '../memory/MemoryService.js';
import { scaledMemoryOptions } from '../memory/MemoryService.js';
import { MaterialResearchService } from '../research/MaterialResearchService.js';
import { stripReasoningArtifacts } from '../text/reasoningSanitizer.js';
import {
  ContinuityInspectorSubAgent,
  runReflectionAndInspectionParallel,
  type InspectorReport,
} from './subagents/index.js';

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
        result = await this.runOnboard(config, prompt, mode, request.projectId, signal, 'novel');
        break;
      case 'title':
        result = await this.runOnboard(config, prompt, mode, request.projectId, signal, 'title');
        break;
      case 'outline':
        result = await this.runOutlineOnly(config, prompt, request.projectId, signal);
        break;
      case 'polish':
        result = await this.runPolish(config, prompt, mode, request.projectId, request.chapterId, signal);
        break;
      case 'diagnostic':
        result = await this.runDiagnostic(config, prompt, request.projectId, signal);
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
        );
        break;
      case 'chapter_diagnosis':
        result = await this.runChapterDiagnosis(config, prompt, request.projectId, request.chapterId, signal);
        break;
      case 'workspace_review':
        result = await this.runWorkspaceReview(config, request.projectId!, signal);
        break;
      case 'auto_next':
        result = await this.runAutoNext(
          config,
          prompt,
          request.projectId!,
          request.options?.targetWords ?? 2000,
          signal,
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

  private async runOnboard(
    config: ModelConfig,
    prompt: string,
    mode: AgentRunMode,
    projectId: Id | undefined,
    signal: AbortSignal,
    variant: 'novel' | 'title',
  ): Promise<AgentRunResult> {
    const steps: string[] = [];
    const { projectId: pid, projectCreated, projectTitle } = await this.resolveProject(
      projectId,
      variant === 'title' ? prompt : prompt,
    );
    steps.push(projectCreated ? '已自动创建小说项目。' : '已复用当前小说项目。');

    const pack = await this.generatePack(config, prompt, mode, variant, signal);
    steps.push('已生成控稿参考包（世界 / 人物 / 大纲分步写入）。');

    const artifacts: AgentArtifact[] = [{ kind: 'project', id: pid, title: projectTitle }];
    const world = await this.store.createWorldSetting(pid, pack.title, pack.world);
    artifacts.push({ kind: 'world', id: world.id, title: world.title });
    steps.push('已保存世界观。');

    const character = await this.store.createCharacter(pid, '人物与口吻护栏', pack.characters);
    artifacts.push({ kind: 'character', id: character.id, title: character.name });
    steps.push('已保存人物护栏。');

    const outline = await this.store.createOutline(pid, `${pack.title}：大纲`, pack.outline);
    artifacts.push({ kind: 'outline', id: outline.id, title: outline.title });
    steps.push('已保存章节大纲。');

    await this.seedMemoryFromPack(pid, pack);

    if (mode === 'reference') {
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

    const draft = await this.generateDraft(config, prompt, pack, pid, signal);
    await this.store.updateChapterContent(chapter.id, draft);
    steps.push('已生成并保存首章正文。');

    await this.reflectAndRemember(config, pid, chapter.id, chapterTitle, draft, signal);
    steps.push('已反思首章并写入长期记忆（摘要 / 事实 / 风格）。');

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
  ): Promise<AgentRunResult> {
    const steps: string[] = [];
    const { projectId: pid, projectCreated, projectTitle } = await this.resolveProject(projectId, prompt);
    steps.push(projectCreated ? '已自动创建小说项目。' : '已复用当前小说项目。');

    const pack = await this.generatePack(config, prompt, 'reference', 'novel', signal);
    const artifacts: AgentArtifact[] = [{ kind: 'project', id: pid, title: projectTitle }];

    const world = await this.store.createWorldSetting(pid, pack.title, pack.world);
    artifacts.push({ kind: 'world', id: world.id, title: world.title });
    const character = await this.store.createCharacter(pid, '人物与口吻护栏', pack.characters);
    artifacts.push({ kind: 'character', id: character.id, title: character.name });
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
  ): Promise<AgentRunResult> {
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
  ): Promise<AgentRunResult> {
    if (projectId === undefined || projectId.trim().length === 0) {
      throw ServiceError.validation('综合测试需要先选择项目。');
    }
    const project = await this.store.getProject(projectId);
    if (!project) throw ServiceError.notFound(`项目不存在：${projectId}`);

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
  ): Promise<AgentRunResult> {
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
  ): Promise<AgentRunResult> {
    if (chapterId === undefined || chapterId.trim().length === 0) {
      throw ServiceError.validation('章节诊断需要先选择一个章节。');
    }
    const chapter = await this.store.getChapter(chapterId);
    if (!chapter) throw ServiceError.notFound(`章节不存在：${chapterId}`);
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
  ): Promise<AgentRunResult> {
    const project = await this.store.getProject(projectId);
    if (!project) throw ServiceError.notFound(`项目不存在：${projectId}`);

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
  ): Promise<AgentRunResult> {
    const project = await this.store.getProject(projectId);
    if (!project) throw ServiceError.notFound(`项目不存在：${projectId}`);

    const steps: string[] = [];
    const chapters = await this.store.listChapters(projectId);
    const nextNum = chapters.length + 1;
    const newTitle = `第${nextNum}章`;
    steps.push(`已推断下一章：${newTitle}`);

    const chapter = await this.store.createChapter(projectId, newTitle);
    steps.push('已创建章节骨架。');

    const baseRequirement =
      prompt.length > 0 ? prompt : '顺接上一章剧情，推进主线并留下章节钩子。';
    // 把长期记忆（前情 + 设定事实 + 风格）注入蓝图需求，保证跨章节连贯。
    const memoryContext = this.memory.buildContext(projectId, scaledMemoryOptions(nextNum));
    const requirement =
      memoryContext.length > 0
        ? `${baseRequirement}\n\n=== 须严格遵循的故事记忆 ===\n${memoryContext}`
        : baseRequirement;
    if (memoryContext.length > 0) {
      steps.push('已回灌长期记忆（前情 / 设定 / 风格）到本章规划。');
    }
    await this.blueprintService.generate(
      chapter.id,
      { targetWords, requirement },
      signal,
    );
    steps.push('已生成章节蓝图与场景列表。');

    for await (const _event of this.chapterWriter.streamChapter(chapter.id, signal)) {
      if (signal.aborted) break;
    }
    steps.push('已按场景顺序写完并合并整章正文。');

    const saved = await this.store.getChapter(chapter.id);
    await this.reflectAndRemember(
      config,
      projectId,
      chapter.id,
      saved?.title ?? newTitle,
      saved?.content ?? '',
      signal,
    );
    steps.push('已反思本章并更新长期记忆。');
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
   * 一键生成整本（小说）：建项目 → 设定包 → 循环写 N 章，每章都注入长期记忆并写完后反思。
   * 这是 Agent 的「长程自动循环」：上一章的反思沉淀会成为下一章的上下文，逐章累积连贯性。
   */
  private async runFullNovel(
    config: ModelConfig,
    prompt: string,
    projectId: Id | undefined,
    chapters: number,
    targetWords: number,
    totalChapters: number | undefined,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    const { chapterCount, wordsPerChapter } = normalizeFullNovelOptions(chapters, targetWords);
    const plannedTotalChapters = clampInteger(
      totalChapters ?? chapterCount,
      FULL_NOVEL_LIMITS.minChapters,
      FULL_NOVEL_LIMITS.maxChapters,
    );
    const plannedWords = plannedTotalChapters * wordsPerChapter;
    const emit = (event: AgentProgressEvent): void => {
      try {
        onProgress?.(event);
      } catch {
        // 进度回调不应影响主流程。
      }
    };
    const steps: string[] = [];
    emit({ phase: 'setup', message: '正在准备项目…' });
    const { projectId: pid, projectCreated, projectTitle } = await this.resolveProject(projectId, prompt);
    steps.push(projectCreated ? '已自动创建小说项目。' : '已复用当前小说项目。');
    steps.push(
      `长篇参数：本批 ${chapterCount} 章 x ${wordsPerChapter} 字；总计划 ${plannedTotalChapters} 章，约 ${plannedWords.toLocaleString()} 字。`,
    );

    const artifacts: AgentArtifact[] = [{ kind: 'project', id: pid, title: projectTitle }];
    let pack = projectCreated ? undefined : await this.loadExistingPack(pid, prompt, artifacts);
    if (pack) {
      steps.push('已复用现有世界观 / 人物护栏 / 大纲，继续长篇批处理。');
      emit({ phase: 'setup', message: '已复用现有设定包，开始继续写作。' });
    } else {
      emit({ phase: 'setup', message: '正在生成世界观 / 人物 / 大纲设定包…' });
      pack = await this.generatePack(config, prompt, 'draft', 'novel', signal);
      const world = await this.store.createWorldSetting(pid, pack.title, pack.world);
      artifacts.push({ kind: 'world', id: world.id, title: world.title });
      const character = await this.store.createCharacter(pid, '人物与口吻护栏', pack.characters);
      artifacts.push({ kind: 'character', id: character.id, title: character.name });
      const outline = await this.store.createOutline(pid, `${pack.title}：大纲`, pack.outline);
      artifacts.push({ kind: 'outline', id: outline.id, title: outline.title });
      steps.push('已生成并保存世界观 / 人物护栏 / 大纲。');
    }

    await this.purgeEmptyChapterShells(pid);
    const existing = await this.store.listChapters(pid);
    const completedBefore = existing.filter((ch) => ch.content.trim().length > 0).length;
    const plannedFinalChapter = Math.max(completedBefore + chapterCount, plannedTotalChapters);
    pack = await this.ensureFullNovelControlOutline(
      config,
      pid,
      pack,
      prompt,
      plannedFinalChapter,
      wordsPerChapter,
      signal,
      emit,
      artifacts,
      steps,
    );
    if (projectCreated) {
      await this.seedMemoryFromPack(pid, pack);
      steps.push('已写入初始故事记忆（设定事实）。');
    }

    emit({ phase: 'setup', message: '设定、总控大纲与初始记忆就绪，开始逐章写作。' });
    let lastChapterId: Id | undefined;
    let completedChapters = 0;
    for (let i = 0; i < chapterCount; i += 1) {
      if (signal.aborted) break;
      const num = completedBefore + i + 1;
      const title = `第${num}章`;
      emit({ phase: 'chapter', message: `正在写「${title}」正文…`, current: i + 1, total: chapterCount });
      const chapter = await this.store.createChapter(pid, title);
      artifacts.push({ kind: 'chapter', id: chapter.id, title });
      lastChapterId = chapter.id;

      const content = await this.generateChapterWithMemory(
        config,
        pid,
        pack,
        num,
        plannedFinalChapter,
        prompt,
        wordsPerChapter,
        signal,
      );
      await this.store.updateChapterContent(chapter.id, content);
      emit({
        phase: 'inspect',
        message: `写作子 Agent 已完成「${title}」，检测子 Agent 并行审查中…`,
        current: i + 1,
        total: chapterCount,
      });
      const post = await runReflectionAndInspectionParallel(
        () => this.reflectAndRemember(config, pid, chapter.id, title, content, signal),
        () => this.inspectChapterDraft(config, pid, num, title, content, signal),
      );
      await this.applyInspectorFindings(pid, post.inspection);
      let finalContent = content;
      if (post.inspection.recommendRevision && post.inspection.revisionHints.length > 0) {
        emit({ phase: 'chapter', message: `检测子 Agent 要求修订「${title}」…`, current: i + 1, total: chapterCount });
        finalContent = await this.reviseChapterWithHints(
          config,
          pid,
          pack,
          num,
          plannedFinalChapter,
          prompt,
          wordsPerChapter,
          finalContent,
          post.inspection.revisionHints,
          signal,
        );
        await this.store.updateChapterContent(chapter.id, finalContent);
        await this.reflectAndRemember(config, pid, chapter.id, title, finalContent, signal);
        steps.push(`检测子 Agent 已触发修订「${title}」。`);
      }
      completedChapters += 1;
      steps.push(
        `已写完「${title}」（${finalContent.length} 字）；检测评分 ${post.inspection.score0to100}。`,
      );
      emit({
        phase: 'chapter',
        message: `「${title}」已完成（${content.length} 字）`,
        current: i + 1,
        total: chapterCount,
      });
    }

    emit({ phase: 'info', message: '整本草稿生成完成。' });
    return {
      task: 'full_novel',
      mode: 'draft',
      projectId: pid,
      chapterId: lastChapterId,
      summary: `已一键生成整本草稿：完成 ${completedChapters}/${chapterCount} 章，全程带长期记忆与逐章反思自我进化。`,
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
    const memoryContext = this.memory.buildContext(projectId, scaledMemoryOptions(chapterNumber));
    const memoryBlock = memoryContext.length > 0 ? `\n\n${memoryContext}` : '';
    const chapterOutline = extractChapterOutline(pack.outline, chapterNumber);
    const chapterOutlineBlock =
      chapterOutline ??
      `总大纲未提供第 ${chapterNumber} 章独立条目。请按当前进度承接总大纲，不得提前回收后续重大伏笔。`;
    const positionHint =
      chapterNumber === 1
        ? '这是开篇第一章：交代主角与世界、抛出核心冲突与悬念。'
        : chapterNumber >= totalChapters
          ? '这是收尾章：推进到高潮并给出结局或强力收束，呼应前情。'
          : '这是中段章节：顺接前情、推进主线、深化人物，并留下章末钩子。';
    const system = [
      `你是长篇小说正文写作子 Agent，正在连续创作《${pack.title}》。`,
      '只输出本章正文，不要输出大纲、解释或总结。',
      '务必与下列设定、人物护栏、整卷大纲、章节锚点和前情保持严格一致。',
      '本章必须优先执行「本章大纲锚点」；只能补足必要场景，不得跳到后续章节重大剧情。',
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

  /** 从设定包抽取初始故事事实写入记忆（无需额外模型调用）。 */
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
    const world = worlds.at(-1);
    const character = characters.at(-1);
    const outline = outlines.at(-1);
    if (!world || !character || !outline) return undefined;
    artifacts.push({ kind: 'world', id: world.id, title: world.title });
    artifacts.push({ kind: 'character', id: character.id, title: character.name });
    artifacts.push({ kind: 'outline', id: outline.id, title: outline.title });
    return {
      title: inferProjectName(prompt),
      world: withHeading('世界与规则', world.content),
      characters: withHeading('人物与口吻护栏', character.description),
      outline: withHeading('第一卷大纲', outline.content),
    };
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

  /** Drop chapter shells left by interrupted runs so resume continues at the right number. */
  private async purgeEmptyChapterShells(projectId: Id): Promise<void> {
    const chapters = await this.store.listChapters(projectId);
    for (const chapter of chapters) {
      if (chapter.content.trim().length === 0) {
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
    _targetWords: number,
    original: string,
    hints: string[],
    signal: AbortSignal,
  ): Promise<string> {
    const memoryContext = this.memory.buildContext(projectId, scaledMemoryOptions(chapterNumber));
    const memoryBlock = memoryContext.length > 0 ? `\n\n${memoryContext}` : '';
    return this.generateText(
      config,
      [
        {
          role: 'system',
          content: [
            `你是长篇小说「写作子 Agent」，正在修订《${pack.title}》第 ${chapterNumber} 章。`,
            '检测子 Agent 已发现连贯性问题，你必须按修订建议改稿，保持人设与世界观一致。',
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
          content: `原稿：\n${original.slice(0, 6000)}\n\n请输出修订后的第 ${chapterNumber} 章全文。题材：${seedPrompt}`,
        },
      ],
      signal,
    );
  }

  /**
   * 反思子 Agent（自我进化核心）：读章节正文，产出
   * { summary, facts[], learning } 并写入长期记忆。
   * 模型未按 JSON 返回时降级：用正文截断作摘要，保证记忆始终被更新、流程不中断。
   */
  private async reflectAndRemember(
    config: ModelConfig,
    projectId: Id,
    chapterId: Id,
    chapterTitle: string,
    content: string,
    signal: AbortSignal,
  ): Promise<void> {
    const text = content.trim();
    if (text.length === 0) return;

    const fallbackSummary = text.replace(/\s+/g, ' ').slice(0, 200);
    let summary = fallbackSummary;
    let facts: Array<{ kind: 'character' | 'world' | 'plot'; text: string }> = [];
    let learning = '';

    try {
      const raw = await this.generateText(
        config,
        [
          {
            role: 'system',
            content: [
              '你是小说连贯性「反思子 Agent」。阅读给定章节正文，提炼可供后续章节复用的记忆。',
              '只输出一个 JSON 对象，不要输出任何额外文字或代码块标记，结构：',
              '{"summary":"本章 100 字内剧情摘要","facts":[{"kind":"character|world|plot","text":"应保持一致的设定/状态，一句话"}],"learning":"一条可复用的写作风格经验"}',
              'facts 至多 5 条，聚焦人物状态变化、世界规则、关键剧情进展。',
            ].join('\n'),
          },
          { role: 'user', content: `章节标题：${chapterTitle}\n\n正文：\n${text.slice(0, 6000)}` },
        ],
        signal,
        { jsonMode: true },
      );
      const parsed = parseReflection(raw);
      if (parsed.summary.length > 0) summary = parsed.summary;
      facts = parsed.facts;
      learning = parsed.learning;
    } catch {
      // 反思失败：保留 fallback 摘要，记忆仍前进，不中断主流程。
    }

    await this.memory.appendChapterSummary(projectId, {
      chapterId,
      title: chapterTitle,
      summary,
    });
    if (facts.length > 0) await this.memory.recordFacts(projectId, facts);
    if (learning.length > 0) await this.memory.recordLearning(projectId, learning);
  }

  private async generatePack(
    config: ModelConfig,
    prompt: string,
    mode: AgentRunMode,
    variant: 'novel' | 'title',
    signal: AbortSignal,
  ): Promise<GeneratedPack> {
    const title = inferProjectName(prompt);
    const modeHint = mode === 'draft' ? '直接成文前置控稿' : '参考方案';

    // Shared stable prefix for all 3 sub-agent calls — maximises DeepSeek prefix cache hits
    const sharedPrefix = [
      `你是一名小说策划子 Agent。模式：${modeHint}。`,
      `任务类型：${variant === 'title' ? '按书名/章节名扩展' : '一句话开书'}`,
      `用户需求：${prompt}`,
    ].join('\n');

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

    const characters = await this.generateText(
      config,
      [
        {
          role: 'system',
          content: sharedPrefix + '\n\n你负责「人物策划」。只输出「人物与口吻护栏」Markdown 一节。\n\n已有世界观摘要：\n' + world.slice(0, 800),
        },
        { role: 'user', content: '请开始生成人物设定。' },
      ],
      signal,
    );

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
    options?: { jsonMode?: boolean },
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

interface ParsedReflection {
  summary: string;
  facts: Array<{ kind: 'character' | 'world' | 'plot'; text: string }>;
  learning: string;
}

/** 从反思子 Agent 的原始输出里稳健解析 JSON（容忍 ```json 包裹与前后噪声）。 */
function parseReflection(raw: string): ParsedReflection {
  const empty: ParsedReflection = { summary: '', facts: [], learning: '' };
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
  return { summary, facts, learning };
}
