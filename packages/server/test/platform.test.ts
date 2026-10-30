import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickChatModel, PlatformCatalog, platformChat } from '../src/account/platform';
import { Core } from '../src/core';

/* 平台模型接入的契约测试：模型清单 → 换 key → 调网关。
   全部用本地 stub 的 fetch，不碰真实平台。 */

const cores: Core[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  while (cores.length) cores.pop()!.close();
});

const CATALOG = {
  object: 'list',
  data: [
    { id: 'claude-sonnet-5-anthropic', protocol: 'anthropic', mode: 'chat', pricing: { input_per_million: 0.01, output_per_million: 0.01 } },
    { id: 'glm-cheap', protocol: 'openai', mode: 'chat', pricing: { input_per_million: 0.1, output_per_million: 0.2 } },
    { id: 'deepseek-v4.1-flash-1017', protocol: 'openai', mode: 'chat', pricing: { input_per_million: 0.3, output_per_million: 1.2 } },
    { id: 'not-chat', protocol: 'openai', mode: 'embedding' },
  ],
};

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function makeFssCore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-platform-'));
  const core = await Core.create({
    dataDir,
    mode: 'web',
    desktop: false,
    version: 'test',
    memory: true,
    account: { provider: 'fastsso', apiBase: 'http://account.test/api/v1', gatewayBase: 'http://gw.test' },
  });
  cores.push(core);
  return core;
}

function fakeLogin(core: Core) {
  (core.accounts as unknown as { tokens: unknown }).tokens = {
    accessToken: 'at-test',
    refreshToken: 'rt-test',
    expiresAt: Date.now() + 3600_000,
  };
  core.accounts.profile = { id: 'u1', nickname: '测试', createdAt: Date.now() };
}

describe('模型清单与选择', () => {
  it('优先偏好模型，其次按标价取最便宜的 openai 对话模型', () => {
    expect(pickChatModel(CATALOG.data as never)).toBe('deepseek-v4.1-flash-1017');
    const noPreferred = CATALOG.data.filter((m) => m.id !== 'deepseek-v4.1-flash-1017');
    expect(pickChatModel(noPreferred as never)).toBe('glm-cheap');
    expect(pickChatModel([{ id: 'only-anthropic', protocol: 'anthropic', mode: 'chat' }])).toBeNull();
  });

  it('清单缓存 60 秒，同一个 base 只拉一次', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, CATALOG));
    vi.stubGlobal('fetch', fetchMock);
    const cat = new PlatformCatalog(() => ({ gatewayBase: 'http://gw.test' }) as never);
    await cat.models();
    await cat.models();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await cat.models(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('网关调用', () => {
  it('把 422 讲成积分不足，401 讲成密钥失效', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(422, { error: { message: 'Budget has been exceeded' } })));
    await expect(platformChat({ baseUrl: 'http://gw.test', key: 'sk-x', model: 'm', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      '积分不足',
    );
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(401, { error: { message: 'bad key' } })));
    await expect(platformChat({ baseUrl: 'http://gw.test', key: 'sk-x', model: 'm', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      '密钥已失效',
    );
  });
});

describe('账号会话：换一次 key 之后一直复用', () => {
  it('key 加密落在本机，第二次不再交换；对话带上 Bearer', async () => {
    const core = await makeFssCore();
    fakeLogin(core);
    const calls: { url: string; auth?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        calls.push({ url: String(url), auth });
        if (String(url).endsWith('/consumer/llm-keys')) return jsonRes(200, { key: 'sk-test-123', keyId: 'k1', expiresAt: null, appId: 'aigc-studio' });
        return jsonRes(200, { choices: [{ message: { content: ' 好的 ' } }] });
      }),
    );
    expect(await core.accounts.llmKey()).toBe('sk-test-123');
    expect(await core.accounts.llmKey()).toBe('sk-test-123');
    expect(calls.filter((c) => c.url.endsWith('/consumer/llm-keys'))).toHaveLength(1);
    /* 明文不落库 */
    expect(core.store.llmKeyOf('u1')).toBeTruthy();
    expect(core.store.llmKeyOf('u1')).not.toContain('sk-test-123');
    expect(core.secrets.decrypt(core.store.llmKeyOf('u1'))).toBe('sk-test-123');

    const text = await core.accounts.chat('deepseek-v4.1-flash-1017', [{ role: 'user', content: 'hi' }]);
    expect(text).toBe('好的');
    expect(calls.at(-1)!.url).toBe('http://gw.test/v1/chat/completions');
    expect(calls.at(-1)!.auth).toBe('Bearer sk-test-123');
    /* consumer token 不发给网关 */
    expect(calls.at(-1)!.auth).not.toContain('at-test');
  });

  it('409 litellm_key_exists 不重试，提示先吊销', async () => {
    const core = await makeFssCore();
    fakeLogin(core);
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(409, { code: 'litellm_key_exists', message: '已有模型密钥' })));
    await expect(core.accounts.llmKey()).rejects.toThrow('吊销');
  });

  it('网关 401 时丢本地副本，只重换一次', async () => {
    const core = await makeFssCore();
    fakeLogin(core);
    let exchanged = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/consumer/llm-keys')) {
          exchanged += 1;
          return jsonRes(200, { key: `sk-${exchanged}`, keyId: 'k', expiresAt: null });
        }
        if (exchanged === 1) return jsonRes(401, { error: { message: 'revoked' } });
        return jsonRes(200, { choices: [{ message: { content: 'ok' } }] });
      }),
    );
    expect(await core.accounts.chat('m', [{ role: 'user', content: 'hi' }])).toBe('ok');
    expect(exchanged).toBe(2);
    expect(core.secrets.decrypt(core.store.llmKeyOf('u1'))).toBe('sk-2');
  });
});
