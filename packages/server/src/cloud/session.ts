import type { CloudMeta, CloudTokens, DevicePollReply, DeviceStartReply, GatewayModel, OrderDto, UserProfile, WalletDto } from '@aigc/shared';
import { CloudClient, CloudError } from './client';
import type { EventHub } from '../events';
import type { Secrets } from '../secrets';
import type { Store } from '../store';

/* ============================================================================
   云端会话：设备码登录、token 刷新、钱包缓存、模型目录缓存、事件流。
   refresh token 加密落盘；access token 只留在内存。
   ========================================================================== */

export type SessionStatus = 'logged_out' | 'pending' | 'logged_in';

export class CloudSession {
  private access: CloudTokens | null = null;
  profile: UserProfile | null = null;
  wallet: WalletDto | null = null;
  models: GatewayModel[] = [];
  meta: CloudMeta | null = null;
  status: SessionStatus = 'logged_out';
  private pending: { deviceCode: string; timer: NodeJS.Timeout | null } | null = null;
  private sseAbort: AbortController | null = null;
  private sseTimer: NodeJS.Timeout | null = null;

  readonly client: CloudClient;

  constructor(
    private readonly store: Store,
    private readonly secrets: Secrets,
    private readonly events: EventHub,
    baseUrl: () => string,
  ) {
    this.client = new CloudClient({
      baseUrl,
      tokens: () => this.access,
      refresh: () => this.refresh(),
      onUnauthorized: () => this.setLoggedOut('登录已失效'),
    });
  }

  get loggedIn() {
    return this.status === 'logged_in';
  }

  /* ---------------- 启动：恢复会话 ---------------- */

  async restore() {
    const enc = this.store.cloudSession;
    const tokens = this.secrets.decryptCloudTokens(enc);
    if (!tokens) return;
    this.access = tokens;
    try {
      await this.fetchProfileAndWallet();
      this.status = 'logged_in';
      this.startSse();
      void this.refreshModels().catch(() => {});
    } catch (e) {
      if (e instanceof CloudError && e.isAuth) this.setLoggedOut();
      else this.status = 'logged_out';
    }
    this.emitSession();
  }

  /* ---------------- 登录 / 登出 ---------------- */

  async loginStart(client: 'desktop' | 'web', deviceName?: string): Promise<DeviceStartReply> {
    const r = await this.client.request<DeviceStartReply>('/auth/device/start', { json: { client, deviceName }, auth: false });
    this.pending = { deviceCode: r.deviceCode, timer: null };
    this.status = 'pending';
    this.emitSession();
    return r;
  }

  async loginPoll(): Promise<DevicePollReply> {
    if (!this.pending) throw new CloudError(40401, '没有进行中的登录', undefined, 400);
    const r = await this.client.request<DevicePollReply>('/auth/device/poll', { json: { deviceCode: this.pending.deviceCode }, auth: false });
    if (r.status === 'approved' && r.tokens) {
      this.pending = null;
      this.applyTokens(r.tokens);
      this.profile = r.profile || null;
      this.status = 'logged_in';
      // 钱包与模型目录在返回前就绪：调用方拿到 approved 后立即可以建任务
      await Promise.all([
        this.profile ? this.refreshWallet() : this.fetchProfileAndWallet(),
        this.refreshModels(),
      ]).catch(() => {});
      this.startSse();
      this.emitSession();
      this.events.notice('success', '已登录', this.profile ? `${this.profile.nickname} · 余额 ${this.wallet?.balance ?? 0} 点` : '');
    } else if (r.status === 'expired' || r.status === 'denied') {
      this.pending = null;
      this.status = 'logged_out';
      this.emitSession();
    }
    return r;
  }

  loginCancel() {
    this.pending = null;
    if (this.status === 'pending') this.status = 'logged_out';
    this.emitSession();
  }

  async logout() {
    const token = this.access?.accessToken;
    this.stopSse();
    this.pending = null;
    this.access = null;
    this.profile = null;
    this.wallet = null;
    this.models = [];
    this.status = 'logged_out';
    this.store.cloudSession = null;
    if (token) await this.client.request('/auth/logout', { method: 'POST', json: {}, auth: false, timeoutMs: 8000 }).catch(() => {});
    this.emitSession();
    this.emitWallet();
    this.events.emit({ type: 'models', models: [], channels: [] });
  }

  /* ---------------- token ---------------- */

