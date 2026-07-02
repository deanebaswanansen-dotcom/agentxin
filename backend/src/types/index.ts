/**
 * Shared domain types for the Novel Writing Agent.
 *
 * NOTE (task 1.2): This file is the CANONICAL source of shared types. An
 * identical copy is kept at `frontend/src/types/index.ts`.
 *
 * Why duplicated instead of a shared package: this monorepo has no configured
 * shared package, and each project constrains TypeScript to its own `src/`
 * root (backend uses `rootDir: "src"`, frontend uses `include: ["src"]` with
 * the Vite project root at `frontend/`). A cross-project relative import would
 * break `npm run typecheck`/build in both projects. Since these are pure type
 * declarations (no runtime logic beyond the error-code constants), the two
 * files are kept byte-for-byte identical and MUST be updated together.
 */

// 唯一标识符统一使用 string（UUID v4）
export type Id = string;

export interface Project {
  id: Id;
  name: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

export interface Chapter {
  id: Id;
  projectId: Id;
  title: string;
  content: string; // 正文
  position: number; // 排序位置, 升序
}

export interface Character {
  id: Id;
  projectId: Id;
  name: string;
  description: string;
}

export interface WorldSetting {
  id: Id;
  projectId: Id;
  title: string;
  content: string;
}

export interface Outline {
  id: Id;
  projectId: Id;
  title: string;
  content: string;
  position: number;
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string; // 仅服务端存储, 绝不返回前端原文
  modelName: string;
  temperature?: number; // 0-2, defaults to 1
  topP?: number; // 0-1, defaults to 1
}

// 返回前端的安全视图（API Key 掩码）
export interface ModelConfigView {
  baseUrl: string;
  modelName: string;
  apiKeyMasked: string; // 例如 "sk-****abcd"
  temperature: number;
  topP: number;
}

export interface CacheUsageRecord {
  at: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  hitRatePct: number;
}

export interface CacheStatsSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  hitRatePct: number;
  localCache: {
    hits: number;
    misses: number;
    lookups: number;
    hitRatePct: number;
  };
  recent: CacheUsageRecord[];
}

// ---------------------------------------------------------------------------
// 写作相关类型
// ---------------------------------------------------------------------------

export interface WritingRequestBody {
  operation: 'continue' | 'rewrite' | 'polish'; // 续写 / 改写 / 润色
  instruction: string; // 用户指令
  selectedText?: string; // 改写/润色目标文本
  attachedSettingIds?: {
    // 附加到上下文的设定条目
    characterIds?: Id[];
    worldSettingIds?: Id[];
    outlineIds?: Id[];
  };
  sessionHistory?: ChatTurn[]; // 同一对话会话内的历史
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface SettingSnippet {
  kind: 'character' | 'world' | 'outline';
  title: string; // 人物用 name, 其余用 title
  body: string; // 描述 / 内容
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface WritingContextInput {
  operation: 'continue' | 'rewrite' | 'polish';
  instruction: string;
  chapterContent: string; // 章节现有正文
  selectedText?: string;
  attachedSettings: SettingSnippet[]; // 已解析的设定内容
  sessionHistory: ChatTurn[];
}

// ---------------------------------------------------------------------------
// 统一错误结构与错误码
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'MODEL_NOT_CONFIGURED'
  | 'PROVIDER_ERROR'
  | 'STORE_ERROR';

/**
 * 运行时可用的错误码常量集合。提供与 {@link ErrorCode} 联合类型一一对应的命名常量，
 * 便于在服务端/客户端代码中以值的形式引用错误码而无需散落字符串字面量。
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  MODEL_NOT_CONFIGURED: 'MODEL_NOT_CONFIGURED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  STORE_ERROR: 'STORE_ERROR',
} as const satisfies Record<ErrorCode, ErrorCode>;

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string; // 面向用户的失败原因
  };
}

// ---------------------------------------------------------------------------
// Agent automation types
// ---------------------------------------------------------------------------

export type AgentRunMode = 'reference' | 'draft';

export type AgentTask =
  | 'novel'
  | 'title'
  | 'outline'
  | 'polish'
  | 'diagnostic'
  | 'material_research'
  | 'trope_breakdown'
  | 'cliche_guard'
  | 'chapter_diagnosis'
  | 'workspace_review'
  | 'auto_next'
  | 'full_novel'
  // Blueprint scenario tasks delegated to Python LangGraph core (refactor spec)
  | 'plan_blueprint'
  | 'write_scene'
  | 'write_chapter_from_blueprint';

export interface AgentRunRequest {
  task: AgentTask;
  mode: AgentRunMode;
  prompt: string;
  projectId?: Id;
  chapterId?: Id;
  options?: {
    targetWords?: number;
    /** full_novel：一键生成的章节数（1-500，默认 3）。 */
    chapters?: number;
    /** full_novel：分批长跑时的最终总章数（1-500，默认等于 chapters）。 */
    totalChapters?: number;
  };
}

