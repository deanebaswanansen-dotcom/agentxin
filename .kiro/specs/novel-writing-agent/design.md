# 设计文档

## Overview

本设计描述 AI 小说创作工作台（Novel Writing Agent）的技术方案。系统采用前后端分离架构：

- **前端**：React + TypeScript 单页应用（SPA），提供项目、章节、结构化设定与对话式写作的交互界面。
- **后端**：Node.js + TypeScript 服务端（采用 Fastify 作为 HTTP 框架），负责业务逻辑、数据持久化与模型代理转发。
- **持久化**：服务端文件型数据存储（基于 JSON 文件 + 原子写入），保证服务重启后数据可恢复，并支持多设备访问同一份数据。
- **模型接入**：统一 OpenAI 兼容接口。用户配置 base URL、API Key 与模型名称，后端作为代理将写作请求转发到目标提供商；API Key 仅存于服务端，不返回给前端。

设计目标：

1. 业务逻辑（领域层）与传输层（HTTP）、存储层（DataStore）解耦，便于测试与替换实现。
2. 写作上下文的组装逻辑为纯函数，可独立做属性测试。
3. 模型代理支持流式转发（SSE），并严格保证 API Key 不外泄。

## Architecture

### 总体分层

```
┌─────────────────────────────────────────────────────┐
│  前端 (React + TypeScript)                            │
│  ├─ ProjectListView / ProjectWorkspaceView           │
│  ├─ ChapterEditor / SettingsPanels                   │
│  ├─ ChatPanel (对话式写作, SSE 流式渲染)              │
│  └─ apiClient (fetch 封装, 错误统一处理)              │
└───────────────────────┬─────────────────────────────┘
                        │ HTTP / SSE (JSON)
┌───────────────────────▼─────────────────────────────┐
│  后端 (Node.js + Fastify + TypeScript)                │
│  ├─ Routes (传输层: 请求校验 / 响应序列化)            │
│  ├─ Services (领域层: 业务规则, 纯逻辑)               │
│  │   ├─ ProjectService / ChapterService              │
│  │   ├─ SettingService (人物/世界观/大纲)             │
│  │   ├─ ModelConfigService                           │
│  │   └─ WritingService (上下文组装 + 代理调用)        │
│  ├─ ModelProxy (OpenAI 兼容转发, 流式)               │
│  └─ DataStore (持久化接口 + 文件实现)                 │
└───────────────────────┬─────────────────────────────┘
                        │ HTTPS
┌───────────────────────▼─────────────────────────────┐
│  OpenAI 兼容模型提供商 (用户配置)                     │
└──────────────────────────────────────────────────────┘
```

### 请求流转

- **普通 CRUD 请求**：Route → Service → DataStore → 返回 JSON。
- **写作请求（流式）**：Route → WritingService 组装上下文 → ModelProxy 向提供商发起流式补全 → 后端以 SSE 将增量逐段转发给前端 → 前端在 ChatPanel 中实时渲染。

### 技术选型理由

- **Fastify**：内置 schema 校验（JSON Schema）、性能良好、对流式响应（`reply.raw` / SSE）支持友好。
- **文件型 DataStore**：满足"重启后恢复全部数据"的需求，无需额外数据库依赖即可跨设备访问（同一后端实例）。通过 `DataStore` 接口抽象，后续可替换为 SQLite/PostgreSQL 而不影响领域层。
- **领域层纯逻辑**：上下文组装、校验、排序等核心逻辑实现为纯函数，便于属性测试。

## Data Models

```typescript
// 唯一标识符统一使用 string（UUID v4）
type Id = string;

interface Project {
  id: Id;
  name: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

interface Chapter {
  id: Id;
  projectId: Id;
  title: string;
  content: string; // 正文
  position: number; // 排序位置, 升序
}

interface Character {
  id: Id;
  projectId: Id;
  name: string;
  description: string;
}

interface WorldSetting {
  id: Id;
  projectId: Id;
  title: string;
  content: string;
}

interface Outline {
  id: Id;
  projectId: Id;
  title: string;
  content: string;
  position: number;
}

interface ModelConfig {
  baseUrl: string;
  apiKey: string;    // 仅服务端存储, 绝不返回前端原文
  modelName: string;
}

// 返回前端的安全视图（API Key 掩码）
interface ModelConfigView {
  baseUrl: string;
  modelName: string;
  apiKeyMasked: string; // 例如 "sk-****abcd"
}
```

