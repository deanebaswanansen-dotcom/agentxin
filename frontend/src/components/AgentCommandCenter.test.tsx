import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, NovelPlanTurnResponse } from '../types/index.js';
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

function askingTurn(overrides: Partial<NovelPlanTurnResponse> = {}): NovelPlanTurnResponse {
  return {
    status: 'asking',
    round: 1,
    message: '先定赛道',
    questions: [
      {
        id: 'genre_lane',
        question: '这本书更靠近哪条赛道？',
        options: [
          { id: 'xuanhuan', label: '玄幻 / 修仙', description: '升级打脸' },
          { id: 'dushi', label: '都市 / 异能' },
        ],
      },
    ],
    ...overrides,
  };
}

/** 关闭计划模式，走原来的直接生成路径。 */
function disablePlanMode(): void {
  const checkbox = screen.queryByRole('checkbox');
  if (checkbox && (checkbox as HTMLInputElement).checked) {
    fireEvent.click(checkbox);
  }
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

    disablePlanMode();
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
    disablePlanMode();
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

    disablePlanMode();
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

    disablePlanMode();
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

    disablePlanMode();
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

  it('starts brainstorm plan mode and renders questions', async () => {
    const planTurn = vi.fn().mockResolvedValue(askingTurn());
    const client = { agent: { run: vi.fn(), planTurn } } as unknown as AgentClient;
    render(<AgentCommandCenter client={client} onCompleted={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('一句话写作需求'), {
      target: { value: '赛博修仙学院' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始头脑风暴' }));

    await waitFor(() =>
      expect(planTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          seedPrompt: '赛博修仙学院',
          targetTask: 'novel',
        }),
        expect.anything(),
      ),
    );
    expect(await screen.findByText('先定赛道')).toBeInTheDocument();
    expect(screen.getByText('这本书更靠近哪条赛道？')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /玄幻 \/ 修仙/ })).toBeInTheDocument();
  });

  it('submits plan answers and generates from ready brief', async () => {
    const planTurn = vi
      .fn()
      .mockResolvedValueOnce(askingTurn())
      .mockResolvedValueOnce({
        status: 'ready',
        round: 2,
        message: '方案好了',
        brief: '【brief】赛博修仙学院完整需求',
        planSummary: { title: '代码御剑', genre: '赛博修仙', hook: '写代码御剑' },
      } satisfies NovelPlanTurnResponse);
    const run = vi.fn().mockResolvedValue(result());
    const list = vi.fn().mockResolvedValue([
      { id: 'c1', projectId: 'p1', title: '第1章', content: '正文', position: 0 },
    ]);
    const client = { agent: { run, planTurn }, chapters: { list } } as unknown as AgentClient;
    render(<AgentCommandCenter client={client} onCompleted={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('一句话写作需求'), {
      target: { value: '赛博修仙学院' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始头脑风暴' }));
    expect(await screen.findByText('先定赛道')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /玄幻 \/ 修仙/ }));
    fireEvent.click(screen.getByRole('button', { name: '回答全部问题，继续追问' }));

    await waitFor(() => expect(planTurn).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('方案好了')).toBeInTheDocument();
    expect(screen.getByLabelText('生成用 brief')).toHaveTextContent('赛博修仙学院完整需求');

    fireEvent.click(screen.getByRole('button', { name: '用方案生成' }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          task: 'novel',
          prompt: '【brief】赛博修仙学院完整需求',
        }),
      ),
    );
  });

  it('can skip plan mode and generate directly while plan toggle is on', async () => {
    const run = vi.fn().mockResolvedValue(result());
    const client = { agent: { run, planTurn: vi.fn() } } as unknown as AgentClient;
    render(<AgentCommandCenter client={client} onCompleted={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('一句话写作需求'), {
      target: { value: '直接开写' },
    });
    fireEvent.click(screen.getByRole('button', { name: '跳过，开始生成' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          task: 'novel',
          prompt: '直接开写',
        }),
      ),
    );
  });
});
