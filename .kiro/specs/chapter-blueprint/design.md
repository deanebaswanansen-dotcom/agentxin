# 设计文档

## Overview

本设计描述「章节蓝图与分场景写作模块」（Chapter Blueprint Module）的技术方案。该模块是对既有 AI 小说创作工作台（Novel Writing Agent）的扩展，让写作 Agent 从「直接写一章」升级为「先规划再写作」：根据章节需求生成结构化蓝图 → 按场景写正文 → 合并整章 → 字数与节奏检查 → 局部扩写或重写。

设计的首要目标是 **与既有架构无缝集成**，沿用既有分层、命名与风格：

- **前端**：React + TypeScript 单页应用。新增章节蓝图面板（`ChapterBlueprintPanel`）及若干子组件，复用既有 `apiClient`（fetch 封装 + SSE 消费）与 `ErrorToast`（全局错误提示）。
- **后端**：Node.js + Fastify + TypeScript。新增领域服务（`BlueprintService` / `SceneService` / `ChapterAssemblyService` / `WordCountService` / `PacingService`）与若干纯函数（蓝图解析/序列化/校验、字数统计、章节合并、各类 prompt 组装），新增 REST + SSE 路由。
- **持久化**：复用既有文件型 `DataStore`（单 JSON 文件 + 原子写入 + 启动恢复）。扩展接口新增蓝图、场景正文与检查报告的 CRUD，并在删除章节/项目时级联删除。
- **模型接入**：复用既有 `ModelProxy`（OpenAI 兼容流式转发，已支持 DeepSeek v4-pro 的 `reasoning_content`）与 `ModelConfigService`（内部完整配置 vs 对外掩码视图）。本模块所有模型调用一律经 `ModelProxy` 注入 API Key，响应中绝不含 Key 原文。

设计要点与既有系统保持一致：

1. 领域层（Services）只依赖抽象（`DataStore` / `ModelConfigService` / `ModelProxy`），通过依赖注入传入，便于替换与测试。
2. 核心逻辑（蓝图解析/序列化/校验、字数统计、章节合并、prompt 组装）实现为 **纯函数**，无 IO、无副作用，便于独立做属性测试。
3. 模型代理支持流式转发（SSE），分场景写作/扩写/重写与整章生成走 SSE，蓝图生成与节奏检查在服务端聚合流后解析为结构化 JSON；任何路径均严格保证 API Key 不外泄。

实现按需求文档的三阶段推进：阶段一（蓝图生成、分场景写作、章节合并、整章生成）、阶段二（字数检查、扩写、重写）、阶段三（节奏检查）。本设计覆盖全部三阶段。

## Architecture

### 总体分层（在既有分层中插入本模块组件）

```
┌─────────────────────────────────────────────────────────────┐
│  前端 (React + TypeScript)                                    │
│  ├─ ProjectWorkspaceView / ChapterEditor / ChatPanel (既有)   │
│  ├─ ChapterBlueprintPanel (新增: 蓝图 + 场景列表 + 生成入口)  │
│  │   ├─ SceneStreamView   (分场景写作/扩写/重写流式渲染)      │
│  │   ├─ WordCountReportView / PacingReportView (报告展示)     │
│  │   └─ "采用合并正文" → 写回 ChapterEditor                   │
│  └─ apiClient (扩展 blueprint 命名空间) + ErrorToast (复用)   │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP / SSE (JSON)
┌───────────────────────────▼─────────────────────────────────┐
│  后端 (Node.js + Fastify + TypeScript)                        │
│  ├─ Routes (传输层) ── blueprintRoutes (新增, REST + SSE)     │
│  ├─ Services (领域层)                                         │
│  │   ├─ BlueprintService        (生成/读取/替换蓝图)          │
│  │   ├─ SceneService            (分场景写作/扩写/重写, 流式)  │
│  │   ├─ ChapterAssemblyService  (整章生成编排 + 合并)         │
│  │   ├─ WordCountService        (字数统计, 无模型)            │
│  │   └─ PacingService           (节奏检查, 经模型)            │
│  ├─ 纯函数 (可属性测试)                                       │
│  │   ├─ blueprintParser / blueprintSerializer / validate     │
│  │   ├─ wordCount / mergeScenes / compareSceneId             │
│  │   └─ buildXxxPromptMessages (各类 prompt 组装)            │
│  ├─ ModelProxy (复用: OpenAI 兼容转发, 流式)                  │
│  ├─ ModelConfigService (复用: 内部配置 vs 掩码视图)           │
│  └─ DataStore (扩展接口 + FileDataStore 实现)                │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTPS (Authorization: Bearer <key>)
┌───────────────────────────▼─────────────────────────────────┐
│  OpenAI 兼容模型提供商 (用户配置, 经 ModelProxy 转发)         │
└──────────────────────────────────────────────────────────────┘
```

### 请求流转

- **蓝图生成（REST，内部聚合流）**：Route → `BlueprintService` 读取项目设定组装上下文 → `ModelConfigService.getInternalConfig()` 取内部配置 → `ModelProxy.streamCompletion` 聚合为完整文本 → `parseBlueprint` 提取/解析 JSON → `validateBlueprint` 结构校验 → 持久化（替换既有）→ 返回蓝图 JSON。
- **分场景写作 / 扩写 / 重写（SSE 流式）**：Route hijack → `SceneService` 组装上下文 → `ModelProxy` 流式补全 → 后端以 SSE（`event: delta`）逐段转发 → 流结束后持久化整段场景正文 → `event: done`。
- **整章生成（SSE 流式编排）**：Route → `ChapterAssemblyService` 按 `scene_id` 升序逐个生成场景，每个场景流式转发并在生成完成后持久化，再生成下一个；全部完成后调用合并，将整章正文写入章节 `content`。
- **章节合并 / 字数检查（REST，无模型）**：Route → 对应 Service 读取蓝图与场景正文 → 纯函数计算 → 持久化 → 返回结果。
- **节奏检查（REST，内部聚合流）**：与蓝图生成同构——聚合模型输出后解析为 `PacingReport` 并持久化。

### 技术选型与既有一致性

- **复用 Fastify SSE 模式**：分场景写作/扩写/重写、整章生成完全沿用既有 `writingRoutes.ts` 的 SSE 契约（`reply.hijack()` + 直接写 `reply.raw`，`event: delta/done/error`，`AbortController` 监听 `reply.raw` 的 `close` 事件做取消）。
- **复用 `DataStore` 抽象**：新增数据继续保存在同一 `data/store.json`，沿用「写临时文件 + rename 原子替换」与启动恢复机制；领域层不感知具体实现。
- **复用 `ModelProxy` / `ModelConfigService`**：不新增任何模型接入逻辑；蓝图生成/节奏检查仅在服务端把流式增量聚合为完整字符串后再解析 JSON。
- **纯逻辑下沉**：所有解析、序列化、校验、统计、合并、prompt 组装均为纯函数，呼应既有 `buildPromptMessages` / `applyAdoption` 的可测试风格。

## Data Models

新增类型集中追加到既有 `backend/src/types/index.ts`（并同步到 `frontend/src/types/index.ts`，二者保持逐字节一致，与既有约定相同）。所有标识符沿用 `type Id = string`（UUID v4）。

### 章节蓝图与场景

蓝图字段严格对应需求 2.3（章节级）与 2.4（场景级）。`scene_id` 与 `chapter_id` 为字符串以容纳模型产出的多种形态（如 `"scene-1"`），排序由统一的比较函数 `compareSceneId` 决定（见纯函数小节）。

```typescript
/** 场景：章节蓝图中的最小施工单元（需求 2.4）。 */
interface Scene {
  scene_id: string;        // 章节蓝图内唯一（需求 4.4）
  name: string;            // 场景名称
  target_words: number;    // 目标字数, 正整数（需求 4.5）
  location: string;        // 地点
  characters: string[];    // 出场角色（与项目人物 name 对应）
  purpose: string;         // 场景目的（写作/重写约束, 需求 6.1/12.2）
  emotion: string;         // 情绪基调
  pacing: string;          // 节奏要求
  must_include: string[];  // 必含要点（写作/重写约束, 需求 6.1/12.2）
  ending_state: string;    // 结束状态（写作约束, 需求 6.1）
}

/** 章节蓝图：章节施工方案，以 JSON 持久化（需求 2.3）。 */
interface ChapterBlueprint {
  chapter_id: string;             // 关联章节标识符
  title: string;                  // 章节标题
  target_words: number;           // 章节目标字数, 正整数（需求 4.5）
  main_goal: string;              // 章节主目标
  tone: string;                   // 整体基调
  pacing: string;                 // 章节节奏要求
  required_plot_points: string[]; // 必含剧情点（节奏检查依据, 需求 10.1/10.2）
  forbidden_points: string[];     // 禁止事项（节奏检查依据, 需求 10.1/10.3）
  emotional_curve: string;        // 情绪曲线（节奏检查依据, 需求 10.1）
  scenes: Scene[];                // 场景数组（数量 3-7, 需求 4.2）
  ending_hook: string;            // 章末钩子
}
```

