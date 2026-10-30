# Fast-SSO 账号与充值接入

AIGC Studio 作为 Fast-SSO `consumer` Realm 的一方应用接入：注册、登录、找回密码、积分与充值都由账号中心提供；登录后提示词助手与 Agent 走平台模型（`https://api.callfansai.com`，按点数计费）。**平台生成网关还没有接入媒体模型**，图片、视频与配音生成仍走「模型与价格 · 自定义渠道」（用户自填 TreeCloud 兼容 Key，自动启用）。

## 架构

```
浏览器 / Electron 窗口
        │  只调本机服务（127.0.0.1:5780）
        ▼
本机 Fastify 服务（packages/server）
        │  OIDC 授权码 + PKCE；consumer Bearer Token
        ▼
https://sso.callfansai.com/realms/consumer
https://account.callfansai.com/api/v1
```

- 窗口与浏览器**不直连**账号 API；账号 API 的 CORS 白名单也不包含本机来源。
- `access_token` 只保存在本机服务内存里；`refresh_token` 用本机密钥（AES-256-GCM）加密后写入 sql.js 存储。
- 登录在**系统浏览器**完成，回调由本机固定的 `127.0.0.1:5781` 监听器接收，只接受 `GET /auth/callback`，校验 `state` 后换码，并校验 ID Token（签名、`iss`、`aud`/`azp`、`exp`/`nbf`、`nonce`）。
- 回环回调要求「浏览器」和「本机服务」在同一台机器上（桌面端、本机 Web 端）。以 `--lan` 暴露给其他设备时，其他设备的浏览器回调会落到它们自己的 5781，登录只能在该服务机本机完成。

## 固定事实

| 项 | 值 |
| --- | --- |
| OIDC Issuer | `https://sso.callfansai.com/realms/consumer` |
| API 根 | `https://account.callfansai.com/api/v1` |
| 客户端 | `aigc-callfans`（public，无密钥） |
| 回调 | `http://127.0.0.1:5781/auth/callback` |
| 积分 | micro，`1 积分 = 1_000_000 micro`，界面按 `micro / 1e6` 展示 |
| 渠道 | `huifu` / `wechat` / `alipay`；`mock` 永远不展示 |

## 上线前检查

1. Fast-SSO 控制台里该应用 `status=active`、`realm=consumer`、`trust=一方`、`protocol=OIDC`、`clientType=public`。
2. `redirectUris` 包含 `http://127.0.0.1:5781/auth/callback`（逐字符一致，末尾斜杠也算）。
3. 若 5781 被其他程序占用，登录会提示端口占用；换端口必须同时改控制台与 `AIGC_SSO_REDIRECT`。
4. 通过 `AIGC_ACCOUNT_PROVIDER` 以外的环境变量覆盖配置（见下）时，重启应用生效。

## 配置

| 环境变量 | 默认值 |
| --- | --- |
| `AIGC_ACCOUNT_PROVIDER` | `fastsso`（设为 `mock` 时使用开发用 Mock 云） |
| `AIGC_SSO_ISSUER` | `https://sso.callfansai.com/realms/consumer` |
| `AIGC_ACCOUNT_API` | `https://account.callfansai.com/api/v1` |
| `AIGC_SSO_CLIENT_ID` | `aigc-callfans` |
| `AIGC_SSO_REDIRECT` | `http://127.0.0.1:5781/auth/callback` |

设置页「账号与云端」只读展示这四项，并提供「测试连接」（Discovery + `/public/consumer/documents`）。

## 本机服务端点

