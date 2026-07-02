# 小说 Agent：LangChain / LangGraph 强制工程规格书

> 版本：v2.0 Strict Spec  
> 用途：交给 Codex CLI / Claude Code / 其他编码 Agent 执行。  
> 目标：禁止 5 分钟玩具 Agent；必须做成具备上下文、记忆、自我反省、工具调用、MCP 接入、可测试、可恢复、可验收的小说写作 Agent。

---

## 0. 强制声明

本项目不是“调用一次大模型生成一章小说”的脚本。

本项目必须实现一个具备以下能力的工程化小说 Agent：

1. **系统提示词层**：有明确的身份、边界、工作流、写作规则、禁忌、输出格式。
2. **上下文层**：能够读取并注入小说 Bible、人物设定、世界观、时间线、章节摘要、伏笔、当前任务。
3. **长期记忆层**：能够把章节摘要、人物变化、伏笔状态、设定变更写入持久化文件或数据库。
4. **短期工作记忆层**：能够在一次任务中保留当前目标、草稿、审查意见、修改计划。
5. **自我反省层**：生成内容后必须进行一致性检查、质量审查、问题归因和修订。
6. **工具调用层**：所有文件读写、检索、导出、统计、审查都必须通过清晰工具接口完成。
7. **MCP 层**：预留或实现 MCP Server / MCP Client 接口，用于连接外部工具、素材库、知识库、项目文件。
8. **Provider 层**：DeepSeek / OpenAI-compatible / Mock Provider 必须统一封装，不能散落 API 请求代码。
9. **状态机层**：核心流程必须是可追踪的 Agent Graph，而不是一堆 if else 脚本。
10. **验收层**：没有通过 mock 测试、API ping、端到端写作测试、上下文注入测试、自我反省测试，不允许宣称完成。

任何实现如果只有：

- 一个 prompt；
- 一个 chat completion；
- 一个 `write_chapter()`；
- 没有状态；
- 没有上下文注入；
- 没有审查和修订；
- 没有测试；
- 没有 API ping；
- 没有错误处理；

一律判定为 **不合格**。

---

## 1. 技术栈强制要求

### 1.1 首选架构

必须优先使用：

- Python 3.11+
- LangChain
- LangGraph
- Pydantic
- Typer 或 Click 作为 CLI
- Rich 作为终端输出
- python-dotenv 或等价配置加载
- SQLite / JSON 文件作为初期持久化
- pytest 作为测试框架

### 1.2 为什么要用 LangGraph

普通 LangChain Agent 容易变成“模型调用 + 工具调用”的薄封装。小说 Agent 是长流程任务，需要：

- 可恢复状态；
- 多步骤工作流；
- 多轮自我反省；
- 节点级调试；
- 失败重试；
- 人工审核插入点；
- 章节级、项目级记忆。

因此核心写作流程必须使用 **LangGraph StateGraph** 或等价状态机实现。

### 1.3 禁止事项

禁止出现以下实现方式：

```text
main.py 里直接拼 prompt → 调 API → print 结果
```

禁止把系统提示词、API Key、模型名、温度、路径、项目状态硬编码在业务函数里。

禁止多个文件各自实现一套 DeepSeek 请求逻辑。

禁止把“自我反省”写成一个无约束的普通 prompt，然后不解析、不落盘、不进入修订流程。

---

## 2. 目标能力总览

小说 Agent 至少分为 11 个核心子系统。

```text
NovelAgent
├── 01 Config Layer              配置层
├── 02 Provider Layer            模型供应商层
├── 03 Prompt Layer              系统提示词与任务提示词层
├── 04 Project Context Layer     小说项目上下文层
├── 05 Memory Layer              长短期记忆层
├── 06 Tool Layer                工具层
├── 07 MCP Layer                 MCP 接入层
├── 08 Agent Graph Layer         LangGraph 状态机层
├── 09 Reflection Layer          自我反省 / 审稿 / 修订层
├── 10 CLI Layer                 命令行交互层
└── 11 Test & Evaluation Layer   测试与验收层
```

---

## 3. 项目目录强制结构

实现时必须调整或补齐为类似结构。已有项目可以迁移，但不能继续混乱堆文件。

