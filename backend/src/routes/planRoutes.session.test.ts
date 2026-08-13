import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NovelPlanService } from '../services/agent/NovelPlanService.js';
import { PlanSessionStore } from '../services/agent/plan/PlanSessionStore.js';
import { registerPlanRoutes } from './planRoutes.js';

describe('planRoutes persistent project session', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('returns a successful null response when a project has no plan session', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerPlanRoutes(
      app,
      { turn: vi.fn() } as unknown as NovelPlanService,
      PlanSessionStore.ephemeral(),
    );
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/projects/new-project/plan-session',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  it('uses the server-side history on the next answer turn and exposes recovery', async () => {
    const turn = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'asking',
        round: 1,
        message: '先确认主角。',
        questions: [
          {
            id: 'core_protagonist_type',
            question: '主角身份是什么？',
            options: [{ id: 'student', label: '普通学生' }],
          },
        ],
      })
      .mockResolvedValueOnce({
        status: 'asking',
        round: 2,
        message: '继续确认规模。',
        questions: [
          {
            id: 'target_total_words',
            question: '全书多少字？',
            options: [{ id: 'words_100k', label: '约10万字' }],
          },
        ],
      }) as unknown as NovelPlanService['turn'];
    const app = Fastify({ logger: false });
    apps.push(app);
    registerPlanRoutes(
      app,
      { turn } as NovelPlanService,
      PlanSessionStore.ephemeral(),
    );
    await app.ready();

    const first = await app.inject({
      method: 'POST',
      url: '/api/agent/plan/turn',
      payload: {
        projectId: 'project-a',
        seedPrompt: '写校园现实小说',
        targetTask: 'long_novel',
      },
    });
    expect(first.statusCode).toBe(200);

    const restored = await app.inject({
      method: 'GET',
      url: '/api/projects/project-a/plan-session',
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      projectId: 'project-a',
      seedPrompt: '写校园现实小说',
      activeQuestions: [{ id: 'core_protagonist_type' }],
    });

    const second = await app.inject({
      method: 'POST',
      url: '/api/agent/plan/turn',
      payload: {
        projectId: 'project-a',
        seedPrompt: '写校园现实小说',
        history: [],
        answers: [
          {
            questionId: 'core_protagonist_type',
            selectedOptionIds: ['student'],
            selectedOptionLabels: ['普通学生'],
          },
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(turn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        history: expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', content: expect.stringContaining('core_protagonist_type') }),
        ]),
      }),
      expect.any(AbortSignal),
    );

    const nextSession = await app.inject({
      method: 'GET',
      url: '/api/projects/project-a/plan-session',
    });
    expect(nextSession.json()).toMatchObject({
      decisions: {
        protagonist_identity: { status: 'answered', value: ['普通学生'] },
        target_total_words: { status: 'asked' },
      },
    });
  });
});
