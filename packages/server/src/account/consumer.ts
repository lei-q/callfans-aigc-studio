import type { OrderDto, PackDto, PayChannel, UserProfile, WalletDto } from '@aigc/shared';

/* ============================================================================
   Fast-SSO consumer API 客户端与 DTO 映射。
   基址：https://account.callfansai.com/api/v1
   只允许调 /consumer/** 与 /public/**；令牌越界会被服务端 403 consumer_scope。
   ========================================================================== */

export class ConsumerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }

  get isAuth() {
    return this.status === 401;
  }
}

export interface ConsumerClientHooks {
  apiBase(): string;
  accessToken(): string | null;
  /** 401 时用 refresh token 换一次；失败返回 null */
  refresh(): Promise<string | null>;
  onUnauthorized(): void;
}

export class ConsumerClient {
  constructor(private readonly hooks: ConsumerClientHooks) {}

  private url(path: string) {
    return `${this.hooks.apiBase().replace(/\/+$/, '')}${path}`;
  }

  async request<T>(
    path: string,
    init: { method?: string; json?: unknown; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; auth?: boolean } = {},
  ): Promise<T> {
    const doFetch = (token: string | null) =>
      fetch(this.url(path), {
        method: init.method || (init.json !== undefined ? 'POST' : 'GET'),
        headers: {
          Accept: 'application/json',
          ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {}),
          ...(token && init.auth !== false ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? 30_000)]) : AbortSignal.timeout(init.timeoutMs ?? 30_000),
      }).catch((e) => {
        if ((e as Error).name === 'TimeoutError') throw new ConsumerError(504, '账号服务请求超时');
        throw new ConsumerError(503, `连不上账号服务：${(e as Error).message}`);
      });

    let res = await doFetch(init.auth === false ? null : this.hooks.accessToken());

    if (res.status === 401 && init.auth !== false) {
      const fresh = await this.hooks.refresh().catch(() => null);
      if (!fresh) {
        this.hooks.onUnauthorized();
        throw new ConsumerError(401, '登录已失效，请重新登录');
      }
      res = await doFetch(fresh);
    }

    const text = await res.text();
    const body: unknown = (() => {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    })();
    if (!res.ok) {
      const b = (body || {}) as { message?: string; error?: string; fields?: Record<string, string> };
      const message = b.message || (b.error === 'consumer_scope' ? '账号令牌不能访问这个接口' : b.error) || `账号服务返回 HTTP ${res.status}`;
      if (res.status === 401) this.hooks.onUnauthorized();
      throw new ConsumerError(res.status, message, b.error, b.fields);
    }
    return body as T;
  }
}

/* ---------------- Fast-SSO 原始 DTO ---------------- */

export interface FssMe {
  id: string;
  username: string;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  status?: string;
  riskLevel?: string;
  billingAccountId?: string | null;
  billingStatus?: string | null;
  createdAt?: string | null;
}

export interface FssBalance {
  accountId: string;
  appId?: string;
  totalMicro: number;
  giftMicro?: number;
  purchaseMicro?: number;
  expiringSoonMicro?: number;
  lotCount?: number;
  updatedAt?: string;
}

export interface FssSku {
  code: string;
  credits: number;
  amountCents: number;
  amountYuan: number;
}

export interface FssChannel {
  channel: string;
  enabled: boolean;
  mode?: string;
}

export interface FssChannels {
  mode?: string;
  channels: FssChannel[];
}

export type FssOrderStatus = 'pending' | 'paid' | 'closed' | 'refunded';

export interface FssOrder {
  id: string;
  outTradeNo?: string;
  appId?: string;
  skuCode: string;
  credits: number;
  amountYuan: number;
  amountCents: number;
  channel: string;
  status: FssOrderStatus;
  expiresAt?: string | null;
  paidAt?: string | null;
  closedAt?: string | null;
  createdAt?: string | null;
}

export interface FssPrepay {
  orderId: string;
  outTradeNo?: string;
  channel: string;
  codeUrl: string;
  expiresAt?: string | null;
}

export interface FssLedgerEntry {
  entryId: string;
  amountMicro: number;
  direction: 'credit' | 'debit';
  reason: string;
  occurredAt: string;
  appId?: string;
}

/* ---------------- 映射 ---------------- */

export const MICRO = 1_000_000;

/** micro 积分 → 积分（点）；保留 1 位小数展示 */
export function microToPoints(micro: number | null | undefined) {
  return Math.round(((micro || 0) / MICRO) * 10) / 10;
}

export function maskPhone(phone?: string | null) {
  if (!phone) return undefined;
  const digits = phone.replace(/^\+?86/, '').replace(/\D/g, '');
  if (digits.length < 7) return phone;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

export function mapProfile(me: FssMe): UserProfile {
  return {
    id: me.id,
    nickname: me.displayName || me.username || '账号',
    phoneMasked: maskPhone(me.phone),
    createdAt: me.createdAt ? Date.parse(me.createdAt) : Date.now(),
  };
}

export function mapBalance(b: FssBalance): WalletDto {
  return {
    balance: microToPoints(b.totalMicro),
    freeToday: 0,
    updatedAt: b.updatedAt ? Date.parse(b.updatedAt) : Date.now(),
  };
}

/** 只开放业务确认过的真实渠道；mock 永远不要展示 */
export const REAL_CHANNELS: PayChannel[] = ['huifu', 'wechat', 'alipay'];

export function mapChannels(c: FssChannels): PayChannel[] {
  const seen = new Set<PayChannel>();
  for (const ch of c.channels || []) {
    const name = ch.channel as PayChannel;
    if (!ch.enabled) continue;
    if (!REAL_CHANNELS.includes(name)) continue;
    seen.add(name);
  }
  return REAL_CHANNELS.filter((x) => seen.has(x));
}

export function mapSku(s: FssSku): PackDto {
  return {
    id: s.code,
    name: `${s.credits} 点`,
    amountCny: s.amountYuan,
    points: s.credits,
    note: '点数不过期',
  };
}

export function mapOrderStatus(s: FssOrderStatus): OrderDto['status'] {
  if (s === 'pending') return 'created';
  return s;
}

export function mapOrder(o: FssOrder, opts: { packName?: string; codeUrl?: string } = {}): OrderDto {
  const createdAt = o.createdAt ? Date.parse(o.createdAt) : Date.now();
  const expireAt = o.expiresAt ? Date.parse(o.expiresAt) : createdAt + 30 * 60_000;
  return {
    id: o.id,
    packId: o.skuCode,
    packName: opts.packName || `${o.credits} 点`,
    channel: o.channel as PayChannel,
    amountCny: o.amountYuan,
    points: o.credits,
    status: mapOrderStatus(o.status),
    qrContent: opts.codeUrl || undefined,
    createdAt,
    expireAt,
    paidAt: o.paidAt ? Date.parse(o.paidAt) : undefined,
  };
}
