# 百万字多 Agent 写作计划

## 目标

把现有 `full_novel` 从 12 章演示能力扩展为可执行长篇批处理：上限 500 章、每章目标 300-8000 字；百万字测试按 500 章 x 2000 字执行。

## 实施顺序

1. 规格落地：补充百万字、多 Agent、token/成本统计、验收标准。
2. 后端改造：解除 12 章硬限制，加入长篇参数归一化、分工 Agent 说明、运行指标汇总。
3. 前端改造：整本参数上限同步到 500 章，并在结果中展示 token、缓存命中和本地缓存指标。
4. 验收：先跑 mock E2E，再跑前后端类型检查和测试；真实 DeepSeek 只用环境变量注入 Key，不写入文件。

## 多 Agent 分工

- Supervisor Agent：统一目标、章节序号、预算和进度事件。
- World Agent：生成世界规则。
- Character Agent：生成人物与口吻护栏。
- Outline Agent：生成卷一大纲和章节方向。
- Chapter Writer Agent：逐章正文写作。
- Reflection Agent：每章结束后抽取摘要、人物状态、世界规则、剧情事实、风格经验。
- Metrics Agent：汇总 usage、缓存命中、本地缓存和可选美元成本估算。

## 验收门槛

- `full_novel` 接受 500 章参数，返回总章数与计划字数。
- 每章写完后写入长期记忆，下一章 prompt 回灌记忆。
- Agent 结果包含 token/cache metrics。
- Mock E2E 证明 SSE、章节落盘、长期记忆、metrics 结构可用。
- 前后端 typecheck/test 通过。
