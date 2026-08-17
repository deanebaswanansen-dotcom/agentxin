# AgentXin 短剧直接写作模式改造计划

状态：已进入首轮实现
版本：v1.0
日期：2026-08-17
适用范围：短剧大纲完成后的单集正文生成、明显错误检查、连续性交接、100 集顺序生产
关联文档：`SHORT_DRAMA_MODE_SPEC.md`、`SHORT_DRAMA_FLASH_OPTIMIZATION_PLAN.md`、`SHORT_DRAMA_RELIABILITY_PLAN.md`

## 1. 决策摘要

本轮不再优化当前“完整 Episode JSON → 扩写块 → 质量门 → Revision Patch → 复检”的正文链路，而是在现有任务和存储框架内增加一条更短的默认路径：

```text
已确认分集卡
  → Flash 直接写标准中文剧本文本
  → 本地解析为现有 ScriptEpisode
  → 篇幅明显不足时最多续写一次
  → 一次明显错误检查并提取连续性交接
  → 必要时最多重写一次
  → 原子提交 Episode + continuity
```

一句话原则：

> 大纲负责方向，Flash 负责写作，程序只负责保存、恢复、格式转换和发现明显错误。

现有的项目隔离、后台任务、checkpoint、revision、CAS、原子提交、导出和编辑器继续保留。正文阶段不新增 Agent 框架、向量数据库、DSL、分片协议或多层状态机。

## 2. 为什么需要改

### 2.1 真实问题不是模型能力，而是约束方式

当前实测已经证明：任务可以完成，但“完成”不代表作品合格。

- 赛车悬疑项目第 3 集写成篮球比赛，属于明显题材跑偏。
- 目标 1,200 字、对白约 60%，五集实际为 1,466 / 716 / 1,015 / 423 / 469 字，平均约 818 字。
- 多集对白比例只有 11%—26%。
- 大纲存在同一证物被连续偷走、重新发现的问题。
- 现有质量门报告 0 个 blocking，却没有阻止上述大问题。
- 为了修长度和结构加入的局部续写、扩写块与 Patch 又制造了重复动作和时序问题。

结论：当前链路检查了大量局部格式，却没有稳定守住题材、当前主事件、人物身份和因果顺序。继续增加局部规则会进一步负优化。

### 2.2 开源实现的共同做法

本计划只借鉴开源项目已经验证的简单模式，不复制其代码：

