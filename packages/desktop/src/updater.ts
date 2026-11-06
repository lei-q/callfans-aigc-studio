import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { app, BrowserWindow, dialog, net, Notification } from 'electron';
import { isNewerVersion, pickUpdateAsset, type UpdateAsset, type UpdateState } from '@aigc/shared';

/* ============================================================================
   自动更新（GitHub Release）
   - 启动时距上次检查超过 12 小时就查一次，之后每 12 小时查一次；也可以在设置里手动查
   - 有更新时页面弹窗让用户确认；确认后先在后台下载并校验 SHA256
   - 下载完成后等本机没有「执行中 / 排队中」的任务再启动安装；有任务就每分钟再看一次
   ========================================================================== */

const REPO = 'lei-q/callfans-aigc-studio';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY = 12 * 60 * 60 * 1000;
const IDLE_POLL = 60 * 1000;
const FIRST_CHECK_DELAY = 20 * 1000;

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  assets?: UpdateAsset[];
}

interface Target {
  version: string;
  asset: UpdateAsset;
  sha256?: string;
  pageUrl?: string;
}

interface Persisted {
  checkedAt?: number;
  dismissedVersion?: string;
}

export class Updater {
  private state: UpdateState = { stage: 'idle', currentVersion: app.getVersion(), version: null };
  private target: Target | null = null;
  private dismissedVersion: string | null = null;
  private checkedAt = 0;
  private checking = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private downloadFile: string | null = null;
  private jobs: (() => number) | null = null;
  /** Web 服务模式没有页面 UI，用系统弹窗提示更新 */
  private nativePrompt = false;
  private prompting = false;

  private get metaFile() {
    return path.join(app.getPath('userData'), 'update-check.json');
  }

  init(nativePrompt = false) {
    if (this.started) return;
    this.started = true;
    this.nativePrompt = nativePrompt;
    this.load();
    this.state.currentVersion = app.getVersion();
    /* 距上次检查超过 12 小时就尽快查一次，否则等到 12 小时后再查 */
    const due = Math.max(FIRST_CHECK_DELAY, this.checkedAt + CHECK_EVERY - Date.now());
    this.timer = setTimeout(() => {
      void this.check(false);
      this.interval = setInterval(() => void this.check(false), CHECK_EVERY);
    }, due);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.timer = this.interval = this.idleTimer = null;
  }

