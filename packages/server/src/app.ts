import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { AestheticItem, Board, OrderDto, PackDto, Post, Project, Result, ServerEvent, UsageRequest, UsageSummary } from '@aigc/shared';
import { PROJECT_DOTS, uid } from '@aigc/shared';
import { enhanceAgent, optimizePrompt } from './assist';
import { CloudError } from './cloud/client';
import type { Core } from './core';
import { mimeOfExt } from './core';
import { linkPreview } from './linkPreview';
import { registerOpenApi } from './openapi';
import { HttpError } from './runner';
import { safeEqual, sha256 } from './secrets';
import * as S from './schemas';

export interface AppOptions {
  /** 访问口令：桌面模式是每次启动随机生成的会话口令；Web 局域网模式是用户设置的口令 */
  accessToken?: string;
  /** 允许的 Host（局域网模式下放开） */
  lan?: boolean;
  logger?: boolean;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function parseCookies(header?: string) {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const LOGIN_HTML = (msg = '') => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIGC 创作台 · 访问口令</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F7FB;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#171A23}
form{background:#fff;border:1px solid #E6E8EF;border-radius:14px;padding:28px;width:320px;box-shadow:0 10px 30px rgba(20,24,40,.06)}
h1{font-size:17px;margin:0 0 6px}p{color:#5B6275;margin:0 0 16px;font-size:12.5px}
input{width:100%;box-sizing:border-box;border:1px solid #D9DCE6;border-radius:9px;padding:10px 12px;font-size:14px}
button{margin-top:12px;width:100%;border:0;border-radius:9px;padding:10px;background:#4F46E5;color:#fff;font-weight:600;font-size:14px;cursor:pointer}
.err{color:#E11D48;font-size:12px;margin-top:8px}</style></head><body>
<form method="get" action="/login"><h1>AIGC 创作台</h1><p>这台服务开放了局域网访问，需要访问口令。口令在服务端的「设置 · 运行模式」里设置。</p>
<input name="token" type="password" placeholder="访问口令" autofocus/><button>进入</button>${msg ? `<div class="err">${msg}</div>` : ''}</form></body></html>`;

const cloudErr = (e: unknown) => {
  if (e instanceof CloudError) return new HttpError(e.status >= 400 && e.status < 600 ? e.status : 502, e.message, e.requestId ? `请求 ID ${e.requestId}` : undefined);
  return e as HttpError;
};

export async function buildApp(core: Core, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 80 * 1024 * 1024, trustProxy: false, forceCloseConnections: true });
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024, files: 20 } });

  /* ---------------- 访问控制 ---------------- */

  const tokenOk = (req: FastifyRequest) => {
    const cookie = parseCookies(req.headers.cookie).aigc_token || '';
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '';
    const given = cookie || bearer;
    if (opts.accessToken) return !!given && safeEqual(given, opts.accessToken);
    const hash = core.store.settings.runtime.tokenHash;
    if (opts.lan && hash) return !!given && safeEqual(sha256(given), hash);
    return true;
  };

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    /* 防 DNS 重绑定：只认本机 Host，局域网模式除外 */
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!opts.lan && !LOOPBACK.has(host)) {
      return reply.code(403).send({ error: '不接受这个 Host 的访问' });
    }
    if (url.startsWith('/openapi/')) return;
    if (url.startsWith('/login')) return;
    if (!tokenOk(req)) {
      if (url.startsWith('/api/')) return reply.code(401).send({ error: '需要访问口令' });
      return reply.code(401).type('text/html; charset=utf-8').send(LOGIN_HTML());
    }
    /* 防 CSRF：写操作必须带自定义头（跨站页面带不上，而我们不开 CORS） */
    if (url.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-aigc-client'] !== '1') {
      return reply.code(403).send({ error: '缺少客户端标识' });
    }
  });

  app.get('/login', async (req, reply) => {
    const token = String((req.query as { token?: string }).token || '');
    const ok = opts.accessToken ? safeEqual(token, opts.accessToken) : core.store.settings.runtime.tokenHash ? safeEqual(sha256(token), core.store.settings.runtime.tokenHash) : true;
    if (!ok) return reply.code(401).type('text/html; charset=utf-8').send(LOGIN_HTML(token ? '口令不对' : ''));
    reply.header('Set-Cookie', `aigc_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
    return reply.redirect('/');
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, detail: err.detail });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: '参数不合法', detail: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；') });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    core.events.notice('warn', '服务出错了', e.message);
    return reply.code(500).send({ error: e.message || '服务出错了' });
  });

  /* ---------------- 静态资源 ---------------- */

  await app.register(fastifyStatic, { root: core.mediaDir, prefix: '/files/media/', decorateReply: false, maxAge: '30d', immutable: true });
  await app.register(fastifyStatic, { root: core.uploadsDir, prefix: '/files/uploads/', decorateReply: false, maxAge: '30d', immutable: true });
  const webDir = core.opts.webDir && fs.existsSync(path.join(core.opts.webDir, 'index.html')) ? path.resolve(core.opts.webDir) : null;
  if (webDir) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      wildcard: false,
      decorateReply: false,
      setHeaders(reply, file: string) {
        if (file.endsWith('index.html')) reply.header('Cache-Control', 'no-cache');
      },
    });
    const indexHtml = () => fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
    app.get('/assets/*', async (_req, reply) => reply.code(404).send('Not found'));
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/files/')) {
        return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(indexHtml());
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html; charset=utf-8').send('<p style="font-family:sans-serif">AIGC 创作台服务已启动。开发模式下请打开 Vite 地址（默认 http://localhost:5173）。</p>'),
    );
  }

  /* ---------------- 基础 ---------------- */

  app.get('/api/health', async () => ({ ok: true, version: core.opts.version }));
  app.get('/api/bootstrap', async () => core.bootstrap());

  /* 关闭服务时主动结束长连接，否则 close() 会一直等着 */
  const sse = new Set<import('node:http').ServerResponse>();
  app.addHook('onClose', async () => {
    for (const r of sse) r.end();
    sse.clear();
  });

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const send = (e: ServerEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const off = core.events.on(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    const end = () => {
      off();
      clearInterval(ping);
    };
    sse.add(res);
    req.raw.on('close', () => {
      end();
      sse.delete(res);
    });
  });

  /* ---------------- 账号（云端） ---------------- */

  app.get('/api/auth/session', async () => ({ session: core.sessionInfo(), wallet: core.session.wallet }));
  app.post('/api/auth/login', async (req) => {
    const body = (req.body || {}) as { deviceName?: string };
    return core.session.loginStart(core.opts.desktop ? 'desktop' : 'web', body.deviceName).catch((e) => {
      throw cloudErr(e);
    });
  });
  app.post('/api/auth/poll', async () => {
    const r = await core.session.loginPoll().catch((e) => {
      throw cloudErr(e);
    });
    if (r.status === 'approved') {
      core.store.cloudModelsCache = core.session.models;
      core.emitModels();
    }
    return r;
  });
  app.post('/api/auth/cancel', async () => {
    core.session.loginCancel();
    return { ok: true };
  });
  app.post('/api/auth/logout', async () => {
    await core.session.logout();
    core.emitModels();
    return { ok: true };
  });

  /* ---------------- 计费（云端） ---------------- */

  app.get('/api/billing/packs', async () => ({
    packs: await core.session.client.request<PackDto[]>('/billing/packs').catch((e) => {
      throw cloudErr(e);
    }),
  }));
  app.post('/api/billing/orders', async (req) => {
    const body = S.orderSchema.parse(req.body);
    const order = await core.session.client.request<OrderDto>('/billing/orders', { json: body }).catch((e) => {
      throw cloudErr(e);
    });
    core.events.emit({ type: 'order', order });
    return { order };
  });
  app.get('/api/billing/orders/:id', async (req) => ({
    order: await core.session.client.request<OrderDto>(`/billing/orders/${encodeURIComponent((req.params as { id: string }).id)}`).catch((e) => {
      throw cloudErr(e);
    }),
  }));
  app.get('/api/billing/orders', async () => ({
    orders: await core.session.client.request<OrderDto[]>('/billing/orders').catch((e) => {
      throw cloudErr(e);
    }),
  }));
  app.post('/api/billing/wallet/refresh', async () => ({ wallet: await core.session.refreshWallet() }));
  app.get('/api/usage/summary', async (req) => {
    const q = req.query as { from?: string; to?: string };
    const qs = new URLSearchParams();
    if (q.from) qs.set('from', q.from);
    if (q.to) qs.set('to', q.to);
    return core.session.client.request<UsageSummary>(`/usage/summary?${qs}`).catch((e) => {
      throw cloudErr(e);
    });
  });
  app.get('/api/usage/requests', async (req) => {
    const q = req.query as { cursor?: string };
    return core.session.client.request<{ items: UsageRequest[]; next?: string }>(`/usage/requests${q.cursor ? `?cursor=${encodeURIComponent(q.cursor)}` : ''}`).catch((e) => {
      throw cloudErr(e);
    });
  });

  /* ---------------- 任务 ---------------- */

  app.post('/api/jobs', async (req) => {
    const body = S.createJobsSchema.parse(req.body);
    return { jobs: core.runner.createMany(body.jobs, 'web') };
  });
  app.post('/api/jobs/:id/cancel', async (req) => core.runner.cancel((req.params as { id: string }).id));
  app.post('/api/jobs/:id/retry', async (req) => ({ job: core.runner.retry((req.params as { id: string }).id) }));
  app.post('/api/jobs/:id/fix', async (req) => core.runner.fix((req.params as { id: string }).id));

  /* ---------------- 产出 ---------------- */

  const emitResult = (r: Result) => {
    core.store.results.put(r);
    core.events.emit({ type: 'result', result: r });
    return r;
  };

  app.patch('/api/results/:id', async (req) => {
    const r = core.store.results.get((req.params as { id: string }).id);
    if (!r) throw new HttpError(404, '产出不存在');
    const body = S.patchResultSchema.parse(req.body);
    if (body.title !== undefined) body.title = body.title.trim() || r.title;
    return { result: emitResult({ ...r, ...body }) };
  });

  app.delete('/api/results/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const r = core.store.results.get(id);
    if (!r) throw new HttpError(404, '产出不存在');
    core.store.results.del(id);
    for (const j of core.store.jobs.all()) {
      if (j.results.includes(id)) {
        j.results = j.results.filter((x) => x !== id);
        core.store.jobs.put(j);
        core.events.emit({ type: 'job', job: j });
      }
    }
    core.removeMediaIfOrphan(r.src);
    core.events.emit({ type: 'result.deleted', id });
    return { ok: true };
  });

  /** 编辑器「保存为新产出」：原素材不变，生成一条标记为已编辑的新产出 */
  app.post('/api/results/edited', async (req) => {
    const body = S.saveEditedSchema.parse(req.body);
    const src = core.store.results.get(body.sourceId);
    if (!src) throw new HttpError(404, '原素材不存在');
    let file = src.src;
    let thumb = src.thumb;
    let mime = src.mime;
    let css = body.edit.css;
    if (body.dataUrl) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(body.dataUrl);
      if (!m) throw new HttpError(400, '图片数据不合法');
      const saved = await core.saveMedia(Buffer.from(m[2], 'base64'), m[1]);
      file = saved.src;
      thumb = saved.src;
      mime = saved.mime;
      css = undefined;
    }
    const r: Result = {
      ...src,
      id: uid('r'),
      job: null,
      title: body.title,
      src: file,
      thumb,
      mime,
      createdAt: Date.now(),
      status: 'new',
      isNew: true,
      tags: body.tags,
      home: 'library',
      edit: { css, ops: body.edit.ops },
    };
    return { result: emitResult(r) };
  });

  /** 收件箱「全部不收」：当前项目没取用的产出沉入草稿箱 */
  app.post('/api/inbox/:ws/drop', async (req) => ({ count: core.runner.settleInbox((req.params as { ws: string }).ws) }));

  app.get('/api/download', async (req, reply) => {
    const q = req.query as { src?: string; name?: string };
    const file = q.src ? core.localPathOf(q.src) : null;
    if (!file || !fs.existsSync(file)) throw new HttpError(404, '文件不存在');
    const ext = path.extname(file);
    const name = `${(q.name || 'aigc').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}${ext}`;
    reply.header('Content-Type', mimeOfExt(ext));
    reply.header('Content-Disposition', `attachment; filename="download${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(fs.createReadStream(file));
  });

  /* ---------------- 画板 ---------------- */

  app.put('/api/boards/:ws', async (req) => {
    const ws = (req.params as { ws: string }).ws;
    if (!core.store.projects.get(ws)) throw new HttpError(404, '项目不存在');
    const board = S.boardSchema.parse(req.body) as unknown as Board;
    core.store.saveBoard(ws, board);
    return { ok: true };
  });

  /* ---------------- 项目 ---------------- */

  app.post('/api/projects', async (req) => {
    const body = S.projectSchema.parse(req.body);
    const n = core.store.projects.size;
    const p: Project = { id: uid('w'), name: body.name.trim(), dot: body.dot || PROJECT_DOTS[n % PROJECT_DOTS.length], used: 0, createdAt: Date.now() };
    core.store.projects.put(p);
    core.events.emit({ type: 'project', project: p });
    return { project: p, board: core.store.board(p.id) };
  });

  app.patch('/api/projects/:id', async (req) => {
    const p = core.store.projects.get((req.params as { id: string }).id);
    if (!p) throw new HttpError(404, '项目不存在');
    const body = S.projectSchema.partial().parse(req.body);
    const next = { ...p, ...(body.name ? { name: body.name.trim() } : {}), ...(body.dot ? { dot: body.dot } : {}) };
    core.store.projects.put(next);
    core.events.emit({ type: 'project', project: next });
    return { project: next };
  });

  app.delete('/api/projects/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    if (!core.store.projects.get(id)) throw new HttpError(404, '项目不存在');
    if (core.store.projects.size <= 1) throw new HttpError(400, '至少要留一个项目');
    if (core.store.jobs.all().some((j) => j.ws === id && (j.status === 'running' || j.status === 'queued'))) {
      throw new HttpError(400, '这个项目还有进行中的任务', '先取消或等它们完成');
    }
    for (const r of core.store.results.all().filter((x) => x.ws === id)) {
      core.store.results.del(r.id);
      core.removeMediaIfOrphan(r.src);
    }
    for (const j of core.store.jobs.all().filter((x) => x.ws === id)) core.store.jobs.del(j.id);
    for (const p of core.store.posts.all().filter((x) => x.ws === id)) core.store.posts.del(p.id);
    core.store.boards.del(id);
    core.store.projects.del(id);
    core.events.emit({ type: 'project.deleted', id });
    return { ok: true };
  });

  /* ---------------- 审美库 / 帖子 ---------------- */

  app.post('/api/aesthetic', async (req, reply) => {
    const body = S.aestheticSchema.parse(req.body);
    const dup = core.store.aesthetic.all().find((a) => a.key === body.key);
    if (dup) return reply.code(409).send({ error: '已经在审美库里了', item: dup });
    const a: AestheticItem = { ...body, id: uid('a'), createdAt: Date.now() };
    core.store.aesthetic.put(a);
    return { item: a };
  });
  app.delete('/api/aesthetic/:id', async (req) => {
    core.store.aesthetic.del((req.params as { id: string }).id);
    return { ok: true };
  });

  app.put('/api/posts/:id', async (req) => {
    const body = S.postSchema.parse(req.body);
    const p: Post = { ...body, id: (req.params as { id: string }).id, updatedAt: Date.now() };
    core.store.posts.put(p);
    return { post: p };
  });
  app.delete('/api/posts/:id', async (req) => {
    core.store.posts.del((req.params as { id: string }).id);
    return { ok: true };
  });

  /* ---------------- 设置 ---------------- */

  const refreshDirect = async () => {
    const s = core.store.settings;
    try {
      const cat = await core.direct.fetchCatalog();
      core.store.directModels = cat;
      s.direct.lastCheck = { ok: true, at: Date.now(), message: `连接正常 · ${cat.models.length} 个生成模型 · ${cat.chat.length} 个对话模型` };
      if (s.chat.model && !cat.chat.includes(s.chat.model)) s.chat.model = cat.chat[0] || '';
    } catch (e) {
      const err = e as { reason?: string; message?: string };
      s.direct.lastCheck = { ok: false, at: Date.now(), message: err.reason || err.message || '连接失败' };
    }
    core.store.settings = s;
    core.emitModels();
    const pub = core.publicSettings();
    core.events.emit({ type: 'settings', settings: pub });
    return pub;
  };

  app.patch('/api/settings', async (req) => {
    const body = S.settingsSchema.parse(req.body);
    const s = core.store.settings;
    let needDirect = false;
    if (body.cloud?.baseUrl !== undefined) s.cloud.baseUrl = body.cloud.baseUrl.replace(/\/+$/, '');
    if (body.runner?.concurrency) s.runner.concurrency = body.runner.concurrency;
    if (body.direct) {
      const d = body.direct;
      if (d.baseUrl) {
        s.direct.baseUrl = d.baseUrl.replace(/\/+$/, '');
        needDirect = true;
      }
      if (d.clearKey) {
        delete s.direct.keyEnc;
        delete s.direct.keyHint;
        delete s.direct.lastCheck;
        s.direct.enabled = false;
        core.store.directModels = { models: [], chat: [], at: 0 };
      }
      if (d.apiKey) {
        const key = d.apiKey.trim();
        s.direct.keyEnc = core.secrets.encrypt(key);
        s.direct.keyHint = `${key.slice(0, 6)}…${key.slice(-4)}`;
        needDirect = true;
      }
      if (d.enabled !== undefined) {
        if (d.enabled && !s.direct.keyEnc) throw new HttpError(400, '先填入你自己的 TreeCloud API Key');
        s.direct.enabled = d.enabled;
      }
    }
    if (body.chat?.model !== undefined) s.chat.model = body.chat.model;
    if (body.prices) {
      for (const [k, v] of Object.entries(body.prices)) {
        if (v == null) delete s.prices[k];
        else s.prices[k] = v;
      }
    }
    if (body.runtime) {
      const r = body.runtime;
      if (r.token) s.runtime.tokenHash = sha256(r.token);
      if (r.clearToken) delete s.runtime.tokenHash;
      if (r.lan && !s.runtime.tokenHash) throw new HttpError(400, '开放局域网访问前，先设置访问口令');
      core.writeLaunch({
        ...(r.mode ? { mode: r.mode } : {}),
        ...(r.port ? { port: r.port } : {}),
        ...(r.lan !== undefined ? { lan: r.lan, host: r.lan ? '0.0.0.0' : '127.0.0.1' } : {}),
      });
    }
    core.store.settings = s;
    if (body.cloud?.baseUrl !== undefined) {
      /* 云端地址变了：重新探测；已登录的话重建事件流 */
      const probe = await core.session.probe();
      if (probe.ok && !core.session.loggedIn) await core.session.restore();
      core.events.emit({ type: 'session', session: core.sessionInfo() });
    }
    if (needDirect && s.direct.keyEnc) return { settings: await refreshDirect() };
    core.emitModels();
    const pub = core.publicSettings();
    core.events.emit({ type: 'settings', settings: pub });
    return { settings: pub };
  });

  app.post('/api/settings/direct/refresh', async () => {
    if (!core.store.settings.direct.keyEnc) throw new HttpError(400, '先填入你自己的 TreeCloud API Key');
    return { settings: await refreshDirect() };
  });

  app.post('/api/settings/cloud/refresh', async () => {
    const probe = await core.session.probe();
    if (probe.ok && core.session.loggedIn) {
      await core.session.refreshWallet().catch(() => {});
      await core.session.refreshModels().catch(() => {});
      core.store.cloudModelsCache = core.session.models;
      core.emitModels();
    }
    core.events.emit({ type: 'session', session: core.sessionInfo() });
    return { ok: probe.ok, message: probe.message, meta: probe.meta };
  });

  app.put('/api/ui', async (req) => {
    const body = (req.body || {}) as Record<string, unknown>;
    core.store.ui = { ...core.store.ui, ...body };
    return { ok: true };
  });

  /* ---------------- 文件 / 链接预览 ---------------- */

  app.post('/api/files', async (req) => {
    const out = [];
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      const ext = path.extname(part.filename || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8) || '.bin';
      const name = `${uid('u')}${ext}`;
      await fs.promises.writeFile(path.join(core.uploadsDir, name), buf);
      out.push({ url: `/files/uploads/${name}`, name: part.filename, size: buf.length, mime: part.mimetype });
    }
    if (!out.length) throw new HttpError(400, '没有收到文件');
    return { files: out };
  });

  app.get('/api/link-preview', async (req) => {
    const url = String((req.query as { url?: string }).url || '');
    if (!/^https?:\/\//i.test(url)) throw new HttpError(400, '不是有效的链接');
    try {
      return await linkPreview(core, url);
    } catch (e) {
      return { url, error: (e as Error).message };
    }
  });

  /* ---------------- 提示词辅助（走真实模型路由） ---------------- */

  app.post('/api/assist/optimize', async (req) => {
    const body = S.optimizeSchema.parse(req.body);
    return optimizePrompt(core, body.type, body.prompt);
  });
  app.post('/api/assist/agent', async (req) => {
    const body = S.agentSchema.parse(req.body);
    return { enhanced: await enhanceAgent(core, body) };
  });

  /* ---------------- 本地 API Key（OpenAPI 鉴权用） ---------------- */

  const emitApi = () => core.events.emit({ type: 'api', apiKeys: core.store.apiKeys.all().map(({ hash: _h, ...k }) => k) });

  app.post('/api/keys', async (req) => {
    const body = S.keySchema.parse(req.body || {});
    const secret = `sk-local-${crypto.randomBytes(18).toString('hex')}`;
    const n = core.store.apiKeys.size + 1;
    const k = {
      id: uid('k'),
      name: body.name || `新 Key ${n}`,
      channel: (body.channel || 'cloud') as 'cloud' | 'direct',
      masked: `${secret.slice(0, 13)}······${secret.slice(-3)}`,
      createdAt: Date.now(),
      on: true,
      hash: sha256(secret),
    };
    core.store.apiKeys.put(k);
    emitApi();
    const { hash: _h, ...pub } = k;
    return { key: pub, secret };
  });
  app.patch('/api/keys/:id', async (req) => {
    const k = core.store.apiKeys.get((req.params as { id: string }).id);
    if (!k) throw new HttpError(404, 'Key 不存在');
    const body = S.keyPatchSchema.parse(req.body);
    core.store.apiKeys.put({ ...k, ...body });
    emitApi();
    return { ok: true };
  });
  app.delete('/api/keys/:id', async (req) => {
    core.store.apiKeys.del((req.params as { id: string }).id);
    emitApi();
    return { ok: true };
  });

  registerOpenApi(app, core);
  return app;
}
