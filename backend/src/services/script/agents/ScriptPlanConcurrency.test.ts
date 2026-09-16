import { describe, expect, it, vi } from 'vitest';

import type { ScriptPlan } from '../domain.js';
import { ScriptConflictError, type ScriptStore } from '../ScriptStore.js';
import {
  InMemoryScriptCheckpointStore,
  ScriptDirector,
  ScriptStructuredNeedsReviewError,
} from './ScriptDirector.js';
import { SCRIPT_PLANNING_FIELDS } from './ScriptPlanningAgent.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('script plan concurrent checkpoint append', () => {
  it.each(['valid', 'invalid'] as const)(
    'allocates distinct checkpoint revisions after concurrent invalid and %s generations', async (secondOutcome) => {
      const enteredA = gate();
      const enteredB = gate();
      const finishA = gate();
      const finishB = gate();
      let savedPlan: ScriptPlan | undefined;
      const savePlan = vi.fn(async (plan: ScriptPlan, expectedRevision = 0) => {
        if ((savedPlan?.revision ?? 0) !== expectedRevision) {
          throw new ScriptConflictError(expectedRevision, savedPlan?.revision ?? 0);
        }
        savedPlan = { ...plan, revision: expectedRevision + 1 };
        return structuredClone(savedPlan);
      });
      const checkpoints = new InMemoryScriptCheckpointStore();
      const director = new ScriptDirector({
        store: {
          getProjectState: async () => savedPlan ? { projectId: 'p1', plan: structuredClone(savedPlan) } : undefined,
          savePlan,
        } as unknown as ScriptStore,
        checkpoints,
        model: {
          complete: async (request) => {
            if (request.prompt.includes('SEED_A')) {
              enteredA.release();
              await finishA.promise;
              return '{}';
            }
            enteredB.release();
            await finishB.promise;
            return secondOutcome === 'invalid' ? '{}' : JSON.stringify({
              title: '有效新策划', logline: '女骑士用账本揭穿领主阴谋。', coreConflict: '女骑士反抗伪造王命的领主。',
            });
          },
        },
      });
      const run = (seedPrompt: string) => director.run({
        task: 'script_plan', projectId: 'p1', seedPrompt,
        planningSession: { values: {}, delegatedFields: [...SCRIPT_PLANNING_FIELDS], askedFields: [], questionCount: 0 },
      }).then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
      const requestA = run('SEED_A');
      await enteredA.promise;
      const requestB = run('SEED_B');
      await enteredB.promise;
      finishA.release();
      if (secondOutcome === 'valid') {
        // A has already appended its failure when B commits a valid plan.
        expect((await requestA).error).toBeInstanceOf(ScriptStructuredNeedsReviewError);
      }
      finishB.release();
      const [resultA, resultB] = await Promise.all([requestA, requestB]);
      expect(resultA.error).toBeInstanceOf(ScriptStructuredNeedsReviewError);
      const history = await checkpoints.list('p1', 'script_plan');
      expect(history).toHaveLength(2);
      expect(history.map((item) => item.artifactRevision)).toEqual([0, 1]);
      expect(history[0]?.inputFingerprint).not.toBe(history[1]?.inputFingerprint);
      if (secondOutcome === 'valid') {
        expect(resultB.error).toBeUndefined();
        expect(resultB.value).toMatchObject({ kind: 'plan_draft', plan: { title: '有效新策划', revision: 1 } });
        expect(history.map((item) => item.status)).toEqual(['needs_review', 'succeeded']);
        expect(history[1]?.artifact).toEqual(savedPlan);
        expect(savePlan).toHaveBeenCalledTimes(1);
      } else {
        expect(resultB.error).toBeInstanceOf(ScriptStructuredNeedsReviewError);
        expect(history.map((item) => item.status)).toEqual(['needs_review', 'needs_review']);
        expect(savePlan).not.toHaveBeenCalled();
      }
    },
  );
});
