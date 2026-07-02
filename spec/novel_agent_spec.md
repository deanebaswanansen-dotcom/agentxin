# 小说 Agent 工程规格书（Codex CLI 接手版）

> 目标：把现有“小说 Agent”补成一个可长期迭代、可测试、可恢复、可接入临时 DeepSeek API 的工程化写作系统。本文档给 Codex CLI 作为执行规格使用，优先保证功能闭环、上下文稳定、输出可验收，而不是堆复杂框架。

---

## 0. 执行摘要

当前项目已经有一个基础小说 Agent，但功能不够齐全。接下来需要补齐的是：

1. **模型调用层**：统一封装 LLM Provider，支持 DeepSeek 测试 API，后续可切换 OpenAI、Claude、Gemini、本地模型等。
2. **项目记忆层**：维护作品设定、人物设定、世界观、剧情大纲、已写章节、伏笔、禁忌规则，避免长篇写作中前后矛盾。
3. **写作流水线**：从题材定位 → 世界观 → 人物卡 → 卷/章大纲 → 场景卡 → 正文 → 自检 → 润色 → 连续性审查。
4. **质量控制层**：对剧情逻辑、人物一致性、节奏、视角、设定冲突、重复桥段、废话率、网文爽点进行检查。
5. **命令行交互层**：让用户可以通过 CLI 指令生成、续写、改写、检查、导出，而不是每次手动拼 Prompt。
6. **安全与可维护性**：API Key 不入库；日志脱敏；失败可重试；章节生成可断点恢复。
7. **测试与验收**：提供最小测试工程、假模型测试、DeepSeek API 联调测试、端到端写作测试。

---

## 1. 项目定位

### 1.1 项目名称

暂定：`NovelAgent`

可后续改名，例如：

- `StoryForge Agent`
- `NovelSmith Agent`
- `WriterCodex Agent`
- `WebNovel Agent`

### 1.2 核心目标

构建一个面向长篇小说创作的 Agent 系统，能够辅助完成：

- 小说创意扩展
- 题材与卖点分析
- 世界观设定
- 人物设定
- 大纲规划
- 章节拆分
- 正文生成
- 续写
- 改写
- 润色
- 连续性检查
- 爽点/节奏检查
- 设定库维护
- 多模型 API 调用
- 输出 Markdown / TXT / JSON 项目文件

### 1.3 非目标

当前阶段不做以下内容：

- 不做完整 Web UI，除非已有 UI 基础。
- 不做复杂多智能体框架，先保证单 Agent 流水线可靠。
- 不做自动发布平台。
- 不做付费、账号、多用户系统。
- 不做训练模型、微调模型。
- 不做版权检测平台级能力。
- 不追求一次生成整本小说，优先实现章节级稳定生成。

---

## 2. 技术栈建议

根据用户习惯和 Codex CLI 执行便利性，建议优先使用以下技术栈：

### 2.1 推荐方案 A：Node.js / TypeScript

适合 CLI 工程、文本处理、JSON 配置和多 Provider 调用。

建议依赖：

- `typescript`
- `tsx`
- `commander` 或 `yargs`
- `dotenv`
- `zod`
- `fs-extra`
- `chalk`
- `ora`
- `openai` 或直接 `fetch`

### 2.2 推荐方案 B：Python

适合快速脚本、文本处理、后续接 RAG、向量库、文件解析。

建议依赖：

- `pydantic`
- `typer`
- `rich`
- `python-dotenv`
- `httpx`
- `tenacity`

### 2.3 当前优先级

如果原项目已经是某种语言，不要重写。Codex CLI 应该先检查现有项目：

1. 查看目录结构。
2. 查看 package / requirements / lock 文件。
3. 查看入口文件。
4. 查看已有 Agent、Prompt、API 调用、配置文件。
5. 在原有结构上补齐功能。

不要为了“看起来高级”强行重构整个项目。

---

## 3. 配置规范

### 3.1 环境变量

需要支持 `.env` 或 `.env.local`：

