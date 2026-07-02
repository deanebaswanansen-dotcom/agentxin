# Implementation Plan: 章节蓝图与分场景写作模块（Chapter Blueprint Module）

## Overview

本实现计划由 requirements.md 与 design.md 派生，是对既有 novel-writing-agent（TypeScript 全栈：Fastify 后端 + React 前端 + 文件型 `FileDataStore`）的扩展。实现顺序遵循自底向上、逐步集成、无悬挂代码的原则：

1. 新增共享数据模型/类型（蓝图、场景、报告、请求体）。
2. 扩展 `DataStore` 接口与 `FileDataStore` 实现（新增四个集合 + 替换/upsert 语义 + 级联删除 + 启动容错恢复）。
3. 实现纯逻辑模块（解析、序列化、结构校验、字数统计、字数报告、合并、提示词组装）——属性测试主要对象。
4. 在纯逻辑之上实现领域服务编排（蓝图生成、分场景写作、整章生成、合并、字数检查、节奏检查、扩写、重写）。
5. 通过 Fastify 路由暴露 REST + SSE 接口，复用既有统一错误映射与已修复的 SSE 模式。
6. 实现前端 `ChapterBlueprintPanel` 及子组件、扩展 `apiClient`，最终接线为可运行整体。

属性测试使用 `fast-check`，覆盖 design.md 的全部 18 条 Correctness Properties；每条属性为独立子任务，标注属性编号与所验证的需求条款。带 `*` 的子任务为可选测试任务，可在追求 MVP 速度时跳过；核心实现任务不可跳过。测试标签格式：**Feature: chapter-blueprint, Property {number}: {property_text}**。

复用约定：模型调用统一经既有 `ModelProxy.streamCompletion` 与 `ModelConfigService.getInternalConfig`；SSE 路由沿用 `writingRoutes.ts` 中已修复的关键点（监听 `reply.raw` 的 `'close'` 事件 + `writableEnded` 守卫 + 统一 `ApiError` 经 `event: error` 转发）；错误码沿用既有枚举与 `errorMapping.ts`。

## Tasks

- [x] 1. 新增共享数据模型与类型
  - [x] 1.1 定义蓝图模块类型
    - 在 `backend/src/types/index.ts` 新增 `Scene`、`ChapterBlueprint`、`BlueprintCore`、`SceneDraft`
    - 新增 `SceneWordCount`、`WordCountReport`、`PlotPointStatus`、`PlotPointResult`、`PacingPriority`、`ScenePacingIssue`、`PacingReport`
    - 新增请求体类型 `GenerateBlueprintBody`、`ExpandSceneBody`、`RewriteSceneBody`
    - 在 `frontend/src/types/index.ts` 同步保持字节一致的副本
    - _Requirements: 2.3, 2.4, 9.2, 10.2, 10.4, 1.1, 11.1, 12.1_

- [x] 2. 扩展 DataStore 持久化层
  - [x] 2.1 扩展 DataStore 接口
    - 在 `backend/src/store/DataStore.ts` 新增蓝图/场景正文/字数报告/节奏报告的读写方法（按 design.md「DataStore 扩展」清单）
    - _Requirements: 5.1, 5.2, 6.5, 9.4, 10.5, 13.1_

  - [x] 2.2 实现 FileDataStore 蓝图与场景正文存储
    - `FileDataStoreState` 新增 `chapterBlueprints`、`sceneDrafts` 数组；`normalizeState` 对缺失字段容错初始化为空数组（向后兼容旧 store.json）
    - 实现 `saveChapterBlueprint`（按 chapter_id 替换，仅保留一份）、`getChapterBlueprintByChapter`
    - 实现 `saveSceneDraft`（按 (blueprintId, scene_id) upsert）、`getSceneDraft`、`listSceneDrafts`（按 scene_id 升序）
    - 写操作返回前完成原子持久化；失败抛 `StoreError`
    - _Requirements: 5.1, 5.2, 5.3, 6.5, 11.5, 12.3, 13.1_

  - [x] 2.3 实现 FileDataStore 检查报告存储
    - `FileDataStoreState` 新增 `wordCountReports`、`pacingReports` 数组，含容错初始化
    - 实现 `saveWordCountReport`/`getWordCountReportByChapter`、`savePacingReport`/`getPacingReportByChapter`（按 chapter_id 替换最新一份）
    - _Requirements: 9.4, 10.5, 13.1, 13.3_

  - [x] 2.4 扩展级联删除
    - 扩展 `deleteChapter`（按 chapter_id）与 `deleteProject`（按 projectId）清除关联的蓝图、场景正文、字数报告、节奏报告
    - _Requirements: 13.4_

  - [x]* 2.5 编写删除级联清除属性测试
    - **Property 15: 删除级联清除关联蓝图数据**
    - **Validates: Requirements 13.4**

  - [x]* 2.6 编写重启恢复属性测试
    - **Property 16: 重启后从存储恢复蓝图模块数据**
    - **Validates: Requirements 13.2**

  - [x]* 2.7 编写蓝图持久化替换与读回往返属性测试
    - **Property 13: 蓝图持久化替换与读回往返**
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [x]* 2.8 编写场景正文写入仅影响目标场景属性测试
    - **Property 14: 场景正文写入仅影响目标场景**
    - **Validates: Requirements 11.5, 12.3**