```text
novel-agent/
├── README.md
├── SPEC.md
├── AGENTS.md
├── pyproject.toml
├── .env.example
├── .gitignore
├── src/
│   └── novel_agent/
│       ├── __init__.py
│       ├── cli.py
│       ├── config.py
│       ├── logging_config.py
│       │
│       ├── providers/
│       │   ├── __init__.py
│       │   ├── base.py
│       │   ├── openai_compatible.py
│       │   ├── deepseek.py
│       │   └── mock.py
│       │
│       ├── prompts/
│       │   ├── __init__.py
│       │   ├── system.py
│       │   ├── planner.py
│       │   ├── writer.py
│       │   ├── critic.py
│       │   ├── reviser.py
│       │   └── schemas.py
│       │
│       ├── context/
│       │   ├── __init__.py
│       │   ├── project_loader.py
│       │   ├── context_builder.py
│       │   ├── retrieval.py
│       │   └── token_budget.py
│       │
│       ├── memory/
│       │   ├── __init__.py
│       │   ├── short_term.py
│       │   ├── long_term.py
│       │   ├── chapter_summary.py
│       │   ├── continuity_store.py
│       │   └── foreshadowing_store.py
│       │
│       ├── tools/
│       │   ├── __init__.py
│       │   ├── file_tools.py
│       │   ├── project_tools.py
│       │   ├── search_tools.py
│       │   ├── export_tools.py
│       │   ├── validation_tools.py
│       │   └── stats_tools.py
│       │
│       ├── mcp/
│       │   ├── __init__.py
│       │   ├── server.py
│       │   ├── client.py
│       │   ├── tools.py
│       │   └── manifest.py
│       │
│       ├── graph/
│       │   ├── __init__.py
│       │   ├── state.py
│       │   ├── nodes.py
│       │   ├── edges.py
│       │   ├── workflow.py
│       │   └── checkpoints.py
│       │
│       ├── reflection/
│       │   ├── __init__.py
│       │   ├── critic.py
│       │   ├── consistency.py
│       │   ├── style.py
│       │   ├── plot_logic.py
│       │   └── revision.py
│       │
│       └── evaluation/
│           ├── __init__.py
│           ├── rubrics.py
│           ├── scoring.py
│           └── regression.py
│
├── projects/
│   └── example_novel/
│       ├── project.yaml
│       ├── bible/
│       │   ├── premise.md
│       │   ├── world.md
│       │   ├── characters.md
│       │   ├── factions.md
│       │   ├── style.md
│       │   ├── taboos.md
│       │   └── canon.md
│       ├── outline/
│       │   ├── volume_001.md
│       │   └── chapter_plan.md
│       ├── chapters/
│       │   ├── ch001.md
│       │   └── ch002.md
│       ├── memory/
│       │   ├── summaries.jsonl
│       │   ├── continuity.json
│       │   ├── foreshadowing.json
│       │   ├── character_arcs.json
│       │   └── timeline.json
│       ├── reviews/
│       │   ├── ch001.review.json
│       │   └── ch001.revision_plan.md
│       └── exports/
│
└── tests/
    ├── test_config.py
    ├── test_provider_mock.py
    ├── test_provider_deepseek_ping.py
    ├── test_context_builder.py
    ├── test_memory.py
    ├── test_graph_flow.py
    ├── test_reflection.py
    └── test_cli_smoke.py
```

---

## 4. 配置层强制要求

### 4.1 `.env.example`

必须提供：

```env
NOVEL_AGENT_PROVIDER=deepseek
NOVEL_AGENT_MODEL=deepseek-chat
NOVEL_AGENT_BASE_URL=https://api.deepseek.com
NOVEL_AGENT_API_KEY=replace_me
NOVEL_AGENT_TIMEOUT_SECONDS=120
NOVEL_AGENT_MAX_RETRIES=3
NOVEL_AGENT_TEMPERATURE=0.75
NOVEL_AGENT_MAX_TOKENS=4096
NOVEL_AGENT_STREAM=true
NOVEL_AGENT_PROJECT_DIR=projects/example_novel
NOVEL_AGENT_LOG_LEVEL=INFO
```

### 4.2 Key 安全

必须满足：

- `.env` 必须加入 `.gitignore`。
- 日志中不得打印完整 API Key。
- 报错信息不得包含完整 Authorization Header。
- 测试中不得写死真实 Key。
- README 中只允许出现 `replace_me` 示例。
- DeepSeek 临时 Key 用完后可以直接删除 `.env`。

