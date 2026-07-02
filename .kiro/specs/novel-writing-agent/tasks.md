# Implementation Plan: AI 小说创作工作台（Novel Writing Agent）

## Overview

本实现计划由需求文档（requirements.md）与设计文档（design.md）派生，采用 TypeScript 全栈：React 前端 + Node.js（Fastify）后端，文件型 `DataStore` 持久化。实现顺序遵循自底向上、逐步集成、无悬挂代码的原则：

1. 搭建前后端项目结构与共享数据模型/类型。
2. 实现文件型持久化层 `DataStore`（原子写入 + 启动恢复 + 级联删除）。
3. 在持久化层之上实现领域服务（项目、章节、设定、模型配置）。
4. 实现写作上下文组装（纯函数 `buildPromptMessages`）与 OpenAI 兼容模型代理（`ModelProxy`，SSE 流式转发）。
5. 通过 Fastify 路由暴露 REST + SSE 接口，并完成统一错误码到 HTTP 状态映射。
6. 实现 React 前端组件、文本采用纯函数与流式写作面板，最终将前后端接线为可运行整体。

属性测试使用 `fast-check`，覆盖设计文档中的全部 24 条 Correctness Properties；每条属性为独立子任务，标注属性编号与所验证的需求条款。带 `*` 的子任务为可选测试任务，可在追求 MVP 速度时跳过；核心实现任务不可跳过。

## Tasks

- [x] 1. 搭建项目结构与共享类型
  - [x] 1.1 初始化前后端项目结构与工具链
    - 创建 `backend/`（Fastify + TypeScript）与 `frontend/`（React + TypeScript + Vite）目录结构
    - 配置 TypeScript、构建/类型检查脚本与测试框架（前后端均接入 Vitest）
    - 安装并配置属性测试库 `fast-check`（前后端均可用）
    - _Requirements: 8.1_

  - [x] 1.2 定义共享数据模型与类型
    - 定义 `Project`、`Chapter`、`Character`、`WorldSetting`、`Outline`、`ModelConfig`、`ModelConfigView`
    - 定义写作相关类型 `WritingRequestBody`、`ChatTurn`、`ChatMessage`、`SettingSnippet`、`WritingContextInput`
    - 定义统一错误结构 `ApiError` 与错误码枚举（`VALIDATION_ERROR`、`NOT_FOUND`、`MODEL_NOT_CONFIGURED`、`PROVIDER_ERROR`、`STORE_ERROR`）
    - 后端 `backend/src/types` 为规范来源，前端 `frontend/src/types` 保持同步副本
    - _Requirements: 1.1, 2.1, 3.1, 4.1, 5.5, 6.1_

- [x] 2. 实现 DataStore 持久化层
  - [x] 2.1 定义 DataStore 接口与存储错误类型
    - 按设计声明 `DataStore` 接口（项目、章节、设定、模型配置的全部方法）
    - 定义 `StoreError`，供读写失败时抛出
    - _Requirements: 7.1, 7.4_

  - [x] 2.2 实现 FileDataStore 存储引擎（原子写入 + 启动加载 + 项目操作）
    - 实现单文件 JSON 存储结构 `{ projects, chapters, characters, worldSettings, outlines, modelConfig }`
    - 实现"写临时文件 + rename 原子替换"写入策略；启动时加载文件，缺失则初始化空结构
    - 实现项目 CRUD：创建（生成 UUID v4）、列表、读取、重命名、删除（级联清除关联章节/人物/世界观/大纲）
    - 读写失败抛出 `StoreError`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 7.1, 7.2, 7.3, 7.4_

  - [x] 2.3 实现 FileDataStore 章节存储操作
    - 实现章节创建、按 `position` 升序列表、读取、更新正文、删除
    - 实现 `reorderChapters` 按提供的标识符顺序更新 `position`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 2.4 实现 FileDataStore 设定与模型配置存储操作
    - 实现人物、世界观、大纲条目的创建、列表、更新、删除
    - 实现模型配置的保存（单例）与读取
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.3_

  - [x]* 2.5 编写重启恢复属性测试
    - **Property 24: 重启后从存储恢复全部数据**
    - **Validates: Requirements 7.3**
    - 基于同一持久化文件重新构造 FileDataStore，断言读回数据与写入前一致（项目及全部关联实体）

