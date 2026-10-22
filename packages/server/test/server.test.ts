import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Job, ServerEvent } from '@aigc/shared';
import { startMockCloud, type MockCloudHandle } from '../../cloud-mock/src/index';
import { buildApp } from '../src/app';
import { Core } from '../src/core';

/* 契约测试：本地服务 + Mock 云（同一份合同，真实云端上线后这些用例同样适用） */

let cloud: MockCloudHandle;
const cores: Core[] = [];

beforeAll(async () => {
  cloud = await startMockCloud({ jobMs: 120 });
});
afterAll(async () => {
  await cloud.close();
});
afterEach(() => {
  while (cores.length) cores.pop()!.close();
});

async function makeCore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-test-'));
  const core = await Core.create({ dataDir, mode: 'web', desktop: false, version: 'test', memory: true, cloudPollMs: 40, directPollMs: 40 });
  const s = core.store.settings;
  s.cloud.baseUrl = cloud.url;
  core.store.settings = s;
  cores.push(core);
  core.runner.start();
  return core;
}

async function login(core: Core, phone = '13800001111') {
  const start = await core.session.loginStart('web');
  cloud.approveDevice(start.deviceCode, phone);
  const poll = await core.session.loginPoll();
  expect(poll.status).toBe('approved');
  return start;
}

function waitJob(core: Core, id: string, statuses: Job['status'][] = ['succeeded', 'failed', 'canceled']) {
  return new Promise<Job>((resolve, reject) => {
    const cur = core.store.jobs.get(id);
    if (cur && statuses.includes(cur.status)) return resolve(cur);
    const t = setTimeout(() => reject(new Error(`timeout waiting ${id}`)), 10_000);
    const off = core.events.on((e: ServerEvent) => {
      if (e.type === 'job' && e.job.id === id && statuses.includes(e.job.status)) {
        clearTimeout(t);
        off();
        resolve(e.job);
      }
    });
  });
}

describe('首启干净', () => {
  it('没有示例数据：一个空项目、没有任务与产出、未登录', async () => {
    const core = await makeCore();
    const b = core.bootstrap();
    expect(b.projects).toHaveLength(1);
    expect(b.jobs).toHaveLength(0);
    expect(b.results).toHaveLength(0);
    expect(b.aesthetic).toHaveLength(0);
    expect(b.wallet).toBeNull();
    expect(b.session.loggedIn).toBe(false);
    expect(b.models).toHaveLength(0);
    expect(Object.values(b.boards)[0].items).toHaveLength(0);
  });

  it('未登录时创建任务被拒绝，并给出登录引导', async () => {
    const core = await makeCore();
    expect(() => core.runner.create({ type: 'image', ws: 'w1', model: 'cloud:g-img-1', prompt: '一杯咖啡', refs: [], ratio: '1:1', count: 1, res: '2k' })).toThrow(/登录/);
  });
});

describe('登录与充值', () => {
  it('设备码登录：新用户赠送 + 今日免费', async () => {
    const core = await makeCore();
    await login(core);
    expect(core.session.loggedIn).toBe(true);
    expect(core.session.wallet?.balance).toBe(1);
    expect(core.session.wallet?.freeToday).toBe(0.5);
    expect(core.models().some((m) => m.id === 'cloud:g-img-1')).toBe(true);
  });

  it('下单 → 支付 → 积分到账（首充翻倍）', async () => {
    const core = await makeCore();
    await login(core);
    const packs = await core.session.client.request<any[]>('/billing/packs');
    const order = await core.session.client.request<any>('/billing/orders', { json: { packId: 'p30', channel: 'wechat' } });
    expect(order.qrContent).toContain('/pay?order=');
    cloud.payOrder(order.id);
    await new Promise((r) => setTimeout(r, 80));
    await core.session.refreshWallet();
    expect(core.session.wallet?.balance).toBe(1 + 60);
    void packs;
  });
});

