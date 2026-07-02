/**
 * 主对话区 —— 对话为中心架构的核心。
 *
 * 整合：
 *  - useChatEngine（文本对话 + 写作流式）
 *  - useAgentEngine（Agent 任务，由斜杠命令触发）
 *  - SlashMenu（/ 命令入口）
 *  - ChatMessageView（消息渲染）
 *  - 输入框 + 发送 + 停止 + 清空
 *
 * 模式自动切换：
 *  - chapterId 存在 → 写作模式（续写/改写/润色/提问 tab）
 *  - chapterId 为空 → 自由讨论模式（主题标签）
 *
 * 输入框行为：
 *  - 首字符 / → 弹出斜杠命令菜单，选择任务后切换到"Agent 任务待执行"状态
 *  - 选中任务后：placeholder 变为任务提示，回车/发送执行 Agent；Esc 退出任务模式
 *  - 普通文本 → 走对话引擎
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import apiClient from '../api/apiClient.js';
import applyAdoption, { type AdoptionTarget } from '../lib/applyAdoption.js';
import type { AgentArtifact, AgentRunResult, Id } from '../types/index.js';
import type { EditorSelection } from './ChapterEditor.js';
import { ChatMessageView } from './ChatMessageView.js';
import { EmptyIllustration } from './EmptyIllustration.js';
import { Icon } from './Icon.js';
import { SlashMenu } from './SlashMenu.js';
import { AGENT_TASKS, type AgentTaskDef } from './chat/agentTasks.js';
import {
  FREE_CHAT_CONTEXT_LABELS,
  FREE_CHAT_CONTEXT_OPTIONS,
  WRITING_OPERATION_LABELS,
  WRITING_OPERATIONS,
  type FreeChatContext,
  type WritingOperation,
} from './chat/types.js';
import { useAgentEngine } from './chat/useAgentEngine.js';
import { useChatEngine } from './chat/useChatEngine.js';
import './components.css';

function hasSlashCommandMatch(input: string): boolean {
  if (!input.startsWith('/')) return false;
  const query = input.slice(1).trim().toLowerCase();
  if (query.length === 0) return true;
  if ('mock'.includes(query) || '演示模式'.includes(query)) return true;
  return AGENT_TASKS.some(
    (task) =>
      task.title.toLowerCase().includes(query) ||
      task.slash.toLowerCase().includes(query) ||
      task.desc.toLowerCase().includes(query),
  );
}

function resolveAdoptionTarget(editorContent: string, selection?: EditorSelection): AdoptionTarget {
  if (selection !== undefined && selection.end > selection.start) {
    return { mode: 'replace', start: selection.start, end: selection.end };
  }
  return { mode: 'insert', position: selection?.start ?? editorContent.length };
}

export interface ChatWorkspaceProps {
  projectId: Id | null;
  projectName?: string;
  chapterId?: Id | null;
  chapterTitle?: string;
  /** 章节编辑器当前正文（写作模式采用定位用）。 */
  editorContent?: string;
  selection?: EditorSelection;
  onError?: (error: unknown) => void;
  /** 流式状态变化（供中央实时预览，与旧架构兼容）。 */
  onStreamingChange?: (state: { streaming: boolean; content: string; thinking: string }) => void;
  /** 写作模式生成文本被"采用"时触发（写回抽屉内的编辑器）。 */
  onAdoptContent?: (content: string) => void;
  /** Agent 任务完成（刷新项目树/加载章节）。 */
  onAgentCompleted?: (result: AgentRunResult) => void;
  /** 点击 artifact 跳转（切资源抽屉 tab / 加载章节）。 */
  onJumpToArtifact?: (artifact: AgentArtifact) => void;
  /** 点击"在编辑器中打开"（打开章节抽屉）。 */
  onOpenChapter?: (chapterId: Id) => void;
}