### 场景正文（SceneDraft）

每个场景的正文独立持久化，便于分场景写作、扩写、重写与按序合并。

```typescript
/** 场景正文：单个场景的生成文本，关联章节与场景标识符（术语表 SceneDraft）。 */
interface SceneDraft {
  chapterId: Id;       // 关联章节（数据存储内部主键, UUID）
  sceneId: string;     // 关联蓝图内的 scene_id
  content: string;     // 场景正文
  updatedAt: string;   // ISO 8601, 最近一次写入时间
}
```

> 说明：`ChapterBlueprint.chapter_id` 是蓝图自身携带的业务字段（可能来自模型产出），而持久化关联使用数据存储的章节主键 `Id`。两者在 `BlueprintRecord` 中通过 `chapterId`（主键）绑定，避免依赖模型产出的 `chapter_id` 做检索。

### 持久化记录（DataStore 内部结构）

为在单 JSON 文件中扩展存储，新增三类记录集合，均以章节主键 `chapterId` 关联，满足「一章至多一份蓝图 / 一份字数报告 / 一份节奏报告」（需求 5.3、9、10）：

```typescript
/** 蓝图持久化记录：一章至多一份（需求 5.3）。 */
interface BlueprintRecord {
  chapterId: Id;               // 章节主键（检索键）
  blueprint: ChapterBlueprint; // 结构化蓝图
  updatedAt: string;           // ISO 8601
}
```

### 字数检查报告（WordCountReport）

实际字数定义为「去除所有空白字符后剩余字符数」（术语表 ActualWordCount）。不足比例 = `(target_words − actualWords) / target_words`，达到或超过 0.15 时给出扩写建议，建议扩写字数 = `target_words − actualWords`（需求 9.3）。

```typescript
/** 单个场景的字数检查结果。 */
interface SceneWordCount {
  sceneId: string;
  targetWords: number;      // 场景蓝图 target_words
  actualWords: number;      // 实际字数, 无正文则计 0（需求 9.1）
  delta: number;            // actualWords − targetWords（需求 9.2）
  needsExpansion: boolean;  // 不足比例 ≥ 0.15（需求 9.3）
  suggestedExpansion: number; // 建议扩写字数 = max(0, target − actual)，仅在 needsExpansion 时 > 0
}

/** 字数检查报告：场景级 + 整章级（需求 9）。 */
interface WordCountReport {
  chapterId: Id;
  scenes: SceneWordCount[];
  chapterTargetWords: number;  // 章节蓝图 target_words
  chapterActualWords: number;  // 整章实际字数
  chapterDelta: number;        // 整章 actual − target（需求 9.2）
  generatedAt: string;         // ISO 8601
}
```

### 节奏检查报告（PacingReport）

依据蓝图 `pacing` / `emotional_curve` / `required_plot_points` / `forbidden_points` 检查整章正文（需求 10）。

```typescript
/** 剧情点完成状态（需求 10.2）。 */
type PlotPointStatus = 'completed' | 'partial' | 'missing';

/** 修改优先级（需求 10.4）。 */
type PacingPriority = 'high' | 'medium' | 'low';

/** 单个必含剧情点的完成情况。 */
interface PlotPointCheck {
  point: string;            // 对应 required_plot_points 中的一条
  status: PlotPointStatus;  // 已完成 / 部分完成 / 未完成
}

/** 按场景给出的节奏问题与建议（需求 10.4）。 */
interface ScenePacingIssue {
  sceneId: string;
  issue: string;            // 节奏问题描述
  suggestion: string;       // 修改建议
  priority: PacingPriority; // 高 / 中 / 低
}

/** 节奏检查报告（需求 10）。 */
interface PacingReport {
  chapterId: Id;
  plotPoints: PlotPointCheck[];      // 每个 required_plot_points 的完成状态（需求 10.2）
  violatedForbiddenPoints: string[]; // 被违反的禁止事项（需求 10.3）
  sceneIssues: ScenePacingIssue[];   // 按场景的问题/建议/优先级（需求 10.4）
  generatedAt: string;               // ISO 8601
}
```

### 请求体类型（传输层）

```typescript
/** 生成蓝图请求体（需求 1.1, 1.3, 1.4, 1.5）。 */
interface GenerateBlueprintBody {
  targetWords: number;   // 100–100000 的正整数（需求 1.3）
  requirement: string;   // 章节需求文本, 1–5000 字符（需求 1.4）
}

/** 场景重写请求体（需求 12.1, 12.5）。 */
interface RewriteSceneBody {
  instruction: string;   // 修改要求, 非空（需求 12.5）
}

/** 场景扩写请求体（需求 11.1, 11.2）。 */
interface ExpandSceneBody {
  addWords: number;      // 期望新增字数, 1–100000 的正整数（需求 11.2）
}
```

所有上述类型不含任何 API Key 字段，对外响应中 Key 由 `ModelProxy` / `ModelConfigService` 隔离，绝不出现（需求 15.3）。

## Components and Interfaces

### DataStore 接口扩展

在既有 `DataStore` 接口中追加蓝图、场景正文与两类报告的 CRUD 方法。命名、异步签名（返回 `Promise`）与「未找到返回 `undefined`、读写失败抛 `StoreError`」的约定与既有方法完全一致。

```typescript
interface DataStore {
  // …（既有项目/章节/设定/模型配置方法保持不变）

  // 章节蓝图（每章至多一份, 需求 5）
  saveBlueprint(chapterId: Id, blueprint: ChapterBlueprint): Promise<BlueprintRecord>;
  getBlueprint(chapterId: Id): Promise<BlueprintRecord | undefined>;
  deleteBlueprint(chapterId: Id): Promise<void>;

  // 场景正文（按 chapterId + sceneId, 需求 6.5, 11.5, 12.3）
  saveSceneDraft(chapterId: Id, sceneId: string, content: string): Promise<SceneDraft>;
  getSceneDraft(chapterId: Id, sceneId: string): Promise<SceneDraft | undefined>;
  listSceneDrafts(chapterId: Id): Promise<SceneDraft[]>;

  // 字数检查报告（每章至多一份, 需求 9.4, 13.3）
  saveWordCountReport(chapterId: Id, report: WordCountReport): Promise<WordCountReport>;
  getWordCountReport(chapterId: Id): Promise<WordCountReport | undefined>;

  // 节奏检查报告（每章至多一份, 需求 10.5, 13.3）
  savePacingReport(chapterId: Id, report: PacingReport): Promise<PacingReport>;
  getPacingReport(chapterId: Id): Promise<PacingReport | undefined>;
}
```

约定（与既有方法对齐）：

- `saveBlueprint` 为 **upsert**：同一 `chapterId` 已存在则整体替换，确保只保留一份（需求 5.3）。`saveWordCountReport` / `savePacingReport` 同理，每章至多一份（需求 9.4、10.5）。
- `saveSceneDraft` 按 `(chapterId, sceneId)` upsert：扩写/重写仅替换目标场景正文，其余不变（需求 11.5、12.3）。
- "未找到" 返回 `undefined`（如 `getBlueprint`），由服务层据此抛 `NOT_FOUND`；存储层只对真正的 IO/解析失败抛 `StoreError`。

### FileDataStore 单 JSON 结构扩展

`FileDataStoreState` 新增三个数组集合（沿用「集合恒存在、缺省为空数组」的 `normalizeState` 容错策略，向后兼容旧文件）：

```typescript
interface FileDataStoreState {
  projects: Project[];
  chapters: Chapter[];
  characters: Character[];
  worldSettings: WorldSetting[];
  outlines: Outline[];
  modelConfig?: ModelConfig;
  // —— 本模块新增 ——
  blueprints: BlueprintRecord[];      // 以 chapterId 唯一
  sceneDrafts: SceneDraft[];          // 以 (chapterId, sceneId) 唯一
  wordCountReports: WordCountReport[];// 以 chapterId 唯一
  pacingReports: PacingReport[];      // 以 chapterId 唯一
}
```