describe('云端网关生成', () => {
  it('创建任务扣点、产出落盘、余额同步', async () => {
    const core = await makeCore();
    await login(core);
    cloud.payOrder((await core.session.client.request<any>('/billing/orders', { json: { packId: 'p10', channel: 'alipay' } })).id);
    await core.session.refreshWallet();
    const before = core.session.wallet!.balance;
    const j = core.runner.create({ type: 'image', ws: 'w1', model: 'cloud:g-img-1', prompt: '一杯咖啡', refs: [], ratio: '1:1', count: 2, res: '2k' });
    const done = await waitJob(core, j.id);
    expect(done.status).toBe('succeeded');
    expect(done.results).toHaveLength(2);
    const r = core.store.results.get(done.results[0])!;
    expect(fs.existsSync(core.localPathOf(r.src)!)).toBe(true);
    expect(core.session.wallet!.balance).toBeLessThan(before);
  });

  it('取消排队中的任务退回点数', async () => {
    const core = await makeCore();
    await login(core);
    const j = core.runner.create({ type: 'video', ws: 'w1', model: 'cloud:g-vid-1', prompt: '海边日落', refs: [], ratio: '16:9', dur: 5, cam: '推近' });
    const before = core.session.wallet!.balance;
    core.runner.cancel(j.id);
    await new Promise((r) => setTimeout(r, 120));
    await core.session.refreshWallet();
    expect(core.session.wallet!.balance).toBe(before);
  });

  it('参数超限本地拦截：不提交云端', async () => {
    const core = await makeCore();
    await login(core);
    const j = core.runner.create({ type: 'image', ws: 'w1', model: 'cloud:g-img-1', prompt: '大幅面', refs: [], ratio: '1:1', count: 1, res: '4k' });
    expect(j.status).toBe('failed');
    expect(j.fail?.code).toBe('E-PRM-04');
  });

  it('余额不足：云端返回 40201，任务失败且提示充值', async () => {
    const core = await makeCore();
    await login(core, '13900002222');
    /* 新用户只有 1 点 + 0.5 免费，排一个 8 秒视频（6.4 点）不够 */
    const j = core.runner.create({ type: 'video', ws: 'w1', model: 'cloud:g-vid-1', prompt: '很长的视频', refs: [], ratio: '16:9', dur: 8, cam: '环绕' });
    const done = await waitJob(core, j.id);
    expect(done.status).toBe('failed');
    expect(done.fail?.code).toBe('E-BAL-02');
  });
});

describe('AI 辅助真调模型', () => {
  it('登录后「帮我写详细」走云端对话', async () => {
    const core = await makeCore();
    const { optimizePrompt } = await import('../src/assist');
    const off = optimizePrompt(core, 'image', '秋季新品海报');
    expect((await off).llm).toBe(false);
    await login(core);
    const r = await optimizePrompt(core, 'image', '秋季新品海报');
    expect(r.llm).toBe(true);
    expect(r.result).toContain('秋季新品海报');
  });
});

describe('直连模式', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  function fakeTreeCloud() {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const json = (code: number, obj: unknown) => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.headers.authorization !== 'Bearer sk-tc-good') return json(401, { error: { message: 'bad key' } });
        if (req.url === '/v1/models') {
          return json(200, { data: [{ id: 'img-x', type: 'image', capabilities: [{ feature: 'generate', runtime_status: 'enabled', limits: { image_sizes: ['1024x1024'] } }] }] });
        }
        if (req.url === '/v1/images/generations') return json(200, { created: 1, data: [{ b64_json: PNG.toString('base64') }] });
        json(404, { error: { message: 'nf' } });
      });
    });
    return new Promise<{ url: string; close: () => void }>((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => srv.close() })));
  }

  it('启用直连后走用户自己的 Key，不扣平台点数', async () => {
    const fake = await fakeTreeCloud();
    try {
      const core = await makeCore();
      await login(core);
      const before = core.session.wallet!.balance;
      const s = core.store.settings;
      s.direct.baseUrl = fake.url;
      s.direct.keyEnc = core.secrets.encrypt('sk-tc-good');
      s.direct.enabled = true;
      core.store.settings = s;
      core.store.directModels = await core.direct.fetchCatalog();
      const j = core.runner.create({ type: 'image', ws: 'w1', model: 'tc:img-x', prompt: '直连一张', refs: [], ratio: '1:1', count: 1, res: '1080p' });
      const done = await waitJob(core, j.id);
      expect(done.status).toBe('succeeded');
      expect(core.session.wallet!.balance).toBe(before);
    } finally {
      fake.close();
    }
  });
});

describe('HTTP 边界', () => {
  it('CSRF / Host / 会话口令', async () => {
    const core = await makeCore();
    const app = await buildApp(core);
    const boot = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { host: '127.0.0.1:5780' } });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().session.loggedIn).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'localhost' }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { host: 'evil.example.com' } })).statusCode).toBe(403);
    await app.close();
  });

  it('本地 OpenAPI：未登录时没有可用模型', async () => {
    const core = await makeCore();
    const app = await buildApp(core);
    const created = await app.inject({ method: 'POST', url: '/api/keys', headers: { host: 'localhost', 'x-aigc-client': '1' }, payload: { name: '脚本' } });
    const secret = created.json().secret as string;
    const res = await app.inject({ method: 'POST', url: '/openapi/v1/images/generations', headers: { host: 'localhost', authorization: `Bearer ${secret}` }, payload: { prompt: 'x' } });
    expect(res.statusCode).toBe(400);
    await login(core);
    const ok = await app.inject({ method: 'POST', url: '/openapi/v1/images/generations', headers: { host: 'localhost', authorization: `Bearer ${secret}` }, payload: { prompt: '一杯咖啡', n: 1 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data[0].url).toMatch(/^http:\/\/localhost\/files\/media\//);
    await app.close();
  });
});
