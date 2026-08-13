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
import {
  formatPlanAnswersForHistory,
  formatPlanQuestionsForHistory,
} from '../lib/planHistory.js';
import {
  isReferenceImportFileName,
  parseReaderFile,
  readerBookToReferenceText,
} from '../lib/readerImport.js';
import type {
  AgentArtifact,
  AgentRunResult,
  AgentTask,
  Id,
  NovelPlanAnswer,
  NovelPlanConfig,
  NovelPlanHistoryTurn,
  NovelPlanQuestion,
  NovelPlanSummary,
  NovelPlanTurnResponse,
  LongNovelAutomationLevel,
  ReferenceAnalysisDepth,
  ReferenceTransferDimension,
} from '../types/index.js';
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
import { makeId } from './chat/types-shared.js';
import { useAgentEngine } from './chat/useAgentEngine.js';
import { useChatEngine } from './chat/useChatEngine.js';
import './components.css';

const CHAT_ENV = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
const SHOW_MOCK_CONTROLS = CHAT_ENV?.DEV === true;

function hasSlashCommandMatch(input: string): boolean {
  if (!input.startsWith('/')) return false;
  const query = input.slice(1).trim().toLowerCase();
  if (query.length === 0) return true;
  if (SHOW_MOCK_CONTROLS && ('mock'.includes(query) || '演示模式'.includes(query))) return true;
  return AGENT_TASKS.some(
    (task) =>
      task.title.toLowerCase().includes(query) ||
      task.slash.toLowerCase().includes(query) ||
      task.desc.toLowerCase().includes(query),
  );
}

function positivePlanNumber(value: string, max: number): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return Math.min(max, parsed);
}

function buildPlanConfig(
  totalWords: string,
  totalChapters: string,
  wordsMin: string,
  wordsMax: string,
  volumeCount: string,
  genres: string,
  endingDirection: string,
  writingRequirements: string,
  coreStory: string,
): NovelPlanConfig | undefined {
  const min = positivePlanNumber(wordsMin, 20000);
  const max = positivePlanNumber(wordsMax, 20000);
  const chapterRange = min || max
    ? { min: min ?? max!, max: max ?? min! }
    : undefined;
  const config: NovelPlanConfig = {
    targetTotalWords: positivePlanNumber(totalWords, 20_000_000),
    targetTotalChapters: positivePlanNumber(totalChapters, 1000),
    targetWordsPerChapter: chapterRange
      ? { min: chapterRange.min, max: Math.max(chapterRange.min, chapterRange.max) }
      : undefined,
    targetVolumeCount: positivePlanNumber(volumeCount, 50),
    genres: genres.split(/[+,，、]/).map((item) => item.trim()).filter(Boolean),
    coreStory: coreStory.trim() || undefined,
    endingDirection: endingDirection.trim() || undefined,
    writingRequirements: writingRequirements.trim() || undefined,
  };
  return Object.values(config).some((value) => value !== undefined) ? config : undefined;
}

function resolveAdoptionTarget(editorContent: string, selection?: EditorSelection): AdoptionTarget {
  if (selection !== undefined && selection.end > selection.start) {
    return { mode: 'replace', start: selection.start, end: selection.end };
  }
  return { mode: 'insert', position: selection?.start ?? editorContent.length };
}

