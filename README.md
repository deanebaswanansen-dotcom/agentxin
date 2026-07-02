# AI 小说创作工作台（Novel Writing Agent）

前后端分离的 AI 小说创作工作台。

## 目录结构

```
.
├── backend/    # Node.js + Fastify + TypeScript 服务端
└── frontend/   # React + TypeScript（Vite）前端
```

## 开发

### 后端

```bash
cd backend
npm install
npm run cli -- help # 查看小说工程 CLI
npm run dev        # 启动开发服务器（tsx watch）
npm run typecheck  # TypeScript 类型检查
npm test           # 运行 Vitest（含 fast-check 属性测试）
```

### 小说工程 CLI

```bash
cd backend
npm run cli -- ping
npm run cli -- init --project ../projects/demo-novel --title Demo
npm run cli -- idea --project ../projects/demo-novel --seed "都市异能"
npm run cli -- outline --project ../projects/demo-novel --chapters 6
npm run cli -- write --project ../projects/demo-novel --chapter 1 --title "开端"
npm run cli -- summary --project ../projects/demo-novel
npm run cli -- check --project ../projects/demo-novel --chapter 1
npm run cli -- export --project ../projects/demo-novel --format markdown
```

真实模型只从环境变量读取密钥；不要把真实 API Key 写进源码、日志或文档。

DeepSeek 官方 OpenAI 兼容入口示例：

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-pro
LLM_API_KEY=你的密钥
```

前端「模型设置」可直接选择 DeepSeek V4 Flash、DeepSeek V4 Pro，或填写自定义 OpenAI 兼容入口。

### 前端

```bash
cd frontend
npm install
npm run dev        # 启动 Vite 开发服务器
npm run typecheck  # TypeScript 类型检查
npm test           # 运行 Vitest（含 fast-check 属性测试）
```

## 测试

- 单元测试与属性测试均使用 [Vitest](https://vitest.dev/)。
- 属性测试使用 [`fast-check`](https://fast-check.dev/)，前后端均已接入。

## 新手快速开始（真实用户体验优化后）

1. Windows 用户直接双击根目录 `start.bat`（会自动检查 Node、安装依赖、开两个终端窗口并打开浏览器）。
2. 浏览器打开后：
   - 左侧「项目」输入名称点击「新建项目」。
   - 选中项目后，在下方「项目资料」里切换 章节/人物/世界观/大纲 标签，添加内容（支持长文本）。
   - 在「章节」标签下新建章节，点击章节标题即可在中间打开编辑器（整行可点）。
   - 右侧切换到「🔮 Agent」，选任务卡，输入一句话，点击执行（支持「Mock (本地演示)」无需 Key）。
3. 想纯本地快速体验：去右上「⚙️ 设置」，选择「Mock (本地演示)」预设，保存即可。Agent 会用模拟响应立即返回结果。
4. 真实模型：选 DeepSeek 预设，填入你的 API Key 保存（Key 仅存后端，不回传前端）。

**注意**：本项目 Web 工作台（React + Fastify）是主要交互界面。根目录下的 CLI (`npm run cli -- help` 在 backend) 和 Python novel_agent 是辅助/进阶工具，两种项目格式目前并存（后续会进一步统一）。

如端口冲突，关闭旧 cmd 窗口重试，或按 bat 内提示手动释放端口。
