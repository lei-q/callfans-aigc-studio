import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enterpriseClientIdOf, enterpriseIssuerOf, type AccountConfig } from '@aigc/shared';
import { Core } from '../src/core';

/* 账号入口：个人账号（consumer Realm）与企业员工（business Realm）共用一套
   /app/** 契约。这里只验协议选择与本地行为，不访问真实账号服务。 */

const cores: Core[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  while (cores.length) cores.pop()!.close();
});

function config(patch: Partial<AccountConfig> = {}): AccountConfig {
  return {
    provider: 'fastsso',
    issuer: 'https://sso.test/realms/consumer',
    apiBase: 'http://account.test/api/v1',
    gatewayBase: 'http://gw.test',
    clientId: 'aigc-callfans',
    redirectUri: 'http://127.0.0.1:5781/auth/callback',
    ...patch,
  };
}

async function makeCore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-mode-'));
  const core = await Core.create({
    dataDir,
    mode: 'web',
    desktop: false,
    version: 'test',
    memory: true,
    platformPollMs: 1,
    account: { provider: 'fastsso', apiBase: 'http://account.test/api/v1', gatewayBase: 'http://gw.test' },
  });
  cores.push(core);
  return core;
}

function actAs(core: Core, mode: 'consumer' | 'enterprise') {
  const session = core.accounts as unknown as {
    mode: 'consumer' | 'enterprise';
    status: string;
    tokens: unknown;
    profile: unknown;
    appMe: unknown;
  };
  session.mode = mode;
  session.status = 'logged_in';
  session.tokens = { accessToken: 'at-test', refreshToken: 'rt-test', expiresAt: Date.now() + 3600_000, mode };
  return session;
}

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('企业入口地址', () => {
  it('由 consumer issuer 推出 business Realm，也允许显式覆盖', () => {
    expect(enterpriseIssuerOf(config())).toBe('https://sso.test/realms/business');
    expect(enterpriseIssuerOf(config({ enterpriseIssuer: 'https://sso.test/realms/tenant/' }))).toBe(
      'https://sso.test/realms/tenant',
    );
    expect(enterpriseIssuerOf(config({ issuer: 'https://sso.test/auth' }))).toBe('');
    expect(enterpriseClientIdOf(config())).toBe('aigc-callfans');
    expect(enterpriseClientIdOf(config({ enterpriseClientId: 'aigc-enterprise' }))).toBe('aigc-enterprise');
  });
});

describe('统一 /app/** 契约', () => {
  it('企业员工的余额走 /app/entitlements/balance', async () => {
    const core = await makeCore();
    actAs(core, 'enterprise');
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonRes(200, { accountId: 'a1', totalMicro: 2_500_000 }));
    vi.stubGlobal('fetch', fetchMock);
    const wallet = await core.accounts.refreshWallet();
    expect(wallet?.balance).toBe(2.5);
    expect(fetchMock.mock.calls[0][0]).toBe('http://account.test/api/v1/app/entitlements/balance');
  });

  it('老版账号服务 404 时，个人账号退回 /consumer/**', async () => {
    const core = await makeCore();
    actAs(core, 'consumer');
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).includes('/app/') ? jsonRes(404, { error: 'not_found' }) : jsonRes(200, { accountId: 'a1', totalMicro: 1_000_000 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wallet = await core.accounts.refreshWallet();
    expect(wallet?.balance).toBe(1);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      'http://account.test/api/v1/app/entitlements/balance',
      'http://account.test/api/v1/consumer/entitlements/balance',
    ]);
  });

  it('企业员工不在应用内充值：渠道为空，下单被拒绝', async () => {
    const core = await makeCore();
    actAs(core, 'enterprise');
    const fetchMock = vi.fn(async () => jsonRes(500, {}));
    vi.stubGlobal('fetch', fetchMock);
    expect(await core.accounts.refreshChannels()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      core.accounts.createOrder({ points: 10, channel: 'alipay', idempotencyKey: 'k1' }),
    ).rejects.toThrow(/租户/);
  });

  it('会话信息带出租户、准入应用与角色', async () => {
    const core = await makeCore();
    const session = actAs(core, 'enterprise');
    session.profile = { id: 'u1', nickname: '张三', createdAt: Date.now() };
    session.appMe = {
      userId: 'u1',
      username: 'zhangsan',
      displayName: '张三',
      mode: 'enterprise',
      tenantId: 't1',
      tenantName: '示例租户',
      appId: 'aigc-studio',
      apps: ['aigc-studio'],
      roles: ['member'],
    };
    const info = core.accounts.info();
    expect(info.accountMode).toBe('enterprise');
    expect(info.tenant).toEqual({ id: 't1', name: '示例租户' });
    expect(info.apps).toEqual(['aigc-studio']);
    expect(info.roles).toEqual(['member']);
    expect(info.payChannels).toEqual([]);
    expect(info.registerEnabled).toBe(false);
  });
});
