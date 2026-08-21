# AgentXin 项目说明书与交接手册

最后更新：2026-08-13

本文供项目使用者、运维人员和接手开发的 Agent 使用。任何密钥都不得写入本文、源码、Git 提交、终端截图或日志。

## 1. 项目定位

AgentXin 是一个 AI 小说创作 Agent，不是固定步骤的工作流。用户提供题材、方向和约束，Agent 负责提问、规划、世界观、人物、分章策划、正文生成、连续性检查、修订和资料沉淀。

核心约束：

- 每台电脑或浏览器使用自己的模型 API 配置。
- API Key 只保存在浏览器，并随模型请求发送；服务端不持久化 API Key。
- 项目、章节、人物、世界观、大纲、记忆和参考资料保存在服务器云盘。
- 计划模式必须尊重用户已给出的题材和约束，禁止重复询问；每轮先展示 Agent 自检清单，再只询问会改变主线、人物弧光、结局或篇幅结构的高影响问题，单轮最多 5 题、总预算 10 题。
- 长篇写作先创建服务器后台任务，再按任务 ID 轮询；切项目、刷新页面或临时断网不会终止服务器任务。

计划模式的详细契约见 [`PLAN_MODE_SPEC.md`](PLAN_MODE_SPEC.md)。

## 2. 当前线上状态

| 项目 | 当前值 |
| --- | --- |
| 代码仓库 | `https://github.com/deanebaswanansen-dotcom/agentxin.git` |
| 生产分支 | `main` |
| 阿里云公网入口 | `http://101.133.150.84` |
| 服务器系统 | Ubuntu 24.04 LTS |
| Node.js | 22.x |
| Nginx | 1.24.0 |
| 服务器代码目录 | `/root/agentxin` |
| 前端发布目录 | `/var/www/agentxin` |
| 持久数据目录 | `/var/lib/agentxin` |
| 后端监听 | `0.0.0.0:3000`，仅由 Nginx 反向代理 |
| 公网端口 | TCP 80；SSH 22 应仅允许管理员 IP |

截至 2026-08-12 已确认：

- 前端和后端均构建成功。
- Nginx 配置检查成功，公网首页返回 HTTP 200。
- `/api` 已能经 Nginx 到达 Fastify 后端。
- 后端曾以终端前台方式成功启动。

仍需在服务器确认：

```bash
systemctl is-enabled agentxin
systemctl is-active agentxin
```

预期结果分别为 `enabled` 和 `active`。未达到该状态时，必须按第 6 节安装 systemd 服务，否则关闭 SSH 或重启服务器后 API 会停止。

## 3. 日常使用

1. 确认阿里云 ECS 实例处于“运行中”。
2. 浏览器打开 `http://101.133.150.84`。
3. 每台电脑第一次进入“设置”，填写自己的模型服务地址、模型名称和 API Key，再执行连接测试。
4. 新建项目后使用自由讨论，或输入 `/计划` 进入计划模式；计划确认后再生成正文。
5. 重要作品定期导出 TXT、Markdown 或 DOCX，并由管理员备份服务器数据目录。

### 浏览器身份与数据隔离

浏览器首次访问时生成一个 256 位随机客户端编号，保存在 Local Storage 的 `nwa.clientId.v1`。每个请求通过 `x-agentxin-client-id` 请求头携带该编号，后端据此在同一服务器数据目录内隔离不同浏览器的数据。

这意味着：

- 几个人可以同时使用同一个网站，各自填写自己的 API Key，并看到各自的项目。
- 同一个人在另一台电脑、另一种浏览器或无痕窗口访问时，会得到新的客户端编号，因此看到的是新的空工作区。
- 清理浏览器站点数据会丢失客户端编号；服务器上的旧项目文件仍存在，但界面无法自动找回对应工作区。
- 当前没有账号登录、跨设备同步、客户端编号恢复或共享项目功能。

### API Key 安全

API 配置保存在浏览器 Local Storage 的 `nwa.modelConfig.v1`。后端使用 `ModelConfigService(..., { allowStoredConfig: false })`，禁止把 API Key 写入项目存储。

当前公网地址使用 HTTP，API Key 在浏览器到服务器之间没有 TLS 加密，只能用于临时测试。长期使用必须配置域名和 HTTPS，或限制为可信 VPN/内网访问。

## 4. 架构

