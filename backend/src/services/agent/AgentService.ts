import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { DataStore } from '../../store/DataStore.js';
import type {
  AgentProgressEvent,
  AgentRunExecutionContext,
  AgentRunRequest,
  AgentRunResult,
} from '../../types/index.js';
import type { BlueprintService } from '../blueprint/BlueprintService.js';
import type { ChapterWriter } from '../blueprint/ChapterWriter.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import type { MemoryService } from '../memory/MemoryService.js';
import type { ReferenceAnalysisService } from '../reference/ReferenceAnalysisService.js';
import type { LongNovelConfigStorePort } from './longNovel/LongNovelConfigStore.js';
import { ServiceError } from '../ServiceError.js';
import type { ScriptDirector, ScriptDirectorResult } from '../script/agents/ScriptDirector.js';
import { SCRIPT_PLANNING_FIELDS } from '../script/agents/ScriptPlanningAgent.js';
import { AgentOrchestrator } from './AgentOrchestrator.js';

type ScriptTask = Extract<AgentRunRequest['task'], `script_${string}`>;

function isScriptTask(task: AgentRunRequest['task']): task is ScriptTask {
  return task === 'script_plan' || task === 'script_series_outline' ||
    task === 'script_bible' || task === 'script_episode_batch';
}

function scriptSummary(result: ScriptDirectorResult): string {
  switch (result.kind) {
    case 'plan_draft':
      return `短剧策划草稿已生成：${result.plan.title}`;
    case 'series_outline':
      return `全剧总纲和 ${result.outline.episodeCards.length} 张分集卡已生成。`;
    case 'bible':
      return `人物圣经（${result.characters.length} 人）和世界圣经已生成。`;
    case 'episode_batch':
      return `已完成 ${result.episodes.length} 集，跳过 ${result.skippedEpisodeNumbers.length} 集；模型调用 ${result.callSummary.totalCalls} 次（Fixup ${result.callSummary.fixupCalls}、fallback ${result.callSummary.fallbackCalls}）。`;
    case 'planning_questions':
      return `短剧策划仍需回答 ${result.questions.length} 个问题。`;
    case 'planning_waiting':
      return `短剧策划仍缺少 ${result.missingFields.length} 个关键字段。`;
  }
}

const SCRIPT_TASK_STEPS: Record<ScriptTask, string[]> = {
  script_plan: ['读取短剧需求', '补全关键策划字段', '保存结构化策划'],
  script_series_outline: ['读取已确认策划', '分段生成全剧总纲与分集卡', '保存全剧大纲'],
  script_bible: ['读取策划和总纲', '生成人物圣经', '生成世界圣经'],
  script_episode_batch: ['展开当前批次详细大纲', '逐集写作、审查和修订', '保存检查点与批次结果'],
};

/** Facade: delegates to {@link AgentOrchestrator} (LangGraph-style multi sub-agent routing). */
export class AgentService {
  private readonly orchestrator: AgentOrchestrator;

  constructor(
    private readonly store: DataStore,
    modelConfigService: ModelConfigService,
    modelProxy: ModelProxy,
    blueprintService: BlueprintService,
    chapterWriter: ChapterWriter,
    memoryService: MemoryService,
    referenceService?: ReferenceAnalysisService,
    longNovelConfigStore?: LongNovelConfigStorePort,
    private readonly scriptDirector?: Pick<ScriptDirector, 'run'>,
  ) {
    this.orchestrator = new AgentOrchestrator(
      store,
      modelConfigService,
      modelProxy,
      blueprintService,
      chapterWriter,
      memoryService,
      referenceService,
      longNovelConfigStore,
    );
  }

  run(
    request: AgentRunRequest,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
    context?: AgentRunExecutionContext,
  ): Promise<AgentRunResult> {
    if (isScriptTask(request.task)) {
      return this.runScript({ ...request, task: request.task }, signal, onProgress, context);
    }
    return this.orchestrator.run(request, signal, onProgress);
  }

  private async runScript(
    request: AgentRunRequest & { task: ScriptTask },
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
    context?: AgentRunExecutionContext,
  ): Promise<AgentRunResult> {
    if (!this.scriptDirector) {
      throw ServiceError.validation('短剧 Agent 尚未接入当前运行环境。');
    }
    const projectId = request.projectId?.trim();
    if (!projectId) throw ServiceError.validation('短剧 Agent 任务必须绑定 projectId。');
    const project = await this.store.getProject(projectId);
    if (!project) throw ServiceError.notFound(`项目 ${projectId} 不存在`);
    if (project.kind !== 'short_drama') {
      throw ServiceError.validation('短剧 Agent 只能用于 short_drama 项目。');
    }

    onProgress?.({ phase: 'setup', message: `正在启动${project.name}的短剧任务…` });
    let result: ScriptDirectorResult;
    if (request.task === 'script_plan') {
      result = await this.scriptDirector.run({
        task: 'script_plan',
        projectId,
        seedPrompt: request.prompt,
        planningSession: {
          values: {},
          delegatedFields: [...SCRIPT_PLANNING_FIELDS],
          askedFields: [],
          questionCount: 0,
        },
        signal,
      });
    } else if (request.task === 'script_series_outline') {
      result = await this.scriptDirector.run({ task: request.task, projectId, signal });
    } else if (request.task === 'script_bible') {
      result = await this.scriptDirector.run({
        task: request.task,
        projectId,
        signal,
        ...(context?.resumeRejectedCandidates ? { resumeRejectedCandidates: true } : {}),
      });
    } else {
      const options = request.scriptBatchOptions;
      if (!options) {
        throw ServiceError.validation('短剧正文批次缺少起始集数、批次数量或策划 revision。');
      }
      result = await this.scriptDirector.run({
        task: request.task,
        projectId,
        ...options,
        signal,
        ...(context?.resumeRejectedCandidates ? { resumeRejectedCandidates: true } : {}),
        onProgress: (event) => {
          onProgress?.(event);
        },
      });
    }
    const summary = scriptSummary(result);
    onProgress?.({ phase: 'info', message: summary });
    return {
      task: request.task,
      mode: 'draft',
      projectId,
      summary,
      steps: SCRIPT_TASK_STEPS[request.task],
      artifacts: [{ kind: 'project', id: projectId, title: project.name }],
    };
  }
}