- [x] 3. 实现蓝图解析与序列化（纯逻辑）
  - [x] 3.1 实现 serializeBlueprint 与 parseBlueprintFromText
    - `serializeBlueprint(core)` 将 `BlueprintCore` 序列化为 JSON 文本
    - `parseBlueprintFromText(text)` 扫描首个平衡 JSON 对象（跳过字符串内花括号）并解析；无合法 JSON 抛 `VALIDATION_ERROR`；缺字段抛 `VALIDATION_ERROR` 描述缺失字段
    - _Requirements: 3.1, 3.2, 3.4, 3.5_

  - [x]* 3.2 编写序列化-解析往返属性测试
    - **Property 1: 蓝图序列化-解析往返**
    - **Validates: Requirements 3.2, 3.3**

  - [x]* 3.3 编写夹带文字提取属性测试
    - **Property 2: 从夹带文字的文本中提取蓝图**
    - **Validates: Requirements 3.1**

  - [x]* 3.4 编写非法 JSON 解析报错属性测试
    - **Property 3: 非法 JSON 文本解析报错**
    - **Validates: Requirements 3.4**

  - [x]* 3.5 编写缺失字段解析报错属性测试
    - **Property 4: 缺失字段解析报错**
    - **Validates: Requirements 3.5**

- [x] 4. 实现蓝图结构校验（纯逻辑）
  - [x] 4.1 实现 deviationRatio 与 validateBlueprint
    - `deviationRatio(core)` = `|Σ场景 target_words − 章节 target_words| / 章节 target_words`
    - `validateBlueprint(core)`：场景数 <3 或 >7、偏差比例严格 >0.1、重复 scene_id、非正整数 target_words 各自抛对应 `VALIDATION_ERROR`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x]* 4.2 编写场景数量越界校验属性测试
    - **Property 5: 场景数量越界校验**
    - **Validates: Requirements 4.2**

  - [x]* 4.3 编写字数分配偏差校验属性测试
    - **Property 6: 字数分配偏差校验**
    - **Validates: Requirements 4.1, 4.3**

  - [x]* 4.4 编写重复 scene_id 校验属性测试
    - **Property 7: 重复 scene_id 校验**
    - **Validates: Requirements 4.4**

  - [x]* 4.5 编写非正整数字数校验属性测试
    - **Property 8: 非正整数字数校验**
    - **Validates: Requirements 4.5**

- [x] 5. 实现字数统计与合并（纯逻辑）
  - [x] 5.1 实现 countActualWords、buildWordCountReport 与 mergeScenes
    - `countActualWords(text)` = 去除全部空白字符后剩余字符数
    - `buildWordCountReport(core, draftsBySceneId)` 计算每场景实际字数/差值/needsExpansion（不足比例 ≥0.15）/suggestedExpansion，及整章实际字数/差值
    - `mergeScenes(orderedDrafts)` 按 scene_id 升序以双换行拼接
    - _Requirements: 9.1, 9.2, 9.3, 7.3, 8.2_

  - [x]* 5.2 编写实际字数统计属性测试
    - **Property 9: 实际字数等于去空白字符数**
    - **Validates: Requirements 9.1**

  - [x]* 5.3 编写扩写建议触发属性测试
    - **Property 10: 扩写建议触发与建议字数**
    - **Validates: Requirements 9.2, 9.3**

  - [x]* 5.4 编写整章实际字数属性测试
    - **Property 11: 整章实际字数等于各场景合并后的实际字数**
    - **Validates: Requirements 9.1, 9.2**

  - [x]* 5.5 编写合并升序拼接属性测试
    - **Property 12: 章节合并为 scene_id 升序拼接**
    - **Validates: Requirements 7.3, 8.2**

