import type { AgentTask, Id } from '../../types/index.js';

const ACTIVE_AGENT_JOB_STORAGE_KEY = 'nwa.activeAgentJob.v1';

export interface ActiveAgentJob {
  id: string;
  task: AgentTask;
  sourceProjectId: Id | null;
  progressMessageId: string;
}

/** Keep just enough browser-local state to reconnect after a refresh or a detached poll. */
export function rememberActiveAgentJob(job: ActiveAgentJob): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ACTIVE_AGENT_JOB_STORAGE_KEY, JSON.stringify(job));
  } catch {
    // Recovery is best effort; storage restrictions must not block generation.
  }
}

export function loadActiveAgentJob(): ActiveAgentJob | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_AGENT_JOB_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ActiveAgentJob>;
    if (
      typeof value.id !== 'string' || value.id.trim().length === 0 ||
      typeof value.task !== 'string' ||
      typeof value.progressMessageId !== 'string' || value.progressMessageId.trim().length === 0 ||
      (value.sourceProjectId !== null && typeof value.sourceProjectId !== 'string')
    ) {
      window.localStorage.removeItem(ACTIVE_AGENT_JOB_STORAGE_KEY);
      return null;
    }
    return value as ActiveAgentJob;
  } catch {
    return null;
  }
}

export function forgetActiveAgentJob(jobId?: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (jobId !== undefined && loadActiveAgentJob()?.id !== jobId) return;
    window.localStorage.removeItem(ACTIVE_AGENT_JOB_STORAGE_KEY);
  } catch {
    // Best effort only.
  }
}
