import type { FastifyInstance } from 'fastify';

import type { AgentService } from '../services/agent/AgentService.js';
import { ServiceError } from '../services/ServiceError.js';
import type { AgentProgressEvent, AgentRunMode, AgentRunRequest, AgentTask } from '../types/index.js';
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
}

function isAgentTask(value: unknown): value is AgentTask {
  return typeof value === 'string' && (AGENT_TASKS as readonly string[]).includes(value);
}

/**
 * Validate and narrow a raw agent request body into an {@link AgentRunRequest}.
 * Throws `VALIDATION_ERROR` on malformed input (shared by REST and SSE routes).
 */
function parseAgentBody(raw: RunAgentBody): AgentRunRequest {
  if (!isAgentTask(raw.task)) {
    throw ServiceError.validation(`Agent 任务无效，必须是：${AGENT_TASKS.join('、')}。`);
  }
  if (raw.mode !== 'reference' && raw.mode !== 'draft') {
    throw ServiceError.validation('Agent 模式必须是 reference 或 draft。');
  }
  if (typeof raw.prompt !== 'string') {
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
    raw.prompt.trim().length === 0
  ) {
    throw ServiceError.validation('一句话需求不能为空。');
  }
  return {
    task: raw.task,
    mode: raw.mode as AgentRunMode,
    prompt: raw.prompt,
    projectId: raw.projectId,
    chapterId: raw.chapterId,
    options:
      raw.options && typeof raw.options === 'object'
        ? (raw.options as { targetWords?: number; chapters?: number; totalChapters?: number })
        : undefined,
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
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const controller = new AbortController();
    const onClose = (): void => {
      if (!raw.writableEnded) {
        controller.abort();
      }
    };
    raw.on('close', onClose);

    try {
      const parsed = parseAgentBody(request.body ?? {});
      const onProgress = (event: AgentProgressEvent): void => {
        if (!raw.writableEnded) {
          raw.write(sseFrame('progress', JSON.stringify(event)));
        }
      };
      const result = await agentService.run(parsed, controller.signal, onProgress);
      if (!raw.writableEnded) {
        raw.write(sseFrame('result', JSON.stringify(result)));
        raw.write(sseFrame('done'));
      }
    } catch (err) {
      if (!controller.signal.aborted && !raw.writableEnded) {
        const { body: apiError } = toErrorResponse(err);
        raw.write(sseFrame('error', JSON.stringify(apiError)));
      }
    } finally {
      raw.removeListener('close', onClose);
      if (!raw.writableEnded) {
        raw.end();
      }
    }
  });
}

export default registerAgentRoutes;
