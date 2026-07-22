# LongCat 海外邮箱注册 → 对话 → 保活 → 思考/联网

> 排查结论（基于 longcat.chat 前端 + passport.mykeeta.com 海外 Passport + 线上探针）  
> 策略：**只走海外 IP + mykeeta 邮箱注册**，不走国内 `passport.meituan.com` 手机号链路。

---

## 0. 本项目策略：仅登录会话（不做免登）

| 通道 | 端点 | Cookie | 本网关 |
|------|------|--------|--------|
| ~~Oversea 免登~~ | `chat-completion-oversea-V2` | 否 | **已禁用**，请求会 400 |
| **登录会话** | `session-create` + `chat-completion-V2` | **是** | **唯一路径** |

无有效账号 Cookie 时：`503 no_account`。

上游探针备忘：

- 无 Cookie：`session-create` → `401 请求cookie信息为空`
- 登录后才有完整 `user-current` / 思考联网按钮状态

---

## 1. 海外邮箱注册 / 登录（passport.mykeeta.com）

### 1.1 入口（LongCat 前端拼出来的）

非 CN 区域登录跳转示例（与你贴的 URL 一致）：

```text
https://passport.mykeeta.com/pc/login
  ?locale=en
  &region=HK
  &joinkey=1101498_851697727
  &token_id=5oTEq210UBLUcm4tcuuy6A
  &service=consumer
  &risk_cost_id=119801
  &theme=longcat
  &cityId=810001
  &backurl=https://longcat.chat/api/v1/user-loginV3?url=https%3A%2F%2Flongcat.chat%2F
```

常量来自 longcat 前端 prod 配置：

| 字段 | 值 |
|------|-----|
| `joinkey` | `1101498_851697727` |
| `token_id` | `5oTEq210UBLUcm4tcuuy6A` |
| 海外 Passport | `https://passport.mykeeta.com/` |
| 回调 | `https://longcat.chat/api/v1/user-loginV3?url=<回跳首页>` |

**不是** `passport.meituan.com` 国内手机登录页。  
HK region 配置里 `loginMethods.consumer.mainOrder` 含 **`email`**（以及 mobile/third）。

### 1.2 关键邮箱 API（均在 mykeeta 域）

来自 `login.e7d4e24d.js`：

| 步骤 | API | 作用 |
|------|-----|------|
| 1 风控预检 | `POST /api/emaillogin/v1/userriskcheck` | 邮箱风控 / 拿 `user_ticket`，区分注册/登录 |
| 2a 注册发码 | `POST /api/emaillogin/v1/emailsignupapply` | 注册场景发邮件验证码（`enableYodaVerify:true`） |
| 2b 登录发码 | `POST /api/emaillogin/v1/emailloginapply` | 登录场景发邮件验证码 body 含 `user_ticket` |
| 3a 注册提交 | `POST /api/emaillogin/v1/emailsignup` | 校验邮箱码完成注册 |
| 3b 登录提交 | `POST /api/emaillogin/v1/emaillogin` | body 含 `user_ticket` + `email_code` + `serial_number`，`set_cookie:true` |
| 4 密码（可选） | `POST /api/emaillogin/v1/emailpasswordlogin` / `POST /api/user/v1/setpassword` | 密码登录 / 设密 |
| 5 换票回 LongCat | 浏览器跳 `user-loginV3` | Passport cookie → LongCat 会话 cookie |

典型码登录 body（从 bundle 还原）：

```json
// emailloginapply
{ "user_ticket": "<from userriskcheck>" }

// emaillogin
{
  "user_ticket": "...",
  "email_code": "123456",
  "serial_number": "<from apply 返回 data.serialNumber>",
  "set_cookie": true
}
```

### 1.3 风控（海外邮箱也有，但和国内手机不是同一套页）

| 机制 | 说明 |
|------|------|
| **H5guard** | `msp.mykeeta.net/h5guard/H5guard.js`，请求签名/指纹 |
| **Yoda Global** | `yoda.global.js`；错误码 `C_USER_LOGIN_YODA_VERIFY=101190` 等，前端日志写「**Yoda 滑块验证**」 |
| **邮箱 OTP** | 邮件验证码（可用 Cloudflare Temp Mail 收） |
| 传统固定图验 OCR | **不是主路径**；主要是 **按风险触发 Yoda（可能滑块）** |

