/**
 * Novel planning / brainstorm routes.
 *
 * | 方法 & 路径                 | 说明                         |
 * |----------------------------|------------------------------|
 * | `POST /api/agent/plan/turn` | 计划模式一轮追问 / 收束 brief |
 */
import type { FastifyInstance } from 'fastify';

import { corsResponseHeaders } from '../cors.js';
import type { NovelPlanService } from '../services/agent/NovelPlanService.js';
import { ServiceError } from '../services/ServiceError.js';
import type {
  NovelPlanAnswer,
  NovelPlanDepth,
  NovelPlanHistoryTurn,
  NovelPlanConfig,
  NovelPlanTargetTask,
  NovelPlanTurnRequest,
} from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';

const TARGET_TASKS: readonly NovelPlanTargetTask[] = ['novel', 'full_novel', 'long_novel', 'outline', 'title'];
const PLAN_DEPTHS: readonly NovelPlanDepth[] = ['light', 'standard', 'deep'];

function isTargetTask(value: unknown): value is NovelPlanTargetTask {
  return typeof value === 'string' && (TARGET_TASKS as readonly string[]).includes(value);
}

function positiveInt(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let parsed: number | undefined;
  if (typeof value === 'number') parsed = value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[,，\s]/g, '');
    const wan = normalized.match(/^(\d+(?:\.\d+)?)万/);
    parsed = wan ? Number(wan[1]) * 10000 : Number(normalized.replace(/[^\d.].*$/, ''));
  }
  if (parsed === undefined || !Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw ServiceError.validation(`${field} 必须是 1-${max} 的整数。`);
  }
  return parsed;
}

function parsePlanConfig(raw: unknown): NovelPlanConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw ServiceError.validation('planConfig 必须为对象。');
  }
  const row = raw as Record<string, unknown>;
  const field = (camel: string, snake: string): unknown => row[camel] ?? row[snake];
  const rangeRaw = field('targetWordsPerChapter', 'target_words_per_chapter');
  let targetWordsPerChapter: NovelPlanConfig['targetWordsPerChapter'];
  if (rangeRaw !== undefined) {
    if (typeof rangeRaw === 'number') {
      const value = positiveInt(rangeRaw, 'planConfig.targetWordsPerChapter', 20000)!;
      targetWordsPerChapter = { min: value, max: value };
    } else if (typeof rangeRaw === 'string') {
      const parts = rangeRaw.split(/[~～\-至]/).map((item) => positiveInt(item, 'planConfig.targetWordsPerChapter', 20000));
      const min = parts[0];
      const max = parts[1] ?? min;
      if (min === undefined || max === undefined || min > max) {
        throw ServiceError.validation('planConfig.targetWordsPerChapter 必须是有效数字或范围。');
      }
      targetWordsPerChapter = { min, max };
    } else if (typeof rangeRaw === 'object' && rangeRaw !== null && !Array.isArray(rangeRaw)) {
      const range = rangeRaw as Record<string, unknown>;
      const min = positiveInt(range.min, 'planConfig.targetWordsPerChapter.min', 20000);
      const max = positiveInt(range.max, 'planConfig.targetWordsPerChapter.max', 20000);
      if (min === undefined || max === undefined || min > max) {
        throw ServiceError.validation('planConfig.targetWordsPerChapter 必须包含有效的 min/max。');
      }
      targetWordsPerChapter = { min, max };
    } else {
      throw ServiceError.validation('planConfig.targetWordsPerChapter 必须是数字或 {min,max}。');
    }
  }
  const genres = field('genres', 'genre');
  if (
    genres !== undefined &&
    !(
      typeof genres === 'string' ||
      (Array.isArray(genres) && genres.every((item) => typeof item === 'string'))
    )
  ) {
    throw ServiceError.validation('planConfig.genres 必须为字符串数组。');
  }
  const textFieldAlias = (camel: string, snake: string, maxLength: number): string | undefined => {
    const value = field(camel, snake);
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.trim().length > maxLength) {
      throw ServiceError.validation(`planConfig.${camel} 必须是长度不超过 ${maxLength} 的文本。`);
    }
    return value.trim() || undefined;
  };
  const config: NovelPlanConfig = {
    targetTotalWords: positiveInt(
      field('targetTotalWords', 'target_total_words'),
      'planConfig.targetTotalWords',
      20_000_000,
    ),
    targetTotalChapters: positiveInt(
      field('targetTotalChapters', 'target_total_chapters'),
      'planConfig.targetTotalChapters',
      1000,
    ),
    targetWordsPerChapter,
    targetVolumeCount: positiveInt(
      field('targetVolumeCount', 'target_volume_count'),
      'planConfig.targetVolumeCount',
      50,
    ),
    genres:
      typeof genres === 'string'
        ? genres.split(/[+,，、]/).map((item) => item.trim()).filter(Boolean).slice(0, 8)
        : Array.isArray(genres)
          ? genres.map((item) => item.trim()).filter(Boolean).slice(0, 8)
          : undefined,
    coreStory: textFieldAlias('coreStory', 'core_story', 20_000),
    endingDirection: textFieldAlias('endingDirection', 'ending_direction', 2_000),
    writingRequirements: textFieldAlias('writingRequirements', 'writing_requirements', 8_000),
  };
  return Object.values(config).some((value) => value !== undefined) ? config : undefined;
}

function isPlanDepth(value: unknown): value is NovelPlanDepth {
  return typeof value === 'string' && (PLAN_DEPTHS as readonly string[]).includes(value);
}