export interface AgentRunMetrics {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRatePct: number;
  localCacheHits: number;
  localCacheMisses: number;
  localCacheHitRatePct: number;
  plannedWords?: number;
  completedChapters?: number;
  estimatedCostUsd?: number;
}

export interface AgentArtifact {
  kind: 'project' | 'world' | 'character' | 'outline' | 'chapter';
  id: Id;
  title: string;
}

export interface AgentRunResult {
  task: AgentTask;
  mode: AgentRunMode;
  projectId: Id;
  chapterId?: Id;
  summary: string;
  steps: string[];
  artifacts: AgentArtifact[];
  metrics?: AgentRunMetrics;
}

/** Agent 执行过程中的实时进度事件（SSE 流式推送）。 */
export interface AgentProgressEvent {
  phase: 'setup' | 'chapter' | 'reflect' | 'inspect' | 'info';
  message: string;
  /** 当前进度序号（如第几章），从 1 开始。 */
  current?: number;
  /** 总数（如总章节数）。 */
  total?: number;
}

// ---------------------------------------------------------------------------
// Novel import / organization
// ---------------------------------------------------------------------------

export interface ImportNovelFile {
  path: string;
  content: string;
}

export interface ImportNovelRequest {
  sourceName?: string;
  files: ImportNovelFile[];
}

export interface ImportNovelResult {
  projectId: Id;
  sourceName: string;
  filesImported: number;
  chaptersCreated: number;
  charactersCreated: number;
  worldSettingsCreated: number;
  outlinesCreated: number;
  firstChapterId?: Id;
  summary: string;
  artifacts: AgentArtifact[];
}

// ---------------------------------------------------------------------------
// 章节蓝图模块类型（Chapter Blueprint Module）
// ---------------------------------------------------------------------------

/** 场景：章节蓝图中的最小施工单元（需求 2.4）。 */
export interface Scene {
  scene_id: string; // 章节蓝图内唯一（需求 4.4）
  name: string; // 场景名称
  target_words: number; // 目标字数, 正整数（需求 4.5）
  location: string; // 地点
  characters: string[]; // 出场角色（与项目人物 name 对应）
  purpose: string; // 场景目的（写作/重写约束, 需求 6.1/12.2）
  emotion: string; // 情绪基调
  pacing: string; // 节奏要求
  must_include: string[]; // 必含要点（写作/重写约束, 需求 6.1/12.2）
  ending_state: string; // 结束状态（写作约束, 需求 6.1）
}

/** 章节蓝图：章节施工方案，以 JSON 持久化（需求 2.3）。 */
export interface ChapterBlueprint {
  chapter_id: string; // 关联章节标识符
  title: string; // 章节标题
  target_words: number; // 章节目标字数, 正整数（需求 4.5）
  main_goal: string; // 章节主目标
  tone: string; // 整体基调
  pacing: string; // 章节节奏要求
  required_plot_points: string[]; // 必含剧情点（节奏检查依据, 需求 10.1/10.2）
  forbidden_points: string[]; // 禁止事项（节奏检查依据, 需求 10.1/10.3）
  emotional_curve: string; // 情绪曲线（节奏检查依据, 需求 10.1）
  scenes: Scene[]; // 场景数组（数量 3-7, 需求 4.2）
  ending_hook: string; // 章末钩子
}

