给 Codex CLI 的执行入口：

请先阅读 `SPEC.md`，不要立刻重构项目。
你的任务是把现有小说 Agent 补成一个可运行、可测试、可接入临时 DeepSeek API 的工程化写作系统。

优先级如下：

1. 先检查现有项目结构，找出入口、模型调用、Prompt、配置文件。
2. 补 `.env.example`、`.gitignore`、配置读取、API Key 脱敏。
3. 抽象统一 LLM Provider，支持 OpenAI-compatible 接口和 mock 模式。
4. 增加 `ping` 指令，用于测试 DeepSeek API。
5. 增加小说项目结构：`bible/`、`outline/`、`chapters/`、`reviews/`、`state.json`。
6. 实现 MVP 指令：`init`、`idea`、`outline`、`write`、`summary`、`check`、`export`。
7. 所有模型调用必须走统一 Provider，不允许到处散落 API 请求代码。
8. API Key 只能从环境变量读取，不能写进源码、日志、README 示例或测试文件。
9. 默认不覆盖用户已有章节，除非显式传入 `--overwrite`。
10. 每完成一个模块都要跑 mock 测试，最后再用临时 DeepSeek API 做真实联调。

最终交付时，请给出：

* 已完成模块清单
* 修改过的文件列表
* 运行命令
* mock 测试结果
* DeepSeek API 联调结果
* 仍未完成或建议后续增强的项目
