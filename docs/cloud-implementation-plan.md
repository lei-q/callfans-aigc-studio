# 云端系统实施计划

本文是「AIGC 创作台」配套云端系统的实施计划：账号与基础 CRM、积分账本、微信 / 支付宝支付、订单、生成网关、模型请求日志与 token 用量统计、管理后台。
**云端本身不在本仓库开发**；客户端已按 [云端 API 合同](./cloud-api-contract.md) 完成，并附 `packages/cloud-mock` 作为合同的参考实现。云端上线后，客户端只需改 base URL。

> 估算（人力、周期）是按常规中小团队给出的量级，用来排期和评审，不是承诺。支付资质与合规周期不由研发控制，已单列为风险。

## 1. 目标与范围

**目标**

1. 用户用手机号等方式登录，点数、订单、用量跟着账号走，可跨设备。
2. 在线充值：微信支付、支付宝，到账实时、可对账、可退款。
3. 生成与 AI 辅助请求走云端网关：平台持有 TreeCloud Key，按真实用量扣点数，全量记录请求日志。
4. 运营可见：用户 360、订单与支付管理、用量与毛利报表、基础 CRM（标签、分群、触达记录）。

**非目标（本期不做）**

- 创作数据（项目、画板、素材）云同步——客户端仍然只存本机，二期再议。
- 团队空间、多人协作、企业发票系统。
- 自研模型推理；上游仍是 TreeCloud。

## 2. 总体架构

```
 客户端(桌面/Web) ──HTTPS──► API 网关(鉴权 / 限流 / 日志)
                                │
        ┌────────┬──────────┬───┴─────┬──────────┬───────────┐
        ▼        ▼          ▼         ▼          ▼           ▼
      auth    user-crm   billing    payment   gateway     admin-bff
     (登录)   (用户/CRM) (账本)     (支付)   (生成网关)   (管理后台)
                                       │         │
                          微信支付 / 支付宝      metering(计量) ──► TreeCloud(平台 Key 池)
                                       │         │
                          PostgreSQL ◄─┴─────────┤        Redis(会话/限流/幂等/队列)
                          对象存储(结果媒体)      └──► 明细库(ClickHouse 或 TimescaleDB)
```

- **拆分原则**：先做**模块化单体**（同一进程内按上面的边界分包），数据库按模块分 schema；等流量与团队规模需要时再拆服务。过早拆服务会把「扣费 + 生成」这类强一致操作变成分布式事务。
- **强一致边界**：`billing`（账本）与 `gateway`（冻结 / 结算）共用同一个 PostgreSQL 事务边界。
- **技术栈建议**：Node.js（NestJS）或 Go 二选一，取团队熟悉者；PostgreSQL 15+；Redis；对象存储（S3 兼容）；用量明细量大后放 ClickHouse / TimescaleDB。栈选型不影响合同。

## 3. 数据模型

下面是核心表与关键字段，不是完整 DDL。

### 3.1 账号

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `users` | id, nickname, avatar, status, tier, created_at | 账号主体 |
| `identities` | user_id, kind(`phone`/`wechat`/`email`), identifier, verified_at | 登录标识；唯一键 (kind, identifier)；一个用户可绑多个 |
| `devices` | id, user_id, name, client(`desktop`/`web`), last_seen_at | 设备码登录的授权设备 |
| `device_codes` | code, status, user_id, expires_at | 设备码流程状态 |
| `sessions` | id, user_id, device_id, refresh_hash, expires_at, revoked_at | refresh token 只存哈希；**一次性**，刷新即轮换，复用旧 token 视为泄露并吊销整条会话链 |

### 3.2 积分账本

账本采用**复式记账**，余额永远由流水推出，钱包表只是缓存。

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `accounts` | id, owner_type(`user`/`platform`), owner_id, kind(`points`/`free`/`revenue`/`promo`/`frozen`) | 账户：用户积分户、用户免费户、用户冻结户、平台收入户、平台促销户 |
| `ledger_entries` | id, txn_id, account_id, delta, balance_after, reason, ref_type, ref_id, created_at | **只增不改**；同一 `txn_id` 下所有 delta 之和为 0 |
| `wallets` | user_id, balance, free_today, free_date, version | 缓存，乐观锁；与流水每日对账 |