结论：海外邮箱路径 **适合 temp-mail 收码**；仍可能偶发 Yoda 滑块，**不能 100% 保证零验证码**，但比国内手机号 + 短信友好得多。注册流量必须 **海外代理出口**。

### 1.4 注册成功后拿到什么

浏览器完成 `user-loginV3` 后，在 `longcat.chat` 域下关键 Cookie（对话必需）：

| Cookie | 必要性 |
|--------|--------|
| **`passport_token_key`** | **必需**（鉴权） |
| `_lxsdk_cuid` | 建议 |
| `_lxsdk_s` | 建议 |

本服务账号池即存这些 Cookie，后续 `mode=cn`（此处含义是「登录态会话」，不是必须大陆 IP）走 session 聊天。

---

## 2. 注册成功后如何在 longcat.chat 发起对话

### 2.1 浏览器手工

1. 确认已登录（Cookie 有 `passport_token_key`）
2. 打开 `https://longcat.chat/t` 新对话  
3. 前端内部会：
   - `POST /api/v1/session-create` `{ "model": "", "agentId": "1" }` → `conversationId`
   - `POST /api/v1/chat-completion-V2` SSE，body 含 `conversationId` + 用户输入 + `reasonEnabled` / `searchEnabled`

### 2.2 协议层（本项目 / 自建客户端）

#### 登录态（唯一路径：注册/Cookie 后）

```http
POST /api/v1/session-create
Cookie: passport_token_key=...; _lxsdk_cuid=...; _lxsdk_s=...

{ "model": "", "agentId": "1" }
```

```http
POST /api/v1/chat-completion-V2
Cookie: ...
```

```json
{
  "content": "你好",
  "conversationId": "<session-create 返回>",
  "agentId": "1",
  "reasonEnabled": 1,
  "searchEnabled": 0,
  "regenerate": 0,
  "parentMessageId": 0,
  "files": []
}
```

OpenAI 兼容（必须先导入有效账号）：

```bash
curl https://longcat2api.mnnu.eu.org/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{"model":"longcat-thinking","messages":[{"role":"user","content":"1+1?"}]}'
```

---

## 3. 思考等级 / 联网搜索（关键）

### 3.1 网页真实控制方式

前端 **没有** OpenAI 那种 `reasoning_effort: low|medium|high` 多档。  
只有两个 **0/1 开关** 打进 chat body：

| 字段 | 类型 | 含义 |
|------|------|------|
| **`reasonEnabled`** | `0` / `1` | 是否开启「思考 / Think」 |
| **`searchEnabled`** | `0` / `1` | 是否开启「联网搜索」 |

前端还会读 `user-current` 里的默认：

| 字段 | 含义 |
|------|------|
| `reasonButtonStatus` | 账号默认是否开思考（未登录探针为 0） |
| `searchButtonStatus` | 账号默认是否开联网（未登录探针为 1） |

提交时常见逻辑：用 UI 状态覆盖/带上 `reasonEnabled` / `searchEnabled`（见 `index-6b882012`）。

### 3.2 SSE 里如何表现

| event.type | 含义 |
|------------|------|
| `reason` / `think` | 思考过程（reasoning） |
| `summary` | 思考阶段小结（可忽略） |
| `content` | 最终/正文增量（有的通道是增量，有的偏累积） |
| `common_search` / `general_search` 等 | 联网检索片段 |
| `finish` | 结束；可能带 `finalContentX`、`usage` |
| `lastOne: true` | 流结束 |

本项目 OpenAI 映射：

- 思考 → `message.reasoning_content` / stream delta  
- 正文 → `content`  
- 模型别名见下表

### 3.3 本项目模型别名（已实现）

| model | agentId | reasonEnabled | searchEnabled |
|-------|---------|---------------|---------------|
| `longcat-flash` / `longcat-default` | 1 | 0 | 0 |
| `longcat-thinking` / `longcat-reason` | 1 | **1** | 0 |
| `longcat-search` | 1 | 0 | **1** |
| `longcat-reason-search` | 1 | **1** | **1** |
| `longcat-pro` | **2** | 1 | 1 |

