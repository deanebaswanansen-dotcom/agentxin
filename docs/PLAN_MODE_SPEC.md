# Spec: 小说 Agent Plan Mode

## Objective

计划模式把用户填写的规模与创作要求转换成可供正文、剧本、人物分析和分镜模块复用的结构化 Story Plan。用户提供全文目标字数、章节数、单章字数、卷数、类型、核心剧情、结局方向和额外要求；未填写的细节由 Agent 自动补全。

验收行为：

- 已知信息禁止重复询问；低风险设定禁止询问。
- 只有答案会改变主线、结局或不可逆结构时才追问；不得把计划模式变成固定问卷。
- 目标参数与用户硬约束优先；缺失参数由 Agent 做可修改的专业默认决策。
- 最终结果包含执行 brief、全文/分卷/阶段层级和当前滚动章节窗口；正文由 Writer Agent 读取当前章节计划后生成。

请求中的 `planConfig` 同时接受 SPEC 的 snake_case 字段与前端使用的 camelCase 字段：

```json
{
  "target_total_words": 1000000,
  "target_total_chapters": 400,
  "target_words_per_chapter": { "min": 2500, "max": 3000 },
  "target_volume_count": 10,
  "genre": ["东方玄幻", "学院", "冒险"],
  "core_story": "主角进入学院后发现世界隐藏的秘密，最终卷入战争。",
  "ending_direction": "苦尽甘来",
  "writing_requirements": "慢热、群像、不后宫"
}
```

## Tech Stack

- Backend：TypeScript 5.6、Fastify 4.28、Vitest 2.1。
- Frontend：React 18.3、Vite 5.4、Vitest 2.1。
- Hosting：阿里云 ECS 常驻 Fastify 服务 + Nginx；计划请求使用 POST SSE 流。

## Commands

- Backend build：`cd backend && npm run build`
- Backend test：`cd backend && npm test -- --run`
- Frontend build：`cd frontend && npm run build`
- Frontend test：`cd frontend && npm test -- --run`
- ECS production build：`cd backend && npm run build && cd ../frontend && VITE_AGENT_BACKGROUND_JOBS=false npm run build`

## Project Structure

- `backend/src/services/agent/NovelPlanService.ts`：结构化配置解析、Requirement State、滚动章节窗口、Story Plan 生成与校验。
- `backend/src/services/agent/AgentOrchestrator.ts`：采纳计划、保存资料、注入记忆和正文上下文。
- `backend/src/types/index.ts`：服务端计划契约。
- `frontend/src/types/index.ts`：浏览器端计划契约。
- `frontend/src/components/ChatWorkspace.tsx`：计划会话状态与历史。
- `frontend/src/components/ChatMessageView.tsx`：问题与 Story Plan 展示。

## Code Style

```ts
const questions = decision.questions
  .filter(isHighValueQuestion)
  .filter((question) => !alreadyAsked(question, history))
  .slice(0, questionBudget);
```

函数使用动词命名，边界输入先归一化；计划规则集中在服务层，界面只负责呈现和提交结构化答案。

## Testing Strategy

- 单元测试验证配置优先级、0 问/追问、低价值问题拒绝、重复问题拒绝、滚动章节窗口与强制收束。
- 单元测试必须证明问题来自模型决策，不得由服务端固定题库在模型调用前短路。
- 回答一题后仍有核心方向缺口且提问预算未耗尽时，必须再次执行 Agent 决策，不得因界面轮次提前收束。
- 集成测试验证 Story Plan 能穿过 Agent 路由并写入项目资料与长期记忆。
- 前端测试验证题目 ID/文本进入历史、选项标签提交、Story Plan 可见。
- 部署前执行前后端全量测试、构建和阿里云 `/api/agent/plan/turn-stream` SSE 回归。

## Boundaries

- Always：保留用户明确题材和禁忌；运行全量测试；API Key 只保存在用户浏览器和单次请求头。
- Ask first：新增外部依赖、改变项目存储格式、改变阿里云生产环境或公网入口。
- Never：提交密钥；用固定多轮问卷替代 Agent 决策；为低风险世界细节向用户提问。

## Success Criteria

- 结构化字段会在请求中传入 Planner；填写完整时可直接生成计划，缺失字段由 Agent 自主补全或提出高影响问题。
- 同一问题 ID 在一次计划会话中只出现 1 次；问题数量由 Agent 决策，不使用固定题库。
- 计划层级至少包含全文规模、分卷范围、卷内阶段目标与当前章节窗口；400 章等长篇目标不一次性展开全部细节。
- 生成任务收到完整 Story Plan，项目资料中保存 `Story Plan（计划锁定）`。
- 阿里云正式站计划 SSE 必须先返回进度帧，最终进入 `asking` 或 `ready`，无 502/空结果。

## Open Questions

无；本规范以用户提供的《小说Agent_Plan_Mode_设计规范.md》为批准来源。
