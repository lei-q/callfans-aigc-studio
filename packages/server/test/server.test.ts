import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, ServerEvent } from '@aigc/shared';
import { buildApp } from '../src/app';
import { Core } from '../src/core';
import { classify, mp3Duration } from '../src/providers/treecloud';

const samplesDir = path.resolve(__dirname, '../../../resources/samples');
const cores: Core[] = [];

async function makeCore(extra: Partial<Parameters<typeof Core.create>[0]> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-test-'));
  const core = await Core.create({
    dataDir,
    samplesDir,
    mode: 'web',
    desktop: false,
    version: 'test',
    memory: true,
    mockTickMs: 2,
    treecloudPollMs: 10,
    ...extra,
  });
  cores.push(core);
  core.runner.start();
  return core;
}

function waitJob(core: Core, id: string, statuses: Job['status'][] = ['succeeded', 'failed', 'canceled']) {
  return new Promise<Job>((resolve, reject) => {
    const cur = core.store.jobs.get(id);
    if (cur && statuses.includes(cur.status)) return resolve(cur);
    const t = setTimeout(() => reject(new Error(`timeout waiting ${id}`)), 8000);
    const off = core.events.on((e: ServerEvent) => {
      if (e.type === 'job' && e.job.id === id && statuses.includes(e.job.status)) {
        clearTimeout(t);
        off();
        resolve(e.job);
      }
    });
  });
}

afterEach(() => {
  while (cores.length) cores.pop()!.close();
});

describe('JobRunner + MockProvider', () => {
  it('生成 → 收件箱；下一批生成时上一批沉入草稿箱；创建即扣费', async () => {
    const core = await makeCore();
    const before = core.store.wallet.balance;
    const j1 = core.runner.create({ type: 'image', ws: 'w1', model: 'm-img-u2', prompt: '测试 A', refs: [], ratio: '1:1', count: 2, res: '2k' });
    expect(['queued', 'running']).toContain(j1.status);
    expect(j1.cost).toBe(0.6);
    const done1 = await waitJob(core, j1.id);
    expect(done1.status).toBe('succeeded');
    expect(done1.results).toHaveLength(2);
    const inbox1 = core.store.results.all().filter((r) => r.home === 'inbox' && r.ws === 'w1');
    expect(inbox1).toHaveLength(2);
    /* 免费额度 0.5 先抵扣，余额只扣 0.1 */
    expect(core.store.wallet.balance).toBe(Math.round((before - 0.1) * 10) / 10);

    const j2 = core.runner.create({ type: 'image', ws: 'w1', model: 'm-img-f2', prompt: '测试 B', refs: [], ratio: '1:1', count: 1, res: '1080p' });
    await waitJob(core, j2.id);
    const ids1 = new Set(done1.results);
    expect(core.store.results.all().filter((r) => ids1.has(r.id)).every((r) => r.home === 'draft')).toBe(true);
  });

  it('参数超限直接记失败、不扣费；按建议修复后按新价重排', async () => {
    const core = await makeCore();
    const before = core.store.wallet.balance;
    const j = core.runner.create({ type: 'image', ws: 'w1', model: 'm-img-u2', prompt: '大幅面', refs: [], ratio: '1:1', count: 2, res: '4k' });
    expect(j.status).toBe('failed');
    expect(j.fail?.code).toBe('E-PRM-04');
    expect(core.store.wallet.balance).toBe(before);
    const { job, log } = core.runner.fix(j.id);
    expect(log).toEqual(['4K → 2K']);
    expect(job.cost).toBe(0.6);
    expect(job.fixed).toBe(true);
    expect((await waitJob(core, j.id)).status).toBe('succeeded');
  });

  it('取消排队中的任务会退回点数，重跑重新扣一次', async () => {
    const core = await makeCore({ mockTickMs: 200 });
    const w0 = core.store.wallet;
    const a = core.runner.create({ type: 'video', ws: 'w2', model: 'm-vid-c1', prompt: '占住队列', refs: [], ratio: '9:16', dur: 3, cam: '推近' });
    const b = core.runner.create({ type: 'video', ws: 'w2', model: 'm-vid-c1', prompt: '排队中', refs: [], ratio: '9:16', dur: 5, cam: '推近' });
    expect(core.store.jobs.get(b.id)!.status).toBe('queued');
    const { refunded } = core.runner.cancel(b.id);
    expect(refunded).toBe(true);
    core.runner.cancel(a.id);
    const w1 = core.store.wallet;
    expect(w1.balance).toBe(w0.balance);
    expect(w1.dailyUsed).toBe(w0.dailyUsed);
    core.runner.retry(b.id);
    expect(core.store.jobs.get(b.id)!.charged).toBe(true);
  });

  it('余额不足时拒绝创建', async () => {
    const core = await makeCore();
    expect(() =>
      core.runner.create({ type: 'video', ws: 'w1', model: 'm-vid-c1', prompt: '很贵', refs: [], ratio: '16:9', dur: 8, cam: '固定', count: 1 }),
    ).not.toThrow();
    expect(() =>
      core.runner.createMany(
        Array.from({ length: 6 }, () => ({ type: 'video' as const, ws: 'w1', model: 'm-vid-c1', prompt: '很贵', refs: [], ratio: '16:9', dur: 8, cam: '固定' })),
      ),
    ).toThrow(/点数不足/);
  });
});

