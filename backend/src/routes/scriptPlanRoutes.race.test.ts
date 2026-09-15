import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerClientScope } from '../services/client/clientScope.js';
import {
  InMemoryScriptCheckpointStore,
  ScriptDirector,
  type ScriptDirectorRequest,
  type ScriptDirectorResult,
  type ScriptModelAdapter,
} from '../services/script/agents/ScriptDirector.js';
import { latestScriptCheckpoint } from '../services/script/agents/ScriptCheckpoint.js';
import { SCRIPT_PLANNING_FIELDS } from '../services/script/agents/ScriptPlanningAgent.js';
import { ScriptPlanTurnService } from '../services/script/agents/ScriptPlanTurnService.js';
import { ScriptModelOutputError } from '../services/script/agents/structuredOutput.js';
import type { ScriptStore } from '../services/script/ScriptStore.js';
import { registerScriptPlanRoutes } from './scriptPlanRoutes.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

const projectLookup = async (id: string) => ({
  id, name: '短剧', kind: 'short_drama' as const,
  createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
});
const questions: ScriptDirectorResult = {
  kind: 'planning_questions',
  questions: [{ field: 'genres', prompt: '题材？' }],
  askedFields: ['genres'], questionCount: 1,
};
const delegatedAnswers = SCRIPT_PLANNING_FIELDS.map((field) => ({ field, delegate: true }));