- [x] 3. 实现 ProjectService（项目领域逻辑）
  - [x] 3.1 实现 ProjectService
    - 创建项目时校验名称非空（仅空白视为空）→ 否则返回 `VALIDATION_ERROR`
    - 提供列表、重命名、级联删除；标识符不存在时返回 `NOT_FOUND`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x]* 3.2 编写项目创建-读回往返与唯一性属性测试
    - **Property 1: 项目创建-读回往返与唯一性**
    - **Validates: Requirements 1.1, 1.2**

  - [x]* 3.3 编写删除项目级联清除属性测试
    - **Property 2: 删除项目级联清除全部关联实体**
    - **Validates: Requirements 1.3**

  - [x]* 3.4 编写项目重命名往返属性测试
    - **Property 3: 项目重命名往返**
    - **Validates: Requirements 1.4**

  - [x]* 3.5 编写空名称创建被拒绝属性测试
    - **Property 4: 空名称创建被拒绝且状态不变**
    - **Validates: Requirements 1.5**

- [x] 4. 实现 ChapterService（章节领域逻辑）
  - [x] 4.1 实现 ChapterService
    - 创建章节（非空标题）、列表（按 position 升序）、更新正文、删除、排序
    - 标识符不存在时返回 `NOT_FOUND`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x]* 4.2 编写章节创建-读回往返与唯一性属性测试
    - **Property 6: 章节创建-读回往返与唯一性**
    - **Validates: Requirements 2.1**

  - [x]* 4.3 编写章节列表按 position 升序属性测试
    - **Property 7: 章节列表按 position 升序**
    - **Validates: Requirements 2.2**

  - [x]* 4.4 编写章节正文更新往返属性测试
    - **Property 8: 章节正文更新往返**
    - **Validates: Requirements 2.3**
    - 生成器需覆盖特殊字符、空白与较长字符串

  - [x]* 4.5 编写删除章节仅影响目标章节属性测试
    - **Property 9: 删除章节仅影响目标章节**
    - **Validates: Requirements 2.4**

  - [x]* 4.6 编写章节排序置换往返属性测试
    - **Property 10: 章节排序为提供顺序的置换往返**
    - **Validates: Requirements 2.5**

- [x] 5. 实现 SettingService（人物/世界观/大纲领域逻辑）
  - [x] 5.1 实现 SettingService
    - 实现三类设定条目的创建、列表、更新、删除
    - 标识符不存在时返回 `NOT_FOUND`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x]* 5.2 编写设定条目创建与字段一致属性测试
    - **Property 11: 设定条目创建后出现在对应列表且字段一致**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

  - [x]* 5.3 编写设定条目更新往返属性测试
    - **Property 12: 设定条目更新往返**
    - **Validates: Requirements 3.5**

  - [x]* 5.4 编写删除设定条目仅影响目标条目属性测试
    - **Property 13: 删除设定条目仅影响目标条目**
    - **Validates: Requirements 3.6**

  - [x]* 5.5 编写不存在标识符返回 NOT_FOUND 属性测试
    - **Property 5: 不存在的标识符返回 NOT_FOUND**
    - **Validates: Requirements 1.6, 2.6, 3.7**
    - 跨项目、章节、设定条目验证读取/更新/重命名/删除均返回 `NOT_FOUND`

- [x] 6. 实现 ModelConfigService（模型配置领域逻辑）
  - [x] 6.1 实现 ModelConfigService
    - 保存/更新模型配置，校验 baseUrl、apiKey、modelName 均非空 → 否则返回 `VALIDATION_ERROR`
    - 提供对外掩码视图 `ModelConfigView`（apiKey 掩码，绝不返回原文）
    - 提供内部读取（供写作请求使用完整配置）
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.6_

  - [x]* 6.2 编写模型配置保存-读回往返属性测试
    - **Property 14: 模型配置保存-读回往返**
    - **Validates: Requirements 4.1, 4.3**

  - [x]* 6.3 编写模型配置对外视图掩码属性测试
    - **Property 15: 模型配置对外视图掩码 API Key**
    - **Validates: Requirements 4.2, 5.6**
    - 对视图完整序列化结果做 API Key 原文子串检查

  - [x]* 6.4 编写空字段模型配置被拒绝属性测试
    - **Property 16: 空字段模型配置被拒绝且已存配置不变**
    - **Validates: Requirements 4.4**

