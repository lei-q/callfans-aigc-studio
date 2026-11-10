import { describe, expect, it } from 'vitest';
import { installerLaunch } from '../src/update-launch';

/* 回归：Windows 自动更新曾经把「安装器 + start」拼成一段字符串交给 cmd.exe，
   Node 再加一层引号后 cmd 会去找一个叫 '\' 的文件，只弹出「Windows 找不到 '\'」，
   安装根本不开始。这里保证 Windows 永远是直接执行安装器本身。 */

const WIN_FILE = 'C:\\Users\\张三\\AppData\\Local\\Temp\\aigc-studio-update\\AIGC-Studio-0.4.21-win-x64.exe';

describe('自动更新启动安装程序', () => {
  it('Windows：直接执行安装器，参数只有 /S 和 --force-run', () => {
    const c = installerLaunch('win32', WIN_FILE);
    expect(c.cmd).toBe(WIN_FILE);
    expect(c.cmd.toLowerCase()).not.toContain('cmd.exe');
    expect(c.args).toEqual(['/S', '--force-run']);
    /* 参数里不能出现需要 shell 再解释的字符：出现就说明又在拼命令行 */
    for (const a of c.args) expect(a).not.toMatch(/[&|<>^"]/);
  });

  it('Windows：安装包路径里有空格也不会被拆开', () => {
    const file = 'C:\\Users\\张三\\AppData\\Local\\Temp\\aigc studio update\\AIGC-Studio-0.4.21-win-x64.exe';
    const c = installerLaunch('win32', file);
    expect(c.cmd).toBe(file);
    expect(c.args).toEqual(['/S', '--force-run']);
  });

  it('macOS：等安装器关闭后再打开应用', () => {
    const c = installerLaunch('darwin', '/Users/me/Downloads/AIGC-Studio-0.4.21-arm64.pkg');
    expect(c.cmd).toBe('sh');
    expect(c.args).toContain('/Users/me/Downloads/AIGC-Studio-0.4.21-arm64.pkg');
    expect(c.args[1]).toContain('open -W');
  });

  it('Linux：AppImage 先覆盖再启动，否则交给 xdg-open', () => {
    const appImage = installerLaunch('linux', '/tmp/new.AppImage', '/opt/AIGC Studio.AppImage');
    expect(appImage.cmd).toBe('sh');
    expect(appImage.args).toContain('/tmp/new.AppImage');
    expect(appImage.args).toContain('/opt/AIGC Studio.AppImage');

    const plain = installerLaunch('linux', '/tmp/AIGC-Studio.deb');
    expect(plain).toEqual({ cmd: 'xdg-open', args: ['/tmp/AIGC-Studio.deb'] });
  });
});