/**
 * 蓝图核心结构：等价于不含数据存储主键字段的章节蓝图。
 * 解析 / 序列化 / 校验等纯逻辑以该结构为输入输出（任务 3.1 / 4.1）。
 */
export type BlueprintCore = Omit<ChapterBlueprint, 'id' | 'projectId'>;

/** 场景正文：单个场景的生成文本，关联章节与场景标识符（术语表 SceneDraft）。 */
export interface SceneDraft {
  chapterId: Id; // 关联章节（数据存储内部主键, UUID）
  sceneId: string; // 关联蓝图内的 scene_id
  content: string; // 场景正文
  updatedAt: string; // ISO 8601, 最近一次写入时间
}

// —— 字数检查报告（WordCountReport, 需求 9） ——

/** 单个场景的字数检查结果。 */
export interface SceneWordCount {
  sceneId: string;
  targetWords: number; // 场景蓝图 target_words
  actualWords: number; // 实际字数, 无正文则计 0（需求 9.1）
  delta: number; // actualWords − targetWords（需求 9.2）
  needsExpansion: boolean; // 不足比例 ≥ 0.15（需求 9.3）
  suggestedExpansion: number; // 建议扩写字数 = max(0, target − actual)，仅在 needsExpansion 时 > 0
}

/** 字数检查报告：场景级 + 整章级（需求 9）。 */
export interface WordCountReport {
  chapterId: Id;
  scenes: SceneWordCount[];
  chapterTargetWords: number; // 章节蓝图 target_words
  chapterActualWords: number; // 整章实际字数
  chapterDelta: number; // 整章 actual − target（需求 9.2）
  generatedAt: string; // ISO 8601
}

// —— 节奏检查报告（PacingReport, 需求 10） ——

/** 剧情点完成状态（需求 10.2）。 */
export type PlotPointStatus = 'completed' | 'partial' | 'missing';

/** 修改优先级（需求 10.4）。 */
export type PacingPriority = 'high' | 'medium' | 'low';

/** 单个必含剧情点的完成情况。 */
export interface PlotPointResult {
  point: string; // 对应 required_plot_points 中的一条
  status: PlotPointStatus; // 已完成 / 部分完成 / 未完成
}

/** 按场景给出的节奏问题与建议（需求 10.4）。 */
export interface ScenePacingIssue {
  sceneId: string;
  issue: string; // 节奏问题描述
  suggestion: string; // 修改建议
  priority: PacingPriority; // 高 / 中 / 低
}

/** 节奏检查报告（需求 10）。 */
export interface PacingReport {
  chapterId: Id;
  plotPoints: PlotPointResult[]; // 每个 required_plot_points 的完成状态（需求 10.2）
  violatedForbiddenPoints: string[]; // 被违反的禁止事项（需求 10.3）
  sceneIssues: ScenePacingIssue[]; // 按场景的问题 / 建议 / 优先级（需求 10.4）
  generatedAt: string; // ISO 8601
}

// —— 请求体类型（传输层） ——

/** 生成蓝图请求体（需求 1.1, 1.3, 1.4, 1.5）。 */
export interface GenerateBlueprintBody {
  targetWords: number; // 100–100000 的正整数（需求 1.3）
  requirement: string; // 章节需求文本, 1–5000 字符（需求 1.4）
}

/** 场景重写请求体（需求 12.1, 12.5）。 */
export interface RewriteSceneBody {
  instruction: string; // 修改要求, 非空（需求 12.5）
}

/** 场景扩写请求体（需求 11.1, 11.2）。 */
export interface ExpandSceneBody {
  addWords: number; // 期望新增字数, 1–100000 的正整数（需求 11.2）
}

// ---------------------------------------------------------------------------
// 自由对话（Free Chat）
// ---------------------------------------------------------------------------

export interface FreeChatRequestBody {
  message: string;
  context?: 'plot' | 'character' | 'world' | 'writing' | null;
  chapterId?: Id;
  attachedSettingIds?: Id[];
  sessionHistory?: ChatTurn[];
}