- [x] 7. 实现 WritingService 上下文组装（纯函数）
  - [x] 7.1 实现 buildPromptMessages
    - 按 operation 组装消息：continue 含章节正文 + 指令；rewrite/polish 含选定文本 + 指令
    - system 消息包含附加设定内容；按序展开会话历史
    - _Requirements: 6.1, 6.2, 6.5, 6.6_

  - [x]* 7.2 编写续写上下文属性测试
    - **Property 19: 写作上下文包含章节正文与指令（续写）**
    - **Validates: Requirements 6.1**

  - [x]* 7.3 编写改写/润色上下文属性测试
    - **Property 20: 写作上下文包含选定文本与指令（改写/润色）**
    - **Validates: Requirements 6.2**

  - [x]* 7.4 编写附加设定进入上下文属性测试
    - **Property 22: 附加设定内容进入写作上下文**
    - **Validates: Requirements 6.5**

  - [x]* 7.5 编写会话历史按序保留属性测试
    - **Property 23: 会话历史按序保留于上下文**
    - **Validates: Requirements 6.6**

- [x] 8. 实现 ModelProxy（OpenAI 兼容流式转发）
  - [x] 8.1 实现 streamCompletion 与 SSE 解析
    - 向 `${baseUrl}/chat/completions` 发起 POST，注入 `Authorization: Bearer ${apiKey}`，body 含 model/messages/stream:true
    - 解析提供商 SSE 行，抽取 `choices[0].delta.content` 增量并以异步迭代器逐段产出
    - 非 2xx 或 AbortSignal 超时时抛出 `ProxyError(reason)`
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6_

  - [x]* 8.2 编写流式增量保序无损转发属性测试
    - **Property 17: 流式增量保序无损转发**
    - **Validates: Requirements 5.3**
    - 使用 mock 提供商以任意分片产出增量，断言转发拼接结果与源拼接一致

  - [x]* 8.3 编写代理调用与错误处理单元测试
    - 使用 mock 提供商验证请求参数（model/messages/header）与超时/错误抛出
    - 对前端可见输出做 API Key 原文子串检查（不泄露）
    - _Requirements: 5.1, 5.2, 5.5, 5.6_

- [x] 9. 实现 WritingService 写作编排
  - [x] 9.1 实现写作编排流程
    - 写作前检查模型配置是否存在，缺失返回 `MODEL_NOT_CONFIGURED`
    - 解析附加设定 → 调用 buildPromptMessages → 调用 ModelProxy 流式转发
    - _Requirements: 5.1, 5.4, 6.1, 6.2, 6.5, 6.6_

  - [x]* 9.2 编写未配置模型写作返回提示错误属性测试
    - **Property 18: 未配置模型时写作返回提示错误**
    - **Validates: Requirements 5.4**

  - [x]* 9.3 编写写作流程集成测试
    - 使用 mock 提供商验证续写/改写/润色端到端组装与流式返回
    - _Requirements: 5.1, 5.2, 5.5_

- [x] 10. 检查点 - 确保领域层与代理层测试通过
  - 运行后端单元测试与属性测试，确保通过；如有疑问请询问用户。

- [x] 11. 实现 Fastify 路由（传输层 + 统一错误映射）
  - [x] 11.1 实现项目路由
    - `POST /api/projects`、`GET /api/projects`、`PATCH /api/projects/:id`、`DELETE /api/projects/:id`，接入 ProjectService
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 11.2 实现章节路由
    - `POST/GET /api/projects/:id/chapters`、`PATCH /api/chapters/:id/content`、`DELETE /api/chapters/:id`、`PUT /api/projects/:id/chapters/order`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 11.3 实现设定路由
    - 人物/世界观/大纲的创建、列表、更新、删除路由，接入 SettingService
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 11.4 实现模型配置路由
    - `PUT /api/model-config`（保存/更新）、`GET /api/model-config`（掩码视图）
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 11.5 实现写作 SSE 路由与统一错误映射
    - `POST /api/projects/:id/chapters/:chapterId/write`，以 SSE 逐段转发增量；错误以 `event: error` 携带 `ApiError`
    - 实现错误码到 HTTP 状态映射（400/404/409/502/500）
    - _Requirements: 5.3, 5.4, 5.5, 7.4_

  - [x]* 11.6 编写路由集成测试
    - 验证各 CRUD 路由、错误状态映射与 SSE 写作端点
    - _Requirements: 1.6, 2.6, 3.7, 4.4, 5.4, 7.4_