### 4.3 配置对象

必须用 Pydantic 或 dataclass 建立统一配置对象：

```python
class AgentConfig(BaseModel):
    provider: str
    model: str
    base_url: str
    api_key: SecretStr
    timeout_seconds: int = 120
    max_retries: int = 3
    temperature: float = 0.75
    max_tokens: int = 4096
    stream: bool = True
    project_dir: Path
    log_level: str = "INFO"
```

验收标准：

```bash
novel-agent config doctor
```

必须输出：

```text
[OK] .env loaded
[OK] provider = deepseek
[OK] model = xxx
[OK] base_url configured
[OK] api_key exists and is masked
[OK] project_dir exists
```

---

## 5. Provider 层强制要求

### 5.1 统一接口

必须定义统一模型供应商接口。

```python
class LLMProvider(Protocol):
    def complete(self, messages: list[Message], options: CompletionOptions) -> CompletionResult:
        ...

    def stream(self, messages: list[Message], options: CompletionOptions) -> Iterator[CompletionChunk]:
        ...

    def ping(self) -> ProviderPingResult:
        ...
```

### 5.2 必须实现三个 Provider

1. `MockProvider`
   - 不调用真实 API。
   - 用于测试 LangGraph 流程、CLI、解析逻辑。

2. `OpenAICompatibleProvider`
   - 所有 OpenAI-compatible API 共用。
   - 负责 base_url、api_key、timeout、retry、stream、错误转换。

3. `DeepSeekProvider`
   - 继承或包装 `OpenAICompatibleProvider`。
   - 不允许到处写 DeepSeek 专用请求。
   - DeepSeek 只是一个 provider 配置，不是业务逻辑。

### 5.3 API 接不好的强制排查

Codex CLI 必须先实现：

```bash
novel-agent provider ping
```

输出必须包含：

```text
Provider: deepseek
Base URL: https://api.deepseek.com
Model: xxx
API Key: sk-****abcd
Network: OK / FAILED
Auth: OK / FAILED
Chat Completion: OK / FAILED
Latency: xxx ms
```

失败时必须给出分类错误：

```text
CONFIG_ERROR: 缺少 API Key 或 base_url
AUTH_ERROR: Key 无效或权限不足
NETWORK_ERROR: DNS / 代理 / 超时
MODEL_ERROR: 模型名错误或模型不可用
RATE_LIMIT_ERROR: 限流
PROVIDER_ERROR: 服务端错误
PARSE_ERROR: 返回结构不符合预期
UNKNOWN_ERROR: 未知错误
```

禁止只输出：

```text
API failed
```

---

## 6. Prompt 层强制要求

### 6.1 Prompt 必须分层

不能把所有内容塞进一个 prompt。

必须至少包含：

```text
System Prompt       Agent 身份、边界、规则
Project Prompt      小说项目设定
Task Prompt         当前任务
Context Prompt      检索出来的相关上下文
Memory Prompt       长期记忆摘要
Output Contract     输出格式协议
Reflection Prompt   审查和反省要求
Revision Prompt     修订要求
```

### 6.2 System Prompt 必须包含

系统提示词必须明确写入：

1. 你是小说写作 Agent，不是聊天机器人。
2. 必须维护设定一致性。
3. 不允许擅自改人物核心设定。
4. 不允许让伏笔凭空消失。
5. 不允许跳过上下文读取。
6. 不允许只生成正文而不做审查。
7. 不允许输出与任务无关的解释。
8. 不确定时必须标记为 `NEEDS_HUMAN_REVIEW`，不能瞎编成定论。
9. 写作结果必须能回写记忆。
10. 任何工具调用失败必须进入错误恢复流程。

### 6.3 输出必须结构化

除最终小说正文外，计划、审查、摘要、记忆更新都必须用 JSON / Pydantic schema。

例如章节审查输出：

```json
{
  "chapter_id": "ch001",
  "score": 7.5,
  "continuity_issues": [],
  "character_issues": [],
  "plot_logic_issues": [],
  "style_issues": [],
  "foreshadowing_updates": [],
  "revision_required": true,
  "revision_plan": [
    {
      "priority": "high",
      "issue": "主角动机不够明确",
      "action": "在第二场景加入内心矛盾"
    }
  ]
}
```

---

## 7. 上下文层强制要求

### 7.1 Context Builder