```text
浏览器 React/Vite
  ├─ Local Storage：API 配置、客户端编号
  ├─ REST：项目、章节、设定、资料
  ├─ Fetch + SSE：计划模式、短任务、自由对话
  └─ 后台任务轮询：整本/长篇写作
            │
            ▼
Nginx :80
  ├─ /            → /var/www/agentxin
  └─ /api/*       → Fastify 127.0.0.1:3000
                         │
                         ├─ NovelPlanService：计划决策与结构化 Story Plan
                         ├─ PlanSessionStore：项目级计划决策与问题恢复
                         ├─ AgentOrchestrator：任务编排、写作与修订
                         ├─ AgentRunStore：后台任务、进度、结果与重启恢复
                         ├─ ModelProxy：OpenAI-compatible 模型请求
                         └─ Client-scoped stores
                              ├─ projects/
                              ├─ memory/
                              ├─ references/
                              ├─ long-novel/
                              ├─ plan-sessions/
                              └─ agent-runs.json
                                  位于 /var/lib/agentxin
```

### 主要代码位置

| 路径 | 职责 |
| --- | --- |
| `frontend/src/components/ChatWorkspace.tsx` | 对话、计划会话、Agent 任务界面状态 |
| `frontend/src/api/apiClient.ts` | REST、SSE、浏览器模型配置和客户端编号 |
| `backend/src/index.ts` | Fastify 服务装配、存储目录和路由注册 |
| `backend/src/services/agent/NovelPlanService.ts` | 计划模式提问、需求状态、Story Plan |
| `backend/src/services/agent/AgentOrchestrator.ts` | Agent 编排、资料保存、正文上下文和记忆 |
| `backend/src/proxy/ModelProxy.ts` | 模型协议、流式响应和错误映射 |
| `backend/src/services/client/clientScope.ts` | 客户端编号校验和请求隔离 |
| `frontend/netlify/functions/` | Netlify 兼容层；阿里云 ECS 部署不使用 |

### 阿里云与 Netlify 的差异

阿里云 ECS 使用常驻 Node.js 后端，前端必须保持 `VITE_AGENT_BACKGROUND_JOBS` 未设置或设为 `false`：计划与短任务使用 SSE，`full_novel`/`long_novel` 使用持久化 `/api/agent/jobs`。Netlify 设置 `VITE_AGENT_BACKGROUND_JOBS=true` 后改走 Netlify Background Functions；该模式仍受 15 分钟函数上限约束，因此当前主部署选择 ECS，决策记录见 [`decisions/001-use-aliyun-ecs-for-primary-deployment.md`](decisions/001-use-aliyun-ecs-for-primary-deployment.md)。

## 5. 本地开发与验证

要求 Node.js 22.x。

```bash
# 后端终端
cd backend
npm ci
npm run dev

# 前端终端
cd frontend
npm ci
npm run dev
```

浏览器访问 `http://127.0.0.1:5173`。提交或部署前执行：

```bash
cd backend
npm run typecheck
npm test
npm run build

cd ../frontend
npm run typecheck
npm test
npm run build
```

不要执行 `npm audit fix --force`；它可能升级破坏性版本。应先用 `npm audit` 确认漏洞位于生产依赖还是开发工具，再单独升级并执行全量测试。

## 6. 阿里云 ECS 初次部署

### 6.1 安全组

- TCP 80：来源 `0.0.0.0/0`，用于当前 HTTP 网站。
- TCP 443：配置 HTTPS 后开放。
- TCP 22：仅允许管理员的固定公网 IP。
- TCP 3000：禁止公网开放，由 Nginx 在本机代理。

### 6.2 构建

```bash
cd /root
git clone https://github.com/deanebaswanansen-dotcom/agentxin.git

cd /root/agentxin/backend
npm ci
npm run build

cd /root/agentxin/frontend
npm ci
VITE_AGENT_BACKGROUND_JOBS=false VITE_SCRIPT_MODE_ENABLED=true npm run build

mkdir -p /var/www/agentxin /var/lib/agentxin
cp -a /root/agentxin/frontend/dist/. /var/www/agentxin/
```

### 6.3 后端 systemd 服务

```bash
cat >/etc/systemd/system/agentxin.service <<'EOF'
[Unit]
Description=AgentXin Backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/agentxin/backend
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=REQUIRE_CLIENT_ID=1
Environment=CLIENT_DATA_DIR=/var/lib/agentxin
ExecStart=/usr/bin/node /root/agentxin/backend/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now agentxin
systemctl status agentxin --no-pager
```

### 6.4 Nginx

仓库内可直接部署的配置位于 `deploy/nginx/agentxin.conf`。它为内容哈希静态资源启用长期缓存和 gzip，确保丢失的旧分包返回 404，并把 `/health` 转发到后端。下方配置应与该文件保持一致：

