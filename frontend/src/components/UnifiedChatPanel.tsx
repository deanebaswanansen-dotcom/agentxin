/**
 * 统一对话面板（任务 #2）。
 *
 * 支持两种模式：
 *  - 自由讨论模式（chapterId 为 null/undefined）：可与 AI 自由讨论剧情/角色/世界观/写作技巧。
 *  - 写作模式（chapterId 存在）：保留续写/改写/润色 + 新增"提问"操作。
 *
 * 采用逻辑仅在写作模式的续写/改写/润色时激活。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../api/apiClient.js';
import applyAdoption, { type AdoptionTarget } from '../lib/applyAdoption.js';
import type { ChatTurn, FreeChatRequestBody, Id, WritingRequestBody } from '../types/index.js';
import type { EditorSelection } from './ChapterEditor.js';
import { Icon } from './Icon.js';
import './components.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 写作操作类型（续写/改写/润色/提问）。 */
export type WritingOperation = 'continue' | 'rewrite' | 'polish' | 'ask';

/** 采用某段生成文本后的结果，交由父组件写回编辑器。 */
export interface AdoptionResult {
  /** 应用采用后的完整章节正文。 */
  content: string;
  /** 被采用的生成文本。 */
  generated: string;
  /** 生成文本被应用到的目标位置。 */
  target: AdoptionTarget;
  /** 应用后建议的编辑器光标位置（折叠选区，位于插入/替换文本之后）。 */
  nextSelection: EditorSelection;
}

/** 自由讨论的主题上下文。 */
export type FreeChatContext = 'plot' | 'character' | 'world' | 'writing' | null;

export interface UnifiedChatPanelProps {
  /** 当前项目标识符。 */
  projectId: Id;
  /** 当前章节标识符。null/undefined = 自由讨论模式。 */
  chapterId?: Id | null;
  /** 章节编辑器的当前完整正文（写作模式需要）。 */
  editorContent?: string;
  /** 编辑器当前选区（写作模式需要）。 */
  selection?: EditorSelection;
  /** 采用生成文本后触发（写作模式的采用回调）。 */
  onAdopt?: (result: AdoptionResult) => void;
  /** 错误上抛。 */
  onError?: (error: unknown) => void;
  /** 流式状态变化回调：streaming 为 true 时持续触发，用于中央面板实时预览。 */
  onStreamingChange?: (state: { streaming: boolean; content: string; thinking: string }) => void;
}

// ---------------------------------------------------------------------------
// Internal types & constants
// ---------------------------------------------------------------------------

interface DisplayTurn extends ChatTurn {
  key: string;
}

const OPERATION_LABELS: Record<WritingOperation, string> = {
  continue: '续写',
  rewrite: '改写',
  polish: '润色',
  ask: '提问',
};

const WRITING_OPERATIONS: WritingOperation[] = ['continue', 'rewrite', 'polish', 'ask'];

const CONTEXT_LABELS: Record<string, string> = {
  plot: '剧情',
  character: '角色',
  world: '世界观',
  writing: '写作技巧',
};

