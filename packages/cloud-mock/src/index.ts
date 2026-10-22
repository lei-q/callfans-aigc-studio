import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type {
  CloudMeta,
  DevicePollReply,
  DeviceStartReply,
  GatewayChatReply,
  GatewayJob,
  GatewayJobBody,
  GatewayModel,
  GatewayResult,
  OrderDto,
  PackDto,
  PayChannel,
  UsageRequest,
  UsageSummary,
  UserProfile,
  WalletDto,
} from '@aigc/shared';
import { CLOUD_ERROR, unitPrice } from '@aigc/shared';

/* ============================================================================
   Mock 云端：实现 docs/cloud-api-contract.md 的全部端点，供开发、演示与 CI 使用。
   - 登录：自带一个极简网页（手机号 + 确认），模拟扫码 / 短信流程
   - 支付：自带收银台网页（「模拟扫码支付」按钮），走回调把订单置 paid 并加积分
   - 网关：fixture 模式——返回极小的 PNG / WAV，按估价扣点，用于跑通全链路
   数据全部在内存里，重启即清空。真实云端按同一合同实现后即可替换。
   ========================================================================== */

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function silentWav(seconds = 1) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

const MODELS: GatewayModel[] = [
  { id: 'g-img-1', name: 'Gateway-Image S1', type: 'image', price: 0.3, basis: '张', maxRes: '2k', caps: ['参考图', '最高 2K'], limit: '比例 1:1 / 4:5 / 16:9 / 9:16', note: 'Mock 云 fixture 图像模型' },
  { id: 'g-vid-1', name: 'Gateway-Video S1', type: 'video', price: 0.8, basis: '秒', durs: [3, 5, 8], caps: ['首帧参考'], limit: '时长 3 / 5 / 8 秒', note: 'Mock 云 fixture 视频模型' },
  { id: 'g-tts-1', name: 'Gateway-TTS S1', type: 'audio', price: 0.5, basis: '30 秒', uses: ['tts'], caps: ['多音色'], limit: '单条 ≤ 120 秒', note: 'Mock 云 fixture 配音模型' },
  { id: 'g-chat-1', name: 'Gateway-Chat S1', type: 'audio', price: 0, basis: '次', caps: [], limit: '', note: '对话模型（网关内部选择）' },
];
const GEN_MODELS = MODELS.filter((m) => m.id !== 'g-chat-1');

const PACKS: PackDto[] = [
  { id: 'p10', name: '入门', amountCny: 10, points: 10, tag: '入门', note: '先试几张图' },
  { id: 'p30', name: '常用', amountCny: 30, points: 30, tag: '常用', note: '够做一组主视觉', promo: 'first-topup-double' },
  { id: 'p100', name: '划算', amountCny: 100, points: 100, tag: '划算', note: '批量出素材更省心' },
];

interface User {
  id: string;
  phone: string;
  nickname: string;
  createdAt: number;
  wallet: WalletDto;
  firstTopupDone: boolean;
}
interface Device {
  code: string;
  status: 'pending' | 'approved' | 'expired';
  userId?: string;
  tokens?: { access: string; refresh: string; expiresAt: number };
  createdAt: number;
}
interface JobState {
  job: GatewayJob;
  body: GatewayJobBody;
  userId: string;
  timer?: NodeJS.Timeout;
}

export interface MockCloudOptions {
  port?: number;
  host?: string;
  /** fixture 生成耗时（毫秒），测试里调小 */
  jobMs?: number;
  logger?: boolean;
}

export interface MockCloudHandle {
  url: string;
  port: number;
  app: FastifyInstance;
  /** 测试辅助：直接批准一个设备码 */
  approveDevice(code: string, phone?: string): string;
  /** 测试辅助：直接支付一个订单 */
  payOrder(orderId: string): OrderDto;
  close(): Promise<void>;
}