## Components and Interfaces

### DataStore 接口（持久化抽象）

```typescript
interface DataStore {
  // 项目
  createProject(name: string): Promise<Project>;
  listProjects(): Promise<Pick<Project, 'id' | 'name'>[]>;
  getProject(id: Id): Promise<Project | undefined>;
  renameProject(id: Id, name: string): Promise<Project>;
  deleteProject(id: Id): Promise<void>; // 级联删除关联实体

  // 章节
  createChapter(projectId: Id, title: string): Promise<Chapter>;
  listChapters(projectId: Id): Promise<Chapter[]>; // 按 position 升序
  getChapter(id: Id): Promise<Chapter | undefined>;
  updateChapterContent(id: Id, content: string): Promise<Chapter>;
  reorderChapters(projectId: Id, orderedIds: Id[]): Promise<void>;
  deleteChapter(id: Id): Promise<void>;

  // 结构化设定
  createCharacter(projectId: Id, name: string, description: string): Promise<Character>;
  createWorldSetting(projectId: Id, title: string, content: string): Promise<WorldSetting>;
  createOutline(projectId: Id, title: string, content: string): Promise<Outline>;
  listCharacters(projectId: Id): Promise<Character[]>;
  listWorldSettings(projectId: Id): Promise<WorldSetting[]>;
  listOutlines(projectId: Id): Promise<Outline[]>;
  updateCharacter(id: Id, fields: Partial<Pick<Character, 'name' | 'description'>>): Promise<Character>;
  updateWorldSetting(id: Id, fields: Partial<Pick<WorldSetting, 'title' | 'content'>>): Promise<WorldSetting>;
  updateOutline(id: Id, fields: Partial<Pick<Outline, 'title' | 'content'>>): Promise<Outline>;
  deleteCharacter(id: Id): Promise<void>;
  deleteWorldSetting(id: Id): Promise<void>;
  deleteOutline(id: Id): Promise<void>;

  // 模型配置（单例配置）
  saveModelConfig(config: ModelConfig): Promise<void>;
  getModelConfig(): Promise<ModelConfig | undefined>;
}
```

文件实现 `FileDataStore`：

- 数据保存在单个 JSON 文件（如 `data/store.json`），结构为 `{ projects, chapters, characters, worldSettings, outlines, modelConfig }`。
- 写入采用"写临时文件 + rename 原子替换"策略，避免写入过程中崩溃导致数据损坏。
- 启动时若文件存在则加载；不存在则初始化空结构。读写失败抛出 `StoreError`，由 Route 层转换为统一错误响应。

### HTTP API（REST + SSE）

| 方法 & 路径 | 说明 | 关联需求 |
|---|---|---|
| `POST /api/projects` | 创建项目 `{name}` → `{id}` | 1.1, 1.5 |
| `GET /api/projects` | 项目列表 | 1.2 |
| `PATCH /api/projects/:id` | 重命名 `{name}` | 1.4 |
| `DELETE /api/projects/:id` | 删除项目（级联） | 1.3 |
| `POST /api/projects/:id/chapters` | 创建章节 `{title}` | 2.1 |
| `GET /api/projects/:id/chapters` | 章节列表（按 position 升序） | 2.2 |
| `PATCH /api/chapters/:id/content` | 更新正文 `{content}` | 2.3 |
| `DELETE /api/chapters/:id` | 删除章节 | 2.4 |
| `PUT /api/projects/:id/chapters/order` | 章节排序 `{orderedIds}` | 2.5 |
| `POST /api/projects/:id/characters` 等 | 创建人物/世界观/大纲 | 3.1-3.3 |
| `GET /api/projects/:id/characters` 等 | 列表 | 3.4 |
| `PATCH /api/characters/:id` 等 | 更新条目 | 3.5 |
| `DELETE /api/characters/:id` 等 | 删除条目 | 3.6 |
| `PUT /api/model-config` | 保存/更新模型配置 | 4.1, 4.3, 4.4 |
| `GET /api/model-config` | 查看模型配置（掩码） | 4.2 |
| `POST /api/projects/:id/chapters/:chapterId/write` | 写作请求（SSE 流式） | 5.x, 6.x |

写作请求体：

