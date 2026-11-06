import { spawn } from 'node:child_process';

/* ============================================================================
   用操作系统默认浏览器打开一个地址。
   桌面端由本机服务直接调用：不经过渲染进程的 window.open，也不依赖 Electron 的
   shell.openExternal，避免新窗口被拦截或应用被隔离运行时静默失败。
   ========================================================================== */

export function openInBrowser(url: string): Promise<boolean> {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
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