export async function startMockCloud(o: MockCloudOptions = {}): Promise<MockCloudHandle> {
  const app = Fastify({ logger: o.logger ?? false, bodyLimit: 40 * 1024 * 1024 });
  /* 登录页 / 收银台是普通表单提交 */
  app.addContentTypeParser('application/x-www-form-urlencoded', (_req, payload, done) => {
    let body = '';
    payload.on('data', (c) => (body += c));
    payload.on('end', () => {
      const out: Record<string, string> = {};
      for (const part of body.split('&')) {
        const i = part.indexOf('=');
        if (i > 0) out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
      }
      done(null, out);
    });
  });
  const users = new Map<string, User>();
  const byToken = new Map<string, string>();
  const byRefresh = new Map<string, string>();
  const devices = new Map<string, Device>();
  const orders = new Map<string, OrderDto>();
  const jobs = new Map<string, JobState>();
  const usage: UsageRequest[] = [];
  const media = new Map<string, { buf: Buffer; mime: string }>();
  const sse = new Set<import('node:http').ServerResponse>();
  const jobMs = o.jobMs ?? 1200;

  const emit = (e: unknown) => {
    for (const res of sse) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const rid = () => crypto.randomUUID();

  const err = (reply: { code(n: number): any }, code: number, message: string, status = code >= 500 ? 500 : Math.floor(code / 100)) =>
    reply.code(status).send({ code, message, requestId: rid() } satisfies import('@aigc/shared').CloudErrorBody);

  const userOf = (req: FastifyRequest): User | null => {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const id = t ? byToken.get(t) : undefined;
    return id ? users.get(id) || null : null;
  };
  const needUser = (req: FastifyRequest, reply: any): User | null => {
    const u = userOf(req);
    if (!u) err(reply, CLOUD_ERROR.TOKEN_INVALID, '登录已失效，请重新登录', 401);
    return u;
  };

  const walletDto = (u: User): WalletDto => ({ balance: round2(u.wallet.balance), freeToday: round2(u.wallet.freeToday), updatedAt: Date.now() });
  const pushWallet = (u: User) => emit({ type: 'wallet.updated', wallet: walletDto(u) });

  /* 积分：先扣今日免费，再扣余额；退回时原路返回 */
  function freeze(u: User, cost: number) {
    const free = Math.min(u.wallet.freeToday, cost);
    u.wallet.freeToday = round2(u.wallet.freeToday - free);
    u.wallet.balance = round2(u.wallet.balance - (cost - free));
    return { free, paid: round2(cost - free) };
  }
  function unfreeze(u: User, f: { free: number; paid: number }) {
    u.wallet.freeToday = round2(u.wallet.freeToday + f.free);
    u.wallet.balance = round2(u.wallet.balance + f.paid);
  }

  /* ---------------- 页面 ---------------- */

  const page = (title: string, body: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F5F9;font:14px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#171A23}
.card{background:#fff;border:1px solid #E6E8EF;border-radius:14px;padding:26px 28px;width:330px;box-shadow:0 10px 30px rgba(20,24,40,.07)}
h1{font-size:16px;margin:0 0 4px}.sub{color:#5B6172;font-size:12.5px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;border:1px solid #D9DCE6;border-radius:9px;padding:10px 12px;font-size:14px;margin-bottom:10px}
button{width:100%;border:0;border-radius:9px;padding:11px;background:#4F46E5;color:#fff;font-weight:600;font-size:14px;cursor:pointer}
.qr{width:180px;height:180px;margin:6px auto 14px;border:1px solid #E6E8EF;border-radius:10px;display:grid;place-items:center;background:repeating-conic-gradient(#171A23 0 25%,#fff 0 50%) 0 0/18px 18px;opacity:.85}
.amount{font-size:26px;font-weight:700;text-align:center;margin:4px 0 2px}.pts{text-align:center;color:#5B6172;font-size:12.5px;margin-bottom:14px}
.tag{display:inline-block;background:#EEF0FE;color:#4F46E5;border-radius:999px;padding:2px 10px;font-size:11.5px;margin-left:6px}</style></head><body><div class="card">${body}</div></body></html>`;

  app.get('/login', async (req, reply) => {
    const code = String((req.query as { code?: string }).code || '');
    const d = devices.get(code);
    if (!d || d.status !== 'pending') return reply.type('text/html; charset=utf-8').send(page('登录', '<h1>链接已失效</h1><p class="sub">请回到应用重新发起登录。</p>'));
    return reply.type('text/html; charset=utf-8').send(
      page(
        '登录 AIGC 创作台',
        `<h1>登录 AIGC 创作台</h1><p class="sub">Mock 云 · 设备码 ${code.slice(0, 6)}… 确认后将授权这台设备使用你的账号。</p>
<form method="post" action="/login/confirm">
<input type="hidden" name="code" value="${code}" />
<input name="phone" placeholder="手机号（Mock：任意 11 位）" required pattern="[0-9]{11}" />
<input name="nickname" placeholder="昵称（可选）" />
<button>确认登录</button></form>`,
      ),
    );
  });

  app.post('/login/confirm', async (req, reply) => {
    const b = req.body as { code?: string; phone?: string; nickname?: string };
    const d = devices.get(b.code || '');
    if (!d || d.status !== 'pending') return err(reply, CLOUD_ERROR.NOT_FOUND, '设备码不存在或已过期', 400);
    const phone = (b.phone || '').replace(/\D/g, '');
    let user = [...users.values()].find((u) => u.phone === phone);
    if (!user) {
      user = {
        id: `u_${crypto.randomBytes(6).toString('hex')}`,
        phone,
        nickname: b.nickname?.trim() || `用户${phone.slice(-4)}`,
        createdAt: Date.now(),
        wallet: { balance: 1, freeToday: 0.5, updatedAt: Date.now() },
        firstTopupDone: false,
      };
      users.set(user.id, user);
    }
    const access = crypto.randomBytes(24).toString('hex');
    const refresh = crypto.randomBytes(24).toString('hex');
    d.status = 'approved';
    d.userId = user.id;
    d.tokens = { access, refresh, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    byToken.set(access, user.id);
    byRefresh.set(refresh, user.id);
    return reply.type('text/html; charset=utf-8').send(page('登录成功', `<h1>登录成功</h1><p class="sub">已授权设备，可以回到应用继续操作。这个页面可以关掉了。</p>`));
  });

  app.get('/pay', async (req, reply) => {
    const id = String((req.query as { order?: string }).order || '');
    const od = orders.get(id);
    if (!od || od.status !== 'created') return reply.type('text/html; charset=utf-8').send(page('收银台', '<h1>订单不存在或已处理</h1><p class="sub">请回到应用重新下单。</p>'));
    const ch = od.channel === 'wechat' ? '微信支付' : '支付宝';
    return reply.type('text/html; charset=utf-8').send(
      page(
        `${ch} · 收银台`,
        `<h1>${ch}<span class="tag">Mock</span></h1><p class="sub">订单 ${od.id.slice(0, 10)}… · ${od.packName}</p>
<div class="qr"></div><div class="amount">¥${od.amountCny.toFixed(2)}</div><div class="pts">到账 ${od.points} 点${od.points > 0 ? '（含赠送）' : ''}</div>
<form method="post" action="/pay/confirm"><input type="hidden" name="order" value="${od.id}" /><button>模拟扫码支付</button></form>`,
      ),
    );
  });

  app.post('/pay/confirm', async (req, reply) => {
    const id = (req.body as { order?: string }).order || '';
    const od = settleOrder(id);
    if (!od) return err(reply, CLOUD_ERROR.NOT_FOUND, '订单不存在', 404);
    return reply.type('text/html; charset=utf-8').send(page('支付成功', `<h1>支付成功</h1><p class="sub">${od.points} 点已到账，可以回到应用继续创作。</p>`));
  });

  function settleOrder(id: string): OrderDto | null {
    const od = orders.get(id);
    if (!od || od.status !== 'created') return null;
    const u = users.get((od as OrderDto & { userId?: string }).userId || '');
    od.status = 'paid';
    od.paidAt = Date.now();
    od.channelTradeNo = `mock_${crypto.randomBytes(8).toString('hex')}`;
    if (u) {
      u.wallet.balance = round2(u.wallet.balance + od.points);
      u.firstTopupDone = true;
      pushWallet(u);
    }
    emit({ type: 'order.updated', order: od });
    return od;
  }

  /* ---------------- 合同端点 ---------------- */

  app.get('/meta', async () => ({ ok: true, name: 'Mock Cloud', version: '0.1.0-mock', payChannels: ['wechat', 'alipay'] as PayChannel[], loginMethods: ['phone'] } satisfies CloudMeta));

  app.post('/auth/device/start', async (req) => {
    const code = crypto.randomBytes(12).toString('hex');
    devices.set(code, { code, status: 'pending', createdAt: Date.now() });
    const base = await baseUrl(app);
    return { deviceCode: code, loginUrl: `${base}/login?code=${code}`, qrContent: `${base}/login?code=${code}`, expiresIn: 300, interval: 2 } satisfies DeviceStartReply;
  });

  app.post('/auth/device/poll', async (req, reply) => {
    const d = devices.get((req.body as { deviceCode?: string }).deviceCode || '');
    if (!d) return err(reply, CLOUD_ERROR.NOT_FOUND, '设备码不存在', 404);
    if (Date.now() - d.createdAt > 300_000) d.status = 'expired';
    const out: DevicePollReply = { status: d.status };
    if (d.status === 'approved' && d.tokens && d.userId) {
      const u = users.get(d.userId)!;
      out.tokens = { accessToken: d.tokens.access, refreshToken: d.tokens.refresh, expiresAt: d.tokens.expiresAt };
      out.profile = profileOf(u);
    }
    return out;
  });

  app.post('/auth/refresh', async (req, reply) => {
    const rt = (req.body as { refreshToken?: string }).refreshToken || '';
    const uid = byRefresh.get(rt);
    const u = uid ? users.get(uid) : null;
    if (!u) return err(reply, CLOUD_ERROR.TOKEN_INVALID, 'refresh token 无效', 401);
    byRefresh.delete(rt);
    const access = crypto.randomBytes(24).toString('hex');
    const refresh = crypto.randomBytes(24).toString('hex');
    byToken.set(access, u.id);
    byRefresh.set(refresh, u.id);
    return { tokens: { accessToken: access, refreshToken: refresh, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, profile: profileOf(u) };
  });

  app.post('/auth/logout', async (req) => {
    const u = userOf(req);
    if (u) {
      for (const [t, id] of byToken) if (id === u.id) byToken.delete(t);
    }
    return { ok: true };
  });

  app.get('/me', async (req, reply) => {
    const u = needUser(req, reply);
    return u ? profileOf(u) : null;
  });

  app.get('/billing/wallet', async (req, reply) => {
    const u = needUser(req, reply);
    return u ? walletDto(u) : null;
  });

  app.get('/billing/packs', async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return null;
    return PACKS.map((p) => ({ ...p, bonusPoints: !u.firstTopupDone && p.promo === 'first-topup-double' ? p.points : undefined }));
  });

  app.post('/billing/orders', async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return null;
    const b = req.body as { packId?: string; channel?: PayChannel };
    const pack = PACKS.find((p) => p.id === b.packId);
    if (!pack) return err(reply, CLOUD_ERROR.NOT_FOUND, '档位不存在', 404);
    if (b.channel !== 'wechat' && b.channel !== 'alipay') return err(reply, CLOUD_ERROR.NOT_FOUND, '支付渠道不支持', 400);
    const bonus = !u.firstTopupDone && pack.promo === 'first-topup-double' ? pack.points : 0;
    const base = await baseUrl(app);
    const od: OrderDto & { userId: string } = {
      id: `o_${crypto.randomBytes(8).toString('hex')}`,
      userId: u.id,
      packId: pack.id,
      packName: pack.name,
      channel: b.channel,
      amountCny: pack.amountCny,
      points: pack.points + bonus,
      status: 'created',
      qrContent: `${base}/pay?order=__ID__`,
      cashierUrl: `${base}/pay?order=__ID__`,
      createdAt: Date.now(),
      expireAt: Date.now() + 15 * 60_000,
    };
    od.qrContent = od.qrContent!.replace('__ID__', od.id);
    od.cashierUrl = od.cashierUrl!.replace('__ID__', od.id);
    orders.set(od.id, od);
    return od;
  });

  app.get('/billing/orders/:id', async (req, reply) => {
    const u = needUser(req, reply);
    const od = orders.get((req.params as { id: string }).id);
    if (!u || !od || (od as OrderDto & { userId?: string }).userId !== u.id) return err(reply, CLOUD_ERROR.NOT_FOUND, '订单不存在', 404);
    return od;
  });

  app.get('/billing/orders', async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return null;
    return [...orders.values()].filter((x) => (x as OrderDto & { userId?: string }).userId === u.id).sort((a, b) => b.createdAt - a.createdAt);
  });

  app.get('/gateway/models', async (req, reply) => {
    const u = needUser(req, reply);
    return u ? GEN_MODELS : null;
  });

  app.post('/gateway/jobs', async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return null;
    const b = req.body as GatewayJobBody;
    const m = GEN_MODELS.find((x) => x.id === b.model);
    if (!m) return err(reply, CLOUD_ERROR.NOT_FOUND, '模型不存在', 404);
    if (!b.prompt?.trim()) return err(reply, CLOUD_ERROR.INTERNAL, '提示词为空', 400);
    const cost = estimate(m, b);
    if (cost > round2(u.wallet.balance + u.wallet.freeToday)) return err(reply, CLOUD_ERROR.BALANCE_NOT_ENOUGH, `点数不足：需要 ${cost} 点，当前 ${round2(u.wallet.balance + u.wallet.freeToday)} 点`, 402);
    const frozen = freeze(u, cost);
    const id = `gj_${crypto.randomBytes(8).toString('hex')}`;
    const job: GatewayJob = { id, status: 'queued', progress: 0, cost, createdAt: Date.now(), requestId: rid() };
    const st: JobState = { job, body: b, userId: u.id };
    (st as JobState & { frozen?: typeof frozen }).frozen = frozen;
    jobs.set(id, st);
    pushWallet(u);
    runJob(st, u);
    return { ...job, balanceAfter: round2(u.wallet.balance) };
  });

  app.get('/gateway/jobs/:id', async (req, reply) => {
    const u = needUser(req, reply);
    const st = jobs.get((req.params as { id: string }).id);
    if (!u || !st || st.userId !== u.id) return err(reply, CLOUD_ERROR.NOT_FOUND, '任务不存在', 404);
    return { ...st.job, balanceAfter: round2(u.wallet.balance) };
  });

  app.delete('/gateway/jobs/:id', async (req, reply) => {
    const u = needUser(req, reply);
    const st = jobs.get((req.params as { id: string }).id);
    if (!u || !st || st.userId !== u.id) return err(reply, CLOUD_ERROR.NOT_FOUND, '任务不存在', 404);
    if (st.job.status === 'queued' || st.job.status === 'running') {
      if (st.timer) clearTimeout(st.timer);
      st.job.status = 'canceled';
      st.job.finishedAt = Date.now();
      unfreeze(u, (st as JobState & { frozen?: { free: number; paid: number } }).frozen || { free: 0, paid: st.job.cost });
      pushWallet(u);
      emit({ type: 'job.updated', job: st.job });
    }
    return { ...st.job, balanceAfter: round2(u.wallet.balance) };
  });

  app.post('/gateway/chat', async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return null;
    const b = req.body as { messages?: { role: string; content: string }[] };
    const last = (b.messages || []).filter((m) => m.role === 'user').pop()?.content || '';
    const isAgent = /画板信息/.test(last);
    const text = isAgent
      ? JSON.stringify({ understanding: `围绕「${last.slice(0, 24)}」做社媒素材`, draft: `${last.slice(0, 60)}，真实摄影质感，柔和自然光，主体居中留标题安全区` })
      : JSON.stringify({ result: `${last}。真实摄影质感，柔和自然光与极轻落地阴影，主体居中并留出标题安全区`, add: '顶部柔光 + 浅景深 f/2.0，中心构图', neg: '模糊, 多余文字, 水印', note: 'Mock 云对话模型补全' });
    return { text, model: 'g-chat-1', usage: { input: last.length, output: 60 } } satisfies GatewayChatReply;
  });

  app.get('/usage/summary', async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return null;
    const to = Date.now();
    const from = to - 7 * 86400_000;
    const inRange = usage.filter((x) => x.at >= from);
    const byModel = new Map<string, UsageSummary['byModel'][number]>();
    for (const x of inRange) {
      const cur = byModel.get(x.model) || { model: x.model, type: x.type, requests: 0, points: 0 };
      cur.requests += 1;
      cur.points = round2(cur.points + x.points);
      byModel.set(x.model, cur);
    }
    return { from, to, requests: inRange.length, points: round2(inRange.reduce((n, x) => n + x.points, 0)), byModel: [...byModel.values()], byDay: [] } satisfies UsageSummary;
  });

  app.get('/usage/requests', async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return null;
    return { items: usage.slice(0, 100), next: undefined };
  });

  app.get('/events', (req, reply) => {
    const u = userOf(req);
    if (!u) {
      reply.code(401).send({ code: CLOUD_ERROR.TOKEN_INVALID, message: '登录已失效' });
      return;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    sse.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      sse.delete(res);
      clearInterval(ping);
    });
  });

  app.get('/media/:id', async (req, reply) => {
    const m = media.get((req.params as { id: string }).id);
    if (!m) return reply.code(404).send('not found');
    reply.header('Content-Type', m.mime);
    return reply.send(m.buf);
  });

  /* ---------------- fixture 生成 ---------------- */

  function runJob(st: JobState, u: User) {
    const { job, body } = st;
    st.timer = setTimeout(() => {
      job.status = 'running';
      job.progress = 30;
      emit({ type: 'job.updated', job });
      st.timer = setTimeout(() => {
        const results: GatewayResult[] = [];
        const n = body.type === 'image' ? body.count || 1 : 1;
        for (let i = 0; i < n; i++) {
          const mid = crypto.randomBytes(6).toString('hex');
          if (body.type === 'audio') media.set(mid, { buf: silentWav(Math.min(2, body.dur || 1)), mime: 'audio/wav' });
          else media.set(mid, { buf: PNG_1PX, mime: 'image/png' });
          results.push({ url: `${mediaUrl(app, mid)}`, mime: body.type === 'audio' ? 'audio/wav' : 'image/png', seed: 1000 + i, dur: body.type === 'image' ? 0 : body.dur || 5 });
        }
        job.status = 'succeeded';
        job.progress = 100;
        job.results = results;
        job.finishedAt = Date.now();
        usage.unshift({
          id: rid(),
          at: Date.now(),
          model: body.model,
          type: body.type,
          status: 'succeeded',
          points: job.cost,
          tokens: body.type === 'image' ? { input: body.prompt.length, output: 200 * n, image: n } : undefined,
          videoSeconds: body.type === 'video' ? body.dur : undefined,
          ttsChars: body.type === 'audio' ? body.prompt.length : undefined,
          requestId: job.requestId || rid(),
        });
        emit({ type: 'job.updated', job });
      }, jobMs);
    }, Math.min(300, jobMs / 4));
  }

  const port = await new Promise<number>((resolve) => {
    app.listen({ port: o.port ?? 0, host: o.host || '127.0.0.1' }, () => {
      const a = app.server.address();
      resolve(typeof a === 'object' && a ? a.port : o.port || 0);
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    app,
    approveDevice(code: string, phone = '13800000000') {
      const d = devices.get(code);
      if (!d) throw new Error('device not found');
      let user = [...users.values()].find((x) => x.phone === phone);
      if (!user) {
        user = { id: `u_${crypto.randomBytes(6).toString('hex')}`, phone, nickname: `用户${phone.slice(-4)}`, createdAt: Date.now(), wallet: { balance: 1, freeToday: 0.5, updatedAt: Date.now() }, firstTopupDone: false };
        users.set(user.id, user);
      }
      const access = crypto.randomBytes(24).toString('hex');
      const refresh = crypto.randomBytes(24).toString('hex');
      d.status = 'approved';
      d.userId = user.id;
      d.tokens = { access, refresh, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      byToken.set(access, user.id);
      byRefresh.set(refresh, user.id);
      return access;
    },
    payOrder(orderId: string) {
      const od = settleOrder(orderId);
      if (!od) throw new Error('order not payable');
      return od;
    },
    async close() {
      for (const st of jobs.values()) if (st.timer) clearTimeout(st.timer);
      for (const res of sse) res.end();
      await app.close();
    },
  };
}

function profileOf(u: User): UserProfile {
  return { id: u.id, nickname: u.nickname, phoneMasked: `${u.phone.slice(0, 3)}****${u.phone.slice(-4)}`, createdAt: u.createdAt };
}

function estimate(m: GatewayModel, b: GatewayJobBody) {
  const { seed: _seed, ...params } = b;
  return unitPrice(b.type, params, m);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

let cachedBase = '';
async function baseUrl(app: FastifyInstance) {
  if (cachedBase) return cachedBase;
  const a = app.server.address();
  cachedBase = typeof a === 'object' && a ? `http://127.0.0.1:${a.port}` : '';
  return cachedBase;
}
function mediaUrl(app: FastifyInstance, id: string) {
  const a = app.server.address();
  return typeof a === 'object' && a ? `http://127.0.0.1:${a.port}/media/${id}` : `/media/${id}`;
}
