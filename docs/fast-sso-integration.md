# Fast-SSO 账号与充值接入

AIGC Studio 是 Fast-SSO 的一方应用，有两个登录入口、同一份账号层：**个人账号**登录 `consumer` Realm，用手机/邮箱注册并自行充值；**企业员工**登录 `business` Realm，由租户管理员开通账号与应用准入，用量记在租户的计费账户上。两个入口签发同一个客户端（`aigc-callfans`）的令牌，登录后一律走 `/api/v1/app/**` 统一契约，应用不需要为两套账号写两套逻辑。

登录后提示词助手与 Agent 走平台模型（`https://api.callfansai.com`，按点数计费），图像与视频生成也走平台网关。「模型与价格」里平台渠道与自定义渠道**二选一**：选平台渠道不用填 Base URL / API Key；生成模型从平台 `/models` 清单按 `mode` 归类，音频媒体暂未开放，需要使用时可切到「自定义渠道」（用户自填 TreeCloud 兼容 Key，存下即启用），文本模型也会跟着渠道一起切换。

## 架构

```
浏览器 / Electron 窗口
        │  只调本机服务（127.0.0.1:5780）
        ▼
本机 Fastify 服务（packages/server）
        │  OIDC 授权码 + PKCE；Bearer Token
        ├── 个人账号 ── https://sso.callfansai.com/realms/consumer
        └── 企业员工 ── https://sso.callfansai.com/realms/business
        ▼
https://account.callfansai.com/api/v1   （/app/** 身份、余额、模型密钥；个人账号另用 /consumer/** 充值）
```

- 窗口与浏览器**不直连**账号 API；账号 API 的 CORS 白名单也不包含本机来源。
- `access_token` 只保存在本机服务内存里；`refresh_token` 用本机密钥（AES-256-GCM）加密后写入 sql.js 存储，并记下签发它的入口（`consumer` / `enterprise`），重启后按同一 Realm 刷新。
- 登录在**系统浏览器**完成，回调由本机固定的 `127.0.0.1:5781` 监听器接收，只接受 `GET /auth/callback`，校验 `state` 后换码，并校验 ID Token（签名、`iss`、`aud`/`azp`、`exp`/`nbf`、`nonce`）。
- 回环回调要求「浏览器」和「本机服务」在同一台机器上（桌面端、本机 Web 端）。以 `--lan` 暴露给其他设备时，其他设备的浏览器回调会落到它们自己的 5781，登录只能在该服务机本机完成。

## 固定事实

| 项 | 值 |
| --- | --- |
| OIDC Issuer（个人） | `https://sso.callfansai.com/realms/consumer` |
| OIDC Issuer（企业） | `https://sso.callfansai.com/realms/business` |
| API 根 | `https://account.callfansai.com/api/v1` |
| 客户端 | `aigc-callfans`（public，无密钥；两个 Realm 各登记一份） |
| 回调 | `http://127.0.0.1:5781/auth/callback` |
| 积分 | micro，`1 积分 = 1_000_000 micro`，界面按 `micro / 1e6` 展示 |
| 渠道 | `huifu` / `wechat` / `alipay`；`mock` 永远不展示；企业员工不开放充值 |

## 上线前检查

1. Fast-SSO 控制台里该应用 `status=active`、`realm=consumer`、`trust=一方`、`protocol=OIDC`、`clientType=public`。
2. `redirectUris` 包含 `http://127.0.0.1:5781/auth/callback`（逐字符一致，末尾斜杠也算）。
3. 企业入口：`business` Realm 里同名客户端 `aigc-callfans` 已启用，回调与 `webOrigins` 相同，默认 scope 含 `entitled-apps`；`app_client` 表把 `business` / `aigc-callfans` 映射到同一个 `app` 行；企业客户拥有该应用（`tenant_app`），员工被授予准入（`user_app_access`）。
4. 若 5781 被其他程序占用，登录会提示端口占用；换端口必须同时改控制台与 `AIGC_SSO_REDIRECT`。
5. 通过 `AIGC_ACCOUNT_PROVIDER` 以外的环境变量覆盖配置（见下）时，重启应用生效。

## 配置

