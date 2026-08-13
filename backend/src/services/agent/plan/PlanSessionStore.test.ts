import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PlanSessionStore, reducePlanSession } from './PlanSessionStore.js';

describe('PlanSessionStore', () => {
  it('restores the active project planning session after a process restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-plan-session-'));
    const file = join(directory, 'sessions.json');
    const store = await PlanSessionStore.create(file);
    const session = reducePlanSession(undefined, {
      projectId: 'project-a',
      seedPrompt: '写一部校园现实小说，不要玄幻',
      response: {
        status: 'asking',
        round: 1,
        message: '先确认关键选择。',
        questions: [
          {
            id: 'core_main_direction',
            question: '校园主线围绕什么展开？',
            options: [{ id: 'campus_growth', label: '学业与成长' }],
          },
        ],
      },
      history: [{ role: 'user', content: '灵感：写一部校园现实小说，不要玄幻' }],
    });
    await store.save(session);

    const reloaded = await PlanSessionStore.create(file);
    const restored = reloaded.get('project-a');

    expect(restored?.seedPrompt).toBe('写一部校园现实小说，不要玄幻');
    expect(restored?.lastResponse.questions?.[0]?.id).toBe('core_main_direction');
    expect(restored?.decisions.main_conflict?.status).toBe('asked');
  });

  it('marks an answered semantic decision and does not leave it active', () => {
    const first = reducePlanSession(undefined, {
      projectId: 'project-a',
      seedPrompt: '写校园故事',
      response: {
        status: 'asking',
        round: 1,
        message: '请选择。',
        questions: [
          {
            id: 'core_protagonist_type',
            question: '主角身份是什么？',
            options: [{ id: 'student', label: '普通学生' }],
          },
        ],
      },
      history: [],
    });

    const next = reducePlanSession(first, {
      projectId: 'project-a',
      seedPrompt: first.seedPrompt,
      answers: [
        {
          questionId: 'core_protagonist_type',
          selectedOptionIds: ['student'],
          selectedOptionLabels: ['普通学生'],
        },
      ],
      response: { status: 'asking', round: 2, message: '继续。', questions: [] },
      history: [],
    });

    expect(next.decisions.protagonist_identity).toMatchObject({
      status: 'answered',
      value: ['普通学生'],
      source: 'user',
    });
    expect(next.activeQuestions).toEqual([]);
  });
});
