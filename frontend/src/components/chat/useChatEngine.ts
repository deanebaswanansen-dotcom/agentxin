/**
 * 对话引擎 Hook —— 从原 UnifiedChatPanel 提炼的流式对话逻辑。
 *
 * 负责：
 *  - 维护按 (projectId, chapterId) 隔离的对话消息流
 *  - 写作模式（续写/改写/润色 调 apiClient.write；提问 调 freeChat.stream）
 *  - 自由讨论模式（调 freeChat.stream，支持主题上下文）
 *  - 流式实时累积 + 思考过程 + AbortController 中止
 *  - 外抛 onStreamingChange（供中央流式预览）和 onAdoptChapter（写作模式生成可采用的章节预览）
 *
 * 不负责：Agent 任务（由 useAgentEngine 承担）、章节正文编辑（由 ChapterEditor 承担）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../../api/apiClient.js';
import type {
  ChatTurn,
  FreeChatRequestBody,
  Id,
  WritingRequestBody,
} from '../../types/index.js';
import type { EditorSelection } from '../ChapterEditor.js';
import {
  type ChatMessage,
  type FreeChatContext,
  type WritingOperation,
} from './types.js';
import { makeId } from './types-shared.js';

export interface UseChatEngineOptions {
  projectId: Id | null;
  chapterId?: Id | null;
  /** 章节编辑器当前正文（写作模式需要，用于采用定位）。 */
  editorContent?: string;
  /** 章节编辑器当前选区。 */
  selection?: EditorSelection;
  onError?: (error: unknown) => void;
  /** 流式状态变化（供中央预览）。 */
  onStreamingChange?: (state: { streaming: boolean; content: string; thinking: string }) => void;
  /** 写作模式生成可采用的章节预览时触发。 */
  onAdoptChapter?: (messageId: string, generated: string) => void;
}

export interface ChatEngineState {
  /** 当前上下文（projectId+chapterId）的消息流。 */
  messages: ChatMessage[];
  /** 是否正在流式生成。 */
  streaming: boolean;
  /** 当前流式累积的文本（实时预览用）。 */
  liveText: string;
  liveThinking: string;
  /** 当前写作操作（写作模式）。 */
  operation: WritingOperation;
  /** 当前自由讨论主题（自由讨论模式）。 */
  chatContext: FreeChatContext;
  /** 历史会话（按上下文隔离，切换时保留）。 */
}

export interface ChatEngineActions {
  setOperation: (op: WritingOperation) => void;
  setChatContext: (ctx: FreeChatContext) => void;
  /** 发送一条文本消息（写作或自由讨论）。 */
  sendText: (text: string) => Promise<void>;
  /** 停止当前流。 */
  stop: () => void;
  /** 清空当前上下文的消息。 */
  clear: () => void;
  /** 采用某条章节预览消息的生成内容。 */
  adoptPreview: (messageId: string) => void;
  /** 直接追加一条消息（供 Agent 引擎或外部注入）。 */
  appendMessage: (message: ChatMessage) => void;
  /** 更新/替换某条消息（供 Agent 流式更新进度消息）。 */
  updateMessage: (id: string, updater: (prev: ChatMessage) => ChatMessage) => void;
  /** 移除某条消息。 */
  removeMessage: (id: string) => void;
  /** 把当前消息带到目标上下文，供 Agent 创建新项目/章节后继续展示结果。 */
  carryNextSession: (targetProjectId?: Id, targetChapterId?: Id | null) => void;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

const CHAT_SESSIONS_STORAGE_KEY = 'nwa.chatSessions.v1';

function loadPersistedSessions(): Map<string, ChatMessage[]> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = window.localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY);
    if (raw === null) return new Map();
    const parsed = JSON.parse(raw) as Record<string, ChatMessage[]>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function persistSessions(sessions: Map<string, ChatMessage[]>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      CHAT_SESSIONS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(sessions.entries())),
    );
  } catch {
    // Persistence is best effort; failed storage must not break writing.
  }
}