典型记账：

| 事件 | 分录 |
| --- | --- |
| 充值到账 | 平台收入户 −N，用户积分户 +N（赠送部分来自促销户） |
| 创建任务（冻结） | 用户免费户 / 积分户 −C，用户冻结户 +C（先扣免费、再扣余额） |
| 任务成功（结算） | 用户冻结户 −C，平台收入户 +C；实际用量与预估不同则多退少补 |
| 任务失败 / 取消 | 用户冻结户 −C，回原账户 +C |

### 3.3 支付与订单

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `packs` | id, name, amount_cny, points, promo, active | 充值档位与促销规则（首充翻倍等由规则表达，不写死） |
| `orders` | id, user_id, pack_id, amount_cny, points, bonus_points, status, channel, expire_at | 订单状态机见 4.2 |
| `payments` | id, order_id, channel, channel_trade_no, status, raw_notify, notified_at | 一单可多次支付尝试；`raw_notify` 留原文便于审计 |
| `refunds` | id, order_id, payment_id, amount, status, operator, reason | 退款，需审批 |
| `channel_bills` | channel, bill_date, raw, imported_at | 渠道对账单 |

### 3.4 网关与用量

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `gateway_requests` | id, request_id, user_id, kind(`job`/`chat`), model, status, client_job_id, cost_est, cost_final, upstream_id, error_code, latency_ms, created_at | 每个请求一行，`request_id` 贯穿全链路 |
| `gateway_jobs` | id, request_id, params(脱敏), result_refs, frozen_txn_id, settled_txn_id | 生成任务特有信息 |
| `usage_lines` | request_id, dim, quantity, unit_price, amount, price_snapshot_id | **用量归一化明细**，一个请求可有多行（见 5.3） |
| `price_snapshots` | id, model, dim, upstream_cost, sale_price, effective_from | 价格快照，保证历史账单可复算 |
| `model_catalog` | id, type, name, caps, limits, status, price rule | 对客户端暴露的模型目录 |

### 3.5 CRM

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `crm_tags` / `crm_user_tags` | tag, user_id, source(`manual`/`auto`) | 标签；自动标签由规则作业产生 |
| `crm_segments` | id, name, rule(json), refreshed_at | 分群规则（RFM、生命周期、用量段） |
| `crm_events` | user_id, kind, payload, at | 行为事件：注册、首充、首次生成、余额不足、沉默 |
| `crm_notes` | user_id, author, body, at | 客服备注 |
| `crm_touches` | user_id, channel, template, status, at | 运营触达记录（只记录与频控，不含渠道实现） |

## 4. 支付对接

### 4.1 渠道与能力

| 渠道 | 接入方式 | 要点 |
| --- | --- | --- |
| 微信支付 v3 | Native 支付（扫码）；回调为 AEAD 加密 + 平台证书验签 | 平台证书定期轮换要自动拉取；账单 API 下载对账单 |
| 支付宝 | 当面付 `precreate`（扫码）；电脑网站支付（收银台页） | RSA2 验签；异步通知 + 主动查单 |

统一封装 `PaymentChannel` 接口：`createOrder` / `queryOrder` / `closeOrder` / `refund` / `verifyNotify` / `downloadBill`，两个渠道各自实现，业务层不感知差异。

### 4.2 订单状态机

```
created ──支付成功回调(验签+幂等)──► paid ──退款完成──► refunded
   │
   ├──超时 / 用户取消──► closed
   └──关闭后迟到的支付成功──► paid（并告警，走补单流程）
```

### 4.3 可靠性要求

- **只信回调**：点数只在「回调验签通过 + 金额与订单一致 + 订单未处理过」后入账，且入账与订单置 paid 在**同一事务**。
- **幂等**：以 `order_id`（商户订单号）为幂等键；渠道回调可能重复，重复回调直接返回成功。
- **掉单补查**：定时任务扫描 `created` 且超过 N 分钟的订单，主动查单；查到已支付则走同一入账逻辑。
- **日终对账**：下载渠道对账单，与 `payments` 逐笔比对，差异（多单 / 少单 / 金额不符）进差异表并告警。
- **退款**：后台发起 → 审批 → 调渠道 → 回写；退款扣回的点数不足时（用户已花掉）按产品策略处理（拒绝 / 记负余额 / 部分退），**这是需要产品拍板的点**。

