# Spec: 小说 Agent Plan Mode

## Objective

计划模式把用户的一句话需求转换成可供正文、剧本、人物分析和分镜模块复用的结构化 Story Plan。用户决定题材、核心方向、主角大方向、整体风格和特殊要求；Agent 自动完成世界观、人物细节、力量体系、支线、伏笔、分卷和章节规划。

验收行为：

- 已知信息禁止重复询问；低风险设定禁止询问。
- 正式规划前最多主动询问 3 个评分不低于 7/10 的高影响问题；信息足够时允许 0 问。
- 问题预算耗尽或用户要求直接生成后，Agent 必须采用合理默认值形成方案。
- 最终结果必须同时包含执行 brief、分章大纲和结构化 Story Plan。

## Tech Stack

- Backend：TypeScript 5.6、Fastify 4.28、Vitest 2.1。
- Frontend：React 18.3、Vite 5.4、Vitest 2.1。
- Hosting：Netlify Functions 与 Background Functions。

## Commands

- Backend build：`cd backend && npm run build`
- Backend test：`cd backend && npm test -- --run`
- Frontend build：`cd frontend && npm run build`
- Frontend test：`cd frontend && npm test -- --run`
- Netlify build：`cd frontend && npx netlify build --offline`

## Project Structure

- `backend/src/services/agent/NovelPlanService.ts`：Requirement State、提问预算、Story Plan 生成与校验。
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

- 单元测试验证 0 问、1-3 问、低价值问题拒绝、重复问题拒绝、总预算与强制收束。
- 集成测试验证 Story Plan 能穿过 Agent 路由并写入项目资料与长期记忆。
- 前端测试验证题目 ID/文本进入历史、选项标签提交、Story Plan 可见。
- 部署前执行前后端全量测试、构建和 Netlify 线上 API 回归。

## Boundaries

- Always：保留用户明确题材和禁忌；运行全量测试；API Key 只保存在用户浏览器和单次请求头。
- Ask first：新增外部依赖、改变项目存储格式、改变 Netlify 站点归属。
- Never：提交密钥；用固定多轮问卷替代 Agent 决策；为低风险世界细节向用户提问。

## Success Criteria

- “写本西方玄幻小说”首轮返回不超过 3 个方向问题，不开始写正文。
- 已包含题材、主角身份、主线和风格的输入可直接生成计划。
- 同一问题 ID 在一次计划会话中只出现 1 次，总主动问题不超过 3 个。
- 生成任务收到完整 Story Plan，项目资料中保存 `Story Plan（计划锁定）`。
- 正式站 Background Function 回归返回 HTTP 202 并最终进入 `asking` 或 `ready`，无 502/超时。

## Open Questions

无；本规范以用户提供的《小说Agent_Plan_Mode_设计规范.md》为批准来源。
