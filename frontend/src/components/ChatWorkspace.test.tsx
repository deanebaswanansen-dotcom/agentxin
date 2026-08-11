import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/apiClient.js', () => ({
  default: {
    write: vi.fn(),
    freeChat: { stream: vi.fn() },
    modelConfig: { save: vi.fn() },
    agent: { runStream: vi.fn(), run: vi.fn() },
    chapters: { list: vi.fn() },
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
});