## 5. 生成网关与计量

### 5.1 请求链路

1. 鉴权、限流（每用户并发数 + 每分钟请求数，Redis 令牌桶）。
2. 校验参数，按价格规则估价，**冻结**点数（事务）；余额不足返回 `40201`。
3. 选 TreeCloud Key（Key 池轮转、按错误率摘除），提交上游；记录 `upstream_id`。
4. 轮询或回调拿结果；媒体转存对象存储，返回带时效签名 URL。
5. **结算**：按实际用量多退少补，写 `usage_lines`；失败 / 取消解冻。
6. 全程带 `X-Request-Id`，响应与日志、TreeCloud 控制台可对照。

### 5.2 失败与补偿

- 提交上游失败：立即解冻，任务置 failed，带 `fail.fix` 修复建议（沿用客户端已有的错误翻译）。
- 云端进程崩溃：启动时扫描 `frozen` 未结算且超时的任务，按上游实际状态结算或退回。**冻结必须可恢复**，否则会产生永久冻结的点数。
- 用户取消：先调上游取消，成功才解冻；上游已完成则按成功结算。

### 5.3 用量归一化

不同模型的计量口径不同，统一落到 `usage_lines.dim`：

| dim | 适用 | 数量单位 |
| --- | --- | --- |
| `input_tokens` / `output_tokens` / `cache_tokens` | 对话 / 润色 | token |
| `image` | 图像生成 | 张（可再按分辨率分档计价） |
| `video_seconds` | 视频 | 秒 |
| `tts_chars` | 配音 | 字符 |

每行记录 `price_snapshot_id`，所以改价不影响历史账单；同时记录上游成本，毛利 = 售价 − 上游成本，可按模型 / 用户 / 日期汇总。

### 5.4 请求日志规范

- 必有：`request_id`、`user_id`、`model`、`status`、`latency_ms`、`error_code`、`cost_est/final`、`upstream_id`。
- **提示词与参考图属于用户内容**：默认只存哈希与长度；排障需要原文时走后台受控开关，限定保留期并审计访问。
- 日志脱敏：手机号掩码、token 不入日志、支付回调原文只进 `payments.raw_notify`。
- T+1 对账：`gateway_requests` 汇总 vs `ledger_entries` 汇总 vs TreeCloud 账单，三方差异告警。

## 6. CRM 基础

- **用户 360**：资料、登录设备、订单、点数流水、用量、请求日志（按 `request_id` 检索）、备注、标签。
- **标签与分群**：
  - 生命周期：新客（注册 7 天内）/ 活跃 / 沉默（14 天无请求）/ 流失（30 天）；
  - 价值：RFM（最近一次充值 / 充值频次 / 金额）；
  - 用量：按模型类型偏好（图 / 视频 / 配音）。
  - 规则作业每日刷新，结果写 `crm_user_tags`。
- **事件**：关键节点写 `crm_events`，供分群和运营回溯（例如「余额不足但未充值」是转化机会）。
- **触达记录**：只做记录、频控和模板管理；短信 / 站内信 / 邮件的渠道实现是独立工作项。
- **客服**：工单暂用外部系统；后台提供「按 request_id / 订单号定位用户与日志」的搜索即可满足第一阶段。

## 7. 管理后台

| 模块 | 功能 |
| --- | --- |
| 用户 | 查询、用户 360、封禁 / 解封、手动赠点（需原因，进账本） |
| 订单与支付 | 订单查询、补单、退款申请与审批、渠道健康度、对账差异处理 |
| 价格与促销 | 档位与促销规则、模型价格（生成 `price_snapshots`）、模型上下架 |
| 用量与财务 | 用量看板（请求数 / 点数 / 失败率 / 延迟）、毛利报表、Key 池用量与余额 |
| CRM | 标签、分群、触达记录 |
| 审计 | 所有后台写操作留痕（谁、何时、改了什么、原因）；敏感查询（看提示词原文）同样留痕 |

权限按角色拆分（客服 / 运营 / 财务 / 管理员），退款与手动赠点需要二人复核。

## 8. 安全与合规

