/**
 * Unit tests for {@link UnifiedChatPanel} (Spec Task 5).
 *
 * Covers:
 *  - Free discussion mode: renders correct UI when chapterId is null.
 *  - Writing mode: renders operation tabs when chapterId is provided.
 *  - Context tag toggling in free discussion mode.
 *  - Clear conversation button.
 *  - Error callback via onError.
 *
 * UnifiedChatPanel imports apiClient directly, so we mock the module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { FreeChatRequestBody, WritingRequestBody } from '../types/index.js';

// Mock the apiClient module
vi.mock('../api/apiClient.js', () => ({
  default: {
    freeChat: { stream: vi.fn() },
    write: vi.fn(),
  },
}));

// Import after mock so we get the mocked version
import apiClient from '../api/apiClient.js';
import { UnifiedChatPanel } from './UnifiedChatPanel.js';

interface StreamController {
  resolve: (full: string) => void;
  reject: (error: unknown) => void;
  onDelta: () => ((delta: string) => void) | undefined;
  body: () => FreeChatRequestBody | WritingRequestBody | undefined;
}

function makeFreeChatController(): StreamController {
  let resolveFn: (full: string) => void = () => {};
  let rejectFn: (error: unknown) => void = () => {};
  let capturedOnDelta: ((delta: string) => void) | undefined;
  let capturedBody: FreeChatRequestBody | undefined;

  vi.mocked(apiClient.freeChat.stream).mockImplementation(
    (_projectId: string, body: FreeChatRequestBody, options?: { onDelta?: (d: string) => void; signal?: AbortSignal }) => {
      capturedBody = body;
      capturedOnDelta = options?.onDelta;
      return new Promise<string>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    },
  );

  return {
    resolve: (full) => resolveFn(full),
    reject: (error) => rejectFn(error),
    onDelta: () => capturedOnDelta,
    body: () => capturedBody,
  };
}

function makeWriteController(): StreamController {
  let resolveFn: (full: string) => void = () => {};
  let rejectFn: (error: unknown) => void = () => {};
  let capturedOnDelta: ((delta: string) => void) | undefined;
  let capturedBody: WritingRequestBody | undefined;

  vi.mocked(apiClient.write).mockImplementation(
    (_projectId: string, _chapterId: string, body: WritingRequestBody, options?: { onDelta?: (d: string) => void; signal?: AbortSignal }) => {
      capturedBody = body;
      capturedOnDelta = options?.onDelta;
      return new Promise<string>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    },
  );

  return {
    resolve: (full) => resolveFn(full),
    reject: (error) => rejectFn(error),
    onDelta: () => capturedOnDelta,
    body: () => capturedBody,
  };
}

function sendInstruction(text: string, label = '讨论输入'): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
}

describe('UnifiedChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom does not implement scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Free discussion mode (chapterId is null)', () => {
    it('renders free discussion UI with context tags', () => {
      render(
        <UnifiedChatPanel projectId="p-1" chapterId={null} />,
      );

      expect(screen.getByText('AI创作顾问')).toBeInTheDocument();
      expect(screen.getByText(/自由讨论模式/)).toBeInTheDocument();
      // Context tags
      expect(screen.getByRole('button', { name: '剧情' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '角色' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '世界观' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '写作技巧' })).toBeInTheDocument();
      // No operation tabs
      expect(screen.queryByRole('tab', { name: '续写' })).not.toBeInTheDocument();
    });

    it('shows empty state hint', () => {
      render(
        <UnifiedChatPanel projectId="p-1" chapterId={null} />,
      );
      expect(screen.getByText(/自由讨论剧情/)).toBeInTheDocument();
    });

    it('toggles context tags', () => {
      render(
        <UnifiedChatPanel projectId="p-1" chapterId={null} />,
      );

      const plotBtn = screen.getByRole('button', { name: '剧情' });
      expect(plotBtn).not.toHaveClass('nwa-context-tag--active');

      fireEvent.click(plotBtn);
      expect(plotBtn).toHaveClass('nwa-context-tag--active');

      // Click again to deselect
      fireEvent.click(plotBtn);
      expect(plotBtn).not.toHaveClass('nwa-context-tag--active');
    });

    it('streams free chat response via apiClient.freeChat.stream', async () => {
      const ctrl = makeFreeChatController();
      render(
        <UnifiedChatPanel projectId="p-1" chapterId={null} />,
      );

      sendInstruction('如何设计好的冲突？');

      expect(await screen.findByText('生成中…')).toBeInTheDocument();

      act(() => ctrl.onDelta()?.('冲突设计'));
      expect(screen.getByText('冲突设计')).toBeInTheDocument();

      await act(async () => {
        ctrl.resolve('冲突设计需要层层递进');
      });

      await waitFor(() => expect(screen.queryByText('生成中…')).not.toBeInTheDocument());
      expect(screen.getByText('冲突设计需要层层递进')).toBeInTheDocument();
    });
  });

  describe('Writing mode (chapterId exists)', () => {
    it('renders writing mode UI with operation tabs', () => {
      render(
        <UnifiedChatPanel
          projectId="p-1"
          chapterId="ch-1"
          editorContent="已有正文"
          onAdopt={vi.fn()}
        />,
      );

      expect(screen.getByText('对话式写作')).toBeInTheDocument();
      expect(screen.getByText(/写作模式/)).toBeInTheDocument();
      // Operation tabs
      expect(screen.getByRole('tab', { name: '续写' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '改写' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '润色' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '提问' })).toBeInTheDocument();
      // No context tags
      expect(screen.queryByRole('button', { name: '剧情' })).not.toBeInTheDocument();
    });

    it('streams writing response and shows adopt button for continue', async () => {
      const ctrl = makeWriteController();
      const onAdopt = vi.fn();
      render(
        <UnifiedChatPanel
          projectId="p-1"
          chapterId="ch-1"
          editorContent="前文"
          onAdopt={onAdopt}
        />,
      );

      sendInstruction('继续写', '写作指令');

      expect(await screen.findByText('生成中…')).toBeInTheDocument();

      await act(async () => {
        ctrl.resolve('新内容');
      });

      await waitFor(() => expect(screen.queryByText('生成中…')).not.toBeInTheDocument());
      expect(screen.getByText('新内容')).toBeInTheDocument();
      // Adopt button visible for continue operation
      expect(screen.getByRole('button', { name: '采用' })).toBeInTheDocument();
    });

    it('"采用" triggers onAdopt with correct result', async () => {
      const ctrl = makeWriteController();
      const onAdopt = vi.fn();
      render(
        <UnifiedChatPanel
          projectId="p-1"
          chapterId="ch-1"
          editorContent="前文"
          onAdopt={onAdopt}
        />,
      );

      sendInstruction('续写', '写作指令');
      await screen.findByText('生成中…');
      await act(async () => {
        ctrl.resolve('新段落');
      });

      fireEvent.click(await screen.findByRole('button', { name: '采用' }));

      expect(onAdopt).toHaveBeenCalledTimes(1);
      const result = onAdopt.mock.calls[0][0];
      expect(result.generated).toBe('新段落');
      expect(result.content).toBe('前文新段落');
    });

    it('"提问" operation calls freeChat.stream instead of write', async () => {
      const ctrl = makeFreeChatController();
      render(
        <UnifiedChatPanel
          projectId="p-1"
          chapterId="ch-1"
          editorContent=""
          onAdopt={vi.fn()}
        />,
      );

      // Switch to "提问" tab
      fireEvent.click(screen.getByRole('tab', { name: '提问' }));

      sendInstruction('这个章节有什么问题？', '写作指令');

      expect(await screen.findByText('生成中…')).toBeInTheDocument();
      expect(apiClient.freeChat.stream).toHaveBeenCalled();

      await act(async () => {
        ctrl.resolve('建议修改节奏');
      });

      await waitFor(() => expect(screen.queryByText('生成中…')).not.toBeInTheDocument());
      expect(screen.getByText('建议修改节奏')).toBeInTheDocument();
    });
  });

  describe('Common features', () => {
    it('clears conversation when "清空对话" is clicked', async () => {
      const ctrl = makeFreeChatController();
      render(
        <UnifiedChatPanel projectId="p-1" chapterId={null} />,
      );

      sendInstruction('你好');
      await screen.findByText('生成中…');
      await act(async () => {
        ctrl.resolve('你好！有什么可以帮你的？');
      });

      await waitFor(() => expect(screen.queryByText('生成中…')).not.toBeInTheDocument());
      expect(screen.getByText('你好！有什么可以帮你的？')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '清空对话' }));

      await waitFor(() =>
        expect(screen.queryByText('你好！有什么可以帮你的？')).not.toBeInTheDocument(),
      );
    });

    it('surfaces errors via onError when stream fails', async () => {
      const ctrl = makeFreeChatController();
      const onError = vi.fn();
      render(
        <UnifiedChatPanel projectId="p-1" chapterId={null} onError={onError} />,
      );

      sendInstruction('测试错误');
      await screen.findByText('生成中…');

      const failure = new Error('网络错误');
      await act(async () => {
        ctrl.reject(failure);
      });

      await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    });

    it('disabled send button when input is empty or streaming', () => {
      render(
        <UnifiedChatPanel projectId="p-1" chapterId={null} />,
      );

      const sendBtn = screen.getByRole('button', { name: '发送' });
      expect(sendBtn).toBeDisabled();

      fireEvent.change(screen.getByLabelText('讨论输入'), { target: { value: '有效输入' } });
      expect(sendBtn).not.toBeDisabled();
    });
  });
});
