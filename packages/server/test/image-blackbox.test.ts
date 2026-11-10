import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Job, ServerEvent } from '@aigc/shared';
import { buildApp } from '../src/app';
import { Core } from '../src/core';

/* 图像创作的黑盒测试：只走应用自己的 HTTP 接口，平台网关换成本机假 LiteLLM。
   假网关完全不碰真实平台，也不产生任何点数。 */

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

interface Seen {
  method: string;
  url: string;
  auth?: string;
  json?: Record<string, unknown>;
  form?: string;
}

let gw: http.Server;
let gwUrl = '';
const seen: Seen[] = [];
const cores: Core[] = [];

beforeAll(async () => {
  gw = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = req.url || '';
      const auth = req.headers.authorization;
      const isForm = /multipart\/form-data/i.test(String(req.headers['content-type'] || ''));
      let body: Record<string, unknown> | undefined;
      if (raw.length && !isForm) {
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          body = undefined;
        }
      }
      seen.push({ method: req.method || '', url, auth, json: body, form: isForm ? raw.toString('latin1') : undefined });

      if (url.endsWith('/models')) {
        return json(200, {
          object: 'list',
          data: [
            { id: 'gemini-3.1-flash-image', protocol: 'openai', mode: 'image_generation', pricing: { per_image: 0.039 } },
            { id: 'qwen-image-3.0', protocol: 'openai', mode: 'image_generation', pricing: { per_image: 0.03 } },
          ],
        });
      }
      if (url.endsWith('/v1/images/generations')) {
        if (body?.model === 'qwen-image-3.0') {
          return json(403, {
            error: {
              message:
                'litellm.APIError: APIError: OpenAIException - {"code":"GROUP_ROUTING_FAILED","message":"No authorized bound group supports this request"}',
              type: 'permission_error',
              code: '403',
            },
          });
        }
        const n = Math.max(1, Number(body?.n) || 1);
        return json(200, { data: Array.from({ length: n }, () => ({ b64_json: PNG.toString('base64') })) });
      }
      if (url.endsWith('/v1/images/edits')) {
        return json(200, { data: [{ b64_json: PNG.toString('base64') }] });
      }
      json(404, { error: { message: 'unexpected' } });
    });
  });
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', () => r()));
  gwUrl = `http://127.0.0.1:${(gw.address() as { port: number }).port}`;
});

afterAll(() => {
  gw.close();
});

afterEach(() => {
  while (cores.length) cores.pop()!.close();
  seen.length = 0;
});

const H = { host: 'localhost', 'x-aigc-client': '1' };

async function makeApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-image-'));
  const core = await Core.create({
    dataDir,
    mode: 'web',
    desktop: false,
    version: 'test',
    memory: true,
    platformPollMs: 1,
    account: { provider: 'fastsso', apiBase: 'http://account.test/api/v1', gatewayBase: gwUrl },
  });
  cores.push(core);
  /* 已经登录 + 本地拿着模型密钥：不经过账号服务 */
  core.accounts.status = 'logged_in';
  (core.accounts as unknown as { tokens: unknown }).tokens = { accessToken: 'at-test', refreshToken: 'rt-test', expiresAt: Date.now() + 3600_000 };
  core.accounts.profile = { id: 'u1', nickname: '测试', createdAt: Date.now() };
  core.store.setLlmKey('u1', core.secrets.encrypt('sk-test'));
  core.runner.start();
  await core.platform.models();
  const app = await buildApp(core);
  return { core, app, dataDir };
}

function waitJob(core: Core, id: string) {
  return new Promise<Job>((resolve, reject) => {
    const cur = core.store.jobs.get(id);
    if (cur && ['succeeded', 'failed', 'canceled'].includes(cur.status)) return resolve(cur);
    const t = setTimeout(() => reject(new Error(`timeout waiting ${id}`)), 10_000);
    const off = core.events.on((e: ServerEvent) => {
      if (e.type === 'job' && e.job.id === id && ['succeeded', 'failed', 'canceled'].includes(e.job.status)) {
        clearTimeout(t);
        off();
        resolve(e.job);
      }
    });
  });
}