```env
LLM_PROVIDER=deepseek
LLM_API_KEY=replace_with_test_key
LLM_BASE_URL=replace_with_provider_base_url
LLM_MODEL=replace_with_model_name
LLM_TEMPERATURE=0.8
LLM_MAX_TOKENS=4096
LLM_TIMEOUT_MS=120000
```

说明：

- `LLM_API_KEY` 必须从环境变量读取。
- 不允许把真实 Key 写入源码、测试文件、README 示例、日志。
- `LLM_BASE_URL` 不要硬编码，用户会临时提供 DeepSeek API 信息。
- API 用完后用户会删除 Key，所以工程需要在 Key 缺失时给出清晰错误提示。

### 3.2 配置文件

建议增加：

```text
config/
  default.json
  providers.json
  writing_profiles.json
```

`providers.json` 示例：

```json
{
  "deepseek": {
    "type": "openai-compatible",
    "baseUrlEnv": "LLM_BASE_URL",
    "apiKeyEnv": "LLM_API_KEY",
    "modelEnv": "LLM_MODEL"
  },
  "openai": {
    "type": "openai-compatible",
    "baseUrlEnv": "OPENAI_BASE_URL",
    "apiKeyEnv": "OPENAI_API_KEY",
    "modelEnv": "OPENAI_MODEL"
  }
}
```

---

## 4. 目录结构建议

如果项目没有明确结构，建议整理成：

```text
novel-agent/
  README.md
  SPEC.md
  AGENTS.md                  # 可选：给 Codex / Claude Code 的工程规则
  .env.example
  .gitignore
  package.json / pyproject.toml

  src/
    cli/                     # CLI 指令入口
    core/                    # 核心流程编排
    llm/                     # 模型 Provider 适配层
    prompts/                 # Prompt 模板
    memory/                  # 项目记忆、设定库、章节库
    pipeline/                # 写作流水线
    validators/              # 质量检查器
    exporters/               # 导出 Markdown/TXT/JSON
    utils/

  projects/
    demo-novel/
      project.json
      bible/
        premise.md
        world.md
        characters.md
        rules.md
        timeline.md
        foreshadowing.md
      outline/
        volume-01.md
        chapter-list.md
      chapters/
        ch001.md
        ch002.md
      reviews/
        ch001.review.md
      state.json

  tests/
    unit/
    integration/
    fixtures/
```

---

## 5. 数据模型

### 5.1 NovelProject

用于描述一个小说项目。

```ts
interface NovelProject {
  id: string;
  title: string;
  genre: string[];
  targetAudience?: string;
  tone: string[];
  lengthPlan?: string;
  createdAt: string;
  updatedAt: string;
  paths: {
    root: string;
    bible: string;
    outline: string;
    chapters: string;
    reviews: string;
  };
}
```

### 5.2 StoryBible

用于维护作品总设定。

```ts
interface StoryBible {
  premise: string;
  sellingPoints: string[];
  worldRules: string[];
  characterRules: string[];
  styleRules: string[];
  forbiddenRules: string[];
  timeline: TimelineEvent[];
  foreshadowing: ForeshadowingItem[];
}
```

### 5.3 CharacterCard

```ts
interface CharacterCard {
  id: string;
  name: string;
  role: "protagonist" | "heroine" | "support" | "villain" | "other";
  age?: string;
  appearance?: string;
  personality: string[];
  desire: string;
  fear?: string;
  secret?: string;
  relationshipMap: Record<string, string>;
  speechStyle?: string;
  growthArc?: string;
  constraints: string[];
}
```

### 5.4 ChapterPlan

```ts
interface ChapterPlan {
  chapterNo: number;
  title: string;
  pov?: string;
  summary: string;
  purpose: string;
  keyEvents: string[];
  conflict: string;
  hook: string;
  requiredCharacters: string[];
  continuityNotes: string[];
  wordTarget?: number;
}
```

### 5.5 ReviewReport

```ts
interface ReviewReport {
  chapterNo: number;
  score: number;
  issues: ReviewIssue[];
  continuityConflicts: string[];
  styleProblems: string[];
  suggestedFixes: string[];
  pass: boolean;
}
```

---

## 6. 核心模块规格

## 6.1 LLM Provider 适配层

### 目标

把所有模型调用统一封装，避免业务代码到处写 API 请求。