/* ---------------- TreeCloud 合约测试：起一个假的上游 ---------------- */

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function fakeTreeCloud() {
  const calls: { method: string; url: string; body: any; auth?: string }[] = [];
  let polls = 0;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
      const json = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_test_1', ...headers });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/file.mp4') {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        return res.end(Buffer.from('fake-mp4'));
      }
      if (req.headers.authorization !== 'Bearer sk-tc-good') return json(401, { error: { message: 'bad key', code: 'invalid_api_key' } });
      if (req.url === '/v1/models') {
        return json(200, {
          object: 'list',
          data: [
            { id: 'img-pro', type: 'image', api_interfaces: [{ path: '/v1/images/generations' }], capabilities: [{ feature: 'generate', runtime_status: 'enabled', limits: { image_sizes: ['1024x1024', '1536x1024', '1024x1536'], max_outputs: 1 } }, { feature: 'reference_edit', runtime_status: 'enabled', limits: { max_input_images: 4 } }] },
            { id: 'img-off', type: 'image', capabilities: [{ feature: 'generate', runtime_status: 'blocked' }] },
            { id: 'seedance-x', type: 'video', api_interfaces: [{ path: '/api/v3/contents/generations/tasks' }] },
            { id: 'tts-1', api_interfaces: [{ path: '/v1/audio/speech' }] },
            { id: 'chat-pro', api_interfaces: [{ path: '/v1/chat/completions' }] },
            { id: 'whisper-x', api_interfaces: [{ path: '/v1/audio/transcriptions' }] },
          ],
        });
      }
      if (req.url === '/v1/images/generations' || req.url === '/v1/images/edits') {
        if (body.prompt.includes('没钱')) return json(402, { code: 17003, message: 'insufficient balance' });
        return json(200, { created: 1, data: [{ b64_json: PNG_1PX.toString('base64') }] });
      }
      if (req.url === '/api/v3/contents/generations/tasks' && req.method === 'POST') return json(200, { id: 'vid_123' });
      if (req.url === '/api/v3/contents/generations/tasks/vid_123') {
        polls += 1;
        if (polls < 2) return json(200, { id: 'vid_123', status: 'running' });
        return json(200, { id: 'vid_123', status: 'succeeded', duration: 5, content: { video_url: `http://127.0.0.1:${(srv.address() as any).port}/file.mp4` } });
      }
      if (req.url === '/file.mp4') {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        return res.end(Buffer.from('fake-mp4'));
      }
      if (req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        return res.end(Buffer.from([0xff, 0xfb, 0x90, 0x00, ...new Array(16000).fill(0)]));
      }
      if (req.url === '/v1/chat/completions') {
        return json(200, { choices: [{ message: { content: '```json\n{"result":"扩写后的提示词","neg":"模糊","note":"补了光线"}\n```' } }] });
      }
      json(404, { error: { message: 'not found' } });
    });
  });
  return new Promise<{ url: string; calls: typeof calls; close: () => void }>((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}`, calls, close: () => srv.close() });
    });
  });
}

async function treecloudCore(base: string, key = 'sk-tc-good') {
  const core = await makeCore();
  const s = core.store.settings;
  s.provider.treecloud.baseUrl = base;
  s.provider.treecloud.keyEnc = core.secrets.encrypt(key);
  s.provider.active = 'treecloud';
  core.store.settings = s;
  core.store.treecloudModels = await core.treecloud.fetchCatalog();
  return core;
}

describe('TreeCloudProvider', () => {
  it('模型目录：按类型归类，blocked 的 fail-closed，转写模型丢弃', async () => {
    const fake = await fakeTreeCloud();
    try {
      const core = await treecloudCore(fake.url);
      const cat = core.store.treecloudModels;
      const ids = cat.models.map((m) => `${m.id}:${m.type}:${m.status}`);
      expect(ids).toContain('tc:img-pro:image:on');
      expect(ids).toContain('tc:img-off:image:off');
      expect(ids).toContain('tc:seedance-x:video:on');
      expect(ids).toContain('tc:tts-1:audio:on');
      expect(cat.chat).toEqual(['chat-pro']);
      const pro = cat.models.find((m) => m.id === 'tc:img-pro')!;
      expect(pro.maxRes).toBe('1080p');
      expect(pro.maxInputImages).toBe(4);
    } finally {
      fake.close();
    }
  });

  it('图片：按尺寸档位请求、逐张请求凑够数量、b64 落盘', async () => {
    const fake = await fakeTreeCloud();
    try {
      const core = await treecloudCore(fake.url);
      const j = core.runner.create({ type: 'image', ws: 'w1', model: 'tc:img-pro', prompt: '一杯咖啡', refs: [{ src: '/samples/thumbs/img-01-coffee-poster.webp', w: 0.6 }], ratio: '16:9', count: 2, res: '1080p' });
      const done = await waitJob(core, j.id);
      expect(done.status).toBe('succeeded');
      expect(done.results).toHaveLength(2);
      const imgCalls = fake.calls.filter((c) => c.url.startsWith('/v1/images'));
      expect(imgCalls).toHaveLength(2);
      expect(imgCalls[0].url).toBe('/v1/images/edits');
      expect(imgCalls[0].body.size).toBe('1536x1024');
      expect(imgCalls[0].body.images[0].image_url).toMatch(/^data:image\/webp;base64,/);
      const r = core.store.results.get(done.results[0])!;
      expect(r.src).toMatch(/^\/files\/media\/.+\.png$/);
      expect(fs.existsSync(core.localPathOf(r.src)!)).toBe(true);
      expect(done.requestId).toBe('req_test_1');
    } finally {
      fake.close();
    }
  });

  it('图片：402 翻译成余额不足并退回点数', async () => {
    const fake = await fakeTreeCloud();
    try {
      const core = await treecloudCore(fake.url);
      const before = core.store.wallet;
      const j = core.runner.create({ type: 'image', ws: 'w1', model: 'tc:img-pro', prompt: '没钱了', refs: [], ratio: '1:1', count: 1, res: '1080p' });
      const done = await waitJob(core, j.id);
      expect(done.status).toBe('failed');
      expect(done.fail?.code).toBe('E-BAL-02');
      expect(done.fail?.reason).toContain('req_test_1');
      expect(core.store.wallet.balance).toBe(before.balance);
      expect(core.store.wallet.dailyUsed).toBe(before.dailyUsed);
    } finally {
      fake.close();
    }
  });

  it('视频：创建任务 → 轮询到成功 → 下载落盘；运镜写进提示词', async () => {
    const fake = await fakeTreeCloud();
    try {
      const core = await treecloudCore(fake.url);
      const j = core.runner.create({ type: 'video', ws: 'w2', model: 'tc:seedance-x', prompt: '海边日落', refs: [], ratio: '16:9', dur: 5, cam: '推近', vres: '720p' });
      const done = await waitJob(core, j.id);
      expect(done.fail).toBeUndefined();
      expect(done.status).toBe('succeeded');
      expect(done.upstreamTaskId).toBe('vid_123');
      const create = fake.calls.find((c) => c.method === 'POST' && c.url === '/api/v3/contents/generations/tasks')!;
      expect(create.body.content[0].text).toContain('运镜：推近');
      expect(create.body.resolution).toBe('720p');
      const r = core.store.results.get(done.results[0])!;
      expect(r.src).toMatch(/\.mp4$/);
      expect(r.dur).toBe(5);
    } finally {
      fake.close();
    }
  });

  it('语音：二进制落盘并估算时长；音乐用途在 TreeCloud 上直接失败退款', async () => {
    const fake = await fakeTreeCloud();
    try {
      const core = await treecloudCore(fake.url);
      const j = core.runner.create({ type: 'audio', ws: 'w3', model: 'tc:tts-1', prompt: '欢迎收听', refs: [], use: 'tts', dur: 30, voice: 'mu' });
      const done = await waitJob(core, j.id);
      expect(done.status).toBe('succeeded');
      expect(fake.calls.find((c) => c.url === '/v1/audio/speech')!.body.voice).toBe('onyx');
      expect(core.store.results.get(done.results[0])!.src).toMatch(/\.mp3$/);
      const m = core.runner.create({ type: 'audio', ws: 'w3', model: 'tc:tts-1', prompt: '音乐', refs: [], use: 'music', dur: 30 });
      const mdone = await waitJob(core, m.id);
      expect(mdone.fail?.code).toBe('E-CAP-01');
    } finally {
      fake.close();
    }
  });

  it('Key 无效时映射成 E-AUTH-01', async () => {
    const fake = await fakeTreeCloud();
    try {
      const core = await makeCore();
      const s = core.store.settings;
      s.provider.treecloud.baseUrl = fake.url;
      s.provider.treecloud.keyEnc = core.secrets.encrypt('sk-tc-bad');
      core.store.settings = s;
      await expect(core.treecloud.fetchCatalog()).rejects.toMatchObject({ code: 'E-AUTH-01' });
    } finally {
      fake.close();
    }
  });

  it('工具函数', () => {
    expect(classify({ id: 'x', api_interfaces: [{ path: '/v1/embeddings' }] })).toBeNull();
    expect(mp3Duration(Buffer.from([0xff, 0xfb, 0x90, 0x00, ...new Array(16000).fill(0)]))).toBe(1);
  });
});

describe('HTTP API', () => {
  it('bootstrap、CSRF 头、Host 校验', async () => {
    const core = await makeCore();
    const app = await buildApp(core);
    const boot = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { host: '127.0.0.1:5780' } });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().projects).toHaveLength(3);
    const noHeader = await app.inject({ method: 'POST', url: '/api/wallet/topup', headers: { host: 'localhost' }, payload: { amount: 10 } });
    expect(noHeader.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/wallet/topup', headers: { host: 'localhost', 'x-aigc-client': '1' }, payload: { amount: 10 } });
    expect(ok.json().got).toBe(20);
    const evil = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { host: 'evil.example.com' } });
    expect(evil.statusCode).toBe(403);
    await app.close();
  });

  it('桌面会话口令：没有 cookie 拒绝访问', async () => {
    const core = await makeCore();
    const app = await buildApp(core, { accessToken: 'secret-token' });
    expect((await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { host: 'localhost' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { host: 'localhost', cookie: 'aigc_token=secret-token' } });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it('本地 OpenAPI：Key 鉴权，同步出图', async () => {
    const core = await makeCore();
    const app = await buildApp(core);
    const created = await app.inject({ method: 'POST', url: '/api/keys', headers: { host: 'localhost', 'x-aigc-client': '1' }, payload: { name: '脚本' } });
    const secret = created.json().secret as string;
    expect(secret.startsWith('sk-local-')).toBe(true);
    const bad = await app.inject({ method: 'POST', url: '/openapi/v1/images/generations', headers: { host: 'localhost', authorization: 'Bearer nope' }, payload: { prompt: 'x' } });
    expect(bad.statusCode).toBe(401);
    const res = await app.inject({
      method: 'POST',
      url: '/openapi/v1/images/generations',
      headers: { host: 'localhost', authorization: `Bearer ${secret}` },
      payload: { prompt: '一张图', n: 1, size: '1024x1024' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].url).toMatch(/^http:\/\/localhost\/samples\//);
    expect(core.store.apiUsage.size).toBe(1);
    await app.close();
  });
});
