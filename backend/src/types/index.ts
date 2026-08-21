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

export type ProjectKind = 'novel' | 'short_drama';

export interface Project {
  id: Id;
  name: string;
  kind: ProjectKind;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

export interface Chapter {
  id: Id;
  projectId: Id;
  title: string;
  content: string; // 正文
  position: number; // 排序位置, 升序
  /** 正文乐观锁版本；旧数据缺失时按 0 处理。 */
  revision?: number;
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
  /** Optional same-provider model used only after structured-output Fixup fails. */
  structuredFallbackModelName?: string;
  temperature?: number; // 0-2, defaults to 1
  topP?: number; // 0-1, defaults to 1
}

// 返回前端的安全视图（API Key 掩码）
export interface ModelConfigView {
  baseUrl: string;
  modelName: string;
  structuredFallbackModelName?: string;
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
  | 'CONFLICT'
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
  CONFLICT: 'CONFLICT',
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
  /** 长篇小说模式：多子代理规划 + 章节循环 + Gate（SPEC V1）。 */
  | 'long_novel'
  | 'script_plan'
  | 'script_series_outline'
  | 'script_bible'
  | 'script_episode_batch'
  // Blueprint scenario tasks delegated to Python LangGraph core (refactor spec)
  | 'plan_blueprint'
  | 'write_scene'
  | 'write_chapter_from_blueprint';

/**
 * 长篇小说自动化等级（SPEC §6）。
 * - assistant：每步需用户发起，单次少章
 * - semi_auto：阶段可自动，严重冲突暂停
 * - auto：连续多章，普通问题自动修
 * - unattended：批量长跑，成本/冲突上限暂停
 */
export type LongNovelAutomationLevel = 'assistant' | 'semi_auto' | 'auto' | 'unattended';

export interface LongNovelModeConfig {
  enabled: boolean;
  automationLevel: LongNovelAutomationLevel;
  targetWords: number;
  targetChapters?: number;
  minWordsPerChapter: number;
  targetWordsPerChapter: number;
  maxWordsPerChapter: number;
  checkpointInterval: number;
  maxChaptersPerRun: number;
  maxConsecutiveFailures: number;
  planningEnabled: boolean;
  structuredMemoryEnabled: boolean;
  foreshadowTrackingEnabled: boolean;
  autoRevisionEnabled: boolean;
  chapterLoopEnabled: boolean;
  stopOnCanonConflict: boolean;
  stopOnOutlineDeviation: boolean;
}

export interface AgentRunRequest {
  task: AgentTask;
  mode: AgentRunMode;
  prompt: string;
  projectId?: Id;
  chapterId?: Id;
  scriptBatchOptions?: {
    startEpisode: number;
    episodeCount: number;
    expectedPlanRevision: number;
    draftMode?: 'structured_legacy' | 'direct_text';
  };
  options?: {
    targetWords?: number;
    /** full_novel / long_novel：本批章节数（1-500）。 */
    chapters?: number;
    /** full_novel / long_novel：最终总章数（1-500）。 */
    totalChapters?: number;
    /**
     * StoryForge 风格「计划采纳」：
     * 写正文前把分章大纲 / 创作规则写入项目资料，并注入写作上下文。
     */
    planSummary?: NovelPlanSummary;
    /** long_novel：自动化等级。 */
    automationLevel?: LongNovelAutomationLevel;
    /** long_novel：全书目标字数。 */
    totalWords?: number;
    /** long_novel：每章最低字数（格式 Gate）。 */
    minWordsPerChapter?: number;
    /** long_novel：每章最高字数（格式 Gate）。 */
    maxWordsPerChapter?: number;
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
  /** Bind a newly created project onto the durable job request. */
  projectId?: Id;
  /** Durable short-drama node checkpoint, when the running task is script based. */
  scriptCheckpoint?: {
    episodeNumber?: number;
    node: string;
    attempt: number;
    artifactRevision: number;
  };
}

/**
 * Internal execution metadata supplied by the durable job runner. It is not
 * parsed from an HTTP request and therefore cannot be spoofed by a client.
 */
export interface AgentRunExecutionContext {
  /** The user explicitly resumed a job that had paused for candidate review. */
  resumeRejectedCandidates?: boolean;
}

// ---------------------------------------------------------------------------
// Novel planning / brainstorm mode (pre-generation interview)
// ---------------------------------------------------------------------------

/** 计划模式可绑定的下游生成任务。 */
export type NovelPlanTargetTask = 'novel' | 'full_novel' | 'long_novel' | 'outline' | 'title';

/** 兼容旧客户端的计划深度标记；当前 Agent 不按固定轮数执行问卷。 */
export type NovelPlanDepth = 'light' | 'standard' | 'deep';

export interface NovelPlanQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface NovelPlanQuestion {
  id: string;
  question: string;
  /** 内部高影响评分（0-10）；低于 7 的问题不得主动询问。 */
  impactScore?: number;
  /** 是否允许多选（默认 false）。 */
  multiSelect?: boolean;
  options: NovelPlanQuestionOption[];
}

/** Agent 在提问或收束前输出的可审计决策清单，不包含隐藏思维链。 */
export interface NovelPlanChecklist {
  confirmedFacts: string[];
  unresolvedDecisions: string[];
  safeDefaults: string[];
  hardConstraints: string[];
}

export interface NovelPlanHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface NovelPlanAnswer {
  questionId: string;
  selectedOptionIds: string[];
  /** Human-readable option labels, so the planning agent receives the actual choice. */
  selectedOptionLabels?: string[];
  /** 用户自定义补充（对应「其他」）。 */
  customText?: string;
}

/** Plan Mode 的结构化目标配置；用户填写的字段优先于 Agent 默认值。 */
export interface NovelPlanConfig {
  targetTotalWords?: number;
  targetTotalChapters?: number;
  targetWordsPerChapter?: { min: number; max: number };
  targetVolumeCount?: number;
  genres?: string[];
  coreStory?: string;
  endingDirection?: string;
  writingRequirements?: string;
}

export interface ModelConnectionResult {
  ok: true;
  modelName: string;
  receivedOutput: boolean;
}

export interface NovelPlanTurnRequest {
  seedPrompt: string;
  /** 当前计划所属项目；提供后由服务端保存并恢复多轮状态。 */
  projectId?: Id;
  /** 明确开始新的计划会话，清除该项目的旧计划状态。 */
  resetSession?: boolean;
  /** v1.0 结构化计划输入；seedPrompt 保留用于兼容旧客户端。 */
  planConfig?: NovelPlanConfig;
  targetTask?: NovelPlanTargetTask;
  /** Optional decision budget retained for older clients; no fixed survey is used. */
  depth?: NovelPlanDepth;
  history?: NovelPlanHistoryTurn[];
  answers?: NovelPlanAnswer[];
  /** 强制收束为 ready（用户点「够了，出方案」）。 */
  forceReady?: boolean;
}

/** 计划模式下 Agent 生成的单章大纲。 */
export interface NovelPlanChapterOutline {
  number: number;
  title: string;
  /** 本章剧情目标 / 冲突 / 结尾钩子。 */
  goal: string;
  estimatedWords?: number;
}

/** 可被正文、剧本、人物分析和分镜模块共同消费的结构化故事计划。 */
export interface NovelStoryPlan {
  metadata: {
    title?: string;
    genre?: string;
    targetLength?: number;
    tone?: string;
    targetTotalChapters?: number;
    targetWordsPerChapterMin?: number;
    targetWordsPerChapterMax?: number;
    targetVolumeCount?: number;
  };
  premise: {
    oneSentence: string;
    coreConflict: string;
    theme?: string;
  };
  protagonist: {
    name?: string;
    age?: number;
    identity: string;
    personality: string[];
    motivation: string;
    goal: string;
    weakness: string;
    growthArc: string;
  };
  world: {
    overview: string;
    regions: string[];
    countries: string[];
    races: string[];
    religions: string[];
    factions: string[];
    history: string[];
  };
  powerSystem: {
    rules: string[];
    levels: string[];
    limitations: string[];
    specialCases: string[];
  };
  characters: Array<{
    name: string;
    role: string;
    identity?: string;
    traits: string[];
    motivation?: string;
    goal?: string;
    weakness?: string;
    arc?: string;
  }>;
  factions: string[];
  mainPlot: {
    beginning: string;
    development: string;
    climax: string;
    ending: string;
  };
  subplots: string[];
  characterArcs: string[];
  volumes: Array<{
    number: number;
    title: string;
    goal: string;
    chapterStart: number;
    chapterEnd: number;
    targetWords?: number;
    mainConflict?: string;
    climax?: string;
    endingHook?: string;
    stages?: Array<{
      title: string;
      chapterStart: number;
      chapterEnd: number;
      goal: string;
      climax?: string;
      endingState?: string;
    }>;
  }>;
  foreshadowing: string[];
  mysteries: string[];
  constraints: {
    mustInclude: string[];
    mustAvoid: string[];
  };
}

export interface NovelPlanSummary {
  title?: string;
  genre?: string;
  genres?: string[];
  protagonist?: string;
  hook?: string;
  tone?: string;
  constraints?: string[];
  /** 全书目标总字数。 */
  totalWords?: number;
  /** 每章目标字数。 */
  wordsPerChapter?: number;
  /** 计划章节数。 */
  chapterCount?: number;
  /** 全书目标卷数。 */
  volumeCount?: number;
  /** 当前已展开的章节规划窗口末章；长篇计划按窗口滚动展开。 */
  plannedThroughChapter?: number;
  /** 计划模式 v1.0 的原始结构化配置。 */
  planConfig?: NovelPlanConfig;
  endingDirection?: string;
  writingRequirements?: string;
  /** Agent 生成的分章大纲（写正文前的章纲）。 */
  chapterOutlines?: NovelPlanChapterOutline[];
  /** 完整结构化 Story Plan，供所有下游 Agent 复用。 */
  storyPlan?: NovelStoryPlan;
}

export interface NovelPlanTurnResponse {
  status: 'asking' | 'ready';
  /** 服务端持久化计划会话 id。 */
  sessionId?: string;
  round: number;
  message: string;
  questions?: NovelPlanQuestion[];
  /** Agent 自检后的事实、未决项、默认项和硬约束。 */
  planningChecklist?: NovelPlanChecklist;
  /** 收束后的可直接喂给生成任务的完整需求 brief。 */
  brief?: string;
  planSummary?: NovelPlanSummary;
  /** 回传当前深度（选完后每轮都带上，方便前端缓存）。 */
  depth?: NovelPlanDepth;
  /** 该深度的目标轮次区间，如 [8, 10]。 */
  depthRoundRange?: [number, number];
}

export interface NovelPlanDecision {
  key: string;
  status: 'unknown' | 'asked' | 'answered' | 'delegated' | 'locked';
  value?: string | number | string[];
  source: 'user' | 'agent' | 'config';
  questionId?: string;
  updatedAt: string;
}

export interface NovelPlanSession {
  id: string;
  projectId: Id;
  seedPrompt: string;
  targetTask: NovelPlanTargetTask;
  depth?: NovelPlanDepth;
  planConfig?: NovelPlanConfig;
  history: NovelPlanHistoryTurn[];
  activeQuestions: NovelPlanQuestion[];
  decisions: Record<string, NovelPlanDecision>;
  lastResponse: NovelPlanTurnResponse;
  createdAt: string;
  updatedAt: string;
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
// 参考小说分析与创作迁移（Reference Novel Analyzer MVP）
// ---------------------------------------------------------------------------

/** 分析深度：快速 / 标准 / 深度。 */
export type ReferenceAnalysisDepth = 'quick' | 'standard' | 'deep';

/** 分析任务状态。 */
export type ReferenceAnalysisStatus =
  | 'imported'
  | 'parsing'
  | 'analyzing'
  | 'ready'
  | 'failed';

/**
 * 可迁移维度（只学方法，不抄内容）。
 * 与 SPEC「用户选择需要学习的维度」对齐。
 */
export type ReferenceTransferDimension =
  | 'pacing'
  | 'chapter_structure'
  | 'characterization'
  | 'suspense'
  | 'dialogue_density'
  | 'description_density'
  | 'emotion_curve'
  | 'payoff_frequency'
  | 'worldbuilding_delivery'
  | 'style';

export const REFERENCE_TRANSFER_DIMENSIONS: readonly ReferenceTransferDimension[] = [
  'pacing',
  'chapter_structure',
  'characterization',
  'suspense',
  'dialogue_density',
  'description_density',
  'emotion_curve',
  'payoff_frequency',
  'worldbuilding_delivery',
  'style',
] as const;

export interface ReferenceImportRequest {
  title?: string;
  author?: string;
  /** 纯文本正文（TXT / Markdown 粘贴或前端读文件后上传）。 */
  text: string;
  depth?: ReferenceAnalysisDepth;
  /** 是否完整作品（影响分卷推断提示）。 */
  isCompleteWork?: boolean;
}

export interface ReferenceChapterMetrics {
  wordCount: number;
  dialogueRatio: number;
  descriptionRatio: number;
  avgSentenceLength: number;
  paragraphCount: number;
}

export interface ReferenceChapterRecord {
  id: Id;
  number: number;
  title: string;
  /** 原文仅存参考库，不进创作上下文。 */
  content: string;
  wordCount: number;
  metrics: ReferenceChapterMetrics;
  /** 章节摘要（分析后填充，无大段原文）。 */
  summary?: string;
  functions?: string[];
  openHook?: string;
  endHook?: string;
  characters?: string[];
}

export interface ReferenceStyleProfile {
  avgSentenceLength: number;
  avgChapterWords: number;
  dialogueRatio: number;
  descriptionRatio: number;
  rhythmLabel: string;
  notes: string[];
}

export interface ReferencePacingProfile {
  avgChapterWords: number;
  shortChapterRatio: number;
  longChapterRatio: number;
  estimatedSmallConflictEveryN: number;
  estimatedMajorPayoffEveryN: number;
  notes: string[];
}

export interface ReferenceTransferableMethod {
  dimension: ReferenceTransferDimension;
  title: string;
  method: string;
  /** 为何可迁移（抽象层）。 */
  why: string;
  /** 如何应用到原创（不得抄袭原文）。 */
  howToApply: string;
}

export interface ReferenceCharacterProfile {
  name: string;
  role: string;
  identity: string;
  goal: string;
  motivation: string;
  traits: string[];
  arc: string;
  keyActions: string[];
}

export interface ReferenceCharacterRelationship {
  from: string;
  to: string;
  relation: string;
  evolution: string;
}

export interface ReferenceConflictProfile {
  type: 'core' | 'external' | 'internal' | 'relationship' | 'stage';
  parties: string[];
  description: string;
  stakes: string;
  progression: string;
}

export interface ReferencePayoffProfile {
  title: string;
  setup: string;
  trigger: string;
  payoff: string;
  impact: string;
  chapter: string;
}

export interface ReferenceWorldbuildingProfile {
  premise: string;
  rules: string[];
  factions: string[];
  locations: string[];
  systems: string[];
  history: string[];
  terminology: string[];
}

export interface ReferencePlotBeat {
  stage: string;
  chapters: string;
  summary: string;
  turningPoint: string;
}

export interface ReferenceForeshadowingProfile {
  setup: string;
  payoff: string;
  status: 'unresolved' | 'partial' | 'resolved' | 'uncertain';
}

export interface ReferenceReversalProfile {
  setup: string;
  reversal: string;
  effect: string;
  chapter: string;
}

export interface ReferenceCharacterOutfitProfile {
  name: string;
  /** 服装概述；没有描写时固定为“正文未描写”。 */
  outfit: string;
  /** 简短原文依据或上下文概述，不复制长段原文。 */
  evidence: string;
  certainty: 'explicit' | 'inferred' | 'not_described';
}

export interface ReferenceChapterOutfitProfile {
  chapter: string;
  characters: ReferenceCharacterOutfitProfile[];
}

export interface ReferenceCreativeProfile {
  oneLineSummary: string;
  genreGuess: string;
  coreConflict: string;
  /** 原作主线概述；旧字段名保留以兼容已存档数据。 */
  mainPlotAbstract: string;
  /** 以下为原作事实性拆解，不是改写建议。旧档案可能没有这些字段。 */
  characters?: ReferenceCharacterProfile[];
  relationships?: ReferenceCharacterRelationship[];
  conflicts?: ReferenceConflictProfile[];
  payoffs?: ReferencePayoffProfile[];
  worldbuilding?: ReferenceWorldbuildingProfile;
  plotOutline?: ReferencePlotBeat[];
  foreshadowing?: ReferenceForeshadowingProfile[];
  reversals?: ReferenceReversalProfile[];
  themes?: string[];
  /** 按章节记录出场人物的服装；未描写也保留明确状态。 */
  chapterCharacterOutfits?: ReferenceChapterOutfitProfile[];
  /** 以下字段是可选的写法分析/迁移附录。 */
  characterMethods: string[];
  worldbuildingDelivery: string[];
  style: ReferenceStyleProfile;
  pacing: ReferencePacingProfile;
  transferableMethods: ReferenceTransferableMethod[];
  strengths: string[];
  risks: string[];
  /** 严禁迁移的内容提示。 */
  doNotCopy: string[];
  markdownReport: string;
}

export interface ReferenceNovelSummary {
  id: Id;
  title: string;
  author?: string;
  depth: ReferenceAnalysisDepth;
  status: ReferenceAnalysisStatus;
  chapterCount: number;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
}

export interface ReferenceNovelDetail extends ReferenceNovelSummary {
  chapters: Array<Omit<ReferenceChapterRecord, 'content'> & { contentPreview: string }>;
  profile?: ReferenceCreativeProfile;
  /** 是否仍保留原文（可删原文只留档案）。 */
  hasRawText: boolean;
}

export interface ReferenceImportResult {
  reference: ReferenceNovelSummary;
  chaptersDetected: number;
  wordCount: number;
  message: string;
  /**
   * 导入后章节清单（无正文，便于前端勾选分析范围）。
   * content 不返回，仅 preview。
   */
  chapters: Array<{
    id: Id;
    number: number;
    title: string;
    wordCount: number;
    contentPreview: string;
  }>;
}

/** 分析请求：可指定章节子集；不传则按深度抽样全书。 */
export interface ReferenceAnalyzeRequest {
  /** 按章节 id 选择（优先）。 */
  chapterIds?: Id[];
  /** 按章节序号选择（1-based）。 */
  chapterNumbers?: number[];
  /** 覆盖导入时的分析深度。 */
  depth?: ReferenceAnalysisDepth;
  /**
   * 最多参与模型综合的章节数（默认随深度：quick 12 / standard 30 / deep 60）。
   * 本地统计仍覆盖所选全部章节。
   */
  maxModelChapters?: number;
}

export interface ReferenceAnalyzeResult {
  reference: ReferenceNovelSummary;
  profile: ReferenceCreativeProfile;
  /** 自动创建/更新的左侧拆解项目。 */
  analysisProjectId: Id;
  analysisProjectName: string;
  /** 可在资料抽屉中直接打开的人物、世界观与大纲资料。 */
  artifacts: AgentArtifact[];
  chaptersAnalyzed: number;
  /** 用户勾选/参与本地统计的章节数。 */
  chaptersSelected: number;
  message: string;
}

export interface ReferenceTransferRequest {
  referenceId: Id;
  dimensions: ReferenceTransferDimension[];
  /** 用户补充的原创方向（可选）。 */
  originalBrief?: string;
}

export interface ReferenceTransferResult {
  projectId: Id;
  referenceId: Id;
  dimensions: ReferenceTransferDimension[];
  planMarkdown: string;
  artifacts: AgentArtifact[];
  summary: string;
}

export interface SimilarityCheckRequest {
  referenceId: Id;
  /** 待检文本；不传则用 chapterId 对应章节正文。 */
  text?: string;
  chapterId?: Id;
}

export interface SimilarityFinding {
  severity: 'low' | 'medium' | 'high';
  kind: 'ngram_overlap' | 'proper_noun' | 'long_span';
  message: string;
  evidence?: string;
}

export interface SimilarityCheckResult {
  projectId?: Id;
  referenceId: Id;
  riskLevel: 'ok' | 'warn' | 'block';
  score0to100: number;
  findings: SimilarityFinding[];
  summary: string;
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