function parseHistory(raw: unknown): NovelPlanHistoryTurn[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw ServiceError.validation('history 必须为数组。');
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw ServiceError.validation(`history[${index}] 必须为对象。`);
    }
    const row = item as Record<string, unknown>;
    if (row.role !== 'user' && row.role !== 'assistant') {
      throw ServiceError.validation(`history[${index}].role 必须是 user 或 assistant。`);
    }
    if (typeof row.content !== 'string') {
      throw ServiceError.validation(`history[${index}].content 必须为字符串。`);
    }
    return { role: row.role, content: row.content };
  });
}

function parseAnswers(raw: unknown): NovelPlanAnswer[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw ServiceError.validation('answers 必须为数组。');
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw ServiceError.validation(`answers[${index}] 必须为对象。`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.questionId !== 'string' || row.questionId.trim().length === 0) {
      throw ServiceError.validation(`answers[${index}].questionId 不能为空。`);
    }
    if (!Array.isArray(row.selectedOptionIds) || !row.selectedOptionIds.every((x) => typeof x === 'string')) {
      throw ServiceError.validation(`answers[${index}].selectedOptionIds 必须为字符串数组。`);
    }
    if (
      row.selectedOptionLabels !== undefined &&
      (!Array.isArray(row.selectedOptionLabels) ||
        !row.selectedOptionLabels.every((x) => typeof x === 'string'))
    ) {
      throw ServiceError.validation(`answers[${index}].selectedOptionLabels 必须为字符串数组。`);
    }
    if (row.customText !== undefined && typeof row.customText !== 'string') {
      throw ServiceError.validation(`answers[${index}].customText 必须为字符串。`);
    }
    return {
      questionId: row.questionId,
      selectedOptionIds: row.selectedOptionIds as string[],
      selectedOptionLabels: Array.isArray(row.selectedOptionLabels)
        ? (row.selectedOptionLabels as string[])
        : undefined,
      customText: typeof row.customText === 'string' ? row.customText : undefined,
    };
  });
}

function parsePlanBody(raw: unknown): NovelPlanTurnRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw ServiceError.validation('计划请求体必须为 JSON 对象。');
  }
  const body = raw as Record<string, unknown>;
  const planConfig = parsePlanConfig(body.planConfig);
  const seedPrompt = typeof body.seedPrompt === 'string' ? body.seedPrompt.trim() : '';
  if (!seedPrompt && !planConfig) {
    throw ServiceError.validation('seedPrompt 不能为空；或提供 planConfig。');
  }
  if (body.targetTask !== undefined && !isTargetTask(body.targetTask)) {
    throw ServiceError.validation(`targetTask 必须是：${TARGET_TASKS.join('、')}。`);
  }
  if (body.forceReady !== undefined && typeof body.forceReady !== 'boolean') {
    throw ServiceError.validation('forceReady 必须为布尔值。');
  }
  if (body.depth !== undefined && !isPlanDepth(body.depth)) {
    throw ServiceError.validation(`depth 必须是：${PLAN_DEPTHS.join('、')}。`);
  }
  return {
    seedPrompt: seedPrompt || '请根据结构化计划配置自动生成小说计划',
    planConfig,
    targetTask: isTargetTask(body.targetTask) ? body.targetTask : undefined,
    depth: isPlanDepth(body.depth) ? body.depth : undefined,
    history: parseHistory(body.history),
    answers: parseAnswers(body.answers),
    forceReady: body.forceReady === true,
  };
}

function sseFrame(event: string, data?: string): string {
  const head = `event: ${event}\n`;
  return data === undefined ? `${head}\n` : `${head}data: ${data}\n\n`;
}

export function registerPlanRoutes(app: FastifyInstance, planService: NovelPlanService): void {
  app.post('/api/agent/plan/turn', async (request, reply) => {
    try {
      const parsed = parsePlanBody(request.body ?? {});
      const controller = new AbortController();
      const raw = reply.raw;
      const onClose = (): void => {
        if (!raw.writableEnded) {
          controller.abort();
        }
      };
      raw.on('close', onClose);
      try {
        const result = await planService.turn(parsed, controller.signal);
        return reply.code(200).send(result);
      } finally {
        raw.removeListener('close', onClose);
      }
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

  // Streaming planning turn. The model may spend tens of seconds deciding or
  // generating chapter anchors, so an immediate frame plus 8-second heartbeats
  // keep Netlify and upstream proxies from treating the response as inactive.
  app.post('/api/agent/plan/turn-stream', async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
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
      const flush = (raw as { flush?: () => void }).flush;
      if (typeof flush === 'function') {
        try {
          flush.call(raw);
        } catch {
          // Best effort; Netlify's streaming transport flushes each chunk.
        }
      }
    };
    const controller = new AbortController();
    const heartbeat = setInterval(() => writeFrame(': heartbeat\n\n'), 8_000);
    heartbeat.unref();
    const onClose = (): void => {
      if (!raw.writableEnded) controller.abort();
    };
    raw.on('close', onClose);

    try {
      const parsed = parsePlanBody(request.body ?? {});
      writeFrame(
        sseFrame(
          'progress',
          JSON.stringify({ message: '策划 Agent 已接收信息，正在判断是否需要补问…' }),
        ),
      );
      const result = await planService.turn(parsed, controller.signal);
      if (!raw.writableEnded) {
        writeFrame(sseFrame('result', JSON.stringify(result)));
        writeFrame(sseFrame('done'));
      }
    } catch (error) {
      if (!controller.signal.aborted && !raw.writableEnded) {
        const { body } = toErrorResponse(error);
        writeFrame(sseFrame('error', JSON.stringify(body)));
      }
    } finally {
      clearInterval(heartbeat);
      raw.removeListener('close', onClose);
      if (!raw.writableEnded) raw.end();
    }
  });
}

export default registerPlanRoutes;