| 项目 | 实际做法 | 本项目借鉴点 |
| --- | --- | --- |
| [Dramatron](https://github.com/google-deepmind/dramatron) | 梗概、人物、情节点、场景、对白分层形成，并强调共同创作和人工修改 | 保留全剧大纲和分集卡，但不把文学质量做成自动硬门 |
| [DOC Story Generation V2](https://github.com/facebookresearch/doc-storygen-v2) | 按大纲节点依次写段落，输入前文摘要、当前事件和少量未来事件 | 每集只读取当前卡片、上一集交接和必要未来约束 |
| [Book-OS](https://github.com/forsonny/book-os/blob/main/instructions/core/write-scene.md) | 找到下一未完成场景，读取相关资料，直接写场景，完成即落盘 | 写作单元简单、失败有上限、完成立即保存 |
| [StoryForge](https://github.com/yuanbw2025/storyforge) | 章节卡包含冲突、人物、地点和伏笔，正文直接生成，采用时检查版本 | 用清楚的事件卡约束正文，而不是用大量正文块规则约束模型 |
| [Novel-OS](https://github.com/mrigankad/Novel-OS/blob/main/core/orchestrator.py) | 先形成节拍，再直接写完整章节，写完提取简短状态交接 | 连续性是写完后的交接摘要，不是正文前的重型输入 |
| [AI Novel Writing Assistant](https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant/blob/main/server/src/services/novel/chapterWritingGraph.ts) | 直接生成普通文本；短稿只续写一次并拼接，不整章重写 | 保留可用短稿，续写一次，不为精确字数反复推翻正文 |

共同结论：成功项目通常按大纲节点或章节直接写作，逐单元保存，用前文摘要和少量状态维持连续性；没有把正文生产建立在巨大结构化 JSON、多轮全量 Fixup 和复杂 Patch 上。

## 3. 产品目标与边界

### 3.1 本轮目标

1. Flash 能稳定照当前分集卡写出可读的中文短剧正文。
2. 优先阻止赛车写成篮球、人物身份错乱、同一证物重复发现等明显问题。
3. 1,200 字目标允许自然波动，常见正文保持在 900—1,500 字。
4. 正常单集只调用 2 次模型：直接写作 1 次、轻检查与交接 1 次。
5. 篇幅不足时最多追加 1 次；明显跑偏时最多重写 1 次。
6. 无论质量如何，模型已写出的正文必须成为可查看、可编辑的候选，不能无声丢弃。
7. 继续支持固定五集批次、断点恢复、版本冲突保护和 100 集顺序生产。

### 3.2 明确不追求

- 不要求每集精确 1,200 字。
- 不要求对白精确占 60%。
- 不自动评价文学性、表演张力、服装丰富度或镜头高级感。
- 不保证 AI 对所有伏笔都理解正确。
- 不为了修一句话而重写整集多次。
- 不一次请求写完整 100 集。
- 不新增 BAML、LangGraph、向量数据库或新的工作流运行时。

### 3.3 保留的可靠性能力

- `AgentRunStore + AgentJobRunner`：任务、去重、取消、恢复。
- `FileScriptCheckpointStore`：候选落盘和断点恢复。
- `FileScriptStore`：资源 revision、CAS 和正式状态。
- `commitEpisodeWithContinuity`：正文与连续性状态原子提交。
- 项目、客户端和模型配置隔离。
- 现有结构化 `ScriptEpisode`、编辑器和导出格式。

这些能力不属于过度设计，继续保留。需要删除的是正文生成中的多轮局部修理，而不是数据安全机制。

## 4. 目标用户流程

### 4.1 用户准备资料

用户仍然完成：

1. 剧本策划；
2. 全剧大纲；
3. 角色设定；
4. 世界设定；
5. 分集卡。

开始写正文前，当前集卡片必须能让用户直接编辑以下字段：

- 标题；
- 本集主事件；
- 核心冲突；
- 参与人物；
- 必须发生；
- 禁止发生；
- 结尾卡点；
- 可选的承接说明。

当前 UI 不能只开放标题和摘要，而把 `mainEvent`、`endingHook` 等真正影响剧情的字段藏起来。

### 4.2 用户生成正文

用户点击“生成第 N 集”后：

1. 页面显示“Flash 正在照分集卡写作”；
2. 首稿一旦返回并能解析，立即保存为候选 checkpoint；
3. 如果字数明显不足，系统最多续写一次；
4. 系统做一次明显错误检查；
5. 没有大问题则正式提交；
6. 有大问题则最多重写一次；
7. 重写后仍有问题也保存正文，并标记“建议人工检查”，不进入自动循环。

用户始终可以打开候选正文，不再只看到抽象的 `waiting_user` 错误。

## 5. 单集直接写作设计

### 5.1 输入上下文

每集只给 Flash 以下资料：

```text
稳定规则：
- 标准中文短剧格式
- 当前项目题材与基调
- 本集目标约 1,200 字、对白建议约 60%
- 禁止思维链、JSON、Markdown 围栏和解释文字

当前任务：
- 当前分集卡的完整可编辑字段
- 当前集涉及人物的精简卡
- 与当前集有关的世界规则、道具、伏笔
- 上一集 200—400 字交接摘要
- 上一集结尾约 600—1,000 字原文
- 下一集一句话方向，仅用于避免提前收完剧情
```

禁止传入：

- 全部历史正文；
- 全部 100 集详细卡片；
- 与本集无关的人物长传记；
- 完整 checkpoint 历史；
- 大量质量规则与 Patch Schema。

### 5.2 模型输出格式

Flash 直接返回标准中文短剧文本，不返回完整 Episode JSON：

```text
第3集

3-1 老周修车厂 夜/内
人物：周野、林秋

△卷帘门被风吹得哐当作响，周野把数据卡压在掌心。

林秋（压低声音）：十年前那场事故，记录不是已经被清空了吗？

周野：被清空的是公开记录，不是这张原始卡。
```

允许的行只有：

- `第 N 集`；
- `N-M 地点 时间/内外`；
- `人物：...`；
- `【字幕：...】`；
- `△动作`；
- `人物（可选语气）：对白`；
- `人物（OS/VO）：对白`。

格式简单、对人可读，也便于本地解析。

### 5.3 本地解析

新增纯函数 `parseChineseShortDramaText()`：

```ts
interface ScriptTextParseResult {
  episode?: ScriptEpisodeInput;
  warnings: ScriptTextParseWarning[];
  unparsedLines: Array<{ line: number; text: string }>;
}
```

解析规则：

- 场景头创建 scene；
- 人物行建立场景人物表；
- 字幕、动作和对白映射到现有 block；
- 角色姓名通过当前项目人物表解析成稳定 `characterId`；
- 所有 scene/block ID 由服务端生成；
- 模型不能提供或覆盖内部 ID；
- 无法识别的非空行保留为 warning，不能静默删除。

如果主体内容存在但局部解析失败，仍保存原始文本候选和解析结果供用户查看。只有完全空输出或完全无法识别场景时才允许一次“仅修格式”调用。

### 5.4 首稿候选

首稿成功返回后，立刻保存一个不可变候选：

```ts
interface ScriptDirectDraftArtifact {
  schemaVersion: 1;
  stage: 'direct_draft';
  episodeNumber: number;
  rawText: string;
  parsedEpisode?: ScriptEpisodeInput;
  parseWarnings: ScriptTextParseWarning[];
  inputFingerprint: string;
  candidateHash: string;
  createdAt: string;
}
```

该 checkpoint 必须在续写、检查或重写之前落盘。页面刷新、服务重启或用户取消后，都能从该候选继续，不能再次扣费重写首稿。

原始文本只保存在项目私有 checkpoint，不进入公开日志、错误消息或调用统计。

## 6. 篇幅处理

### 6.1 建议区间

对目标 1,200 字：

- 900—1,500：正常，不处理；
- 700—899：偏短，但允许直接完成；默认不续写；
- 少于 700：明显偏短，最多续写一次；
- 超过 1,500：提示偏长，不自动删改；
- 超过 2,000：标记建议人工检查，不自动压缩。

字数只作为生产指标，不再作为 blocking gate。

### 6.2 一次续写

续写输入：

- 当前分集卡；
- 已有完整正文；
- 末尾 800—1,400 字；
- 当前字数和建议补充量；
- 明确要求从结尾继续，不复述、不重开场头、不重做已经发生的事件。

续写输出仍是标准剧本文本片段。本地解析后追加到相应场景或新场景。原首稿不被重写。

续写一次后，无论最终字数是否达到 900，都停止自动补字并继续轻检查。

## 7. 明显错误检查与交接状态

### 7.1 一次小型结构化调用

正文完成后调用一次 `ScriptHandoffReview`。这是一个小 JSON，不包含完整正文重写：

```ts
interface ScriptHandoffReview {
  verdict: 'pass' | 'major_issue';
  issues: Array<{
    code:
      | 'OFF_OUTLINE'
      | 'WRONG_GENRE_OR_SETTING'
      | 'CHARACTER_IDENTITY_CONFLICT'
      | 'DUPLICATE_MAJOR_EVENT'
      | 'CAUSAL_CONTRADICTION'
      | 'PROP_STATE_CONTRADICTION';
    sceneNumber?: number;
    evidence: string;
    expected: string;
  }>;
  handoff: {
    summary: string;
    characterStates: Array<{
      characterId: string;
      location?: string;
      state: string;
      knows: string[];
    }>;
    props: Array<{
      name: string;
      holder?: string;
      location?: string;
      state: string;
    }>;
    openThreads: string[];
    ending: string;
  };
}
```

检查只回答六类大问题：

1. 本集主事件是否发生；
2. 是否明显换了题材或场景类型；
3. 人物身份、关系、职业是否冲突；
4. 同一主要事件或证据是否重复发生；
5. 因果顺序是否明显倒置；
6. 重要道具状态是否自相矛盾。

禁止输出服装、台词润色、节奏、表演、镜头和文学性意见。

### 7.2 本地确定性检查

继续保留但只检查：

- 有集号和至少一个场景；
- 场号唯一且顺序合法；
- 动作和对白不为空；
- 说话人能映射到登记人物；
- 普通对白人物属于当前场景；
- OS/VO 人物已登记但不要求物理在场；
- 没有 JSON、系统提示、思维链和围栏污染；
- 没有完全相同的相邻正文块；
- revision、fingerprint 和 CAS 没有冲突。

字数、对白比例、风格、钩子强度和 requiredFacts 同义匹配全部只做指标或 advisory。

### 7.3 最多一次重写

只有 `ScriptHandoffReview.verdict === 'major_issue'` 且问题属于白名单六类时才允许重写一次。

重写输入：

- 原分集卡；
- 当前正文；
- 最多 3 条问题和证据；
- 明确要求保留没有问题的剧情，输出一份完整替代剧本文本。

重写后只运行本地检查，不再调用第二轮 AI reviewer。若仍存在 AI 建议，保存正文并标记“存在明显问题建议人工检查”，不得继续循环。

## 8. 连续性设计

### 8.1 保留原子提交

最终候选通过本地结构检查后，继续使用现有 `commitEpisodeWithContinuity()`：

- Episode 和 handoff/continuity 同时提交；
- 输入 revision 在写入期间发生变化则整体拒绝；
- 已完成集被用户编辑后，旧 continuity 继续标 stale；
- 下一集只读取与当前正文 revision 匹配的 current continuity。

### 8.2 简化给下一集的上下文

下一集默认读取：

- 上一集 `handoff.summary`；
- 上一集 `handoff.ending`；
- 当前人物位置、状态和已知信息；
- 当前道具持有人、位置和状态；
- open threads；
- 上一集末尾少量原文。

不把 100 集历史正文、完整账本对象或所有旧 checkpoint 放进写作 Prompt。

现有详细 continuity ledger 可以继续作为存储和审计结构，但写作 Prompt 只投影成上述精简交接。

## 9. Checkpoint 与恢复

新路径只需要四个逻辑节点：

| 节点 | 内容 | 恢复行为 |
| --- | --- | --- |
| `direct_draft` | 首稿原文和解析候选 | 精确 fingerprint 相同则直接复用 |
| `continuation` | 可选续写片段与合并候选 | 已成功则不再调用续写 |
| `handoff_review` | 明显问题和连续性交接 | 已成功则不再调用 reviewer |
| `direct_rewrite` | 可选一次重写候选 | 已生成后不再自动二次重写 |

恢复规则：

- fingerprint 相同：从下一未完成节点继续；
- 策划、分集卡、人物、世界、模型配置或前一集 continuity 改变：旧候选 stale，从首稿重新生成；
- 用户取消：保留最后一个已完成候选；
- 网络错误：HTTP 层有限重试，不触发整条业务链从头重跑；
- 任何候选生成后、正式提交前发生崩溃：正式 Episode 不变，恢复时复用候选。

不新增更细的 chunk checkpoint。

## 10. 调用预算

### 10.1 单集预算

| 调用 | 正常 | 可能发生 |
| --- | --- | --- |
| 直接写作 | 1 | 必须 |
| 仅修格式 | 0 | 完全无法解析时最多 1 |
| 自然续写 | 0 | 少于 700 字时最多 1 |
| 明显错误检查＋交接 | 1 | 必须 |
| 明显问题重写 | 0 | 最多 1 |

正常单集 2 次；异常单集最多 4 次。格式完全错误又同时偏短时，优先修格式，不再追加续写，单集总业务调用不得超过 4 次。

### 10.2 五集与 100 集

- 正常五集：约 10 次模型调用；
- 五集常见上限：15 次；
- 五集绝对上限：20 次；
- 100 集正常估算：约 200 次正文相关调用；
- 100 集应继续按 20 个固定五集批次顺序运行。

任何节点达到预算后保存已有正文和提示，不进入无限 `waiting_user → resume → 相同输出` 循环。

## 11. 前端改造

### 11.1 大纲编辑器

分集卡编辑模式补齐：

- main event；
- conflict；
- characters；
- required beats；
- forbidden beats；
- ending hook；
- handoff note。

保存时做简单必填检查，不评价内容好坏。

### 11.2 任务展示

用户看到的节点文案改为：

- 正在照分集卡写作；
- 首稿已保存；
- 正在从结尾续写；
- 正在检查明显错误；
- 正在按明显问题重写；
- 正文已完成／正文已完成，建议人工检查。

不再向普通用户展示 `Fixup`、`Patch policy`、`candidateHash` 等实现细节；这些只保留在调试信息中。

### 11.3 候选可见

当任务因网络或格式问题暂停时，若已经有首稿：

- 正文页提供“查看候选”；
- 允许复制或下载原始剧本文本；
- 允许用户选择“采用当前候选”；
- 不要求用户只能点“继续任务”。

## 12. 迁移与兼容

### 12.1 功能开关

新增服务端模式：

```ts
type ScriptDraftMode = 'structured_legacy' | 'direct_text';
```

初期默认仍可回退到 `structured_legacy`。测试项目显式使用 `direct_text`；A/B 通过后，新项目默认 `direct_text`。

已有项目：

- 已完成 Episode 不重写；
- 旧 active/waiting 任务可继续旧模式，也可由用户明确“从本集改用直接写作”；
- 新模式不得复用旧 structured draft/revision 候选；
- 现有导出、阅读和编辑器继续读取同一 `ScriptEpisode`，无需迁移正式数据。

### 12.2 回滚

如果直接模式线上效果变差：

- 关闭默认开关；
- 新任务回到旧模式；
- 已生成的 `ScriptEpisode`、continuity 和导出不受影响；
- direct checkpoint 可保留为审计，不被旧模式复用。

## 13. A/B/C 真实验收

### 13.1 三个实验组

使用完全相同的策划、人物、世界和 5 张分集卡，模型统一为 `deepseek-v4-flash`：

- A：当前 structured legacy 流水线；
- B：只用一个直接写作 Prompt，不续写、不检查；
- C：本计划的直接写作＋最多一次续写＋一次明显错误检查。

所有组禁止人工修改后再评分。

### 13.2 固定验收故事

继续使用赛车悬疑测试《旧赛道证人》，至少固定这些约束：

- 全剧始终是赛车、修车厂、赛道和证据调查，不能变成篮球或其他运动；
- 原始数据卡第一次发现只能发生一次；
- 第 5 集结尾必须由第 6 集直接承接；
- 证据被偷、转移或夺回必须有明确动作；
- 未登记人物不得突然说话；
- 人物不能无原因换地点或改变职业关系。

### 13.3 评分表

每集由人工盲评 1—5 分：

| 指标 | 权重 | 说明 |
| --- | ---: | --- |
| 大纲遵守 | 35% | 主事件、冲突、卡点是否落实 |
| 明显 Bug | 30% | 题材、人物、因果、证物是否冲突 |
| 可读可拍 | 20% | 是否像正常短剧而非机械填充 |
| 篇幅 | 10% | 1,200 目标下 900—1,500 为正常 |
| 调用与恢复 | 5% | 调用数、失败重试、候选是否保存 |

另记录：

- 单集字数；
- 对白比例，仅作观察；
- 模型调用数；
- 完成耗时；
- 是否进入 waiting_user；
- 是否出现重复事件；
- 是否发生明显跑题。

### 13.4 上线判据

C 组成为默认模式必须同时满足：

1. 5/5 集都有可查看正文；
2. 不出现赛车写成篮球等明显跑题；
3. 不出现主要证物重复发现；
4. 不出现人物身份或说话人明显错误；
5. 至少 4/5 集在 900—1,500 字；
6. 正常单集不超过 2 次调用，含异常平均不超过 3 次；
7. 5 集不得因字数或对白比例进入 waiting_user；
8. C 组综合盲评分不低于 B，并明显高于 A；
9. 如果 B 反而最好，直接采用 B，不为了保留流程强行上线 C。

第 9 条是本计划的关键：架构必须用作品结果证明价值，不能只证明代码更复杂。

## 14. 实施任务与提交边界

### PR 1：直接写作实验模式

目标：不删除旧链路，完整打通 C 组。

任务：

1. 新增 `ScriptDraftMode` 和服务端开关；
2. 新增标准中文剧本文本 Prompt；
3. 新增 `parseChineseShortDramaText()`；
4. 新增 direct draft checkpoint；
5. 接入一次续写；
6. 新增 `ScriptHandoffReview`；
7. 把 handoff 映射到现有 continuity candidate；
8. 复用原子提交；
9. UI 补齐分集卡可编辑字段和候选查看；
10. 增加 A/B/C 离线和真实模型脚本。

主要文件预计：

- `backend/src/services/script/agents/ScriptDirector.ts`
- `backend/src/services/script/agents/ScriptCheckpoint.ts`
- `backend/src/services/script/serializers/chineseShortDrama.ts`
- 新增 `backend/src/services/script/parsers/chineseShortDramaText.ts`
- `backend/src/services/script/ScriptContinuityCommit.ts`
- `frontend/src/components/ScriptWorkspace.tsx`
- `frontend/src/types/index.ts`
- `scripts/online_user_e2e.mjs` 或新增 direct-mode acceptance 脚本

PR 1 完成标准：离线测试全绿、功能开关默认关闭、测试项目可完整生成五集。

### PR 2：真实验收、默认切换与清理

目标：用结果决定默认模式，不提前删除旧代码。

任务：

1. 运行 A/B/C 五集对照；
2. 保存盲评和调用统计；
3. 通过则新项目默认 `direct_text`；
4. 旧模式保留一个发布周期作为回滚；
5. UI 隐藏 legacy 的 Patch/Fixup 细节；
6. 一次发布周期稳定后，再单独提交删除不再使用的 expansion/revision 默认路径。

PR 2 完成标准：线上五集通过 §13.4，且直接模式可随时关闭回退。

## 15. 测试矩阵

### 15.1 文本解析器

1. 多场景、动作、字幕、普通对白、OS、VO 正确解析；
2. 中文冒号、英文冒号、空格和括号语气兼容；
3. 未登记人物产生可定位错误；
4. 无法识别行保留为 warning，不静默丢失；
5. 模型返回 Markdown 围栏时拒绝污染；
6. scene/block ID 始终由服务端生成；
7. parse → serialize → parse 的场次、人物和正文保持一致。

### 15.2 单集流程

1. 1,100 字首稿直接进入 reviewer；
2. 600 字首稿续写一次后完成；
3. 续写后仍只有 800 字，也完成并提示偏短；
4. 1,600 字首稿不触发自动压缩；
5. 空响应只重试一次格式/生成；
6. 首稿保存后进程中断，恢复不重调首稿；
7. reviewer 发现赛车变篮球，最多重写一次；
8. 重写仍被认为有问题时保留候选并完成为“建议人工检查”；
9. reviewer 返回服装和文学建议时 decoder 丢弃；
10. 用户编辑分集卡后旧 direct draft 自动 stale；
11. plan/characters/world/previous continuity 变化触发 CAS，正式数据零写入；
12. 正式 Episode 和 continuity 始终原子提交。

### 15.3 连续性

1. 第 1 集数据卡在第 2 集不会再次被当成首次发现；
2. 证物 holder/location/state 传入下一集；
3. 第 5 集 ending 出现在第 6 集上下文；
4. 修改已完成第 5 集后，第 6 集生成被旧 continuity 阻止；
5. 100 集不累加完整历史正文，只使用精简交接和最近尾文；
6. 1—100 集 continuity revision 唯一、连续、可恢复。

### 15.4 调用上限

1. 正常单集正好 2 次；
2. 短稿单集最多 3 次；
3. 明显跑题单集最多 3 次；
4. 格式失败和其他异常组合最多 4 次；
5. resume 不重新消耗已成功节点；
6. JobRunner、HTTP 和业务层重试不会相乘。

## 16. 删除与保留清单

### 16.1 默认路径中停止使用

- 完整 Episode 的多轮结构化 Fixup；
- 为追求精确字数而生成大量 expansion blocks；
- 对短稿反复计算对白/动作配额；
- AI review 后再走复杂白名单 Revision Patch；
- Patch 后第二轮 AI review；
- 字数和对白比例导致的 waiting_user；
- AI 风格建议转 blocking。

### 16.2 继续保留

- `ScriptEpisode` 结构化领域模型；
- 中文短剧 serializer 和各类导出；
- 人物 ID、场号、空块、提示词污染检查；
- 分集卡、人物和世界资料；
- checkpoint、resume、revision fingerprint；
- 正式稿与 continuity 的原子提交；
- 用户可见校稿和人工编辑；
- 五集固定批次与任务去重。

## 17. 风险与处理

| 风险 | 处理 |
| --- | --- |
| 普通文本解析不稳定 | 使用极简固定格式；局部失败保留原文；最多一次格式修复 |
| Flash 仍可能跑题 | 当前卡片写清主事件/禁项；一次 reviewer；最多重写一次 |
| 续写造成重复 | 只给末尾和已发生事件清单；续写一次；检查主要事件重复 |
| AI reviewer 误判 | 只接受六类大问题；必须给 evidence/expected；重写最多一次 |
| 直接文本无法编辑结构 | 解析后仍进入现有 ScriptEpisode 编辑器，原文候选仅用于恢复和审计 |
| 新模式不如直接裸写 | A/B/C 盲评；B 最好就采用 B，不继续加结构 |
| 100 集后期上下文膨胀 | 只传上一集交接、尾文和本集相关状态，不传完整历史 |

## 18. 完成定义

本轮只有同时满足以下条件才算完成：

- 用户可以完整编辑真正影响正文的分集卡字段；
- Flash 直接输出人可读的标准剧本文本；
- 首稿返回后先落 checkpoint，不会因后续失败丢稿；
- 1,200 字目标下至少 4/5 集处于 900—1,500 字；
- 五集不出现明显题材漂移、人物身份错乱或主要事件重复；
- 正常单集 2 次调用，异常单集不超过 4 次；
- 字数和对白比例不会阻塞生成；
- 任何失败都不会覆盖正式 Episode 或 continuity；
- 5 集 A/B/C 实测证明新模式不低于裸写，并优于旧流水线；
- 10 集跨批连续性通过后，才允许继续做 100 集整本测试；
- 后端、前端 typecheck、全量测试、构建和真实 Flash 验收全部通过；
- 文档、UI 文案、实现和线上行为一致。

## 19. 实施顺序

严格按以下顺序执行，避免再次边修边加架构：

1. 评审本计划，只确认产品行为和验收标准；
2. 先写 A/B/C 测试夹具和评分表；
3. 实现纯文本 parser 与 round-trip 测试；
4. 接入 direct draft 和首稿 checkpoint；
5. 接入一次续写；
6. 接入一次 review/handoff 和原子提交；
7. 补齐分集卡编辑器和候选查看；
8. 跑离线测试；
9. 部署功能开关关闭的版本；
10. 在测试项目开启 direct mode，跑五集 C；
11. 同资料跑 B，与现有 A 对照；
12. 只有盲评通过才切默认；
13. 先跑 10 集，再决定是否继续 100 集；
14. 稳定一个发布周期后再删除旧默认链路。

不得跳过第 2、10、11、12 步。我们这次用作品结果决定架构，不再用测试数量或流程复杂度证明质量。
