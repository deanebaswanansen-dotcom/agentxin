import type { FastifyInstance } from 'fastify';

import { corsResponseHeaders } from '../cors.js';
import type { AgentService } from '../services/agent/AgentService.js';
import { normalizeStoryPlan } from '../services/agent/NovelPlanService.js';
import { ServiceError } from '../services/ServiceError.js';
import type {
  AgentProgressEvent,
  AgentRunMode,
  AgentRunRequest,
  AgentTask,
  LongNovelAutomationLevel,
  NovelPlanChapterOutline,
  NovelPlanSummary,
} from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';

const AGENT_TASKS: readonly AgentTask[] = [
  'novel',
  'title',
  'outline',
  'polish',
  'diagnostic',
  'material_research',
  'trope_breakdown',
  'cliche_guard',
  'chapter_diagnosis',
  'workspace_review',
  'auto_next',
  'full_novel',
  'long_novel',
  'script_plan',
  'script_series_outline',
  'script_bible',
  'script_episode_batch',
  // New blueprint-centric tasks (Python LangGraph core)
  'plan_blueprint',
  'write_scene',
  'write_chapter_from_blueprint',
];

interface RunAgentBody {
  task?: unknown;
  mode?: unknown;
  prompt?: unknown;
  projectId?: unknown;
  chapterId?: unknown;
  options?: unknown;
  scriptBatchOptions?: unknown;
  regenerate?: unknown;
}

function isAgentTask(value: unknown): value is AgentTask {
  return typeof value === 'string' && (AGENT_TASKS as readonly string[]).includes(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.round(value);
  return n > 0 ? n : undefined;
}

/** 宽松解析计划摘要（StoryForge 风格计划采纳），非法字段丢弃。 */
export function parsePlanSummary(raw: unknown): NovelPlanSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const constraints = Array.isArray(obj.constraints)
    ? obj.constraints.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
    : undefined;
  const chapterOutlines: NovelPlanChapterOutline[] | undefined = Array.isArray(obj.chapterOutlines)
    ? obj.chapterOutlines
        .map((item): NovelPlanChapterOutline | null => {
          if (!item || typeof item !== 'object') return null;
          const ch = item as Record<string, unknown>;
          const number = asOptionalPositiveInt(ch.number);
          const title = asOptionalString(ch.title);
          const goal = asOptionalString(ch.goal);
          if (number === undefined || !title || !goal) return null;
          return {
            number,
            title,
            goal,
            estimatedWords: asOptionalPositiveInt(ch.estimatedWords),
          };
        })
        .filter((x): x is NovelPlanChapterOutline => x !== null)
    : undefined;

  const summary: NovelPlanSummary = {
    title: asOptionalString(obj.title),
    genre: asOptionalString(obj.genre),
    protagonist: asOptionalString(obj.protagonist),
    hook: asOptionalString(obj.hook),
    tone: asOptionalString(obj.tone),
    constraints: constraints && constraints.length > 0 ? constraints : undefined,
    totalWords: asOptionalPositiveInt(obj.totalWords),
    wordsPerChapter: asOptionalPositiveInt(obj.wordsPerChapter),
    chapterCount: asOptionalPositiveInt(obj.chapterCount),
    chapterOutlines: chapterOutlines && chapterOutlines.length > 0 ? chapterOutlines : undefined,
    storyPlan: normalizeStoryPlan(obj.storyPlan),
  };

  const hasAny = Object.values(summary).some((v) => v !== undefined);
  return hasAny ? summary : undefined;
}

function parseAutomationLevel(value: unknown): LongNovelAutomationLevel | undefined {
  if (
    value === 'assistant' ||
    value === 'semi_auto' ||
    value === 'auto' ||
    value === 'unattended'
  ) {
    return value;
  }
  return undefined;
}

function parseAgentOptions(raw: unknown): AgentRunRequest['options'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const options: NonNullable<AgentRunRequest['options']> = {};
  const targetWords = asOptionalPositiveInt(obj.targetWords);
  const chapters = asOptionalPositiveInt(obj.chapters);
  const totalChapters = asOptionalPositiveInt(obj.totalChapters);
  const totalWords = asOptionalPositiveInt(obj.totalWords);
  const minWordsPerChapter = asOptionalPositiveInt(obj.minWordsPerChapter);
  const maxWordsPerChapter = asOptionalPositiveInt(obj.maxWordsPerChapter);
  const planSummary = parsePlanSummary(obj.planSummary);
  const automationLevel = parseAutomationLevel(obj.automationLevel);
  if (targetWords !== undefined) options.targetWords = targetWords;
  if (chapters !== undefined) options.chapters = chapters;
  if (totalChapters !== undefined) options.totalChapters = totalChapters;
  if (totalWords !== undefined) options.totalWords = totalWords;
  if (minWordsPerChapter !== undefined) options.minWordsPerChapter = minWordsPerChapter;
  if (maxWordsPerChapter !== undefined) options.maxWordsPerChapter = maxWordsPerChapter;
  if (planSummary !== undefined) options.planSummary = planSummary;
  if (automationLevel !== undefined) options.automationLevel = automationLevel;
  return Object.keys(options).length > 0 ? options : undefined;
}

