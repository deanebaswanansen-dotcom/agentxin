import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryScriptCheckpointStore } from '../services/script/agents/ScriptDirector.js';
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
    expect(await checkpoints.list('project-1', 'script_plan_session')).toHaveLength(1);
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
});
