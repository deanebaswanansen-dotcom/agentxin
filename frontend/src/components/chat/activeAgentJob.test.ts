import { afterEach, describe, expect, it } from 'vitest';
import {
  forgetActiveAgentJob,
  loadActiveAgentJob,
  rememberActiveAgentJob,
} from './activeAgentJob.js';

afterEach(() => {
  forgetActiveAgentJob();
});

describe('active Agent job recovery state', () => {
  it('persists the job needed to reconnect after a page refresh', () => {
    rememberActiveAgentJob({
      id: 'job-1', task: 'long_novel', sourceProjectId: null, progressMessageId: 'message-1',
    });

    expect(loadActiveAgentJob()).toEqual({
      id: 'job-1',
      task: 'long_novel',
      sourceProjectId: null,
      progressMessageId: 'message-1',
    });
  });

  it('only clears the matching job so an older completion cannot erase a newer run', () => {
    rememberActiveAgentJob({
      id: 'job-new', task: 'full_novel', sourceProjectId: 'p1', progressMessageId: 'message-new',
    });

    forgetActiveAgentJob('job-old');
    expect(loadActiveAgentJob()?.id).toBe('job-new');

    forgetActiveAgentJob('job-new');
    expect(loadActiveAgentJob()).toBeNull();
  });
});
