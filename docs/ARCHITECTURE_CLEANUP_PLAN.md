# 写作引擎收敛与架构清理计划

> 状态：草案，待评审。
> 范围：只处理"写小说"链路的架构问题；不涉及 UX-BUG-REPORT、百万字多 Agent 规格、Netlify 后台函数。

## 1. 现状（三条互相矛盾的引擎叙事）

1. **Web 工作台（真正的产品）**：完整跑在 TS 引擎上——`AgentOrchestrator`（3627 行）编排蓝图/场景/合并/审校/修订/记忆，质量 Gate、伏笔台账、断点续传都在这套里，线上已多次迭代稳定。
2. **Python LangGraph 引擎（`src/novel_agent/`）**：自有一套 supervisor、write-chapter/blueprint-chapter workflow、记忆、反思、MCP。`PythonBridge.ts` 和 `USE_PYTHON_CORE=1` 是唯二入口，但：
   - 前端只出现 `plan_blueprint`/`write_scene`/`write_chapter_from_blueprint` 三个任务的名字和描述，**没有任何组件派发它们**；
   - `BlueprintService` 的 Python 分支默认关闭；
   - `start.bat` 只装 Node，普通用户机器上根本没有 Python 运行时。
3. **文档与 CLI**：`Agent_Refactoring_Spec.md`、`backend/src/cli/main.ts`、`PythonBridge.ts` 注释都声称"Node 是薄层、Python 是单一真相源"，与事实相反。

### 关键问题清单

| # | 问题 | 影响 |
| --- | --- | --- |
| P1 | `src/novel_agent/config.py` 从 `backend/data/store.json` 读 `modelConfig.apiKey`，也从 `.env` 读 `LLM_API_KEY` | 违反"API Key 只在浏览器"的核心安全约束；密钥会持久化到磁盘 |
| P2 | 双引擎全量重复：蓝图/场景/合并/审校/记忆/伏笔/两套 prompts、两套检查点 | 维护成本翻倍，行为分叉 |
| P3 | `runPythonDelegated` 半成品：忽略 `signal` 与 options，`projectId` 用 `'unknown'` 兜底，Python 结果不落 store | 即使调通也是死路 |
| P4 | `AgentOrchestrator` 上帝类：编排、prompt 组装、markdown 解析、中文数字转换、记忆播种混在一起 | 难以定位问题、难以并行开发 |
| P5 | 记忆注入是固定窗口（facts 取最近 24 条 + 16k 字符），CanonLock 无自动注册入口 | 长篇后期早期核心设定可能被挤出窗口，一致性检查有盲区 |

## 2. 目标

1. 写作链路收敛为**单一引擎（TS）**，消除密钥读盘旁路。
2. `AgentOrchestrator` 拆分到可单测、可独立修改的模块，行为不变。
3. 记忆/一致性机制补上 CanonLock 自动注册和核心事实常驻。
4. 文档与代码叙事一致。

## 3. 决策点（需确认后再动工）

**D1：Python 引擎去留**

- **方案 A（推荐）：退役 Python 引擎。**
  - 先打归档 tag（`archive/python-langgraph-engine`）再删除 `src/novel_agent/`、`PythonBridge.ts`、`web_bridge` 调用点、`pyproject.toml` 和 Python 测试。
  - 理由：产品是 Web；TS 引擎是唯一经过线上验证的实现；Python 路径带密钥读盘隐患；维护两套记忆/检查点没有收益。
- **方案 B：保留为"实验性 CLI 辅助"，与 Web 完全隔离。**
  - 删除 `PythonBridge.ts` 及 Node 内所有调用；`config.py` 移除 `load_backend_model_config`（禁止读 store.json），密钥只从 env 注入；文档降级为"实验，不在部署路径上"。
  - 代价：继续背两套 prompts/记忆的维护成本。
- 方案 C（不推荐）：维持现状。密钥隐患和死代码继续存在。

**D2：三个 Python 任务的前端入口**
- 方案 A 下：从 `TASK_MODES`、`agentTasks.ts`、`AgentCommandCenter.tsx`、`types/index.ts` 中移除三个任务；TS 蓝图能力已由 `/计划` 蓝图表单和 `long_novel` 链路覆盖，无需替代品。
- 方案 B 下：前端同样移除（Web 不暴露 Python 路径），保留 CLI。

## 4. 分阶段执行

### 阶段 0：基线（先冻结可回滚点）

1. 确认工作区干净，打基线 tag：`git tag baseline/pre-cleanup`。
2. 全量跑绿并记录：`backend: typecheck + test + build`；`frontend: typecheck + test + build`。
3. 确认线上部署（阿里云）未设置 `USE_PYTHON_CORE`、systemd 服务不依赖 Python。

**验收**：基线测试结果存档；任何后续阶段的回滚锚点。

### 阶段 1：切断 Python 旁路（安全优先，行为不变）

按 D1 决策执行：

1. 移除 `AgentOrchestrator.runPythonDelegated` 及三个 `case` 分支。
2. 移除 `BlueprintService` 中 `USE_PYTHON_CORE === '1'` 分支。
3. 删除 `PythonBridge.ts`（或按方案 B 保留 Python 代码但删除 Node 调用）。
4. 按 D2 清理前端三个死任务（类型、任务描述、命令中心文案）。
5. 方案 A 额外：归档并删除 `src/novel_agent/`、`tests/`（Python 部分）、`pyproject.toml`；`backend/src/cli/main.ts` 中"Python 是主入口"的注释改回现实描述。
6. 全量测试 + grep 验证：仓库内无 `PythonBridge`、`USE_PYTHON_CORE`、`web_bridge` 引用；`store.json` 读取密钥的代码随 `config.py` 一并移除（方案 B 则修改 config）。