### 必须支持

- OpenAI-compatible chat completions。
- 从环境变量读取 `apiKey`、`baseURL`、`model`。
- 支持 temperature、maxTokens、timeout。
- 支持失败重试。
- 支持请求日志，但不能记录 API Key。
- 支持 dry-run / mock 模式，便于没有 Key 时测试。

### 接口建议

```ts
interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
}

interface LLMClient {
  generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<string>;
}
```

### 验收标准

- 没有 API Key 时，CLI 显示明确错误，不崩溃。
- DeepSeek 测试 Key 可成功完成一次 `ping`。
- 所有写作模块都通过同一层调用模型。
- 日志中不能出现完整 Key。

---

## 6.2 Project Memory 项目记忆层

### 目标

让 Agent 不依赖一次性长上下文，而是每次生成前主动读取必要设定。

### 必须维护

- 小说前提 `premise.md`
- 世界观 `world.md`
- 人物卡 `characters.md`
- 规则/禁忌 `rules.md`
- 时间线 `timeline.md`
- 伏笔表 `foreshadowing.md`
- 章节摘要 `chapter-summaries.md`
- 已完成章节正文 `chapters/*.md`
- 审查报告 `reviews/*.review.md`

### 功能要求

- `loadProject(projectPath)`：加载项目。
- `getContextForChapter(chapterNo)`：生成某章所需上下文。
- `updateChapterSummary(chapterNo)`：写完章节后生成摘要。
- `updateTimeline(chapterNo)`：抽取时间线变化。
- `updateForeshadowing(chapterNo)`：记录新增伏笔/回收伏笔。
- `checkContradiction(chapterNo)`：检查当前章节和设定冲突。

### 验收标准

- 生成第 N 章时，会自动读取：总设定、人物设定、章节计划、前 1–3 章摘要、当前未回收伏笔。
- 写完章节后自动更新摘要，不需要手动复制。
- 项目状态保存在 `state.json`，可以断点恢复。

---

## 6.3 Prompt 模板层

### 目标

把 Prompt 从代码里拆出来，方便调整风格和规则。

### 目录建议

```text
src/prompts/
  system.md
  premise_expand.md
  character_create.md
  world_build.md
  volume_outline.md
  chapter_outline.md
  scene_plan.md
  chapter_draft.md
  chapter_rewrite.md
  chapter_review.md
  continuity_check.md
  style_polish.md
  summary_update.md
```

### Prompt 变量

Prompt 模板支持变量插入：

```text
{{project_title}}
{{genre}}
{{style_rules}}
{{story_bible}}
{{character_cards}}
{{chapter_plan}}
{{previous_summary}}
{{user_instruction}}
```

### 规则

- Prompt 模板不得写死模型名称。
- Prompt 模板不得写死用户 API Key。
- 每个 Prompt 顶部写明用途、输入、输出。
- 对需要结构化解析的输出，要求模型返回 JSON 或严格 Markdown。

---

## 6.4 小说规划模块

### 功能 1：创意扩展

指令示例：

```bash
novel-agent idea "喜欢玩黄油的我，没想到遇到的校花也有这种爱好"
```

输出：

- 核心卖点
- 目标读者
- 题材标签
- 主线冲突
- 男女主关系推进
- 前 10 章钩子
- 风险点

### 功能 2：世界观生成

```bash
novel-agent world ./projects/demo-novel
```

输出：

- 世界规则
- 学校/社团/城市/家庭结构
- 隐藏规则
- 禁止破坏的设定
- 可扩展设定

### 功能 3：人物卡生成

```bash
novel-agent character ./projects/demo-novel --role heroine --count 4
```

输出：

- 人物外貌
- 性格
- 欲望
- 缺点
- 口癖
- 与主角关系
- 专属剧情线
- 人设雷区

### 功能 4：卷大纲生成

```bash
novel-agent outline ./projects/demo-novel --volume 1 --chapters 30
```

输出：

- 每章标题
- 每章作用
- 每章冲突
- 每章钩子
- 关系推进
- 伏笔投放/回收

---

## 6.5 章节生成模块

### 输入