必须有 `ContextBuilder`，负责把项目文件组织成模型输入。

```text
ContextBuilder 输入：
- 当前任务
- 当前章节编号
- 当前卷/篇章规划
- 小说 Bible
- 人物设定
- 世界观设定
- 最近 N 章摘要
- 相关伏笔
- 相关时间线
- 用户额外指令

ContextBuilder 输出：
- system messages
- context messages
- task messages
- token budget report
```

### 7.2 上下文预算

必须实现 token 预算策略。

优先级从高到低：

1. 当前用户任务
2. 系统提示词
3. 当前章节计划
4. 核心人物设定
5. 强制禁忌和风格要求
6. 最近 3 章摘要
7. 当前相关伏笔
8. 世界观摘要
9. 更早章节摘要
10. 参考素材

超出预算时，不能随机裁剪，必须按优先级裁剪并生成报告。

### 7.3 上下文注入验收

必须有命令：

```bash
novel-agent context build --chapter ch003 --task "写第三章"
```

输出必须显示：

```text
[OK] Loaded premise.md
[OK] Loaded characters.md
[OK] Loaded world.md
[OK] Loaded chapter_plan.md
[OK] Loaded recent summaries: ch001, ch002
[OK] Loaded active foreshadowing: 3 items
[OK] Token budget: 12000 / 32000
```

---

## 8. 记忆层强制要求

### 8.1 短期记忆

短期记忆保存一次任务内的信息：

```json
{
  "task_id": "write_ch003_2026_06_04",
  "goal": "写第三章初稿",
  "current_step": "revision",
  "draft_path": "chapters/ch003.draft.md",
  "critic_result_path": "reviews/ch003.review.json",
  "revision_plan_path": "reviews/ch003.revision_plan.md"
}
```

### 8.2 长期记忆

长期记忆至少包含：

```text
memory/summaries.jsonl          每章摘要
memory/continuity.json          连贯性事实
memory/foreshadowing.json       伏笔状态
memory/character_arcs.json      人物成长变化
memory/timeline.json            事件时间线
```

### 8.3 章节结束必须写入记忆

每完成一章，必须自动生成并落盘：

1. 章节摘要。
2. 新增事实。
3. 人物关系变化。
4. 伏笔新增 / 推进 / 回收。
5. 时间线事件。
6. 下章衔接点。

没有记忆写入，不允许标记章节完成。

---

## 9. 工具层强制要求

### 9.1 工具类型

必须至少有以下工具：

```text
FileReadTool
FileWriteTool
ProjectLoadTool
ContextBuildTool
ChapterSaveTool
ChapterSummaryTool
ContinuityCheckTool
ForeshadowingUpdateTool
ExportTool
StatsTool
```

### 9.2 工具接口必须可控

每个工具必须有：

```text
name
purpose
input_schema
output_schema
side_effects
error_types
requires_confirmation
```

例如写文件工具：

```python
class FileWriteInput(BaseModel):
    path: str
    content: str
    overwrite: bool = False

class FileWriteOutput(BaseModel):
    path: str
    bytes_written: int
    overwritten: bool
```

### 9.3 写操作必须安全

默认禁止覆盖已有文件。

覆盖必须显式传入：

```bash
--overwrite
```

或者进入人类确认：

```text
File exists: chapters/ch003.md
Action required: overwrite / save_as_draft / cancel
```

---

## 10. MCP 层强制要求

> 注意：这里是 MCP，Model Context Protocol，不是 MPC。

### 10.1 MCP 的定位

MCP 层用于把小说 Agent 接入外部上下文和工具，例如：

- 本地素材库；
- 角色卡数据库；
- 世界观数据库；
- 文件系统；
- 搜索工具；
- 写作风格库；
- 参考小说片段库；
- 编辑器插件；
- 后续的 Web UI。

### 10.2 必须实现的 MCP 规划

MVP 阶段至少实现 MCP manifest 和预留接口。

目录：

```text
src/novel_agent/mcp/
├── server.py
├── client.py
├── tools.py
└── manifest.py
```

### 10.3 MCP Server 至少暴露

```text
Tools:
- novel.project.load
- novel.context.build
- novel.chapter.read
- novel.chapter.write
- novel.memory.search
- novel.memory.update
- novel.review.run
- novel.export.markdown

Resources:
- novel://project/bible
- novel://project/characters
- novel://project/world
- novel://project/chapters
- novel://project/memory

Prompts:
- novel.write_chapter
- novel.review_chapter
- novel.revise_chapter
- novel.summarize_chapter
```

