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

## 接入 TreeCloud 真实生成

默认使用**演示渠道**：本地模拟进度，用示意素材出片，不产生任何费用，方便先把流程走一遍。

接入真实模型：

1. 在 [TreeCloud 控制台](https://console.jtreecloud.com) 创建一个 `sk-tc-` 开头的 API Key；
2. 打开应用「设置 · 生成渠道」，填入 Key，点「保存并连接」；
3. 连接成功后会自动切到 TreeCloud 渠道，并按 `GET /v1/models` 返回的结果列出当前 Key 可用的模型。

| 能力 | TreeCloud 接口 | 说明 |
| --- | --- | --- |
| 图像 | `POST /v1/images/generations`；有参考图时 `POST /v1/images/edits` | 比例 + 分辨率换算成模型支持的 `size`；返回的 `b64_json` / `url` 立即保存到本机。**不自动重试**，避免重复计费 |
| 视频 | `POST /api/v3/contents/generations/tasks` → 轮询 `GET …/{id}` | 参考图作为首帧或参考图传入；运镜写进提示词；取消时调用 `DELETE`；应用重启后接着查询 |
| 配音 | `POST /v1/audio/speech` | 音色映射到网关公开音色；音乐与音效 TreeCloud 暂不提供，只能在演示渠道体验 |
| 对话（可选） | `POST /v1/chat/completions` | 开启后「帮我写详细」和 Agent 的「需求理解 / 建议提示词」由对话模型生成，失败时回退到规则推断 |

错误会翻译成「原因 + 修复建议」，并带上响应头里的 `X-Request-Id`，方便到 TreeCloud 控制台核对。Key 用本机密钥加密保存，只会发给你填写的 Base URL。

**关于点数**：应用里的点数钱包是本地预算记账（创建即扣、失败与取消退回、每日免费额度、首充翻倍），充值不涉及真实支付。接入 TreeCloud 后，真实扣费以 TreeCloud 账单为准，可以在「设置 · 本地单价」里按控制台价格调整每个模型的点数单价。

### 本地 OpenAPI

「API 接入」页可以创建 `sk-local-` Key，把本机服务接进脚本或 agent，和网页共用同一份余额：

```bash
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
pnpm dev            # 本机服务（:5780）+ Vite 前端（:5173），改代码自动刷新
pnpm test           # 单元测试与 TreeCloud 合约测试（vitest）
pnpm e2e            # 端到端测试（Playwright，需先 pnpm build）
pnpm lint && pnpm typecheck

pnpm build          # 构建 shared / server / web / desktop
pnpm start:web      # 以 Web 服务方式运行构建产物
pnpm desktop        # 以 Electron 桌面应用运行（首次会弹出运行方式选择）
pnpm dist           # 打当前平台的安装包，产物在 packages/desktop/release
```

国内网络下载 Electron 慢时，可以设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

### 项目结构

```
packages/
  shared/    领域类型、常量、计价与参数校验、计费、Agent 规则推断（前后端共用）
  server/    Fastify 本机服务：sql.js 存储、任务调度、Provider（演示 / TreeCloud）、SSE、本地 OpenAPI
  web/       React + Zustand 前端：生成表单、无限画布、Agent、素材库、审美库、设置…
  desktop/   Electron 外壳：桌面 / Web 双模式、首次启动选择、托盘、安装器定制
resources/samples/   演示渠道的示意素材
prototype/           v0.27 交互原型与原型文档
e2e/                 Playwright 端到端测试
```

- **一个服务，两种外壳**：前端只和本机 HTTP 服务通信。桌面模式由 Electron 内嵌服务并加载窗口；Web 模式由同一程序起服务、托盘常驻；无界面时以 `ELECTRON_RUN_AS_NODE=1` 直接运行服务包。
- **零原生依赖**：数据库用 sql.js（WASM），macOS 双架构可以在一台机器上交叉打包。
- **Provider 层**：`packages/server/src/providers/` 下每个渠道实现同一套接口（模型目录、图像、视频创建与轮询、配音、对话）。新增渠道只需再实现一个 Provider。

### 发布

推送 `v*` 标签即触发 [Release 工作流](.github/workflows/release.yml)：在 macOS（arm64 runner，同时产出 arm64 与 x64）、Windows、Linux 上并行打包，产物与 `SHA256SUMS.txt` 一起上传到 GitHub Release。

```bash
git tag v0.1.0 && git push origin v0.1.0
```

配置 `CSC_LINK` / `CSC_KEY_PASSWORD`（以及 macOS 的 `APPLE_INSTALLER_IDENTITY`）secrets 后会自动启用代码签名。

## 许可

[GPL-3.0](LICENSE)
