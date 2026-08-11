import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceError } from '../services/ServiceError.js';
import type { NovelPlanService } from '../services/agent/NovelPlanService.js';
import type { NovelPlanTurnResponse } from '../types/index.js';
import { registerPlanRoutes } from './planRoutes.js';

describe('planRoutes turn-stream', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  async function buildApp(turn: NovelPlanService['turn']): Promise<void> {
    app = Fastify({ logger: false });
    registerPlanRoutes(app, { turn } as NovelPlanService);
    await app.ready();
  }

  it('starts SSE immediately and finishes with result plus done', async () => {
    const result: NovelPlanTurnResponse = {
      status: 'asking',
      round: 1,
      message: '只补一个关键问题。',
      questions: [
        {
          id: 'ending_cost',
          question: '胜利需要付出什么代价？',
          options: [
            { id: 'memory', label: '失去记忆' },
            { id: 'title', label: '失去爵位' },
          ],
        },
      ],
    };
    const turn = vi.fn().mockResolvedValue(result) as unknown as NovelPlanService['turn'];
    await buildApp(turn);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/plan/turn-stream',
      payload: { seedPrompt: '西方玄幻' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: progress');
    expect(response.body).toContain('event: result');
    expect(response.body).toContain('只补一个关键问题');
    expect(response.body.trimEnd().endsWith('event: done')).toBe(true);
  });

  it('keeps failures inside a parseable SSE error frame', async () => {
    const turn = vi
      .fn()
      .mockRejectedValue(ServiceError.validation('seedPrompt 不能为空。')) as unknown as NovelPlanService['turn'];
    await buildApp(turn);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/plan/turn-stream',
      payload: { seedPrompt: '西方玄幻' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: error');
    expect(response.body).toContain('VALIDATION_ERROR');
  });
});