```typescript
interface WritingRequestBody {
  operation: 'continue' | 'rewrite' | 'polish'; // 续写 / 改写 / 润色
  instruction: string;          // 用户指令
  selectedText?: string;        // 改写/润色目标文本
  attachedSettingIds?: {        // 附加到上下文的设定条目
    characterIds?: Id[];
    worldSettingIds?: Id[];
    outlineIds?: Id[];
  };
  sessionHistory?: ChatTurn[];  // 同一对话会话内的历史
}

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}
```

### WritingService：上下文组装（纯逻辑）

核心函数 `buildPromptMessages` 为纯函数，便于属性测试：

```typescript
interface WritingContextInput {
  operation: 'continue' | 'rewrite' | 'polish';
  instruction: string;
  chapterContent: string;           // 章节现有正文
  selectedText?: string;
  attachedSettings: SettingSnippet[]; // 已解析的设定内容
  sessionHistory: ChatTurn[];
}

interface SettingSnippet {
  kind: 'character' | 'world' | 'outline';
  title: string;   // 人物用 name, 其余用 title
  body: string;    // 描述 / 内容
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 组装规则：
// - system 消息包含附加的设定内容（若有）
// - 历史消息按顺序展开（保留先前用户指令与模型响应）
// - continue: 用户消息包含章节现有正文 + 指令
// - rewrite/polish: 用户消息包含选定文本 + 指令
function buildPromptMessages(input: WritingContextInput): ChatMessage[];
```

### ModelProxy：OpenAI 兼容转发

```typescript
interface CompletionResult {
  // 非流式：返回完整文本
  text: string;
}

interface ModelProxy {
  // 流式：以异步迭代器逐段产出增量文本
  streamCompletion(
    config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal
  ): AsyncIterable<string>;
}
```

转发规则：

- 向 `${baseUrl}/chat/completions` 发起 POST，请求头 `Authorization: Bearer ${apiKey}`，body 含 `model`、`messages`、`stream: true`。
- 解析提供商 SSE（`data: {...}` 行），抽取 `choices[0].delta.content` 增量并产出。
- API Key 仅出现在服务端到提供商的请求中；转发给前端的 SSE 仅包含文本增量与错误信息，绝不含 Key。
- 提供商返回非 2xx 或超时（AbortSignal）时，抛出 `ProxyError(reason)`，由 Route 层以错误事件转发前端。

### 前端组件

```typescript
// API 客户端：统一错误处理（后端错误信息 -> 抛出 ApiError 供 UI 展示）
const apiClient = {
  projects: { list, create, rename, remove },
  chapters: { list, create, updateContent, remove, reorder },
  settings: { /* characters / worldSettings / outlines CRUD */ },
  modelConfig: { get, save },
  write: (params) => EventSource-like 流式接口
};
```

- `ProjectListView`：展示项目列表 + 创建入口（需求 8.1）。
- `ProjectWorkspaceView`：选中项目后展示章节列表、人物、世界观、大纲（需求 8.2）。
- `ChapterEditor`：展示并编辑章节正文，保存时提交更新（需求 8.3, 8.4）。
- `ChatPanel`：对话式写作面板，流式渲染生成文本（需求 6.3），提供"采用"按钮将文本插入/替换到编辑器（需求 6.4）。
- `SettingsPanel`：查看与更新模型配置（需求 8.5）。
- 全局错误提示组件展示后端错误（需求 8.6, 4.x, 5.x, 7.4）。

文本采用逻辑（纯函数，便于测试）：

```typescript
// insert: 在 position 处插入；replace: 替换 [start, end) 区间
function applyAdoption(
  original: string,
  generated: string,
  target: { mode: 'insert'; position: number } | { mode: 'replace'; start: number; end: number }
): string;
```

## Error Handling

统一错误响应结构：

```typescript
interface ApiError {
  error: {
    code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'MODEL_NOT_CONFIGURED'
        | 'PROVIDER_ERROR' | 'STORE_ERROR';
    message: string; // 面向用户的失败原因
  };
}
```

| 场景 | code | HTTP 状态 | 关联需求 |
|---|---|---|---|
| 项目名为空 / 模型配置字段为空 | `VALIDATION_ERROR` | 400 | 1.5, 4.4 |
| 标识符不存在 | `NOT_FOUND` | 404 | 1.6, 2.6, 3.7 |
| 未配置模型即写作 | `MODEL_NOT_CONFIGURED` | 409 | 5.4 |
| 提供商错误 / 超时 | `PROVIDER_ERROR` | 502 | 5.5 |
| 数据存储读写失败 | `STORE_ERROR` | 500 | 7.4 |

