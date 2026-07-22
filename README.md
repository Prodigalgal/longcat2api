# longcat2api

**Node.js + SQLite** 实现的 LongCat 网页端 → **OpenAI 兼容 API** 网关。

| 能力 | 说明 |
|------|------|
| OpenAI Chat | `POST /v1/chat/completions` 流式 / 非流式 |
| OpenAI Responses | `POST /v1/responses` 流式 / 非流式 |
| 模型列表 | `GET /v1/models` |
| 账号池 | Cookie / `passport_token_key` 导入，SQLite 持久化 |
| 保活 | 定时 `session-create` / `user-current` 探测 |
| 临时邮箱 | 对接 [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) |
| 代理池 | VLESS 订阅 + 本机 **sing-box** mixed 入站 |
| 注册机 | 邮箱准备 + 代理；Passport 完成后绑定 Cookie |
| 管理面板 | 中文 Web UI（Basic 认证） |

> 协议逆向参考：`kylinpoet/longcat2api`、`JessonChan/longcat-web-api`、`sfdzkj/LongCat-Web-API-Wrapper`  
> 工程结构参考：`MiMo2API`（临时邮箱 / 代理池 / 保活）

---

## 架构

```
Client (OpenAI SDK / CherryStudio / NewAPI)
        │  Bearer sk-xxx
        ▼
┌─────────────────────────────────────┐
│         longcat2api (Express)        │
│  /v1/chat/completions  /v1/responses │
│  账号池 · 保活 · 注册 · 管理面板      │
│              SQLite                  │
└──────────────┬──────────────────────┘
               │
     ┌─────────┴──────────┐
     ▼                    ▼
 oversea-V2            cn chat-completion-V2
 (免登录)              (Cookie 账号池)
     │
     ▼
 CF Temp Mail · sing-box 代理（注册/可选）
```

### 上游模式

| 模式 | 端点 | 鉴权 |
|------|------|------|
| `oversea`（默认） | `/api/v1/chat-completion-oversea-V2` | 无需 Cookie |
| `cn` | `session-create` + `/api/v1/chat-completion-V2` | `passport_token_key` 等 Cookie |

可在配置 `default_mode` 切换，或在请求 body 中传 `"mode":"cn"` / 模型后缀 `:cn`。

---

## 快速开始

### 环境

- Node.js **18+**
- （可选）[sing-box](https://github.com/SagerNet/sing-box) — 代理池
- （可选）自建 Cloudflare 临时邮箱

### 安装运行

```bash
cd longcat2api
cp .env.example .env
cp config.example.json config.json
# 编辑 config.json：api_keys、admin_password、temp_mail、proxy_pool

npm install
npm start
```

默认：`http://0.0.0.0:8080`

- 管理面板：`http://localhost:8080/`（用户名 `admin`，密码见 `admin_password`）
- 健康检查：`GET /health`

### 调用示例

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-longcat" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "longcat-flash",
    "messages": [{"role":"user","content":"你好"}],
    "stream": false
  }'
```

```bash
curl http://localhost:8080/v1/responses \
  -H "Authorization: Bearer sk-longcat" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "longcat-thinking",
    "input": "解释一下 MoE"
  }'
```

### 模型别名

| model | 思考 | 搜索 |
|-------|------|------|
| `longcat-flash` / `longcat-default` | 否 | 否 |
| `longcat-thinking` / `longcat-reason` | 是 | 否 |
| `longcat-search` | 否 | 是 |
| `longcat-reason-search` / `longcat-pro` | 是 | 是 |

---

## 账号与保活

1. 浏览器登录 [longcat.chat](https://longcat.chat)
2. DevTools → Application → Cookie，复制整段，或至少 `passport_token_key`
3. 管理面板 **账号 → 导入 Cookie**，或：

```http
POST /api/account/import-cookie
Authorization: Basic YWRtaW46YWRtaW4=
Content-Type: application/json

