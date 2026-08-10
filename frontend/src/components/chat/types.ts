/**
 * 对话流消息类型（对话为中心架构的核心数据结构）。
 *
 * 一条 ChatMessage 可能是：
 *  - 普通文本对话（用户提问 / AI 回答，含可选的思考过程）
 *  - Agent 任务结果（携带 summary / steps / artifacts / 章节预览）
 *  - 章节正文预览（写作模式生成后内联展示，可"采用"写回抽屉编辑器）
 *  - Agent 实时进度（流式期间的占位消息，承载 SSE progress 事件）
 *  - 计划模式追问（/计划 头脑风暴选择题 + brief）
 */

import type {
  AgentArtifact,
  AgentRunMetrics,
  AgentProgressEvent,
  Chapter,
  NovelPlanChapterOutline,
  NovelPlanQuestion,
  NovelPlanSummary,
  ReferenceCreativeProfile,
  ReferenceNovelSummary,
  ReferenceTransferDimension,
} from '../../types/index.js';

export type { NovelPlanChapterOutline };

export type ChatRole = 'user' | 'assistant';

/** 文本消息（用户指令或 AI 自由对话/写作回复）。 */
export interface TextMessage {
  id: string;
  role: ChatRole;
  kind: 'text';
  content: string;
  /** AI 回复可选的思考过程。 */
  thinking?: string;
}

/** Agent 任务执行结果消息。 */
export interface AgentResultMessage {
  id: string;
  role: 'assistant';
  kind: 'agent-result';
  task: string;
  summary: string;
  steps: string[];
  artifacts: AgentArtifact[];
  metrics?: AgentRunMetrics;
  /** 若任务生成了章节，附带章节预览。 */
  chapterPreview?: Pick<Chapter, 'id' | 'title' | 'content'> | null;
}

/** 章节正文预览消息（写作模式生成后展示，可"采用"）。 */
export interface ChapterPreviewMessage {
  id: string;
  role: 'assistant';
  kind: 'chapter-preview';
  chapterId: string;
  title: string;
  content: string;
  /** 标记是否已被用户采用。 */
  adopted?: boolean;
}

/** Agent 流式执行期间的实时进度占位消息。 */
export interface AgentProgressMessage {
  id: string;
  role: 'assistant';
  kind: 'agent-progress';
  task: string;
  taskTitle: string;
  events: AgentProgressEvent[];
}

/**
 * 计划模式一轮追问 / 收束 brief（/计划）。
 * 用户点选选项或补充文字后，由 ChatWorkspace 提交下一轮。
 */
export interface PlanTurnMessage {
  id: string;
  role: 'assistant';
  kind: 'plan-turn';
  status: 'asking' | 'ready';
  round: number;
  message: string;
  questions?: NovelPlanQuestion[];
  brief?: string;
  planSummary?: NovelPlanSummary;
  /** 本轮是否已提交（禁用继续点选）。 */
  resolved?: boolean;
  /** 是否已用 brief 触发下游生成。 */
  generated?: boolean;
  /** 计划深度 light | standard | deep */
  depth?: 'light' | 'standard' | 'deep';
  /** 深度轮次区间，如 [8, 10] */
  depthRoundRange?: [number, number];
}

/**
 * 参考小说导入后的章节勾选卡片：整本/部分分析。
 */
export interface ReferenceImportMessage {
  id: string;
  role: 'assistant';
  kind: 'reference-import';
  reference: ReferenceNovelSummary;
  message: string;
  chapters: Array<{
    id: string;
    number: number;
    title: string;
    wordCount: number;
    contentPreview: string;
  }>;
  depth: 'quick' | 'standard' | 'deep';
  /** 是否已提交分析（禁用重复勾选）。 */
  resolved?: boolean;
}

/**
 * 参考小说分析完成卡片（/参考）。
 * 用户勾选迁移维度后应用到当前原创项目。
 */
export interface ReferenceResultMessage {
  id: string;
  role: 'assistant';
  kind: 'reference-result';
  reference: ReferenceNovelSummary;
  profile: ReferenceCreativeProfile;
  message: string;
  /** 是否已迁移到项目。 */
  transferred?: boolean;
}

export type ChatMessage =
  | TextMessage
  | AgentResultMessage
  | ChapterPreviewMessage
  | AgentProgressMessage
  | PlanTurnMessage
  | ReferenceImportMessage
  | ReferenceResultMessage;

export type { ReferenceTransferDimension };

/** 自由讨论主题上下文（与 freeChat 接口对齐）。 */
export type FreeChatContext = 'plot' | 'character' | 'world' | 'writing' | null;

/** 写作操作类型。 */
export type WritingOperation = 'continue' | 'rewrite' | 'polish' | 'ask';

export const FREE_CHAT_CONTEXT_LABELS: Record<Exclude<FreeChatContext, null>, string> = {
  plot: '剧情',
  character: '角色',
  world: '世界观',
  writing: '写作技巧',
};

export const FREE_CHAT_CONTEXT_OPTIONS: Array<Exclude<FreeChatContext, null>> = [
  'plot',
  'character',
  'world',
  'writing',
];

export const WRITING_OPERATION_LABELS: Record<WritingOperation, string> = {
  continue: '续写',
  rewrite: '改写',
  polish: '润色',
  ask: '提问',
};

export const WRITING_OPERATIONS: WritingOperation[] = ['continue', 'rewrite', 'polish', 'ask'];
