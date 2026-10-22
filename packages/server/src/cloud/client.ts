import type { CloudErrorBody, CloudTokens } from '@aigc/shared';
import { CLOUD_ERROR } from '@aigc/shared';

/* ============================================================================
   云端 HTTP 客户端：统一带 token、统一错误映射、401 时自动刷新一次。
   ========================================================================== */

export class CloudError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly requestId?: string,
    readonly status = 500,
  ) {
    super(message);
  }

  get isAuth() {
    return this.code === CLOUD_ERROR.TOKEN_INVALID || this.code === CLOUD_ERROR.NOT_LOGGED_IN;
  }
  get isBalance() {
    return this.code === CLOUD_ERROR.BALANCE_NOT_ENOUGH;
  }
}

export interface CloudClientHooks {
  baseUrl(): string;
  tokens(): CloudTokens | null;
  /** 401 时尝试用 refresh_token 换一次；成功返回新 token */
  refresh(): Promise<CloudTokens | null>;
  onUnauthorized(): void;
}

export class CloudClient {
  constructor(private readonly hooks: CloudClientHooks) {}

  get configured() {
    return !!this.hooks.baseUrl();
  }

  private url(path: string) {
    return `${this.hooks.baseUrl().replace(/\/+$/, '')}${path}`;
  }

  async request<T>(path: string, init: { method?: string; json?: unknown; signal?: AbortSignal; timeoutMs?: number; auth?: boolean } = {}): Promise<T> {
    if (!this.configured) throw new CloudError(CLOUD_ERROR.NOT_FOUND, '还没有配置云端地址', undefined, 400);
    const doFetch = (token: string | null) =>
      fetch(this.url(path), {
        method: init.method || (init.json ? 'POST' : 'GET'),
        headers: {
          ...(init.json ? { 'Content-Type': 'application/json' } : {}),
          ...(token && init.auth !== false ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: init.json ? JSON.stringify(init.json) : undefined,
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? 30_000)]) : AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });

    let res = await doFetch(init.auth === false ? null : this.hooks.tokens()?.accessToken || null).catch((e) => {
      if ((e as Error).name === 'TimeoutError') throw new CloudError(CLOUD_ERROR.INTERNAL, '云端请求超时', undefined, 504);
      throw new CloudError(CLOUD_ERROR.INTERNAL, `连不上云端：${(e as Error).message}`, undefined, 503);
    });

    if (res.status === 401 && init.auth !== false) {
      const fresh = await this.hooks.refresh().catch(() => null);
      if (fresh) {
        res = await doFetch(fresh.accessToken).catch((e) => {
          throw new CloudError(CLOUD_ERROR.INTERNAL, `连不上云端：${(e as Error).message}`, undefined, 503);
        });
      } else {
        this.hooks.onUnauthorized();
        throw new CloudError(CLOUD_ERROR.TOKEN_INVALID, '登录已失效，请重新登录', undefined, 401);
      }
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const err = (body || {}) as CloudErrorBody;
      if (err.code === CLOUD_ERROR.TOKEN_INVALID) this.hooks.onUnauthorized();
      throw new CloudError(err.code || res.status, err.message || `云端返回 HTTP ${res.status}`, err.requestId, res.status);
    }
    return body as T;
  }

  /** SSE：登录态下的事件流；断线由调用方重连 */
  events(onEvent: (e: unknown) => void, signal: AbortSignal) {
    const open = async () => {
      const token = this.hooks.tokens()?.accessToken;
      if (!this.configured || !token) return;
      try {
        const res = await fetch(this.url('/events'), { headers: { Authorization: `Bearer ${token}` }, signal });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line) {
              try {
                onEvent(JSON.parse(line.slice(6)));
              } catch {
                /* 忽略坏消息 */
              }
            }
          }
        }
      } catch {
        /* 断线后由外层定时重连 */
      }
    };
    void open();
  }
}