- 项目设定
- 人物设定
- 当前章节计划
- 前文摘要
- 用户额外指令
- 字数目标

### 输出

- 正文 Markdown
- 章节摘要
- 新增设定
- 新增伏笔
- 待回收问题
- 自检报告

### 指令示例

```bash
novel-agent write ./projects/demo-novel --chapter 1
novel-agent write ./projects/demo-novel --chapter 2 --words 3000
novel-agent continue ./projects/demo-novel --chapter 2
```

### 生成流程

1. 读取项目状态。
2. 读取当前章节计划。
3. 读取相关人物卡。
4. 读取前文摘要。
5. 组装上下文。
6. 调用模型生成正文。
7. 保存到 `chapters/chXXX.md`。
8. 自动生成章节摘要。
9. 自动运行基础审查。
10. 写入 `reviews/chXXX.review.md`。

### 验收标准

- 章节文件存在且格式正确。
- 章节标题、正文、摘要、审查报告分开保存。
- 失败时不覆盖旧文件，改存为 `.draft.md` 或 `.failed.md`。
- 支持 `--overwrite` 明确覆盖。

---

## 6.6 续写模块

### 目标

给定已有章节末尾，继续写后续内容，不破坏上下文。

### 指令

```bash
novel-agent continue ./projects/demo-novel --chapter 3 --from-end
```

### 规则

- 默认读取当前章节末尾 800–1500 字。
- 结合当前章节计划判断是否偏离。
- 续写时不要重复前文。
- 续写完成后合并到章节末尾前，先生成 `.continue.md`，由用户确认或使用 `--apply`。

### 验收标准

- 不直接破坏原章节。
- 续写内容与原文衔接自然。
- 有独立审查报告。

---

## 6.7 改写 / 润色模块

### 指令

```bash
novel-agent rewrite ./projects/demo-novel --chapter 1 --mode stronger-hook
novel-agent polish ./projects/demo-novel --chapter 1 --mode webnovel
```

### 支持模式

- `clean`：清理病句和重复表达。
- `webnovel`：增强网文节奏和可读性。
- `stronger-hook`：强化章末钩子。
- `character-voice`：强化人物台词差异。
- `emotion`：增强情绪张力。
- `less-water`：降低废话率。
- `more-detail`：增加画面细节。

### 规则

- 改写结果保存为新文件：`ch001.rewrite.md`。
- 默认不覆盖原文。
- 必须生成改动说明。

---

## 6.8 连续性审查模块

### 检查内容

- 人物性格是否前后不一致。
- 人物关系是否跳跃。
- 时间线是否冲突。
- 地点是否冲突。
- 已设定能力/规则是否被破坏。
- 伏笔是否遗忘。
- 新设定是否没有登记。
- 章节目标是否完成。

### 指令

```bash
novel-agent check ./projects/demo-novel --chapter 5
novel-agent check ./projects/demo-novel --range 1-10
```

### 输出

```markdown
# 第 5 章连续性审查

## 总评分
78 / 100

## 主要问题
1. 女主 A 在第 2 章设定为怕水，但第 5 章主动跳入湖中，没有解释。
2. 第 4 章埋下的社团钥匙伏笔，第 5 章没有延续。

## 修复建议
- 在跳湖前增加心理挣扎，或改成被迫落水。
- 在结尾加入钥匙再次出现的细节。

## 是否建议通过
不建议直接通过，需要小修。
```

### 验收标准

- 能输出具体问题，不只是空泛评价。
- 每个问题尽量指向章节、人物或设定。
- 报告保存到 `reviews/`。

---

## 6.9 风格控制模块

### 写作档案 Writing Profile

建议维护：

```json
{
  "name": "webnovel_fast_reading",
  "language": "zh-CN",
  "tone": ["轻松", "暧昧", "吐槽", "节奏快"],
  "sentence": {
    "preferShortParagraphs": true,
    "avoidLongExposition": true,
    "dialogueRatio": "medium-high"
  },
  "rules": [
    "每章结尾保留钩子",
    "人物台词要区分口吻",
    "避免连续大段设定说明",
    "感情推进要有台阶，不要突然满好感"
  ],
  "forbidden": [
    "机械式总结",
    "人物突然降智",
    "重复解释同一设定",
    "每章都用同一种冲突模板"
  ]
}
```