实现要点：

- 每个变更方法修改内存 `state` 后调用既有 `persist()`（写临时文件 + rename 原子替换），返回前完成写盘（需求 13.1）。
- `saveBlueprint`：在 `blueprints` 中查找 `chapterId`，存在则替换 `blueprint` 与 `updatedAt`，否则 push（需求 5.3）。报告方法同构。
- `saveSceneDraft`：按 `(chapterId, sceneId)` 查找替换或 push。
- `normalizeState` 对四个新集合做 `Array.isArray(...) ? ... : []` 兜底，旧 `store.json` 无这些字段时自动初始化为空数组，满足启动恢复且向后兼容（需求 13.2）。

#### 级联删除（需求 13.4）

复用既有级联模式：

- 扩展 `deleteChapter(id)`：除删除章节外，过滤掉 `blueprints` / `sceneDrafts` / `wordCountReports` / `pacingReports` 中 `chapterId === id` 的全部记录。
- 扩展 `deleteProject(id)`：先计算该项目下全部章节 id 集合，再连带删除这些章节关联的蓝图、场景正文与报告（与既有按 `projectId` 过滤章节/设定的逻辑并列）。

```
deleteProject(projectId):
  chapterIds = chapters.filter(c => c.projectId === projectId).map(c => c.id)
  chapters         ← 移除 projectId 匹配项（既有）
  characters/world/outlines ← 既有过滤
  blueprints       ← 移除 chapterId ∈ chapterIds
  sceneDrafts      ← 移除 chapterId ∈ chapterIds
  wordCountReports ← 移除 chapterId ∈ chapterIds
  pacingReports    ← 移除 chapterId ∈ chapterIds
  persist()
```

### 纯函数（领域逻辑核心，可属性测试）

下列纯函数无 IO、无副作用，相同输入恒产生相同输出，是属性测试的核心。建议放在 `backend/src/services/blueprint/` 下，与对应 `*.property.test.ts` 同目录（沿用既有布局）。

#### 蓝图解析 `parseBlueprint`

```typescript
/** 解析结果：成功携带蓝图, 失败携带错误原因（需求 3.1, 3.4, 3.5）。 */
type ParseResult =
  | { ok: true; blueprint: ChapterBlueprint }
  | { ok: false; reason: string };

/**
 * 从可能夹带额外说明文字的文本中提取 JSON 片段并解析为章节蓝图。
 * - 提取策略: 优先匹配 ```json … ``` 代码块; 否则从第一个 '{' 到与之匹配的
 *   '}' 做花括号配对扫描（跳过字符串字面量内的花括号）取出最外层 JSON 对象。
 * - 无可提取的合法 JSON → ok:false（需求 3.4）。
 * - 解析成功但缺少需求 2.3/2.4 所列任一章节级或场景级字段 → ok:false 并指出缺失字段（需求 3.5）。
 * 纯函数: 不做任何结构合理性校验（场景数/字数/唯一性由 validateBlueprint 负责）。
 */
function parseBlueprint(text: string): ParseResult;
```

#### 蓝图序列化 `serializeBlueprint`

```typescript
/** 将章节蓝图对象序列化为 JSON 文本（需求 3.2）。 */
function serializeBlueprint(blueprint: ChapterBlueprint): string;
```

> 往返保证（需求 3.3 / Property）：对任意合法蓝图，`parseBlueprint(serializeBlueprint(bp))` 必成功，且产出的蓝图所有章节级与场景级字段值与 `bp` 逐一相等。为此 `serializeBlueprint` 使用稳定字段集的 `JSON.stringify`，`parseBlueprint` 仅保留蓝图 schema 内字段。

#### 蓝图结构校验 `validateBlueprint`

```typescript
/** 校验结果: 通过, 或携带首个违规原因与建议错误消息。 */
type ValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * 校验已解析蓝图的结构规则（需求 4）：
 * 1. 场景数量 ∈ [3, 7], 否则 reason="场景数量超出允许范围"（需求 4.2）。
 * 2. 偏差比例 = |Σ scene.target_words − chapter.target_words| / chapter.target_words;
 *    严格大于 0.1 → reason="场景字数分配不合理"（需求 4.1, 4.3）。
 * 3. scene_id 全局唯一, 重复 → reason="场景标识符重复"（需求 4.4）。
 * 4. 章节 target_words 与每个场景 target_words 均为正整数, 否则 reason="字数取值非法"（需求 4.5）。
 * 校验顺序: 先做字数取值合法性（4.5）再算偏差比例, 避免除零/非数参与运算。
 */
function validateBlueprint(blueprint: ChapterBlueprint): ValidationResult;
```

辅助纯函数：

```typescript
/** 是否为正整数（> 0 且为整数）。供需求 1.3、4.5、11.2 复用。 */
function isPositiveInteger(value: number): boolean;

/** 偏差比例（需求 4.1）。前置: chapterTargetWords > 0。 */
function deviationRatio(sceneTargets: number[], chapterTargetWords: number): number;
```

#### 字数统计 `countActualWords` 与报告构建 `buildWordCountReport`

```typescript
/**
 * 实际字数 = 去除所有空白字符（含空格/制表/换行/全角空格等 Unicode 空白）后的字符数。
 * 以 Unicode 码点计数, 正确处理多字节字符（术语表 ActualWordCount, 需求 9.1）。
 */
function countActualWords(text: string): number;

/**
 * 由蓝图 + 各场景正文映射构建字数检查报告（纯函数, 需求 9）。
 * - 无正文场景 actualWords=0（需求 9.1）。
 * - 每场景 delta=actual−target; 整章 actual=各场景 actual 之和。
 * - 不足比例 (target−actual)/target ≥ 0.15 → needsExpansion=true,
 *   suggestedExpansion=target−actual（需求 9.3）。
 */
function buildWordCountReport(
  blueprint: ChapterBlueprint,
  drafts: ReadonlyMap<string, string>, // sceneId → content
): Omit<WordCountReport, 'chapterId' | 'generatedAt'>;
```

#### 场景排序与章节合并 `compareSceneId` / `mergeScenes`

```typescript
/**
 * scene_id 升序比较: 提取末尾数字按数值比较, 数值相同或缺失时退回字符串
 * 本地化比较, 保证全序且稳定（需求 7.1, 8.2）。
 */
function compareSceneId(a: string, b: string): number;

/**
 * 按 scene_id 升序拼接各场景正文为整章正文（需求 8.2）。
 * - 输入为 (sceneId, content) 列表; 以 compareSceneId 排序后以分隔符拼接。
 * - 纯函数: 不读取存储; 缺失场景的判定由调用方（ChapterAssemblyService）负责。
 */
function mergeScenes(parts: ReadonlyArray<{ sceneId: string; content: string }>): string;
```

#### Prompt 组装（复用 `buildPromptMessages` 风格）

均为纯函数，产出既有 `ChatMessage[]`，确保关键约束作为子串出现在消息中，便于属性测试。

```typescript
/** 蓝图生成 prompt: 注入项目大纲/人物/世界观 + 章节需求 + 目标字数 + 结构与字段要求（需求 2.2, 2.3, 2.4）。 */
function buildBlueprintPromptMessages(input: {
  requirement: string;
  targetWords: number;
  outlines: SettingSnippet[];
  characters: SettingSnippet[];
  worldSettings: SettingSnippet[];
}): ChatMessage[];

/** 场景写作 prompt: 注入场景 target_words/purpose/must_include/ending_state + 出场角色设定 + 上一场景正文（需求 6.1, 6.2, 6.3）。 */
function buildScenePromptMessages(input: {
  scene: Scene;
  characters: SettingSnippet[]; // 仅该场景出场角色
  previousSceneContent?: string;
  blueprintContext: Pick<ChapterBlueprint, 'title' | 'tone' | 'main_goal'>;
}): ChatMessage[];

/** 场景扩写 prompt: 注入当前正文 + 蓝图约束 + 保留剧情/走向/避免新增设定 + 目标字数=当前实际+addWords（需求 11.4）。 */
function buildExpandPromptMessages(input: {
  scene: Scene;
  currentContent: string;
  addWords: number;
  currentActualWords: number;
}): ChatMessage[];

/** 场景重写 prompt: 注入当前正文 + 蓝图约束 + 用户修改要求 + 保留 purpose/must_include 与相邻衔接（需求 12.1, 12.2）。 */
function buildRewritePromptMessages(input: {
  scene: Scene;
  currentContent: string;
  instruction: string;
}): ChatMessage[];

/** 节奏检查 prompt: 注入整章正文 + pacing/emotional_curve/required_plot_points/forbidden_points, 要求按结构化 JSON 输出（需求 10.1, 10.2, 10.3, 10.4）。 */
function buildPacingPromptMessages(input: {
  blueprint: ChapterBlueprint;
  chapterContent: string;
}): ChatMessage[];
```