- [x] 6. 实现提示词组装（纯逻辑）
  - [x] 6.1 实现 buildBlueprintPrompt / buildScenePrompt / buildExpandPrompt / buildRewritePrompt
    - 仿照既有 `buildPromptMessages` 返回 `ChatMessage[]`
    - 蓝图生成：纳入大纲/人物/世界观 + 章节需求 + 目标字数，要求输出符合 2.3/2.4 字段的 JSON
    - 场景写作：纳入场景 target_words/purpose/must_include/ending_state + 出场角色设定 +（若有）上一场景正文
    - 扩写：当前正文 + 蓝图约束 + 保留剧情/不新增设定 + 目标实际字数 = 当前 + 扩写字数
    - 重写：当前正文 + 蓝图约束 + 用户修改要求 + 保留 purpose/must_include 与衔接
    - _Requirements: 2.1, 2.2, 6.1, 6.2, 6.3, 11.4, 12.1, 12.2_

  - [x]* 6.2 编写场景写作提示词内容属性测试
    - **Property 17: 字数检查上下文包含蓝图与正文约束（提示词组装）**
    - **Validates: Requirements 6.1, 6.2, 6.3**

- [x] 7. 实现 BlueprintService（蓝图生成编排）
  - [x] 7.1 实现 BlueprintService.generate 与 getByChapter
    - generate 顺序：校验请求体（目标字数 100–100000、需求文本 1–5000 非空、字段齐全）→ 模型配置检查（缺失 MODEL_NOT_CONFIGURED 且不调用代理）→ 章节存在性（NOT_FOUND）→ 读取大纲/人物/世界观（缺类空集合）→ buildBlueprintPrompt → 经 ModelProxy 收集完整文本 → parseBlueprintFromText → validateBlueprint → saveChapterBlueprint
    - getByChapter：章节不存在或无蓝图均返回 NOT_FOUND
    - 模型错误/超时映射 PROVIDER_ERROR；解析失败映射 VALIDATION_ERROR
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1, 2.2, 2.5, 2.6, 3.1, 4.x, 5.1, 5.2, 5.3, 5.4, 5.6, 15.1, 15.2_

  - [x]* 7.2 编写 BlueprintService 单元测试
    - 用 mock 提供商验证生成编排顺序与各错误条件（未配置模型、章节不存在、解析失败、校验失败）
    - 对返回结果做 API Key 原文子串检查（需求 15.3）
    - _Requirements: 2.5, 2.6, 5.4, 5.6, 15.3_

- [x] 8. 实现分场景写作与整章生成（编排）
  - [x] 8.1 实现 SceneWriter（流式单场景）
    - streamScene 顺序：模型配置检查（MODEL_NOT_CONFIGURED 先于代理）→ 读取蓝图与目标场景（NOT_FOUND）→ 解析出场角色设定 + 上一场景已存正文 → buildScenePrompt → 返回增量流
    - 提供 finalizeDraft：累加增量、流正常结束后持久化完整场景正文；中途失败不持久化
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [x] 8.2 实现 ChapterMerger
    - merge：读取蓝图全部已存场景正文；存在缺正文场景抛 VALIDATION_ERROR 且不改 Chapter.content；否则 mergeScenes → updateChapterContent；章节无蓝图 NOT_FOUND
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 8.3 实现 ChapterWriter（整章生成）
    - 模型配置检查（7.5）→ 读取蓝图 → 按 scene_id 升序复用 SceneWriter 逐场景生成并在进入下一场景前持久化（7.1, 7.2）→ 全部完成调用 ChapterMerger（7.3）→ 某场景失败停止后续并保留已写场景，抛 PROVIDER_ERROR（7.4）
    - 以事件序列暴露（scene/delta）供 SSE 路由转发
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x]* 8.4 编写缺正文场景阻止合并属性测试
    - **Property 18: 缺正文场景阻止合并**
    - **Validates: Requirements 8.4**

  - [x]* 8.5 编写分场景写作与整章生成集成测试
    - mock 提供商验证：单场景流式拼接与收尾持久化、中途失败不持久化、整章按序生成与失败保留
    - _Requirements: 6.5, 6.8, 7.2, 7.4_

