import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryScriptCheckpointStore, ScriptStructuredNeedsReviewError } from '../services/script/agents/ScriptDirector.js';
import { StructuredGenerationError } from '../services/script/agents/generateStructured.js';
import { ScriptPlanTurnService } from '../services/script/agents/ScriptPlanTurnService.js';
import type { ScriptPlan } from '../services/script/domain.js';
import { registerScriptPlanRoutes } from './scriptPlanRoutes.js';

function plan(): ScriptPlan {
  return {
    id: 'plan-1', projectId: 'project-1', status: 'draft', revision: 1,
    title: '她不再道歉', theme: '自我成长', market: 'domestic', channel: 'female',
    genres: ['都市情感'], audience: '女性观众', coreConflict: '女主反抗控制',
    logline: '女主在婚礼前夜揭穿骗局。', highlights: ['婚礼反转'], totalEpisodes: 10,
    episodeDurationSeconds: { min: 60, max: 90 }, targetCharsPerEpisode: 1200,
    maxPrimaryCharacters: 6, maxScenesPerEpisode: 3, dialogueDensityPercent: 60,
    language: 'zh-CN', format: 'cn_short_drama', coreRequirements: '每集有卡点',
    forbiddenElements: [], endingDirection: '痛快翻盘',
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
  };
}

describe('script plan routes', () => {
  it('persists a multi-turn planning session and returns a draft only after answers arrive', async () => {
    const run = vi.fn(async (request: { planningSession: { values: { endingDirection?: string } } }) => {
      if (!request.planningSession.values.endingDirection) {
        return {
          kind: 'planning_questions' as const,
          questions: [{
            field: 'endingDirection' as const,
            prompt: '结局要给观众什么情绪？',
            options: ['痛快翻盘', '温暖和解'],
          }],
          askedFields: ['endingDirection' as const],
          questionCount: 1,
        };
      }
      return { kind: 'plan_draft' as const, plan: plan() };
    });
    const checkpoints = new InMemoryScriptCheckpointStore();
    const service = new ScriptPlanTurnService(
      { run } as never,
      checkpoints,
      async (id) => ({
        id, name: '短剧', kind: 'short_drama',
        createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
      }),
    );
    const app = Fastify();
    registerScriptPlanRoutes(app, service);

    const first = await app.inject({
      method: 'POST', url: '/api/plan/script/turn',
      payload: { projectId: 'project-1', seedPrompt: '婚礼前夜觉醒', answers: [] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'asking', round: 1,
      questions: [{ field: 'endingDirection', label: '结局要给观众什么情绪？' }],
    });

    const second = await app.inject({
      method: 'POST', url: '/api/plan/script/turn',
      payload: {
        projectId: 'project-1',
        answers: [{ field: 'endingDirection', value: '痛快翻盘' }],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'ready', round: 2, plan: { title: '她不再道歉' } });
    expect(run.mock.calls[1]?.[0].planningSession.values.endingDirection).toBe('痛快翻盘');
    const history = await checkpoints.list('project-1', 'script_plan_session');
    expect(history).toHaveLength(2);
    expect(history.map((item) => item.artifactRevision)).toEqual([0, 1]);
    expect(history.map((item) => item.status)).toEqual(['running', 'succeeded']);
    await app.close();
  });

  it('retries a structured plan failure and then surfaces PROVIDER_ERROR', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new ScriptStructuredNeedsReviewError(
        'plan',
        new StructuredGenerationError('script_plan', 1, [], []),
      ))
      .mockResolvedValueOnce({ kind: 'plan_draft' as const, plan: plan() });
    const checkpoints = new InMemoryScriptCheckpointStore();
    const service = new ScriptPlanTurnService(
      { run } as never,
      checkpoints,
      async (id) => ({
        id, name: '短剧', kind: 'short_drama',
        createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
      }),
    );
    const app = Fastify();
    registerScriptPlanRoutes(app, service);

    const first = await app.inject({
      method: 'POST', url: '/api/plan/script/turn',
      payload: {
        projectId: 'project-1',
        seedPrompt: '修车铺赛车手',
        answers: [
          { field: 'genres', delegate: true },
          { field: 'coreConflict', delegate: true },
          { field: 'audience', delegate: true },
          { field: 'totalEpisodes', delegate: true },
          { field: 'episodeDurationSeconds', delegate: true },
          { field: 'targetCharsPerEpisode', delegate: true },
          { field: 'maxScenesPerEpisode', delegate: true },
          { field: 'dialogueDensityPercent', delegate: true },
          { field: 'endingDirection', delegate: true },
        ],
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'ready', plan: { title: '她不再道歉' } });
    expect(run).toHaveBeenCalledTimes(2);

    run.mockReset();
    run.mockRejectedValue(new ScriptStructuredNeedsReviewError(
      'plan',
      new StructuredGenerationError('script_plan', 1, [], []),
    ));
    const failed = await app.inject({
      method: 'POST', url: '/api/plan/script/turn',
      payload: {
        projectId: 'project-1',
        reset: true,
        seedPrompt: '修车铺赛车手',
        answers: [{ field: 'endingDirection', delegate: true }],
      },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe('PROVIDER_ERROR');
    expect(failed.json().error.message).not.toBe('服务器内部错误。');
    expect(run).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it('rejects malformed answers and non-script projects', async () => {
    const director = { run: vi.fn() } as never;
    const checkpoints = new InMemoryScriptCheckpointStore();
    const service = new ScriptPlanTurnService(
      director,
      checkpoints,
      async (id) => ({
        id, name: '小说', kind: 'novel',
        createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
      }),
    );
    const app = Fastify();
    registerScriptPlanRoutes(app, service);

    const malformed = await app.inject({
      method: 'POST', url: '/api/plan/script/turn',
      payload: { projectId: 'project-1', answers: [{ field: 'totalEpisodes', value: {} }] },
    });
    expect(malformed.statusCode).toBe(400);
    const wrongKind = await app.inject({
      method: 'POST', url: '/api/plan/script/turn',
      payload: { projectId: 'project-1', answers: [] },
    });
    expect(wrongKind.statusCode).toBe(400);
    await app.close();
  });

  it('returns three AI concept proposals through the synchronous planning route', async () => {
    const director = { run: vi.fn() } as never;
    const checkpoints = new InMemoryScriptCheckpointStore();
    const service = new ScriptPlanTurnService(
      director,
      checkpoints,
      async (id) => ({
        id, name: '短剧', kind: 'short_drama',
        createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
      }),
    );
    const generate = vi.fn().mockResolvedValue({
      proposals: [{ title: '选题一' }, { title: '选题二' }, { title: '选题三' }],
    });
    const app = Fastify();
    registerScriptPlanRoutes(app, service, { generate } as never);

    const response = await app.inject({
      method: 'POST', url: '/api/plan/script/concepts',
      payload: { projectId: 'project-1', seedPrompt: '家庭情绪勒索' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.proposals).toHaveLength(3);
    expect(body.proposals[0]).toMatchObject({ title: '选题一' });
    expect(generate).toHaveBeenCalledWith(
      'project-1', '家庭情绪勒索', expect.any(AbortSignal),
    );
    await app.close();
  });
});
