import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  const core = await Core.create({ dataDir, mode: 'web', desktop: false, version: 'test', memory: true, cloudPollMs: 40, directPollMs: 40, account: { provider: 'mock' } });
  const s = core.store.settings;
  s.cloud.baseUrl = cloud.url;
  core.store.settings = s;
  cores.push(core);
  core.runner.start();
  return core;
}

async function login(core: Core, phone = '13800001111') {
  const start = await core.session.loginStart('web');
  cloud.approveDevice(start.deviceCode!, phone);
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

  /* 临时测试入口：自定义金额可以是任意正整数，不受已开通档位限制 */
  it('自定义金额：任意正整数点数下单并到账', async () => {
    const core = await makeCore();
    await login(core);
    const before = core.session.wallet?.balance ?? 0;
    const order = await core.session.client.request<any>('/billing/orders', { json: { points: 37, channel: 'wechat' } });
    expect(order).toMatchObject({ points: 37, amountCny: 37, packName: '37 点' });
    cloud.payOrder(order.id);
    await new Promise((r) => setTimeout(r, 80));
    await core.session.refreshWallet();
    expect(core.session.wallet?.balance).toBe(before + 37);
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

  it('发散一次提交多个方向：同批产出都留在收件箱，下一批来了才沉入草稿箱', async () => {
    const core = await makeCore();
    await login(core);
    cloud.payOrder((await core.session.client.request<any>('/billing/orders', { json: { packId: 'p10', channel: 'alipay' } })).id);
    await core.session.refreshWallet();
    const body = { type: 'image' as const, ws: 'w1', model: 'cloud:g-img-1', refs: [], ratio: '1:1', count: 1, res: '2k' as const };
    const batch = core.runner.createMany([
      { ...body, prompt: '一杯咖啡。更暖', divergeAxis: '更暖' },
      { ...body, prompt: '一杯咖啡。更冷', divergeAxis: '更冷' },
      { ...body, prompt: '一杯咖啡。更近', divergeAxis: '更近' },
    ]);
    expect(new Set(batch.map((j) => j.batch)).size).toBe(1);
    expect(batch[0].batch).toBeTruthy();
    for (const j of batch) await waitJob(core, j.id);
    const homes = () => core.store.results.all().filter((r) => batch.some((j) => j.id === r.job)).map((r) => r.home);
    expect(homes()).toEqual(['inbox', 'inbox', 'inbox']);

    const next = core.runner.create({ ...body, prompt: '另一杯拿铁' });
    await waitJob(core, next.id);
    expect(homes()).toEqual(['draft', 'draft', 'draft']);
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

  it('失败任务可以手动移除，非失败任务拒绝移除', async () => {
    const core = await makeCore();
    await login(core);
    const failed = core.runner.create({ type: 'image', ws: 'w1', model: 'cloud:g-img-1', prompt: '大幅面', refs: [], ratio: '1:1', count: 1, res: '4k' });
    core.runner.remove(failed.id);
    expect(core.store.jobs.get(failed.id)).toBeUndefined();

    const queued = core.runner.create({ type: 'video', ws: 'w1', model: 'cloud:g-vid-1', prompt: '海边日落', refs: [], ratio: '16:9', dur: 5, cam: '推近' });
    expect(() => core.runner.remove(queued.id)).toThrow(/只能移除失败/);
    core.runner.cancel(queued.id);
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
  it('未登录没有文本模型时直接报错，不返回预置示例', async () => {
    const core = await makeCore();
    const { optimizePrompt } = await import('../src/assist');
    await expect(optimizePrompt(core, 'image', '秋季新品海报')).rejects.toThrow(/文本模型/);
  });

  it('登录后「帮我写详细」走云端对话', async () => {
    const core = await makeCore();
    const { optimizePrompt } = await import('../src/assist');
    await login(core);
    const r = await optimizePrompt(core, 'image', '秋季新品海报');
    expect(r.llm).toBe(true);
    expect(r.mode).toBe('expand');
    expect(r.result).toContain('秋季新品海报');
  });

  it('提示词很长时让模型补充细节', async () => {
    const core = await makeCore();
    const { optimizePrompt } = await import('../src/assist');
    await login(core);
    const r = await optimizePrompt(core, 'video', '夜晚的海边，浪花拍打礁石，镜头从远景慢慢推近到人物侧脸，最后停在她的眼睛上');
    expect(r.llm).toBe(true);
    expect(r.mode).toBe('add');
    expect(r.add.length).toBeGreaterThan(0);
    expect(r.result).toBe('');
  });
});

describe('帖子：AI 文案与导出', () => {
  it('AI 写文案：解析标题 / 正文 / 标签；模型没给可用内容时明确报错、不改原文', async () => {
    const core = await makeCore();
    const { postCopy } = await import('../src/assist');
    await login(core);
    const spy = vi.spyOn(core.cloud, 'chat');
    spy.mockResolvedValueOnce('好的：```json\n{"title":"秋日第一杯","body":"风有点凉，来杯热的。","tags":["#咖啡","秋天"]}\n```');
    const r = await postCopy(core, { platform: 'xhs', images: [{ title: '拿铁', prompt: '窗边的热拿铁' }] });
    expect(r).toEqual({ title: '秋日第一杯', body: '风有点凉，来杯热的。', tags: ['咖啡', '秋天'] });
    spy.mockResolvedValueOnce('抱歉我不会');
    await expect(postCopy(core, { platform: 'xhs', title: '原标题', images: [] })).rejects.toMatchObject({ status: 502 });
    spy.mockRejectedValueOnce(new Error('网关超时'));
    await expect(postCopy(core, { platform: 'xhs', images: [] })).rejects.toThrow(/模型调用失败/);
  });

  it('未登录时 AI 写文案直接说明需要文本模型', async () => {
    const core = await makeCore();
    const { postCopy } = await import('../src/assist');
    await expect(postCopy(core, { platform: 'xhs', images: [] })).rejects.toThrow(/文本模型/);
  });

  it('保存帖子带每图配文；导出 zip 含 index.md（相对路径、配文）与 images/', async () => {
    const core = await makeCore();
    const ws = core.store.projects.all()[0].id;
    const f = core.newMediaFile('png');
    fs.writeFileSync(f.file, 'png-bytes');
    core.store.results.put({ id: 'rr1', job: null, type: 'image', ws, title: '拿铁', src: f.src, ratio: '1:1', model: 'm', seed: 1, createdAt: 1, status: 'new', tags: [], dur: 0, home: 'library' });
    const app = await buildApp(core);
    const H = { host: 'localhost', 'x-aigc-client': '1' };
    const put = await app.inject({ method: 'PUT', url: '/api/posts/P1', headers: H, payload: { ws, title: '秋日', body: '正文', items: ['rr1'], platform: 'xhs', captions: { rr1: '窗边的热拿铁' } } });
    expect(put.statusCode).toBe(200);
    expect(core.store.posts.get('P1')?.captions).toEqual({ rr1: '窗边的热拿铁' });
    const zip = await app.inject({ method: 'GET', url: '/api/posts/P1/export', headers: { host: 'localhost' } });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    const raw = zip.rawPayload.toString('latin1');
    expect(raw).toContain('index.md');
    expect(raw).toContain('images/01-');
    expect(zip.rawPayload.toString('utf8')).toContain('![窗边的热拿铁](images/01-');
    await app.close();
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
      s.channel = 'direct';
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

describe('画布上下文接口', () => {
  it('OpenAPI 与网页接口返回同一份：元素、提示词、模型、连线、坐标；没有 Key 拒绝', async () => {
    const core = await makeCore();
    await login(core);
    const ws = core.store.projects.all()[0].id;
    const j = core.runner.create({ type: 'image', ws, model: 'cloud:g-img-1', prompt: '一杯咖啡', refs: [], ratio: '4:5', count: 1, res: '2k' });
    const done = await waitJob(core, j.id);
    const rid = done.results[0];
    core.store.saveBoard(ws, {
      items: [
        { id: 'c1', kind: 'media', type: 'image', src: core.store.results.get(rid)!.src, t: '咖啡', rid, x: 10, y: 20, w: 200, ar: 1.25 },
        { id: 'c2', kind: 'node', text: '主视觉走暖橙', x: 300, y: 20 },
        { id: 'c3', kind: 'group', t: '一组', x: 0, y: 0, w: 600, h: 400 },
      ],
      links: [{ id: 'L1', from: 'c1', to: 'c2', label: '启发' }],
      view: { x: 0, y: 0, k: 1 },
      anchor: null,
    });
    const app = await buildApp(core);
    const H = { host: 'localhost', 'x-aigc-client': '1' };
    const denied = await app.inject({ method: 'GET', url: '/openapi/v1/canvas/context', headers: { host: 'localhost' } });
    expect(denied.statusCode).toBe(401);
    const secret = (await app.inject({ method: 'POST', url: '/api/keys', headers: H, payload: { name: 'agent' } })).json().secret as string;
    const r = await app.inject({ method: 'GET', url: `/openapi/v1/canvas/context?project=${ws}`, headers: { host: 'localhost', authorization: `Bearer ${secret}` } });
    expect(r.statusCode).toBe(200);
    const ctx = r.json();
    expect(ctx.summary).toContain('3 个元素（1 个素材、1 个分组），1 条连线');
    const media = ctx.items.find((i: { id: string }) => i.id === 'c1');
    expect(media).toMatchObject({ kind: 'media', type: 'image', title: '咖啡', prompt: '一杯咖啡', model: 'cloud:g-img-1', ratio: '4:5', x: 10, y: 20, w: 200, h: 252 });
    expect(media.src).toMatch(/^http:\/\/localhost\/files\/media\//);
    expect(ctx.items.find((i: { id: string }) => i.id === 'c2')).toMatchObject({ kind: 'node', text: '主视觉走暖橙', src: null, type: null });
    expect(ctx.links).toEqual([{ from: 'c1', to: 'c2', label: '启发' }]);
    const web = await app.inject({ method: 'GET', url: `/api/canvas/context?ws=${ws}`, headers: { host: 'localhost' } });
    expect(web.json().items).toHaveLength(3);
    expect((await app.inject({ method: 'GET', url: '/api/canvas/context?ws=nope', headers: { host: 'localhost' } })).statusCode).toBe(404);
    await app.close();
  });
});

describe('决策：充值开放与内容审核', () => {
  async function withCloud(opts: Parameters<typeof startMockCloud>[0], fn: (c: MockCloudHandle) => Promise<void>) {
    const c = await startMockCloud({ jobMs: 60, ...opts });
    try {
      await fn(c);
    } finally {
      await c.close();
    }
  }

  it('云端没有开通支付渠道：登录后 session.payChannels 为空，下单被拒绝', async () => {
    await withCloud({ payChannels: [] }, async (c) => {
      const core = await makeCore();
      const st = core.store.settings;
      st.cloud.baseUrl = c.url;
      core.store.settings = st;
      const start = await core.session.loginStart('web');
      c.approveDevice(start.deviceCode!);
      await core.session.loginPoll();
      expect(core.sessionInfo().payChannels).toEqual([]);
      await expect(core.session.client.request('/billing/orders', { json: { packId: 'p10', channel: 'wechat' } })).rejects.toThrow();
    });
  });

  it('内容审核拦截：任务失败、给出可修改的提示，且不扣点', async () => {
    await withCloud({ blockWords: ['违禁词'] }, async (c) => {
      const core = await makeCore();
      const st = core.store.settings;
      st.cloud.baseUrl = c.url;
      core.store.settings = st;
      const start = await core.session.loginStart('web');
      c.approveDevice(start.deviceCode!);
      await core.session.loginPoll();
      const before = core.session.wallet!.balance + core.session.wallet!.freeToday;
      const j = core.runner.create({ type: 'image', ws: 'w1', model: 'cloud:g-img-1', prompt: '含有违禁词的描述', refs: [], ratio: '1:1', count: 1, res: '2k' });
      const done = await waitJob(core, j.id);
      expect(done.status).toBe('failed');
      expect(done.fail?.code).toBe('E-SAFE-03');
      await core.session.refreshWallet();
      expect(core.session.wallet!.balance + core.session.wallet!.freeToday).toBe(before);
    });
  });
});
