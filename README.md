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
