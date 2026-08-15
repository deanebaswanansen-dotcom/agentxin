import type { FastifyInstance } from 'fastify';

import { AgentJobRunner } from '../services/agent/jobs/AgentJobRunner.js';
import type { AgentRunStore, StoredAgentRun } from '../services/agent/jobs/AgentRunStore.js';
import { getCurrentClientId } from '../services/client/clientScope.js';
import { getRequestModelConfig } from '../services/modelConfig/requestModelConfig.js';
import { parseAgentBody } from './agentRoutes.js';
import { toErrorResponse } from './errorMapping.js';

interface RunAgentBody {
  task?: unknown;
  mode?: unknown;
  prompt?: unknown;
  projectId?: unknown;
  chapterId?: unknown;
  options?: unknown;
  scriptBatchOptions?: unknown;
}

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: '后台任务不存在。' } };

function toClientRun(run: StoredAgentRun): StoredAgentRun & {
  projectId?: string;
  task: StoredAgentRun['request']['task'];
  scriptBatchOptions?: StoredAgentRun['request']['scriptBatchOptions'];
  checkpoint?: unknown;
  continuable: boolean;
} {
  const checkpoint = [...run.events]
    .reverse()
    .map((event) => (event as typeof event & { scriptCheckpoint?: unknown }).scriptCheckpoint)
    .find((value) => value !== undefined);
  const isScriptTask = run.request.task.startsWith('script_');
  return {
    ...run,
    projectId: run.request.projectId,
    task: run.request.task,
    ...(run.request.scriptBatchOptions ? { scriptBatchOptions: run.request.scriptBatchOptions } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    continuable:
      isScriptTask &&
      (run.status === 'failed' || run.status === 'waiting_user' || run.status === 'cancelled'),
  };
}

export function registerAgentJobRoutes(
  app: FastifyInstance,
  store: AgentRunStore,
  runner: AgentJobRunner,
): void {
  app.post<{ Body: RunAgentBody }>('/api/agent/jobs', async (request, reply) => {
    try {
      const run = await runner.start(
        getCurrentClientId(),
        parseAgentBody(request.body ?? {}),
        getRequestModelConfig(),
      );
      return reply.code(202).send(toClientRun(run));
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

  app.get<{ Params: { id: string } }>('/api/agent/jobs/:id', async (request, reply) => {
    const clientId = getCurrentClientId();
    let run = store.getForClient(clientId, request.params.id);
    if (!run) return reply.code(404).send(NOT_FOUND);
    if (run.status === 'waiting_user' && getRequestModelConfig()) {
      await runner.resume(clientId, run.id, getRequestModelConfig());
      run = store.getForClient(clientId, run.id) ?? run;
    }
    return reply.code(200).send(toClientRun(run));
  });

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/agent-jobs',
    async (request, reply) => reply.code(200).send(
      store.listForClient(getCurrentClientId(), request.params.projectId).map(toClientRun),
    ),
  );

  app.post<{ Params: { id: string } }>('/api/agent/jobs/:id/resume', async (request, reply) => {
    const run = await runner.resume(
      getCurrentClientId(),
      request.params.id,
      getRequestModelConfig(),
    );
    return run ? reply.code(200).send(toClientRun(run)) : reply.code(404).send(NOT_FOUND);
  });

  app.post<{ Params: { id: string } }>('/api/agent/jobs/:id/cancel', async (request, reply) => {
    const run = await runner.cancel(getCurrentClientId(), request.params.id);
    return run ? reply.code(200).send(toClientRun(run)) : reply.code(404).send(NOT_FOUND);
  });
}