- 流式写作请求中若发生错误，后端通过 SSE 发送 `event: error` 携带 `ApiError`，前端中止流并展示错误。
- 前端 `apiClient` 将任意非成功响应转换为 `ApiError` 并交由错误提示组件展示（需求 8.6）。

## 数据持久化与多设备

- 所有创建/更新/删除操作在返回前完成对 DataStore 的写入（需求 7.1）。
- 读取请求始终从 DataStore 返回最新持久化内容，任意设备通过同一后端访问到一致数据（需求 7.2）。
- 后端启动时从 JSON 文件加载全部数据（需求 7.3）。
- 写入采用原子替换，读写失败返回 `STORE_ERROR`（需求 7.4）。

## 安全性

- API Key 仅存于服务端 DataStore，对外仅暴露掩码视图（需求 4.2, 5.6）。
- 模型代理在服务端注入 `Authorization` 头，前端永不接触原始 Key。
- 注意：当前设计未包含用户认证/鉴权。由于服务端保存用户的 API Key 与全部小说数据，若部署在公网，必须在其前置增加访问控制（如反向代理鉴权或后续引入登录）。本设计默认单用户/可信网络环境部署。

## Correctness Properties

*属性（Property）是指在系统所有有效执行中都应成立的特征或行为——它是关于系统应当做什么的形式化陈述。属性在人类可读的规格与机器可验证的正确性保证之间架起桥梁。*

下列属性基于前述验收标准的可测试性分析得出。UI 渲染（8.x、6.3）、交互示例（4.5、5.1、5.2、5.5、7.4、8.4、8.6）将以示例/集成测试覆盖，不在属性测试范围内。

### Property 1: 项目创建-读回往返与唯一性

*For any* 由非空名称组成的项目序列，依次创建后，每个项目返回的标识符均唯一，且项目列表恰好包含这些已创建项目的标识符与名称。

**Validates: Requirements 1.1, 1.2**

### Property 2: 删除项目级联清除全部关联实体

*For any* 项目及其下任意数量的章节、人物、世界观与大纲条目，删除该项目后，该项目本身及其全部关联实体在数据存储中均不再存在。

**Validates: Requirements 1.3**

### Property 3: 项目重命名往返

*For any* 已存在的项目与任意非空新名称，执行重命名后读回的项目名称等于该新名称。

**Validates: Requirements 1.4**

### Property 4: 空名称创建被拒绝且状态不变

*For any* 由空或纯空白字符组成的项目名称，创建请求被拒绝并返回 `VALIDATION_ERROR`，且数据存储中的项目集合保持不变。

**Validates: Requirements 1.5**

### Property 5: 不存在的标识符返回 NOT_FOUND

*For any* 在数据存储中不存在的项目、章节或设定条目标识符，针对其的读取、更新、重命名或删除操作均返回 `NOT_FOUND` 错误。

**Validates: Requirements 1.6, 2.6, 3.7**

### Property 6: 章节创建-读回往返与唯一性

*For any* 在某项目下以非空标题创建的章节序列，每个章节返回的标识符均唯一，且可按其标识符读回对应标题。

**Validates: Requirements 2.1**

### Property 7: 章节列表按 position 升序

*For any* 项目及其任意章节集合（经过任意次创建与排序操作），章节列表返回结果的 position 字段单调非降。

**Validates: Requirements 2.2**

### Property 8: 章节正文更新往返

*For any* 章节与任意正文内容字符串（含特殊字符与空白），更新该章节正文后读回的正文内容与所提交内容相等。

**Validates: Requirements 2.3**

### Property 9: 删除章节仅影响目标章节

*For any* 项目的章节集合与其中任一章节，删除该章节后其不再存在，且集合中其余章节保持不变。

**Validates: Requirements 2.4**

### Property 10: 章节排序为提供顺序的置换往返

*For any* 项目已有章节标识符的任意排列，以该排列提交排序请求后，章节列表返回的顺序与该排列一致。

**Validates: Requirements 2.5**

### Property 11: 设定条目创建后出现在对应列表且字段一致

*For any* 项目下任意类型（人物、世界观、大纲）设定条目集合，逐个创建后，对应类型的列表恰好包含这些条目，且每个条目的字段与创建时所提交的值一致。

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

### Property 12: 设定条目更新往返