const CONTEXT_OPTIONS: FreeChatContext[] = ['plot', 'character', 'world', 'writing'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function resolveTarget(editorContent: string, selection?: EditorSelection): AdoptionTarget {
  if (selection !== undefined && selection.end > selection.start) {
    return { mode: 'replace', start: selection.start, end: selection.end };
  }
  const position = selection !== undefined ? selection.start : editorContent.length;
  return { mode: 'insert', position };
}

function caretAfter(target: AdoptionTarget, generatedLength: number): number {
  const base = target.mode === 'insert' ? target.position : target.start;
  return base + generatedLength;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * 统一对话面板。根据 chapterId 自动切换自由讨论/写作模式。
 */
export function UnifiedChatPanel({
  projectId,
  chapterId,
  editorContent = '',
  selection,
  onAdopt,
  onError,
  onStreamingChange,
}: UnifiedChatPanelProps): JSX.Element {
  // 模式判断
  const isWritingMode = chapterId != null;

  // 写作模式状态
  const [operation, setOperation] = useState<WritingOperation>('continue');
  // 自由讨论模式的主题上下文
  const [chatContext, setChatContext] = useState<FreeChatContext>(null);

  // 共用对话状态
  const [instruction, setInstruction] = useState('');
  const [turns, setTurns] = useState<DisplayTurn[]>([]);
  const [liveText, setLiveText] = useState('');
  const [liveThinking, setLiveThinking] = useState('');
  const [streaming, setStreaming] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const turnSeq = useRef(0);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // 卸载时中止进行中的流
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // 自动滚到底部
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, liveText]);

  const nextKey = useCallback((): string => {
    turnSeq.current += 1;
    return `turn-${turnSeq.current}`;
  }, []);

  // 写作模式：选区相关
  const needsSelection = isWritingMode && (operation === 'rewrite' || operation === 'polish');
  const hasSelection = selection !== undefined && selection.end > selection.start;
  const selectedText = hasSelection ? editorContent.slice(selection.start, selection.end) : '';

  // 是否显示采用按钮（写作模式 + 非提问操作）
  const showAdopt = isWritingMode && operation !== 'ask';

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleSend = useCallback(async () => {
    const text = instruction.trim();
    if (text.length === 0 || streaming) return;

    const sessionHistory: ChatTurn[] = turns.map(({ role, content }) => ({ role, content }));

    // 立即把用户指令加入会话
    setTurns((prev) => [...prev, { key: nextKey(), role: 'user', content: text }]);
    setInstruction('');
    setLiveText('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let accumulated = '';
    let accumulatedThinking = '';

    try {
      let full: string;

      if (!isWritingMode || operation === 'ask') {
        // 自由讨论模式 或 写作模式的"提问"→ 调用 freeChat.stream
        const body: FreeChatRequestBody = {
          message: text,
          context: isWritingMode ? null : chatContext,
          sessionHistory,
        };
        if (isWritingMode && chapterId) {
          body.chapterId = chapterId;
        }
        full = await apiClient.freeChat.stream(projectId, body, {
          signal: controller.signal,
          onDelta: (delta) => {
            accumulated += delta;
            setLiveText(accumulated);
            onStreamingChange?.({ streaming: true, content: accumulated, thinking: accumulatedThinking });
          },
          onThinking: (delta) => {
            accumulatedThinking += delta;
            setLiveThinking(accumulatedThinking);
            onStreamingChange?.({ streaming: true, content: accumulated, thinking: accumulatedThinking });
          },
        });
      } else {
        // 写作模式的续写/改写/润色 → 调用 apiClient.write
        const body: WritingRequestBody = {
          operation,
          instruction: text,
          sessionHistory,
        };
        if (needsSelection && hasSelection) {
          body.selectedText = selectedText;
        }
        full = await apiClient.write(projectId, chapterId!, body, {
          signal: controller.signal,
          onDelta: (delta) => {
            accumulated += delta;
            setLiveText(accumulated);
            onStreamingChange?.({ streaming: true, content: accumulated, thinking: accumulatedThinking });
          },
          onThinking: (delta) => {
            accumulatedThinking += delta;
            setLiveThinking(accumulatedThinking);
            onStreamingChange?.({ streaming: true, content: accumulated, thinking: accumulatedThinking });
          },
        });
      }

      setTurns((prev) => [...prev, { key: nextKey(), role: 'assistant', content: full }]);
    } catch (error) {
      if (isAbort(error)) {
        if (accumulated.length > 0) {
          setTurns((prev) => [
            ...prev,
            { key: nextKey(), role: 'assistant', content: accumulated },
          ]);
        }
      } else {
        onError?.(error);
      }
    } finally {
      setLiveText('');
      setLiveThinking('');
      setStreaming(false);
      onStreamingChange?.({ streaming: false, content: '', thinking: '' });
      abortRef.current = null;
    }
  }, [
    instruction,
    streaming,
    turns,
    operation,
    isWritingMode,
    chatContext,
    chapterId,
    projectId,
    needsSelection,
    hasSelection,
    selectedText,
    nextKey,
    onError,
  ]);

  const handleAdopt = useCallback(
    (generated: string) => {
      if (!onAdopt) return;
      const target = resolveTarget(editorContent, selection);
      const content = applyAdoption(editorContent, generated, target);
      const caret = caretAfter(target, generated.length);
      onAdopt({ content, generated, target, nextSelection: { start: caret, end: caret } });
    },
    [editorContent, selection, onAdopt],
  );

  const handleClear = useCallback(() => {
    if (streaming) return;
    setTurns([]);
    setLiveText('');
  }, [streaming]);

  const handleContextToggle = useCallback((ctx: FreeChatContext) => {
    setChatContext((prev) => (prev === ctx ? null : ctx));
  }, []);

  const canSend = instruction.trim().length > 0 && !streaming;
  const isEmpty = turns.length === 0 && !streaming;

  // 占位提示文本
  const placeholderText = isWritingMode
    ? `输入${OPERATION_LABELS[operation]}指令…（Ctrl/⌘ + Enter 发送）`
    : '向 AI 创作顾问提问…（Ctrl/⌘ + Enter 发送）';

  const emptyHint = isWritingMode
    ? '向 AI 提出写作、续写、改写、润色或提问请求。'
    : '与 AI 创作顾问自由讨论剧情、角色、世界观或写作技巧。';

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section className="nwa-panel" aria-label={isWritingMode ? '对话式写作' : 'AI创作顾问'}>
      {/* 标题栏 */}
      <div className="nwa-row">
        <h2 className="nwa-panel__title nwa-grow">
          {isWritingMode ? '对话式写作' : 'AI创作顾问'}
        </h2>
        <button
          type="button"
          className="nwa-button nwa-button--ghost"
          disabled={streaming || turns.length === 0}
          onClick={handleClear}
        >
          清空对话
        </button>
      </div>

      {/* 模式指示器 */}
      <div className="nwa-chat-mode">
        <span className="nwa-muted">
          <Icon name={isWritingMode ? 'penLine' : 'messages'} /> {isWritingMode ? '写作模式' : '自由讨论模式'}
        </span>
      </div>

      {/* 自由讨论模式：主题快捷标签 */}
      {!isWritingMode && (
        <div className="nwa-context-tags" role="group" aria-label="对话主题">
          {CONTEXT_OPTIONS.map((ctx) => {
            const active = chatContext === ctx;
            return (
              <button
                key={ctx!}
                type="button"
                className={`nwa-context-tag${active ? ' nwa-context-tag--active' : ''}`}
                onClick={() => handleContextToggle(ctx)}
                disabled={streaming}
              >
                {CONTEXT_LABELS[ctx!]}
              </button>
            );
          })}
        </div>
      )}

      {/* 写作模式：操作类型选择 */}
      {isWritingMode && (
        <div className="nwa-tabs" role="tablist" aria-label="写作操作">
          {WRITING_OPERATIONS.map((op) => {
            const active = op === operation;
            return (
              <button
                key={op}
                type="button"
                role="tab"
                aria-selected={active}
                className={`nwa-tab${active ? ' nwa-tab--active' : ''}`}
                disabled={streaming}
                onClick={() => setOperation(op)}
              >
                {OPERATION_LABELS[op]}
              </button>
            );
          })}
        </div>
      )}

      {/* 写作模式：改写/润色选定文本提示 */}
      {needsSelection &&
        (hasSelection ? (
          <p className="nwa-muted nwa-chat__selected">
            选定文本：{selectedText.length > 60 ? `${selectedText.slice(0, 60)}…` : selectedText}
          </p>
        ) : (
          <p className="nwa-empty">请先在编辑器中选择要{OPERATION_LABELS[operation]}的文本。</p>
        ))}

      {/* 对话会话区 */}
      <div className="nwa-chat" aria-label="对话记录" aria-live="polite">
        {isEmpty ? (
          <p className="nwa-empty">{emptyHint}</p>
        ) : (
          <ul className="nwa-list">
            {turns.map((turn) => (
              <li
                key={turn.key}
                className={`nwa-chat__msg nwa-chat__msg--${turn.role}`}
              >
                <div className="nwa-row">
                  <span className="nwa-chat__role nwa-grow">
                    {turn.role === 'user' ? '你' : 'AI'}
                  </span>
                </div>
                <div className="nwa-stream">{turn.content}</div>
                {turn.role === 'assistant' && showAdopt && (
                  <div className="nwa-row" style={{ justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                    <button
                      type="button"
                      className="nwa-button"
                      onClick={() => handleAdopt(turn.content)}
                    >
                      采用
                    </button>
                  </div>
                )}
              </li>
            ))}
            {streaming && (
              <li className="nwa-chat__msg nwa-chat__msg--assistant">
                <div className="nwa-row">
                  <span className="nwa-chat__role nwa-grow">AI</span>
                  <span className="nwa-muted">生成中…</span>
                </div>
                {liveThinking && (
                  <details className="nwa-thinking-details">
                    <summary className="nwa-thinking-summary"><Icon name="brain" /> AI 思考过程</summary>
                    <div className="nwa-thinking-content">{liveThinking}</div>
                  </details>
                )}
                <div className="nwa-stream">{liveText}</div>
              </li>
            )}
            <div ref={chatEndRef} />
          </ul>
        )}
      </div>

      {/* 指令输入与发送 */}
      <textarea
        className="nwa-textarea"
        aria-label={isWritingMode ? '写作指令' : '讨论输入'}
        rows={4}
        placeholder={placeholderText}
        value={instruction}
        disabled={streaming}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void handleSend();
          }
        }}
      />
      <div className="nwa-row">
        <span className="nwa-grow" />
        {streaming ? (
          <button type="button" className="nwa-button nwa-button--danger" onClick={handleStop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="nwa-button"
            disabled={!canSend}
            onClick={() => void handleSend()}
          >
            发送
          </button>
        )}
      </div>
    </section>
  );
}

export default UnifiedChatPanel;
