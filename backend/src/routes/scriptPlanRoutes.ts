import type { FastifyInstance } from 'fastify';

import { ServiceError } from '../services/ServiceError.js';
import type {
  ScriptPlanAnswerValue,
  ScriptPlanTurnAnswer,
  ScriptPlanTurnService,
} from '../services/script/agents/ScriptPlanTurnService.js';
import { toErrorResponse } from './errorMapping.js';

interface ScriptPlanTurnBody {
  projectId?: unknown;
  seedPrompt?: unknown;
  answers?: unknown;
  reset?: unknown;
}
function answerValue(value: unknown, index: number): ScriptPlanAnswerValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  throw ServiceError.validation(`answers[${index}].value 类型无效。`);
}

function parseAnswers(value: unknown): ScriptPlanTurnAnswer[] {
  if (!Array.isArray(value) || value.length > 12) {
    throw ServiceError.validation('answers 必须是最多包含 12 项的数组。');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw ServiceError.validation(`answers[${index}] 必须是对象。`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.field !== 'string' || !row.field.trim()) {
      throw ServiceError.validation(`answers[${index}].field 不能为空。`);
    }
    if (row.delegate !== undefined && typeof row.delegate !== 'boolean') {
      throw ServiceError.validation(`answers[${index}].delegate 必须是布尔值。`);
    }
    return {
      field: row.field.trim(),
      value: answerValue(row.value, index),
      delegate: row.delegate === true,
    };
  });
}

function parseBody(body: ScriptPlanTurnBody) {
  if (typeof body.projectId !== 'string' || !body.projectId.trim()) {
    throw ServiceError.validation('projectId 不能为空。');
  }
  if (body.seedPrompt !== undefined &&
      (typeof body.seedPrompt !== 'string' || body.seedPrompt.length > 20_000)) {
    throw ServiceError.validation('seedPrompt 必须是长度不超过 20000 的文本。');
  }
  if (body.reset !== undefined && typeof body.reset !== 'boolean') {
    throw ServiceError.validation('reset 必须是布尔值。');
  }
  return {
    projectId: body.projectId.trim(),
    seedPrompt: typeof body.seedPrompt === 'string' ? body.seedPrompt : undefined,
    answers: parseAnswers(body.answers ?? []),
    reset: body.reset === true,
  };
}

export function registerScriptPlanRoutes(
  app: FastifyInstance,
  service: ScriptPlanTurnService,
): void {
  app.post<{ Body: ScriptPlanTurnBody }>('/api/plan/script/turn', async (request, reply) => {
    const controller = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.on('close', onClose);
    try {
      return reply.code(200).send(await service.turn(parseBody(request.body ?? {}), controller.signal));
    } catch (error) {
      const mapped = toErrorResponse(error);
      return reply.code(mapped.status).send(mapped.body);
    } finally {
      reply.raw.removeListener('close', onClose);
    }
  });
}
