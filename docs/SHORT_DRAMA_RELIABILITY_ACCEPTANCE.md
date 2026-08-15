# AgentXin 短剧整本生成稳定性验收记录

状态：离线实现验收通过，线上真实模型验收待部署后执行
日期：2026-08-15
对应计划：`docs/SHORT_DRAMA_RELIABILITY_PLAN.md`

## 1. 本轮实现结论

第一阶段已按计划落地四层目标，同时保留现有 `AgentRunStore + AgentJobRunner + ScriptDirector` 任务框架：

- BAML 式结构输出：版本化契约、保守解析、字段级错误、一次 Fixup、可选 fallback、固定调用预算。
- Dramatron 式分层创作：策划、全剧粗纲、人物/世界、分集细纲、场景计划、单集候选依次持久化和校验。
- Novel-OS/DOME 式连续性：人物、事实、道具、伏笔、时间与因果形成逐集 continuity commit。
- LangGraph 式恢复语义：checkpoint v2、不可变候选、fingerprint、stale、`needs_review → waiting_user` 和显式 resume。

正式 Episode 不再被未通过校验的初稿或修订稿提前覆盖；通过质量门后，Episode 与 continuity commit 在同一次 Store mutation 中原子提交。

## 2. 自动化验收结果

| 范围 | 结果 |
| --- | --- |
| Backend TypeScript | 通过 |
| Backend 全量测试 | 107 个测试文件，673 个测试通过 |
| Backend 核心可靠性回归 | 14 个测试文件，152 个测试通过 |
| Frontend TypeScript | 通过 |
| Frontend 全量测试 | 31 个测试文件，254 个测试通过 |
| Frontend 生产构建 | 通过 |
| `git diff --check` | 无空白错误；仅 Windows LF/CRLF 提示 |

核心可靠性回归覆盖：

- 20 个脱敏结构失败夹具及失败分类；
- primary、一次 Fixup、可选 fallback 和无 fallback 的 `waiting_user`；
- 人物与世界独立产物、单人物定向修复、完整人物契约两端共享夹具；
- checkpoint v1 → v2 迁移、不可变 artifact revision、精确 fingerprint 复用和 stale 下游；
- Patch 目标白名单、未知 ID、越权块、非法人物、非目标缩稿及复检失败不写正式稿；
- source-aware blocking/advisory，AI 主观 hard 不再卡死任务；
- review revision CAS、open blocking issue、取消窗口和正式写入边界；
- completed Episode 编辑后降为 reviewing、旧 continuity stale、复检后原子恢复；
- 1–5 与 6–10 固定批次、前置 continuity 断链时零模型调用；
- 离线 10 集整本生成、连续性链、重启恢复和幂等重跑。

## 3. 结构输出基线

固定 20 个脱敏夹具的结果：

| 指标 | 结果 |
| --- | ---: |
| 直接解析并通过契约 | 7 |
| 本地保守 repair 后通过 | 4 |
| JSON 解析失败并进入 Fixup | 7 |
| JSON 可解析但契约失败并进入 Fixup | 2 |
| 失败分类符合预期 | 20 / 20 |
| primary 完成 | 11 |
| 一次 Fixup 完成 | 9 |
| 单夹具最大模型调用 | 2 |

本地 repair 不猜测缺失语义；空响应、真实截断、非法 JSON 和结构错误保留机器可读分类。确定性假 Fixup 只验证预算与回环，真实模型恢复率留到线上验收统计。

## 4. 离线整本验收

真实 File Store、Checkpoint Store 和 ScriptDirector 的离线模型桩已完成两组固定批次：

1. 生成第 1–5 集；
2. 校验第 5 集 current continuity 后生成第 6–10 集；
3. 形成 10 个与最终 Episode revision 对应的 current continuity commit；
4. 第 6 集上下文继承第 5 集的时间因果、伏笔 thread 和道具状态；
5. 首次完整流程模型调用数有界；
6. 同输入重跑复用成功节点，正文模型调用为零；
7. 中断后从已保存 draft checkpoint 继续，不重复生成 draft；
8. 缺失或陈旧的前置 continuity 会在调用模型前拒绝下一批。

## 5. 部署后线上验收矩阵

以下项目必须在合并并部署新版本后，使用公开 UI/API 与用户已配置模型执行；离线通过不替代这一步：

- 3 种题材分别生成 3 个明显不同的选题；
- 3 个单集样例覆盖约 300、500、300 可见字符目标；
- 一部 10 集诊断剧，按 1–5、6–10 两批完成；
- 生成期间覆盖刷新、切换项目、任务恢复和一次可恢复结构错误；
- 检查每集标准剧本结构、blocking/advisory 校稿、continuity 链和整本导出；
- 诊断通过后，再运行 900–1200 字/集的 10 集发布规格整本。

线上验收必须记录：项目 ID、部署版本、模型名、节点调用次数、Fixup/fallback 次数、waiting_user 次数、每集字数、blocking/advisory 数量、continuity revision 链与导出结果。不得把 API Key、Authorization header 或未脱敏原始模型响应写入报告。

## 6. 当前发布判断

代码和离线验收满足合并条件。最终产品验收仍需完成：合并、部署、确认线上静态资源与后端接口均为本提交版本，然后执行第 5 节真实模型矩阵。线上矩阵未完成前，本记录保持“待线上模型验收”。