- [x] 9. 实现字数检查、节奏检查、扩写与重写（编排）
  - [x] 9.1 实现 WordCountChecker
    - 读取蓝图与各场景正文 → buildWordCountReport → 注入元数据 → saveWordCountReport；章节无蓝图 NOT_FOUND；不调用模型
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 9.2 实现 PacingChecker
    - 模型配置检查（10.6）→ 读取蓝图与整章正文 → buildPacingPrompt（pacing/emotional_curve/required_plot_points/forbidden_points）→ 收集完整文本 → 解析为 PacingReport（剧情点状态、被违反禁止项、按场景问题/建议/优先级 高/中/低）→ savePacingReport
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [x] 9.3 实现 SceneExpander
    - 校验 expandWords 1–100000 正整数（11.2）→ 模型配置检查（11.8）→ 场景存在性（11.6）→ 目标场景已有正文否则提示未写作（11.7）→ buildExpandPrompt → 流式生成 → 仅覆盖目标场景正文（11.5）
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8_

  - [x] 9.4 实现 SceneRewriter
    - 校验 instruction 非空（12.5）→ 模型配置检查（12.7）→ 场景存在性（12.4）→ 目标场景已有正文否则提示未写作（12.6）→ buildRewritePrompt → 流式生成 → 仅覆盖目标场景正文（12.3）
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7_

  - [x]* 9.5 编写检查/扩写/重写单元测试
    - 验证字数报告统计与持久化、节奏报告解析、扩写/重写各错误条件与「仅改目标场景」
    - _Requirements: 9.4, 10.5, 11.5, 11.7, 12.3, 12.6_

- [x] 10. 检查点 - 确保领域层与纯逻辑测试通过
  - 运行后端单元测试与属性测试，确保通过；如有疑问请询问用户。

- [x] 11. 实现 Fastify 路由（传输层 + SSE）
  - [x] 11.1 实现蓝图 REST 路由
    - `POST /api/projects/:id/chapters/:chapterId/blueprint`（生成）、`GET /api/chapters/:chapterId/blueprint`（读取）
    - 经 `toErrorResponse` 统一错误映射
    - _Requirements: 1.x, 2.x, 3.x, 4.x, 5.1, 5.2, 5.3, 5.4, 5.6_

  - [x] 11.2 实现合并与检查 REST 路由
    - `POST /api/chapters/:chapterId/merge`、`POST /api/chapters/:chapterId/word-count-check`、`GET /api/chapters/:chapterId/word-count-report`、`POST /api/chapters/:chapterId/pacing-check`、`GET /api/chapters/:chapterId/pacing-report`
    - _Requirements: 8.x, 9.x, 10.x, 13.3, 13.5_

  - [x] 11.3 实现场景写作/扩写/重写/整章生成 SSE 路由
    - `POST /api/chapters/:chapterId/scenes/:sceneId/write`、`.../expand`、`.../rewrite`、`POST /api/chapters/:chapterId/generate`
    - 严格沿用既有 SSE 模式：reply.hijack + reply.raw close 监听 + writableEnded 守卫 + event: delta/done/error；整章生成额外 event: scene
    - 流正常结束后由编排持久化完整正文；中途 error 不持久化
    - _Requirements: 6.x, 7.x, 11.x, 12.x, 14.3_

  - [x]* 11.4 编写路由集成测试
    - 验证 REST/SSE 端点、错误状态映射、SSE 帧协议与 reply.raw close 行为
    - _Requirements: 5.4, 6.6, 8.4, 9.4, 10.5, 11.6, 12.4, 13.5_