### 领域服务

所有服务构造函数注入 `DataStore`、`ModelConfigService`、`ModelProxy`（按需），与既有 `WritingService` 一致；校验/未找到/未配置模型统一以 `ServiceError` 抛出。

#### BlueprintService（生成 / 读取 / 替换蓝图）

```typescript
class BlueprintService {
  constructor(
    private store: DataStore,
    private modelConfigService: ModelConfigService,
    private modelProxy: ModelProxy,
  ) {}

  /**
   * 生成并持久化章节蓝图（需求 1, 2, 3, 4, 5）。步骤（顺序至关重要）:
   * 1. 校验请求: targetWords ∈ [100,100000] 正整数（1.3）; requirement 非空且 ≤5000（1.4）;
   *    缺字段 → VALIDATION_ERROR（1.5）。
   * 2. 校验章节存在, 否则 NOT_FOUND（5.4）。
   * 3. 取内部模型配置, 缺失 → MODEL_NOT_CONFIGURED, 不触达 ModelProxy（2.5）。
   * 4. 读取项目 outlines/characters/worldSettings 作为上下文; 缺某类则空集合（2.1）。
   * 5. buildBlueprintPromptMessages → ModelProxy 聚合流为完整文本（2.2）。
   *    模型错误/超时 → ProxyError → PROVIDER_ERROR（2.6）。
   * 6. parseBlueprint: 失败 → VALIDATION_ERROR（含原因, 3.4/3.5）。
   * 7. validateBlueprint: 失败 → VALIDATION_ERROR（含原因, 4.x）。
   * 8. saveBlueprint upsert（替换既有, 仅留一份, 5.1/5.3）, 返回蓝图。
   */
  async generate(projectId: Id, chapterId: Id, body: GenerateBlueprintBody): Promise<ChapterBlueprint>;

  /** 读取某章节最新蓝图; 章节不存在或无蓝图 → NOT_FOUND（需求 5.2, 5.4, 5.6）。 */
  async get(chapterId: Id): Promise<ChapterBlueprint>;
}
```

> 聚合流辅助：`BlueprintService` 与 `PacingService` 通过一个共享私有助手把 `AsyncIterable<string>` 收敛为完整字符串（`for await` 累加），再交给纯函数解析。该助手不暴露 Key，错误透传为 `ProxyError`。

#### SceneService（分场景写作 / 扩写 / 重写，流式）

```typescript
class SceneService {
  constructor(
    private store: DataStore,
    private modelConfigService: ModelConfigService,
    private modelProxy: ModelProxy,
  ) {}

  /**
   * 分场景写作（SSE 流式, 需求 6）。
   * 1. 取内部配置, 缺失 → MODEL_NOT_CONFIGURED（6.7）。
   * 2. 取章节蓝图; 缺失 → NOT_FOUND。定位 scene_id; 不存在 → NOT_FOUND（6.6）。
   * 3. 组装上下文: 该场景出场角色设定（6.2）+ 上一场景已持久化正文（若有, 6.3）。
   * 4. buildScenePromptMessages → ModelProxy.streamCompletion, 逐段产出（6.4）。
   * 返回 AsyncIterable<string>; 路由层在流结束后整体持久化（见下「持久化时机」）。
   */
  async streamWriteScene(chapterId: Id, sceneId: string, signal: AbortSignal): Promise<AsyncIterable<string>>;

  /** 扩写（SSE 流式, 需求 11）。校验 addWords 1–100000 正整数（11.2）; 场景不存在 → NOT_FOUND（11.6）;
   *  目标场景无正文 → VALIDATION_ERROR「该场景尚未写作」（11.7）; 缺配置 → MODEL_NOT_CONFIGURED（11.8）。
   *  目标字数 = 当前实际字数 + addWords（11.4）。 */
  async streamExpandScene(chapterId: Id, sceneId: string, body: ExpandSceneBody, signal: AbortSignal): Promise<AsyncIterable<string>>;

  /** 重写（SSE 流式, 需求 12）。instruction 非空（12.5）; 场景不存在 → NOT_FOUND（12.4）;
   *  无正文 → VALIDATION_ERROR「该场景尚未写作」（12.6）; 缺配置 → MODEL_NOT_CONFIGURED（12.7）。 */
  async streamRewriteScene(chapterId: Id, sceneId: string, body: RewriteSceneBody, signal: AbortSignal): Promise<AsyncIterable<string>>;

  /** 持久化整段场景正文（流结束、未中止时调用）。upsert 仅改目标场景, 其余不变（6.5, 11.5, 12.3）。 */
  async persistSceneDraft(chapterId: Id, sceneId: string, content: string): Promise<void>;
}
```

**持久化时机（需求 6.8 / 11.5 / 12.3）**：与既有写作 SSE 一致，路由在 `for await` 中转发增量并就地累加完整文本；**仅当流正常结束且未被中止时** 才调用 `persistSceneDraft` 写入完整正文。模型错误/超时或客户端中止则不持久化部分内容（需求 6.8）。

#### ChapterAssemblyService（整章生成编排 + 合并）

```typescript
class ChapterAssemblyService {
  constructor(
    private store: DataStore,
    private modelConfigService: ModelConfigService,
    private modelProxy: ModelProxy,
    private sceneService: SceneService,
  ) {}

  /**
   * 整章生成（SSE 流式编排, 需求 7）。
   * 1. 取内部配置, 缺失 → MODEL_NOT_CONFIGURED, 不发起调用（7.5）。
   * 2. 取蓝图; 缺失 → NOT_FOUND。场景按 compareSceneId 升序（7.1）。
   * 3. 依次对每个场景: 流式生成 → 转发增量 → 生成完成后持久化该场景, 再开始下一个（7.2）。
   * 4. 某场景失败 → 停止后续, 保留此前已持久化场景, 抛出错误（7.4）。
   * 5. 全部完成 → 调用 merge 合并并写入章节 content（7.3）。
   * 以 SSE 增量转发; 可在帧中区分场景边界（如附加场景序号事件, 见路由小节）。
   */
  async streamAssembleChapter(chapterId: Id, signal: AbortSignal): Promise<AsyncIterable<AssemblyEvent>>;

  /**
   * 章节合并（REST, 需求 8）。
   * 1. 取蓝图; 缺失 → NOT_FOUND（8.5）。
   * 2. 读取全部场景正文; 若任一蓝图场景无已持久化正文 → VALIDATION_ERROR「存在未写作场景」,
   *    且不修改章节 content（8.4）。
   * 3. mergeScenes 按序拼接 → updateChapterContent 写入章节正文字段（8.3）, 返回合并正文。
   */
  async merge(chapterId: Id): Promise<{ content: string }>;
}

/** 整章生成流式事件: 文本增量, 或场景切换标记（用于前端分段展示）。 */
type AssemblyEvent =
  | { type: 'scene-start'; sceneId: string }
  | { type: 'delta'; sceneId: string; text: string }
  | { type: 'scene-done'; sceneId: string };
```

#### WordCountService（字数检查，无模型调用）

```typescript
class WordCountService {
  constructor(private store: DataStore) {}

  /**
   * 字数检查（需求 9, 13.3）。
   * 1. 取蓝图; 缺失 → NOT_FOUND。
   * 2. 读取各场景正文 → buildWordCountReport（纯函数）。
   * 3. saveWordCountReport upsert 持久化（9.4）, 返回报告。
   * 不调用模型: 纯统计, 无需 MODEL_NOT_CONFIGURED 检查。
   */
  async check(chapterId: Id): Promise<WordCountReport>;

  /** 读取最新字数检查报告; 无则 NOT_FOUND（需求 13.3, 13.5）。 */
  async getReport(chapterId: Id): Promise<WordCountReport>;
}
```

#### PacingService（节奏检查，经模型）

