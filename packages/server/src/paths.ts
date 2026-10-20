import os from 'node:os';
import path from 'node:path';

export const PRODUCT_DIR = 'AIGC Studio';

/** 和 Electron 的 userData 保持同一个目录，桌面模式与 Web 模式共用一份数据 */
export function defaultDataDir() {
  if (process.env.AIGC_DATA_DIR) return path.resolve(process.env.AIGC_DATA_DIR);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', PRODUCT_DIR);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), PRODUCT_DIR);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), PRODUCT_DIR);
}

/** 安装器写入的系统级默认模式（macOS .pkg 装在 /Library 下，Windows/Linux 在程序目录 resources 下） */
export function systemLaunchFiles(resourcesDir?: string) {
  const files: string[] = [];
  if (resourcesDir) files.push(path.join(resourcesDir, 'launch-mode.json'));
  if (process.platform === 'darwin') files.push(path.join('/Library', 'Application Support', PRODUCT_DIR, 'launch-mode.json'));
  return files;
}