| 端点 | 说明 |
| --- | --- |
| `POST /api/auth/login` | 生成 `state`/`nonce`/PKCE，启动回调监听，返回 `{mode:'browser', loginUrl, expiresIn}` |
| `POST /api/auth/poll` | 登录进度：`pending` / `approved` / `denied` / `expired` |
| `POST /api/auth/cancel` | 取消并关闭回调监听 |
| `POST /api/auth/logout` | 撤销 refresh token 并清理本地会话 |
| `GET /api/account/documents` | 条款版本（注册勾选用） |
| `POST /api/account/register/start` | 发送注册验证码 |
| `POST /api/account/register/complete` | 验证码 + 密码 + 条款同意 |
| `POST /api/account/password/forgot` | 发送找回验证码 |
| `POST /api/account/password/reset` | 重置密码 |
| `GET /api/billing/packs` | 积分档位（5 分钟缓存） |
| `GET /api/billing/wallet` | 余额与今日免费额度 |
| `POST /api/billing/orders` | 下单，**必须**带 `Idempotency-Key`（请求体 `idempotencyKey`） |
| `POST /api/billing/orders/:id/prepay` | 获取 `codeUrl`（二维码内容） |
| `POST /api/billing/orders/:id/cancel` | 关闭待支付订单（`/consumer/recharge/orders/{id}/close`） |
| `GET /api/billing/orders/:id` | 轮询订单状态，`paid` 为准 |
| `GET /api/billing/orders` | 最近订单 |
| `POST /api/settings/account/refresh` | 探测账号服务连通性（`/api/settings/cloud/refresh` 的别名） |

## 上游调用

- Discovery：`{issuer}/.well-known/openid-configuration`（缓存 1 小时）。
- 授权：`scope=openid profile email`、`code_challenge_method=S256`。
- 账号 API：只调 `/api/v1/consumer/**` 与 `/api/v1/public/**`；其他路径会被 `403 consumer_scope` 拒绝。
- 充值：`/consumer/recharge/skus` → `/channels` → `POST /orders`（`Idempotency-Key`）→ `POST /orders/{id}/prepay` → 轮询 `GET /orders/{id}`。
- 取消：`POST /consumer/recharge/orders/{id}/close`；只有待支付订单能关闭，已支付返回 409。该接口需要账号服务升级到包含 consumer close 的版本。
- 渠道过滤：只保留 `huifu` / `wechat` / `alipay` 且服务端 `enabled=true`；`mock` 一律不展示。
- 登录状态以 ID Token 校验通过 + `GET /consumer/entitlements/balance` 成功为准；access token 401 时刷新一次，失败则登出并提示。

## 开发与测试

```bash
# 用 Mock 云跑通设备码登录、模拟支付与生成
AIGC_ACCOUNT_PROVIDER=mock AIGC_CLOUD_URL=http://127.0.0.1:5790 pnpm dev:server
```

- 单元测试与 e2e 会自动设置 `AIGC_ACCOUNT_PROVIDER=mock`（`packages/server/test/server.test.ts`、`playwright.config.ts`）。
- Mock 云合同见 [`cloud-api-contract.md`](cloud-api-contract.md)，只用于联调，不是安全实现。

## 平台模型（对话）

- 清单：`GET {gatewayBase}/models`，免令牌，缓存 60 秒；`gatewayBase` 默认 `https://api.callfansai.com`，可用 `AIGC_GATEWAY_URL` 覆盖。
- 选模型：`AIGC_CHAT_MODEL` → 内置偏好（`deepseek-v4.1-flash-1017`、`claude-haiku-5-5`、`gpt-6-luna`）→ 最便宜的 openai 协议对话模型；不写死。
- 密钥：`POST /consumer/llm-keys` 用 consumer token 换一把长期 key，按账号 id 加密存在本机（`Store.setLlmKey`），之后复用；`key` 不出后端、不进日志。
  - 409 `billing_account_provisioning` → 约 30 秒后重试；409 `litellm_key_exists` → 本地副本丢了，先让平台吊销再换，不重试。
- 调用：`POST {gatewayBase}/v1/chat/completions`；401 丢本地副本重换一次，422 = 积分不足。
- 失败时提示词辅助回退到规则推断，并在响应里带上原因。

## 尚未接入

- 平台生成网关的**媒体**能力（图片 / 视频 / 语音）：登录后的点数目前只用于对话与订单；生成需要在「模型与价格 · 自定义渠道」填自己的 Key。平台上线媒体路由后，`Provider` 层可直接复用账号会话。
- 站内支付渠道以外的退款/对账界面：以账号中心后台为准。