```typescript
class PacingService {
  constructor(
    private store: DataStore,
    private modelConfigService: ModelConfigService,
    private modelProxy: ModelProxy,
  ) {}

  /**
   * 节奏检查（需求 10, 13.3）。
   * 1. 取内部配置, 缺失 → MODEL_NOT_CONFIGURED, 不发起调用（10.6）。
   * 2. 取蓝图; 缺失 → NOT_FOUND。读取整章正文（合并后的章节 content 或现拼接）。
   * 3. buildPacingPromptMessages → ModelProxy 聚合流 → 解析为 PacingReport
   *    （plotPoints 完成状态 10.2 / violatedForbiddenPoints 10.3 / sceneIssues 含优先级 10.4）。
   * 4. savePacingReport upsert 持久化（10.5）, 返回报告。
   */
  async check(chapterId: Id): Promise<PacingReport>;

  /** 读取最新节奏检查报告; 无则 NOT_FOUND（需求 13.3, 13.5）。 */
  async getReport(chapterId: Id): Promise<PacingReport>;
}
```

### HTTP API（REST + SSE）

新增 `blueprintRoutes.ts`，沿用既有 `registerXxxRoutes(app, service)` 注入模式，在 `index.ts` 的 `buildServer` 中统一注册。错误一律经既有 `toErrorResponse` 映射为统一 `ApiError`。

| 方法 & 路径 | 类型 | 说明 | 关联需求 |
|---|---|---|---|
| `POST /api/chapters/:chapterId/blueprint` | REST | 生成蓝图 `{targetWords, requirement}` → 蓝图 | 1, 2, 3, 4, 5.1, 5.3 |
| `GET /api/chapters/:chapterId/blueprint` | REST | 获取最新蓝图 | 5.2, 5.4, 5.6 |
| `POST /api/chapters/:chapterId/scenes/:sceneId/write` | SSE | 分场景写作（流式） | 6 |
| `POST /api/chapters/:chapterId/assemble` | SSE | 整章生成（按序流式 + 合并） | 7 |
| `POST /api/chapters/:chapterId/merge` | REST | 合并场景为整章并写入章节正文 | 8 |
| `POST /api/chapters/:chapterId/word-count` | REST | 触发字数检查并持久化 | 9 |
| `GET /api/chapters/:chapterId/word-count` | REST | 获取最新字数检查报告 | 13.3, 13.5 |
| `POST /api/chapters/:chapterId/pacing` | REST | 触发节奏检查并持久化 | 10 |
| `GET /api/chapters/:chapterId/pacing` | REST | 获取最新节奏检查报告 | 13.3, 13.5 |
| `POST /api/chapters/:chapterId/scenes/:sceneId/expand` | SSE | 场景扩写 `{addWords}`（流式） | 11 |
| `POST /api/chapters/:chapterId/scenes/:sceneId/rewrite` | SSE | 场景重写 `{instruction}`（流式） | 12 |

> 路由以 `chapterId`（章节主键）为关联键，蓝图生成时需要项目设定上下文：`BlueprintService.generate` 内部通过 `store.getChapter(chapterId)` 取得 `projectId`，再读取该项目的 outlines/characters/worldSettings，因此 HTTP 路径无需携带 `projectId`，与"蓝图归属于章节"的语义一致。

#### SSE 线缆契约（与 `frontend/src/api/apiClient.ts` 既有解析器一致）

分场景写作、扩写、重写沿用既有写作 SSE 契约，逐字节兼容现有 `parseSseEvents` / `decodeDelta`：

| 事件 | 帧 | 说明 |
|---|---|---|
| 文本增量 | `event: delta\ndata: <JSON 字符串>\n\n` | 逐段转发提供商增量（6.4） |
| 完成 | `event: done\n\n` | 流正常结束（前端 resolve） |
| 失败 | `event: error\ndata: <JSON ApiError>\n\n` | 统一 `ApiError`（5.x/6.8/7.4） |

整章生成额外引入场景边界事件（向后兼容：不识别该事件的旧消费者忽略它，仍能拼接全文）：

| 事件 | 帧 | 说明 |
|---|---|---|
| 场景开始 | `event: scene\ndata: <JSON {sceneId}>\n\n` | 标记后续 delta 属于该场景（7.1） |
| 文本增量 | `event: delta\ndata: <JSON 字符串>\n\n` | 当前场景的增量（7.2） |
| 完成 | `event: done\n\n` | 全部场景生成并合并完成（7.3） |
| 失败 | `event: error\ndata: <JSON ApiError>\n\n` | 某场景失败即停止后续（7.4） |

#### 流式路由实现要点（复用既有 `writingRoutes.ts` 模式）

- `reply.hijack()` 后对 `reply.raw` 写 `200` 头（`Content-Type: text/event-stream` 等），所有失败（含流前抛出的 `MODEL_NOT_CONFIGURED` / `NOT_FOUND` / `VALIDATION_ERROR`）均以 `event: error` 帧输出，而非 HTTP 状态码。
- 用 `AbortController` 监听 **`reply.raw` 的 `close`**（非 `request.raw`），并以 `raw.writableEnded` 区分正常结束与真实断开，与既有实现一致。
- delta 以 `JSON.stringify` 编码，保证含换行/控制字符的文本块在行式 SSE 中无损传输。
- **持久化与中止**：在 `for await` 中累加完整文本；仅当未中止（`!controller.signal.aborted`）且流正常结束时调用 `persistSceneDraft`（分场景/扩写/重写）或写入章节正文（整章生成的合并阶段）。中止或出错不持久化部分内容（需求 6.8、7.4）。

#### REST 路由错误映射（既有 `toErrorResponse`）

| 场景 | code | HTTP | 关联需求 |
|---|---|---|---|
| 目标字数/扩写字数越界、需求文本空或超长、修改要求为空、存在未写作场景、场景未写作即扩写/重写、解析/校验失败 | `VALIDATION_ERROR` | 400 | 1.3, 1.4, 1.5, 4.x, 8.4, 11.2, 11.7, 12.5, 12.6, 3.4, 3.5 |
| 章节/场景/报告不存在 | `NOT_FOUND` | 404 | 5.4, 5.6, 6.6, 8.5, 11.6, 12.4, 13.5 |
| 未配置模型即生成/写作/检查 | `MODEL_NOT_CONFIGURED` | 409 | 2.5, 6.7, 7.5, 10.6, 11.8, 12.7 |
| 模型提供商错误/超时 | `PROVIDER_ERROR` | 502 | 2.6, 6.8 |
| 数据存储读写失败 | `STORE_ERROR` | 500 | 5.5, 13.6 |

### 前端组件

复用既有 `apiClient`（扩展 `blueprint` 命名空间）与 `ErrorToast`，新增章节蓝图面板及子组件，挂入既有 `ProjectWorkspaceView` 的章节工作区。

#### apiClient 扩展

```typescript
interface ApiClient {
  // …（既有 projects / chapters / settings / modelConfig / write 保持不变）
  blueprint: {
    get(chapterId: Id, signal?: AbortSignal): Promise<ChapterBlueprint>;
    generate(chapterId: Id, body: GenerateBlueprintBody, signal?: AbortSignal): Promise<ChapterBlueprint>;
    merge(chapterId: Id, signal?: AbortSignal): Promise<{ content: string }>;
    wordCount: {
      run(chapterId: Id, signal?: AbortSignal): Promise<WordCountReport>;
      get(chapterId: Id, signal?: AbortSignal): Promise<WordCountReport>;
    };
    pacing: {
      run(chapterId: Id, signal?: AbortSignal): Promise<PacingReport>;
      get(chapterId: Id, signal?: AbortSignal): Promise<PacingReport>;
    };
    // 流式: 复用既有 streamWrite 同款 SSE 消费逻辑（onDelta + AbortSignal）。
    writeScene(chapterId: Id, sceneId: string, options?: WriteOptions): Promise<string>;
    expandScene(chapterId: Id, sceneId: string, body: ExpandSceneBody, options?: WriteOptions): Promise<string>;
    rewriteScene(chapterId: Id, sceneId: string, body: RewriteSceneBody, options?: WriteOptions): Promise<string>;
    assembleChapter(chapterId: Id, options?: AssembleOptions): Promise<string>;
  };
}

/** 整章生成消费选项: 在既有 onDelta 基础上增加场景边界回调（可选）。 */
interface AssembleOptions extends WriteOptions {
  onSceneStart?: (sceneId: string) => void;
  onSceneDone?: (sceneId: string) => void;
}
```