describe('script plan route session ownership', () => {
  it('keeps B as the latest session when reset A fails late and C continues', async () => {
    const firstEntered = deferred<void>();
    const firstResult = deferred<ScriptDirectorResult>();
    const run = vi.fn(async (request: ScriptDirectorRequest): Promise<ScriptDirectorResult> => {
      if (request.task === 'script_plan' && request.seedPrompt === '旧灵感 A') {
        firstEntered.resolve();
        return firstResult.promise;
      }
      return questions;
    });
    const checkpoints = new InMemoryScriptCheckpointStore();
    const service = new ScriptPlanTurnService({ run }, checkpoints, projectLookup);
    const app = Fastify();
    registerScriptPlanRoutes(app, service);
    try {
      const requestA = app.inject({
        method: 'POST', url: '/api/plan/script/turn',
        payload: { projectId: 'project-1', reset: true, seedPrompt: '旧灵感 A', draft: { title: '旧草稿 A' } },
      }).then((response) => response);
      await firstEntered.promise;
      const responseB = await app.inject({
        method: 'POST', url: '/api/plan/script/turn',
        payload: { projectId: 'project-1', reset: true, seedPrompt: '新灵感 B', draft: { title: '新草稿 B' } },
      });
      expect(responseB.statusCode).toBe(200);
      firstResult.reject(new ScriptModelOutputError('无有效模型内容'));
      const responseA = await requestA;
      expect(responseA.statusCode).toBe(409);
      expect(responseA.json().error.code).toBe('CONFLICT');

      const responseC = await app.inject({
        method: 'POST', url: '/api/plan/script/turn', payload: { projectId: 'project-1', answers: [] },
      });
      expect(responseC.statusCode).toBe(200);
      expect(responseC.json().session).toBe(responseB.json().session);
      expect(run.mock.calls[2]?.[0]).toMatchObject({ seedPrompt: '新灵感 B', draft: { title: '新草稿 B' } });
      const history = await checkpoints.list('project-1', 'script_plan_session');
      expect(history.map((item) => item.status)).toEqual(['running', 'running']);
      expect(history.map((item) => item.artifactRevision)).toEqual([0, 1]);
    } finally {
      await app.close();
    }
  });

  it.each(['success', 'failure'] as const)(
    'cancels the real Director before an obsolete %s can persist a plan or return ready', async (outcome) => {
      const modelEntered = deferred<void>();
      const modelResult = deferred<string>();
      let modelSignal: AbortSignal | undefined;
      const savePlan = vi.fn();
      const checkpoints = new InMemoryScriptCheckpointStore();
      const model: ScriptModelAdapter = {
        complete: async (request) => {
          modelSignal = request.signal;
          modelEntered.resolve();
          // Deliberately ignore cancellation, as an already-returning provider may.
          return modelResult.promise;
        },
      };
      const director = new ScriptDirector({
        store: { getProjectState: async () => undefined, savePlan } as unknown as ScriptStore,
        checkpoints, model,
      });
      const service = new ScriptPlanTurnService(director, checkpoints, projectLookup);
      const app = Fastify();
      registerScriptPlanRoutes(app, service);
      try {
        const requestA = app.inject({
          method: 'POST', url: '/api/plan/script/turn',
          payload: { projectId: 'project-1', reset: true, seedPrompt: '旧灵感 A', draft: { title: '旧草稿 A' }, answers: delegatedAnswers },
        }).then((response) => response);
        await modelEntered.promise;
        const responseB = await app.inject({
          method: 'POST', url: '/api/plan/script/turn',
          payload: { projectId: 'project-1', reset: true, seedPrompt: '新灵感 B', draft: { title: '新草稿 B' } },
        });
        expect(responseB.statusCode).toBe(200);
        expect(responseB.json().status).toBe('asking');
        expect(modelSignal?.aborted).toBe(true);
        if (outcome === 'success') {
          modelResult.resolve(JSON.stringify({ title: '过期策划', logline: '女骑士用账本揭穿领主阴谋。', coreConflict: '女骑士反抗伪造王命的领主。' }));
        } else {
          modelResult.reject(new ScriptModelOutputError('迟到的无效内容'));
        }
        const responseA = await requestA;
        expect(responseA.statusCode).toBe(409);
        expect(savePlan).not.toHaveBeenCalled();
        expect(await checkpoints.list('project-1', 'script_plan')).toEqual([]);

        const responseC = await app.inject({
          method: 'POST', url: '/api/plan/script/turn',
          payload: { projectId: 'project-1', answers: [{ field: 'genres', value: ['校园青春'] }] },
        });
        expect(responseC.statusCode).toBe(200);
        expect(responseC.json().session).toBe(responseB.json().session);
        expect(latestScriptCheckpoint(await checkpoints.list('project-1', 'script_plan_session'), { node: 'plan' })?.artifact).toMatchObject({
          seedPrompt: '新灵感 B', draft: { title: '新草稿 B' }, values: { genres: ['校园青春'] },
        });
      } finally {
        await app.close();
      }
    },
  );

  it('does not let an obsolete finally release the new operation or overlap same-session turns', async () => {
    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    const resultA = deferred<ScriptDirectorResult>();
    const resultB = deferred<ScriptDirectorResult>();
    const run = vi.fn(async (request: ScriptDirectorRequest) => {
      if (request.task === 'script_plan' && request.seedPrompt === 'A') {
        enteredA.resolve();
        return resultA.promise;
      }
      enteredB.resolve();
      return resultB.promise;
    });
    const service = new ScriptPlanTurnService({ run }, new InMemoryScriptCheckpointStore(), projectLookup);
    const app = Fastify();
    registerScriptPlanRoutes(app, service);
    try {
      const requestA = app.inject({ method: 'POST', url: '/api/plan/script/turn', payload: { projectId: 'p1', reset: true, seedPrompt: 'A' } }).then((response) => response);
      await enteredA.promise;
      const requestB = app.inject({ method: 'POST', url: '/api/plan/script/turn', payload: { projectId: 'p1', reset: true, seedPrompt: 'B' } }).then((response) => response);
      await enteredB.promise;
      resultA.resolve(questions);
      expect((await requestA).statusCode).toBe(409);
      const overlapping = await app.inject({ method: 'POST', url: '/api/plan/script/turn', payload: { projectId: 'p1', answers: [] } });
      expect(overlapping.statusCode).toBe(409);
      expect(run).toHaveBeenCalledTimes(2);
      resultB.resolve(questions);
      expect((await requestB).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it.each(['client', 'project'] as const)('does not cancel another %s scope', async (scope) => {
    const entered = deferred<void>();
    const result = deferred<ScriptDirectorResult>();
    let firstSignal: AbortSignal | undefined;
    const run = vi.fn(async (request: ScriptDirectorRequest) => {
      if (request.task === 'script_plan' && request.seedPrompt === 'A') {
        firstSignal = request.signal;
        entered.resolve();
        return result.promise;
      }
      return questions;
    });
    const app = Fastify();
    registerClientScope(app);
    registerScriptPlanRoutes(app, new ScriptPlanTurnService({ run }, new InMemoryScriptCheckpointStore(), projectLookup));
    try {
      const requestA = app.inject({
        method: 'POST', url: '/api/plan/script/turn', headers: { 'x-agentxin-client-id': 'a'.repeat(64) },
        payload: { projectId: 'p1', reset: true, seedPrompt: 'A' },
      }).then((response) => response);
      await entered.promise;
      const responseB = await app.inject({
        method: 'POST', url: '/api/plan/script/turn', headers: { 'x-agentxin-client-id': (scope === 'client' ? 'b' : 'a').repeat(64) },
        payload: { projectId: scope === 'project' ? 'p2' : 'p1', reset: true, seedPrompt: 'B' },
      });
      expect(responseB.statusCode).toBe(200);
      expect(firstSignal?.aborted).toBe(false);
      result.resolve(questions);
      expect((await requestA).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