- **个人信息（PIPL）**：最小化收集（手机号用于登录与实名要求，不收身份证）；隐私政策与用户协议在登录页明示并留存同意记录；用户可注销账号并按规则删除或匿名化。
- **内容安全**：提示词与产出需要按监管要求做内容审核（接入审核服务或上游自带审核，**这一项必须在上线前确认方案**）。
- **支付资质**：需要有主体的商户号（微信支付商户号、支付宝商户），涉及营业执照、行业类目；周期不由研发控制。
- **密钥管理**：TreeCloud Key、支付私钥、平台证书放 KMS / 密钥管理服务，不进代码和日志；Key 池支持热更换。
- **防刷与风控**：新用户赠点是薅羊毛重灾区——设备指纹 + 手机号 + IP 频控 + 黑名单；赠点设上限与观察期。
- **传输与存储**：全站 HTTPS；refresh token 只存哈希；签名 URL 有时效。
- **数据出境**：上游 TreeCloud 若在境外，用户提示词会出境，需评估并在隐私政策披露。

## 9. 里程碑与人力

建议角色：后端 2、前端（后台）1、运维 0.5、产品 0.5；测试由后端与前端自测 + 合同测试兜底。

| 里程碑 | 内容 | 周期 | 验收标准 |
| --- | --- | --- | --- |
| M0 合同冻结 | 评审合同、定技术栈、搭环境与 CI；确认支付资质进度与内容审核方案 | 1 周 | 合同评审通过；预发环境可部署；支付商户号申请已提交 |
| M1 账号 + 账本 + 支付 | 设备码登录、refresh 轮换、复式账本、微信 / 支付宝下单与回调、订单与钱包 API、SSE | 3 周 | 客户端登录与充值全流程在预发通过；回调重放不重复入账；账本日终自检为零差 |
| M2 网关 + 计量 | 冻结 / 结算 / 退回、Key 池、限流、用量归一化、请求日志、模型目录 | 3 周 | `packages/server/test/server.test.ts` 契约测试对预发全绿；崩溃恢复演练通过；三方对账脚本跑通 |
| M3 CRM + 后台 | 用户 360、订单 / 退款审批、价格与促销配置、用量与毛利看板、标签分群 | 3 周 | 客服能凭 request_id 定位问题；退款流程走通且有审计 |
| M4 对账 + 灰度 + 切流 | 渠道日终对账、告警、压测、安全自查、灰度发布 | 2 周 | 对账连续 7 天零未解释差异；压测达标；灰度用户无资金类缺陷 |

合计约 12 周（并行与阻塞情况下会变化）。M1 的最长路径通常是**支付资质**而不是代码。

## 10. 切流方案

1. 客户端已按合同完成；云端按里程碑在预发环境逐步实现，每个里程碑都用客户端的契约测试验证。
2. 灰度：按用户 ID 尾号分批把云端地址指向真实云端（设置里的云端地址 / 随版本下发默认地址）。
3. 双跑期：真实云端上线后保留一周的三方对账（网关请求 / 账本 / TreeCloud 账单）。
4. 回滚：客户端本地不持有任何账务状态，回滚云端版本不需要客户端配合；账务数据只能前滚修复，所以 M4 的对账与演练是上线前提。

## 11. 主要风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 支付资质周期长 | M1 无法上线收款 | M0 就提交申请；开发期用沙箱环境；资质未下来前可只开放赠点体验 |
| 内容审核方案未定 | 无法合规上线 | M0 确认：上游自带审核 or 接第三方；失败请求的计费策略要提前约定 |
| TreeCloud 价格变动 | 毛利被侵蚀 | `price_snapshots` + 毛利日报；售价调整走后台配置而非发版 |
| 用量口径分歧 | 对账差异难以解释 | 归一化维度先和 TreeCloud 账单口径对齐再定型；差异表保留原始数据 |
| 回调丢失 / 延迟 | 用户付了钱不到账 | 主动查单补偿 + 日终对账 + 后台补单入口 |
| 赠点被薅 | 成本损失 | 风控 + 赠点观察期 + 上限；监控新用户首日用量异常 |
| 冻结点数悬挂 | 用户余额「消失」 | 启动恢复作业 + 悬挂冻结告警 |
| 单一上游依赖 | TreeCloud 故障即全停 | Key 池之外预留第二上游的适配层（Provider 接口已抽象） |
