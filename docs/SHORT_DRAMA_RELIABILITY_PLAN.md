# AgentXin 短剧整本生成稳定性改造计划

状态：第一阶段实现完成，待合并部署与线上模型验收
版本：v1.0  
创建日期：2026-08-15  
适用仓库：`agentxin`  
关联文档：`docs/SHORT_DRAMA_MODE_SPEC.md`  

## 1. 文档目的

本文不是重新设计短剧模式，而是针对当前线上真实模型验收暴露的问题，给出一套可分批提交、可测试、可回滚的轻量改造计划。

本计划的最终目标是：用户只通过正常 UI 和公开 API，就能从策划开始连续完成一部 10 集短剧，不需要人工修改存储文件、不需要手工调用内部接口补资料，也不会因为一次模型 JSON 异常或主观校稿意见导致整批任务永久失败。

本文评审通过后，应先把确定的行为同步回 `SHORT_DRAMA_MODE_SPEC.md`，再开始功能实现。

### 1.1 一句话架构目标

> **保留现有任务框架，借 BAML 的结构输出、Dramatron 的分层创作、Novel-OS/DOME 的连续性状态、LangGraph 的恢复语义。**

这四部分都是本计划必须落地的目标，不是可有可无的参考：

1. **BAML 式结构输出层**：Schema-first、宽容解析、硬/软校验、显式 Fixup 和可配置模型 fallback。
2. **Dramatron 式创作分层**：策划、人物/世界、情节点、场景计划、单集结构稿逐级形成，阶段产物可持久化、可验证；第一阶段不增加“每场一次模型调用”。
3. **Novel-OS/DOME 式故事状态层**：正文与状态补丁分离；粗纲保持全局方向，局部细纲随当前批次展开；人物、时间、因果、道具和伏笔逐集提交。
4. **LangGraph 式恢复语义**：节点状态、checkpoint、错误回环、stale 检测和人工 interrupt；运行时继续使用现有 `AgentRunStore + AgentJobRunner`。

“借鉴”和“直接安装依赖”是两件事：四层结构必须实现；BAML 或 LangGraph 的 npm/runtime 是否直接进入生产依赖，需要通过小型试验证明收益，避免为了框架而框架。

## 2. 当前结论

### 2.1 保留的现有能力

当前代码已经具备以下可靠基础，不需要推倒重写：

- `ScriptDirector` 已按策划、总纲、圣经、分集和审查拆分节点。
- `AgentRunStore + AgentJobRunner` 已具备后台任务、项目隔离、去重和恢复能力。
- `FileScriptCheckpointStore` 已能保存节点产物与恢复游标。
- `structuredOutput.ts` 已有思维链清理、JSON 对象提取和宽松解析。
- `ScriptQualityGates` 已有确定性结构检查。
- 资料和正文已经使用 `revision / expectedRevision` 防止旧请求覆盖新内容。
- 前端已有 dirty guard、轮询恢复、批次阅读、校稿和可靠导出。

### 2.2 第一阶段明确不做

为了控制改造重量，第一阶段不做以下事情：

- 不引入 LangGraph、CrewAI、AutoGen 或新的多 Agent 运行时。
- 不迁移 SQLite、PostgreSQL 或向量数据库。
- 不在验证收益前把所有 Prompt 一次性改写成 BAML DSL；但 BAML 式结构输出契约、Fixup 和“已配置才启用、未配置则等待用户”的 fallback 决策路径是必做设计。
- 不一次生成完整 10 集或 60 集大 JSON。
- 不引入自动改写整集的“万能修稿 Agent”。
- 不复制 GPL/AGPL 项目的源码。
- 不为了通过测试而放宽必填人物字段或关闭确定性质量门。

第一阶段在现有架构上落实上述四层目标，具体补齐：契约一致、结构化输出修复、创作节点分层、局部修订、质量门分轨、连续性账本和节点恢复语义。

## 3. 线上验收暴露的问题

| 编号 | 实际现象 | 直接影响 | 根因判断 | 本计划对应任务 |
| --- | --- | --- | --- | --- |
| R1 | 人物圣经连续缺少 `hairstyle` | `script_bible` 整步失败 | 模型输出 Schema 失败不重试；人物与世界并发且一损俱损 | T2、T3 |
| R2 | 前端人物页无法填写完整必填字段 | 用户无法用 UI 修复人物卡 | 后端人物契约与编辑器字段不一致 | T2 |
| R3 | 模型连续返回不完整 review JSON | 单集失败，必须重跑整任务 | 解析失败被当成不可恢复错误，缺少定向修复节点 | T3 |
| R4 | 500 字草稿修订后缩成 245 字 | 正常正文被修订 Agent 删除 | 修订要求模型重写完整 Episode，且复检前已经覆盖正式稿 | T4 |
| R5 | AI 将钩子、语义线索等主观判断标为 hard | 确定性结构合格仍无法完成 | AI 问题直接参与 `hardFailed` | T5 |
| R6 | `requiredFacts` 同义表达仍被判缺失 | 产生误报并触发无效重写 | 使用正文精确字符串匹配语义事实 | T5 |
| R7 | 采用 AI 选题后产生半成品脏大纲 | 无法保存，也无法启动大纲 Agent | concept 同时修改 plan 和不完整 outline | T1 |
| R8 | 失败后按钮可能显示“生成第 2–6 集” | 跨越固定五集批次 | 下一批起点按全剧首个未完成集计算 | T1 |
| R9 | 单集上下文会遗漏或误用历史事实 | 后续集线索和人物状态漂移 | 缺少结构化、可审计的逐集连续性提交 | T6 |

## 4. 开源项目借鉴与采用边界

