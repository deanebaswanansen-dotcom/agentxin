# 短剧结构化输出轻量评估与依赖决策

## 结论

第一阶段采用 BAML 的设计思路，但暂不引入 BAML 运行时依赖。

当前 TypeScript 实现已经具备本阶段最重要的四个能力：版本化整对象契约、字段级错误、
保守本地修复，以及最多一次显式 Fixup。先用失败夹具和可重复指标稳定这些边界，避免在
短剧主链仍快速调整时同时引入新的 schema DSL、生成器和运行时。

这不是拒绝 BAML。若后续出现多语言契约、跨服务 schema 漂移、几十个重复 decoder，
或需要统一生成客户端类型，再单独评估引入成本。

## 评估范围

夹具目录：
`backend/src/services/script/agents/fixtures/`

20 个脱敏样例覆盖：

- 合法 JSON、Markdown code fence、正文前后说明；
- `<think>` 与方括号思维链污染；
- 对象/数组尾逗号、字符串内裸换行和制表符；
- 缺右括号、响应中途真实截断；
- 未引用键、单引号、字符串内未转义引号；
- 顶层数组、完全无 JSON、只有思维链；
- 必填字段缺失和字段类型错误。

评估契约是一张脱敏人物卡，要求完整的 `name / hairstyle / role / aliases`。它同时运行：

1. `parseStructuredModelOutputWithDiagnostics` 的直接解析与本地 repair；
2. `StructuredContract` 全对象 decode；
3. `generateStructured` 的一次 primary 与最多一次 Fixup。

Fixup 使用确定性假模型，只验证调用顺序、错误分类和预算，不代表真实模型修复成功率。

## 可机器运行

输出完整 JSON 指标：

```powershell
cd backend
npx tsx src/services/script/agents/structuredOutputEval.ts
```

运行固定断言：

```powershell
cd backend
npx vitest run src/services/script/agents/structuredOutputEval.test.ts --pool=threads --maxWorkers=1 --minWorkers=1 --fileParallelism=false
```

指标 JSON 的 `schemaVersion` 当前为 `1`；自动化可以读取 `local`、`boundedWorkflow` 和
逐例 `cases`，不需要解析人类日志。

## 基线结果

| 指标 | 结果 |
| --- | ---: |
| 夹具总数 | 20 |
| 直接解析并通过契约 | 7 |
| 本地 repair 后通过契约 | 4 |
| JSON 解析失败 | 7 |
| JSON 可解析但契约失败 | 2 |
| 分类符合夹具预期 | 20 / 20 |
| primary 完成 | 11 |
| 一次 Fixup 完成 | 9 |
| 进入 needs_review | 0（确定性假 Fixup） |
| 总模型调用数 | 29 |
| 单夹具最大调用数 | 2 |

本地 repair 能安全处理尾逗号和字符串内裸控制字符，不尝试猜测缺失引号、缺括号或被
截断的内容。这些不可确定修复进入显式 Fixup，符合“本地只做保守修复”的边界。

## 已发现边界

- 顶层数组夹具会被当前“提取第一个平衡对象”逻辑提取出内部对象并通过契约。对于只需
  从带说明文本中寻找一个对象的当前调用，这是既有行为；若未来必须严格拒绝原始顶层
  数组，应增加原始容器检查，而不是扩大 loose JSON repair。
- 假 Fixup 总会返回合法对象，因此 `needsReview = 0` 只证明预算和回环正确。真实模型
  成功率必须在后续脱敏真实响应集上单独统计。
- 夹具不得保存 API Key、用户原文、真实人名、项目 ID 或完整业务故事；新增案例继续使用
  同等规模的最小脱敏样例。

## 第一阶段决策记录

采用的 BAML 式原则：

- 契约有名称和版本，不把 Prompt 当 schema；
- decoder 检查完整对象并一次返回所有已知字段错误；
- Fixup Prompt 携带字段路径、错误码和上一份候选；
- 模型输出始终是候选，通过 decode 才成为领域对象；
- 调用预算固定为 primary 一次、Fixup 一次，可选 fallback 一次。

暂不引入运行时依赖的原因：

- 当前契约数量和 TypeScript 落点仍小，现有接口已能覆盖主要失败；
- 避免同时维护 DSL schema、生成类型和手写领域 decoder；
- 保持 provider 与现有请求级模型配置兼容；
- 先用本夹具集验证收益，再以数据决定是否增加依赖。

重新评估触发条件：契约数量明显增长、前后端类型持续漂移、同类 decoder 大量重复，或
真实模型评估显示手写 Fixup 难以稳定表达字段级约束。