```nginx
server {
    listen 80 default_server;
    server_name _;

    root /var/www/agentxin;
    index index.html;
    client_max_body_size 20m;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_comp_level 5;
    gzip_types application/javascript application/json application/xml image/svg+xml text/css text/plain;

    location = /health {
        proxy_pass http://127.0.0.1:3000/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_connect_timeout 3s;
        proxy_read_timeout 5s;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        access_log off;
    }

    location = /index.html {
        add_header Cache-Control "no-cache" always;
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
    }
}
```

将 `deploy/nginx/agentxin.conf` 复制为 `/etc/nginx/sites-available/agentxin`，然后执行：

```bash
ln -sf /etc/nginx/sites-available/agentxin /etc/nginx/sites-enabled/agentxin
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx
curl -I http://127.0.0.1
```

## 7. 发布新版本

生产更新必须在代码完成测试、合并到 GitHub `main` 后执行：

```bash
cd /root/agentxin
git status --short
git pull --ff-only origin main

cd backend
npm ci
npm run build

cd ../frontend
npm ci
VITE_AGENT_BACKGROUND_JOBS=false VITE_SCRIPT_MODE_ENABLED=true npm run build
cp -a dist/. /var/www/agentxin/

systemctl restart agentxin
nginx -t && systemctl reload nginx
systemctl status agentxin --no-pager
curl -I http://127.0.0.1
```

若服务器 `git status --short` 有输出，先查明文件来源，不要使用 `git reset --hard` 覆盖未知改动。

## 8. 启停与日志

```bash
# 状态
systemctl status agentxin --no-pager
systemctl status nginx --no-pager

# 重启
systemctl restart agentxin
systemctl restart nginx

# 后端最近 200 行日志
journalctl -u agentxin -n 200 --no-pager

# 持续查看后端日志
journalctl -u agentxin -f

# Nginx 错误日志
tail -n 200 /var/log/nginx/error.log
```

ECS 正常关机时，网站不可访问，云盘记录仍保留。再次启动 ECS 后，已启用的 `nginx` 和 `agentxin` 服务会自动启动。释放实例、重装系统盘或删除 `/var/lib/agentxin` 会造成数据丢失。

## 9. 备份与恢复

### 备份

写作数据变化后以及每次生产更新前执行：

```bash
mkdir -p /root/backups
tar -czf "/root/backups/agentxin-data-$(date +%F-%H%M%S).tar.gz" -C /var/lib agentxin
ls -lh /root/backups
```

服务器内备份无法防止整台实例或系统盘被释放，应定期把备份文件下载到本地或同步到独立存储。

### 恢复

恢复会覆盖同名数据，先确认备份文件路径：

```bash
systemctl stop agentxin
tar -xzf /root/backups/agentxin-data-YYYY-MM-DD-HHMMSS.tar.gz -C /var/lib
systemctl start agentxin
systemctl status agentxin --no-pager
```

## 10. 常见故障

| 现象 | 检查 | 处理 |
| --- | --- | --- |
| 公网 IP 打不开 | 阿里云安全组、`systemctl status nginx` | 开放 TCP 80；修复 Nginx 后重启 |
| 首页能开但请求失败 | `systemctl status agentxin`、`journalctl -u agentxin -n 200` | 启动后端；确认 3000 未被其他进程占用 |
| 关闭 SSH 后 API 失效 | `systemctl is-active agentxin` | 停止前台 `npm start`，安装并启用 systemd 服务 |
| 长篇页面关闭或切项目 | 返回原项目查看后台任务 | 服务器继续运行；页面会恢复已持久化进度和结果 |
| 服务器在长篇中重启 | 返回原项目并保持 API 配置有效 | 任务显示等待恢复；首次查询会从已保存章节/场景继续 |
| 新电脑看不到旧项目 | 浏览器客户端编号不同 | 当前属于既定隔离行为；使用原浏览器，或另行实现账号与迁移功能 |
| 清理浏览器后项目为空 | Local Storage 客户端编号已重建 | 服务器数据可能仍在；不要继续创建大量同名项目，先备份 `/var/lib/agentxin` |
| API 测试失败 | 浏览器设置、模型服务地址、模型名、后端日志 | 在该电脑重新填写自己的 API 配置；不要把 Key 发给开发 Agent |
| 返回 502 | `journalctl -u agentxin`、Nginx error log | 先确认后端存活，再检查上游模型返回和网络连接 |
| 页面偶发白屏或一直加载模块 | `curl -I http://127.0.0.1/assets/<文件名>`、Nginx error log、ECS 带宽 | 部署仓库内 Nginx 配置；确认 `/assets/` 返回长期缓存头且丢失文件为 404 |
| 计划模式重复询问 | 计划会话历史、问题 ID、`NovelPlanService` 测试 | 按 `PLAN_MODE_SPEC.md` 修复，禁止用固定问卷替代 Agent 决策 |
| 分章结果为 0/N 章 | 模型原始响应、解析与重试日志 | 验证结构化解析、分批策略和重试；不得伪造已生成章节 |
| 长篇结果提示正文为空 | ChapterAgent 重试日志、模型原始响应 | 最多生成 3 次；拿到非空正文前禁止进入审校；无蓝图的空壳删除，有场景检查点的章节保留并在下次恢复 |