说明：

- **思考「等级」= 开关**，不是 low/medium/high。若客户端传 `reasoning_effort` 且非 `none`，会打开 `reasonEnabled`。  
- `agentId` 除 `1/2` 外，前端还有图片/视频/深度研究等特殊 agent（本网关当前只映射文本对话）。  
- 深度研究类：`reasonEnabled && searchEnabled` 时前端可能走额外 agent 路径；普通 Think+Search 用上表即可。

### 3.4 与官方开放平台的区别

- **网页反代**：靠 Cookie / oversea + `reasonEnabled`/`searchEnabled`  
- **开放平台 API Key**（`api.longcat.chat`）：另一套计费与鉴权，不在本「网页 2api」路径

---

## 4. 保活（Keep-alive）

### 4.1 为什么要保活

- 登录态 Cookie（尤其 `passport_token_key`）会过期  
- 过期后 `session-create` / `chat-completion-V2` 401  
- **Oversea 免登不依赖 Cookie**，不需要账号保活；但限流/风控与登录池是不同维度

### 4.2 本项目已实现策略

`src/services/keepalive.js` + `probeAccount`：

1. 优先 `POST /api/v1/session-create`（带账号 Cookie）— 最贴近真实对话鉴权  
2. 失败则 `GET /api/v1/user-current`  
3. 成功：`is_valid=1`，清 `error_count`  
4. 失败：累计错误，连续失败可自动 `enabled=0`  
5. 周期：`LONGCAT2API_KEEPALIVE_INTERVAL_SECONDS`（默认 6h）

**当前未做**：过期后用邮箱密码 + temp-mail 自动重登（mykeeta 流程可扩展，依赖 OTP + 可能 Yoda）。

### 4.3 推荐运营姿势

| 模式 | 保活 |
|------|------|
| 登录池（唯一） | 导入 Cookie 后开启 `auto_renew`；后台定时 probe；失败人工或半自动重登 |
| 海外注册机 | 注册出口必须走 **CF/VLESS 海外节点**；Cookie 写入账号池后进入保活 |

### 4.4 保活探针示例

```http
POST /api/v1/session-create
Cookie: passport_token_key=...
Content-Type: application/json

{"model":"","agentId":"1"}
```

- `code=0` 且有 `data.conversationId` → 有效  
- `401` / cookie 空 / 鉴权失败 → 失效，需重登

---

## 5. 端到端目标架构（海外 only）

```
[Temp Mail] 创建邮箱
     │
     ▼
[海外代理 IP] ──► passport.mykeeta.com
                   userriskcheck → emailsignupapply
                   → 邮箱 OTP → emailsignup / emaillogin
                   → 跳转 longcat user-loginV3
     │
     ▼
[Cookie] passport_token_key + _lxsdk_*
     │
     ├─► 保活: session-create 周期探测
     │
     └─► 对话:
           session-create
           chat-completion-V2
             reasonEnabled / searchEnabled / agentId
           SSE → OpenAI chat/responses
```

---

## 6. 实现清单（相对本仓库）

| 能力 | 状态 |
|------|------|
| 登录态 session + chat-V2（唯一对话路径） | ✅ 已实现；无账号 503 |
| reason/search 模型别名 | ✅ 已实现 |
| Cookie 导入 / 探测保活 | ✅ 已实现 |
| 免登 oversea | ❌ 已关闭 |
| mykeeta 海外邮箱全自动注册 | ✅ Playwright + Temp Mail；慢站点长超时；**AI 打码仅最后兜底** |
| 过期自动邮箱 OTP 重登 | ⏳ 可扩展 |
| 思考多档 effort | ❌ 上游只有 0/1 |

---

## 7. 一句话结论

1. **注册**：海外 **mykeeta 邮箱**（非 meituan 手机）；OTP + 可能 Yoda。  
2. **对话**：**仅** `session-create` + `chat-completion-V2` + Cookie。  
3. **思考/联网**：`reasonEnabled` / `searchEnabled` 开关（无多档）。  
4. **保活**：周期 `session-create` 探测 Cookie。