*For any* 已存在的设定条目与任意新字段值，更新后读回的对应字段等于所提交的值。

**Validates: Requirements 3.5**

### Property 13: 删除设定条目仅影响目标条目

*For any* 项目某类型的设定条目集合与其中任一条目，删除该条目后其不再存在，且同类型其余条目保持不变。

**Validates: Requirements 3.6**

### Property 14: 模型配置保存-读回往返

*For any* 由非空 base URL、API Key 与模型名称组成的模型配置，保存后内部读回的各字段与所提交的值一致。

**Validates: Requirements 4.1, 4.3**

### Property 15: 模型配置对外视图掩码 API Key

*For any* 已保存的模型配置，对外返回的配置视图包含 base URL 与模型名称，且其完整序列化结果不包含 API Key 原文。

**Validates: Requirements 4.2, 5.6**

### Property 16: 空字段模型配置被拒绝且已存配置不变

*For any* 至少含一个空字符串字段（base URL、API Key 或模型名称之一）的模型配置，保存请求被拒绝并返回 `VALIDATION_ERROR`，且数据存储中已存的模型配置保持不变。

**Validates: Requirements 4.4**

### Property 17: 流式增量保序无损转发

*For any* 提供商以任意分片方式产出的文本增量序列，后端转发给前端的全部增量按顺序拼接后，等于提供商产出增量按顺序拼接的结果（不丢失、不重复、不乱序）。

**Validates: Requirements 5.3**

### Property 18: 未配置模型时写作返回提示错误

*For any* 写作请求体，在数据存储中不存在模型配置时，后端返回 `MODEL_NOT_CONFIGURED` 错误。

**Validates: Requirements 5.4**

### Property 19: 写作上下文包含章节正文与指令（续写）

*For any* 章节正文与用户指令，`buildPromptMessages` 在 `continue` 操作下组装的消息内容包含该章节正文与该用户指令。

**Validates: Requirements 6.1**

### Property 20: 写作上下文包含选定文本与指令（改写/润色）

*For any* 选定文本与用户指令，`buildPromptMessages` 在 `rewrite` 或 `polish` 操作下组装的消息内容包含该选定文本与该用户指令。

**Validates: Requirements 6.2**

### Property 21: 采用文本的插入/替换正确性

*For any* 原始正文、生成文本与目标位置：在 `insert` 模式下，结果在指定位置嵌入生成文本，其余字符按序保留；在 `replace` 模式下，结果以生成文本替换指定区间 `[start, end)`，区间外字符按序保留。

**Validates: Requirements 6.4**

### Property 22: 附加设定内容进入写作上下文

*For any* 被选定附加的设定条目集合，`buildPromptMessages` 组装的消息内容包含其中每一个条目的内容。

**Validates: Requirements 6.5**

### Property 23: 会话历史按序保留于上下文

*For any* 对话会话的历史轮次序列，`buildPromptMessages` 组装的消息按原顺序包含全部历史轮次的内容。

**Validates: Requirements 6.6**

### Property 24: 重启后从存储恢复全部数据

*For any* 写入数据存储的项目及关联实体数据集合，基于同一持久化文件重新构造数据存储后，读回的全部数据与写入前一致。

**Validates: Requirements 7.3**

## Testing Strategy

### 双重测试方法

- **单元测试**：覆盖具体示例、边界条件与错误条件；覆盖 UI 渲染与交互（8.x、6.3）、代理调用交互（4.5、5.1、5.2、5.5）、存储失败错误（7.4）、前端错误展示（8.6）。
- **属性测试**：覆盖上述 24 条通用属性，验证跨大量随机输入下的不变量、往返与错误条件。

### 属性测试配置

- 使用 `fast-check`（TypeScript 生态主流 PBT 库）。
- 每条属性测试至少运行 100 次迭代（随机化）。
- 生成器需覆盖特殊字符、空白、Unicode、空集合与较长字符串等边界。
- 每条属性测试标注其对应设计属性，标签格式：**Feature: novel-writing-agent, Property {number}: {property_text}**。

### 单元/集成测试要点

- ModelProxy 转发：使用 mock 提供商验证调用参数与流式拼接，避免真实网络调用。
- 安全：在属性 15 与 17/5.6 相关测试中，对前端可见的全部输出做 API Key 原文子串检查。
- 存储：FileDataStore 的原子写入与跨实例恢复以集成测试覆盖（属性 24）。
