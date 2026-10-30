import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickChatModel, PlatformCatalog, platformChat } from '../src/account/platform';
import { buildApp } from '../src/app';
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

  it('用户选的文本模型优先于默认偏好；summary 翻成界面用的字段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, CATALOG)));
    const cat = new PlatformCatalog(() => ({ gatewayBase: 'http://gw.test/' }) as never);
    const sum = await cat.summary();
    expect(sum.gatewayBase).toBe('http://gw.test');
    expect(sum.models.find((m) => m.id === 'glm-cheap')).toMatchObject({
      protocol: 'openai',
      mode: 'chat',
      inputPerMillion: 0.1,
      outputPerMillion: 0.2,
    });
    expect(pickChatModel(sum.models as never, 'glm-cheap')).toBe('glm-cheap');
    /* 选了个清单里没有的模型：退回自动挑 */
    expect(pickChatModel(sum.models as never, 'gone-model')).toBe('deepseek-v4.1-flash-1017');
  });
});

describe('「模型与价格」的渠道设置', () => {
  it('保存辅助模型；只填 Key 就自动启用自定义渠道；清单接口返回平台模型', async () => {
    const core = await makeFssCore();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (String(url).startsWith('http://gw.test/models') ? jsonRes(200, CATALOG) : jsonRes(200, { data: [] }))),
    );
    const app = await buildApp(core);
    const h = { host: 'localhost', 'x-aigc-client': '1' };

    const patch = await app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { models: { cloud: { text: ' glm-cheap ' } } } });
    expect(patch.statusCode).toBe(200);
    expect(core.store.settings.models.cloud.text).toBe('glm-cheap');

    const cat = await app.inject({ method: 'GET', url: '/api/platform/models', headers: h });
    expect(cat.statusCode).toBe(200);
    expect(cat.json()).toMatchObject({ gatewayBase: 'http://gw.test' });
    expect(cat.json().models).toHaveLength(CATALOG.data.length);

    /* 没有单独的开关：存了 Key 就是启用 */
    const key = await app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { direct: { apiKey: 'sk-tc-test' } } });
    expect(key.statusCode).toBe(200);
    expect(core.store.settings.direct.enabled).toBe(true);
    expect(key.json().settings.direct).toMatchObject({ enabled: true, hasKey: true });

    /* 清掉 Key 同时关闭自定义渠道 */
    const clear = await app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { direct: { clearKey: true } } });
    expect(clear.json().settings.direct).toMatchObject({ enabled: false, hasKey: false });
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