  private applyTokens(t: CloudTokens) {
    this.access = t;
    this.store.cloudSession = this.secrets.encryptCloudTokens(t);
  }

  private async refresh(): Promise<CloudTokens | null> {
    const rt = this.access?.refreshToken || this.secrets.decryptCloudTokens(this.store.cloudSession)?.refreshToken;
    if (!rt) return null;
    try {
      const r = await this.client.request<{ tokens: CloudTokens; profile?: UserProfile }>('/auth/refresh', { json: { refreshToken: rt }, auth: false, timeoutMs: 15_000 });
      this.applyTokens(r.tokens);
      if (r.profile) this.profile = r.profile;
      return r.tokens;
    } catch {
      return null;
    }
  }

  private setLoggedOut(reason?: string) {
    const was = this.status;
    this.stopSse();
    this.access = null;
    this.profile = null;
    this.wallet = null;
    this.models = [];
    this.status = 'logged_out';
    this.store.cloudSession = null;
    if (was === 'logged_in') {
      this.emitSession();
      this.emitWallet();
      if (reason) this.events.notice('warn', reason, '请重新登录后继续生成');
    }
  }

  /* ---------------- 数据 ---------------- */

  async fetchProfileAndWallet() {
    const [me, wallet] = await Promise.all([
      this.client.request<UserProfile>('/me'),
      this.client.request<WalletDto>('/billing/wallet'),
    ]);
    this.profile = me;
    this.setWallet(wallet);
  }

  setWallet(w: WalletDto) {
    this.wallet = w;
    this.emitWallet();
  }

  async refreshWallet() {
    if (!this.loggedIn) return null;
    const w = await this.client.request<WalletDto>('/billing/wallet');
    this.setWallet(w);
    return w;
  }

  async refreshModels() {
    if (!this.loggedIn) return [];
    this.models = await this.client.request<GatewayModel[]>('/gateway/models');
    return this.models;
  }

  async probe(): Promise<{ ok: boolean; message: string; meta: CloudMeta | null }> {
    if (!this.client.configured) return { ok: false, message: '还没有配置云端地址', meta: null };
    try {
      this.meta = await this.client.request<CloudMeta>('/meta', { auth: false, timeoutMs: 10_000 });
      return { ok: true, message: `已连接 ${this.meta.name || '云端'} v${this.meta.version || '?'}`, meta: this.meta };
    } catch (e) {
      return { ok: false, message: (e as Error).message, meta: null };
    }
  }

  /* ---------------- 事件流 ---------------- */

  private startSse() {
    this.stopSse();
    const loop = () => {
      if (!this.loggedIn) return;
      const ac = new AbortController();
      this.sseAbort = ac;
      this.client.events(
        (e) => this.onCloudEvent(e),
        ac.signal,
      );
      /* 流断开后定期重连 */
      this.sseTimer = setInterval(() => {
        if (!this.loggedIn) return;
        this.stopSse();
        loop();
      }, 30_000);
    };
    loop();
  }

  private stopSse() {
    this.sseAbort?.abort();
    this.sseAbort = null;
    if (this.sseTimer) clearInterval(this.sseTimer);
    this.sseTimer = null;
  }

  private onCloudEvent(raw: unknown) {
    const e = raw as { type: string; wallet?: WalletDto; order?: OrderDto };
    if (e.type === 'wallet.updated' && e.wallet) this.setWallet(e.wallet);
    if (e.type === 'order.updated' && e.order) {
      if (e.order.status === 'paid') this.events.notice('success', '充值到账', `${e.order.packName} · ${e.order.points} 点`);
      if (e.order.status === 'closed' || e.order.status === 'refunded') this.events.notice('info', `订单${e.order.status === 'refunded' ? '已退款' : '已关闭'}`, e.order.packName);
      this.events.emit({ type: 'order', order: e.order as never });
    }
  }

  /* ---------------- 广播 ---------------- */

  private emitSession() {
    this.events.emit({
      type: 'session',
      session: {
        loggedIn: this.loggedIn,
        profile: this.profile || undefined,
        cloudReachable: this.client.configured,
        cloudMessage: this.client.configured ? undefined : '还没有配置云端地址',
      },
    });
  }

  private emitWallet() {
    this.events.emit({ type: 'wallet', wallet: this.wallet });
  }

  stop() {
    this.stopSse();
    if (this.pending?.timer) clearTimeout(this.pending.timer);
  }
}
