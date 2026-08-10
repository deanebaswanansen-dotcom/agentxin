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

## 线上部署（常驻后端，推荐）

> 场景：想把工作台挂到公网供多人使用。前端（Netlify 静态站）+ 后端（常驻 Node 服务）。
> 不推荐把后端塞进 Netlify Function —— 它有 ~60s 执行上限，长文/整章生成会超时（HTTP 502）。

1. **部署后端**（选一个免费常驻平台，如 Render / Railway）
   - 直接连接本仓库，仓库根 `Procfile` 已配置启动命令 `cd backend && node dist/index.js`。
   - 构建命令：`npm --prefix backend install && npm --prefix backend run build`
   - 环境变量：
     | 变量 | 说明 |
     |---|---|
     | `PORT` | 平台自动注入，无需手填 |
     | `DATA_FILE` | 数据文件路径，默认临时目录；配持久磁盘时填 `/data/agentxin-store.json` |
     | `AGENT_MEMORY_FILE` | Agent 记忆文件，同上 |
     | `REFERENCE_FILE` | 参考库文件，同上 |
     | `LONG_NOVEL_CONFIG_FILE` | 长篇配置文件，同上 |
     | `CORS_ORIGIN` | 前端站点地址，如 `https://xxx.netlify.app`；不填则允许所有来源（个人工具够用） |
   - ⚠️ 免费档文件系统不持久：重启/重新部署会丢数据。要持久化请挂持久磁盘（Railway Volume / Render Persistent Disk），并把上述文件路径指向磁盘挂载点。
2. **前端指向后端**
   - Netlify 构建环境变量里加：`VITE_API_BASE_URL=https://<后端域名>/api`，然后重新部署前端。
   - 本地 `npm run dev` 不设此变量，仍走 Vite 代理到 `127.0.0.1:3000`，互不影响。
3. 打开前端站点，设置页填 API Key 即可使用。生成过程无超时限制。

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
