# AI 小说创作工作台（Novel Writing Agent）

前后端分离的 AI 小说创作工作台。

## 目录结构

```
.
├── backend/    # Node.js + Fastify + TypeScript 服务端
├── frontend/   # React + TypeScript（Vite）前端
├── start.bat   # 一键启动（自动装环境）
├── stop.bat    # 一键停止
└── 发给别人-请先读我.txt
```

## 拷给别人 / 新手（推荐）

1. **Windows 双击根目录 `start.bat`**
   - 自动检测 Node.js（没有则下载便携版到 `.agentxin/node`，一般不需要管理员）
   - 自动 `npm install` 前后端依赖
   - 启动服务并打开浏览器：http://127.0.0.1:5173
2. 不用了双击 **`stop.bat`**
3. 说明见：`发给别人-请先读我.txt`

浏览器打开后：

- 左侧新建/搜索/删除项目；章节可删；「管理」可批量删除
- 右侧对话：`/计划`、`/参考`、`/长篇` 等
- 设置里填 API Key，或先用「演示模式」

## 开发（已有 Node 时）

### 后端

```bash
cd backend
npm install
npm run cli -- help
npm run dev
npm run typecheck
npm test
```

### 前端

```bash
cd frontend
npm install
npm run dev
npm run typecheck
npm test
```

## 线上部署（Netlify）

> 前端、API 和长任务可部署在同一个 Netlify 站点。每个浏览器首次打开时生成 256 位随机库标识；项目、记忆和参考库按该标识写入同一个 Netlify Blobs 站点存储。API Key 只保存在浏览器，并仅随模型任务请求进入函数内存，不写入 Blobs。

1. 在 Netlify 连接本仓库并部署；`netlify.toml` 已包含构建命令和 `VITE_AGENT_BACKGROUND_JOBS=true`。
2. 普通 API 走同步函数；多步 Agent 任务自动进入后台函数，最长执行 15 分钟，前端每 750 毫秒轮询一次进度。
3. 打开站点，在设置页选择当前模型并填写自己的 API Key。DeepSeek 官方当前可选 `deepseek-v4-flash` 或 `deepseek-v4-pro`。

可选常驻后端：仓库根的 [`render.yaml`](render.yaml) 可部署 Render 服务；此模式需把 Netlify 环境变量设为 `VITE_API_BASE_URL=https://<后端域名>/api` 和 `VITE_AGENT_BACKGROUND_JOBS=false`，正式使用时为 `CLIENT_DATA_DIR` 挂载持久磁盘。

## 模型

真实模型只从环境变量或设置页读取密钥；不要把 Key 写进源码。

DeepSeek 示例：

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-pro
LLM_API_KEY=你的密钥
```

## 测试

- 单元 / 属性测试：Vitest + fast-check

**注意**：Web 工作台是主界面；backend CLI 与 Python novel_agent 为辅助工具。