function isScriptTask(task: AgentTask): boolean {
  return task === 'script_plan' || task === 'script_series_outline' ||
    task === 'script_bible' || task === 'script_episode_batch';
}

function parseScriptBatchOptions(raw: unknown): AgentRunRequest['scriptBatchOptions'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const startEpisode = asOptionalPositiveInt(value.startEpisode);
  const episodeCount = asOptionalPositiveInt(value.episodeCount);
  const expectedPlanRevision = asOptionalPositiveInt(value.expectedPlanRevision);
  const draftMode = value.draftMode;
  const rewriteMode = value.rewriteMode;
  const rewriteInstruction = typeof value.rewriteInstruction === 'string'
    ? value.rewriteInstruction.trim()
    : '';
  if (startEpisode === undefined || episodeCount === undefined || expectedPlanRevision === undefined) {
    throw ServiceError.validation('短剧批次必须包含起始集、1–5 集数量和策划版本。');
  }
  if (episodeCount > 5) {
    throw ServiceError.validation('短剧每批最多生成 5 集。');
  }
  if ((startEpisode - 1) % 5 !== 0 && episodeCount !== 1) {
    throw ServiceError.validation('短剧正文批次必须从第 1、6、11……集开始。');
  }
  if (rewriteInstruction.length > 2_000) {
    throw ServiceError.validation('单集修改要求不能超过 2000 字。');
  }
  if (rewriteInstruction && episodeCount !== 1) {
    throw ServiceError.validation('自定义修改要求只能用于单独重写一集。');
  }
  if (rewriteMode !== undefined && rewriteMode !== 'revise' && rewriteMode !== 'replace') {
    throw ServiceError.validation('单集重写方式必须是 revise 或 replace。');
  }
  if (rewriteMode !== undefined && episodeCount !== 1) {
    throw ServiceError.validation('单集重写方式只能用于单独重写一集。');
  }
  if (
    draftMode !== undefined &&
    draftMode !== 'structured_legacy' &&
    draftMode !== 'direct_text'
  ) {
    throw ServiceError.validation('短剧正文模式必须是 structured_legacy 或 direct_text。');
  }
  return {
    startEpisode,
    episodeCount,
    expectedPlanRevision,
    ...(draftMode ? { draftMode } : {}),
    ...(rewriteMode ? { rewriteMode } : {}),
    ...(rewriteInstruction ? { rewriteInstruction } : {}),
  };
}

/**
 * Validate and narrow a raw agent request body into an {@link AgentRunRequest}.
 * Throws `VALIDATION_ERROR` on malformed input (shared by REST and SSE routes).
 */
export function parseAgentBody(raw: RunAgentBody): AgentRunRequest {
  if (!isAgentTask(raw.task)) {
    throw ServiceError.validation(`Agent 任务无效，必须是：${AGENT_TASKS.join('、')}。`);
  }
  const scriptTask = isScriptTask(raw.task);
  if (!scriptTask && raw.mode !== 'reference' && raw.mode !== 'draft') {
    throw ServiceError.validation('Agent 模式必须是 reference 或 draft。');
  }
  if (!scriptTask && typeof raw.prompt !== 'string') {
    throw ServiceError.validation('prompt 必须为字符串。');
  }
  if (raw.projectId !== undefined && typeof raw.projectId !== 'string') {
    throw ServiceError.validation('projectId 必须为字符串。');
  }
  if (raw.chapterId !== undefined && typeof raw.chapterId !== 'string') {
    throw ServiceError.validation('chapterId 必须为字符串。');
  }
  if (
    raw.task !== 'auto_next' &&
    raw.task !== 'workspace_review' &&
    raw.task !== 'chapter_diagnosis' &&
    typeof raw.prompt === 'string' && raw.prompt.trim().length === 0
  ) {
    throw ServiceError.validation('一句话需求不能为空。');
  }
  if (scriptTask && (typeof raw.projectId !== 'string' || raw.projectId.trim().length === 0)) {
    throw ServiceError.validation('短剧 Agent 任务必须绑定 projectId。');
  }
  const scriptBatchOptions = raw.task === 'script_episode_batch'
    ? parseScriptBatchOptions(raw.scriptBatchOptions)
    : undefined;
  if (
    scriptBatchOptions &&
    scriptBatchOptions.episodeCount === 1 &&
    (scriptBatchOptions.startEpisode - 1) % 5 !== 0 &&
    raw.regenerate !== true
  ) {
    throw ServiceError.validation('只有重写已生成的单集可以从任意集数开始。');
  }
  if (
    (scriptBatchOptions?.rewriteInstruction || scriptBatchOptions?.rewriteMode) &&
    raw.regenerate !== true
  ) {
    throw ServiceError.validation('单集修改要求必须与重新写作一起提交。');
  }
  if (
    (scriptBatchOptions?.rewriteInstruction || scriptBatchOptions?.rewriteMode) &&
    scriptBatchOptions.draftMode === 'structured_legacy'
  ) {
    throw ServiceError.validation('按要求重写单集只支持直接正文模式。');
  }
  return {
    task: raw.task,
    mode: scriptTask ? 'draft' : raw.mode as AgentRunMode,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    projectId: raw.projectId,
    chapterId: raw.chapterId,
    ...(scriptTask && raw.regenerate === true ? { regenerate: true } : {}),
    options: parseAgentOptions(raw.options),
    scriptBatchOptions,
  };
}

