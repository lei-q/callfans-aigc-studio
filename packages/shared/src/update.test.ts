import { describe, expect, it } from 'vitest';
import { isNewerVersion, pickUpdateAsset } from './update';

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
