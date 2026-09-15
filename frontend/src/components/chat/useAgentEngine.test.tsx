import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/apiClient.js', () => ({
  default: {
    agent: {
      listJobs: vi.fn(),
      watchJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      runStream: vi.fn(),
      run: vi.fn(),
    },
    chapters: { list: vi.fn() },
  },
  isApiClientError: (value: unknown) => value instanceof Error && 'code' in value,
}));

import apiClient from '../../api/apiClient.js';
import { forgetActiveAgentJob, loadActiveAgentJob, rememberActiveAgentJob } from './activeAgentJob.js';
import { useAgentEngine } from './useAgentEngine.js';

describe('useAgentEngine persistent job recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.agent.listJobs).mockResolvedValue([]);
  });

  afterEach(() => {
    forgetActiveAgentJob();
  });

  const pausedResult = {
    task: 'full_novel' as const, mode: 'draft' as const, projectId: 'p-1',
    summary: '已保存部分章节', steps: [], artifacts: [],
    outcome: { status: 'paused' as const, code: 'QUALITY_GATE', message: '请检查草稿后继续' },
  };

  it('releases the editor on pause and resumes the same job only on explicit action', async () => {
    const appendMessage = vi.fn();
    const onStreamingChange = vi.fn();
    const onCompleted = vi.fn();
    const options = { projectId: 'p-1', appendMessage, updateMessage: vi.fn(), removeMessage: vi.fn(), onStreamingChange, onCompleted };
    vi.mocked(apiClient.agent.runStream).mockImplementation(async (_body, stream) => {
      stream?.onJobCreated?.('job-paused');
      return pausedResult;
    });
    const { result } = renderHook(() => useAgentEngine(options));
    await act(() => result.current.run({ task: 'full_novel', prompt: '开始生成' }));
    expect(result.current.running).toBe(false);
    expect(result.current.pausedJob?.id).toBe('job-paused');
    expect(loadActiveAgentJob()?.id).toBe('job-paused');
    expect(onStreamingChange).toHaveBeenLastCalledWith({ streaming: false, content: '', thinking: '' });
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent-result', outcome: pausedResult.outcome }));
    expect(apiClient.agent.resumeJob).not.toHaveBeenCalled();

    vi.mocked(apiClient.agent.resumeJob).mockResolvedValue({ id: 'job-paused', status: 'queued', events: [{ phase: 'info', message: '旧进度' }] });
    const completed = { ...pausedResult, summary: '完成', outcome: { status: 'completed' as const } };
    vi.mocked(apiClient.agent.watchJob).mockResolvedValue(completed);
    await act(() => result.current.resume());
    expect(apiClient.agent.resumeJob).toHaveBeenCalledWith('job-paused', expect.any(AbortSignal));
    expect(apiClient.agent.watchJob).toHaveBeenCalledWith('job-paused', expect.objectContaining({ deliveredEvents: 1 }));
    expect(apiClient.agent.runStream).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenLastCalledWith(completed, 'p-1');
    expect(result.current.running).toBe(false);
    expect(result.current.pausedJob).toBeNull();
    expect(loadActiveAgentJob()).toBeNull();
  });

  it('restores a structured pause after refresh without resuming generation and keeps it retryable after resume failure', async () => {
    vi.mocked(apiClient.agent.listJobs).mockResolvedValue([{
      id: 'job-refresh', status: 'waiting_user', events: [], result: pausedResult,
      request: { task: 'full_novel', mode: 'draft', projectId: 'p-1', prompt: '生成' },
    }]);
    vi.mocked(apiClient.agent.watchJob).mockResolvedValue(pausedResult);
    const onError = vi.fn();
    const onStreamingChange = vi.fn();
    const options = { projectId: 'p-1', appendMessage: vi.fn(), updateMessage: vi.fn(), removeMessage: vi.fn(), onError, onStreamingChange };
    const { result } = renderHook(() => useAgentEngine(options));
    await waitFor(() => expect(result.current.pausedJob?.id).toBe('job-refresh'));
    expect(result.current.running).toBe(false);
    expect(apiClient.agent.resumeJob).not.toHaveBeenCalled();
    expect(apiClient.agent.runStream).not.toHaveBeenCalled();
    expect(loadActiveAgentJob()?.id).toBe('job-refresh');
    vi.mocked(apiClient.agent.resumeJob).mockRejectedValue(new Error('网络暂不可用'));
    await act(() => result.current.resume());
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '网络暂不可用' }));
    expect(result.current.running).toBe(false);
    expect(result.current.pausedJob?.id).toBe('job-refresh');
    expect(onStreamingChange).toHaveBeenLastCalledWith({ streaming: false, content: '', thinking: '' });
    await act(() => result.current.run({ task: 'full_novel', prompt: '重试' }));
    expect(apiClient.agent.runStream).not.toHaveBeenCalled();
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
