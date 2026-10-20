import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Job, Result } from '@aigc/shared';
import type { Core } from './core';
import { HttpError } from './runner';
import { sha256 } from './secrets';
import { createJobSchema } from './schemas';

/* ============================================================================
   本地 OpenAPI：给专业用户接进脚本 / agent。和网页共用同一份点数余额，
   用「API 接入」页创建的 sk-local- Key 鉴权；调用失败不扣费。
   ========================================================================== */

const imageGenSchema = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1).max(8000),
  n: z.number().int().min(1).max(8).optional(),
  size: z.string().optional(),
  ratio: z.string().optional(),
  res: z.enum(['1080p', '2k', '4k']).optional(),
  project: z.string().optional(),
});

function sizeToRatio(size?: string) {
  const m = /^(\d+)x(\d+)$/.exec(size || '');
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const r = w / h;
  const table: [string, number][] = [['1:1', 1], ['4:5', 0.8], ['16:9', 16 / 9], ['9:16', 9 / 16]];
  return table.sort((a, b) => Math.abs(a[1] - r) - Math.abs(b[1] - r))[0][0];
}

export function registerOpenApi(app: FastifyInstance, core: Core) {
  const auth = (req: FastifyRequest) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token) throw new HttpError(401, '缺少 Authorization: Bearer <sk-local-…>');
    const hash = sha256(token.trim());
    const key = core.store.apiKeys.all().find((k) => k.hash === hash);
    if (!key) throw new HttpError(401, 'API Key 无效');
    if (!key.on) throw new HttpError(403, 'API Key 已停用');
    core.store.apiKeys.put({ ...key, lastUsedAt: Date.now() });
    return key;
  };

  const absolute = (req: FastifyRequest, src: string) => (src.startsWith('/') ? `${req.protocol}://${req.headers.host}${src}` : src);
  const defaultWs = () => core.store.projects.all().sort((a, b) => a.createdAt - b.createdAt)[0]?.id;
  const jobView = (req: FastifyRequest, j: Job) => ({
    id: j.id,
    status: j.status,
    progress: j.progress ?? 0,
    cost: j.cost,
    fail: j.fail,
    results: j.results
      .map((id) => core.store.results.get(id))
      .filter((r): r is Result => !!r)
      .map((r) => ({ id: r.id, type: r.type, url: absolute(req, r.src), mime: r.mime })),
  });

  /** 并发上限：同一时间排队 + 生成中的 API 任务最多 8 个，超出返回 429 */
  const guardConcurrency = () => {
    const active = core.store.jobs.all().filter((j) => j.source === 'api' && (j.status === 'queued' || j.status === 'running')).length;
    if (active >= 8) throw new HttpError(429, '超出并发上限，稍后再试');
  };

  const waitFor = (id: string, timeoutMs: number) =>
    new Promise<Job>((resolve) => {
      const done = (j?: Job) => {
        clearTimeout(t);
        off();
        resolve(j || core.store.jobs.get(id)!);
      };
      const off = core.events.on((e) => {
        if (e.type === 'job' && e.job.id === id && ['succeeded', 'failed', 'canceled'].includes(e.job.status)) done(e.job);
      });
      const t = setTimeout(() => done(), timeoutMs);
      const cur = core.store.jobs.get(id);
      if (cur && ['succeeded', 'failed', 'canceled'].includes(cur.status)) done(cur);
    });

  app.get('/openapi/v1/models', async (req) => {
    const key = auth(req);
    return {
      object: 'list',
      data: core
        .models()
        .filter((m) => m.channel === key.channel && m.status === 'on')
        .map((m) => ({ id: m.id, name: m.name, type: m.type, price: m.price, basis: m.basis })),
    };
  });

  /** OpenAI 风格的同步出图：等任务完成再返回（最多 10 分钟） */
  app.post('/openapi/v1/images/generations', async (req) => {
    const key = auth(req);
    guardConcurrency();
    const body = imageGenSchema.parse(req.body);
    const model =
      (body.model && core.models().find((m) => m.id === body.model || m.upstream === body.model)) ||
      core.models().find((m) => m.type === 'image' && m.channel === key.channel && m.status === 'on');
    if (!model) throw new HttpError(400, '没有可用的图像模型');
    const ws = body.project && core.store.projects.get(body.project) ? body.project : defaultWs();
    if (!ws) throw new HttpError(400, '没有可用的项目');
    const job = core.runner.create(
      {
        type: 'image',
        ws,
        model: model.id,
        prompt: body.prompt,
        refs: [],
        count: body.n || 1,
        ratio: body.ratio || sizeToRatio(body.size) || '1:1',
        res: body.res || '2k',
      },
      'api',
      key.id,
    );
    if (job.status === 'failed') throw new HttpError(400, job.fail?.reason || '参数校验失败', job.fail?.fix);
    const done = await waitFor(job.id, 600_000);
    if (done.status !== 'succeeded') {
      throw new HttpError(done.status === 'failed' ? 502 : 504, done.fail?.reason || '生成没有在时限内完成', done.fail?.fix);
    }
    return {
      created: Math.floor(Date.now() / 1000),
      data: jobView(req, done).results.map((r) => ({ url: r.url })),
      job_id: done.id,
      cost: done.cost,
    };
  });

  /** 通用异步任务：提交后轮询 GET /openapi/v1/jobs/:id */
  app.post('/openapi/v1/jobs', async (req) => {
    const key = auth(req);
    guardConcurrency();
    const raw = (req.body || {}) as Record<string, unknown>;
    const body = createJobSchema.parse({ refs: [], ws: raw.ws || defaultWs(), ...raw });
    const job = core.runner.create(body, 'api', key.id);
    return jobView(req, job);
  });

  app.get('/openapi/v1/jobs/:id', async (req) => {
    auth(req);
    const job = core.store.jobs.get((req.params as { id: string }).id);
    if (!job || job.source !== 'api') throw new HttpError(404, '任务不存在');
    return jobView(req, job);
  });
}
