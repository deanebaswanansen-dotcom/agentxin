import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRunResult } from '../types/index.js';
import { AgentCommandCenter, type AgentClient } from './AgentCommandCenter.js';

function result(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    task: 'novel',
    mode: 'draft',
    projectId: 'p1',
    chapterId: 'c1',
    summary: '已生成首章',
    steps: ['已自动创建小说项目。', '已生成并保存第一章正文。'],
    artifacts: [{ kind: 'chapter', id: 'c1', title: '第1章' }],
    ...overrides,
  };
}

describe('AgentCommandCenter', () => {
  it('renders a distinct visual class for each task card', () => {
    const { container } = render(<AgentCommandCenter client={{ agent: { run: vi.fn() } } as unknown as AgentClient} onCompleted={vi.fn()} />);

    [
      'novel',
      'full_novel',
      'auto_next',
      'title',
      'outline',
      'polish',
      'diagnostic',
      'material_research',
      'trope_breakdown',
      'cliche_guard',
      'chapter_diagnosis',
      'workspace_review',
    ].forEach((taskKey) => {
      expect(container.querySelector(`.nwa-task-card--${taskKey}`)).toBeInTheDocument();
    });
  });

  it('runs novel draft automation with task field', async () => {
    const run = vi.fn().mockResolvedValue(result());
    const list = vi.fn().mockResolvedValue([
      { id: 'c1', projectId: 'p1', title: '第1章', content: '正文预览', position: 0 },
    ]);
    const onCompleted = vi.fn();
    const client = { agent: { run }, chapters: { list } } as unknown as AgentClient;
    render(<AgentCommandCenter client={client} onCompleted={onCompleted} />);

    fireEvent.change(screen.getByLabelText('一句话写作需求'), {
      target: { value: '赛博修仙学院' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        task: 'novel',
        mode: 'draft',
        prompt: '赛博修仙学院',
        projectId: undefined,
        chapterId: undefined,
        options: undefined,
      }),
    );
    expect(await screen.findByText('已生成首章')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Agent 执行结果' })).toHaveTextContent('已生成首章');
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({ chapterId: 'c1' }));
  });

  it('sends outline task in reference mode for selected project', async () => {
    const run = vi.fn().mockResolvedValue(result({ task: 'outline', mode: 'reference', chapterId: undefined }));
    const client = { agent: { run } } as unknown as AgentClient;
    const onCompleted = vi.fn();
    render(<AgentCommandCenter client={client} selectedProjectId="p1" onCompleted={onCompleted} />);

    fireEvent.click(screen.getByText('大纲和设定'));
    fireEvent.change(screen.getByLabelText('一句话写作需求'), {
      target: { value: '都市异能' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成方案' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        task: 'outline',
        mode: 'reference',
        prompt: '都市异能',
        projectId: 'p1',
        chapterId: undefined,
        options: undefined,
      }),
    );
  });

  it('shows progress while running', async () => {
    const run = vi.fn().mockReturnValue(new Promise(() => undefined));
    const client = { agent: { run } } as unknown as AgentClient;
    render(<AgentCommandCenter client={client} onCompleted={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('一句话写作需求'), {
      target: { value: '赛博修仙学院' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));

    expect(await screen.findByLabelText('Agent 执行进度')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Agent 思考动画' })).toBeInTheDocument();
    expect(screen.getByText(/已运行/)).toBeInTheDocument();
  });

  it('passes an AbortSignal to streaming agent runs and stops it from the UI', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runStream = vi.fn((_body, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal;
      return new Promise<AgentRunResult>(() => undefined);
    });
    const client = { agent: { runStream } } as unknown as AgentClient;
    render(<AgentCommandCenter client={client} onCompleted={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('一句话写作需求'), {
      target: { value: '赛博修仙学院' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => expect(runStream).toHaveBeenCalled());
    expect(capturedSignal).toBeInstanceOf(AbortSignal);

    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('renders a Lottie completion motion when a task finishes', async () => {
    const run = vi.fn().mockResolvedValue(result());
    const client = { agent: { run } } as unknown as AgentClient;
    render(<AgentCommandCenter client={client} onCompleted={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('一句话写作需求'), {
      target: { value: '赛博修仙学院' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }));

    expect(await screen.findByRole('img', { name: '任务完成动画' })).toHaveAttribute(
      'data-lottie-motion',
      '任务完成动画',
    );
  });

  it('runs workspace review for the selected project without requiring prompt text', async () => {
    const run = vi.fn().mockResolvedValue(result({ task: 'workspace_review', mode: 'reference', chapterId: undefined }));
    const client = { agent: { run } } as unknown as AgentClient;
    render(<AgentCommandCenter client={client} selectedProjectId="p1" onCompleted={vi.fn()} />);

    fireEvent.click(screen.getByText('主动审阅'));
    fireEvent.click(screen.getByRole('button', { name: '审阅当前项目' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        task: 'workspace_review',
        mode: 'reference',
        prompt: '',
        projectId: 'p1',
        chapterId: undefined,
        options: undefined,
      }),
    );
  });

  it('runs material research in reference mode', async () => {
    const run = vi.fn().mockResolvedValue(result({ task: 'material_research', mode: 'reference', chapterId: undefined }));
    const client = { agent: { run } } as unknown as AgentClient;
    render(<AgentCommandCenter client={client} selectedProjectId="p1" onCompleted={vi.fn()} />);

    fireEvent.click(screen.getByText('素材研究'));
    fireEvent.change(screen.getByLabelText('一句话写作需求'), {
      target: { value: '退婚反杀不要老套' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始研究' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        task: 'material_research',
        mode: 'reference',
        prompt: '退婚反杀不要老套',
        projectId: 'p1',
        chapterId: undefined,
        options: undefined,
      }),
    );
  });
});
