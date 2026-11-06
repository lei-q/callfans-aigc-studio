/* ============================================================================
   自动更新：主进程维护状态，页面只读展示并触发动作。
   更新包来自 GitHub Release（公开仓库，无需令牌）。
   ========================================================================== */

export type UpdateStage = 'idle' | 'checking' | 'available' | 'downloading' | 'waiting' | 'installing' | 'error';

export interface UpdateState {
  stage: UpdateStage;
  /** 当前安装的版本 */
  currentVersion: string;
  /** 有更新时的目标版本，没有更新时为 null */
  version: string | null;
  /** Release 页面地址 */
  pageUrl?: string;
  /** 安装包大小（字节） */
  size?: number;
  /** 下载进度（0-100）；大小未知时没有这个字段 */
  percent?: number;
  transferred?: number;
  total?: number;
  /** 下载完成、等待任务结束时，还有多少个任务在执行或排队 */
  busy?: number;
  /** 下一次检查是否空闲的时间戳（毫秒） */
  nextCheckAt?: number;
  message?: string;
  checkedAt?: number;
  /** 用户已经对当前版本点过「稍后」 */
  dismissed?: boolean;
  /** 这次检查由用户手动触发 */
  manual?: boolean;
}

/** GitHub Release 里的一条资产，只取用得到的字段 */
export interface UpdateAsset {
  name: string;
  size?: number;
  /** API 资产地址：带上 Accept: application/octet-stream 会重定向到真实下载地址 */
  url?: string;
  browser_download_url?: string;
}

function parseVersion(v: string): number[] | null {
  const core = v.trim().replace(/^v/i, '').split('-')[0].split('+')[0];
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return core.split('.').map(Number);
}

/** candidate 是否比 current 新：逐段比较数字，忽略预发布与构建元数据 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** 按平台和架构挑安装包：macOS 优先 .pkg，Windows 用 .exe，Linux 按 AppImage / deb 区分 */
export function pickUpdateAsset(
  assets: UpdateAsset[],
  platform: string,
  arch: string,
  appImage = false,
): UpdateAsset | null {
  const names = (a: UpdateAsset) => a.name.toLowerCase();
  const end = (suffix: string) => assets.find((a) => names(a).endsWith(suffix)) || null;

  if (platform === 'darwin') {
    const mac = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
    return assets.find((a) => names(a).includes(mac) && names(a).endsWith('.pkg')) || assets.find((a) => names(a).includes(mac) && names(a).endsWith('.dmg')) || null;
  }
  if (platform === 'win32') return end('.exe');
  if (platform === 'linux') {
    if (appImage) return end('.appimage');
    return end('.deb') || end('.appimage');
  }
  return null;
}