### 10.4 MCP 安全要求

MCP 工具默认只允许访问项目目录：

```text
projects/<project_name>/
```

禁止 MCP 工具读取：

```text
.env
.git/
系统用户目录
SSH Key
浏览器 Cookie
任意绝对路径
```

必须做路径归一化检查，防止：

```text
../../.env
```

---

## 11. LangGraph Agent Graph 强制设计

### 11.1 状态对象

必须定义 AgentState。

```python
class NovelAgentState(TypedDict):
    task_id: str
    project_dir: str
    user_request: str
    chapter_id: str | None

    system_prompt: str
    project_context: dict
    memory_context: dict
    retrieved_context: list[dict]
    token_budget_report: dict

    plan: dict | None
    draft: str | None
    critique: dict | None
    revision_plan: dict | None
    revised_draft: str | None

    tool_results: list[dict]
    errors: list[dict]
    needs_human_review: bool
    final_output_path: str | None
```

### 11.2 写章节 Graph

必须实现如下状态图。

```text
START
  ↓
load_project
  ↓
build_context
  ↓
plan_chapter
  ↓
write_draft
  ↓
self_critique
  ↓
needs_revision? ── no ──→ save_chapter
  │                         ↓
 yes                        update_memory
  ↓                         ↓
make_revision_plan          export_or_finish
  ↓                         ↓
revise_draft              END
  ↓
self_critique
```

### 11.3 审查失败处理

如果连续 2 次修订后仍不合格：

```text
needs_human_review = true
```

并输出：

```text
NEEDS_HUMAN_REVIEW
原因：xxx
建议人工检查：xxx
当前草稿路径：xxx
审查报告路径：xxx
```

禁止无限循环修订。

### 11.4 每个节点必须可单测

每个 graph node 必须是独立函数：

```python
def load_project(state: NovelAgentState) -> NovelAgentState: ...
def build_context(state: NovelAgentState) -> NovelAgentState: ...
def plan_chapter(state: NovelAgentState) -> NovelAgentState: ...
def write_draft(state: NovelAgentState) -> NovelAgentState: ...
def self_critique(state: NovelAgentState) -> NovelAgentState: ...
def revise_draft(state: NovelAgentState) -> NovelAgentState: ...
def save_chapter(state: NovelAgentState) -> NovelAgentState: ...
def update_memory(state: NovelAgentState) -> NovelAgentState: ...
```

禁止把完整流程写在一个函数里。

---

## 12. 自我反省层强制要求

### 12.1 反省不是一句“检查一下”

自我反省必须包含明确维度：

```text
1. 设定一致性
2. 人物性格一致性
3. 人物关系变化合理性
4. 剧情因果逻辑
5. 时间线一致性
6. 伏笔推进情况
7. 爽点 / 冲突 / 钩子
8. 文风一致性
9. 重复、废话、水字数
10. 下一章衔接能力
```

### 12.2 审查结果必须结构化

```python
class CritiqueResult(BaseModel):
    score: float
    pass_threshold: float = 8.0
    continuity_issues: list[Issue]
    character_issues: list[Issue]
    plot_issues: list[Issue]
    style_issues: list[Issue]
    pacing_issues: list[Issue]
    foreshadowing_issues: list[Issue]
    revision_required: bool
    revision_plan: list[RevisionAction]
```

### 12.3 强制修订逻辑

```text
如果 score >= 8.0 且 high priority issue 数量为 0：通过
否则：进入 revise_draft
最多修订 2 轮
仍不通过：标记 NEEDS_HUMAN_REVIEW
```

### 12.4 自我反省输出必须保存

```text
reviews/ch003.review.round1.json
reviews/ch003.revision_plan.round1.md
reviews/ch003.review.round2.json
```

---

## 13. CLI 层强制要求

### 13.1 必须实现的命令

```bash
novel-agent --help
novel-agent config doctor
novel-agent provider ping
novel-agent init <project_name>
novel-agent context build --chapter ch001 --task "写第一章"
novel-agent idea "一句话创意"
novel-agent outline generate
novel-agent chapter write ch001
novel-agent chapter review ch001
novel-agent chapter revise ch001
novel-agent memory update ch001
novel-agent export markdown
novel-agent test mock-flow
```