### 指令

```bash
novel-agent profile list
novel-agent profile apply ./projects/demo-novel webnovel_fast_reading
```

---

## 6.10 导出模块

### 支持导出

```bash
novel-agent export ./projects/demo-novel --format md
novel-agent export ./projects/demo-novel --format txt
novel-agent export ./projects/demo-novel --format json
```

### 输出

```text
exports/
  demo-novel.full.md
  demo-novel.full.txt
  demo-novel.project.json
```

### 规则

- Markdown 导出保留标题层级。
- TXT 导出适合阅读，不带过多元信息。
- JSON 导出保留项目结构，方便后续导入。

---

## 7. CLI 指令总表

| 指令 | 功能 | 示例 |
|---|---|---|
| `init` | 初始化小说项目 | `novel-agent init ./projects/demo --title "社团恋爱喜剧"` |
| `ping` | 测试模型连接 | `novel-agent ping` |
| `idea` | 扩展创意 | `novel-agent idea "一句话创意"` |
| `world` | 生成/补全世界观 | `novel-agent world ./projects/demo` |
| `character` | 生成人物卡 | `novel-agent character ./projects/demo --role heroine --count 4` |
| `outline` | 生成章节大纲 | `novel-agent outline ./projects/demo --chapters 30` |
| `write` | 生成章节正文 | `novel-agent write ./projects/demo --chapter 1` |
| `continue` | 续写章节 | `novel-agent continue ./projects/demo --chapter 1` |
| `rewrite` | 改写章节 | `novel-agent rewrite ./projects/demo --chapter 1 --mode less-water` |
| `polish` | 润色章节 | `novel-agent polish ./projects/demo --chapter 1` |
| `check` | 审查章节 | `novel-agent check ./projects/demo --chapter 1` |
| `summary` | 更新摘要 | `novel-agent summary ./projects/demo --chapter 1` |
| `export` | 导出作品 | `novel-agent export ./projects/demo --format md` |
| `state` | 查看项目状态 | `novel-agent state ./projects/demo` |

---

## 8. 写作流水线

### 8.1 标准流程

```text
用户创意
  ↓
创意扩展 idea
  ↓
作品设定 premise/world/rules
  ↓
人物卡 characters
  ↓
卷大纲 volume outline
  ↓
章节大纲 chapter outline
  ↓
章节正文 draft
  ↓
自动摘要 summary
  ↓
连续性检查 continuity check
  ↓
风格润色 polish
  ↓
人工确认
  ↓
进入下一章
```

### 8.2 每章生成前上下文组装

每次写章节时，Prompt 上下文按以下优先级拼装：

1. 系统写作规则。
2. 当前小说核心设定。
3. 禁止破坏的设定。
4. 相关人物卡。
5. 时间线摘要。
6. 未回收伏笔。
7. 前 1–3 章摘要。
8. 当前章节计划。
9. 用户额外要求。

不要把所有章节全文都塞进上下文，避免上下文污染和成本爆炸。

---

## 9. 质量评分标准

每章审查建议按 100 分制：

| 维度 | 分值 | 说明 |
|---|---:|---|
| 剧情推进 | 20 | 本章是否真的推进主线/关系/冲突 |
| 人物一致性 | 15 | 人设、口吻、行为是否稳定 |
| 连续性 | 15 | 是否和前文设定冲突 |
| 节奏 | 15 | 是否拖沓、废话、信息密度低 |
| 画面感 | 10 | 场景和动作是否清晰 |
| 台词 | 10 | 台词是否自然、有区分度 |
| 钩子 | 10 | 章末是否有继续阅读动力 |
| 文风符合度 | 5 | 是否符合当前 Writing Profile |

通过建议：

- `90+`：优秀，可进入下一章。
- `80–89`：可用，小修。
- `70–79`：勉强可用，建议改写关键段落。
- `<70`：不建议通过，需要重写或大修。

---

## 10. DeepSeek API 临时测试要求

### 10.1 基本原则

