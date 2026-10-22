import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from 'electron';

/* ============================================================================
   AIGC 创作台 · 桌面主进程
   同一个程序两种运行方式：
     - 桌面应用：内嵌本机服务（127.0.0.1 随机端口 + 会话口令），独立窗口
     - Web 服务：内嵌本机服务（默认 5780），托盘常驻，用系统浏览器访问
   运行方式的来源（优先级从高到低）：
     命令行 --mode=desktop|web > 安装器留下的 pending-mode.json > 用户数据目录的 launch-mode.json
     > 系统级 launch-mode.json（macOS .pkg） > 首次启动时弹窗选择
   ========================================================================== */

type Mode = 'desktop' | 'web';
interface LaunchConfig {
  mode?: Mode;
  host?: string;
  port?: number;
  lan?: boolean;
}
interface ServerModule {
  startServer(o: {
    dataDir: string;
    webDir?: string;
    mode: Mode;
    desktop: boolean;
    host?: string;
    port?: number;
    accessToken?: string;
    version?: string;
  }): Promise<{ url: string; port: number; generatedToken?: string; close(): Promise<void> }>;
}

app.setName('AIGC Studio');
const isDev = !app.isPackaged;
const userData = app.getPath('userData');
const launchFile = path.join(userData, 'launch-mode.json');
const pendingFile = path.join(userData, 'pending-mode.json');

const res = (...p: string[]) => (isDev ? path.join(__dirname, '..', '..', ...p) : path.join(process.resourcesPath, ...p));
const serverEntry = () => (isDev ? path.join(__dirname, '..', '..', 'server', 'dist', 'server.cjs') : res('server', 'server.cjs'));
const webDir = () => (isDev ? path.join(__dirname, '..', '..', 'web', 'dist') : res('web'));
const iconPath = () => path.join(__dirname, 'icon.png');

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
function writeLaunch(patch: LaunchConfig) {
  fs.mkdirSync(userData, { recursive: true });
  const next = { ...(readJson<LaunchConfig>(launchFile) || {}), ...patch };
  fs.writeFileSync(launchFile, JSON.stringify(next, null, 2));
  return next;
}

function argMode(): Mode | null {
  const a = process.argv.find((x) => x.startsWith('--mode='));
  const v = a?.split('=')[1];
  return v === 'web' || v === 'desktop' ? v : null;
}

/** 安装器在安装时留下的选择：只生效一次，合并进 launch-mode.json 后删除 */
function applyPending() {
  const p = readJson<{ mode?: string }>(pendingFile);
  if (p && (p.mode === 'web' || p.mode === 'desktop')) writeLaunch({ mode: p.mode });
  if (p) fs.rmSync(pendingFile, { force: true });
}

function systemMode(): Mode | null {
  const files = [res('launch-mode.json')];
  if (process.platform === 'darwin') files.push('/Library/Application Support/AIGC Studio/launch-mode.json');
  for (const f of files) {
    const m = readJson<{ mode?: string }>(f)?.mode;
    if (m === 'web' || m === 'desktop') return m;
  }
  return null;
}

/* ---------------- 首次启动：选择运行方式 ---------------- */

function chooseMode(): Promise<Mode | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 640,
      height: 440,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: '选择运行方式 · AIGC 创作台',
      icon: iconPath(),
      backgroundColor: '#F6F7F9',
      show: false,
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let done = false;
    const onChoose = (_e: unknown, mode: string) => {
      if (mode !== 'web' && mode !== 'desktop') return;
      done = true;
      ipcMain.removeListener('choose-mode', onChoose);
      resolve(mode);
      win.close();
    };
    ipcMain.on('choose-mode', onChoose);
    win.on('closed', () => {
      ipcMain.removeListener('choose-mode', onChoose);
      if (!done) resolve(null);
    });
    win.once('ready-to-show', () => win.show());
    void win.loadFile(path.join(__dirname, 'chooser.html'));
  });
}

/* ---------------- 启动服务 ---------------- */

let server: Awaited<ReturnType<ServerModule['startServer']>> | null = null;
let mainWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let mode: Mode = 'desktop';

function loadServer(): ServerModule {
  return require(serverEntry()) as ServerModule;
}

async function startDesktop() {
  const token = crypto.randomBytes(24).toString('hex');
  server = await loadServer().startServer({
    dataDir: userData,
    webDir: webDir(),
    mode: 'desktop',
    desktop: true,
    host: '127.0.0.1',
    port: 0,
    accessToken: token,
    version: app.getVersion(),
  });
  await session.defaultSession.cookies.set({ url: server.url, name: 'aigc_token', value: token, httpOnly: true, sameSite: 'lax' });
  createWindow(server.url);
}