export function ChatWorkspace({
  projectId,
  projectName,
  chapterId = null,
  chapterTitle,
  editorContent = '',
  selection,
  onError,
  onStreamingChange,
  onAdoptContent,
  onAgentCompleted,
  onJumpToArtifact,
  onOpenChapter,
}: ChatWorkspaceProps): JSX.Element {
  const isWritingMode = chapterId != null;

  // —— 采用回调：把章节预览的生成内容写回抽屉编辑器 ——
  const handleAdoptChapter = useCallback(
    (_messageId: string, generated: string) => {
      const target = resolveAdoptionTarget(editorContent, selection);
      onAdoptContent?.(applyAdoption(editorContent, generated, target));
    },
    [editorContent, selection, onAdoptContent],
  );

  const chat = useChatEngine({
    projectId,
    chapterId,
    editorContent,
    selection,
    onError,
    onStreamingChange,
    onAdoptChapter: handleAdoptChapter,
  });

  const agent = useAgentEngine({
    projectId,
    chapterId,
    onError,
    onCompleted: (result) => {
      chat.carryNextSession();
      onAgentCompleted?.(result);
    },
    appendMessage: chat.appendMessage,
    updateMessage: chat.updateMessage,
    removeMessage: chat.removeMessage,
  });

  // —— 输入框状态 ——
  const [input, setInput] = useState('');
  const [pendingTask, setPendingTask] = useState<AgentTaskDef | null>(null);
  // 整本生成参数
  const [fullNovelChapters, setFullNovelChapters] = useState(3);
  const [fullNovelWords, setFullNovelWords] = useState(1500);
  // 一键 Mock
  const [mockBusy, setMockBusy] = useState(false);
  const [mockDone, setMockDone] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 切换章节时清空待执行任务
  useEffect(() => {
    setPendingTask(null);
  }, [chapterId, projectId]);

  // 自动滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.liveText]);

  // —— 斜杠菜单显示判断 ——
  const showSlashMenu =
    hasSlashCommandMatch(input) && !pendingTask && !chat.streaming && !agent.running;
  const slashQuery = input;

  const handleSelectTask = useCallback((task: AgentTaskDef) => {
    setPendingTask(task);
    setInput('');
    inputRef.current?.focus();
  }, []);

  const handleSelectMock = useCallback(async () => {
    setInput('');
    setMockBusy(true);
    try {
      await apiClient.modelConfig.save({
        baseUrl: 'mock',
        apiKey: 'mock-key-for-demo',
        modelName: 'mock-model',
      });
      setMockDone(true);
    } catch (error) {
      onError?.(error);
    } finally {
      setMockBusy(false);
    }
  }, [onError]);

  const handleCloseSlash = useCallback(() => {
    setInput('');
  }, []);

  // —— 发送 ——
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (chat.streaming || agent.running) return;

    // Agent 任务模式
    if (pendingTask) {
      const needsProject = pendingTask.needsProject === true;
      const needsChapter = pendingTask.needsChapter === true;
      if (needsProject && projectId === null) return;
      if (needsChapter && chapterId === null) return;
      await agent.run({
        task: pendingTask.key,
        prompt: text,
        chapters: fullNovelChapters,
        targetWords: fullNovelWords,
      });
      setPendingTask(null);
      setInput('');
      return;
    }

    // 普通对话
    if (text.length === 0) return;
    setInput('');
    await chat.sendText(text);
  }, [
    input,
    chat,
    agent,
    pendingTask,
    projectId,
    fullNovelChapters,
    fullNovelWords,
    chapterId,
  ]);

  const busy = chat.streaming || agent.running;

  const handleStop = useCallback(() => {
    chat.stop();
    agent.stop();
  }, [chat, agent]);

  const handleClear = useCallback(() => {
    if (busy || chat.messages.length === 0) return;
    setConfirmClearOpen(true);
  }, [busy, chat.messages.length]);

  const doClear = useCallback(() => {
    chat.clear();
    setConfirmClearOpen(false);
  }, [chat]);

  // —— 键盘 ——
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // 斜杠菜单激活时，方向键/Enter/Esc 由 SlashMenu 全局监听处理
      if (showSlashMenu) {
        if (['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) {
          e.preventDefault();
          // 让 SlashMenu 的 window keydown 处理选择和关闭
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void handleSend();
        return;
      }
      if (e.key === 'Escape' && pendingTask) {
        e.preventDefault();
        setPendingTask(null);
      }
    },
    [showSlashMenu, pendingTask, handleSend],
  );

  const canSend =
    !busy &&
    (pendingTask
      ? pendingTask.key === 'auto_next' ||
        pendingTask.key === 'workspace_review' ||
        pendingTask.key === 'chapter_diagnosis' ||
        input.trim().length > 0
      : input.trim().length > 0);

  // 写作模式：选区提示
  const needsSelection = isWritingMode && (chat.operation === 'rewrite' || chat.operation === 'polish');
  const hasSelection = selection !== undefined && selection.end > selection.start;
  const selectedText = hasSelection ? editorContent.slice(selection!.start, selection!.end) : '';

  // placeholder
  const placeholderText = pendingTask
    ? pendingTask.placeholder
    : isWritingMode
      ? `输入${WRITING_OPERATION_LABELS[chat.operation]}指令…（Enter 发送，Shift+Enter 换行）`
      : '输入消息开始对话，或输入 / 选择创作任务…';

  // 空状态提示
  const isEmpty = chat.messages.length === 0 && !chat.streaming && !agent.running;

  // 当前模式标签
  const modeLabel = useMemo(() => {
    if (pendingTask) return `任务：${pendingTask.title}`;
    if (isWritingMode) return `写作模式 · ${chapterTitle ?? ''}`;
    return projectName ? `自由讨论 · ${projectName}` : '自由讨论';
  }, [pendingTask, isWritingMode, chapterTitle, projectName]);

  return (
    <div className="nwa-chat-workspace">
      {/* —— 上下文栏 —— */}
      <div className="nwa-chat-contextbar">
        <span className="nwa-chat-contextbar__mode">{modeLabel}</span>
        <div className="nwa-chat-contextbar__actions">
          {!isEmpty && !busy ? (
            <button
              type="button"
              className="nwa-button nwa-button--ghost nwa-button--sm"
              onClick={handleClear}
              title="清空当前对话"
            >
              清空
            </button>
          ) : null}
        </div>
      </div>

      {confirmClearOpen
        ? createPortal(
            <div className="nwa-modal-overlay">
              <div className="nwa-modal" role="dialog" aria-label="清空对话确认" aria-modal="true">
                <div className="nwa-modal-header">
                  <h2>清空对话</h2>
                  <button
                    type="button"
                    className="nwa-modal-close"
                    onClick={() => setConfirmClearOpen(false)}
                    aria-label="关闭清空对话确认"
                  >
                    <Icon name="x" />
                  </button>
                </div>
                <div className="nwa-modal-body">
                  <p>确定要清空当前上下文的对话记录吗？</p>
                </div>
                <div className="nwa-modal-footer">
                  <button
                    type="button"
                    className="nwa-button nwa-button--ghost"
                    onClick={() => setConfirmClearOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="nwa-button nwa-button--danger"
                    onClick={doClear}
                  >
                    确认清空
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {/* —— 写作模式操作 tab —— */}
      {isWritingMode && !pendingTask ? (
        <div className="nwa-chat-operations" role="tablist" aria-label="写作操作">
          {WRITING_OPERATIONS.map((op) => {
            const active = op === chat.operation;
            return (
              <button
                key={op}
                type="button"
                role="tab"
                aria-selected={active}
                className={`nwa-chat-op${active ? ' nwa-chat-op--active' : ''}`}
                disabled={busy}
                onClick={() => chat.setOperation(op as WritingOperation)}
              >
                {WRITING_OPERATION_LABELS[op]}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* —— 自由讨论主题标签 —— */}
      {!isWritingMode && !pendingTask ? (
        <div className="nwa-chat-context-tags" role="group" aria-label="对话主题">
          {FREE_CHAT_CONTEXT_OPTIONS.map((ctx) => {
            const active = chat.chatContext === ctx;
            return (
              <button
                key={ctx}
                type="button"
                className={`nwa-context-tag${active ? ' nwa-context-tag--active' : ''}`}
                onClick={() => chat.setChatContext(active ? null : (ctx as FreeChatContext))}
                disabled={busy}
              >
                {FREE_CHAT_CONTEXT_LABELS[ctx]}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* —— 改写/润色选区提示 —— */}
      {needsSelection && !pendingTask ? (
        hasSelection ? (
          <p className="nwa-chat__selected">
            选定文本：{selectedText.length > 80 ? `${selectedText.slice(0, 80)}…` : selectedText}
          </p>
        ) : (
          <p className="nwa-muted nwa-chat-hint">
            请先在编辑器中选择要{WRITING_OPERATION_LABELS[chat.operation]}的文本。
          </p>
        )
      ) : null}

      {/* —— 消息流 —— */}
      <div className="nwa-chat-stream" ref={scrollRef} aria-label="对话消息" aria-live="polite">
        {isEmpty ? (
          <div className="nwa-chat-empty">
            <div className="nwa-chat-empty__icon">
              <EmptyIllustration variant={isWritingMode ? 'editor' : projectName ? 'chat' : 'project'} />
            </div>
            <h2 className="nwa-chat-empty__title">
              {isWritingMode ? '开始写作' : '开始你的创作'}
            </h2>
            <p className="nwa-chat-empty__desc">
              {isWritingMode
                ? '向 AI 提出续写、改写、润色或提问。选中正文片段可针对性改写/润色。'
                : projectName
                  ? `在「${projectName}」中讨论剧情、角色、世界观，或输入 / 让 AI 帮你建项目、写章节、生成大纲。`
                  : '输入 / 选择创作任务（一键新书、整本、大纲…），或直接开始对话。没有 API Key？输入 / 选「演示模式」。'}
            </p>
          </div>
        ) : (
          <>
            {chat.messages.map((message) => (
              <ChatMessageView
                key={message.id}
                message={message}
                streaming={busy}
                onAdoptPreview={(id) => chat.adoptPreview(id)}
                onJumpToArtifact={onJumpToArtifact}
                onOpenChapter={(cid) => onOpenChapter?.(cid as Id)}
              />
            ))}
            {/* 流式实时消息 */}
            {chat.streaming && chat.liveText.length === 0 && chat.liveThinking.length === 0 ? (
              <div className="nwa-chat__msg nwa-chat__msg--assistant">
                <span className="nwa-chat__role">AI</span>
                <div className="nwa-chat__content nwa-chat__typing">
                  <span className="nwa-chat__dot" />
                  <span className="nwa-chat__dot" />
                  <span className="nwa-chat__dot" />
                </div>
              </div>
            ) : null}
            {chat.streaming && (chat.liveText.length > 0 || chat.liveThinking.length > 0) ? (
              <div className="nwa-chat__msg nwa-chat__msg--assistant">
                <span className="nwa-chat__role">AI</span>
                {chat.liveThinking ? (
                  <details className="nwa-thinking-details" open>
                    <summary className="nwa-thinking-summary"><Icon name="brain" /> 思考过程</summary>
                    <div className="nwa-thinking-content">{chat.liveThinking}</div>
                  </details>
                ) : null}
                <div className="nwa-chat__content nwa-stream nwa-stream--typing">{chat.liveText || '生成中…'}</div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* —— 待执行任务条 —— */}
      {pendingTask ? (
        <div className="nwa-chat-pending">
          <span className="nwa-chat-pending__label">
            <Icon name={pendingTask.icon} /> {pendingTask.title}
            <button
              type="button"
              className="nwa-button nwa-button--icon"
              onClick={() => setPendingTask(null)}
              title="取消任务"
              aria-label="取消任务"
            >
              <Icon name="x" />
            </button>
          </span>
          {pendingTask.key === 'full_novel' ? (
            <span className="nwa-chat-pending__params">
              <label className="nwa-chat-pending__param">
                章节数
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={fullNovelChapters}
                  disabled={busy}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setFullNovelChapters(Number.isFinite(n) ? Math.min(500, Math.max(1, Math.round(n))) : 3);
                  }}
                />
              </label>
              <label className="nwa-chat-pending__param">
                每章字数
                <input
                  type="number"
                  min={300}
                  max={8000}
                  step={100}
                  value={fullNovelWords}
                  disabled={busy}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setFullNovelWords(Number.isFinite(n) ? Math.min(8000, Math.max(300, Math.round(n))) : 1500);
                  }}
                />
              </label>
              <span className="nwa-muted">
                共约 {(fullNovelChapters * fullNovelWords).toLocaleString()} 字
              </span>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* —— Mock 提示 + NEW-01 强引导 —— */}
      {mockDone ? (
        <div className="nwa-chat-mock-hint">
          <span className="nwa-muted"><Icon name="check" /> 已切换到演示模式，可直接执行任务</span>
        </div>
      ) : (
        <button
          type="button"
          className="nwa-button nwa-button--ghost"
          disabled={mockBusy}
          onClick={() => void handleSelectMock()}
          style={{ alignSelf: 'flex-start', fontSize: '0.8rem', padding: '0.25rem 0.6rem' }}
          title="无需 Key，一键切换本地演示模式，立即可用全部功能包括蓝图分场景"
        >
          {mockBusy ? '切换中…' : '🚀 一键启用 Mock (本地演示) —— 首次无 Key 快速入口'}
        </button>
      )}

      {/* —— 输入区 —— */}
      <div className="nwa-chat-input-area">
        {showSlashMenu ? (
          <SlashMenu
            query={slashQuery}
            hasProject={projectId !== null}
            hasChapter={chapterId !== null}
            onSelectTask={handleSelectTask}
            onSelectMock={() => void handleSelectMock()}
            onClose={handleCloseSlash}
          />
        ) : null}
        <textarea
          ref={inputRef}
          className="nwa-chat-input"
          rows={2}
          placeholder={placeholderText}
          value={input}
          disabled={busy || mockBusy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="对话输入"
        />
        <div className="nwa-chat-input-actions">
          <span className="nwa-muted nwa-chat-input-hint">
            {pendingTask ? 'Enter 执行任务，Esc 取消' : 'Enter 发送，Shift+Enter 换行'}
          </span>
          {busy ? (
            <button
              type="button"
              className="nwa-button nwa-button--danger"
              onClick={handleStop}
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              className="nwa-button"
              disabled={!canSend}
              onClick={() => void handleSend()}
            >
              {pendingTask ? '执行' : '发送'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ChatWorkspace;
