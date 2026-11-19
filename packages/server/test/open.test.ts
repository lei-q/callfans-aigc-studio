import { describe, expect, it } from 'vitest';
import { browserCommand, openInBrowser } from '../src/open';

const URL_WITH_AMP = 'https://sso.test/realms/business/protocol/openid-connect/auth?client_id=aigc-callfans&response_type=code&state=abc';

describe('系统浏览器打开命令', () => {
  it('Windows 不经过 cmd：URL 里的 & 不能被当成命令分隔符', () => {
    const { cmd, args } = browserCommand(URL_WITH_AMP, 'win32');
    expect(cmd).not.toBe('cmd');
    expect(args).toEqual(['url.dll,FileProtocolHandler', URL_WITH_AMP]);
  });

  it('macOS / Linux 把完整地址作为单独的参数', () => {
    expect(browserCommand(URL_WITH_AMP, 'darwin')).toEqual({ cmd: 'open', args: [URL_WITH_AMP] });
    expect(browserCommand(URL_WITH_AMP, 'linux')).toEqual({ cmd: 'xdg-open', args: [URL_WITH_AMP] });
  });

  it('只放行 http(s)', async () => {
    expect(await openInBrowser('file:///etc/passwd')).toBe(false);
    expect(await openInBrowser('calc.exe')).toBe(false);
  });
});
