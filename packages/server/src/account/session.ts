import type {
  AccountConfig,
  CloudMeta,
  DevicePollReply,
  LoginStartReply,
  OrderDto,
  PackDto,
  PayChannel,
  SessionInfo,
  UserProfile,
  WalletDto,
} from '@aigc/shared';
import { callbackPage, startCallbackServer, type CallbackHandle, type CallbackResult, type CallbackReply } from './callback';
import {
  ConsumerClient,
  ConsumerError,
  mapBalance,
  mapChannels,
  mapOrder,
  mapProfile,
  mapSku,
  type FssBalance,
  type FssChannels,
  type FssMe,
  type FssOrder,
  type FssPrepay,
  type FssSku,
} from './consumer';
import { OidcClient, OidcError, randomToken, type OidcTokens } from './oidc';
import type { EventHub } from '../events';
import type { Secrets } from '../secrets';
import type { Store } from '../store';

/* ============================================================================
   Fast-SSO 账号会话：
   - 授权码 + PKCE 登录，回环回调由本机服务临时监听；
   - access token 只在内存，refresh token 加密落盘；
   - 余额 / 档位 / 渠道 / 订单来自 /api/v1/consumer/*；
   - 注册与找回密码走 /api/v1/public/consumer/*。
   ========================================================================== */

export type SessionStatus = 'logged_out' | 'pending' | 'logged_in';

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** ms */
  expiresAt: number;
  /** ms；0 = 未知 */
  refreshExpiresAt?: number;
}

interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  createdAt: number;
  server: CallbackHandle | null;
  timer: NodeJS.Timeout | null;
  /** 浏览器拒绝 / 超时后留给 poll 报告一次 */
  outcome?: 'denied' | 'expired';
}

const LOGIN_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;

export class AccountSession {
  status: SessionStatus = 'logged_out';
  profile: UserProfile | null = null;
  wallet: WalletDto | null = null;
  payChannels: PayChannel[] | undefined = undefined;
  reachable: boolean | null = null;

  private tokens: StoredTokens | null = null;
  private pending: PendingLogin | null = null;
  private refreshing: Promise<StoredTokens | null> | null = null;
  private oidc: OidcClient | null = null;
  private oidcKey = '';
  private skusCache: { value: PackDto[]; at: number } | null = null;

  readonly api: ConsumerClient;

  constructor(
    private readonly store: Store,
    private readonly secrets: Secrets,
    private readonly events: EventHub,
    private readonly config: () => AccountConfig,
  ) {
    this.api = new ConsumerClient({
      apiBase: () => this.config().apiBase,
      accessToken: () => this.tokens?.accessToken || null,
      refresh: async () => (await this.refresh())?.accessToken || null,
      onUnauthorized: () => this.setLoggedOut('登录已失效'),
    });
  }

  get loggedIn() {
    return this.status === 'logged_in';
  }

  private get cfg() {
    return this.config();
  }

  private client() {
    const c = this.cfg;
    const key = `${c.issuer}|${c.clientId}`;
    if (!this.oidc || key !== this.oidcKey) {
      this.oidc = new OidcClient(c.issuer, c.clientId);
      this.oidcKey = key;
    }
    return this.oidc;
  }

  /* ---------------- 启动：恢复会话 ---------------- */

  async restore() {
    const raw = this.secrets.decrypt(this.store.accountSession);
    if (!raw) return;
    const stored = parseTokens(raw);
    if (!stored) {
      this.store.accountSession = null;
      return;
    }
    this.tokens = stored;
    try {
      if (stored.expiresAt <= Date.now() + CLOCK_SKEW_MS) {
        const fresh = await this.refresh();
        if (!fresh) return;
      }
      await this.fetchProfile();
      await this.refreshWallet().catch(() => {});
      await this.refreshChannels().catch(() => {});
      this.status = 'logged_in';
    } catch (e) {
      if (e instanceof ConsumerError && e.isAuth) this.clear();
      else if (e instanceof OidcError && e.code === 'invalid_grant') this.clear();
      /* 网络问题：保留令牌，下次启动再试 */
    }
    this.emitSession();
  }

  /* ---------------- 登录：授权码 + PKCE ---------------- */

