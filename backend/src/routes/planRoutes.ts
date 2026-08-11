/**
 * Novel planning / brainstorm routes.
 *
 * | 方法 & 路径                 | 说明                         |
 * |----------------------------|------------------------------|
 * | `POST /api/agent/plan/turn` | 计划模式一轮追问 / 收束 brief |
 */
import type { FastifyInstance } from 'fastify';

import type { NovelPlanService } from '../services/agent/NovelPlanService.js';
import { ServiceError } from '../services/ServiceError.js';
import type {
  NovelPlanAnswer,
  NovelPlanDepth,
  NovelPlanHistoryTurn,
  NovelPlanTargetTask,
  NovelPlanTurnRequest,
} from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';

const TARGET_TASKS: readonly NovelPlanTargetTask[] = ['novel', 'full_novel', 'long_novel', 'outline', 'title'];
const PLAN_DEPTHS: readonly NovelPlanDepth[] = ['light', 'standard', 'deep'];

function isTargetTask(value: unknown): value is NovelPlanTargetTask {
  return typeof value === 'string' && (TARGET_TASKS as readonly string[]).includes(value);
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
  if (typeof body.seedPrompt !== 'string' || body.seedPrompt.trim().length === 0) {
    throw ServiceError.validation('seedPrompt 不能为空。');
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
    seedPrompt: body.seedPrompt,
    targetTask: isTargetTask(body.targetTask) ? body.targetTask : undefined,
    depth: isPlanDepth(body.depth) ? body.depth : undefined,
    history: parseHistory(body.history),
    answers: parseAnswers(body.answers),
    forceReady: body.forceReady === true,
  };
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
}

export default registerPlanRoutes;