export function useChatEngine(options: UseChatEngineOptions): ChatEngineState & ChatEngineActions {
  const {
    projectId,
    chapterId = null,
    editorContent = '',
    selection,
    onError,
    onStreamingChange,
    onAdoptChapter,
  } = options;

  const isWritingMode = chapterId != null;
  const sessionKey = `${projectId ?? 'none'}:${chapterId ?? 'free'}`;

  const abortRef = useRef<AbortController | null>(null);
  // 在切换上下文时保留各自的会话历史，key = `${projectId}:${chapterId ?? 'free'}`
  const sessionsRef = useRef<Map<string, ChatMessage[]>>(loadPersistedSessions());
  const [operation, setOperation] = useState<WritingOperation>('continue');
  const [chatContext, setChatContext] = useState<FreeChatContext>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(() => sessionsRef.current.get(sessionKey) ?? []);
  const [liveText, setLiveText] = useState('');
  const [liveThinking, setLiveThinking] = useState('');
  const [streaming, setStreaming] = useState(false);

  const currentSessionKeyRef = useRef(sessionKey);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const carryNextSessionRef = useRef(false);

  const commitMessages = useCallback((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    const next = updater(messagesRef.current);
    messagesRef.current = next;
    sessionsRef.current.set(currentSessionKeyRef.current, next);
    persistSessions(sessionsRef.current);
    setMessages(next);
  }, []);

  // —— 切换上下文时，保存当前消息并加载目标上下文的消息 ——
  useEffect(() => {
    if (currentSessionKeyRef.current !== sessionKey) {
      sessionsRef.current.set(currentSessionKeyRef.current, messagesRef.current);
    }
    currentSessionKeyRef.current = sessionKey;

    const saved = sessionsRef.current.get(sessionKey);
    const nextMessages =
      carryNextSessionRef.current && saved === undefined ? messagesRef.current : saved ?? [];
    carryNextSessionRef.current = false;
    messagesRef.current = nextMessages;
    sessionsRef.current.set(sessionKey, nextMessages);
    persistSessions(sessionsRef.current);
    setMessages(nextMessages);
    setLiveText('');
    setLiveThinking('');
    // 切换上下文时中止任何进行中的流
    abortRef.current?.abort();
  }, [sessionKey]);

  // 持久化当前消息到 sessionsRef
  useEffect(() => {
    messagesRef.current = messages;
    sessionsRef.current.set(currentSessionKeyRef.current, messages);
    persistSessions(sessionsRef.current);
  }, [messages]);

  // 卸载时中止
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const updateStreaming = useCallback(
    (streamingFlag: boolean, content: string, thinking: string) => {
      onStreamingChange?.({ streaming: streamingFlag, content, thinking });
    },
    [onStreamingChange],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    if (streaming) return;
    commitMessages(() => []);
    setLiveText('');
  }, [streaming, commitMessages]);

  const appendMessage = useCallback((message: ChatMessage) => {
    commitMessages((prev) => [...prev, message]);
  }, [commitMessages]);

  const updateMessage = useCallback(
    (id: string, updater: (prev: ChatMessage) => ChatMessage) => {
      commitMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
    },
    [commitMessages],
  );

  const removeMessage = useCallback((id: string) => {
    commitMessages((prev) => prev.filter((m) => m.id !== id));
  }, [commitMessages]);

  const carryNextSession = useCallback((targetProjectId?: Id, targetChapterId: Id | null = null) => {
    if (targetProjectId === undefined) {
      carryNextSessionRef.current = true;
      return;
    }
    const targetKey = `${targetProjectId}:${targetChapterId ?? 'free'}`;
    if (!sessionsRef.current.has(targetKey)) {
      sessionsRef.current.set(targetKey, messagesRef.current);
      persistSessions(sessionsRef.current);
    }
  }, []);

  const sendText = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (text.length === 0 || streaming || projectId === null) return;

      // 把历史会话转成 ChatTurn[]（仅取文本消息）
      const sessionHistory: ChatTurn[] = messages
        .filter((m): m is Extract<ChatMessage, { kind: 'text' }> => m.kind === 'text')
        .map(({ role, content }) => ({ role, content }));

      // 立即加入用户消息
      const userMsg: ChatMessage = {
        id: makeId(),
        role: 'user',
        kind: 'text',
        content: text,
      };
      commitMessages((prev) => [...prev, userMsg]);
      setLiveText('');
      setLiveThinking('');
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      let accumulated = '';
      let accumulatedThinking = '';

      try {
        let full: string;

        const useFreeChat = !isWritingMode || operation === 'ask';
        if (useFreeChat) {
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
              updateStreaming(true, accumulated, accumulatedThinking);
            },
            onThinking: (delta) => {
              accumulatedThinking += delta;
              setLiveThinking(accumulatedThinking);
              updateStreaming(true, accumulated, accumulatedThinking);
            },
          });
        } else {
          // 写作模式续写/改写/润色
          const body: WritingRequestBody = {
            operation,
            instruction: text,
            sessionHistory,
          };
          const needsSelection = operation === 'rewrite' || operation === 'polish';
          const hasSelection = selection !== undefined && selection.end > selection.start;
          if (needsSelection && hasSelection) {
            body.selectedText = editorContent.slice(selection!.start, selection!.end);
          }
          full = await apiClient.write(projectId, chapterId!, body, {
            signal: controller.signal,
            onDelta: (delta) => {
              accumulated += delta;
              setLiveText(accumulated);
              updateStreaming(true, accumulated, accumulatedThinking);
            },
            onThinking: (delta) => {
              accumulatedThinking += delta;
              setLiveThinking(accumulatedThinking);
              updateStreaming(true, accumulated, accumulatedThinking);
            },
          });
        }

        // 写作模式（非提问）且生成了实质内容 → 作为章节预览消息（可"采用"）
        if (isWritingMode && operation !== 'ask' && full.trim().length > 0) {
          const previewMsg: ChatMessage = {
            id: makeId(),
            role: 'assistant',
            kind: 'chapter-preview',
            chapterId: String(chapterId),
            title: '写作结果',
            content: full,
          };
          commitMessages((prev) => [...prev, previewMsg]);
        } else {
          // 普通文本回复
          const assistantMsg: ChatMessage = {
            id: makeId(),
            role: 'assistant',
            kind: 'text',
            content: full,
            thinking: accumulatedThinking || undefined,
          };
          commitMessages((prev) => [...prev, assistantMsg]);
        }
      } catch (error) {
        if (isAbort(error)) {
          // 保留已累积的内容
          if (accumulated.length > 0) {
            const partialMsg: ChatMessage = {
              id: makeId(),
              role: 'assistant',
              kind: 'text',
              content: accumulated + '\n\n（已停止）',
              thinking: accumulatedThinking || undefined,
            };
            commitMessages((prev) => [...prev, partialMsg]);
          }
        } else {
          onError?.(error);
        }
      } finally {
        setLiveText('');
        setLiveThinking('');
        setStreaming(false);
        updateStreaming(false, '', '');
        abortRef.current = null;
      }
    },
    [
      streaming,
      projectId,
      messages,
      isWritingMode,
      operation,
      chatContext,
      chapterId,
      selection,
      editorContent,
      updateStreaming,
      onError,
      commitMessages,
    ],
  );

  const adoptPreview = useCallback(
    (messageId: string) => {
      const target = messages.find((m) => m.id === messageId);
      if (!target || target.kind !== 'chapter-preview') return;
      onAdoptChapter?.(messageId, target.content);
      // 标记为已采用
      commitMessages((prev) =>
        prev.map((m) =>
          m.id === messageId && m.kind === 'chapter-preview' ? { ...m, adopted: true } : m,
        ),
      );
    },
    [messages, onAdoptChapter, commitMessages],
  );

  return {
    messages,
    streaming,
    liveText,
    liveThinking,
    operation,
    chatContext,
    setOperation,
    setChatContext,
    sendText,
    stop,
    clear,
    adoptPreview,
    appendMessage,
    updateMessage,
    removeMessage,
    carryNextSession,
  };
}