{"cookie":"_lxsdk_cuid=...; passport_token_key=...; _lxsdk_s=..."}
```

4. 后台定时保活（默认 6h）调用 session 探测；连续失败会标记 invalid。

---

## 注册机说明

美团 Passport 注册含 Yoda 风控，**无法保证纯 API 全自动完成**。当前流程：

1. 配置 **临时邮箱** +（推荐）**代理池**
2. `准备邮箱` / `批量准备` → 生成 temp-mail + draft 账号
3. 用返回邮箱在浏览器完成 LongCat/美团注册登录
4. 将 Cookie **绑定**到对应 `account_id`

后续若补齐 Passport 协议，可在 `src/services/register.js` 扩展自动化钩子。

---

## 配置

`config.json`（也可用管理面板）：

```json
{
  "api_keys": "sk-longcat",
  "admin_password": "admin",
  "default_mode": "oversea",
  "keepalive_interval_seconds": 21600,
  "temp_mail": {
    "api_base": "https://apimail.example.com",
    "admin_password": "xxx"
  },
  "proxy_pool": {
    "enabled": false,
    "sub_url": "https://proxy.example.com/sub?token=xxx",
    "listen_port": 17890,
    "singbox_path": ""
  }
}
```

SQLite 默认路径：`data/longcat2api.db`

---

## 项目结构

```
longcat2api/
├── package.json
├── config.example.json
├── src/
│   ├── index.js              # 入口
│   ├── config.js
│   ├── db/index.js           # SQLite
│   ├── middleware/auth.js
│   ├── openai/               # 模型别名 + 协议转换
│   ├── routes/
│   │   ├── openai.js         # chat + responses
│   │   └── admin.js
│   └── services/
│       ├── longcatClient.js  # 上游客户端
│       ├── sseParser.js
│       ├── tempMail.js
│       ├── proxyPool.js
│       ├── register.js
│       └── keepalive.js
└── public/index.html         # 管理面板
```

---

## 管理 API（Basic admin）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/config` | 系统配置 |
| GET | `/api/accounts` | 账号列表 |
| POST | `/api/account/import-cookie` | 导入 Cookie |
| POST | `/api/account/:id/test` | 测试账号 |
| POST | `/api/accounts/renew-all` | 全量保活 |
| POST | `/api/account/auto-register` | 单次注册准备 |
| POST | `/api/account/auto-register-batch` | 批量异步任务 |
| GET/POST | `/api/temp-mail/*` | 临时邮箱 |
| POST | `/api/proxy/start\|stop\|rotate\|test` | 代理池 |

---

## Oracle Cloud K8s 部署（mnnu 集群）

部署约定对齐 `mimo2api` / `grok2api`，清单在 GitOps 仓库：

`D:\WorkSpace\Project\服务器管理\private\gitops\ircs-prod-config\longcat2api\`

| 项 | 值 |
|----|-----|
| 公网 | `https://longcat2api.mnnu.eu.org` |
| 命名空间 | `longcat2api` |
| 镜像 | `speedproxy/longcat2api:sha-<gitsha>`（多架构 amd64/arm64） |
| 状态卷 | Longhorn PVC `longcat2api-state` → `/var/lib/longcat2api` |
| 节点 | `infra.mnnu/node-class=core-public` |
| 流式超时 | HTTPRoute 标签 `infra.mnnu/traffic-class=streaming-ai` |

本地私密凭据：

- `D:\WorkSpace\Project\服务器管理\private\longcat2api\credentials.env`
- `D:\WorkSpace\Project\服务器管理\private\longcat2api\config.json`

详细步骤见 GitOps 文档：

`private/gitops/ircs-prod-config/docs/longcat2api-deployment.md`

### 首次上线 checklist

1. 推送本仓库并构建镜像（`.github/workflows/docker-publish.yml`）
2. 将 `ircs-prod-config` 中 `longcat2api/` 与 `apps/longcat2api-application.yaml` 推到 `main`
3. 集群一次性创建 bootstrap / dockerhub Secret（见 `longcat2api/README.md`）
4. Cloudflare 增加 `longcat2api.mnnu.eu.org` 多 A 记录（与其它 `*.mnnu.eu.org` 相同 NLB）
5. Argo CD 同步后访问 `/health` 与管理面板

K8s 环境变量（Secret）会覆盖 PVC 内 `config.json` 的密钥类字段，前缀统一为 `LONGCAT2API_*`。

---

## 许可

MIT