用户会给一个测试用 DeepSeek API，用完后删除。因此工程必须做到：

- Key 只放 `.env.local`。
- `.env.local` 必须加入 `.gitignore`。
- 日志不得打印完整 Key。
- README 只能写占位符。
- 联调结束后可以运行无 Key 的 mock 测试。

### 10.2 `.gitignore` 必须包含

```gitignore
.env
.env.local
*.log
logs/
.cache/
exports/tmp/
```

### 10.3 API 测试指令

```bash
novel-agent ping
```

输出示例：

```text
Provider: deepseek
Model: from-env
Base URL: from-env
API Key: ****abcd
Status: OK
Latency: 1234ms
```

### 10.4 联调验收

至少完成三次模型调用：

1. `ping`：确认 API 可用。
2. `idea`：确认普通文本生成可用。
3. `write --chapter 1`：确认长文本生成可用。

---

## 11. 错误处理

### 11.1 常见错误

| 错误 | 处理 |
|---|---|
| API Key 缺失 | 提示用户设置环境变量 |
| Base URL 缺失 | 提示用户设置环境变量 |
| 请求超时 | 自动重试，最终失败保存上下文 |
| 模型输出为空 | 重试一次，仍失败则保存错误报告 |
| JSON 解析失败 | 尝试修复；失败则保存原始输出 |
| 章节文件已存在 | 默认不覆盖，要求 `--overwrite` |
| 生成中断 | 保存 `.partial.md` |

### 11.2 错误文件

建议保存：

```text
logs/
  latest.log
  errors/YYYY-MM-DD-HH-mm-ss.md
```

错误报告包含：

- 执行指令
- Provider 名称
- 模型名
- 时间
- 错误类型
- 脱敏后的请求信息
- 是否已保存 partial 文件

---

## 12. 测试计划

### 12.1 单元测试

必须覆盖：

- 配置加载。
- API Key 脱敏。
- Prompt 模板变量替换。
- 项目路径解析。
- 章节编号格式化。
- 文件写入不覆盖。
- ReviewReport 解析。

### 12.2 Mock 集成测试

在无真实 API Key 时也能跑：

```bash
novel-agent ping --mock
novel-agent idea "测试创意" --mock
novel-agent write ./projects/demo --chapter 1 --mock
```

Mock 输出固定文本，主要测试流程和文件生成。

### 12.3 真实 API 联调测试

使用用户临时 DeepSeek API：

```bash
novel-agent ping
novel-agent idea "一个普通高中生加入神秘社团后，被迫和几位性格不同的少女一起解决校园怪谈"
novel-agent init ./projects/api-test --title "社团怪谈恋爱喜剧"
novel-agent world ./projects/api-test
novel-agent character ./projects/api-test --role heroine --count 3
novel-agent outline ./projects/api-test --chapters 5
novel-agent write ./projects/api-test --chapter 1 --words 1500
novel-agent check ./projects/api-test --chapter 1
```

### 12.4 验收标准

- 所有 mock 测试通过。
- DeepSeek `ping` 成功。
- 能生成一个完整 demo 项目。
- 第 1 章正文、摘要、审查报告均能落盘。
- 无 API Key 泄露。
- 断点恢复可用。

---

## 13. Codex CLI 执行步骤

Codex CLI 接手时按以下顺序执行。

### Step 1：读取项目

```text
1. 查看根目录。
2. 查看 README / package / src。
3. 找出现有入口和模型调用位置。
4. 不要立刻大改，先写出当前项目结构总结。
```

### Step 2：补环境配置

```text
1. 增加 .env.example。
2. 检查 .gitignore。
3. 增加配置加载模块。
4. 增加 API Key 脱敏函数。
```

### Step 3：补 LLM Provider

```text
1. 抽象 LLMClient。
2. 实现 OpenAI-compatible provider。
3. 实现 mock provider。
4. 增加 ping 指令。
```

### Step 4：补项目结构

```text
1. 增加 init 指令。
2. 自动创建 bible/ outline/ chapters/ reviews/ exports/。
3. 增加 project.json 和 state.json。
```

### Step 5：补 Prompt 模板

