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
  LongNovelAutomationLevel,
  NovelPlanSummary,
} from '../../types/index.js';
import { AGENT_TASKS, TASK_PLANS } from './agentTasks.js';
import { buildAgentRunOptions } from './buildAgentRunOptions.js';
import { type ChatMessage } from './types.js';
import { makeId } from './types-shared.js';

export interface UseAgentEngineOptions {
  projectId?: Id | null;
  chapterId?: Id | null;
  onError?: (error: unknown) => void;
  /** 任务完成回调（供 App 刷新列表/加载章节到抽屉）。 */
  onCompleted?: (result: AgentRunResult) => void;
  /** 流式进度（供中央预览面板实时显示当前在干什么）。 */
  onStreamingChange?: (state: { streaming: boolean; content: string; thinking: string }) => void;
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
  /**
   * StoryForge 风格计划采纳：把分章大纲 / 创作规则交给 full_novel，
   * 写正文前写入项目资料并注入章节锚点。
   */
  planSummary?: NovelPlanSummary;
  /** long_novel：自动化等级。 */
  automationLevel?: LongNovelAutomationLevel;
  /** long_novel：全书目标字数。 */
  totalWords?: number;
}

function isRunnableAgentTask(task: string): task is AgentTask {
  return task !== 'plan' && task !== 'reference' && AGENT_TASKS.some((t) => t.key === task);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function useAgentEngine(options: UseAgentEngineOptions): AgentEngineState & {
  run: (params: AgentRunParams) => Promise<void>;
  stop: () => void;
} {
  const {
    projectId,
    chapterId,
    onError,
    onCompleted,
    onStreamingChange,
    appendMessage,
    updateMessage,
    removeMessage,
  } = options;

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
      if (!isRunnableAgentTask(task)) {
        onError?.(new Error('计划模式请使用对话区的选项提交，不要直接当 Agent 任务执行。'));
        return;
      }
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
      const progressLines: string[] = [`启动任务：${taskTitle}`];
      onStreamingChange?.({
        streaming: true,
        content: progressLines.join('\n'),
        thinking: `任务：${taskTitle}\n模式：${effectiveMode === 'draft' ? '直接成文' : '只要方案'}`,
      });

      try {
        const body = {
          task,
          mode: effectiveMode,
          prompt: prompt.trim(),
          projectId: projectId ?? undefined,
          chapterId: chapterId ?? undefined,
          options: buildAgentRunOptions({
            task,
            chapters: params.chapters,
            targetWords: params.targetWords,
            totalWords: params.totalWords,
            automationLevel: params.automationLevel,
            planSummary: params.planSummary,
          }),
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
                  const prefix =
                    event.current !== undefined && event.total !== undefined
                      ? `[${event.current}/${event.total}] `
                      : '';
                  progressLines.push(`${prefix}${event.message}`);
                  // Keep the live pane focused on the latest stretch of work.
                  const tail = progressLines.slice(-40).join('\n');
                  onStreamingChange?.({
                    streaming: true,
                    content: tail,
                    thinking: `任务：${taskTitle}\n模式：${effectiveMode === 'draft' ? '直接成文' : '只要方案'}\n阶段：${event.phase}`,
                  });
                },
              })
            : await apiClient.agent.run(body, controller.signal);

        // 结果一到就立刻关掉中央「生成中」遮罩——后续拉预览/切换项目不应再挡住编辑器。
        progressLines.push('任务完成，正在整理结果…');
        onStreamingChange?.({
          streaming: false,
          content: '',
          thinking: '',
        });

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
          progressLines.push('任务已停止。');
          onStreamingChange?.({
            streaming: true,
            content: progressLines.slice(-40).join('\n'),
            thinking: `任务：${taskTitle}`,
          });
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
        onStreamingChange?.({ streaming: false, content: '', thinking: '' });
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
      onStreamingChange,
    ],
  );

  return { running, runningTask, run, stop };
}

export { AGENT_TASKS, TASK_PLANS };