- [x] 12. 实现前端组件与流式写作
  - [x] 12.1 实现 apiClient 与统一错误处理
    - 封装 fetch 与 SSE 写作流接口，将非成功响应转换为 `ApiError`
    - _Requirements: 7.2, 8.6_

  - [x] 12.2 实现 applyAdoption 文本采用纯函数
    - insert 模式按位置嵌入、replace 模式替换 `[start, end)` 区间
    - _Requirements: 6.4_

  - [x]* 12.3 编写采用文本插入/替换属性测试
    - **Property 21: 采用文本的插入/替换正确性**
    - **Validates: Requirements 6.4**

  - [x] 12.4 实现项目列表与工作台视图
    - `ProjectListView`（列表 + 创建入口）与 `ProjectWorkspaceView`（章节/人物/世界观/大纲）
    - _Requirements: 8.1, 8.2_

  - [x] 12.5 实现章节编辑器
    - `ChapterEditor` 展示并编辑正文，保存时提交更新请求
    - _Requirements: 8.3, 8.4_

  - [x] 12.6 实现对话式写作面板
    - `ChatPanel` 以 SSE 流式渲染生成文本，提供"采用"按钮调用 applyAdoption 插入/替换到编辑器
    - _Requirements: 6.3, 6.4_

  - [x] 12.7 实现设置面板与全局错误提示
    - `SettingsPanel` 查看/更新模型配置；`ErrorToast` 全局错误组件展示后端错误信息
    - _Requirements: 8.5, 8.6_

  - [x]* 12.8 编写前端组件单元测试
    - 覆盖视图渲染、章节保存触发、流式文本渲染与错误展示
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 6.3, 8.6_

- [x] 13. 集成与接线
  - [x] 13.1 接线后端服务
    - 在 Fastify 入口实例化 FileDataStore、各 Service、ModelProxy，注册全部路由与启动加载
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 13.2 接线前端应用
    - 在 `App.tsx` 组合视图与状态，使项目→章节→写作流程贯通
    - _Requirements: 8.1, 8.2, 8.3_

  - [x]* 13.3 编写端到端集成测试
    - 以自动化测试验证创建项目→章节→写作（mock 提供商）→采用文本的完整流程
    - _Requirements: 6.4, 7.2, 8.2_

- [x] 14. 最终检查点 - 确保全部测试通过
  - 运行前后端全部测试，确保通过；如有疑问请询问用户。

## Notes

- 标记 `*` 的子任务为可选测试任务（单元/属性/集成测试），可在追求 MVP 速度时跳过；核心实现任务不可跳过。
- 每个任务都引用了具体需求条款，便于追溯；24 条属性各自映射到独立子任务并标注属性编号与所验证需求。
- 检查点用于增量验证；属性测试验证 24 条通用正确性属性，单元/集成测试覆盖具体示例、UI 交互（8.x、6.3）、代理调用（4.5、5.1、5.2、5.5）、存储失败（7.4）与前端错误展示（8.6）。
- 属性测试使用 `fast-check`，每条至少运行 100 次迭代，生成器需覆盖特殊字符、空白、Unicode、空集合与较长字符串等边界；测试标签格式：**Feature: novel-writing-agent, Property {number}: {property_text}**。
- 安全要求：API Key 仅存于服务端，对外仅暴露掩码视图；ModelProxy 在服务端注入 Authorization 头，前端永不接触原始 Key（Property 15、17 相关测试需做 API Key 原文子串检查）。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "7.1", "8.1", "12.1", "12.2"] },
    { "id": 3, "tasks": ["2.2", "7.2", "7.3", "7.4", "7.5", "8.2", "8.3", "12.3", "12.4", "12.5", "12.6", "12.7"] },
    { "id": 4, "tasks": ["2.3", "12.8"] },
    { "id": 5, "tasks": ["2.4"] },
    { "id": 6, "tasks": ["2.5", "3.1", "4.1", "5.1", "6.1"] },
    { "id": 7, "tasks": ["3.2", "3.3", "3.4", "3.5", "4.2", "4.3", "4.4", "4.5", "4.6", "5.2", "5.3", "5.4", "5.5", "6.2", "6.3", "6.4", "9.1", "11.1", "11.2", "11.3", "11.4"] },
    { "id": 8, "tasks": ["9.2", "9.3", "11.5"] },
    { "id": 9, "tasks": ["11.6", "13.1", "13.2"] },
    { "id": 10, "tasks": ["13.3"] }
  ]
}
```
