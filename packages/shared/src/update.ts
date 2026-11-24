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

/** `…/releases/tag/v1.2.3` 这类跳转后的地址 → 版本号（不带 v）；不是 tag 地址返回 null */
export function versionFromReleaseUrl(url: string): string | null {
  const m = /\/releases\/tag\/([^/?#]+)/.exec(url);
  if (!m) return null;
  const tag = decodeURIComponent(m[1]).replace(/^v/i, '');
  return parseVersion(tag) ? tag : null;
}

/**
 * 从 `releases/expanded_assets/<tag>` 的 HTML 里取安装包列表（只认本仓库的 download 地址）。
 * GitHub API 对匿名请求按 IP 限流（公司出口 / 代理共用 IP 时常见 403），
 * 网页地址不受这个限制，所以 API 不可用时用它兜底。
 */
export function parseReleaseAssets(html: string, repo: string): UpdateAsset[] {
  const out: UpdateAsset[] = [];
  const seen = new Set<string>();
  const re = new RegExp(`href="(/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/releases/download/[^"]+)"`, 'g');
  for (const m of html.matchAll(re)) {
    const href = m[1].replace(/&amp;/g, '&');
    const name = decodeURIComponent(href.split('/').pop() || '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, browser_download_url: `https://github.com${href}` });
  }
  return out;
}