流式方法复用既有 `streamWrite` 中的 `fetch` + `ReadableStream` + `parseSseEvents` + `decodeDelta` 逻辑（抽取为通用 `streamSse` 助手），整章生成额外识别 `event: scene` 帧并回调 `onSceneStart`。

#### 组件

- **`ChapterBlueprintPanel`**（容器）：进入某章节工作区时调用 `blueprint.get`。
  - 无蓝图（`NOT_FOUND`）→ 展示空状态「请先生成章节蓝图」，提供需求文本输入与目标字数输入（需求 14.7、14.1）。
  - 输入校验：需求文本为空或目标字数不在 100–100000 时禁用「生成蓝图」按钮（需求 14.2）。
  - 有蓝图 → 展示章节级字段 + 场景列表（`SceneList`）。
- **`SceneList` / `SceneCard`**：展示每个场景的 `name` / `target_words` / `purpose` / `must_include` 等，并对每个场景提供「写作」「扩写」「重写」入口；展示该场景已持久化正文（如有）。
- **`SceneStreamView`**：复用 `ChatPanel` 的流式渲染范式——`apiClient.blueprint.writeScene/expandScene/rewriteScene` 随增量追加展示，结束后允许查看完整正文（需求 14.3）。扩写需输入新增字数，重写需输入修改要求。
- **`ChapterAssembleView`**：触发整章生成，按 `onSceneStart` 分段流式展示各场景；完成后展示合并正文并提供「采用到章节」按钮 → 调用 `chapters.updateContent`（或先 `blueprint.merge` 已写入则刷新 `ChapterEditor`）将合并正文写入章节编辑器（需求 14.5、8.3）。
- **`WordCountReportView` / `PacingReportView`**：展示后端返回的报告（场景/整章字数差距与扩写建议；剧情点完成状态、被违反禁止事项、按场景问题与优先级）（需求 14.4）。
- **错误展示**：所有后端错误经 `onError` 上抛至既有 `ErrorToast`（需求 14.6），与既有组件一致。

文本采用逻辑复用既有纯函数 `applyAdoption`（插入/替换），整章合并正文默认整体替换章节正文。

## Error Handling

沿用既有统一错误结构与错误码（`ApiError` + `ErrorCode`），不新增错误码：

```typescript
interface ApiError {
  error: {
    code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'MODEL_NOT_CONFIGURED'
        | 'PROVIDER_ERROR' | 'STORE_ERROR';
    message: string; // 面向用户的失败原因（绝不含 API Key）
  };
}
```

错误来源与映射（复用既有 `ServiceError` / `StoreError` / `ProxyError` 与 `toErrorResponse`）：

| 错误场景 | 抛出 | code | HTTP | 关联需求 |
|---|---|---|---|---|
| 目标字数非 100–100000 正整数 | `ServiceError.validation` | `VALIDATION_ERROR` | 400 | 1.3 |
| 需求文本为空或超过 5000 字符 | `ServiceError.validation` | `VALIDATION_ERROR` | 400 | 1.4 |
| 缺少必填字段（章节标识符/目标字数/需求文本） | `ServiceError.validation` | `VALIDATION_ERROR` | 400 | 1.5 |
| 蓝图解析失败（无合法 JSON / 缺字段） | `ServiceError.validation` | `VALIDATION_ERROR` | 400 | 3.4, 3.5 |
| 结构校验失败（场景数/字数偏差/重复 scene_id/字数非法） | `ServiceError.validation` | `VALIDATION_ERROR` | 400 | 4.2–4.5 |
| 合并时存在未写作场景 | `ServiceError.validation` | `VALIDATION_ERROR` | 400 | 8.4 |
| 扩写字数非 1–100000 正整数 | `ServiceError.validation` | `VALIDATION_ERROR` | 400 | 11.2 |
| 扩写/重写目标场景尚无正文 | `ServiceError.validation` | `VALIDATION_ERROR` | 400 | 11.7, 12.6 |
| 重写修改要求为空 | `ServiceError.validation` | `VALIDATION_ERROR` | 400 | 12.5 |
| 章节/场景/报告不存在 | `ServiceError.notFound` | `NOT_FOUND` | 404 | 5.4, 5.6, 6.6, 8.5, 11.6, 12.4, 13.5 |
| 未配置模型即生成/写作/检查 | `ServiceError.modelNotConfigured` | `MODEL_NOT_CONFIGURED` | 409 | 2.5, 6.7, 7.5, 10.6, 11.8, 12.7 |
| 提供商错误/超时 | `ProxyError` | `PROVIDER_ERROR` | 502 | 2.6, 6.8 |
| 存储读写失败 | `StoreError` | `STORE_ERROR` | 500 | 5.5, 13.6 |

关键行为约束：

- **生成蓝图的检查顺序**：先做请求体校验（1.3/1.4/1.5）→ 章节存在性（5.4）→ 模型配置存在性（2.5），最后才调用模型。未配置模型时绝不触达 `ModelProxy`（需求 2.5、7.5、10.6），与既有 `WritingService` 的「先检查后调用」一致。
- **流式错误**：分场景写作/扩写/重写与整章生成中的失败（流前的 `MODEL_NOT_CONFIGURED`/`NOT_FOUND`/`VALIDATION_ERROR`，流中的 `PROVIDER_ERROR`/`STORE_ERROR`）统一以 SSE `event: error` 携带 `ApiError` 输出；前端 `apiClient` 将其转为 `ApiClientError` 交由 `ErrorToast` 展示。
- **部分生成不持久化**：模型错误/超时或客户端中止时，场景写作/扩写/重写均不写入部分正文（需求 6.8）；整章生成在某场景失败时停止后续并保留此前已持久化场景（需求 7.4）。
- **合并失败不破坏正文**：存在未写作场景时直接拒绝，不修改章节 `content`（需求 8.4）。

## 数据持久化与恢复

- 创建/更新蓝图、场景正文、字数报告、节奏报告均在返回前完成对 `DataStore` 的写入（需求 13.1），复用既有 `persist()` 原子替换。
- 后端重启时由 `FileDataStore.create` 从同一 JSON 文件恢复全部新增集合；`normalizeState` 对四个新集合做空数组兜底，旧文件平滑升级，恢复后数据与重启前最后一次持久化一致（需求 13.2）。
- 报告读取（`GET .../word-count`、`GET .../pacing`）始终返回最新已持久化报告（需求 13.3）；无报告时返回 `NOT_FOUND`（需求 13.5）。
- 删除章节或项目级联删除其关联蓝图、场景正文与报告（需求 13.4，见「级联删除」小节）。
- 任意读写失败抛 `StoreError` → `STORE_ERROR`（需求 13.6）。

## 安全性

- **API Key 仅服务端**：所有模型调用（蓝图生成、分场景/整章写作、扩写、重写、节奏检查）一律通过 `ModelConfigService.getInternalConfig()` 取得内部配置并交给既有 `ModelProxy` 注入 `Authorization: Bearer <key>` 出站头（需求 15.1、15.2）。
- **响应不含 Key 原文**：本模块所有返回给前端的对象（蓝图、场景正文、字数报告、节奏报告、SSE 增量与错误帧）均不含 API Key 字段，亦不拼接 Key。`ModelProxy` 产出的增量仅为 `delta.content`/`reasoning_content` 文本，错误经 `ProxyError` 构造为受控消息，绝不含 Key（需求 15.3）。
- **聚合流安全**：蓝图生成与节奏检查在服务端把流聚合为完整字符串后解析 JSON，聚合过程仅累加文本增量，不接触请求头/配置对象，因此聚合文本与解析结果均不含 Key。
- 沿用既有部署前提：当前无用户鉴权，服务端保存 Key 与小说数据，公网部署需在前置增加访问控制（与既有 design.md 安全章节一致）。

## Prework: Acceptance Criteria Testability Analysis

为生成正确性属性，先对各需求验收标准做可测试性分析（property=适合属性测试的不变量/往返/全称命题；example=具体示例或交互；edge-case=边界示例；no=纯交互/外部依赖）。