  /** 本机服务里的任务计数：等空闲时用它判断能不能退出安装 */
  setActiveJobs(fn: () => number) {
    this.jobs = fn;
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  async check(manual: boolean): Promise<UpdateState> {
    if (this.checking) return this.getState();
    if (this.state.stage === 'downloading' || this.state.stage === 'waiting' || this.state.stage === 'installing') return this.getState();
    this.checking = true;
    this.patch({ stage: 'checking', message: undefined, manual });
    try {
      const res = await net.fetch(API_LATEST, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `AIGC-Studio-Updater/${app.getVersion()}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(res.status === 404 ? '还没有发布版本' : `GitHub 返回 HTTP ${res.status}`);
      const release = (await res.json()) as GitHubRelease;
      const version = String(release.tag_name || '').replace(/^v/i, '');
      if (!version) throw new Error('Release 缺少版本号');
      this.checkedAt = Date.now();

      if (!isNewerVersion(version, app.getVersion())) {
        this.target = null;
        this.patch({ stage: 'idle', version: null, checkedAt: this.checkedAt, message: manual ? '已经是最新版本' : undefined });
        this.save();
        return this.getState();
      }

      const asset = pickUpdateAsset(release.assets || [], process.platform, process.arch, !!process.env.APPIMAGE);
      if (!asset || !(asset.url || asset.browser_download_url)) throw new Error('这个版本还没有适合当前系统的安装包');
      const sha256 = await this.sumOf(release.assets || [], asset.name);
      this.target = { version, asset, sha256, pageUrl: release.html_url };
      this.patch({
        stage: 'available',
        version,
        checkedAt: this.checkedAt,
        message: undefined,
        pageUrl: release.html_url,
        size: asset.size,
        dismissed: this.dismissedVersion === version,
        percent: undefined,
        transferred: undefined,
        total: undefined,
        busy: undefined,
      });
      this.save();
      if (!manual && this.dismissedVersion !== version) this.announce(version);
    } catch (e) {
      this.target = null;
      this.patch({ stage: 'error', message: (e as Error).message || '检查更新失败', checkedAt: Date.now(), manual });
    } finally {
      this.checking = false;
    }
    return this.getState();
  }

  /** 用户确认后开始下载；下载完先查一次是否空闲 */
  async download(): Promise<UpdateState> {
    if (this.state.stage !== 'available' || !this.target) return this.getState();
    const t = this.target;
    const urls = [t.asset.url, t.asset.browser_download_url].filter((x): x is string => !!x);
    /* 只接受本仓库 Release 的资产地址：API 资产地址或下载页地址 */
    const ok = urls.some(
      (u) =>
        /^https:\/\/api\.github\.com\/repos\/lei-q\/callfans-aigc-studio\/releases\/assets\/\d+$/.test(u) ||
        /^https:\/\/github\.com\/lei-q\/callfans-aigc-studio\/releases\/download\//.test(u),
    );
    if (!ok) {
      this.patch({ stage: 'error', message: '安装包地址不合法，已停止下载' });
      return this.getState();
    }

    const dir = path.join(app.getPath('temp'), 'aigc-studio-update');
    const file = path.join(dir, t.asset.name.replace(/[\\/:*?"<>|]/g, '_'));
    this.patch({ stage: 'downloading', percent: 0, transferred: 0, total: t.asset.size, message: undefined, busy: undefined, nextCheckAt: undefined });
    try {
      await fsp.mkdir(dir, { recursive: true });
      const res = await this.fetchAsset(urls);
      if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）`);
      const total = Number(res.headers.get('content-length')) || t.asset.size || 0;
      let got = 0;
      let last = 0;
      const hash = crypto.createHash('sha256');
      const meter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          got += chunk.length;
          hash.update(chunk);
          const now = Date.now();
          if (now - last > 400) {
            last = now;
            this.patch({ transferred: got, total: total || undefined, percent: total ? Math.min(99, Math.round((got / total) * 100)) : undefined });
          }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream), meter, fs.createWriteStream(file));
      if (total && got !== total) throw new Error('下载不完整，请重试');
      if (t.sha256) {
        const actual = hash.digest('hex');
        if (actual !== t.sha256) {
          await fsp.rm(file, { force: true });
          throw new Error('安装包校验失败，已删除下载文件');
        }
      }
      this.downloadFile = file;
      this.patch({ stage: 'waiting', percent: 100, transferred: got, total: total || undefined, nextCheckAt: Date.now() });
      if (this.nativePrompt) this.notify('更新已下载', '等当前任务全部结束后会自动安装并重启。');
      this.scheduleIdle(0);
    } catch (e) {
      const message = (e as Error).message || '下载失败';
      this.patch({ stage: 'error', message });
      if (this.nativePrompt) this.errorBox(message);
    }
    return this.getState();
  }

  dismiss() {
    this.dismissedVersion = this.state.version;
    this.patch({ dismissed: true });
    this.save();
  }

  /* ---------------- 下载完成后等空闲 ---------------- */

  private scheduleIdle(delay: number) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.idleTick(), delay);
  }

  private async idleTick() {
    if (this.state.stage !== 'waiting' || !this.downloadFile) return;
    const busy = this.activeJobs();
    if (busy === null) {
      this.patch({ busy: undefined, message: '本机服务暂时没有响应，稍后再检查', nextCheckAt: Date.now() + IDLE_POLL });
      this.scheduleIdle(IDLE_POLL);
      return;
    }
    if (busy > 0) {
      this.patch({ busy, message: undefined, nextCheckAt: Date.now() + IDLE_POLL });
      this.scheduleIdle(IDLE_POLL);
      return;
    }
    await this.install();
  }

  /** 返回执行中 + 排队中的任务数；拿不到返回 null（宁可多等一分钟，也不在任务中途退出） */
  private activeJobs(): number | null {
    if (!this.jobs) return null;
    try {
      return this.jobs();
    } catch {
      return null;
    }
  }

  private async install() {
    if (!this.downloadFile) return;
    if (!fs.existsSync(this.downloadFile)) {
      this.patch({ stage: 'error', message: '下载文件已不存在，请重新检查更新' });
      return;
    }
    this.patch({ stage: 'installing', message: undefined, nextCheckAt: undefined });
    /* 给页面一点时间把「正在启动安装程序」显示出来，同时也再确认一次没有新任务 */
    await new Promise((r) => setTimeout(r, 800));
    const busy = this.activeJobs();
    if (busy === null || busy > 0) {
      this.patch({
        stage: 'waiting',
        busy: busy ?? undefined,
        message: busy === null ? '暂时读不到任务状态，稍后再试' : undefined,
        nextCheckAt: Date.now() + IDLE_POLL,
      });
      this.scheduleIdle(IDLE_POLL);
      return;
    }
    if (this.nativePrompt) this.notify('正在安装更新', '应用即将退出，安装程序会自动打开，装完会重新启动。');
    try {
      launchInstaller(this.downloadFile);
    } catch (e) {      const message = `启动安装程序失败：${(e as Error).message}`;
      this.patch({ stage: 'error', message });
      if (this.nativePrompt) this.errorBox(message);
      return;
    }
    /* 安装程序需要替换正在运行的程序，先退出；Windows / Linux 的辅助脚本会在安装完后再拉起 */
    setTimeout(() => app.quit(), 800);
  }

  /* ---------------- 辅助 ---------------- */

  private patch(partial: Partial<UpdateState>) {
    this.state = { ...this.state, ...partial };
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('update:state', this.state);
    }
  }

  /** 主动告知有更新：有可见窗口就交给页面弹窗；没有窗口时桌面模式发通知，Web 模式用系统弹窗 */
  private announce(version: string) {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    if (wins.some((w) => w.isVisible())) return;
    if (wins.length) {
      this.notify(`发现新版本 v${version}`, '打开窗口即可选择下载更新。');
      return;
    }
    if (this.nativePrompt) {
      void this.promptNative(version);
      return;
    }
    this.notify(`发现新版本 v${version}`, '打开应用后可在设置里下载更新；有任务进行时会等任务完成后再安装。');
  }

  /** Web 服务模式没有页面：用系统弹窗询问是否下载 */
  private async promptNative(version: string) {
    if (this.prompting) return;
    this.prompting = true;
    try {
      if (process.platform === 'darwin') app.focus({ steal: true });
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `AIGC 创作台 v${version} 可以更新`,
        detail: '确认后先在后台下载，不影响正在执行的任务；等任务全部结束后才会安装并重启。',
        buttons: ['下载并更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) void this.download();
      else this.dismiss();
    } finally {
      this.prompting = false;
    }
  }

  private errorBox(message: string) {
    if (process.platform === 'darwin') app.focus({ steal: true });
    void dialog.showMessageBox({ type: 'error', title: '更新失败', message: '更新没有完成', detail: message, buttons: ['知道了'], noLink: true });
  }

  private notify(title: string, body: string) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win) {
        win.show();
        win.focus();
      }
    });
    n.show();
  }

  /** 优先走 API 资产地址（会重定向到真实下载地址），失败再退回下载页地址 */
  private async fetchAsset(urls: string[]): Promise<Response> {
    let last: Response | null = null;
    let lastErr: unknown = null;
    for (const u of urls) {
      try {
        const res = await net.fetch(u, {
          headers: {
            'User-Agent': `AIGC-Studio-Updater/${app.getVersion()}`,
            ...(u.includes('api.github.com') ? { Accept: 'application/octet-stream' } : {}),
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(30 * 60 * 1000),
        });
        if (res.ok) return res;
        last = res;
      } catch (e) {
        lastErr = e;
      }
    }
    if (last) return last;
    throw lastErr instanceof Error ? lastErr : new Error('下载失败');
  }

  private async sumOf(assets: UpdateAsset[], name: string): Promise<string | undefined> {
    const sums = assets.find((a) => a.name === 'SHA256SUMS.txt');
    const url = sums?.url || sums?.browser_download_url;
    if (!url) return undefined;
    try {
      const res = await net.fetch(url, {
        headers: {
          'User-Agent': `AIGC-Studio-Updater/${app.getVersion()}`,
          ...(url.includes('api.github.com') ? { Accept: 'application/octet-stream' } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return undefined;
      const text = await res.text();
      for (const line of text.split('\n')) {
        const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
        if (m && m[2].trim() === name) return m[1].toLowerCase();
      }
    } catch {
      /* 校验文件拿不到就跳过校验：安装包本身仍来自本仓库的 Release */
    }
    return undefined;
  }

  private load() {
    try {
      const p = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')) as Persisted;
      this.checkedAt = Number(p.checkedAt) || 0;
      this.dismissedVersion = typeof p.dismissedVersion === 'string' ? p.dismissedVersion : null;
    } catch {
      /* 第一次运行没有记录 */
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.metaFile), { recursive: true });
      const p: Persisted = { checkedAt: this.checkedAt, dismissedVersion: this.dismissedVersion || undefined };
      fs.writeFileSync(this.metaFile, JSON.stringify(p, null, 2));
    } catch {
      /* 记录写失败不影响更新本身 */
    }
  }
}

function spawnDetached(cmd: string, args: string[]) {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  p.unref();
}

function launchInstaller(file: string) {
  if (process.platform === 'darwin') {
    /* .pkg 交给系统安装器；装完（安装器关闭）后重新打开应用 */
    spawnDetached('sh', ['-c', 'sleep 1; open -W "$1"; open "/Applications/AIGC Studio.app"', 'sh', file]);
    return;
  }
  if (process.platform === 'win32') {
    /* 静默安装，装完再拉起新版本；本进程会先退出，避免文件被占用 */
    const cmd = `"${file}" /S & start "" "${process.execPath}"`;
    spawnDetached('cmd.exe', ['/c', cmd]);
    return;
  }
  const appImage = process.env.APPIMAGE;
  if (appImage) {
    /* 退出后用新 AppImage 覆盖旧文件并启动 */
    spawnDetached('sh', ['-c', 'sleep 1; mv "$1" "$2"; chmod +x "$2"; "$2" >/dev/null 2>&1 &', 'sh', file, appImage]);
    return;
  }
  spawnDetached('xdg-open', [file]);
}