/** 从阅读器/外部一键送入的参考书 payload。 */
export interface PendingReferenceImport {
  title: string;
  text: string;
  /** 可选来源说明（如「书架」「EPUB」）。 */
  sourceLabel?: string;
  /** 递增 token，同一本书重复发送也能触发。 */
  token: number;
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
  /** Agent 任务完成（刷新项目树/加载章节）。第二个参数是任务启动时的项目。 */
  onAgentCompleted?: (result: AgentRunResult, sourceProjectId?: Id | null) => void;
  /** 点击 artifact 跳转（切资源抽屉 tab / 加载章节）。 */
  onJumpToArtifact?: (artifact: AgentArtifact) => void;
  /** 点击"在编辑器中打开"（打开章节抽屉）。 */
  onOpenChapter?: (chapterId: Id) => void;
  /** 从阅读器一键送入的参考书（导入后出现章节勾选卡）。 */
  pendingReferenceImport?: PendingReferenceImport | null;
  /** 消费掉 pending 后回调，避免重复导入。 */
  onPendingReferenceConsumed?: () => void;
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
  pendingReferenceImport = null,
  onPendingReferenceConsumed,
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
    onStreamingChange,
    onCompleted: (result) => {
      // 只有结果会切换到另一个项目/章节时，才把本轮任务消息写入目标
      // 会话。同一上下文完成时不复制，避免后续手动新建项目看到旧消息。
      const resultChapterId = result.chapterId ?? null;
      if (result.projectId !== projectId || resultChapterId !== chapterId) {
        chat.carryNextSession(result.projectId, resultChapterId);
      }
      onAgentCompleted?.(result, projectId);
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

  // —— 计划模式会话（/计划） ——
  const [planBusy, setPlanBusy] = useState(false);
  const [planSeed, setPlanSeed] = useState('');
  const [planHistory, setPlanHistory] = useState<NovelPlanHistoryTurn[]>([]);
  const [activePlanQuestions, setActivePlanQuestions] = useState<NovelPlanQuestion[]>([]);
  const [activePlanConfig, setActivePlanConfig] = useState<NovelPlanConfig | undefined>();
  const [planTotalWords, setPlanTotalWords] = useState('');
  const [planTotalChapters, setPlanTotalChapters] = useState('');
  const [planWordsMin, setPlanWordsMin] = useState('');
  const [planWordsMax, setPlanWordsMax] = useState('');
  const [planVolumeCount, setPlanVolumeCount] = useState('');
  const [planGenres, setPlanGenres] = useState('');
  const [planEndingDirection, setPlanEndingDirection] = useState('');
  const [planWritingRequirements, setPlanWritingRequirements] = useState('');
  const planAbortRef = useRef<AbortController | null>(null);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 切换章节时清空待执行任务
  useEffect(() => {
    setPendingTask(null);
  }, [chapterId, projectId]);

  useEffect(() => {
    return () => {
      planAbortRef.current?.abort();
    };
  }, []);

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

  const applyPlanResponse = useCallback(
    (response: NovelPlanTurnResponse, historyAfter: NovelPlanHistoryTurn[]) => {
      setPlanHistory(historyAfter);
      setActivePlanQuestions(response.status === 'asking' ? response.questions ?? [] : []);
      chat.appendMessage({
        id: makeId(),
        role: 'assistant',
        kind: 'plan-turn',
        status: response.status,
        round: response.round,
        message: response.message,
        questions: response.questions,
        planningChecklist: response.planningChecklist,
        brief: response.brief,
        planSummary: response.planSummary,
        resolved: false,
        generated: false,
        depth: response.depth,
        depthRoundRange: response.depthRoundRange,
      });
    },
    [chat],
  );

  const startPlanMode = useCallback(
    async (seed: string, planConfig?: NovelPlanConfig) => {
      const seedPrompt = seed.trim() || planConfig?.coreStory?.trim() || '请根据计划配置自动生成小说计划';
      if (!seedPrompt || planBusy || planAbortRef.current !== null || agent.running || chat.streaming) return;
      setPlanBusy(true);
      setPlanSeed(seedPrompt);
      setActivePlanConfig(planConfig);
      setPlanHistory([]);
      setActivePlanQuestions([]);
      chat.appendMessage({
        id: makeId(),
        role: 'user',
        kind: 'text',
        content: `/计划 ${seedPrompt}`,
      });
      const controller = new AbortController();
      planAbortRef.current = controller;
      try {
        // The planning agent decides whether a blocking question is needed.
        const response = await apiClient.agent.planTurn(
          {
            seedPrompt,
            planConfig,
            targetTask: 'long_novel',
            history: [],
          },
          controller.signal,
        );
        const historyAfter: NovelPlanHistoryTurn[] = [
          { role: 'user', content: `灵感：${seedPrompt}` },
          {
            role: 'assistant',
            content: formatPlanQuestionsForHistory(response.message, response.questions, response.planningChecklist),
          },
        ];
        applyPlanResponse(response, historyAfter);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          onError?.(error);
        }
      } finally {
        setPlanBusy(false);
        planAbortRef.current = null;
      }
    },
    [agent.running, applyPlanResponse, chat, onError, planBusy],
  );

