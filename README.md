# AIGC 创作台

> 不用订阅，按次付费，说一句就能出片。

面向社媒运营与偶尔有突发需求的个人用户：写一句大白话就能生成图像、视频和配音；右侧是一块 PureRef 式的无限画布，用来收集参考、整理思路、发散方向；Agent 读懂画板后帮你把想法写成提示词。

同一套代码同时提供 **桌面应用（GUI）** 和 **Web 服务（浏览器访问）** 两种运行方式，安装时自行选择，之后也能随时切换。支持 macOS（Apple 芯片 / Intel）、Windows、Linux。

产品规格见 [`prototype/原型文档.md`](prototype/原型文档.md)，交互原型保留在 [`prototype/`](prototype/) 目录里作对照。

---

## 下载与安装

到 [Releases](https://github.com/lei-q/callfans-aigc-studio/releases) 下载对应平台的安装包：

| 系统 | 文件 | 安装时如何选择运行方式 |
| --- | --- | --- |
| Windows 10/11 x64 | `AIGC-Studio-<版本>-win-x64.exe` | 安装向导里的「选择运行方式」页 |
| macOS Apple 芯片 | `AIGC-Studio-<版本>-mac-arm64.pkg`（推荐）/ `.dmg` | `.pkg` 的「自定义安装」里勾选「以 Web 服务方式运行」；`.dmg` 首次启动时选择 |
| macOS Intel 芯片 | `AIGC-Studio-<版本>-mac-x64.pkg`（推荐）/ `.dmg` | 同上 |
| Linux x64 | `.AppImage` / `.deb` | 首次启动时选择；`.deb` 另装一个 `aigc-studio-web` 命令，给没有桌面环境的服务器用 |

安装包暂未做代码签名：macOS 首次打开请右键 →「打开」；Windows 出现 SmartScreen 提示时点「更多信息 → 仍要运行」。

### 两种运行方式

- **桌面应用**：独立窗口。内置服务只监听 `127.0.0.1` 的随机端口，并用每次启动随机生成的会话口令保护，别的程序访问不到。
- **Web 服务**：后台运行，托盘（macOS 菜单栏）常驻，用系统浏览器打开 `http://127.0.0.1:5780`。可以在「设置 · 运行模式」里开放给局域网，开放前必须设置访问口令。

两种方式共用同一份数据。数据目录：

| 系统 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/AIGC Studio` |
| Windows | `%APPDATA%\AIGC Studio` |
| Linux | `~/.config/AIGC Studio` |

无界面服务器上可以直接运行：`aigc-studio-web --port 5780 --lan`（`.deb` 安装后可用；Windows 在安装目录 `resources\bin\aigc-studio-web.cmd`）。

---

## 账号、点数与生成

首次启动是一个干净的空项目：没有示例素材，也没有假数据。生成与对话有两条渠道，在「模型与价格」里可以看到当前走哪条：

- **平台渠道（默认，`api.callfansai.com`）**：注册、登录、找回密码与充值都由账号中心完成，点数跟着账号走，换设备也不丢。登录后，提示词助手与 Agent 直接调用平台模型（按点数计费），不需要任何配置；模型清单与「辅助模型」选择都在「模型与价格」里。
- **自定义渠道（TreeCloud 兼容）**：在「模型与价格 · 自定义渠道」填自己的 Base URL 与 `sk-tc-` Key，点「保存并启用」就切换到自己的上游，**不扣平台点数**，费用由上游结算。图片、视频与配音目前只走这条渠道（平台网关还没有接入媒体模型）。

没有登录、也没有配置自定义渠道时，生成按钮会变成「登录后生成」。

### 登录、注册与充值

- **登录**：标准 OIDC 授权码 + PKCE。点「登录」后用系统浏览器打开 `sso.callfansai.com`，授权完成后浏览器回调到本机固定端口 `http://127.0.0.1:5781/auth/callback`，应用自动继续。access token 只放在本机服务内存里，refresh token 加密落盘；浏览器与窗口从不直连账号 API。
- **注册 / 找回密码**：应用内表单，验证码与密码规则由账号中心下发（6 位验证码、密码 10–128 位）；条款版本从 `/public/consumer/documents` 读取。
- **充值**：档位与渠道每次都从账号服务拉取（`/consumer/recharge/skus`、`/consumer/recharge/channels`，目前为汇付聚合 / 微信 / 支付宝）。选档位 → 下单（带幂等键）→ 展示收款码 → 轮询订单直到 `paid`。二维码内容是 `codeUrl`，应用本地渲染，不会把扫码串当跳转链接。
- **账号配置**：见 [`docs/fast-sso-integration.md`](docs/fast-sso-integration.md)，可用环境变量 `AIGC_SSO_ISSUER`、`AIGC_ACCOUNT_API`、`AIGC_SSO_CLIENT_ID`、`AIGC_SSO_REDIRECT` 覆盖。

> 开发与 CI 默认可以切回 Mock 云（`AIGC_ACCOUNT_PROVIDER=mock` + `AIGC_CLOUD_URL=http://127.0.0.1:5790`）：设备码登录、模拟扫码支付、生成与扣费都能跑通，**不涉及真实付款**。仓库里的 `packages/cloud-mock` 只用于联调和测试。

> 使用 Fast-SSO 前需要在控制台把 `http://127.0.0.1:5781/auth/callback` 加进该应用的 `redirectUris`（逐字符一致），并确认应用 `realm=consumer`、`trust=一方`、`status=active`、`clientType=public`。

### 平台模型（对话）

「帮我写详细」和 Agent 的「需求理解 / 建议提示词」由平台模型生成，走 LiteLLM 网关 `https://api.callfansai.com`：

1. 模型清单 `GET /models` 免令牌，运行时拉取并缓存 60 秒，「模型与价格」页会列出来；选择顺序为 `AIGC_CHAT_MODEL` → 你在「辅助模型」里选的 → 内置偏好（`deepseek-v4.1-flash-1017` 等，清单里没有就跳过）→ 最便宜的 openai 协议对话模型。模型名不写死在客户端。
2. 模型密钥由本机服务用该账号的 consumer token 换一次（`POST /consumer/llm-keys`，每个用户每个应用一把、默认不过期），**加密存在本机**，之后一直复用；前端、日志里都不会出现 `sk-`。
3. 调用 `POST /v1/chat/completions`，扣的是该账号在这个应用池里的点数。网关 422 = 积分不足（充值后再试），401 = key 被吊销（丢本地副本后只重换一次）。
4. 换 key 返回 409 `litellm_key_exists` 时不重试：说明平台已签发过、本机没有副本，需要先在平台吊销。

可用环境变量 `AIGC_GATEWAY_URL` 覆盖网关地址（默认 `https://api.callfansai.com`）。

### 自定义渠道（TreeCloud 兼容）

1. 在 [TreeCloud 控制台](https://console.jtreecloud.com) 创建一个 `sk-tc-` 开头的 API Key；
2. 打开应用「模型与价格 · 自定义渠道」，填 Base URL 与 Key，点「保存并启用」——没有单独的开关，存下 Key 就是启用；
3. 连接成功后会按 `GET /v1/models` 返回的结果列出当前 Key 可用的模型，生成改用这个渠道；「清除 Key」会同时关闭它，生成回到平台渠道。

| 能力 | TreeCloud 接口 | 说明 |
| --- | --- | --- |
| 图像 | `POST /v1/images/generations`；有参考图时 `POST /v1/images/edits` | 比例 + 分辨率换算成模型支持的 `size`；返回的 `b64_json` / `url` 立即保存到本机。**不自动重试**，避免重复计费 |
| 视频 | `POST /api/v3/contents/generations/tasks` → 轮询 `GET …/{id}` | 参考图作为首帧或参考图传入；运镜写进提示词；取消时调用 `DELETE`；应用重启后接着查询 |
| 配音 | `POST /v1/audio/speech` | 音色映射到网关公开音色。TreeCloud 暂不提供音乐与音效，所以这两类在自定义渠道里不可用 |

错误会翻译成「原因 + 修复建议」，并带上响应头里的 `X-Request-Id`，方便到 TreeCloud 控制台核对。Key 用本机密钥加密保存，只会发给你填写的 Base URL。

### 本地 OpenAPI

本机服务仍暴露 `sk-local-` Key 鉴权的本地 OpenAPI，方便脚本接入（界面里不再提供创建入口）。Key 只在本机创建与校验，和网页共用同一份模型与账号：

```bash
# 创建一把本地 Key（完整 Key 只在响应里出现一次）
curl -X POST http://127.0.0.1:5780/api/keys

curl http://127.0.0.1:5780/openapi/v1/images/generations \
  -H "Authorization: Bearer $AIGC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "暖橙主色背景，哑光纸杯居中", "n": 2, "size": "1024x1024"}'
```

异步任务：`POST /openapi/v1/jobs` 提交，`GET /openapi/v1/jobs/:id` 轮询；`GET /openapi/v1/models` 列出可用模型。

---

## 开发

需要 Node.js ≥ 22.12 与 pnpm 10。

```bash
pnpm install
pnpm dev            # Mock 云（:5790）+ 本机服务（:5780）+ Vite 前端（:5173），改代码自动刷新（账号默认走 Fast-SSO，见下方环境变量）
pnpm test           # 单元测试，以及对着 Mock 云的云端合同测试（vitest）
pnpm e2e            # 端到端测试（Playwright，自动起 Mock 云与本机服务，需先构建 web 与 server）
pnpm lint && pnpm typecheck

pnpm build          # 构建 shared / server / web / desktop
pnpm start:web      # 以 Web 服务方式运行构建产物
pnpm desktop        # 以 Electron 桌面应用运行（首次会弹出运行方式选择）
pnpm dist           # 打当前平台的安装包，产物在 packages/desktop/release
```

`pnpm dev` 里的 `dev:server` 用了行内环境变量写法，Windows 下请在 Git Bash / WSL 中运行，或自己先设置 `AIGC_CLOUD_URL=http://127.0.0.1:5790` 再分别启动。开发时想用 Mock 云跑通登录与充值，加 `AIGC_ACCOUNT_PROVIDER=mock`（单测与 e2e 已自动设置）。

国内网络下载 Electron 慢时，可以设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

### 项目结构

```
packages/
  shared/    领域类型、常量、计价与参数校验、云端合同类型、Agent 规则推断（前后端共用）
  server/    Fastify 本机服务：sql.js 存储、任务调度、云端会话、Provider（平台网关 / 自定义渠道）、SSE、本地 OpenAPI
  web/       React + Zustand 前端：生成表单、无限画布、Agent、素材库、审美库、设置…
  cloud-mock/ 开发 / 演示 / CI 用的 Mock 云，实现云端合同（不打包进安装包）
  desktop/   Electron 外壳：桌面 / Web 双模式、首次启动选择、托盘、安装器定制
docs/                云端 API 合同与云端实施计划
prototype/           v0.27 交互原型与原型文档
e2e/                 Playwright 端到端测试
```

- **一个服务，两种外壳**：前端只和本机 HTTP 服务通信。桌面模式由 Electron 内嵌服务并加载窗口；Web 模式由同一程序起服务、托盘常驻；无界面时以 `ELECTRON_RUN_AS_NODE=1` 直接运行服务包。
- **零原生依赖**：数据库用 sql.js（WASM），macOS 双架构可以在一台机器上交叉打包。
- **Provider 层**：`packages/server/src/providers/` 下每个渠道（平台网关、自定义渠道）实现同一套接口（模型目录、图像、视频创建与轮询、配音、对话）。新增渠道只需再实现一个 Provider。

### 发布

推送 `v*` 标签即触发 [Release 工作流](.github/workflows/release.yml)：在 macOS（arm64 runner，同时产出 arm64 与 x64）、Windows、Linux 上并行打包，产物与 `SHA256SUMS.txt` 一起上传到 GitHub Release。

```bash
git tag v0.4.0 && git push origin v0.4.0
```

配置 `CSC_LINK` / `CSC_KEY_PASSWORD`（以及 macOS 的 `APPLE_INSTALLER_IDENTITY`）secrets 后会自动启用代码签名。

## 许可

[GPL-3.0](LICENSE)
