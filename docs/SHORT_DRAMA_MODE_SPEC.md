# AgentXin 短剧剧本模式 SPEC v1.0

状态：待评审  
创建日期：2026-08-14  
适用仓库：`agentxin`  
目标版本：短剧剧本模式 MVP  

## 1. 文档目的

本文定义 AgentXin 新增“短剧剧本模式”的产品范围、领域模型、Agent 架构、接口、持久化、前端交互、导出格式、质量门、测试方案和接入顺序。实现必须以本文为准；需求或架构变化时先更新本文，再修改代码。

## 2. 前置假设

1. 短剧模式与现有小说模式并存，不用剧本结构替换小说结构。
2. 继续使用 React 18、TypeScript、Vite、Fastify 5、Node.js 22 和当前文件持久化方案。
3. 继续使用浏览器自带 API Key、`x-agentxin-client-id` 客户端隔离和阿里云 ECS 常驻后端。
4. 首版支持原创短剧；“导入小说并改编成短剧”留到 v1.1。
5. 首版生成封面提示词，不调用图片模型，也不实现付费、版权保护、团队协作和视频生产。
6. 默认每批生成 5 集；用户可配置总集数、单集时长、单集目标字数、场景上限和角色上限。

## 3. 目标与非目标

### 3.1 目标

- 用户从一个故事想法开始，通过 Agent 提问形成可确认的剧本策划。
- 策划确认后，依次形成全剧总纲、分集卡、详细分集大纲、人物圣经和世界圣经。
- 正文按 5 集一批生成，每集按标准短剧格式组织为场景、动作、字幕和对白。
- 生成任务支持刷新、切换项目、断网和服务器重启后的恢复。
- 所有结构化资料可编辑、可追踪版本，并作为后续集数的唯一事实来源。
- 整本和分批内容可导出 TXT、Markdown、DOCX；可选导出 Fountain 文本。

### 3.2 非目标

- v1.0 不生成分镜图片、视频、配音或封面图片。
- v1.0 不提供多人实时协作、账号体系或跨设备同步。
- v1.0 不兼容 Final Draft FDX 的完整生产字段、锁页和修订色。
- v1.0 不自动发布、购买服务或管理内容版权。
- v1.0 不允许一次请求连续生成全部 60 集正文。

## 4. 现状与目标结构对比

| 层级 | 当前小说模式 | 短剧模式目标 |
| --- | --- | --- |
| 项目 | `Project` 只有名称 | `Project.kind = novel | short_drama` |
| 策划 | `NovelPlanSummary` | 独立 `ScriptPlan`，保存市场、频类、时长、场景、对白密度等 |
| 大纲 | 自由文本 `Outline` 和小说章纲 | 全剧总纲、全量分集卡、当前批次详细分集大纲 |
| 人物 | 名称＋自由文本描述 | 结构化身份、外貌、服装、动机、弱点、口吻和关系 |
| 世界 | 标题＋自由文本内容 | 时间、地点、社会状态、规则、交通、通信、组织和道具 |
| 正文 | 章节＋小说场景草稿 | 集＋剧本场景＋结构化剧本块 |
| 编排 | `AgentOrchestrator` 长篇循环 | 独立 `ScriptDirector` 决策，复用后台任务基础设施 |
| 恢复 | 章节/场景检查点 | 每集、每场、每个 Agent 节点检查点 |
| 导出 | 小说 Markdown/TXT/DOCX | 标准中文短剧文本＋Markdown/DOCX/Fountain |

## 5. 开源项目调研

调研时间为 2026-08-14。Star、Fork 和更新时间仅用于判断社区活跃度，不作为选型的唯一依据。