- 需求 1（输入校验）：1.3/1.4/1.5 为对输入域的全称校验 → property；1.1/1.2 为契约/接受两种格式 → example。
- 需求 2（生成）：2.1（缺类用空集）、2.3/2.4（字段齐全）可对解析结果做 property；2.2/2.5/2.6 为代理交互/前置检查 → example。
- 需求 3（解析/序列化）：3.3 序列化-解析往返字段相等 → property（核心）；3.1 夹带文字提取、3.4/3.5 失败原因 → property（含 edge-case）。
- 需求 4（结构校验）：4.1 偏差比例公式、4.2 场景数边界、4.3 偏差严格 >0.1、4.4 scene_id 唯一、4.5 正整数 → 全部 property（边界值用 edge-case 强化）。
- 需求 5（持久化）：5.3 替换且仅留一份、5.1/5.2 存读往返 → property；5.4/5.5/5.6 错误/失败 → example。
- 需求 6（分场景写作）：6.1/6.2/6.3 prompt 含约束/角色/上一场景 → property（对 prompt 组装纯函数）；6.4 流式、6.5 持久化、6.6/6.7/6.8 错误 → property（持久化关联）+ example（交互/错误）。
- 需求 7（整章生成）：7.1 按 scene_id 升序、7.2 逐场景先持久化、7.4 失败保留已持久化 → property（编排不变量，可用 fake proxy）；7.3/7.5 → example。
- 需求 8（合并）：8.2 按序拼接、8.4 未写作即拒绝且不改正文 → property；8.1/8.3/8.5 → example。
- 需求 9（字数检查）：9.1 实际字数定义、9.2 差值、9.3 不足比例阈值与建议字数 → property（纯函数核心）；9.4 持久化 → example。
- 需求 10（节奏检查）：10.2/10.4 报告取值域（状态/优先级枚举）可对解析结果做 property；10.1/10.3/10.5/10.6 依赖模型语义/交互 → example。
- 需求 11（扩写）：11.2 字数校验、11.4 目标字数=当前+新增、11.5 仅改目标场景 → property；11.3/11.6/11.7/11.8 → example。
- 需求 12（重写）：12.2 prompt 保留 purpose/must_include、12.3 仅改目标场景、12.5 空要求拒绝 → property；12.1/12.4/12.6/12.7 → example。
- 需求 13（持久化/恢复）：13.2 重启恢复一致、13.4 级联删除 → property；13.1/13.3/13.5/13.6 → example。
- 需求 14（前端）：全部为 UI 渲染/交互 → example（组件测试），不在属性测试范围。
- 需求 15（复用配置/代理）：15.3 响应不含 Key 原文 → property（对全部对外输出做 Key 子串检查）；15.1/15.2 → example（代理调用交互）。

## Correctness Properties

*属性（Property）是指在系统所有有效执行中都应成立的特征或行为——它是关于系统应当做什么的形式化陈述。属性在人类可读的规格与机器可验证的正确性保证之间架起桥梁。*

下列属性基于上节可测试性分析得出，覆盖蓝图解析/序列化/校验、字数统计、章节合并、编排不变量、prompt 组装、持久化/恢复/级联与安全等核心逻辑。UI 渲染（需求 14.x）与依赖模型语义或代理交互的标准（如 2.2/2.5/2.6、6.4/6.6/6.7、10.1/10.3/10.5/10.6、15.1/15.2 等）以示例/集成测试覆盖，不在属性测试范围。属性编号沿用本模块独立计数。

### Property 1: 目标字数范围校验

*For any* 数值 n，生成蓝图请求当且仅当 n 为 100 至 100000 之间的正整数时通过字数校验，否则返回 `VALIDATION_ERROR`。

**Validates: Requirements 1.3**

### Property 2: 需求文本长度校验

*For any* 字符串 s，生成蓝图请求当且仅当 s 非空且长度不超过 5000 个字符时通过文本校验，空字符串或长度超过 5000 时返回 `VALIDATION_ERROR`。

**Validates: Requirements 1.4**

### Property 3: 缺字段拒绝

*For any* 缺少目标字数、需求文本或目标章节标识符中任一项的请求，后端返回 `VALIDATION_ERROR`。

**Validates: Requirements 1.5**

### Property 4: 蓝图序列化-解析往返字段逐一相等

*For any* 合法章节蓝图对象 bp，`parseBlueprint(serializeBlueprint(bp))` 解析成功，且所得蓝图的全部章节级字段（chapter_id、title、target_words、main_goal、tone、pacing、required_plot_points、forbidden_points、emotional_curve、ending_hook）与每个场景的全部场景级字段（scene_id、name、target_words、location、characters、purpose、emotion、pacing、must_include、ending_state）均与 bp 逐一相等。

**Validates: Requirements 3.2, 3.3, 2.3, 2.4**

### Property 5: 夹带说明文字仍可提取并解析蓝图

*For any* 合法蓝图 JSON 文本与任意前缀/后缀说明文字 p、q，`parseBlueprint(p + json + q)` 仍解析成功并产出与原蓝图字段一致的对象。

**Validates: Requirements 3.1**

### Property 6: 无合法 JSON 的文本解析失败

*For any* 不包含可提取合法 JSON 对象的文本，`parseBlueprint` 返回失败结果并携带描述性原因。

**Validates: Requirements 3.4**

### Property 7: 缺字段对象解析失败

*For any* 合法蓝图删去任一章节级或场景级必需字段后序列化得到的文本，`parseBlueprint` 返回失败结果并指明缺失字段。

**Validates: Requirements 3.5**

### Property 8: 偏差比例计算公式

*For any* 场景 target_words 序列与正整数章节 target_words，`deviationRatio` 的返回值等于「所有场景 target_words 之和与章节 target_words 之差的绝对值除以章节 target_words」。

**Validates: Requirements 4.1**

### Property 9: 场景数量范围校验

*For any* 章节蓝图，`validateBlueprint` 当且仅当场景数量在 3 至 7 之间时不因场景数量被拒绝；场景数量小于 3 或大于 7 时返回提示场景数量超出允许范围的校验错误。

**Validates: Requirements 4.2**

### Property 10: 字数偏差严格大于 0.1 被拒绝

*For any* 章节蓝图，当其偏差比例严格大于 0.1 时 `validateBlueprint` 返回提示字数分配不合理的校验错误，偏差比例恰为 0.1 或更小时不因该规则被拒绝。

**Validates: Requirements 4.3**

### Property 11: 重复 scene_id 被拒绝

*For any* 含至少一对重复 scene_id 的章节蓝图，`validateBlueprint` 返回提示场景标识符重复的校验错误；全部 scene_id 互异时不因该规则被拒绝。

**Validates: Requirements 4.4**

### Property 12: 字数取值非正整数被拒绝

*For any* 章节 target_words 或任一场景 target_words 不是正整数的章节蓝图，`validateBlueprint` 返回提示字数取值非法的校验错误。

**Validates: Requirements 4.5**

### Property 13: 蓝图替换且仅保留一份

*For any* 章节与对其先后保存的两份蓝图，二次保存后数据存储中该章节恰好关联一份蓝图，且读回结果等于第二份蓝图。

**Validates: Requirements 5.1, 5.2, 5.3**

### Property 14: 实际字数等于去空白字符数

*For any* 字符串 s，`countActualWords(s)` 等于 s 去除全部空白字符（含空格、制表、换行及 Unicode 空白）后的码点数量。

**Validates: Requirements 9.1**

### Property 15: 字数差值与不足比例建议

*For any* 章节蓝图与各场景正文映射，所构建字数报告中：每个场景 delta 等于实际字数减目标字数，无正文场景实际字数为 0，整章实际字数等于各场景实际字数之和；当且仅当某场景不足比例（(target−actual)/target）达到或超过 0.15 时 needsExpansion 为真且 suggestedExpansion 等于 target−actual。

**Validates: Requirements 9.2, 9.3**

### Property 16: 章节合并按 scene_id 升序拼接

*For any* 场景正文片段集合的任意排列，`mergeScenes` 的输出等于按 `compareSceneId` 升序排列后拼接的结果（与输入顺序无关）。

**Validates: Requirements 8.2**

### Property 17: 存在未写作场景时合并被拒绝且正文不变

*For any* 章节蓝图，若存在至少一个无已持久化正文的场景，合并请求返回提示存在未写作场景的校验错误，且数据存储中对应章节的正文字段保持不变。

**Validates: Requirements 8.4**

### Property 18: 整章生成按 scene_id 升序逐场景持久化

*For any* 章节蓝图的场景集合，整章生成在使用 fake 代理成功时，按 `compareSceneId` 升序生成各场景，且每个场景在下一个场景开始前已被持久化。

**Validates: Requirements 7.1, 7.2**

### Property 19: 整章生成失败保留此前已持久化场景