  const submitPlanAnswers = useCallback(
    async (messageId: string, answers: NovelPlanAnswer[], forceReady: boolean) => {
      if (planBusy || planAbortRef.current !== null || agent.running || chat.streaming) return;
      const seed = planSeed.trim();
      if (!seed) return;

      // 标记本轮已提交
      chat.updateMessage(messageId, (prev) => {
        if (prev.kind !== 'plan-turn') return prev;
        return { ...prev, resolved: true };
      });

      setPlanBusy(true);
      const controller = new AbortController();
      planAbortRef.current = controller;
      try {
        const historyForApi = planHistory;
        const userLine = formatPlanAnswersForHistory(answers, activePlanQuestions);
        const response = await apiClient.agent.planTurn(
          {
            seedPrompt: seed,
            planConfig: activePlanConfig,
            targetTask: 'long_novel',
            history: historyForApi,
            answers,
            forceReady,
          },
          controller.signal,
        );
        const historyAfter: NovelPlanHistoryTurn[] = [
          ...historyForApi,
          {
            role: 'user',
            content: userLine,
          },
          {
            role: 'assistant',
            content: formatPlanQuestionsForHistory(response.message, response.questions, response.planningChecklist),
          },
        ];
        applyPlanResponse(response, historyAfter);
      } catch (error) {
        chat.updateMessage(messageId, (prev) => {
          if (prev.kind !== 'plan-turn') return prev;
          return { ...prev, resolved: false };
        });
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          onError?.(error);
        }
      } finally {
        setPlanBusy(false);
        planAbortRef.current = null;
      }
    },
    [
      activePlanQuestions,
      agent.running,
      applyPlanResponse,
      chat,
      onError,
      planBusy,
      planHistory,
      planSeed,
      activePlanConfig,
    ],
  );

  const parseLongNovelInput = useCallback((raw: string): {
    prompt: string;
    chapters?: number;
    targetWords?: number;
    totalWords?: number;
    automationLevel?: LongNovelAutomationLevel;
  } => {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const first = lines[0]?.trim() ?? '';
    let chapters: number | undefined;
    let targetWords: number | undefined;
    let totalWords: number | undefined;
    let automationLevel: LongNovelAutomationLevel | undefined;
    let bodyStart = 0;
    if (/自动|章数|每章|总字|automation/i.test(first) && first.length < 120) {
      bodyStart = 1;
      const auto = first.match(/(?:自动|automation)\s*[:：]?\s*(assistant|semi_auto|auto|unattended|辅助|半自动|自动|无人)/i);
      if (auto) {
        const v = auto[1]!.toLowerCase();
        automationLevel =
          v === 'assistant' || v === '辅助'
            ? 'assistant'
            : v === 'auto' || v === '自动'
              ? 'auto'
              : v === 'unattended' || v === '无人'
                ? 'unattended'
                : 'semi_auto';
      }
      const ch = first.match(/章数\s*[:：]?\s*(\d{1,3})/);
      if (ch) chapters = Number(ch[1]);
      const tw = first.match(/每章\s*[:：]?\s*(\d{3,5})/);
      if (tw) targetWords = Number(tw[1]);
      const total = first.match(/总字\s*[:：]?\s*(\d{4,8})/);
      if (total) totalWords = Number(total[1]);
    }
    const prompt = lines.slice(bodyStart).join('\n').trim() || raw.trim();
    return { prompt, chapters, targetWords, totalWords, automationLevel };
  }, []);

  const parseReferenceInput = useCallback((raw: string): {
    title?: string;
    depth: ReferenceAnalysisDepth;
    text: string;
  } => {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    let title: string | undefined;
    let depth: ReferenceAnalysisDepth = 'standard';
    let bodyStart = 0;
    for (let i = 0; i < Math.min(lines.length, 6); i += 1) {
      const line = lines[i]!.trim();
      if (!line) {
        bodyStart = i + 1;
        break;
      }
      const nameMatch = line.match(/^(?:名称|书名|标题)[:：]\s*(.+)$/);
      if (nameMatch) {
        title = nameMatch[1]!.trim();
        bodyStart = i + 1;
        continue;
      }
      const depthMatch = line.match(/^(?:深度|分析深度)[:：]\s*(quick|standard|deep|快速|标准|深度)\s*$/i);
      if (depthMatch) {
        const v = depthMatch[1]!.toLowerCase();
        depth = v === 'quick' || v === '快速' ? 'quick' : v === 'deep' || v === '深度' ? 'deep' : 'standard';
        bodyStart = i + 1;
        continue;
      }
      // 首行很短且不像正文标题，当作书名
      if (i === 0 && line.length <= 40 && !/^第.+[章节]/.test(line) && lines.length > 2) {
        title = line;
        bodyStart = 1;
      }
      break;
    }
    const text = lines.slice(bodyStart).join('\n').trim() || raw.trim();
    return { title, depth, text };
  }, []);

  const runReferenceImport = useCallback(
    async (raw: string, sourceLabel?: string) => {
      const { title, depth, text } = parseReferenceInput(raw);
      if (text.length < 80) {
        onError?.(new Error('参考正文过短，请粘贴更多内容或选择更大的文件。'));
        return;
      }
      setPlanBusy(true);
      chat.appendMessage({
        id: makeId(),
        role: 'user',
        kind: 'text',
        content: `/参考 ${title ?? sourceLabel ?? '（未命名）'} · ${depth}\n（已提交 ${text.length.toLocaleString()} 字${sourceLabel ? ` · ${sourceLabel}` : ''}）`,
      });
      const progressId = makeId();
      chat.appendMessage({
        id: progressId,
        role: 'assistant',
        kind: 'text',
        content: '正在导入整本并识别章节（支持几十～上百章）…',
      });
      try {
        const imported = await apiClient.references.import({
          title: title ?? sourceLabel,
          text,
          depth,
          isCompleteWork: true,
        });
        chat.removeMessage(progressId);
        chat.appendMessage({
          id: makeId(),
          role: 'assistant',
          kind: 'reference-import',
          reference: imported.reference,
          message: imported.message,
          chapters: imported.chapters,
          depth: imported.reference.depth,
          resolved: false,
        });
      } catch (error) {
        chat.removeMessage(progressId);
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          onError?.(error);
        }
      } finally {
        setPlanBusy(false);
      }
    },
    [chat, onError, parseReferenceInput],
  );

  const analyzeReferenceChapters = useCallback(
    async (
      messageId: string,
      referenceId: string,
      chapterIds: string[],
      depth: ReferenceAnalysisDepth,
    ) => {
      if (planBusy || agent.running) return;
      if (chapterIds.length === 0) {
        onError?.(new Error('请至少勾选一章。'));
        return;
      }
      setPlanBusy(true);
      chat.updateMessage(messageId, (prev) =>
        prev.kind === 'reference-import' ? { ...prev, resolved: true, depth } : prev,
      );
      const progressId = makeId();
      chat.appendMessage({
        id: progressId,
        role: 'assistant',
        kind: 'text',
        content: `正在分析已选 ${chapterIds.length} 章（深度 ${depth}）…`,
      });
      try {
        const analyzed = await apiClient.references.analyze(referenceId, {
          chapterIds,
          depth,
        });
        chat.removeMessage(progressId);
        chat.appendMessage({
          id: makeId(),
          role: 'assistant',
          kind: 'reference-result',
          reference: analyzed.reference,
          profile: analyzed.profile,
          message: analyzed.message,
          transferred: false,
        });
        if (analyzed.analysisProjectId !== projectId) {
          chat.carryNextSession(analyzed.analysisProjectId, null);
        }
        onAgentCompleted?.({
          task: 'outline',
          mode: 'reference',
          projectId: analyzed.analysisProjectId,
          summary: `已创建/更新拆解项目「${analyzed.analysisProjectName}」`,
          steps: [
            '按原书顺序写入全部章节与正文',
            '提取原作人物与人物关系',
            '整理世界观、势力、规则与地点',
            '整理剧情大纲、冲突爽点、伏笔反转与主题',
          ],
          artifacts: analyzed.artifacts,
        }, projectId);
      } catch (error) {
        chat.updateMessage(messageId, (prev) =>
          prev.kind === 'reference-import' ? { ...prev, resolved: false } : prev,
        );
        chat.removeMessage(progressId);
        onError?.(error);
      } finally {
        setPlanBusy(false);
      }
    },
    [agent.running, chat, onAgentCompleted, onError, planBusy],
  );

  const handleReferenceFilePick = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const file = fileList[0]!;
      if (!isReferenceImportFileName(file.name)) {
        onError?.(new Error('支持 .txt / .md / .html / .epub。'));
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        onError?.(new Error('文件过大（上限约 20MB）。请拆分或先导出部分章节。'));
        return;
      }
      try {
        const book = await parseReaderFile(file);
        const text = readerBookToReferenceText(book);
        if (text.length > 1_500_000) {
          onError?.(new Error('解析后的正文超过 1,500,000 字符，请拆分后再导入。'));
          return;
        }
        const meta =
          `名称：${book.title}\n深度：standard\n\n${text}`;
        await runReferenceImport(meta, `${book.title}（${book.format.toUpperCase()}）`);
      } catch (error) {
        onError?.(error);
      }
    },
    [onError, runReferenceImport],
  );

  // 阅读器一键送入：自动导入并弹出章节勾选
  useEffect(() => {
    if (!pendingReferenceImport) return;
    const { title, text, sourceLabel } = pendingReferenceImport;
    if (!text.trim()) {
      onPendingReferenceConsumed?.();
      return;
    }
    void (async () => {
      try {
        const header = `名称：${title}\n深度：standard\n\n${text}`;
        await runReferenceImport(header, sourceLabel ?? title);
      } finally {
        onPendingReferenceConsumed?.();
      }
    })();
    // token 变化即触发；runReferenceImport 稳定依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReferenceImport?.token]);

  const transferReference = useCallback(
    async (messageId: string, referenceId: string, dimensions: ReferenceTransferDimension[]) => {
      if (!projectId) {
        onError?.(new Error('请先在左侧选择或创建一个原创项目，再应用参考维度。'));
        return;
      }
      if (planBusy || agent.running) return;
      setPlanBusy(true);
      try {
        const result = await apiClient.references.transfer(projectId, {
          referenceId,
          dimensions,
        });
        chat.updateMessage(messageId, (prev) =>
          prev.kind === 'reference-result' ? { ...prev, transferred: true } : prev,
        );
        chat.appendMessage({
          id: makeId(),
          role: 'assistant',
          kind: 'text',
          content: `${result.summary}\n\n已写入项目资料「参考创作档案 / 参考写作方法」。后续 /整本 与 /下一章 会注入方法参数，不会加载参考原文。`,
        });
        onAgentCompleted?.({
          task: 'outline',
          mode: 'reference',
          projectId: result.projectId,
          summary: result.summary,
          steps: [result.summary],
          artifacts: result.artifacts,
        }, projectId);
      } catch (error) {
        onError?.(error);
      } finally {
        setPlanBusy(false);
      }
    },
    [agent.running, chat, onAgentCompleted, onError, planBusy, projectId],
  );

  const generateFromPlanBrief = useCallback(
    async (
      messageId: string,
      brief: string,
      scale?: { chapters?: number; targetWords?: number; totalWords?: number },
      planSummary?: NovelPlanSummary,
      taskOverride?: AgentTask,
    ) => {
      const text = brief.trim();
      if (!text || agent.running || planBusy) return;
      chat.updateMessage(messageId, (prev) => {
        if (prev.kind !== 'plan-turn') return prev;
        return { ...prev, generated: true };
      });
      const chapters = Math.min(
        500,
        Math.max(1, Math.round(scale?.chapters ?? fullNovelChapters ?? 3)),
      );
      const targetWords = Math.min(
        8000,
        Math.max(300, Math.round(scale?.targetWords ?? fullNovelWords ?? 2000)),
      );
      const totalWords = scale?.totalWords ?? planSummary?.totalWords;
      // 单章 → novel；多章默认 long_novel（质量门控）。按钮可覆盖为 full_novel。
      let task: AgentTask;
      if (taskOverride === 'full_novel' || taskOverride === 'long_novel' || taskOverride === 'novel') {
        task = taskOverride;
      } else if (chapters <= 1) {
        task = 'novel';
      } else {
        task = 'long_novel';
      }
      if (chapters > 1) {
        setFullNovelChapters(chapters);
        setFullNovelWords(targetWords);
      }
      await agent.run({
        task,
        prompt: text,
        chapters,
        targetWords,
        totalWords,
        automationLevel: task === 'long_novel' ? 'semi_auto' : undefined,
        planSummary,
      });
    },
    [agent, chat, fullNovelChapters, fullNovelWords, planBusy],
  );

  // —— 发送 ——
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (chat.streaming || agent.running || planBusy) return;

    // Agent 任务模式
    if (pendingTask) {
      // /计划 → 头脑风暴，不直接猛写
      if (pendingTask.key === 'plan') {
        const config = buildPlanConfig(
          planTotalWords,
          planTotalChapters,
          planWordsMin,
          planWordsMax,
          planVolumeCount,
          planGenres,
          planEndingDirection,
          planWritingRequirements,
          text,
        );
        if (text.length === 0 && !config) return;
        setPendingTask(null);
        setInput('');
        await startPlanMode(text, config);
        return;
      }
      // /参考 → 导入整本，再勾选章节分析
      if (pendingTask.key === 'reference') {
        if (text.length === 0) return;
        setPendingTask(null);
        setInput('');
        await runReferenceImport(text);
        return;
      }
      const needsProject = pendingTask.needsProject === true;
      const needsChapter = pendingTask.needsChapter === true;
      if (needsProject && projectId === null) return;
      if (needsChapter && chapterId === null) return;

      // /长篇：解析「自动:xx 章数:n 每章:n 总字:n」前缀
      if (pendingTask.key === 'long_novel') {
        const parsed = parseLongNovelInput(text);
        setPendingTask(null);
        setInput('');
        await agent.run({
          task: 'long_novel',
          prompt: parsed.prompt,
          chapters: parsed.chapters ?? fullNovelChapters,
          targetWords: parsed.targetWords ?? fullNovelWords,
          totalWords: parsed.totalWords,
          automationLevel: parsed.automationLevel,
        });
        return;
      }

      await agent.run({
        task: pendingTask.key as AgentTask,
        prompt: text,
        chapters: fullNovelChapters,
        targetWords: fullNovelWords,
      });
      setPendingTask(null);
      setInput('');
      return;
    }

    // 允许直接发送「/计划 核心剧情」，但仍先打开计划配置，让用户确认核心方向。
    const directPlanMatch = text.match(/^\/计划(?:\s+([\s\S]*))?$/);
    if (directPlanMatch) {
      const planTask = AGENT_TASKS.find((task) => task.key === 'plan');
      if (planTask) setPendingTask(planTask);
      setInput(directPlanMatch[1]?.trim() ?? '');
      inputRef.current?.focus();
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
    planBusy,
    startPlanMode,
    runReferenceImport,
    planTotalWords,
    planTotalChapters,
    planWordsMin,
    planWordsMax,
    planVolumeCount,
    planGenres,
    planEndingDirection,
    planWritingRequirements,
  ]);

  const busy = chat.streaming || agent.running || planBusy;

  const handleStop = useCallback(() => {
    chat.stop();
    agent.stop();
    planAbortRef.current?.abort();
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
        input.trim().length > 0 ||
        (pendingTask.key === 'plan' &&
          [
            planTotalWords,
            planTotalChapters,
            planWordsMin,
            planWordsMax,
            planVolumeCount,
            planGenres,
            planEndingDirection,
            planWritingRequirements,
          ].some((value) => value.trim().length > 0))
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
  const isEmpty = chat.messages.length === 0 && !chat.streaming && !agent.running && !planBusy;

  // 当前模式标签
  const modeLabel = useMemo(() => {
    if (planBusy) return '计划模式 · 责编思考中';
    if (pendingTask?.key === 'plan') return '计划模式 · 输入灵感后开始追问';
    if (pendingTask) return `任务：${pendingTask.title}`;
    if (isWritingMode) return `写作模式 · ${chapterTitle ?? ''}`;
    return projectName ? `自由讨论 · ${projectName}` : '自由讨论';
  }, [pendingTask, isWritingMode, chapterTitle, projectName, planBusy]);

  const placeholderTextPlanAware = useMemo(() => {
    if (pendingTask?.key === 'plan') {
      return '先写一句话灵感，例如：写一本修仙小说…（Enter 开始计划追问）';
    }
    return placeholderText;
  }, [pendingTask, placeholderText]);

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
                  ? `在「${projectName}」中讨论剧情、角色、世界观；输入 /计划 先头脑风暴，或 /新书 直接生成。`
                  : '输入 /计划 后，Agent 会理解硬约束并自主决定是否需要补问；/新书 可直接开写。'}
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
                onPlanSubmit={(id, answers, forceReady) => {
                  void submitPlanAnswers(id, answers, forceReady);
                }}
                onPlanGenerate={(id, brief, scale, planSummary, taskOverride) => {
                  void generateFromPlanBrief(id, brief, scale, planSummary, taskOverride);
                }}
                onReferenceTransfer={(id, referenceId, dimensions) => {
                  void transferReference(id, referenceId, dimensions);
                }}
                onReferenceAnalyze={(id, referenceId, chapterIds, depth) => {
                  void analyzeReferenceChapters(id, referenceId, chapterIds, depth);
                }}
              />
            ))}
            {planBusy ? (
              <div className="nwa-chat__msg nwa-chat__msg--assistant">
                <span className="nwa-chat__role"><Icon name="brain" /> 处理中</span>
                <div className="nwa-chat__content nwa-chat__typing">
                  <span className="nwa-chat__dot" />
                  <span className="nwa-chat__dot" />
                  <span className="nwa-chat__dot" />
                  <span className="nwa-muted" style={{ marginLeft: '0.5rem' }}>计划 / 参考分析进行中…</span>
                </div>
              </div>
            ) : null}
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
          {pendingTask.key === 'plan' ? (
            <div className="nwa-plan-config" aria-label="小说计划配置">
              <div className="nwa-plan-config__grid">
                <label>全文目标字数<input type="number" min={1} placeholder="例如 1000000" value={planTotalWords} disabled={busy} onChange={(e) => setPlanTotalWords(e.target.value)} /></label>
                <label>总章节数<input type="number" min={1} placeholder="例如 400" value={planTotalChapters} disabled={busy} onChange={(e) => setPlanTotalChapters(e.target.value)} /></label>
                <label>单章最少字数<input type="number" min={300} placeholder="例如 2400" value={planWordsMin} disabled={busy} onChange={(e) => setPlanWordsMin(e.target.value)} /></label>
                <label>单章最多字数<input type="number" min={300} placeholder="例如 2800" value={planWordsMax} disabled={busy} onChange={(e) => setPlanWordsMax(e.target.value)} /></label>
                <label>目标卷数<input type="number" min={1} placeholder="可留空由 Agent 推荐" value={planVolumeCount} disabled={busy} onChange={(e) => setPlanVolumeCount(e.target.value)} /></label>
                <label>小说类型<input type="text" placeholder="玄幻 + 学院 + 冒险" value={planGenres} disabled={busy} onChange={(e) => setPlanGenres(e.target.value)} /></label>
                <label>结局方向<input type="text" placeholder="自动规划 / 大团圆 / 悲剧…" value={planEndingDirection} disabled={busy} onChange={(e) => setPlanEndingDirection(e.target.value)} /></label>
              </div>
              <label className="nwa-plan-config__wide">额外要求<textarea rows={2} placeholder="慢热、群像、不后宫、不要系统流…" value={planWritingRequirements} disabled={busy} onChange={(e) => setPlanWritingRequirements(e.target.value)} /></label>
              <span className="nwa-muted">核心剧情请填写下方对话框；上方字段是计划约束，留空的细节由 Agent 自动补全。</span>
            </div>
          ) : null}
          {pendingTask.key === 'full_novel' || pendingTask.key === 'long_novel' ? (
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
          {pendingTask.key === 'reference' ? (
            <span className="nwa-chat-pending__params">
              <label className="nwa-button nwa-button--ghost nwa-button--sm" style={{ cursor: 'pointer' }}>
                选择文件导入整本
                <input
                  type="file"
                  accept=".txt,.md,.markdown,.html,.htm,.epub,text/plain,text/markdown,application/epub+zip"
                  style={{ display: 'none' }}
                  disabled={busy}
                  onChange={(e) => {
                    void handleReferenceFilePick(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
              <span className="nwa-muted">支持 TXT / MD / HTML / EPUB，或粘贴正文；导入后勾选章节分析</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Mock controls are available only in local development. */}
      {SHOW_MOCK_CONTROLS ? (mockDone ? (
        <div className="nwa-chat-mock-hint">
          <span className="nwa-muted"><Icon name="check" /> 演示模式已开启</span>
        </div>
      ) : (
        <button
          type="button"
          className="nwa-button nwa-button--ghost nwa-button--sm nwa-chat-mock-entry"
          disabled={mockBusy}
          onClick={() => void handleSelectMock()}
          title="无需 API Key 的本地演示模式"
        >
          {mockBusy ? '切换中…' : '演示模式'}
        </button>
      )) : null}

      {/* —— 输入区 —— */}
      <div className="nwa-chat-input-area">
        {showSlashMenu ? (
          <SlashMenu
            query={slashQuery}
            hasProject={projectId !== null}
            hasChapter={chapterId !== null}
            onSelectTask={handleSelectTask}
            onSelectMock={() => void handleSelectMock()}
            showMock={SHOW_MOCK_CONTROLS}
            onClose={handleCloseSlash}
          />
        ) : null}
        <textarea
          ref={inputRef}
          className="nwa-chat-input"
          rows={2}
          placeholder={placeholderTextPlanAware}
          value={input}
          disabled={busy || mockBusy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="对话输入"
        />
        <div className="nwa-chat-input-actions">
          <span className="nwa-muted nwa-chat-input-hint">
            {pendingTask?.key === 'plan'
              ? 'Enter 开始计划追问，Esc 取消'
              : pendingTask?.key === 'reference'
                ? '选文件或粘贴全书 → Enter 导入 → 勾选章节再分析'
                : pendingTask
                  ? 'Enter 执行任务，Esc 取消'
                  : 'Enter 发送 · /参考 导入整本分析 · /计划 头脑风暴'}
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