/** Serialize a single SSE frame (matches the writing/blueprint route conventions). */
function sseFrame(event: string, data?: string): string {
  const head = `event: ${event}\n`;
  return data === undefined ? `${head}\n` : `${head}data: ${data}\n\n`;
}

export function registerAgentRoutes(app: FastifyInstance, agentService: AgentService): void {
  // Non-streaming run (kept for backward compatibility / simple tasks).
  app.post<{ Body: RunAgentBody }>('/api/agent/run', async (request, reply) => {
    try {
      const parsed = parseAgentBody(request.body ?? {});
      const controller = new AbortController();
      const raw = reply.raw;
      const onClose = (): void => {
        if (!raw.writableEnded) {
          controller.abort();
        }
      };
      raw.on('close', onClose);
      const result = await (async () => {
        try {
          return await agentService.run(parsed, controller.signal);
        } finally {
          raw.removeListener('close', onClose);
        }
      })();
      return reply.code(200).send(result);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

  // Streaming run (SSE): forwards live progress events, then the final result.
  //
  // Wire contract (must match frontend apiClient.agent.runStream):
  //   event: progress  data: <JSON AgentProgressEvent>   — incremental progress
  //   event: result    data: <JSON AgentRunResult>       — final result payload
  //   event: done                                         — normal completion
  //   event: error     data: <JSON ApiError>             — failure (pre/mid stream)
  app.post<{ Body: RunAgentBody }>('/api/agent/run-stream', async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    // Disable Nagle-ish buffering so progress frames reach the browser promptly.
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsResponseHeaders(),
    });
    if (typeof (raw as { flushHeaders?: () => void }).flushHeaders === 'function') {
      (raw as { flushHeaders: () => void }).flushHeaders();
    }

    const writeFrame = (frame: string): void => {
      if (raw.writableEnded) return;
      raw.write(frame);
      const maybeFlush = (raw as { flush?: () => void }).flush;
      if (typeof maybeFlush === 'function') {
        try {
          maybeFlush.call(raw);
        } catch {
          // flush is best-effort on Node HTTP responses.
        }
      }
    };

    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      writeFrame(': heartbeat\n\n');
    }, 10_000);
    heartbeat.unref();
    const onClose = (): void => {
      if (!raw.writableEnded) {
        controller.abort();
      }
    };
    raw.on('close', onClose);

    try {
      const parsed = parseAgentBody(request.body ?? {});
      // Immediate heartbeat so the UI leaves "等待输出" even before first agent step.
      writeFrame(sseFrame('progress', JSON.stringify({
        phase: 'setup',
        message: 'Agent 已接收任务，正在编排…',
      } satisfies AgentProgressEvent)));

      const onProgress = (event: AgentProgressEvent): void => {
        writeFrame(sseFrame('progress', JSON.stringify(event)));
      };
      const result = await agentService.run(parsed, controller.signal, onProgress);
      if (!raw.writableEnded) {
        writeFrame(sseFrame('result', JSON.stringify(result)));
        writeFrame(sseFrame('done'));
      }
    } catch (err) {
      if (!controller.signal.aborted && !raw.writableEnded) {
        const { body: apiError } = toErrorResponse(err);
        writeFrame(sseFrame('error', JSON.stringify(apiError)));
      }
    } finally {
      clearInterval(heartbeat);
      raw.removeListener('close', onClose);
      if (!raw.writableEnded) {
        raw.end();
      }
    }
  });
}

export default registerAgentRoutes;