### 13.2 CLI 不能偷懒

每个命令必须：

- 有 help 文案；
- 有成功输出；
- 有失败输出；
- 有 exit code；
- 不吞异常；
- 不打印完整 Key；
- 不覆盖用户文件。

### 13.3 `provider ping` 是第一优先级

如果 API 都接不好，禁止继续做写作功能。

Codex CLI 执行顺序必须是：

```text
1. config doctor
2. provider ping with mock
3. provider ping with deepseek
4. test graph mock-flow
5. write example chapter with mock
6. write example chapter with deepseek
```

---

## 14. 小说项目文件规范

### 14.1 project.yaml

```yaml
project_name: example_novel
language: zh-CN
genre: 后宫 / 校园 / 奇幻 / 都市
rating: normal
style_profile: web_novel_fast_paced
chapter_target_words: 2500
revision_rounds: 2
pass_score: 8.0

model:
  provider: deepseek
  model: deepseek-chat
  temperature: 0.75

context:
  recent_chapters: 3
  max_context_tokens: 32000
```

### 14.2 style.md

必须明确：

```text
叙事视角：
节奏：
对白风格：
爽点密度：
心理描写比例：
战斗描写比例：
禁忌：
不要出现的套路：
读者预期：
```

### 14.3 characters.md

每个角色必须至少包含：

```text
姓名：
定位：
外貌：
性格核心：
欲望：
恐惧：
秘密：
与主角关系：
当前阶段：
不能违背的设定：
```

---

## 15. 测试层强制要求

### 15.1 Mock 测试必须先通过

没有 mock 测试，真实 API 联调没有意义。

必须至少有：

```bash
pytest tests/test_config.py
pytest tests/test_provider_mock.py
pytest tests/test_context_builder.py
pytest tests/test_memory.py
pytest tests/test_graph_flow.py
pytest tests/test_reflection.py
pytest tests/test_cli_smoke.py
```

### 15.2 API 测试隔离

真实 DeepSeek API 测试必须标记：

```python
@pytest.mark.integration
```

默认测试不跑真实 API。

运行方式：

```bash
pytest -m integration tests/test_provider_deepseek_ping.py
```

### 15.3 端到端验收

必须能跑：

```bash
novel-agent test mock-flow
```

预期输出：

```text
[OK] Loaded project
[OK] Built context
[OK] Planned chapter
[OK] Wrote draft
[OK] Ran critique
[OK] Revised draft
[OK] Saved chapter
[OK] Updated memory
[OK] Exported markdown
```

---

## 16. Codex CLI 强制执行顺序

Codex CLI 不允许自由发挥。

必须按以下顺序执行：

### Phase 1：项目体检

1. 列出当前项目结构。
2. 找出入口文件。
3. 找出现有 API 调用位置。
4. 找出现有 prompt 位置。
5. 找出现有读写文件逻辑。
6. 输出问题清单。

未完成项目体检，不得开始重构。

### Phase 2：配置和 Provider

1. 创建 `.env.example`。
2. 更新 `.gitignore`。
3. 实现 `config.py`。
4. 实现 `providers/base.py`。
5. 实现 `MockProvider`。
6. 实现 `OpenAICompatibleProvider`。
7. 实现 `DeepSeekProvider`。
8. 实现 `config doctor`。
9. 实现 `provider ping`。

此阶段必须优先解决 API 接不好的问题。

### Phase 3：项目上下文

1. 创建小说项目目录规范。
2. 实现 `ProjectLoader`。
3. 实现 `ContextBuilder`。
4. 实现 token budget report。
5. 实现 `context build` CLI。

### Phase 4：LangGraph 状态机

1. 定义 `NovelAgentState`。
2. 实现 graph nodes。
3. 实现 write chapter workflow。
4. 实现 checkpoint。
5. 实现 mock-flow 测试。

### Phase 5：自我反省和修订

1. 实现 Critique schema。
2. 实现 critique prompt。
3. 实现 revision plan。
4. 实现 revise node。
5. 实现最多 2 轮修订。
6. 实现 NEEDS_HUMAN_REVIEW。

### Phase 6：记忆落盘

1. 实现章节摘要。
2. 实现 continuity update。
3. 实现 foreshadowing update。
4. 实现 timeline update。
5. 实现 memory update CLI。

### Phase 7：MCP

