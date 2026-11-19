import { spawn } from 'node:child_process';

/* ============================================================================
   用操作系统默认浏览器打开一个地址。
   桌面端由本机服务直接调用：不经过渲染进程的 window.open，也不依赖 Electron 的
   shell.openExternal，避免新窗口被拦截或应用被隔离运行时静默失败。
   ========================================================================== */

/**
 * 各平台的打开命令。
 * Windows 不能用 `cmd /c start "" <url>`：cmd 会把 URL 里的 `&` 当成命令分隔符，
 * 授权地址（client_id=…&response_type=…&redirect_uri=…）会在第一个 `&` 处被截断，
 * 浏览器只收到 client_id，授权页直接报参数缺失。rundll32 不经过 shell，URL 原样传入。
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { cmd: 'xdg-open', args: [url] };
}

export function openInBrowser(url: string): Promise<boolean> {
  /* 只放行 http(s)：别的协议会被系统当成「打开本地程序」 */
  if (!/^https?:\/\//i.test(url)) return Promise.resolve(false);
  const { cmd, args } = browserCommand(url);
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      p.once('error', () => resolve(false));
      p.once('spawn', () => {
        p.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
