import { describe, expect, it } from 'vitest';
import { isNewerVersion, parseReleaseAssets, pickUpdateAsset, versionFromReleaseUrl } from './update';

const assets = [
  { name: 'AIGC-Studio-0.5.0-mac-arm64.pkg' },
  { name: 'AIGC-Studio-0.5.0-mac-arm64.dmg' },
  { name: 'AIGC-Studio-0.5.0-mac-x64.pkg' },
  { name: 'AIGC-Studio-0.5.0-win-x64.exe' },
  { name: 'AIGC-Studio-0.5.0-linux-amd64.deb' },
  { name: 'AIGC-Studio-0.5.0-linux-x86_64.AppImage' },
  { name: 'SHA256SUMS.txt' },
];

describe('版本比较', () => {
  it('按数字逐段比较，v 前缀不影响', () => {
    expect(isNewerVersion('v0.4.15', '0.4.14')).toBe(true);
    expect(isNewerVersion('0.4.14', '0.4.14')).toBe(false);
    expect(isNewerVersion('0.4.9', '0.4.14')).toBe(false);
    expect(isNewerVersion('0.5', '0.4.99')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
  });

  it('非法版本号不当作更新', () => {
    expect(isNewerVersion('latest', '0.4.14')).toBe(false);
    expect(isNewerVersion('0.5.0', 'unknown')).toBe(false);
  });
});

describe('选择安装包', () => {
  it('macOS 按芯片选 pkg', () => {
    expect(pickUpdateAsset(assets, 'darwin', 'arm64')?.name).toBe('AIGC-Studio-0.5.0-mac-arm64.pkg');
    expect(pickUpdateAsset(assets, 'darwin', 'x64')?.name).toBe('AIGC-Studio-0.5.0-mac-x64.pkg');
  });

  it('macOS 没有 pkg 时退回 dmg', () => {
    const onlyDmg = assets.filter((a) => !a.name.endsWith('.pkg'));
    expect(pickUpdateAsset(onlyDmg, 'darwin', 'arm64')?.name).toBe('AIGC-Studio-0.5.0-mac-arm64.dmg');
  });

  it('Windows 用 exe，Linux 按运行方式选 deb 或 AppImage', () => {
    expect(pickUpdateAsset(assets, 'win32', 'x64')?.name).toBe('AIGC-Studio-0.5.0-win-x64.exe');
    expect(pickUpdateAsset(assets, 'linux', 'x64', false)?.name).toBe('AIGC-Studio-0.5.0-linux-amd64.deb');
    expect(pickUpdateAsset(assets, 'linux', 'x64', true)?.name).toBe('AIGC-Studio-0.5.0-linux-x86_64.AppImage');
  });

  it('找不到匹配资产时返回 null', () => {
    expect(pickUpdateAsset([], 'darwin', 'arm64')).toBeNull();
    expect(pickUpdateAsset(assets, 'freebsd', 'x64')).toBeNull();
  });
});

describe('API 限流（403）时的网页兜底', () => {
  it('从跳转后的地址取版本号', () => {
    expect(versionFromReleaseUrl('https://github.com/lei-q/callfans-aigc-studio/releases/tag/v0.4.40')).toBe('0.4.40');
    expect(versionFromReleaseUrl('https://github.com/lei-q/callfans-aigc-studio/releases')).toBeNull();
    expect(versionFromReleaseUrl('https://github.com/x/y/releases/tag/nightly')).toBeNull();
  });

  it('只认本仓库 download 地址，去重并解码文件名', () => {
    const html = `
      <a href="/lei-q/callfans-aigc-studio/releases/download/v0.4.40/AIGC-Studio-0.4.40-win-x64.exe" rel="nofollow">x</a>
      <a href="/lei-q/callfans-aigc-studio/releases/download/v0.4.40/AIGC-Studio-0.4.40-win-x64.exe" rel="nofollow">dup</a>
      <a href="/lei-q/callfans-aigc-studio/releases/download/v0.4.40/SHA256SUMS.txt">s</a>
      <a href="/evil/other/releases/download/v1/bad.exe">bad</a>`;
    const list = parseReleaseAssets(html, 'lei-q/callfans-aigc-studio');
    expect(list.map((a) => a.name)).toEqual(['AIGC-Studio-0.4.40-win-x64.exe', 'SHA256SUMS.txt']);
    expect(list[0].browser_download_url).toBe('https://github.com/lei-q/callfans-aigc-studio/releases/download/v0.4.40/AIGC-Studio-0.4.40-win-x64.exe');
    expect(pickUpdateAsset(list, 'win32', 'x64')?.name).toBe('AIGC-Studio-0.4.40-win-x64.exe');
  });
});
