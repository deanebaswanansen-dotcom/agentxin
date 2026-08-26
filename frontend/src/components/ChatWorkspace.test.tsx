import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/apiClient.js', () => ({
  default: {
    write: vi.fn(),
    freeChat: { stream: vi.fn() },
    modelConfig: { save: vi.fn() },
    agent: {
      runStream: vi.fn(),
      run: vi.fn(),
      planTurn: vi.fn(),
      getPlanSession: vi.fn(),
      clearPlanSession: vi.fn(),
      listJobs: vi.fn(),
      watchJob: vi.fn(),
      cancelJob: vi.fn(),
    },
    chapters: { list: vi.fn() },
    references: {
      import: vi.fn(),
      analyze: vi.fn(),
      transfer: vi.fn(),
    },
  },
}));

import apiClient from '../api/apiClient.js';
import {
  formatPlanAnswersForHistory,
  formatPlanQuestionsForHistory,
} from '../lib/planHistory.js';
import { ChatWorkspace } from './ChatWorkspace.js';

function mockWriteResponse(content: string): void {
  vi.mocked(apiClient.write).mockResolvedValue(content);
}

describe('ChatWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(apiClient.agent.getPlanSession).mockResolvedValue(null);
    vi.mocked(apiClient.agent.clearPlanSession).mockResolvedValue(undefined);
    vi.mocked(apiClient.agent.listJobs).mockResolvedValue([]);
  });

  it('serializes plan question and option ids into history', () => {
    expect(
      formatPlanAnswersForHistory(
        [{ questionId: 'words_per_chapter', selectedOptionIds: ['wpc_2000'] }],
        [
          {
            id: 'words_per_chapter',
            question: '每一章目标字数？',
            options: [{ id: 'wpc_2000', label: '约 2000 字' }],
          },
        ],
      ),
    ).toBe('- words_per_chapter: wpc_2000 | 每一章目标字数？ → 约 2000 字');
  });

  it('stores asked question ids and text so later turns cannot repeat them', () => {
    expect(
      formatPlanQuestionsForHistory('只确认核心方向。', [
        {
          id: 'main_direction',
          question: '主线更偏向哪种方向？',
          impactScore: 9,
          options: [
            { id: 'adventure', label: '冒险成长' },
            { id: 'agent', label: 'Agent 自己决定' },
          ],
        },
      ]),
    ).toContain('PLAN_QUESTION[main_direction] score=9: 主线更偏向哪种方向？');
  });

  it('adopts generated writing text at the caret instead of replacing the whole chapter', async () => {
    mockWriteResponse('续写段落');
    const onAdoptContent = vi.fn();

    render(
      <ChatWorkspace
        projectId="p-1"
        chapterId="ch-1"
        editorContent="已有正文"
        selection={{ start: 4, end: 4 }}
        onAdoptContent={onAdoptContent}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), {
      target: { value: '继续写' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(apiClient.write).toHaveBeenCalled());
    await screen.findByText('续写段落');
    fireEvent.click(screen.getByRole('button', { name: '采用到正文' }));

    expect(onAdoptContent).toHaveBeenCalledWith('已有正文续写段落');
  });

  it('adopts generated writing text by replacing the selected range', async () => {
    mockWriteResponse('替换段落');
    const onAdoptContent = vi.fn();

    render(
      <ChatWorkspace
        projectId="p-1"
        chapterId="ch-1"
        editorContent="已有正文"
        selection={{ start: 2, end: 4 }}
        onAdoptContent={onAdoptContent}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '改写' }));
    fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), {
      target: { value: '改写选区' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(apiClient.write).toHaveBeenCalled());
    await screen.findByText('替换段落');
    fireEvent.click(screen.getByRole('button', { name: '采用到正文' }));

    expect(onAdoptContent).toHaveBeenCalledWith('已有替换段落');
  });

  it('lists plan mode slash command', async () => {
    render(
      <ChatWorkspace projectId={null} onError={vi.fn()} onAgentCompleted={vi.fn()} />,
    );
    const input = screen.getByLabelText('对话输入');
    fireEvent.change(input, { target: { value: '/计' } });
    expect(await screen.findByText(/Agent 先理解目标与硬约束/)).toBeInTheDocument();
  });

  it('stops reference analysis without leaving the workspace disabled', async () => {
    const onError = vi.fn();
    let analyzeSignal: AbortSignal | undefined;
    vi.mocked(apiClient.references.import).mockResolvedValue({
      reference: {
        id: 'ref-1',
        title: '测试参考书',
        depth: 'standard',
        status: 'imported',
        chapterCount: 1,
        wordCount: 120,
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      },
      chaptersDetected: 1,
      wordCount: 120,
      message: '已识别 1 章',
      chapters: [{
        id: 'ref-ch-1',
        number: 1,
        title: '第一章',
        wordCount: 120,
        contentPreview: '正文预览',
      }],
    });
    vi.mocked(apiClient.references.analyze).mockImplementation((_id, _body, signal) => {
      analyzeSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    });

    render(<ChatWorkspace projectId="p-1" projectName="测试项目" onError={onError} />);

    const input = screen.getByRole('textbox', { name: '对话输入' });
    fireEvent.change(input, { target: { value: '/参' } });
    fireEvent.click(await screen.findByRole('option', { name: /\/参考 · 小说内容拆解/ }));
    fireEvent.change(input, {
      target: { value: `名称：测试参考书\n\n第一章\n${'这是用于参考分析取消测试的正文。'.repeat(8)}` },
    });
    fireEvent.click(screen.getByRole('button', { name: '执行' }));

    const analyzeButton = await screen.findByRole('button', { name: '分析选中的 1 章' });
    fireEvent.click(analyzeButton);
    await waitFor(() => expect(apiClient.references.analyze).toHaveBeenCalledWith(
      'ref-1',
      { chapterIds: ['ref-ch-1'], depth: 'standard' },
      expect.any(AbortSignal),
    ));
    expect(input).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '停止' }));

    await waitFor(() => expect(analyzeSignal?.aborted).toBe(true));
    expect(input).toBeEnabled();
    expect(await screen.findByRole('button', { name: '分析选中的 1 章' })).toBeEnabled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('opens plan configuration before sending a direct /计划 command', async () => {
    render(<ChatWorkspace projectId={null} onError={vi.fn()} />);

    const input = screen.getByRole('textbox', { name: '对话输入' });
    fireEvent.change(input, { target: { value: '/计划 写本小说' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByLabelText('小说计划配置')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '对话输入' })).toHaveValue('写本小说');
    expect(apiClient.agent.runStream).not.toHaveBeenCalled();
  });

  it('shows the selected slash task title without leaking the icon key', async () => {
    render(<ChatWorkspace projectId="p-1" projectName="测试项目" />);

    fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), {
      target: { value: '/大纲' },
    });
    fireEvent.click(screen.getByRole('option', { name: /\/大纲 · 大纲和设定/ }));

    expect(screen.getByText('任务：大纲和设定')).toBeInTheDocument();
    expect(screen.queryByText(/map/)).not.toBeInTheDocument();
  });

  it('runs workspace review from slash menu without requiring prompt text', async () => {
    vi.mocked(apiClient.agent.runStream).mockResolvedValue({
      task: 'workspace_review',
      mode: 'reference',
      projectId: 'p-1',
      summary: '已主动审阅当前项目',
      steps: ['已读取项目快照'],
      artifacts: [{ kind: 'outline', id: 'o-1', title: '主动审阅报告' }],
    });

    render(<ChatWorkspace projectId="p-1" projectName="测试项目" />);

    fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), {
      target: { value: '/审阅' },
    });
    fireEvent.click(screen.getByRole('option', { name: /\/审阅 · 主动审阅/ }));

    const execute = screen.getByRole('button', { name: '执行' });
    expect(execute).toBeEnabled();
    fireEvent.click(execute);

    await waitFor(() => {
      expect(apiClient.agent.runStream).toHaveBeenCalledWith(
        expect.objectContaining({ task: 'workspace_review', prompt: '', projectId: 'p-1' }),
        expect.any(Object),
      );
    });
    expect(await screen.findByText('已主动审阅当前项目')).toBeInTheDocument();
  });

  it('renders a typing cursor on live streaming text', async () => {
    vi.mocked(apiClient.freeChat.stream).mockImplementation((_projectId, _body, options) => {
      options?.onDelta?.('片段');
      return new Promise(() => undefined);
    });

    render(<ChatWorkspace projectId="p-1" projectName="测试项目" />);

    fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), {
      target: { value: '继续聊' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    const liveText = await screen.findByText('片段');
    expect(liveText).toHaveClass('nwa-stream--typing');
  });

  it('restores persisted chat history for the same project session', async () => {
    let finishStream!: () => void;
    vi.mocked(apiClient.freeChat.stream).mockImplementation((_projectId, _body, options) => {
      options?.onDelta?.('历史回执');
      return new Promise((resolve) => {
        finishStream = () => resolve('历史回执');
      });
    });

    const firstRender = render(<ChatWorkspace projectId="p-1" projectName="测试项目" />);

    fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), {
      target: { value: '记录这轮对话' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('历史回执')).toBeInTheDocument();
    finishStream();
    await waitFor(() => {
      expect(window.localStorage.getItem('nwa.chatSessions.v1')).toContain('历史回执');
    });
    firstRender.unmount();

    render(<ChatWorkspace projectId="p-1" projectName="测试项目" />);

    expect(screen.getByText('记录这轮对话')).toBeInTheDocument();
    expect(screen.getByText('历史回执')).toBeInTheDocument();
  });

  it('keeps project Agent history visible when selecting a chapter in the same project', async () => {
    window.localStorage.setItem('nwa.chatSessions.v1', JSON.stringify({
      'p-shared:free': [{ id: 'shared-message', role: 'assistant', kind: 'text', content: '项目级回复' }],
    }));
    const view = render(<ChatWorkspace projectId="p-shared" projectName="同一项目" chapterId={null} />);
    expect(screen.getByText('项目级回复')).toBeInTheDocument();

    view.rerender(<ChatWorkspace projectId="p-shared" projectName="同一项目" chapterId="chapter-1" />);
    expect(await screen.findByText('项目级回复')).toBeInTheDocument();
  });

  it('restores a completed background task when returning to its project', async () => {
    vi.mocked(apiClient.agent.listJobs).mockResolvedValue([{
      id: 'completed-job',
      status: 'completed',
      events: [],
      request: {
        task: 'long_novel',
        mode: 'draft',
        prompt: '写完整本',
        projectId: 'p-restored',
      },
      result: {
        task: 'long_novel',
        mode: 'draft',
        projectId: 'p-restored',
        summary: '离开项目期间已完成 20 章',
        steps: ['已保存全部章节'],
        artifacts: [],
      },
    }]);

    render(<ChatWorkspace projectId="p-restored" projectName="恢复项目" />);

    expect(await screen.findByText('离开项目期间已完成 20 章')).toBeInTheDocument();
    expect(apiClient.agent.watchJob).not.toHaveBeenCalled();
  });

  it('starts a fresh project-scoped plan session', async () => {
    vi.mocked(apiClient.agent.planTurn).mockResolvedValue({
      status: 'asking',
      sessionId: 'session-1',
      round: 1,
      message: '先确认校园主线。',
      questions: [
        {
          id: 'core_main_direction',
          question: '校园主线围绕什么展开？',
          options: [{ id: 'growth', label: '学业与成长' }],
        },
      ],
    });
    render(<ChatWorkspace projectId="p-1" projectName="校园故事" />);

    fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), {
      target: { value: '/计划 写校园现实小说' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByLabelText('小说计划配置');
    fireEvent.click(screen.getByRole('button', { name: '执行' }));

    await waitFor(() => {
      expect(apiClient.agent.planTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'p-1',
          resetSession: true,
          seedPrompt: '写校园现实小说',
        }),
        expect.any(AbortSignal),
      );
    });
  });

  it('restores the latest plan question when returning to a project', async () => {
    vi.mocked(apiClient.agent.getPlanSession).mockResolvedValue({
      id: 'session-1',
      projectId: 'p-1',
      seedPrompt: '写校园现实小说',
      targetTask: 'long_novel',
      history: [],
      activeQuestions: [
        {
          id: 'core_protagonist_type',
          question: '主角在学校中的身份是什么？',
          options: [{ id: 'student', label: '普通学生' }],
        },
      ],
      decisions: {},
      lastResponse: {
        status: 'asking',
        sessionId: 'session-1',
        round: 2,
        message: '继续确认主角。',
        questions: [
          {
            id: 'core_protagonist_type',
            question: '主角在学校中的身份是什么？',
            options: [{ id: 'student', label: '普通学生' }],
          },
        ],
      },
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:01.000Z',
    });

    render(<ChatWorkspace projectId="p-1" projectName="校园故事" />);

    expect(await screen.findByText('继续确认主角。')).toBeInTheDocument();
    expect(screen.getByText('主角在学校中的身份是什么？')).toBeInTheDocument();
  });

  it('does not carry a completed same-project task into a newly selected project', async () => {
    vi.mocked(apiClient.agent.runStream).mockResolvedValue({
      task: 'workspace_review',
      mode: 'reference',
      projectId: 'p-1',
      summary: '旧项目审阅结果',
      steps: ['已读取旧项目'],
      artifacts: [],
    });

    const view = render(<ChatWorkspace projectId="p-1" projectName="旧项目" />);
    fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), {
      target: { value: '/审阅' },
    });
    fireEvent.click(screen.getByRole('option', { name: /\/审阅 · 主动审阅/ }));
    fireEvent.click(screen.getByRole('button', { name: '执行' }));

    expect(await screen.findByText('旧项目审阅结果')).toBeInTheDocument();
    view.rerender(<ChatWorkspace projectId="p-2" projectName="新项目" />);

    await waitFor(() => {
      expect(screen.queryByText('旧项目审阅结果')).not.toBeInTheDocument();
    });
    expect(screen.getByText('自由讨论 · 新项目')).toBeInTheDocument();
  });

  it('keeps a new-book result visible after the Agent switches to the created project', async () => {
    vi.mocked(apiClient.agent.runStream).mockResolvedValue({
      task: 'novel',
      mode: 'draft',
      projectId: 'p-created',
      chapterId: 'ch-created',
      summary: '新书和首章已创建',
      steps: ['已创建项目', '已写首章'],
      artifacts: [],
    });
    vi.mocked(apiClient.chapters.list).mockResolvedValue([
      {
        id: 'ch-created',
        projectId: 'p-created',
        title: '第一章',
        content: '首章正文',
        position: 0,
      },
    ]);

    function ProjectSwitchHarness(): JSX.Element {
      const [context, setContext] = useState<{ projectId: string | null; chapterId: string | null }>({
        projectId: null,
        chapterId: null,
      });
      return (
        <ChatWorkspace
          key={context.projectId ?? 'no-project'}
          projectId={context.projectId}
          chapterId={context.chapterId}
          onAgentCompleted={(result) => {
            setContext({
              projectId: result.projectId,
              chapterId: result.chapterId ?? null,
            });
          }}
        />
      );
    }

    render(<ProjectSwitchHarness />);
    fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), {
      target: { value: '/新书' },
    });
    fireEvent.click(screen.getByRole('option', { name: /\/新书 · 一键创建新书/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), {
      target: { value: '东方奇幻冒险' },
    });
    fireEvent.click(screen.getByRole('button', { name: '执行' }));

    expect(await screen.findByText('新书和首章已创建')).toBeInTheDocument();
  });
});
