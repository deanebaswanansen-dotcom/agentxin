/**
 * Agent 引擎 Hook —— 从原 AgentCommandCenter 提炼的任务执行逻辑。
 *
 * 负责：
 *  - 执行 Agent 任务（novel/full_novel/auto_next/title/outline/polish/diagnostic/workspace_review）
 *  - SSE 流式进度（runStream）+ 旧接口回退（run）
 *  - 把进度/结果以消息形式推入对话流（通过注入的 appendMessage/updateMessage）
 *  - 整本生成参数（章节数/字数）
 *
 * 任务定义与编排步骤常量从 agentTasks.ts 复用，保持单一数据源。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../../api/apiClient.js';
import type {
  AgentProgressEvent,
  AgentRunMode,
  AgentRunResult,
  AgentTask,
  Chapter,
  Id,
} from '../../types/index.js';
import { AGENT_TASKS, TASK_PLANS } from './agentTasks.js';
import { type ChatMessage } from './types.js';
import { makeId } from './types-shared.js';

export interface UseAgentEngineOptions {
  projectId?: Id | null;
  chapterId?: Id | null;
  onError?: (error: unknown) => void;
  /** 任务完成回调（供 App 刷新列表/加载章节到抽屉）。 */
  onCompleted?: (result: AgentRunResult) => void;
  /** 注入对话流的消息操作（来自 useChatEngine）。 */
  appendMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, updater: (prev: ChatMessage) => ChatMessage) => void;
  removeMessage: (id: string) => void;
}

export interface AgentEngineState {
  running: boolean;
  /** 当前正在运行的任务 key（用于 UI 提示）。 */
  runningTask: AgentTask | null;
}

export interface AgentRunParams {
  task: AgentTask;
  mode?: AgentRunMode;
  prompt: string;
  /** 整本生成的章节数（仅 full_novel）。 */
  chapters?: number;
  /** 整本生成的每章字数（仅 full_novel）。 */
  targetWords?: number;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function useAgentEngine(options: UseAgentEngineOptions): AgentEngineState & {
  run: (params: AgentRunParams) => Promise<void>;
  stop: () => void;
} {
  const { projectId, chapterId, onError, onCompleted, appendMessage, updateMessage, removeMessage } =
    options;

  const [running, setRunning] = useState(false);
  const [runningTask, setRunningTask] = useState<AgentTask | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(
    async (params: AgentRunParams) => {
      const { task, prompt } = params;
      if (running) return;
      // auto_next/workspace_review/chapter_diagnosis 允许空 prompt
      if (
        task !== 'auto_next' &&
        task !== 'workspace_review' &&
        task !== 'chapter_diagnosis' &&
        prompt.trim().length === 0
      ) return;

      const taskDef = AGENT_TASKS.find((t) => t.key === task);
      const taskTitle = taskDef?.title ?? task;
      const effectiveMode: AgentRunMode = taskDef?.lockedMode
        ? taskDef.mode
        : params.mode ?? taskDef?.mode ?? 'draft';

      setRunning(true);
      setRunningTask(task);

      // 在对话流中插入用户指令消息（让用户看到自己发了什么）
      const userMsgId = makeId();
      appendMessage({
        id: userMsgId,
        role: 'user',
        kind: 'text',
        content: `/${taskDef?.slash ?? task} ${taskTitle}${prompt.trim() ? '：' + prompt.trim() : ''}`,
      });

      // 插入进度占位消息
      const progressMsgId = makeId();
      appendMessage({
        id: progressMsgId,
        role: 'assistant',
        kind: 'agent-progress',
        task,
        taskTitle,
        events: [],
      });

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const body = {
          task,
          mode: effectiveMode,
          prompt: prompt.trim(),
          projectId: projectId ?? undefined,
          chapterId: chapterId ?? undefined,
          options:
            task === 'auto_next'
              ? { targetWords: params.targetWords ?? 2000 }
              : task === 'full_novel'
                ? {
                    chapters: params.chapters ?? 3,
                    targetWords: params.targetWords ?? 1500,
                    totalChapters: params.chapters ?? 3,
                  }
                : undefined,
        } as const;

        let chapterPreview: Pick<Chapter, 'id' | 'title' | 'content'> | null = null;

        const next =
          apiClient.agent.runStream !== undefined
            ? await apiClient.agent.runStream(body, {
                signal: controller.signal,
                onProgress: (event: AgentProgressEvent) => {
                  updateMessage(progressMsgId, (prev) => {
                    if (prev.kind !== 'agent-progress') return prev;
                    return { ...prev, events: [...prev.events, event] };
                  });
                },
              })
            : await apiClient.agent.run(body, controller.signal);

        // 若生成了章节，拉取预览
        if (next.chapterId !== undefined) {
          try {
            const chapters = await apiClient.chapters.list(next.projectId);
            const found = chapters.find((c) => c.id === next.chapterId);
            if (found) {
              chapterPreview = {
                id: found.id,
                title: found.title,
                content: found.content,
              };
            }
          } catch {
            // 预览失败不影响主流程
          }
        }

        // 移除进度占位，替换为结果消息
        removeMessage(progressMsgId);
        appendMessage({
          id: makeId(),
          role: 'assistant',
          kind: 'agent-result',
          task,
          summary: next.summary,
          steps: next.steps,
          artifacts: next.artifacts,
          metrics: next.metrics,
          chapterPreview,
        });

        onCompleted?.(next);
      } catch (error) {
        if (isAbort(error)) {
          updateMessage(progressMsgId, (prev) => {
            if (prev.kind !== 'agent-progress') return prev;
            return {
              ...prev,
              events: [
                ...prev.events,
                {
                  phase: 'info' as const,
                  message: '任务已停止。',
                },
              ],
            };
          });
          return;
        }
        // 失败时把进度消息转成错误提示
        updateMessage(progressMsgId, (prev) => {
          if (prev.kind !== 'agent-progress') return prev;
          return {
            ...prev,
            // 复用 events 字段末尾追加一条错误信息（简单处理）
            events: [
              ...prev.events,
              {
                phase: 'info' as const,
                message: '任务执行失败，请查看错误提示。',
              },
            ],
          };
        });
        if (!isAbort(error)) onError?.(error);
      } finally {
        setRunning(false);
        setRunningTask(null);
        abortRef.current = null;
      }
    },
    [
      running,
      projectId,
      chapterId,
      appendMessage,
      updateMessage,
      removeMessage,
      onCompleted,
      onError,
    ],
  );

  return { running, runningTask, run, stop };
}

export { AGENT_TASKS, TASK_PLANS };
