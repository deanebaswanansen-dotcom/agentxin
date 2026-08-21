import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/apiClient.js', () => ({
  default: {
    agent: {
      listJobs: vi.fn(),
      watchJob: vi.fn(),
      cancelJob: vi.fn(),
      runStream: vi.fn(),
      run: vi.fn(),
    },
    chapters: { list: vi.fn() },
  },
  isApiClientError: (value: unknown) => value instanceof Error && 'code' in value,
}));

import apiClient from '../../api/apiClient.js';
import { forgetActiveAgentJob, rememberActiveAgentJob } from './activeAgentJob.js';
import { useAgentEngine } from './useAgentEngine.js';

describe('useAgentEngine persistent job recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.agent.listJobs).mockResolvedValue([]);
  });

  afterEach(() => {
    forgetActiveAgentJob();
  });

  it('reconnects a new-project job after refresh and removes the old progress card on completion', async () => {
    const result = {
      task: 'long_novel' as const,
      mode: 'draft' as const,
      projectId: 'project-created',
      summary: '生成完成',
      steps: [],
      artifacts: [],
    };
    rememberActiveAgentJob({
      id: 'job-1',
      task: 'long_novel',
      sourceProjectId: null,
      progressMessageId: 'progress-original',
    });
    vi.mocked(apiClient.agent.watchJob).mockResolvedValue(result);
    const appendMessage = vi.fn();
    const removeMessage = vi.fn();
    const onCompleted = vi.fn();

    renderHook(() => useAgentEngine({
      projectId: null,
      appendMessage,
      updateMessage: vi.fn(),
      removeMessage,
      onCompleted,
    }));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith(result, null));
    expect(apiClient.agent.listJobs).not.toHaveBeenCalled();
    expect(apiClient.agent.watchJob).toHaveBeenCalledWith('job-1', expect.any(Object));
    expect(removeMessage).toHaveBeenCalledWith('progress-original');
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'progress-original', kind: 'agent-progress', task: 'long_novel',
    }));
  });

  it('recovers a remembered job after refresh even when projectId is still null', async () => {
    const result = {
      task: 'full_novel' as const,
      mode: 'draft' as const,
      projectId: 'project-created',
      summary: '生成完成',
      steps: [],
      artifacts: [],
    };
    rememberActiveAgentJob({
      id: 'job-2',
      task: 'full_novel',
      sourceProjectId: 'project-created',
      progressMessageId: 'progress-2',
    });
    vi.mocked(apiClient.agent.watchJob).mockResolvedValue(result);
    const onCompleted = vi.fn();

    renderHook(() => useAgentEngine({
      projectId: null,
      appendMessage: vi.fn(),
      updateMessage: vi.fn(),
      removeMessage: vi.fn(),
      onCompleted,
    }));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith(result, 'project-created'));
    expect(apiClient.agent.listJobs).not.toHaveBeenCalled();
    expect(apiClient.agent.watchJob).toHaveBeenCalledWith('job-2', expect.objectContaining({
      deliveredEvents: 0,
    }));
  });

  it('does not replay already delivered listJobs events', async () => {
    const event = { phase: 'chapter' as const, message: '第1章完成' };
    vi.mocked(apiClient.agent.listJobs).mockResolvedValue([{
      id: 'job-list',
      status: 'running',
      events: [event],
      request: { task: 'long_novel', mode: 'draft', prompt: 'x', projectId: 'p-1' },
    }]);
    vi.mocked(apiClient.agent.watchJob).mockResolvedValue({
      task: 'long_novel', mode: 'draft', projectId: 'p-1', summary: '完成', steps: [], artifacts: [],
    });
    const appendMessage = vi.fn();

    renderHook(() => useAgentEngine({
      projectId: 'p-1',
      appendMessage,
      updateMessage: vi.fn(),
      removeMessage: vi.fn(),
    }));

    await waitFor(() => expect(apiClient.agent.watchJob).toHaveBeenCalled());
    expect(apiClient.agent.watchJob).toHaveBeenCalledWith('job-list', expect.objectContaining({
      deliveredEvents: 1,
    }));
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent-job:job-list:progress',
      kind: 'agent-progress',
      events: [event],
    }));
  });
});
