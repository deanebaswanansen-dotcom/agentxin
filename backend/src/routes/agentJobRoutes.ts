import type { FastifyInstance } from 'fastify';

import { AgentJobRunner } from '../services/agent/jobs/AgentJobRunner.js';
import type { AgentRunStore } from '../services/agent/jobs/AgentRunStore.js';
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
}

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: '后台任务不存在。' } };

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
      return reply.code(202).send(run);
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
    return reply.code(200).send(run);
  });

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/agent-jobs',
    async (request, reply) => reply.code(200).send(
      store.listForClient(getCurrentClientId(), request.params.projectId),
    ),
  );

  app.post<{ Params: { id: string } }>('/api/agent/jobs/:id/cancel', async (request, reply) => {
    const run = await runner.cancel(getCurrentClientId(), request.params.id);
    return run ? reply.code(200).send(run) : reply.code(404).send(NOT_FOUND);
  });
}