  async loginStart(_client?: 'desktop' | 'web', _deviceName?: string): Promise<LoginStartReply> {
    await this.closePending();
    const c = this.cfg;
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    /* 先拿 Discovery：连不上时直接给出可读错误，不留下监听 */
    await this.client().discovery();
    this.reachable = true;

    const server = await startCallbackServer(c.redirectUri, (r) => this.onCallback(r));
    const loginUrl = await this.client().authorizeUrl({ redirectUri: c.redirectUri, state, nonce, verifier });
    const pending: PendingLogin = {
      state,
      nonce,
      verifier,
      createdAt: Date.now(),
      server,
      timer: null,
    };
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      pending.outcome = 'expired';
      pending.server?.close().catch(() => {});
      pending.server = null;
      this.status = 'logged_out';
      this.emitSession();
    }, LOGIN_TTL_MS);
    pending.timer.unref?.();
    this.pending = pending;
    this.status = 'pending';
    this.emitSession();
    return { mode: 'browser', loginUrl, expiresIn: LOGIN_TTL_MS / 1000, interval: 2 };
  }

  private async onCallback(r: CallbackResult): Promise<CallbackReply> {
    const pending = this.pending;
    if (!pending || r.state !== pending.state) {
      return { status: 400, html: callbackPage({ ok: false, title: '登录状态已失效', message: '这次登录不是从本机发起的，或已经超时。请回到应用重新点「登录」。' }) };
    }
    if (r.error) {
      pending.outcome = 'denied';
      this.status = 'logged_out';
      this.closeServer(pending);
      this.emitSession();
      return {
        status: 200,
        html: callbackPage({ ok: false, title: r.error === 'access_denied' ? '已取消登录' : '登录失败', message: r.errorDescription || '账号服务返回了错误，请回到应用重试。' }),
      };
    }
    if (!r.code) {
      return { status: 400, html: callbackPage({ ok: false, title: '没有拿到授权码', message: '请回到应用重新点「登录」。' }) };
    }
    try {
      const tokens = await this.client().exchangeCode({ code: r.code, verifier: pending.verifier, redirectUri: this.cfg.redirectUri });
      if (tokens.id_token) await this.client().verifyIdToken(tokens.id_token, { nonce: pending.nonce });
      this.applyTokens(tokens);
      await this.fetchProfile();
      this.status = 'logged_in';
      await this.refreshWallet().catch(() => {});
      await this.refreshChannels().catch(() => {});
      this.pending = null;
      if (pending.timer) clearTimeout(pending.timer);
      this.closeServer(pending);
      this.emitSession();
      const name = this.profile?.nickname || '';
      this.events.notice('success', '已登录', `${name} · 余额 ${this.wallet?.balance ?? 0} 点`);
      return { status: 200, html: callbackPage({ ok: true, title: '登录成功', message: '可以关闭这个页面，回到 AIGC 创作台继续。' }) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : '登录失败';
      this.status = 'logged_out';
      this.pending = null;
      if (pending.timer) clearTimeout(pending.timer);
      this.closeServer(pending);
      this.emitSession();
      return { status: 400, html: callbackPage({ ok: false, title: '登录失败', message: msg }) };
    }
  }

  async loginPoll(): Promise<DevicePollReply> {
    if (this.loggedIn) return { status: 'approved', profile: this.profile || undefined };
    const pending = this.pending;
    if (pending?.outcome) {
      const status = pending.outcome;
      this.pending = null;
      return { status };
    }
    if (pending) {
      if (Date.now() - pending.createdAt > LOGIN_TTL_MS) {
        this.pending = null;
        this.status = 'logged_out';
        this.closeServer(pending);
        this.emitSession();
        return { status: 'expired' };
      }
      return { status: 'pending' };
    }
    return { status: 'expired' };
  }

  loginCancel() {
    void this.closePending();
    if (this.status === 'pending') this.status = 'logged_out';
    this.emitSession();
  }

  private closeServer(pending: PendingLogin) {
    if (pending.server) {
      const server = pending.server;
      pending.server = null;
      setTimeout(() => void server.close().catch(() => {}), 300);
    }
  }

  private async closePending() {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    await pending.server?.close().catch(() => {});
  }

  /* ---------------- 令牌 ---------------- */

  private applyTokens(t: OidcTokens) {
    const now = Date.now();
    this.tokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token || this.tokens?.refreshToken || '',
      idToken: t.id_token || this.tokens?.idToken,
      expiresAt: now + (t.expires_in || 900) * 1000,
      refreshExpiresAt: t.refresh_expires_in ? now + t.refresh_expires_in * 1000 : this.tokens?.refreshExpiresAt,
    };
    this.store.accountSession = this.secrets.encrypt(JSON.stringify(this.tokens));
  }

  private async refresh(): Promise<StoredTokens | null> {
    if (this.refreshing) return this.refreshing;
    const current = this.tokens;
    if (!current?.refreshToken) return null;
    this.refreshing = (async () => {
      try {
        const t = await this.client().refresh(current.refreshToken);
        if (t.id_token) await this.client().verifyIdToken(t.id_token).catch(() => {});
        this.applyTokens(t);
        return this.tokens;
      } catch (e) {
        if (e instanceof OidcError && e.code === 'invalid_grant') {
          this.clear();
          this.events.notice('warn', '登录已失效', '请重新登录');
        }
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private clear() {
    this.tokens = null;
    this.profile = null;
    this.wallet = null;
    this.payChannels = undefined;
    this.skusCache = null;
    this.status = 'logged_out';
    this.store.accountSession = null;
    this.emitSession();
    this.emitWallet();
  }

  private setLoggedOut(reason?: string) {
    const was = this.status;
    this.clear();
    if (was === 'logged_in' && reason) this.events.notice('warn', reason, '请重新登录后继续');
  }

  /* ---------------- 资料 / 余额 / 渠道 ---------------- */

  private async fetchProfile() {
    const me = await this.api.request<FssMe>('/consumer/me');
    this.profile = mapProfile(me);
  }

  async refreshWallet(): Promise<WalletDto | null> {
    if (!this.loggedIn && !this.tokens) return null;
    try {
      const b = await this.api.request<FssBalance>('/consumer/entitlements/balance');
      this.setWallet(mapBalance(b));
      return this.wallet;
    } catch (e) {
      if (e instanceof ConsumerError && e.isAuth) this.setLoggedOut('登录已失效');
      throw e;
    }
  }

  private setWallet(w: WalletDto) {
    this.wallet = w;
    this.events.emit({ type: 'wallet', wallet: w });
  }

  async refreshChannels(): Promise<PayChannel[] | undefined> {
    if (!this.tokens) return this.payChannels;
    try {
      const r = await this.api.request<FssChannels>('/consumer/recharge/channels');
      this.payChannels = mapChannels(r);
    } catch {
      /* 拿不到渠道时保持 undefined（客户端按“未知”处理，不隐藏入口） */
    }
    this.emitSession();
    return this.payChannels;
  }

  async probe(force = false): Promise<{ ok: boolean; message: string; meta: CloudMeta | null }> {
    try {
      await this.client().discovery(force);
      const docs = await this.api.request<{ termsVersion: string }>('/public/consumer/documents', { auth: false, timeoutMs: 10_000 });
      this.reachable = true;
      this.emitSession();
      return { ok: true, message: `已连接账号服务${docs?.termsVersion ? `（条款版本 ${docs.termsVersion}）` : ''}`, meta: this.meta() };
    } catch (e) {
      this.reachable = false;
      this.emitSession();
      return { ok: false, message: (e as Error).message, meta: null };
    }
  }

  private meta(): CloudMeta {
    return {
      ok: true,
      name: 'Fast-SSO 账号服务',
      version: '',
      payChannels: this.payChannels || [],
      loginMethods: ['oidc'],
    };
  }

  info(): SessionInfo {
    return {
      loggedIn: this.loggedIn,
      profile: this.profile || undefined,
      cloudReachable: this.reachable !== false,
      cloudMessage: this.reachable === false ? '连不上账号服务：检查网络后到「设置 · 账号」重试' : undefined,
      payChannels: this.payChannels,
      loginMode: 'browser',
      registerEnabled: true,
    };
  }

  /* ---------------- 充值：档位 / 渠道 / 订单 ---------------- */

  async skus(force = false): Promise<PackDto[]> {
    const now = Date.now();
    if (!force && this.skusCache && now - this.skusCache.at < 5 * 60_000) return this.skusCache.value;
    const list = await this.api.request<FssSku[]>('/consumer/recharge/skus');
    const value = (list || []).map(mapSku);
    this.skusCache = { value, at: now };
    return value;
  }

  private async packName(skuCode: string) {
    const sku = this.skusCache?.value.find((s) => s.id === skuCode);
    return sku?.name || `充值 ${skuCode}`;
  }

  async createOrder(input: { packId: string; channel: PayChannel; idempotencyKey: string }): Promise<OrderDto> {
    const sku = this.skusCache?.value.find((s) => s.id === input.packId) || (await this.skus(true)).find((s) => s.id === input.packId);
    if (!sku) throw new ConsumerError(400, `这个档位不可用：${input.packId}`);
    const o = await this.api.request<FssOrder>('/consumer/recharge/orders', {
      method: 'POST',
      json: { credits: sku.points, channel: input.channel },
      headers: { 'Idempotency-Key': input.idempotencyKey },
      timeoutMs: 25_000,
    });
    return mapOrder(o, { packName: sku.name });
  }

  async prepay(orderId: string): Promise<{ order: OrderDto; codeUrl: string }> {
    const p = await this.api.request<FssPrepay>(`/consumer/recharge/orders/${encodeURIComponent(orderId)}/prepay`, {
      method: 'POST',
      timeoutMs: 25_000,
    });
    const o = await this.getOrder(orderId).catch(() => null);
    const order = o || {
      id: orderId,
      packId: '',
      packName: '充值',
      channel: p.channel as PayChannel,
      amountCny: 0,
      points: 0,
      status: 'created',
      qrContent: p.codeUrl,
      createdAt: Date.now(),
      expireAt: p.expiresAt ? Date.parse(p.expiresAt) : Date.now() + 30 * 60_000,
    };
    order.qrContent = p.codeUrl;
    return { order, codeUrl: p.codeUrl };
  }

  async getOrder(orderId: string): Promise<OrderDto> {
    const o = await this.api.request<FssOrder>(`/consumer/recharge/orders/${encodeURIComponent(orderId)}`, { timeoutMs: 15_000 });
    const order = mapOrder(o, { packName: await this.packName(o.skuCode) });
    if (order.status === 'paid') await this.refreshWallet().catch(() => {});
    return order;
  }

  async listOrders(limit = 20): Promise<OrderDto[]> {
    const list = await this.api.request<FssOrder[]>(`/consumer/recharge/orders?limit=${limit}`, { timeoutMs: 15_000 });
    const names = new Map((this.skusCache?.value || []).map((s) => [s.id, s.name]));
    return (list || []).map((o) => mapOrder(o, { packName: names.get(o.skuCode) || `${o.credits} 点` }));
  }

  /* ---------------- 注册 / 找回密码 ---------------- */

  private get fp() {
    return this.store.deviceFingerprint;
  }

  documents() {
    return this.api.request<{ termsVersion: string; privacyVersion: string }>('/public/consumer/documents', { auth: false, timeoutMs: 10_000 });
  }

  registerStart(identifier: string) {
    return this.api.request('/public/consumer/registrations', {
      method: 'POST',
      json: { identifier },
      headers: { 'X-Device-Fingerprint': this.fp },
      auth: false,
      timeoutMs: 15_000,
    });
  }

  registerComplete(body: {
    challengeId: string;
    identifier: string;
    code: string;
    password: string;
    displayName?: string;
    consents: { termsVersion: string; privacyVersion: string; marketing: boolean };
  }) {
    return this.api.request('/public/consumer/registrations/complete', {
      method: 'POST',
      json: { ...body, deviceFingerprint: this.fp },
      auth: false,
      timeoutMs: 20_000,
    });
  }

  forgotPassword(identifier: string) {
    return this.api.request('/public/consumer/passwords/forgot', {
      method: 'POST',
      json: { identifier },
      headers: { 'X-Device-Fingerprint': this.fp },
      auth: false,
      timeoutMs: 15_000,
    });
  }

  resetPassword(body: { challengeId: string; identifier: string; code: string; newPassword: string }) {
    return this.api.request('/public/consumer/passwords/reset', {
      method: 'POST',
      json: body,
      auth: false,
      timeoutMs: 20_000,
    });
  }

  /* ---------------- 登出 / 广播 ---------------- */

  async logout() {
    const refreshToken = this.tokens?.refreshToken;
    this.clear();
    if (refreshToken) await this.client().revoke(refreshToken).catch(() => {});
  }

  stop() {
    void this.closePending();
  }

  private emitSession() {
    this.events.emit({ type: 'session', session: this.info() });
  }

  private emitWallet() {
    this.events.emit({ type: 'wallet', wallet: this.wallet });
  }
}

function parseTokens(raw: string): StoredTokens | null {
  try {
    const t = JSON.parse(raw) as Partial<StoredTokens>;
    if (!t.accessToken || !t.refreshToken) return null;
    return {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      idToken: t.idToken,
      expiresAt: t.expiresAt || 0,
      refreshExpiresAt: t.refreshExpiresAt,
    };
  } catch {
    return null;
  }
}