describe('图像创作黑盒：HTTP → 平台 Provider → 本地假网关', () => {
  it('模型没有通道：任务失败有明确原因，模型暂时下架，再提交被拦住', async () => {
    const { core, app } = await makeApp();
    const ws = core.bootstrap().projects[0].id;
    const created = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: H,
      payload: { jobs: [{ type: 'image', ws, model: 'cloud:qwen-image-3.0', prompt: '海报', refs: [], ratio: '1:1', count: 1, res: '2k' }] },
    });
    expect(created.statusCode, created.body).toBe(200);
    const job = await waitJob(core, created.json().jobs[0].id);
    expect(job.status).toBe('failed');
    expect(job.fail).toMatchObject({ code: 'E-MOD-06' });
    expect(job.fail!.reason).toContain('没有为');
    expect(job.fail!.fix).toContain('换一个模型');

    const models = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: H })).json().models as { id: string; status: string }[];
    expect(models.find((m) => m.id === 'cloud:qwen-image-3.0')!.status).toBe('off');

    const again = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: H,
      payload: { jobs: [{ type: 'image', ws, model: 'cloud:qwen-image-3.0', prompt: '海报', refs: [], ratio: '1:1', count: 1, res: '2k' }] },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toContain('当前不可用');

    /* 修复重试换成另一个可用模型，并真的跑完 */
    const fixed = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/fix`, headers: H });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().job.model).toBe('cloud:gemini-3.1-flash-image');
    const done = await waitJob(core, job.id);
    expect(done.status).toBe('succeeded');
  });

  it('文生图：数量按 n 提交，b64_json 落盘，产出数量对得上', async () => {
    const { core, app } = await makeApp();
    const ws = core.bootstrap().projects[0].id;
    const created = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: H,
      payload: { jobs: [{ type: 'image', ws, model: 'cloud:gemini-3.1-flash-image', prompt: '一杯咖啡', refs: [], ratio: '1:1', count: 2, res: '2k' }] },
    });
    expect(created.statusCode).toBe(200);
    const job = await waitJob(core, created.json().jobs[0].id);
    expect(job.status).toBe('succeeded');
    expect(job.results).toHaveLength(2);
    for (const id of job.results) {
      const r = core.store.results.get(id)!;
      expect(fs.existsSync(core.localPathOf(r.src)!)).toBe(true);
    }
    const gen = seen.filter((s) => s.url.endsWith('/v1/images/generations'));
    expect(gen).toHaveLength(1);
    expect(gen[0].auth).toBe('Bearer sk-test');
    expect(gen[0].json).toMatchObject({ model: 'gemini-3.1-flash-image', n: 2 });
    expect(gen[0].json).not.toHaveProperty('response_format');
    expect(String(gen[0].json!.prompt)).toContain('画幅 1:1');
  });

  it('参考图：走 /v1/images/edits，multipart 带上全部参考图，不退回文生图', async () => {
    const { core, app, dataDir } = await makeApp();
    const ws = core.bootstrap().projects[0].id;
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'uploads', 'a.png'), PNG);
    fs.writeFileSync(path.join(dataDir, 'uploads', 'b.png'), PNG);
    const created = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: H,
      payload: {
        jobs: [
          {
            type: 'image',
            ws,
            model: 'cloud:gemini-3.1-flash-image',
            prompt: '保留主体，把背景换成雪山',
            refs: [{ src: '/files/uploads/a.png', w: 0.6 }, { src: '/files/uploads/b.png', w: 0.4 }],
            ratio: '4:3',
            count: 1,
            res: '2k',
          },
        ],
      },
    });
    expect(created.statusCode).toBe(200);
    const job = await waitJob(core, created.json().jobs[0].id);
    expect(job.status).toBe('succeeded');
    const edit = seen.find((s) => s.url.endsWith('/v1/images/edits'))!;
    expect(edit).toBeTruthy();
    expect(edit.form).toContain('name="image[]"');
    expect(edit.form!.match(/name="image\[\]"/g)).toHaveLength(2);
    expect(edit.form).toContain('gemini-3.1-flash-image');
    expect(seen.some((s) => s.url.endsWith('/v1/images/generations'))).toBe(false);
  });
});