function createWindow(url: string) {
  mainWin = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    title: 'AIGC 创作台',
    icon: iconPath(),
    backgroundColor: '#F6F7F9',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  mainWin.once('ready-to-show', () => mainWin?.show());
  /* 同源的新窗口（打开本地文档、原图）留在应用里；外部链接交给系统浏览器 */
  mainWin.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: iconPath() } };
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    }
  });
  mainWin.on('closed', () => (mainWin = null));
  void mainWin.loadURL(url);
}

async function startWeb() {
  const cfg = readJson<LaunchConfig>(launchFile) || {};
  const host = cfg.lan ? '0.0.0.0' : cfg.host || '127.0.0.1';
  const base = cfg.port || 5780;
  let lastErr: unknown = null;
  for (let port = base; port < base + 10; port++) {
    try {
      server = await loadServer().startServer({
        dataDir: userData,
        webDir: webDir(),
        mode: 'web',
        desktop: false,
        host,
        port,
        version: app.getVersion(),
      });
      break;
    } catch (e) {
      lastErr = e;
      if ((e as { code?: string }).code !== 'EADDRINUSE') break;
    }
  }
  if (!server) throw lastErr;
  if (process.platform === 'darwin') app.dock?.hide();
  createTray();
  if (!process.env.AIGC_NO_BROWSER) void shell.openExternal(server.url);
  const lanTip = host === '0.0.0.0' ? '，局域网里的其他设备可以用本机 IP 访问' : '';
  if (Notification.isSupported() && !process.env.AIGC_NO_BROWSER) {
    new Notification({
      title: 'AIGC 创作台 · Web 服务已启动',
      body: `${server.url}${lanTip}${server.generatedToken ? `\n访问口令：${server.generatedToken}` : ''}`,
    }).show();
  }
}

function createTray() {
  if (!server) return;
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') img.setTemplateImage(false);
  tray = new Tray(img);
  tray.setToolTip(`AIGC 创作台 · ${server.url}`);
  const url = server.url;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Web 服务运行中 · ${url}`, enabled: false },
      ...(server.generatedToken ? [{ label: `访问口令：${server.generatedToken}`, enabled: false }] : []),
      { type: 'separator' },
      { label: '在浏览器中打开', click: () => void shell.openExternal(url) },
      { label: '复制访问地址', click: () => clipboard.writeText(url) },
      { label: '打开数据目录', click: () => void shell.openPath(userData) },
      { type: 'separator' },
      {
        label: '改为桌面应用方式运行',
        click: () => {
          writeLaunch({ mode: 'desktop' });
          app.relaunch({ args: process.argv.slice(1).filter((a) => !a.startsWith('--mode=')) });
          app.exit(0);
        },
      },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => void shell.openExternal(url));
}

/* ---------------- IPC：给页面用的少量能力 ---------------- */

ipcMain.handle('app:info', () => ({ mode, version: app.getVersion(), dataDir: userData }));
ipcMain.on('app:relaunch', () => {
  app.relaunch({ args: process.argv.slice(1).filter((a) => !a.startsWith('--mode=')) });
  app.exit(0);
});
ipcMain.on('app:open-path', (_e, p: string) => {
  if (typeof p === 'string' && p.startsWith(userData)) void shell.openPath(p);
});
ipcMain.on('app:open-external', (_e, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url);
});

/* ---------------- 生命周期 ---------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    } else if (server) {
      void shell.openExternal(server.url);
    }
  });

  app.whenReady().then(async () => {
    try {
      applyPending();
      const chosen = argMode() || readJson<LaunchConfig>(launchFile)?.mode || systemMode() || (await chooseMode());
      if (!chosen) {
        app.quit();
        return;
      }
      if (!readJson<LaunchConfig>(launchFile)?.mode) writeLaunch({ mode: chosen });
      mode = chosen;
      if (mode === 'web') await startWeb();
      else await startDesktop();
    } catch (e) {
      dialog.showErrorBox('AIGC 创作台启动失败', (e as Error)?.stack || String(e));
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => {
    /* Web 模式靠托盘常驻；桌面模式在 macOS 上保持 Dock 习惯 */
    if (mode === 'web') return;
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (mode === 'desktop' && !mainWin && server) createWindow(server.url);
  });

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting || !server) return;
    e.preventDefault();
    quitting = true;
    const s = server;
    server = null;
    void s.close().finally(() => app.quit());
  });
}