| 项目 | 借鉴内容 | 本项目采用方式 | 许可证边界 |
| --- | --- | --- | --- |
| [Google DeepMind Dramatron](https://github.com/google-deepmind/dramatron) | `梗概 → 人物/地点 → 情节点 → 场景对白` 的分层生成；阶段间允许人编辑 | 保留现有阶段导航，固定“场景计划 → 当前单集结构稿”；第一阶段不增加逐场模型调用 | Apache-2.0，可参考实现，但不整体移植 |
| [BAML](https://github.com/BoundaryML/baml) | Schema-Aligned Parsing、类型化 Prompt、`@assert/@check`、模型 fallback | 第一阶段只借“解析 → 校验 → Fixup”模式；人物圣经节点完成小型试验后再决定是否引入依赖 | Apache-2.0 |
| [Instructor-JS](https://github.com/567-labs/instructor-js) | Zod 驱动结构输出、把校验错误反馈给模型重问 | 借验证重问模式；第一阶段不要求引入 Zod/Instructor 依赖 | MIT |
| [jsonrepair](https://github.com/josdejong/jsonrepair) | 修复代码围栏、引号、逗号、缺括号及部分截断 JSON | 先用真实失败夹具评估；只有明显提升恢复率才增加这一项小依赖 | ISC |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | checkpoint、节点重试、错误回环、人工 interrupt | 借状态语义，继续使用现有 Runner 和 Checkpoint Store | MIT，不在第一阶段引入运行时 |
| [Novel-OS](https://github.com/mrigankad/Novel-OS) | 正文与 `STATE_UPDATE` 分离；确定性预检后再做 LLM 审稿 | 每集完成时提交正文和连续性状态补丁；先确定性 blocking，后 AI advisory | MIT；项目较新，只借数据流 |
| [DOME](https://aclanthology.org/2025.naacl-long.63/) | 粗纲、动态局部细纲和时间知识状态 | 保持全剧分集卡，当前五集展开详细大纲；连续性账本记录时间、人物和因果 | 论文与架构参考；代码仓库无明确许可证，不复制代码 |
| [RecurrentGPT](https://github.com/aiwaves-cn/RecurrentGPT) | 当前计划、短期摘要、长期记忆分层 | 使用“最近两集摘要 + 相关历史事实 + 当前集卡”，不累加整本正文 | GPL-3.0，只借思想，不复制代码 |
| [ConStory-Bench](https://github.com/Picrew/ConStory-Bench) | 人物、事实、风格、时间情节、世界设定五类连续性问题 | 作为 AI 校稿分类和验收数据集设计参考 | MIT；LLM judge 不能替代确定性质量门 |

结论：第一阶段不是“接入一个大框架”，而是把这些项目已经验证过的边界落到当前代码中。

### 4.1 四层目标架构与本地落点

| 目标层 | 主要参考 | 当前可复用模块 | 必须新增或调整 |
| --- | --- | --- | --- |
| 结构输出层 | BAML / Instructor-JS | `structuredOutput.ts`、现有领域 decoder、`BlueprintService` 的精简重试 | `generateStructured`、字段级 validation error、显式 Fixup、模型 fallback 策略、原始候选留档 |
| 创作分层 | Dramatron | `ScriptDirector` 的 plan/outline/bible/episode 节点 | 固定“全剧粗纲 → 当前五集细纲 → 单集场景计划 → 单集结构稿”；正文仍可一次返回本集的全部 scenes，但不得跳过已保存、已验证的场景计划，更不得一次返回五集 |
| 故事状态层 | Novel-OS / DOME | `ScriptProjectState`、episode summary、open threads、revision | 独立 continuity commit、人物/时间/道具/因果/伏笔账本、局部细纲滚动展开、正文与状态补丁分离 |
| 恢复执行层 | LangGraph | `AgentRunStore`、`AgentJobRunner`、`FileScriptCheckpointStore` | 更完整的节点状态、结构修复回环、waiting-user 语义、input fingerprint、stale candidate 拒绝提交 |

实现完成后，四层仍由现有 `ScriptDirector` 串联；不会另起一套与现有任务系统并行的隐藏流程。

## 5. 设计原则

### 5.1 模型输出永远是候选，不是事实

模型原始响应必须依次经过：净化、解析、契约校验、业务校验和版本校验。只有全部通过的候选产物才能写入正式资源。

### 5.2 一个节点只负责一个可验证产物

人物圣经和世界圣经必须成为两个可独立成功、失败和恢复的节点。某个人物卡缺字段时，只修复该人物，不重新生成全部人物和世界。

### 5.3 自动修复只能改出错范围

修订 Agent 不再返回整集正文。所有修订必须引用稳定的 `sceneId / blockId`，服务端只允许白名单操作，并验证未命中内容完全不变。

### 5.4 硬阻断必须可确定或可举证

Schema、枚举、ID、空场、非法人物、明确禁项和版本冲突可以硬阻断。节奏、钩子强弱、对白自然度和语义线索默认只能作为建议。

### 5.5 正文和连续性状态一起提交

每集正文通过后，同时提交人物、道具、时间线和伏笔变化。连续性状态是下一集提示词的结构化输入，不是从全部历史正文临时猜测。

### 5.6 第一阶段优先可观察、可恢复

每次模型尝试保留节点、attempt、原始响应摘要、解析错误、输入 revision 和候选 artifact。失败后应能知道“在哪一步、为什么失败、能否继续”，不能只显示一段通用错误。

## 6. 目标流水线

```text
AI 三选题
  ↓ 用户采用
策划草稿 → 保存 → 确认/锁定
  ↓
全剧粗纲 + 全量分集卡
  ↓
人物圣经节点 ─┐
               ├→ 当前五集详细大纲
世界圣经节点 ─┘
  ↓
逐集场景计划（保存并校验）
  ↓
一次生成当前单集 Episode 候选
  ↓
结构解析 / 契约校验
  ↓
确定性 blocking gate
  ↓
AI advisory review
  ↓ 有可定位问题
受限 Patch 修订 → 候选复检
  ↓
原子提交 completed Episode + current continuity commit
  ↓
下一集 / 下一固定五集批次
```

### 6.1 Episode 候选与正式稿边界

新生成的初稿和修订稿在通过质量门前都不是正式 `ScriptEpisode`，而是当前任务 checkpoint 中的候选 artifact：

```ts
interface ScriptInputRevisionRef {
  resource: 'plan' | 'outline' | 'characters' | 'world' | 'episode' | 'continuity';
  id: string;
  revision: number;
}

interface ScriptUpstreamArtifactRef {
  node: string;
  artifactRevision: number;
  artifactHash: string;
}

interface ScriptEpisodeCandidateArtifact {
  schemaVersion: 1;
  projectId: string;
  episodeNumber: number;
  baseEpisodeRevision: number;
  inputRevisionRefs: ScriptInputRevisionRef[];
  upstreamArtifactRefs: ScriptUpstreamArtifactRef[];
  promptVersion: string;
  modelConfigFingerprint: string; // 不包含 API Key
  inputFingerprint: string;
  candidateHash: string;
  stage: 'draft' | 'patched';
  episode: ScriptEpisodeInput;
  validationErrors: Array<{ path?: string; code: string; message: string }>;
  createdAt: string;
}
```

- 候选只写入 `FileScriptCheckpointStore`，不出现在普通 Episode 列表，也不改变正式稿 revision。
- 任务详情只显示候选阶段、字数和错误摘要；第一阶段不新增完整候选正文编辑器。
- 恢复任务从 checkpoint 读取候选并继续校验/修订，不重新调用已经成功的上游节点。
- 通过全部 blocking gate 后，候选正文与 continuity commit 在同一次 `FileScriptStore` mutation 中原子提交。
- checkpoint artifact 在同一 runKey/node/revision 下不可原地改写；新候选必须增加 artifact revision，因此其 hash 可安全进入提交前置条件。
- 旧版本中已经保存为 `reviewing` 的 Episode 仍可读取；新任务不再把未通过质量门的初稿或修订稿提前写入正式 Episode。
- 本计划批准后，必须同步修改原 SPEC 11.2 中“初稿保存为 reviewing”的旧规则。

## 7. 轻量结构化输出层

### 7.1 新的统一调用边界

计划新增内部 helper，暂命名为：

```ts
type StructuredDecodeResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      errors: Array<{ path?: string; code: string; message: string }>;
    };

interface StructuredContract<T> {
  name: string;
  schemaVersion: number;
  decode: (value: unknown) => StructuredDecodeResult<T>;
  check: (value: T) => Array<{
    severity: 'assert' | 'check';
    path?: string;
    code: string;
    message: string;
  }>;
  buildFixupPrompt: (input: {
    rawCandidate: string;
    errors: Array<{ path?: string; code: string; message: string }>;
  }) => string;
}

interface StructuredFallbackPolicy {
  configuredModelProfile?: string;
  maxFallbackCalls: 0 | 1;
}

interface StructuredGenerationRequest<T> {
  node: ScriptNodeName;
  prompt: string;
  contract: StructuredContract<T>;
  maxSchemaRepairAttempts: number; // 第一阶段固定为 1
  fallback: StructuredFallbackPolicy;
  signal?: AbortSignal;
}

interface StructuredGenerationResult<T> {
  value: T;
  attempts: number;
  repaired: boolean;
  checks: Array<{ path?: string; code: string; message: string }>;
  rawArtifacts: ScriptRawModelArtifact[];
}
```

处理顺序固定为：

```text
调用模型
→ 清理 reasoning / Markdown 围栏
→ 提取平衡 JSON
→ 现有 loose repair
→ contract.decode 领域结构
→ contract.check：assert 失败、check 留作建议
→ decode/assert 失败时，把字段路径和原候选交给 Fixup
→ Fixup 返回“当前节点/当前人物”的完整修正版，再做全量 decode/check
→ 最多补发 1 次 Fixup
→ 若用户配置了强模型 fallback，最多再调用 1 次并重新走完整校验
→ 仍失败则保存错误现场并进入 waiting_user
```

Fixup 不返回零散字段，也不在服务端猜测如何合并不完整对象。人物数组先拆成单个人物候选，只让失败人物返回一张完整修正版人物卡；其他节点返回该节点的完整小型产物。这样修复边界明确，最终结果始终经过全量解码。

网络错误继续沿用现有 429/5xx/超时重试，Schema 修复与网络重试分开计数，避免同一错误无限消耗模型调用。单个结构节点的逻辑调用预算最多为：主调用 1 次 + Fixup 1 次 + 已配置 fallback 1 次。

fallback 不得把某个商业模型名称硬编码进领域服务。只有用户已经配置同一供应商的“主模型/强模型”能力时，结构修复失败才允许切换；没有配置 fallback 时，当前节点保存现场并进入人工恢复，不偷偷改用其他模型或密钥。

第一阶段在现有浏览器 `ModelConfig` 增加一个可选字段，不增加第二套密钥配置：

```ts
interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  structuredFallbackModelName?: string;
}
```

- fallback 与主模型共用当前请求的 base URL、API Key 和 headers，只替换 model name。
- 设置页增加可选“结构修复备用模型”；留空即禁用。
- 旧 localStorage/header 缺少该字段时按 `undefined` 迁移，不影响现有配置。
- `ScriptModelAdapter.complete` 接收可选 model override/profile，但领域 Prompt 不读取 API Key。
- fallback model 也必须先通过现有模型配置测试；不得在服务端内置 Flash、Pro 或其他供应商名称。

### 7.2 错误分类

```ts
type StructuredFailureKind =
  | 'empty_output'
  | 'truncated_output'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'semantic_mismatch';
```

- `empty_output / truncated_output / invalid_json`：要求模型重新返回完整 JSON，不扩写内容。
- `schema_mismatch`：明确列出字段路径，例如 `characters[0].hairstyle 必须是非空字符串`。
- `semantic_mismatch`：由后续质量门处理，不能伪装成 JSON 解析失败。
- 所有失败记录只保存安全摘要，不记录 API Key 或 Authorization header。

### 7.3 第三方依赖决策门

先建立 20 个结构失败夹具，使用现有解析器跑基线。只有满足以下条件才引入 `jsonrepair`：

- 至少修复 3 个现有解析器无法恢复、但人工确认内容完整的真实样例。
- 修复后全部能再次通过领域 decoder。
- 不把空对象、缺少正文或截断语义内容误判为成功。

BAML runtime 只在人物圣经节点做隔离试验，不与第一阶段主实现绑定；上述 `StructuredContract`、Fixup、assert/check 和 fallback 语义仍属于第一阶段主实现。试验指标见第 17 节。

## 8. 契约一致性方案

### 8.1 第一阶段做法

第一阶段不为共享类型新建 monorepo package，也不引入代码生成器。采用以下轻量方式：

1. 后端 `ScriptCharacter` 和 `parseCharacters` 继续作为权威保存契约。
2. 前端补齐每个必填字段的独立编辑控件。
3. 新增一份版本化“完整人物样例”契约夹具。
4. 后端测试验证该夹具可保存；前端测试验证用户能通过 UI 生成同形对象。
5. 任一端增删必填字段时，两端契约测试必须同时更新。

需要补齐的 UI 字段至少包括：

- `identity`
- `biography`
- `motivation`
- `goal`
- `weakness`
- `arc`
- `appearance`
- `hairstyle`
- `physique`
- `defaultOutfit`
- `personality[]`
- `skills[]`
- `speechStyle`
- `catchphrases[]`
- `relationships[]`

当前“身份与经历”“发型与体格”“语言风格与口头禅”不得再把两个字段显示在一个文本框、却只保存其中一个字段。

### 8.2 后续可选升级

若第一阶段通过整本验收，再评估以下二选一：

- 建立轻量 `shared-contracts` package，由前后端共同引用。
- 使用 BAML/Zod/JSON Schema 生成模型输出格式和 TypeScript 类型。

升级前不得同时维护第三套独立 Schema。

## 9. 受限 Patch 修订

### 9.1 第一阶段允许的操作

```ts
type ScriptRevisionOperation =
  | {
      op: 'replaceBlockText';
      sceneId: string;
      blockId: string;
      text: string;
    }
  | {
      op: 'insertBlockAfter';
      sceneId: string;
      afterBlockId: string;
      block: ScriptBlockInput;
    }
  | {
      op: 'appendBlock';
      sceneId: string;
      block: ScriptBlockInput;
    }
  | {
      op: 'updateSceneCharacters';
      sceneId: string;
      characterIds: string[];
    };
```

第一阶段禁止模型执行：删除整场、替换整集、修改集号、修改 `outlineId`、重排所有场景、删除未命中正文块。

### 9.2 提交流程

```text
读取 base episode + revision
→ 模型返回 operations
→ 校验 op 白名单及目标 ID
→ 在内存 clone 上应用 Patch
→ 验证未命中 block 的 ID、类型、文本和顺序未变
→ 运行确定性 gate
→ 需要时运行 AI advisory 复检
→ expectedRevision CAS 保存
```

任何可人工处理的步骤失败：候选保存在 checkpoint artifact，正式 Episode 保持原样，内部节点进入 `needs_review`，外层 Job 映射为 `waiting_user`。只有不可恢复的存储、权限或未知程序错误才进入 `failed`。

### 9.3 字数不足的处理

`TOO_SHORT` 不允许触发整集重写。Director 应选择信息密度最低或篇幅最短的场景，要求模型只返回 `appendBlock / insertBlockAfter`。每轮扩写后重新计算可见字符，最多两轮；仍不足则交给用户，不无限扩写。

## 10. 质量门分轨

### 10.1 Blocking issues

第一阶段只有以下问题自动阻止 `completed`：

- 结构无法解析或不符合领域契约。
- 集号、场号、场景 ID、正文块 ID 非法或重复。
- 空场、空动作、空对白、缺说话人。
- 说话人和人物 ID 无法映射。
- 场景人物表与对白人物存在可确定的不一致。
- 字数超出策划允许范围。
- 思维链、系统提示、JSON/Markdown 包装污染正文。
- 明确命中策划中的禁项。
- 用户创建且仍为 open 的 hard issue。
- 保存时 revision 冲突。

### 10.2 Advisory issues

以下问题默认不自动卡死任务：

- 钩子是否足够强。
- 节奏是否拖沓。
- 对白是否自然。
- 对白密度轻微偏差。
- 语义上疑似遗漏 `requiredFacts`。
- 角色口吻、情绪或关系疑似漂移。
- AI 发现但无法由确定性规则复核的事实冲突。

AI review 可保留 `hard` 原始建议用于展示，但 `hardFailed` 计算不能直接包含 AI 来源。未来如果某个 AI 问题能提供 `sceneId / blockId / requirementId / evidence`，并由确定性验证器确认，才允许升级为 blocking。

### 10.3 `requiredFacts` 改造

第一阶段停止使用全文 exact substring 作为 hard gate，改为：

```ts
interface ScriptRequirementEvidence {
  requirementId: string;
  blockIds: string[];
  explanation: string;
}
```

没有 evidence 时记为 advisory。后续可增加人工确认或语义分类器，但不得仅凭一次 LLM judge 阻止整批完成。

## 11. 连续性账本

### 11.1 最小数据结构

```ts
interface ScriptEpisodeContinuityCommit {
  id: string;
  schemaVersion: 1;
  projectId: string;
  episodeNumber: number;
  episodeRevision: number; // 绑定原子提交后的正式 Episode revision
  revision: number;
  status: 'current' | 'stale';
  inputFingerprint: string;
  previousContinuityCommitId?: string;
  previousContinuityRevision?: number;
  characterUpdates: Array<{
    characterId: string;
    location?: string;
    emotionalState?: string;
    knownFactsAdded: string[];
    relationshipChanges: string[];
    outfit?: string;
  }>;
  factsAdded: Array<{
    factId: string;
    text: string;
    evidenceBlockIds: string[];
  }>;
  props: Array<{
    propId: string;
    name: string;
    holderCharacterId?: string;
    state: string;
    evidenceBlockIds: string[];
  }>;
  threads: Array<{
    threadId: string;
    action: 'opened' | 'advanced' | 'closed';
    description: string;
    evidenceBlockIds: string[];
  }>;
  timelineEvents: Array<{
    eventId: string;
    timeLabel: string;
    summary: string;
    causeEventIds: string[];
    evidenceBlockIds: string[];
  }>;
  nextEpisodeMustInherit: string[];
  createdAt: string;
  updatedAt: string;
}
```

第一阶段继续保存在当前项目 JSON 中，不增加数据库。同一集最多有一个 `current` commit，历史 commit 可保留为 `stale`。用户修改已完成正文时，保存 Episode、把 Episode 状态降为 `reviewing`、把旧 continuity commit 标为 stale 必须发生在同一次项目文件 mutation 中；此时它不再计入“completed 必有 current commit”的集合。用户点击现有“校稿第 N 集”后，后端重新运行确定性检查和 AI advisory；无 blocking issue 时重新生成 continuity candidate，并通过原子完成操作把 Episode 恢复为 completed、产生新的 current commit。

### 11.2 原子完成语义

计划在 `ScriptStore` 增加一个领域操作，而不是让 Director 连续调用两个保存方法：

```ts
commitEpisodeWithContinuity(input: {
  episode: ScriptEpisodeInput;
  expectedEpisodeRevision: number;
  continuity: ScriptEpisodeContinuityCommitInput;
  inputRevisionRefs: ScriptInputRevisionRef[];
  upstreamArtifactRefs: ScriptUpstreamArtifactRef[];
  promptVersion: string;
  modelConfigFingerprint: string;
  inputFingerprint: string;
  candidateHash: string;
}): Promise<{
  episode: ScriptEpisode;
  continuity: ScriptEpisodeContinuityCommit;
}>;
```

该操作在现有 FileScriptStore 串行写队列和一次临时文件 rename 内完成：

1. 在 FileScriptStore 写队列内部逐项读取并比较 `inputRevisionRefs`；任一正式资源 revision 改变立即返回 CONFLICT。
2. 对排序后的 revision refs、不可变 upstream artifact refs、Prompt 版本、脱敏模型配置 fingerprint 和 candidate hash 使用同一 canonical 算法重算 input fingerprint，并与传入值比较。
3. 对传入 Episode 数据重算 candidate hash，防止候选在检查后被替换。
4. 为 Episode 分配最终 revision。
5. 把 continuity 绑定到该最终 revision，并持久化 input fingerprint 与前序 continuity revision。
6. 将 Episode 标记 completed，并保存唯一 current continuity commit。
7. 一次原子 rename 提交；任一步失败则两者都不改变。

启动后续集/批次前，后端必须校验所有前置集均 completed，且紧邻前一集存在与最新 Episode revision 匹配的 current continuity commit。这样 1–5 与 6–10 即使区间不重叠，也不能在第 5 集状态尚未提交时并发运行。

### 11.3 下一集上下文顺序

```text
锁定策划与硬禁项
→ 当前集分集卡和详细大纲
→ 当前集出场人物 Canon
→ 相关世界规则
→ 上一集结尾及摘要
→ 最近两集连续性提交
→ 检索出的相关旧事实/伏笔
→ 格式规则
```

禁止把全部历史正文累加进 Prompt。历史正文保留为审计和召回源，摘要/账本作为默认提示词源。

## 12. 前端确定性修复

### 12.1 采用选题

采用选题只更新 plan：标题、logline、核心冲突、题材和主线提示。不得创建仅含 `mainArc` 的半成品 outline，也不得把 outline 标为 dirty。

如果需要保留选题的主线提示，短期放入 plan 的策划文本；后续再评估独立 `outlineSeed`，它不能作为正式 artifact 或参与 revision。

### 12.2 固定五集批次

当前批次永远固定为：

```ts
const batchStart = Math.floor((episodeNumber - 1) / 5) * 5 + 1;
const batchEnd = Math.min(batchStart + 4, totalEpisodes);
```

- 查看 1–5 集时只能生成/恢复 1–5。
- 第 2 集失败时显示“继续第 2 集所在的 1–5 集任务”，不得显示“生成第 2–6 集”。
- 6–10 集只有在前置资料和必要的第 5 集连续性状态可用时才能启动。
- 后端同样校验 `startEpisode` 位于固定批次起点，避免绕过 UI。

### 12.3 人物编辑器

- 数组字段采用逐行编辑，空行过滤并去重。
- relationships 使用重复行编辑：目标人物、关系标签、备注。
- 保存前本地展示缺失字段，不发送必然失败的请求。
- Agent 生成失败时保留已经成功的世界或人物节点，不把两者一起清空。

## 13. 工作流状态和检查点

第一阶段继续使用现有 Job 状态，对内部 Script 节点补充更明确的状态：

```ts
type ScriptNodeStatus =
  | 'pending'
  | 'running'
  | 'repairing'
  | 'validating'
  | 'succeeded'
  | 'needs_review'
  | 'stale'
  | 'failed';
```

每个节点检查点至少记录：

```ts
interface ScriptNodeCheckpointMeta {
  schemaVersion: 2;
  node: string;
  status: ScriptNodeStatus;
  attempt: number;
  inputRevisions: Record<string, number>;
  inputFingerprint: string;
  artifactRevision?: number;
  validationErrors: Array<{ path?: string; code: string; message: string }>;
  updatedAt: string;
}
```

恢复规则：

- `succeeded` 节点只有在重新计算的 fingerprint 完全一致时才能只读复用。
- 网络错误从同一节点重试。
- 结构错误从该节点的 repair attempt 继续。
- `needs_review` 映射为外层 Job `waiting_user`；用户处理后 resume 同一节点，不自动重新执行上游节点。
- `failed` 只表示不可恢复错误；可修复的模型输出和用户资料问题不得直接标 failed。
- 输入 revision/fingerprint 已改变时，当前节点及其全部下游候选标记 stale，不允许提交。

fingerprint 由“节点名称 + 排序后的输入资源 ID/revision + 相关配置 + Prompt 版本”做稳定 JSON 序列化后计算 SHA-256。不能使用 `updatedAt`、对象遍历顺序或模型输出作为输入 fingerprint。

例如 `draft_episode_6` 至少引用：plan revision、outline revision、characters revision 向量、world revision、episode outline revision、scene plan artifact revision、第 5 集 episode revision 和第 5 集 continuity commit revision。用户修改已确认场景计划后，其下游 draft/review/patch 全部变 stale；重新生成的 draft 必须读取新 fingerprint。

### 13.1 Checkpoint v1 → v2 迁移

版本升级作用于整个检查点文件，不只是单条记录：

```ts
interface ScriptCheckpointFileV2 {
  schemaVersion: 2;
  projectId: string;
  runKey: string;
  checkpoints: Array<ScriptPipelineCheckpointV2 & ScriptNodeCheckpointMeta>;
}
```

- `FileScriptCheckpointStore.normalizeFile` 同时识别外层 schemaVersion 1 和 2；所有新文件及下一次持久化统一写 v2。
- 读取 v1 文件时，记录级 `running` 映射为 `pending`，`completed` 映射为 `succeeded`。
- 旧记录缺少输入 revision 向量时，不猜测可复用；将该节点标为 stale，并从最后一个可由正式资源证明成功的边界恢复。
- 迁移只发生在内存读取阶段；下一次保存写出 schemaVersion 2，必须幂等。
- 未知的新 schemaVersion 返回明确 STORE_ERROR，不覆盖原文件。

### 13.2 重试所有权

- `callModel` 只负责单次 HTTP 调用以及请求级网络退避。
- `generateStructured` 只负责一次 Fixup 和一次已配置 fallback。
- `AgentJobRunner` 负责进程/服务级恢复，不因 Schema mismatch 从任务开头重跑。
- 三层计数分别写入 checkpoint，禁止出现 Runner × 网络重试 × Schema 重试的乘法失控。

## 14. 实施任务与提交边界

### T0：失败夹具与基线

内容：

- 保存脱敏的缺字段人物 JSON、截断 review JSON、缩稿 revision 和 AI hard 样例。
- 为每个线上失败建立先失败的回归测试。
- 记录现有调用次数和失败节点。

主要文件：

- `backend/src/services/script/agents/structuredOutput.test.ts`
- `backend/src/services/script/agents/ScriptDirector.test.ts`
- `backend/src/services/script/quality/ScriptQualityGates.test.ts`
- `frontend/src/components/ScriptWorkspace.test.tsx`

完成标准：每个 R1–R9 至少有一个能稳定复现的测试；测试不依赖真实 API。

### T1：前端确定性问题

内容：

- 采用选题不再生成脏 outline。
- 动态生成按钮钳制到固定五集批次。
- 前后端均拒绝跨批请求。

完成标准：采用选题后可直接启动大纲 Agent；第 2 集失败时不再出现 2–6。

建议提交：`fix: stabilize short drama stage transitions`

### T2：人物契约和表单

内容：

- 补齐所有必填字段独立控件。
- 增加完整人物契约夹具和两端测试。
- 保存前本地显示字段错误。

完成标准：用户可完全通过 UI 创建并保存后端接受的人物卡；不需要内部 API 补字段。

建议提交：`fix: align script character editor with canonical contract`

### T3：结构化输出修复层

内容：

- 定义 `StructuredContract` 并抽取 `generateStructured`。
- 区分网络重试、JSON repair 和 Schema repair。
- 实现 assert/check、完整小产物 Fixup 和可配置 fallback。
- 为前后端 `ModelConfig`、请求 header 迁移、设置页和 `ScriptModelAdapter` 增加可选 `structuredFallbackModelName`；继续共用当前 base URL/API Key。
- 人物与世界改成独立 checkpoint。
- 只重试失败人物或失败节点。
- 保留安全的原始响应与 validation errors。

完成标准：缺少一个人物字段时只发生一次定向修复；世界节点成功后不会因人物失败丢失；截断输出不会写入正式资源；旧单模型配置无损迁移；primary 失败后按配置依次走 Fixup/fallback；未配置 fallback 时进入 waiting_user，不使用未知模型。

建议提交：`feat: add recoverable structured generation for scripts`

### T4：Checkpoint v2、候选稿与恢复语义

内容：

- 增加 checkpoint v2、旧记录幂等迁移和稳定 fingerprint。
- 定义 `ScriptEpisodeCandidateArtifact`，初稿不提前写正式 Episode。
- 明确 `needs_review → Job waiting_user`、`stale` 和 resume 同节点语义。
- 统一三层重试所有权，禁止乘法重试。
- 固定 `episode_outline → scene_plan → draft`；scene plan 成功后先保存，draft 的 fingerprint 必须引用它。

完成标准：旧 checkpoint 可安全读取；fingerprint 相同才复用成功节点；用户修改场景计划后旧 draft 自动 stale；候选生成/校验过程中断后从同节点恢复；waiting_user 不被错误标记为 failed。

建议提交：`feat: add durable script candidate checkpoints`

### T5：质量门分轨

内容：

- 定义 source-aware `blockingIssues` 与 `advisoryIssues` 契约。
- 同步修改 QualityGates、Director、ScriptService 完成门、持久化 reviewIssues 和前端按钮判断。
- AI issue 不直接参与 `hardFailed`，用户创建的 open hard 仍阻断。
- `requiredFacts` exact match 降为 advisory/evidence。

完成标准：确定性错误仍严格阻断；单纯主观 AI hard 不会让任务永久失败；前后端对同一个 issue 的 blocking 结论完全一致；UI 能显示建议并允许用户处理。

建议提交：`fix: separate blocking script gates from ai advice`

### T6：Patch 修订和提交顺序

内容：

- 定义受限 Patch operation decoder。
- 模型只返回操作，不返回完整 Episode。
- 在 checkpoint candidate 上应用 Patch 和复检，不能写正式 Episode。
- 加入 untouched block 不变量、base revision 和 input fingerprint 测试。

完成标准：任何修订失败都不改变正式稿；修复单个问题时未命中的文本、ID 和顺序逐字不变；不得再次出现 500 字修成 245 字。

建议提交：`feat: revise script episodes with validated patches`

### T7：连续性提交与原子完成

内容：

- 增加版本化 `continuityCommits[]`、稳定 thread/prop/event ID 和 stale 语义。
- 实现 `commitEpisodeWithContinuity` 单次原子写。
- 用户编辑 completed Episode 时在同一 mutation 中把 Episode 降为 reviewing，并使旧 commit stale。
- 复用现有 `POST /script-episodes/:number/review` 作为再激活入口：重审无 blocking 后生成新 continuity candidate，再原子恢复 completed/current；前端继续使用“校稿第 N 集”，不增加新的主流程按钮。
- 下一集上下文只读取相关账本和最近摘要。
- 后端阻止前一集缺少 current continuity commit 时启动后续批次。

完成标准：completed Episode 不可能缺少匹配 revision 的 current continuity commit；第 1 集埋下的线索能在第 2 集上下文中定位；用户改第 1 集后立即变为 reviewing/旧账本 stale，点击校稿后可产生新 current commit 并继续下一批；进程在提交边界中断不会产生半完成状态。

建议提交：`feat: atomically persist episode continuity`

### T8：真实模型验收和收尾

内容：

- 运行多选题、多题材、单批恢复和 10 集整本。
- 记录模型、参数、每节点调用数、修复次数、字数、问题和耗时。
- 修复验收发现的阻断问题；非阻断问题进入后续清单。

完成标准见第 15 节。

建议提交：`test: add short drama reliability acceptance coverage`

## 15. 验收方案

### 15.1 离线自动化

必须覆盖：

1. 缺 `hairstyle` 后定向修复成功。
2. 某一个人物失败时其他人物和世界产物不丢失。
3. 代码围栏、尾逗号、缺闭合括号和真实截断分别得到正确分类。
4. 无法恢复的截断内容不被补成“合法空对象”。
5. Patch 只修改指定 block。
6. Patch 目标 ID 不存在、越权路径、base revision 过期时拒绝。
7. 候选复检失败时正式 Episode 内容和 revision 不变。
8. AI hard advisory 不进入 `hardFailed`。
9. 用户 open hard 仍阻止 completed。
10. 采用选题后 outline 保持 clean/undefined。
11. 所有批次均为 1–5、6–10 等固定边界。
12. primary → Fixup → configured fallback 的调用顺序和总预算正确；无 fallback 时进入 waiting_user。
13. scene plan 修改后旧 draft/review/patch fingerprint 全部 stale。
14. 外层 CheckpointFile v1 可幂等迁移到 v2；needs_review 恢复后从同节点继续。
15. 进程在候选生成后、原子提交前中断，正式 Episode 不改变且候选可恢复。
16. completed Episode 与同 revision 的 current continuity commit 原子出现。
17. 下一批在上一集 continuity 缺失或 stale 时被后端拒绝。
18. 时间事件、因果 ID、伏笔和道具状态能从上一集正确继承。
19. FileScriptStore 在写队列内发现任一 input revision 改变、fingerprint 不可复算或 candidate hash 不一致时返回 CONFLICT，正文与账本均不变。
20. 用户编辑 completed Episode 后同一次保存得到 reviewing + stale commit；重新校稿通过后恢复 completed + 新 current commit。

### 15.2 真实模型分层验收

为控制费用和定位问题，按四层执行：

#### A. 多示例策划与圣经

- 都市女频、家庭反转、悬疑复仇三个提示。
- 每个提示生成 3 个选题，共 9 个选题。
- 每组选用 1 个，完成 plan、outline、characters、world。
- 不要求写正文，重点统计结构首轮成功率和 repair 次数。

#### B. 三个单集样例

- 都市女频：目标 300 字。
- 家庭悬疑：目标 500 字。
- 西方玄幻：目标 300 字。
- 每个样例都完成生成、校稿、必要 Patch 和导出。

#### C. 一部 10 集诊断整本

- 先用 300–500 字/集控制成本。
- 严格按 1–5、6–10 两批运行。
- 中途主动刷新页面一次、切换项目一次，并模拟一次可恢复节点失败。
- 全程只使用 UI 和正常公开 API，不直接修改存储或补写内部状态。

#### D. 一部 10 集发布验收整本

- C 全部通过后，再按正式目标运行 900–1,200 字/集的 10 集短剧。
- 不注入故障，验证正常生产路径的上下文预算、字数扩写、连续性和导出。
- 若发布验收失败，只回到具体失败节点修复，不扩大到视频、图片或其他产品范围。

### 15.3 整本通过标准

- 10/10 集状态为 completed。
- 所有集号连续唯一，批次固定且无重叠任务。
- 每集场景、人物和正文块结构合法。
- 每集字数必须在策划目标允许范围内；字数不足或超限仍属于 blocking，不能通过忽略 advisory 放行。
- 结构化输出修复最多 1 次；同一节点不无限循环。
- 任一 Episode 正式 revision 只在候选通过后增加。
- 不出现整集缩稿、空集、JSON/思维链污染或用户稿被覆盖。
- 第 1–9 集各自拥有可用于下一集的 continuity commit。
- 每个 completed Episode 都拥有与最新 revision 一致的 current continuity commit。
- 场景计划、候选稿和 continuity commit 的输入 fingerprint 可追溯且没有 stale 产物被提交。
- 刷新、切项目和任务恢复后不重复生成已完成集。
- TXT、Markdown、DOCX、Fountain 整本导出顺序正确且文件可打开。
- 浏览器无未处理请求错误和控制台错误。

## 16. 评估指标

| 指标 | 第一阶段目标 |
| --- | ---: |
| 人物/世界结构首轮或一次修复成功率 | ≥ 95% |
| 无法恢复输出被错误保存 | 0 |
| 单集失败导致已完成集重写 | 0 |
| 修订影响非目标 block | 0 |
| AI 主观问题导致无人值守任务失败 | 0 |
| 10 集重复/缺失/跨批 | 0 |
| UI 无法填写后端必填字段 | 0 |
| 单节点 Schema repair 次数 | ≤ 1 |
| 单集自动扩写轮次 | ≤ 2 |
| 真实 10 集流程需内部 API/改文件 | 0 |

## 17. BAML 结构必做项与依赖试验

BAML 提供的结构思想是第一阶段主路径的必做项，包括 Schema-first、宽容解析、`assert/check` 分轨、显式 Fixup 和 fallback。这里需要试验的只是“是否直接引入 BAML 运行时/DSL”，不是是否采用这套结构。

为 `script_bible` 建立隔离原型，使用同一组 20 个结构失败夹具比较：

- 当前解析器 + 定向 repair。
- BAML SAP + 显式 Fixup function。

比较指标：

- 首轮解析成功率。
- 一次 Fixup 后成功率。
- 平均输入/输出 token。
- TypeScript 集成复杂度。
- 对现有模型 base URL、headers 和 BYOK 的兼容性。
- 错误是否能保留精确字段路径。

只有 BAML 明显提高恢复率，且没有破坏当前浏览器 BYOK/自定义模型配置时，才单独提交依赖评审。BAML 官方 `retry_policy` 只解决网络类问题，Schema validation 的 Fixup 仍必须由应用显式编排。

## 18. 风险、回滚和发布

### 18.1 主要风险

- Patch operation 过少可能无法自动修复复杂问题。
- AI advisory 全部降级后，可能放过真实语义矛盾。
- 新连续性账本可能与用户后续编辑不一致。
- 增加 repair 调用会提高单节点费用。

### 18.2 控制方式

- Patch 不能处理的问题进入 `needs_review`，不退回整集重写。
- AI 问题保留完整展示，用户可升级为 hard；后续再增加可举证的 deterministic verifier。
- continuity commit 绑定 Episode revision，旧账本自动 stale。
- Schema repair 最多一次，并记录调用数。

### 18.3 回滚边界

- 每个 T1–T8 独立提交，禁止把全部改造压成一个 commit。
- 新字段读取必须提供旧 schema 默认值，已有剧本文件可继续加载。
- Patch revision 可用功能开关回退到“只提示用户、不自动修订”，但不得恢复复检前覆盖正文的旧行为。
- continuity ledger 不影响正文读取和导出；关闭写入后旧项目仍可正常工作。
- 任一真实验收失败时关闭自动续批，不删除已有短剧资料。

## 19. 推荐执行顺序

```text
T0 失败夹具
 ↓
T1 前端阶段/批次修复 ─┐
T2 人物契约与表单 ────┼→ T3 结构化输出修复
                      ↓
                 T4 Checkpoint v2 / 候选恢复
                      ↓
                 T5 质量门分轨
                      ↓
                 T6 Patch 修订
                      ↓
                 T7 连续性原子提交
                      ↓
                 T8 多样例与整本验收
```

优先级解释：

1. T1、T2 是确定性 bug，模型再强也无法绕过，先修收益最高。
2. T3 落地 BAML 式结构契约，解决人物和 review JSON 的直接失败。
3. T4 落地 LangGraph 式 checkpoint/fingerprint/waiting-user 语义，并给候选稿提供安全存放边界。
4. T5 先确定哪些问题允许自动修，再由 T6 实现 Patch，避免 Patch 依赖尚未稳定的 issue 分类。
5. T7 落地 Novel-OS/DOME 式连续性提交，并用原子操作防止正文与状态分裂。
6. Dramatron 式分层贯穿 T1–T4：大纲、场景计划和单集候选不得跨层或跳过 fingerprint。
7. 最后执行真实 10 集，过程中只修阻断，不临时扩大范围。

## 20. 实施前必须同步的 SPEC 条款

本计划批准后、功能代码开始前，先提交一次纯文档变更，至少更新 `SHORT_DRAMA_MODE_SPEC.md`：

- **9.2 持久化结构**：增加版本化 `continuityCommits[]`、current/stale 和旧 schema 默认迁移。
- **10.4 单集生成策略**：明确场景计划先持久化；初稿/修订稿为 checkpoint candidate；正文一次生成当前单集 scenes，不增加逐场多调用。
- **10.6 记忆写回**：改为 Episode 与 continuity commit 原子完成，并增加时间/因果/evidence ID。
- **11.2 节点检查点**：升级 checkpoint v2、fingerprint、stale、needs_review/waiting_user 和恢复规则。
- **14.1/14.2 质量门**：改为 source-aware blocking/advisory；AI 原始 hard 默认不直接阻断；字数仍保持确定性 blocking。
- **19 测试策略**：增加候选不落正式稿、Patch 不变量、checkpoint 迁移和连续性原子提交。
- **20 调用预算**：分别统计网络重试、Fixup、fallback 和 Patch，禁止多层重试相乘。
- **27.3 可见校稿**：前后端对 issue source/severity/status 的 blocking 规则保持一致。

SPEC 与本计划冲突时不得边写代码边临时选择；先修正文档并评审对应条款。

## 21. 完成定义

本计划完成不是“所有单元测试变绿”，而是同时满足：

- T0–T8 的自动化测试、typecheck 和 build 全部通过。
- 一部 10 集短剧仅通过 UI/公开 API 完成。
- 线上实测的 R1–R9 均有回归测试并已关闭。
- 没有新增大 Agent 框架或数据库依赖。
- 现有小说模式全量回归通过。
- 计划、SPEC、接口行为和部署版本保持一致。