```text
1. 拆分 prompts。
2. 实现模板变量替换。
3. 每个写作动作使用独立 prompt。
```

### Step 6：补写作流水线

```text
1. idea。
2. world。
3. character。
4. outline。
5. write。
6. summary。
7. check。
8. polish / rewrite。
9. export。
```

### Step 7：补测试

```text
1. 先 mock 测试。
2. 再 DeepSeek 真实 API 测试。
3. 检查输出文件。
4. 检查日志脱敏。
```

---

## 14. 最小可用版本 MVP

如果时间有限，先完成 MVP：

1. `.env.example` + `.gitignore`。
2. LLM Provider 统一调用。
3. `ping`。
4. `init`。
5. `idea`。
6. `outline`。
7. `write`。
8. `check`。
9. `summary`。
10. mock 测试。

MVP 不强求：

- 多模型高级路由。
- 向量数据库。
- Web UI。
- 多 Agent 并行。
- 自动发布。

---

## 15. Prompt 输出格式建议

### 15.1 章节正文格式

```markdown
# 第 X 章：标题

正文内容……

---

## 本章摘要

- ……

## 新增设定

- ……

## 新增伏笔

- ……
```

### 15.2 审查报告格式

```markdown
# 第 X 章审查报告

## 总分

85 / 100

## 优点

- ……

## 问题

1. ……

## 修复建议

1. ……

## 是否通过

小修后通过。
```

---

## 16. 写作质量硬规则

生成小说正文时，必须遵守：

1. 不要一章里塞太多设定说明。
2. 不要让人物突然变聪明或突然降智，只为推动剧情。
3. 不要每章都用同一种冲突模板。
4. 不要用机械总结代替场景。
5. 不要连续大段心理独白。
6. 台词要体现人物身份、性格和关系。
7. 情感推进要有台阶。
8. 章末要留钩子，但不能每次都靠强行反转。
9. 新设定必须登记到设定库。
10. 伏笔必须记录，不要写了就忘。

---

## 17. 后续增强方向

### 17.1 RAG / 向量检索

当前不作为 MVP，但后续可以把：

- 人物卡
- 设定库
- 章节摘要
- 伏笔
- 历史章节

切成片段后做检索，用于更长篇幅小说。

### 17.2 多 Agent 分工

后续可以拆成：

- 总编 Agent：定方向。
- 大纲 Agent：拆结构。
- 正文 Agent：写章节。
- 审稿 Agent：挑毛病。
- 连续性 Agent：查设定冲突。
- 润色 Agent：修文风。

但当前不要过早复杂化，先把单 Agent 流水线跑通。

### 17.3 UI

后续可以做一个简单 Web UI：

- 左侧项目树。
- 中间章节编辑器。
- 右侧设定卡 / 审查报告。
- 顶部模型配置。

---

## 18. 给 Codex CLI 的最终要求

执行时请遵守：

1. 先理解现有项目，不要盲目重写。
2. 优先补齐可运行闭环。
3. 所有模型调用走统一 Provider。
4. API Key 只从环境变量读取。
5. 不要把测试 Key 写入任何文件。
6. 每做完一个模块，运行对应测试。
7. 生成的章节和报告必须落盘。
8. 默认不覆盖用户已有小说内容。
9. 保留 mock 模式，避免每次测试都消耗 API。
10. 最终交付时给出：已完成清单、运行命令、测试结果、未完成项。

---

## 19. 推荐交付结果

Codex CLI 最终应提交：

```text
- 新增/修改的代码文件
- .env.example
- README 更新
- SPEC.md
- demo 项目
- mock 测试结果
- DeepSeek API 联调说明
- 使用命令清单
```

最终用户应该能运行：

```bash
novel-agent ping
novel-agent init ./projects/demo --title "测试小说"
novel-agent idea "一个普通学生加入神秘社团后，被迫和几位少女一起解决校园事件"
novel-agent outline ./projects/demo --chapters 5
novel-agent write ./projects/demo --chapter 1
novel-agent check ./projects/demo --chapter 1
novel-agent export ./projects/demo --format md
```

如果以上命令能跑通，这个小说 Agent 就具备了继续迭代的基础。