| 环境变量 | 默认值 |
| --- | --- |
| `AIGC_ACCOUNT_PROVIDER` | `fastsso`（设为 `mock` 时使用开发用 Mock 云） |
| `AIGC_SSO_ISSUER` | `https://sso.callfansai.com/realms/consumer` |
| `AIGC_SSO_ENTERPRISE_ISSUER` | 留空时把 `AIGC_SSO_ISSUER` 的 Realm 名换成 `business` |
| `AIGC_ACCOUNT_API` | `https://account.callfansai.com/api/v1` |
| `AIGC_SSO_CLIENT_ID` | `aigc-callfans` |
| `AIGC_SSO_ENTERPRISE_CLIENT_ID` | 留空沿用 `AIGC_SSO_CLIENT_ID` |
| `AIGC_SSO_REDIRECT` | `http://127.0.0.1:5781/auth/callback` |

设置页「账号与云端」只读展示入口与 API 地址，并提供「测试连接」（Discovery + `/public/consumer/documents`）。

## 本机服务端点

| 端点 | 说明 |
| --- | --- |
| `POST /api/auth/login` | 生成 `state`/`nonce`/PKCE，启动回调监听，返回 `{mode:'browser', loginUrl, expiresIn}`；请求体 `{mode:'consumer'｜'enterprise'}` 选择入口 |
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
| `POST /api/billing/wallet/refresh` | 主动向账号中心查一次余额（页面每 10 秒调一次，结果同时走 SSE `wallet`） |
| `POST /api/billing/orders` | 下单，**必须**带 `Idempotency-Key`（请求体 `idempotencyKey`） |
| `POST /api/billing/orders/:id/prepay` | 获取 `codeUrl`（二维码内容） |
| `POST /api/billing/orders/:id/cancel` | 关闭待支付订单（`/consumer/recharge/orders/{id}/close`） |
| `GET /api/billing/orders/:id` | 轮询订单状态，`paid` 为准 |
| `GET /api/billing/orders` | 最近订单 |
| `POST /api/settings/account/refresh` | 探测账号服务连通性（`/api/settings/cloud/refresh` 的别名） |

## 上游调用

- Discovery：`{issuer}/.well-known/openid-configuration`（缓存 1 小时，按入口分别缓存）。
- 授权：`scope=openid profile email`、`code_challenge_method=S256`。
- 统一契约：身份与余额用 `/api/v1/app/me`、`/app/entitlements/balance`，模型密钥用 `POST /app/llm-keys`；个人账号与企业员工走同一组路径。
  - 个人账号的令牌另可访问 `/api/v1/consumer/**` 与 `/api/v1/public/**`；企业令牌访问 consumer 路径会被拒绝。
  - 老版账号服务没有 `/app/**`（404）时，个人账号自动退回 `/consumer/me`、`/consumer/entitlements/balance`、`/consumer/llm-keys`；企业入口要求升级后的账号服务。
- 充值（仅个人账号）：`/consumer/recharge/skus` → `/channels` → `POST /orders`（`Idempotency-Key`）→ `POST /orders/{id}/prepay` → 轮询 `GET /orders/{id}`。
- 取消：`POST /consumer/recharge/orders/{id}/close`；只有待支付订单能关闭，已支付返回 409。该接口需要账号服务升级到包含 consumer close 的版本。
- 渠道过滤：只保留 `huifu` / `wechat` / `alipay` 且服务端 `enabled=true`；`mock` 一律不展示。
- 登录状态以 ID Token 校验通过 + `/app/entitlements/balance` 成功为准；access token 401 时刷新一次，失败则登出并提示。

## 企业员工模式

登录抽屉提供「个人账号登录」与「企业员工登录」两个按钮，后者用 `business` Realm 的 issuer 和同一个 `clientId` 发起授权码流程。登录成功后：