*For any* 章节蓝图与失败发生于第 k 个场景的情形，整章生成停止后续场景生成，且前 k−1 个场景的已持久化正文均被保留。

**Validates: Requirements 7.4**

### Property 20: 场景写作上下文包含蓝图约束

*For any* 场景，`buildScenePromptMessages` 组装的消息内容包含该场景的 target_words、purpose、must_include 各项与 ending_state。

**Validates: Requirements 6.1**

### Property 21: 场景写作上下文包含出场角色设定

*For any* 场景与其出场角色设定集合，`buildScenePromptMessages` 组装的消息内容包含其中每个角色设定的内容。

**Validates: Requirements 6.2**

### Property 22: 场景写作上下文包含上一场景正文

*For any* 存在上一场景正文的情形，`buildScenePromptMessages` 组装的消息内容包含该上一场景的正文。

**Validates: Requirements 6.3**

### Property 23: 写作仅持久化目标场景

*For any* 章节及其场景集合，对某场景完成写作后，仅该场景的正文被写入，章节其余场景的正文保持不变。

**Validates: Requirements 6.5**

### Property 24: 提供商失败时不持久化部分场景正文

*For any* 在生成过程中失败的场景写作（注入失败代理），数据存储中该场景的正文保持失败前状态，不写入部分生成内容。

**Validates: Requirements 6.8**

### Property 25: 扩写字数范围校验

*For any* 数值 n，扩写请求当且仅当 n 为 1 至 100000 之间的正整数时通过校验，否则返回 `VALIDATION_ERROR`。

**Validates: Requirements 11.2**

### Property 26: 扩写指令包含目标字数与保留要求

*For any* 场景当前正文与扩写字数 addWords，`buildExpandPromptMessages` 组装的消息要求扩写后实际字数达到「当前实际字数 + addWords」，并包含保留既有关键剧情、维持原有剧情走向、避免新增重大设定的指令。

**Validates: Requirements 11.4**

### Property 27: 扩写仅改目标场景

*For any* 章节及其场景集合，对某场景扩写后，仅该场景正文被替换，章节其余场景的正文保持不变。

**Validates: Requirements 11.5**

### Property 28: 重写指令保留剧情功能

*For any* 场景，`buildRewritePromptMessages` 组装的消息包含该场景蓝图的 purpose 与 must_include，并包含维持与相邻场景衔接的要求。

**Validates: Requirements 12.2**

### Property 29: 重写仅改目标场景

*For any* 章节及其场景集合，对某场景重写后，仅该场景正文被替换，章节其余场景的正文保持不变。

**Validates: Requirements 12.3**

### Property 30: 空修改要求重写被拒绝

*For any* 修改要求文本为空字符串的重写请求，后端返回 `VALIDATION_ERROR`，且目标场景正文保持不变。

**Validates: Requirements 12.5**

### Property 31: 节奏报告剧情点状态取值合法

*For any* 成功解析的节奏检查报告，其每个剧情点完成状态取值均属于 {已完成, 部分完成, 未完成}，且为每个 required_plot_points 给出一条状态。

**Validates: Requirements 10.2**

### Property 32: 节奏报告修改优先级取值合法

*For any* 成功解析的节奏检查报告，其每条按场景的问题项的修改优先级取值均属于 {高, 中, 低}。

**Validates: Requirements 10.4**

### Property 33: 重启后从存储恢复全部新增数据

*For any* 写入数据存储的蓝图、场景正文、字数报告与节奏报告集合，基于同一持久化文件重新构造数据存储后，读回的全部数据与写入前一致。

**Validates: Requirements 13.2**

### Property 34: 删除章节或项目级联清除关联数据

*For any* 章节及其关联的蓝图、场景正文、字数报告与节奏报告，删除该章节或其所属项目后，这些关联数据在数据存储中均不再存在。

**Validates: Requirements 13.4**

### Property 35: 对外输出不含 API Key 原文

*For any* 已保存的模型配置与本模块任一对外输出（蓝图、场景正文、字数报告、节奏报告，以及 SSE 增量与错误帧），其完整序列化结果不包含 API Key 原文。

**Validates: Requirements 15.3**

## Testing Strategy

### 双重测试方法

- **单元测试**：覆盖具体示例、边界条件与错误条件；覆盖前端 UI 渲染与交互（需求 14.x）、模型代理调用交互（需求 2.2/2.5/2.6、6.4/6.6/6.7、7.3/7.5、10.1/10.5/10.6、11.x、12.x、15.1/15.2）、存储失败错误（需求 5.5、13.6）、报告 NOT_FOUND（需求 13.5）。
- **属性测试**：覆盖上述 35 条通用属性，验证跨大量随机输入下的不变量、往返与错误条件。

### 属性测试配置（与既有一致）

- 使用 `fast-check`（TypeScript 生态主流 PBT 库），与既有 `*.property.test.ts` 同目录同风格。
- 每条属性测试至少运行 100 次迭代（既有写作属性用 200，本模块沿用 ≥100）。
- 生成器需覆盖特殊字符、空白、Unicode、空集合、较长字符串与边界数值（如字数阈值 100/100000、不足比例 0.15、偏差 0.1、场景数 3/7）。
- 每条属性测试标注其对应设计属性，标签格式：**Feature: chapter-blueprint, Property {number}: {property_text}**。

### 蓝图/字数/合并纯函数测试要点

- `parseBlueprint`：用「合法蓝图序列化文本 + 随机前后缀」构造夹带文字样本（Property 5）；用删字段、损坏 JSON、纯文本构造失败样本（Property 6、7）。
- `validateBlueprint`：针对场景数、偏差比例、scene_id 唯一性、字数正整数分别构造命中/边界样本（Property 9–12），偏差 0.1 与 0.15 用 edge-case 强化。
- `countActualWords` / `buildWordCountReport`：生成含各类 Unicode 空白与多字节字符的文本，验证去空白计数与阈值/建议字数公式（Property 14、15）。
- `mergeScenes` / `compareSceneId`：对场景片段做任意置换，验证输出与升序拼接一致（Property 16）。

### 编排与服务测试要点（注入 fake 代理/存储）

- 整章生成：用 fake `ModelProxy`（产出可控、可在第 k 个场景抛错）验证升序、逐场景持久化与失败保留（Property 18、19）；用内存/临时文件 `DataStore` 验证仅目标场景被改（Property 23、27、29）。
- 「未配置模型不调用」：注入会记录调用的 fake 代理，断言其在 `MODEL_NOT_CONFIGURED` 路径下零调用（需求 2.5、6.7、7.5、10.6，示例测试）。
- 持久化/恢复/级联：基于临时文件 `FileDataStore` 跨实例重建验证恢复一致（Property 33），删除章节/项目后断言关联集合清空（Property 34）。

### 安全测试要点

- 在 Property 35 及相关代理/路由测试中，对前端可见的全部输出（含 SSE 帧、错误信息）做 API Key 原文子串检查，确保任何字段不泄露 Key（需求 15.3），与既有 design.md 的安全测试约定一致。

### 单元/集成测试要点

- `ModelProxy` 转发与 SSE 拼接复用既有测试范式（mock 提供商，验证调用参数与流式无损），本模块不重复实现代理逻辑。
- 路由层：以 `app.inject` 验证 REST 错误码到 HTTP 状态映射（与既有 `errorMapping` 一致），SSE 路由验证 `event: delta/scene/done/error` 帧格式与中止不持久化行为。
- 前端：以组件测试验证空状态（需求 14.7）、目标字数/需求文本校验禁用按钮（需求 14.2）、流式增量渲染（需求 14.3）、报告展示（需求 14.4）、采用合并正文写回编辑器（需求 14.5）与错误提示（需求 14.6）。

## Dependencies

- **后端**：复用既有 `fastify`、`fast-check`（PBT）、`vitest`（测试）。无需新增运行时依赖；新增数据全部存于既有 `data/store.json`。
- **前端**：复用既有 React + Vite 技术栈与 `apiClient`、`ErrorToast`，无新增依赖。
- **模型接入**：复用既有 `OpenAiCompatibleModelProxy` 与 `ModelConfigService`，兼容 DeepSeek v4-pro 等 OpenAI 兼容提供商（含 `reasoning_content` 流式）。
- **共享类型**：新增类型同时写入 `backend/src/types/index.ts` 与 `frontend/src/types/index.ts`，保持二者逐字节一致（沿用既有约定）。