1. 创建 MCP manifest。
2. 暴露基础 resources。
3. 暴露基础 tools。
4. 做路径安全限制。
5. 写 MCP smoke test。

### Phase 8：最终验收

1. 运行全部 mock 测试。
2. 运行 provider ping。
3. 用 DeepSeek 生成一章测试章节。
4. 检查审查报告。
5. 检查记忆更新。
6. 检查导出文件。
7. 输出最终交付报告。

---

## 17. Definition of Done

只有满足以下条件，才允许说“Agent 完成”。

```text
[ ] 有明确项目结构
[ ] 有 .env.example
[ ] .env 已加入 .gitignore
[ ] API Key 不会出现在日志
[ ] config doctor 可运行
[ ] provider ping 可运行
[ ] mock provider 可运行
[ ] DeepSeek provider 可运行
[ ] prompt 分层，不是单 prompt
[ ] 有 ProjectLoader
[ ] 有 ContextBuilder
[ ] 有 token budget report
[ ] 有长期记忆文件
[ ] 有短期状态
[ ] 有 LangGraph StateGraph
[ ] 有 write chapter workflow
[ ] 有 self critique
[ ] 有 revise workflow
[ ] 有最多 2 轮修订限制
[ ] 有 NEEDS_HUMAN_REVIEW
[ ] 有章节摘要落盘
[ ] 有伏笔状态更新
[ ] 有时间线更新
[ ] 有 MCP 预留或实现
[ ] 有 CLI help
[ ] 有 mock-flow 测试
[ ] 有真实 API ping 测试
[ ] 有端到端章节生成测试
[ ] 有交付报告
```

少一项，都不能算完整 Agent。

---

## 18. 给 Codex CLI 的强制提示词

复制下面这段给 Codex CLI。

```text
你现在接手的是一个小说 Agent 工程，不是一个五分钟脚本。

你必须先阅读 SPEC.md，然后严格按 Phase 1 到 Phase 8 执行。

禁止事项：
1. 禁止直接写一个 main.py 调 API 就结束。
2. 禁止把 API Key 写进源码。
3. 禁止跳过 config doctor。
4. 禁止跳过 provider ping。
5. 禁止跳过 mock provider。
6. 禁止跳过 LangGraph 状态机。
7. 禁止跳过 ContextBuilder。
8. 禁止跳过长期记忆。
9. 禁止跳过自我反省和修订。
10. 禁止没有测试就说完成。

你的第一步必须是项目体检：
- 列出当前目录结构；
- 找出现有入口文件；
- 找出现有 API 调用；
- 找出现有 prompt；
- 找出现有文件读写；
- 输出当前项目距离 SPEC 的缺口。

然后你必须先实现：
1. .env.example
2. .gitignore
3. config doctor
4. MockProvider
5. OpenAICompatibleProvider
6. DeepSeekProvider
7. provider ping

API 接通之前，不允许继续做写作功能。

每完成一个 Phase，你都必须输出：
- 修改文件列表；
- 新增命令；
- 测试命令；
- 测试结果；
- 未完成项。

如果某项做不了，必须明确说明原因，不能伪装完成。
```

---

## 19. 最小 MVP 但不能再低

如果时间有限，MVP 也必须包含：

```text
1. config doctor
2. provider ping
3. MockProvider
4. DeepSeekProvider
5. ProjectLoader
6. ContextBuilder
7. LangGraph write workflow
8. self critique
9. revise once
10. save chapter
11. update summary memory
12. CLI commands
13. mock-flow test
```

低于这个标准，不叫 Agent，只叫 API Demo。

---

## 20. 参考来源

- LangChain Agents Docs: https://docs.langchain.com/oss/python/langchain/agents
- LangGraph Overview: https://docs.langchain.com/oss/python/langgraph/overview
- LangGraph Agentic RAG: https://docs.langchain.com/oss/python/langgraph/agentic-rag
- LangChain Structured Output: https://docs.langchain.com/oss/python/langchain/structured-output
- LangChain Human-in-the-Loop: https://docs.langchain.com/oss/python/langchain/human-in-the-loop
- MCP Official Intro: https://modelcontextprotocol.io/docs/getting-started/intro
- MCP Server Concepts: https://modelcontextprotocol.io/docs/learn/server-concepts
- DeepSeek API Docs: https://api-docs.deepseek.com/