- `/app/me` 返回 `mode=enterprise`、`tenantId`/`tenantName`、`apps`（已准入应用）、`roles`（租户角色），会话信息随 SSE 同步到界面；账号抽屉展示企业名称与准入范围，不再显示订单与充值。
- 余额读 `/app/entitlements/balance`，是**租户计费账户**在该应用下的余额，由企业统一结算。
- 模型密钥用 `POST /app/llm-keys` 换取：服务端按「租户计费账户 + 员工 + 应用 + 设备」签发，撤销员工准入后下一次申请即失败。
- 关键错误码（均来自 `/app/**`，`code` 字段稳定）：
  - `403 app_not_entitled`：员工未被授予该应用准入，提示联系租户管理员；
  - `403 app_not_registered`：令牌里的 `azp` 在 `app_client` 没有登记；
  - `403 account_disabled`：员工账号已停用；
  - `409 billing_account_inactive`：租户计费账户不可用，联系平台管理员；
  - `403 app_scope_mismatch`：请求了其他应用的积分。
- 企业员工不能注册、找回密码或在应用内充值；账号由租户管理员在控制台「员工目录」创建与重置。

## 开发与测试

```bash
# 用 Mock 云跑通设备码登录、模拟支付与生成
AIGC_ACCOUNT_PROVIDER=mock AIGC_CLOUD_URL=http://127.0.0.1:5790 pnpm dev:server
```

- 单元测试与 e2e 会自动设置 `AIGC_ACCOUNT_PROVIDER=mock`（`packages/server/test/server.test.ts`、`playwright.config.ts`）。
- Mock 云合同见 [`cloud-api-contract.md`](cloud-api-contract.md)，只用于联调，不是安全实现。

## 平台模型（对话）

- 清单：`GET {gatewayBase}/models`，免令牌，缓存 60 秒；`gatewayBase` 默认 `https://api.callfansai.com`，可用 `AIGC_GATEWAY_URL` 覆盖。
- 选模型：`AIGC_CHAT_MODEL` →「模型与价格 · 文本模型」里选的（平台渠道）→ 内置偏好（`deepseek-v4.1-flash-1017`、`claude-haiku-5-5`、`gpt-6-luna`）→ 最便宜的 openai 协议对话模型；不写死。
- 密钥：`POST /app/llm-keys`（个人账号为 `/consumer/llm-keys` 的兼容回退）用当前令牌换一把长期 key，按账号 id 加密存在本机（`Store.setLlmKey`），之后复用；`key` 不出后端、不进日志。
  - 409 `billing_account_provisioning` → 约 30 秒后重试。
  - 409 `litellm_key_exists` → 平台已为本机签发过、但本机副本丢了：带 `recover:true` 自动补发一次（只影响本设备这一把）；补发仍冲突时把服务端信息原样上报。
- 调用：`POST {gatewayBase}/v1/chat/completions`；401 丢本地副本重换一次，422 = 积分不足。
- 失败时提示词辅助回退到规则推断，并在响应里带上原因。

## 平台模型（图像 / 视频生成）

- 模型目录：仍来自免令牌 `GET {gatewayBase}/models`，`mode` 以 `image` / `video` 开头的归到对应类型；价目表在「模型与价格」页面最下方统一展示。
- 图片：`POST {gatewayBase}/v1/images/generations`（`model`、`prompt`、`n`、`response_format=b64_json`），返回的 `b64_json` 保存到本机媒体目录；**不自动重试**。
- 视频：`POST {gatewayBase}/v1/videos`，请求体只有 `model / prompt / seconds / size`（**不传 `resolution`**）；把返回的 `id` 原样存为上游任务 ID，每 3–5 秒 `GET /v1/videos/{id}`，最多等 10 分钟，成功后 `GET /v1/videos/{id}/content` 取 mp4。
- 计费：视频创建返回 200 即已按秒扣费，任务失败也不退；因此失败后**不会自动重建**，重跑需要用户手动确认。应用内这些模型显示「按实际用量」，余额每 10 秒自动刷新。
- 密钥：复用账号会话里的长期 LiteLLM key，只在后端使用；401 时丢本地副本重换一次，422 = 积分不足。

## 尚未接入

- 平台生成网关的**音频**能力（配音 / 音乐 / 音效）：需要时在「模型与价格」切到自定义渠道；音频模型出现在平台清单后会自动出现在对应段。
- 站内支付渠道以外的退款/对账界面：以账号中心后台为准。