可用 `curl -fsS http://127.0.0.1:3000/health` 检查后端直连，用 `curl -fsS http://127.0.0.1/api/health` 检查 Nginx 代理；二者均应返回 `{"status":"ok"}`，且不需要客户端编号。

## 11. 接手 Agent 必读

开始工作前依次读取：

1. `README.md`
2. `docs/PROJECT_HANDBOOK.md`
3. `docs/PLAN_MODE_SPEC.md`
4. 与任务直接相关的服务、路由、测试和前端组件

执行纪律：

- 先运行 `git status --short`，保留用户已有修改。
- 先复现和定位，再修改；完成后运行相关测试、前后端 typecheck 和 build。
- 不读取、记录、提交或复述用户 API Key。
- 不把 Agent 改写成固定多步骤工作流。
- 不改变客户端隔离、存储格式、部署归属或外部依赖，除非用户明确批准。
- 不宣称线上已更新，除非代码已推送、服务器已拉取、服务已重启并完成真实回归。
- 线上排错优先收集 `journalctl -u agentxin`、Nginx error log、浏览器 Network 请求状态和可脱敏的模型响应。

交接给其他 Agent 时可直接提供以下提示：

```text
请先完整阅读 README.md、docs/PROJECT_HANDBOOK.md 和 docs/PLAN_MODE_SPEC.md。
当前生产环境是阿里云 ECS，公网入口 http://101.133.150.84，代码目录 /root/agentxin，
数据目录 /var/lib/agentxin，前端目录 /var/www/agentxin，后端服务名 agentxin。
先检查 git status、systemctl status agentxin、journalctl 和 Nginx 日志，再开展工作。
禁止接收或输出任何真实 API Key；计划模式必须输出自检清单，遵守单轮最多 5 题、总预算 10 题、禁止重复询问、尊重题材约束。
修改后运行前后端测试、typecheck 和 build，并明确区分“本地完成”“已推送”“已部署”。
```

## 12. 当前待办与风险

- 配置域名与 HTTPS；完成前不要在不可信网络填写真实 API Key。
- 确认 `agentxin.service` 已是 `enabled` 和 `active`。
- 建立独立于系统盘的自动备份。
- 增加正式健康检查路由及部署回归脚本。
- 账号登录、跨设备同步、客户端编号恢复和共享项目尚未实现。
- systemd 当前以 root 运行；后续应在保持数据权限正确的前提下迁移到专用低权限用户。

## 13. 短剧模式本地验收

短剧新建入口由前端构建变量 `VITE_SCRIPT_MODE_ENABLED` 控制；当前生产构建应显式设为 `true`。设为 `false` 时只禁止新建短剧，已有短剧项目仍会显示并可正常打开，不会删除资料。

真实模型验收脚本会创建独立临时项目，依次执行策划、总纲、圣经、单集正文、质量门和 TXT/Markdown/Fountain 导出。密钥只允许通过当前进程的 `SHORT_DRAMA_E2E_API_KEY` 提供，不要写入仓库、命令历史、日志或测试夹具。运行方式：

```powershell
cd backend
$secureKey = Read-Host -AsSecureString 'API Key'
$env:SHORT_DRAMA_E2E_API_KEY = [Net.NetworkCredential]::new('', $secureKey).Password
npm run acceptance:short-drama
Remove-Item Env:SHORT_DRAMA_E2E_API_KEY
```

可按供应商设置 `SHORT_DRAMA_E2E_BASE_URL` 和 `SHORT_DRAMA_E2E_MODEL`。验收脚本默认使用一个 300 字、单场、单集样例以控制调用成本，但仍严格执行正文 ±15% 字数门禁；失败时不得通过放宽门禁伪造成功结果。