| 项目 | 技术/定位 | 调研时数据 | License | 借鉴内容 | 采用方式 |
| --- | --- | ---: | --- | --- | --- |
| [Toonflow](https://github.com/HBAI-Ltd/Toonflow-app) | TypeScript，短剧“策划→编剧→分镜→出片”，决策/执行/监督 Agent | 13,872 Star / 2,510 Fork | Apache-2.0 | ScriptAgent 分层、Skill 外置、项目级记忆隔离 | 参考架构和接口思想；不引入其视频链路 |
| [LocalMiniDrama](https://github.com/xuanyustudio/LocalMiniDrama) | JavaScript/Vue/Node/SQLite，本地短剧生产线 | 1,277 Star / 327 Fork | MIT | Drama→Episode→Scene→Storyboard 的实体边界、异步任务表、角色/场景资产分离 | 参考领域拆分；首版只实现文字层 |
| [Story Architect](https://github.com/story-apps/starc) | C++/Qt，专业剧本、人物、地点、世界与结构视图 | 374 Star / 50 Fork | GPL-3.0 | 剧本元素类型、场景标题、人物/地点资料独立、编辑器导航 | 只参考产品和领域概念，禁止复制 GPL 代码 |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | TypeScript，有状态 Agent 图和持久化检查点 | 3,205 Star / 548 Fork | MIT | 每个节点后保存状态、线程隔离、等待人工确认、故障恢复 | 参考检查点语义；v1.0 继续使用现有 `AgentJobRunner`，不新增框架依赖 |
| [webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer) | 长文本创作、分层记忆、审查、伏笔和状态沉淀 | 6,471 Star / 1,109 Fork | GPL-3.0 | 写前检索、写后事实沉淀、当前状态/伏笔/摘要分开保存 | 只参考记忆分层，禁止复制 GPL 代码 |

仓库热度数据快照日期为 2026-08-14；许可证以各仓库根目录的 `LICENSE` 文件为准。Star/Fork 只用于判断项目活跃度，不参与技术选型评分。

### 5.1 可直接使用的标准或库

| 项目 | 用途 | 决策 |
| --- | --- | --- |
| [Fountain 语法](https://fountain.io/syntax/) | 可移植的纯文本剧本交换格式 | 作为可选导出格式，不作为内部唯一数据源 |
| [screenplay-tools](https://github.com/wildwinter/screenplay-tools) | Fountain/FDX 的解析与写出，MIT | 实现 Fountain 导入或 FDX 时再评估依赖；MVP 先写无依赖序列化器 |

### 5.2 调研结论

1. 正确的稳定边界是 `Project → Plan/Bible → EpisodeOutline → Episode → Scene/Block`，不能继续把人物、世界和大纲只保存成不可校验的大段 Markdown。
2. Agent 可以自主决定调用哪个子 Agent，但持久化层必须使用显式状态机；“Agent 决策”和“可靠执行”不能混成一次模型请求。
3. 详细大纲采用滚动窗口：全剧先生成轻量分集卡，写到某批前再展开 5 集详细大纲，避免 60 集资料一次塞入上下文。
4. 内部以结构化 JSON 为事实源，中文短剧文本、Markdown、DOCX 和 Fountain 都由序列化器派生。
5. 现有 `AgentRunStore + AgentJobRunner` 已具备项目绑定、轮询和恢复基础，v1.0 不引入 LangGraph.js，降低迁移风险。

## 6. 用户流程

```text
新建项目并选择“短剧”
  → Agent 策划问答
  → 用户确认并锁定剧本策划
  → 生成全剧总纲和全量分集卡
  → 生成人物圣经和世界圣经
  → 用户确认当前 5 集详细大纲
  → 后台生成 5 集正文
  → 格式/连续性审查与定点修订
  → 用户检查并继续下一批
  → 导出整本或指定批次
```

阶段导航固定为：

```text
剧本策划 → 剧本大纲 → 角色设定 → 世界设定 → 1–5 集正文 → 6–10 集正文 → …
```

导航是资料成熟度和人工确认的状态展示，不是限制 Agent 推理的固定工作流。`ScriptDirector` 可以补问、回查资料或重新调用某个子 Agent，但未满足硬前置条件时不得越级写正文。

## 7. 术语与状态

### 7.1 术语

- 剧本策划（Script Plan）= 市场方向、题材参数、篇幅、格式和硬约束的结构化配置。
- 剧本圣经（Script Bible）= 已确认的人物、世界、关系、规则和连续性事实集合。
- 分集卡（Episode Card）= 覆盖全剧的轻量单集摘要，用于保证主线节奏。
- 详细分集大纲（Episode Outline）= 当前批次每集的冲突、场景、反转、卡点和必含项。
- 剧本块（Script Block）= 字幕、动作或对白等可校验的最小正文元素。
- 卡点（Ending Hook）= 单集结尾促使观众继续观看的悬念、反转或未完成动作。
- 质量门（Gate）= 在持久化或进入下一阶段前执行的确定性检查。

### 7.2 状态

```ts
type ScriptPlanStatus = 'draft' | 'approved' | 'locked';
type ScriptOutlineStatus = 'card' | 'expanded' | 'approved';
type ScriptEpisodeStatus =
  | 'planned'
  | 'generating'
  | 'reviewing'
  | 'completed'
  | 'failed';
```

允许的正文状态转换：

```text
planned → generating → reviewing → completed
                    ↘ failed → generating
```

`completed` 集允许用户编辑；编辑后增加 `revision`，后续 Agent 必须读取最新版本。后台任务写入时发现 `revision` 已改变，返回 `CONFLICT`，不得覆盖用户修改。

## 8. 领域模型

### 8.1 项目类型

```ts
export type ProjectKind = 'novel' | 'short_drama';

export interface Project {
  id: Id;
  name: string;
  kind: ProjectKind;
  createdAt: string;
  updatedAt: string;
}
```

旧项目加载时缺少 `kind` 一律迁移为 `novel`，不得根据项目名称猜测类型。

### 8.2 剧本策划

```ts
export interface ScriptPlan {
  id: Id;
  projectId: Id;
  status: ScriptPlanStatus;
  revision: number;
  title: string;
  theme: string;
  market: 'domestic' | 'overseas';
  channel: 'female' | 'male' | 'general';
  genres: string[];
  audience: string;
  coreConflict: string;
  logline: string;
  highlights: string[];
  totalEpisodes: number;
  episodeDurationSeconds: { min: number; max: number };
  targetCharsPerEpisode: number;
  maxPrimaryCharacters: number;
  maxScenesPerEpisode: number;
  dialogueDensityPercent: number;
  language: 'zh-CN';
  format: 'cn_short_drama';
  coreRequirements: string;
  forbiddenElements: string[];
  endingDirection: string;
  coverPrompt?: string;
  createdAt: string;
  updatedAt: string;
}
```

输入范围：

| 字段 | 范围 |
| --- | --- |
| `totalEpisodes` | 1–200 |
| `episodeDurationSeconds` | 30–180 秒，最小值不得大于最大值 |
| `targetCharsPerEpisode` | 300–3,000 个可见字符 |
| `maxPrimaryCharacters` | 1–20 人 |
| `maxScenesPerEpisode` | 1–5 场 |
| `dialogueDensityPercent` | 20–90 |
| `genres` | 1–6 项，去重后保存 |
| `coreRequirements` | 最多 4,000 个字符 |

### 8.3 人物圣经

```ts
export interface ScriptCharacter {
  id: Id;
  projectId: Id;
  name: string;
  aliases: string[];
  role: 'lead' | 'supporting' | 'antagonist' | 'minor';
  age?: number;
  occupation?: string;
  identity: string;
  biography: string;
  motivation: string;
  goal: string;
  weakness: string;
  arc: string;
  appearance: string;
  hairstyle: string;
  physique: string;
  defaultOutfit: string;
  personality: string[];
  skills: string[];
  speechStyle: string;
  catchphrases: string[];
  relationships: Array<{ characterId: Id; label: string; notes?: string }>;
  revision: number;
  updatedAt: string;
}
```

### 8.4 世界圣经

```ts
export interface ScriptWorldBible {
  projectId: Id;
  era: string;
  primaryLocations: string[];
  worldState: string;
  rules: string[];
  transport: string[];
  communication: string[];
  organizations: string[];
  recurringProps: string[];
  forbiddenAnachronisms: string[];
  revision: number;
  updatedAt: string;
}
```

### 8.5 总纲、分集卡和详细大纲

```ts
export interface ScriptSeriesOutline {
  projectId: Id;
  synopsis: string;
  openingState: string;
  midpointTurn: string;
  climax: string;
  endingState: string;
  mainArc: string[];
  subplotArcs: string[];
  episodeCards: ScriptEpisodeCard[];
  revision: number;
}

export interface ScriptEpisodeCard {
  episodeNumber: number;
  title: string;
  logline: string;
  mainEvent: string;
  endingHook: string;
}

export interface ScriptEpisodeOutline {
  id: Id;
  projectId: Id;
  episodeNumber: number;
  title: string;
  goal: string;
  conflict: string;
  beats: string[];
  characterIds: Id[];
  plannedScenes: Array<{
    ordinal: number;
    location: string;
    timeOfDay: 'day' | 'night' | 'dawn' | 'dusk';
    interiorExterior: 'interior' | 'exterior';
    purpose: string;
  }>;
  reveal?: string;
  reversal?: string;
  endingHook: string;
  requiredFacts: string[];
  forbiddenFacts: string[];
  status: ScriptOutlineStatus;
  revision: number;
}
```

全剧必须先拥有 `1..totalEpisodes` 连续且唯一的分集卡。详细大纲只要求当前批次和下一批次存在，单次最多展开 10 集。

### 8.6 剧本正文

```ts
export interface ScriptEpisode {
  id: Id;
  projectId: Id;
  episodeNumber: number;
  title: string;
  outlineId: Id;
  status: ScriptEpisodeStatus;
  targetChars: number;
  scenes: ScriptScene[];
  summary: string;
  newFacts: string[];
  openedThreads: string[];
  closedThreads: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptScene {
  id: Id;
  ordinal: number;
  location: string;
  timeOfDay: 'day' | 'night' | 'dawn' | 'dusk';
  interiorExterior: 'interior' | 'exterior';
  characterIds: Id[];
  blocks: ScriptBlock[];
}

export type ScriptBlock =
  | { id: Id; type: 'caption'; text: string }
  | { id: Id; type: 'action'; text: string }
  | {
      id: Id;
      type: 'dialogue';
      characterId?: Id;
      speaker: string;
      delivery?: string;
      mode?: 'normal' | 'os' | 'vo';
      text: string;
    };
```

结构化 JSON 是唯一事实源。界面显示的剧本文本和所有导出文件均由纯函数序列化器生成，禁止同时保存另一份可独立编辑的完整正文字符串。

## 9. 持久化设计

### 9.1 存储边界

小说实体继续使用现有 `DataStore/FileDataStore`。短剧资料新增独立端口：

```ts
export interface ScriptStore {
  getProjectState(projectId: Id): Promise<ScriptProjectState | undefined>;
  savePlan(plan: ScriptPlan, expectedRevision?: number): Promise<ScriptPlan>;
  saveCharacters(projectId: Id, items: ScriptCharacter[]): Promise<void>;
  saveWorldBible(value: ScriptWorldBible): Promise<void>;
  saveSeriesOutline(value: ScriptSeriesOutline): Promise<void>;
  saveEpisodeOutline(value: ScriptEpisodeOutline): Promise<void>;
  saveEpisode(value: ScriptEpisode, expectedRevision?: number): Promise<void>;
  deleteProject(projectId: Id): Promise<void>;
}
```

文件布局：

```text
<client-data-dir>/
├─ store.json
├─ scripts/
│  ├─ <project-id>.json
│  └─ <project-id>.json.tmp-<uuid>
├─ agent-runs.json
└─ plan-sessions/
```

每个短剧项目独立一个 JSON 文件，采用“临时文件＋同目录原子 rename”和串行写队列。这样不会因每次保存一场戏而重写所有小说项目，也便于项目级备份和删除。

### 9.2 文件结构

```ts
export interface ScriptProjectState {
  schemaVersion: 1;
  projectId: Id;
  plan?: ScriptPlan;
  characters: ScriptCharacter[];
  worldBible?: ScriptWorldBible;
  seriesOutline?: ScriptSeriesOutline;
  episodeOutlines: ScriptEpisodeOutline[];
  episodes: ScriptEpisode[];
  continuity: {
    currentState: string[];
    openThreads: string[];
    wardrobeLedger: Array<{
      episodeNumber: number;
      characterId: Id;
      outfit: string;
    }>;
  };
  updatedAt: string;
}
```

### 9.3 迁移

1. `Project.kind` 缺失时补为 `novel`。
2. 读取短剧文件时，缺失数组补空数组，未知 `schemaVersion` 返回 `STORE_ERROR`，不静默覆盖。
3. 删除项目时级联删除对应短剧文件、剧本任务和缓存，但仍沿用现有删除确认流程。
4. 所有迁移必须幂等；同一数据重复启动不会生成重复实体。

## 10. Agent 架构

### 10.1 总体结构

```text
ScriptDirector
  ├─ ScriptPlanningAgent
  ├─ SeriesOutlineAgent
  ├─ CharacterDesignAgent
  ├─ WorldDesignAgent
  ├─ EpisodeOutlineAgent
  ├─ ScriptWriterAgent
  ├─ ScriptContinuityAgent
  └─ ScriptRevisionAgent
```

`ScriptDirector` 是决策 Agent：读取当前项目状态、自检缺口、选择需要调用的子 Agent，并向用户提出高影响问题。子 Agent 只负责一个可验证产物，不负责修改其他阶段资料。

### 10.2 计划决策规则

- 用户已明确的信息直接锁定，禁止换题材或重复提问。
- 每轮最多 5 题，总问题预算 12 题；用户可选择“交给 Agent”。
- 进入策划确认前，必须确认或明确委托：题材、核心冲突、目标受众、总集数、单集时长、单集字数、场景上限、对话密度和结局方向。
- Agent 生成策划后进入 `draft`，用户点击确认后进入 `approved`；首次生成正文时自动进入 `locked`。
- `locked` 策划仍可修改，但必须提示会影响哪些未生成集数；已完成集数不得自动重写。

### 10.3 分集规划策略

1. `SeriesOutlineAgent` 生成全剧总纲和全部分集卡，按 10 集一段调用模型；每段完成立即持久化。
2. `EpisodeOutlineAgent` 只展开当前批次 5 集，允许提前展开下一批 5 集。
3. 分集卡提供全局节奏，详细大纲提供当前正文约束；正文 Agent 不读取其他 59 集的详细文本。
4. 后续批次规划必须读取上一批结束状态、未回收伏笔和人物状态变化。

### 10.4 单集生成策略

单集逻辑调用上限为 4 次：

```text
1. EpisodeScenePlanner：把详细大纲确认成 1–5 场
2. ScriptWriterAgent：一次生成全剧本结构 JSON
3. ScriptContinuityAgent：输出结构化审查结果
4. ScriptRevisionAgent：仅在硬错误时定点修订失败场景
```

临时网络错误允许每个步骤额外重试 2 次，使用指数退避 2 秒、5 秒。模型返回空内容、截断 JSON 或 429/5xx 时不得写入 `completed`。

### 10.5 上下文预算

每次写单集的输入最多 18,000 个中文可见字符：

| 上下文 | 上限 |
| --- | ---: |
| 已锁定策划与硬约束 | 2,500 |
| 世界圣经相关片段 | 2,500 |
| 本集出场人物档案 | 6,000 |
| 本集详细大纲 | 2,500 |
| 上一集结尾＋摘要 | 2,000 |
| 未回收伏笔与当前状态 | 1,500 |
| 格式和风格规则 | 1,000 |

截断优先级从低到高为历史摘要、非出场人物、非相关世界设定、风格示例。当前集大纲、硬约束、人物身份和未回收伏笔禁止截断。

### 10.6 记忆写回

每集通过质量门后写回：

- 150–300 字单集摘要。
- 人物地点、关系、已知信息和情绪变化。
- 新增、推进、回收的伏笔。
- 关键道具归属和状态。
- 每个出场人物的服装。
- 下一集必须继承的结束状态。

原始剧本是召回源；摘要和账本是提示词源。不得把完整历史正文逐集累加到提示词。

## 11. 后台任务与恢复

### 11.1 新任务类型

```ts
type AgentTask =
  | ExistingAgentTask
  | 'script_plan'
  | 'script_series_outline'
  | 'script_bible'
  | 'script_episode_batch';
```

复用 `/api/agent/jobs`：

```ts
interface ScriptBatchOptions {
  startEpisode: number;
  episodeCount: number; // 1–5
  expectedPlanRevision: number;
}
```

### 11.2 节点检查点

`script_episode_batch` 在以下位置同步保存检查点：

1. 当前 5 集详细大纲保存后。
2. 单集场景计划保存后。
3. 单集初稿保存为 `reviewing` 后。
4. 审查或修订完成并保存为 `completed` 后。
5. 批次报告生成后。

任务检查点必须记录 `projectId、episodeNumber、node、attempt、artifactRevision`。恢复时查询第一个未完成节点；已完成集只读复用，不重新调用模型。

### 11.3 项目隔离

- 每个任务同时绑定 `clientId` 和 `projectId`。
- 前端切换项目只切换显示，不取消后台任务。
- 返回原项目时通过 `/api/projects/:projectId/agent-jobs` 恢复进度和结果。
- 右侧 Agent 面板的消息、计划会话和运行状态均以 `projectId` 为键，禁止沿用上一个项目的界面状态。

## 12. API 设计

### 12.1 项目

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/projects` | 请求增加 `kind`，默认 `novel` |
| GET | `/api/projects/:id` | 返回项目完整信息和 `kind` |

### 12.2 剧本资料

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/api/projects/:id/script-plan` | 读取或保存策划草稿 |
| POST | `/api/projects/:id/script-plan/approve` | 确认策划，增加 revision |
| GET/PUT | `/api/projects/:id/script-characters` | 批量读取或保存人物圣经 |
| GET/PUT | `/api/projects/:id/script-world` | 读取或保存世界圣经 |
| GET/PUT | `/api/projects/:id/script-outline` | 读取或保存总纲和分集卡 |
| GET/PUT | `/api/projects/:id/episode-outlines/:number` | 读取或保存详细分集大纲 |
| GET/PUT | `/api/projects/:id/script-episodes/:number` | 读取或保存单集正文 |
| GET | `/api/projects/:id/script-episodes` | 按集号列出状态、字数和标题 |

PUT 请求包含 `expectedRevision`；版本冲突返回 HTTP 409 和 `CONFLICT`。

### 12.3 Agent 与导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/plan/script/turn` | 剧本策划多轮决策，SSE 心跳沿用现有实现 |
| POST | `/api/agent/jobs` | 创建总纲、圣经或 1–5 集后台任务 |
| GET | `/api/projects/:id/agent-jobs` | 恢复项目运行状态 |
| POST | `/api/agent/jobs/:id/cancel` | 在当前节点结束后取消 |

导出在前端基于结构化数据完成，首版不新增后端下载路由。

## 13. 剧本格式与序列化

### 13.1 中文短剧格式

```text
第一集
1-1 沈家老宅大门 日/外
人物：沈清 沈亦舟 周慧兰
【字幕：沧南市沈家百年老宅】
△沈清身穿白色衬衫与黑色西装裤，跨过门槛。
周慧兰（嗓子哑）：恭请太奶奶出房用膳——！
沈清（os）：这规矩，该改改了。
```

映射规则：

- 场景标题：`集号-场号 地点 时间/内外`。
- 人物行：按 `scene.characterIds` 对应的显示名输出。
- `caption`：输出 `【字幕：...】`。
- `action`：输出 `△...`。
- 普通对白：`角色（delivery）：text`。
- 内心独白：`角色（os）：text`。
- 画外音：`角色（vo）：text`。

### 13.2 Fountain 导出

Fountain 只作为交换格式：场景标题使用 `.INT.`/`.EXT.` 兼容写法，角色名和对白按 Fountain 规则输出；中国短剧特有字幕、OS/VO 使用注释或 parenthetical 保留。序列化必须是纯函数，并为中文、空 parenthetical、标点和多场景建立单元测试。

## 14. 质量门

### 14.1 硬错误

出现任意一项时不得标记 `completed`：

- 集号与请求集号不一致或同一项目集号重复。
- 正文没有场景，或场景数超出 `maxScenesPerEpisode`。
- 场号重复、缺失地点、缺失时间或缺失内外景。
- 对白缺少说话人，或说话人未登记且没有明确标为临时角色。
- 可见字符少于目标的 85%，或超过目标的 115%。
- 模型思维链、JSON 标签、Markdown 围栏或系统提示混入正文。
- 与锁定策划的题材、时代或硬禁忌直接冲突。
- 本集关键事件或结尾卡点为空。

可见字符定义：序列化后的中文、字母、数字和标点，排除空白、格式前缀和场景编号。

### 14.2 软问题

- 同一角色对白与已锁定口吻明显冲突。
- 相邻集服装、地点、持有道具或已知信息跳变。
- 任意两句对白标准化后相似度大于 0.92。
- 连续两场没有新的冲突、信息或人物状态变化。
- 本集前 20% 没有建立冲突，后 15% 没有形成卡点。
- 对话密度偏离策划值超过 15 个百分点。

软问题写入批次报告，不自动整集重写。只有能定位到具体场景和具体字段的问题才允许调用 `ScriptRevisionAgent`。

## 15. 前端工作台

### 15.1 项目入口

新建项目增加“小说 / 短剧”选择。短剧项目进入 `ScriptWorkspace`，小说继续进入现有 `ProjectWorkspaceView`。

### 15.2 页面组成

```text
顶部：项目名称、完成集数/总集数、总字数、Agent、设置、导出
左侧：阶段导航与每 5 集批次状态
中间：当前策划/大纲/人物/世界/剧本编辑区
右侧：封面提示词或 Agent 运行详情
底部：确认、生成当前阶段、继续下一批、停止
```

### 15.3 策划页

策划页以结构化表单展示：剧本名称、主题、市场、频类、题材、总集数、单集时长、角色上限、场景上限、语言、单集字数、对话密度、格式、核心要求和结局方向。每个 Agent 默认值显示来源标记，用户修改后来源变为 `user`。

### 15.4 大纲页

大纲页显示全剧总纲和连续分集卡；每 5 集为一组，组内可展开详细大纲。禁止把 60 集大纲保存成一个不可定位的大文本框。

### 15.5 人物与世界页

人物使用顶部标签切换，字段分区显示身份、人物小传、外貌、服装、性格、技能、弱点、口吻和关系；世界使用时间、地点、状态、规则、交通、通信、组织、道具分区。所有字段可单独编辑并保存 revision。

### 15.6 正文页

正文按 5 集分组，单集内按场景显示。初版编辑器允许新增/删除/重排剧本块；保存前实时显示可见字符、场景数、对白密度和硬错误。

## 16. 项目结构

```text
backend/src/
├─ types/index.ts
├─ services/script/
│  ├─ ScriptStore.ts
│  ├─ FileScriptStore.ts
│  ├─ ScriptPlanService.ts
│  ├─ ScriptDirector.ts
│  ├─ ScriptContextAssembler.ts
│  ├─ ScriptFormatter.ts
│  ├─ ScriptQualityGates.ts
│  └─ agents/
│     ├─ SeriesOutlineAgent.ts
│     ├─ CharacterDesignAgent.ts
│     ├─ WorldDesignAgent.ts
│     ├─ EpisodeOutlineAgent.ts
│     ├─ ScriptWriterAgent.ts
│     ├─ ScriptContinuityAgent.ts
│     └─ ScriptRevisionAgent.ts
├─ routes/scriptRoutes.ts
└─ services/agent/jobs/

frontend/src/
├─ types/index.ts
├─ components/script/
│  ├─ ScriptWorkspace.tsx
│  ├─ ScriptPlanPanel.tsx
│  ├─ ScriptOutlinePanel.tsx
│  ├─ ScriptCharacterPanel.tsx
│  ├─ ScriptWorldPanel.tsx
│  ├─ ScriptEpisodePanel.tsx
│  └─ ScriptRunPanel.tsx
├─ lib/scriptFormat.ts
└─ lib/scriptExport.ts
```

测试文件与被测模块放在同目录，沿用现有 `*.test.ts` / `*.test.tsx` 约定。

## 17. 代码风格

领域操作使用显式输入和不可变返回值；禁止用 `any` 承载模型结构。

```ts
export function validateEpisode(
  episode: ScriptEpisode,
  plan: ScriptPlan,
): ScriptGateReport {
  const issues = collectEpisodeIssues(episode, plan);
  return {
    hardFailed: issues.some((issue) => issue.severity === 'hard'),
    issues,
  };
}
```

约定：

- 类型使用名词，服务使用职责名，纯函数使用动词。
- 模型原始输出必须先解析、校验，再进入领域服务。
- Prompt 与解析器分离；Prompt 不直接执行持久化。
- 错误统一使用现有 `ServiceError` 和错误映射。
- 共享前后端类型在实现时保持字段一致，并用契约测试防止漂移。

## 18. 开发、构建和验证命令

```bash
# 后端开发
cd backend
npm ci
npm run dev

# 后端验证
npm run typecheck
npm test
npm run build

# 前端开发
cd ../frontend
npm ci
npm run dev

# 前端验证
npm run typecheck
npm test
npm run build
```

短剧专项测试命令在实现后固定为：

```bash
cd backend
npm test -- --run src/services/script src/routes/scriptRoutes.test.ts

cd ../frontend
npm test -- --run src/components/script src/lib/scriptFormat.test.ts src/lib/scriptExport.test.ts
```

## 19. 测试策略

### 19.1 单元测试

- 所有类型解析器、输入范围和枚举校验。
- 中文短剧序列化和 Fountain 序列化。
- 可见字符、对白密度、场景数、人物引用和重复台词检测。
- 上下文预算与截断优先级。
- 状态转换和 revision 冲突。

### 19.2 属性测试

- 任意合法 `ScriptEpisode` 序列化不得丢失集号、场号、人物和对白。
- 任意项目删除后不得遗留该项目的短剧实体。
- 任意批次恢复不得生成重复集号。
- 任意旧项目载入后 `kind` 必为 `novel`。

### 19.3 集成测试

- 策划问答→确认→总纲→圣经→5 集详细大纲→5 集正文完整链路。
- 第 4 集写作中断后重启，只恢复第 4、5 集。
- 切换项目后右侧运行记录、计划会话和正文不串线。
- 用户编辑已完成集后，旧后台任务写入触发 HTTP 409。
- 模型返回空内容、截断 JSON、429、502 和超时时不产生空集。

### 19.4 浏览器验收

使用 Playwright 完成两条主路径：

1. 原创都市女频短剧，10 集、每集 1,200 字、每批 5 集。
2. 西方玄幻短剧，10 集、每集 900 字、每批 5 集。

验收记录必须包含问题轮次、模型调用数、单集字数、场景数、耗时、恢复结果、请求错误和控制台错误。

## 20. 性能与可靠性指标

- 单集 1,200 字、最多 3 场时，正常逻辑调用不超过 4 次。
- 5 集批次正常逻辑调用不超过 21 次：1 次详细大纲＋每集最多 4 次。
- 每个模型步骤收到首个 SSE 心跳的时间不超过 8 秒。
- 后台任务每完成一个节点即持久化；服务器重启后最多重复当前未完成节点。
- 项目切换后 2 秒内显示该项目已持久化的任务状态，不展示其他项目消息。
- 10 集验收不得出现空集、重复集号、缺失场号或跨项目资料。

## 21. 安全与边界

### 21.1 始终执行

- API Key 只随请求发送，不写入短剧文件、日志、测试夹具或 Git。
- 所有新路由校验 `x-agentxin-client-id` 和项目归属。
- 每次提交前运行专项测试、全量 typecheck 和 build。
- 模型输出先净化思维链，再做结构校验和持久化。
- 删除、覆盖和批量重写必须有明确目标和用户确认。

### 21.2 实现前需要确认

- 新增第三方依赖，包括 `screenplay-tools` 或 LangGraph.js。
- 从文件存储迁移到 SQLite/PostgreSQL。
- 增加图片、视频或语音模型供应商。
- 修改现有客户端身份隔离和 API Key 策略。

### 21.3 禁止

- 复制 GPL/AGPL 项目的源码进入本仓库。
- 把模型隐藏推理、工具 XML、JSON 围栏写进剧本正文。
- 因某集失败而覆盖整个已完成批次。
- 通过提高超时时间掩盖没有心跳、检查点或恢复逻辑的问题。
- 让短剧类型改变现有小说项目的读取和导出结果。

## 22. 实施任务与依赖

### Task 1：共享契约与旧项目迁移

- 内容：增加 `Project.kind` 和全部短剧领域类型；旧数据缺失 `kind` 时补 `novel`。
- 验收：旧 `store.json` 原样加载；新短剧项目类型可往返保存。
- 验证：后端/前端 typecheck，`FileDataStore` 迁移属性测试。
- 预计文件：前后端类型、`FileDataStore`、对应测试，最多 5 个。
- 依赖：无。

### Task 2：独立 ScriptStore

- 内容：实现项目级短剧文件、原子写、revision 冲突和级联删除。
- 验收：并发保存不产生半文件；重启可恢复；删除无残留。
- 验证：`FileScriptStore.test.ts` 与属性测试。
- 预计文件：端口、实现、错误类型、测试，最多 4 个。
- 依赖：Task 1。

### Task 3：剧本资料 CRUD API

- 内容：实现策划、人物、世界、总纲、分集大纲和正文的读取/保存路由。
- 验收：所有路由验证客户端、项目类型、字段范围和 revision。
- 验证：`scriptRoutes.test.ts` 覆盖 200/400/404/409。
- 预计文件：路由、解析器、装配、测试，最多 4 个。
- 依赖：Task 2。

### Task 4：策划 Agent 与确认门

- 内容：实现题材自适应提问、策划自检、Agent 默认值、确认和锁定。
- 验收：不重复问题；九项关键决策全部确认或委托后才能批准。
- 验证：都市、西幻、校园三组计划测试和恢复测试。
- 预计文件：计划服务、Prompt 构建器、路由、测试，最多 4 个。
- 依赖：Task 3。

### Task 5：总纲、人物、世界和分集大纲 Agent

- 内容：实现 ScriptDirector 调度和 10 集分段卡片、5 集详细展开。
- 验收：集号完整、人物引用有效、每集有冲突与卡点；每个产物独立保存。
- 验证：结构解析、分段续写、幂等重试和题材约束测试。
- 预计文件：每次按一个 Agent＋解析器＋测试拆成多个小提交，每提交最多 5 个文件。
- 依赖：Task 4。

### Task 6：剧本写作、格式化和质量门

- 内容：实现结构 JSON 生成、中文短剧渲染、字数/格式/连续性检查和定点修订。
- 验收：合法样例可稳定渲染；硬错误不得完成；软问题不触发整集重写。
- 验证：序列化单测、属性测试和空响应/截断响应测试。
- 预计文件：写作 Agent、格式器、质量门、测试，最多 5 个。
- 依赖：Task 5。

### Task 7：5 集后台任务与恢复

- 内容：扩展 `AgentJobRunner`，记录节点检查点并绑定项目；实现取消与恢复。
- 验收：第 4 集中断后只补第 4、5 集；项目切换不串状态。
- 验证：任务存储测试、runner 测试、E2E 恢复测试。
- 预计文件：任务类型、runner、store、测试，最多 5 个。
- 依赖：Task 6。

### Task 8：短剧工作台与导出

- 内容：实现类型入口、阶段导航、结构化表单、人物/世界视图、分集编辑和导出。
- 验收：完整 10 集流程可从 UI 完成；导出顺序与界面一致。
- 验证：React Testing Library、导出单测、Playwright 主路径。
- 预计文件：按页面纵向拆成 4 个小提交，每提交最多 5 个文件。
- 依赖：Task 3–7。

### Task 9：全量回归、文档与灰度启用

- 内容：运行小说与短剧全量测试，更新手册和部署说明，以功能开关启用短剧入口。
- 验收：小说测试零回归；阿里云部署后两种项目均可创建和恢复。
- 验证：前后端全量测试、build、本地 Playwright、公网脱敏验收。
- 预计文件：功能开关、手册、验收脚本、测试，最多 4 个。
- 依赖：Task 8。

## 23. 发布策略

1. `SCRIPT_MODE_ENABLED=false` 合并基础类型、存储和 API，不显示入口。
2. 本地完成 10 集双题材验收后开启开发环境入口。
3. 阿里云部署后只对管理员浏览器开启，完成真实 API 的 10 集测试。
4. 确认无小说回归、空集、任务丢失和项目串线后设为默认开启。
5. 任何阶段失败均关闭入口，不回滚或删除已保存短剧文件。

## 24. 成功标准

- 用户可创建独立短剧项目，小说项目行为保持不变。
- 策划页完整保存截图中展示的核心字段，并允许用户确认和修改。
- 10 集测试全部生成，按 5 集分批，每集 1–5 场且字数误差不超过 ±15%。
- 人物、世界、分集大纲和正文全部结构化、可定位、可编辑。
- 刷新、切项目和后端重启后任务恢复，不重复生成已完成集。
- 正文不包含思维链、JSON、XML 或提示词残留。
- TXT、Markdown 和 DOCX 可导出整本及指定批次，顺序正确。
- 前后端 typecheck、全量测试和 build 通过，公网 E2E 无请求错误和控制台错误。

## 25. 待用户评审的范围选择

以下默认值不阻塞 SPEC 评审，进入实现前可调整：

- v1.0 默认面向 1–3 分钟竖屏短剧，但允许配置 30–180 秒。
- v1.0 默认 5 集一批，最多 5 场、每集 1,200 字。
- v1.0 先实现原创短剧；小说改编、分镜和视频生产排入后续版本。
- v1.0 不加入新的 Agent 框架和数据库依赖，优先复用现有运行时。

## 26. 参考资料

- Toonflow：<https://github.com/HBAI-Ltd/Toonflow-app>
- LocalMiniDrama：<https://github.com/xuanyustudio/LocalMiniDrama>
- Story Architect：<https://github.com/story-apps/starc>
- LangGraph.js：<https://github.com/langchain-ai/langgraphjs>
- LangGraph.js Persistence：<https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/concepts/persistence.md>
- webnovel-writer：<https://github.com/lingfengQAQ/webnovel-writer>
- Fountain：<https://fountain.io/>
- Fountain Syntax：<https://fountain.io/syntax/>
- screenplay-tools：<https://github.com/wildwinter/screenplay-tools>