- [x] 12. 实现前端组件
  - [x] 12.1 扩展 apiClient
    - 新增 `blueprint.generate/get`、`scenes.write/expand/rewrite`（SSE，复用既有 streamWrite 的解析，识别 event: scene）、`chapters.merge`、`reports.wordCountCheck/getWordCount/pacingCheck/getPacing`
    - _Requirements: 14.3, 14.4, 7.2_

  - [x] 12.2 实现 ChapterBlueprintPanel 与 BlueprintForm
    - 打开时 GET 蓝图；NOT_FOUND 展示空状态（14.7）；否则展示蓝图与场景列表（14.1）
    - BlueprintForm：需求文本 + 目标字数输入；文本空或字数不在 100–100000 时禁用生成按钮（14.2）
    - _Requirements: 14.1, 14.2, 14.7_

  - [x] 12.3 实现 SceneList 与 SceneStreamView
    - SceneList 渲染场景及「写作/扩写/重写」操作与是否已有正文
    - SceneStreamView 复用既有 ChatPanel 流式渲染，随 event: delta 增量追加直至 done（14.3）
    - _Requirements: 14.3_

  - [x] 12.4 实现 ReportView 与 MergedChapterView
    - ReportView 展示字数报告与节奏报告（14.4）
    - MergedChapterView 触发合并、预览整章、提供「采用」写入 ChapterEditor（14.5）
    - 错误统一经既有 ErrorToast 展示（14.6）
    - _Requirements: 14.4, 14.5, 14.6_

  - [x]* 12.5 编写前端组件单元测试
    - 覆盖空状态、表单禁用条件、流式追加渲染、报告展示与错误展示
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.6, 14.7_

- [x] 13. 集成与接线
  - [x] 13.1 接线后端服务
    - 在 Fastify 入口实例化各蓝图服务（复用既有 store/ModelConfigService/ModelProxy），注册全部蓝图路由
    - _Requirements: 13.1, 15.1, 15.2_

  - [x] 13.2 接线前端
    - 在 ProjectWorkspaceView 的章节工作区挂载 ChapterBlueprintPanel，使蓝图→场景→写作→合并→采用流程贯通
    - _Requirements: 14.1, 14.5_

  - [x]* 13.3 编写端到端集成测试
    - mock 提供商验证：生成蓝图→分场景写作→合并→字数检查→扩写→采用整章的完整流程
    - _Requirements: 5.1, 6.5, 7.3, 8.3, 9.4, 14.5_

- [x] 14. 最终检查点 - 确保全部测试通过
  - 运行前后端全部测试，确保通过；如有疑问请询问用户。

## Notes

- 标记 `*` 的子任务为可选测试任务（单元/属性/集成测试），可在追求 MVP 速度时跳过；核心实现任务不可跳过。
- 每个任务引用具体需求条款，便于追溯；18 条属性各自映射到独立子任务并标注属性编号与所验证需求。
- 阶段对应：阶段一（最小可用）= 任务 1–8、11.1、11.3、12.1–12.3、13；阶段二（可控写作）= 9.1、9.3、9.4、11.2 中字数/合并、12.4；阶段三（质量检查）= 9.2、节奏检查相关路由与展示。
- 属性测试使用 `fast-check`，每条至少运行 100 次迭代，生成器需覆盖特殊字符、空白、Unicode、空集合、较长字符串与数值边界（0/负数/非整数/边界比例）。
- 安全要求：模型调用统一经 ModelProxy 注入 Authorization；蓝图/场景正文/报告返回前端的数据均不含 API Key 原文（属性/单元测试需做原文子串检查）。
- 复用既有已修复模式：SSE 路由监听 `reply.raw` 的 `'close'`（非 `request.raw`）并以 `writableEnded` 守卫，避免请求体读完即误判客户端断开。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "5.1", "6.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2", "3.3", "3.4", "3.5", "4.2", "4.3", "4.4", "4.5", "5.2", "5.3", "5.4", "5.5", "6.2"] },
    { "id": 3, "tasks": ["2.4", "7.1", "8.1", "8.2", "9.1"] },
    { "id": 4, "tasks": ["2.5", "2.6", "2.7", "2.8", "7.2", "8.3", "9.2", "9.3", "9.4"] },
    { "id": 5, "tasks": ["8.4", "8.5", "9.5", "11.1", "11.2", "11.3", "12.1"] },
    { "id": 6, "tasks": ["10", "11.4", "12.2", "12.3", "12.4"] },
    { "id": 7, "tasks": ["12.5", "13.1", "13.2"] },
    { "id": 8, "tasks": ["13.3"] },
    { "id": 9, "tasks": ["14"] }
  ]
}
```