**验收**：
- `grep -r "pythonBridge\|USE_PYTHON_CORE\|web_bridge"` 命中为 0（或仅剩归档分支）；
- 前后端全量测试绿；Web 手动冒烟：新建项目 → `/计划` → 长篇生成一批章节。

### 阶段 2：拆分 AgentOrchestrator（每步一个提交，测试先行）

拆出的模块放在 `backend/src/services/agent/` 下，原测试随函数迁移：

1. **`text/markdownParsers.ts`**：`parseChapterHeading`、`chineseNumeralToNumber`、`parseCharacterProfiles`、`extractChapterOutfitPlan`、`parseReflection`、`normalizeControlOutlineChunk`、`buildControlOutlineFromPlan`、`fallbackChapterAnchor` —— 全部已是纯函数，原样搬 + re-export 兼容。
2. **`prompts/chapterPrompts.ts`**：`buildChapterBlueprintRequirement`、`generateChapterWithMemory` 的 system prompt 组装、`generateControlOutlineChunk` prompt、修订 prompt —— 抽成纯函数，property test 验证输入输出格式（编号、字数、截断预算）。
3. **`plan/PackPlanner.ts`**：`generatePack`、`loadExistingPack`、`ensureFullNovelControlOutline`、`adoptPlanMaterials`、`persistGeneratedCharacters`、`promoteLegacyCharacterRecords`、`ensureChapterOutfitPlan`、`seedProjectMemory`/`seedMemoryFromPack`/`seedMemoryFromPlan` —— 依赖注入 store/memory/modelProxy。
4. **`longNovel/ChapterLoop.ts`**：章节 for 循环状态机（批量裁剪、检查点复用、写章、Gate、审校、修订、反思、硬冲突停机的完整循环），依赖 ChapterLoop 所需的 port 接口。
5. `AgentOrchestrator` 瘦身为路由 + 短任务（onboard/polish/diagnostic/idea skills）+ 指标统计。

**验收**：每步后 `npm test` + `npm run typecheck` 绿；`AgentOrchestrator` 最终 < 900 行；现有 property tests 全数通过；Web 冒烟行为与阶段 0 基线一致。

### 阶段 3：记忆与一致性增强（每个增强独立提交）

1. **CanonLock 自动注册**：
   - `reflectAndRemember` 时允许反思 JSON 新增 `canonLocks: [{keyword, introducedBy, note}]`，写入记忆；
   - `seedMemoryFromPack`/`recordFacts` 对 world/character 类事实自动提取高频特征词生成锁（数量上限 20，去噪）。
2. **核心事实常驻**：记忆新增 pinned 标记（seed 阶段写入的事实）；`buildContext` 改为"pinned 事实优先 + 滚动近期事实"填充 16k 预算，pinned 永不因窗口滚动被挤出。
3. （可选）**修订仲裁第二判据**：除字数距离外，增加"章末钩子 Gate 不劣化"条件，避免为保字数牺牲钩子。

**验收**：`MemoryService` / `qualityGates` / orchestrator 相关测试扩展覆盖新行为；property test 验证 pinned 不挤出。

### 阶段 4：文档收敛

1. 重写 `Agent_Refactoring_Spec.md` → 标注"已被本计划取代"或按新架构改写。
2. `PROJECT_HANDBOOK.md`、`README.md`：删除"Python 单一真相源"表述，CLI 章节按 D1 结果更新。
3. `spec/` 下与 Python 引擎强绑定的规格文件加"现状说明"头注。
4. 更新 `.env.example`（如涉及）。

**验收**：文档 grep 无"单一真相源/Python 核心"等过时断言；新手按 README 能跑通全链路。

## 5. 风险与回滚

| 风险 | 对策 |
| --- | --- |
| 删除 Python 后有人依赖 CLI 工作流 | D1 是显式决策点；归档 tag 保证随时可恢复；方案 B 是保险丝 |
| 拆分引入行为回归 | 每步一个提交 + 全量测试 + 阶段 0 冒烟基线对比 |
| 线上正在用 `USE_PYTHON_CORE` | 阶段 0 显式确认线上环境变量，否则不进入阶段 1 |
| CanonLock 自动注册误报导致误停 | 自动锁只进 structural checks（soft），模型审校才可能 hard；先上量上限与去噪规则 |

## 6. 提交与时间估计

- 阶段 0：1 个提交（tag）；~0.5h
- 阶段 1：2–3 个提交；~2h
- 阶段 2：4–5 个提交（每模块一个）；~4h
- 阶段 3：2–3 个提交；~3h
- 阶段 4：1–2 个提交；~1h

每个阶段独立可合、可回滚；阶段 1 完成后即可安全停在任何后续阶段。

## 7. 明确不做（本次范围外）

- UX-BUG-REPORT 中的交互问题
- `spec/million_word_multi_agent_*` 的多 Agent 演进
- Netlify Background Functions 改进
- 新增登录/账号体系
