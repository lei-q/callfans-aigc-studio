import type { AccountConfig, PlatformModelsReply } from '@aigc/shared';
import type { ChatMessage } from '../providers/types';

/* ============================================================================
   平台模型网关（LiteLLM，https://api.callfansai.com）：
   - 模型清单 GET /models 免令牌，运行时拉取并缓存 60 秒；
   - 调用 POST /v1/chat/completions，只认 LiteLLM 虚拟密钥（key 由账号会话换取）；
   - consumer access token 只发 account.callfansai.com，key 只发网关，两者不混用。
   ========================================================================== */

export interface PlatformModel {
  id: string;
  protocol?: string;
  mode?: string;
  family?: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  pricing?: { input_per_million?: number; output_per_million?: number } | null;
}

export class PlatformError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const CATALOG_TTL_MS = 60_000;
const GATEWAY_TIMEOUT_MS = 120_000;

/** 提示词辅助用的模型偏好；清单里没有就按标价取最便宜的 openai 协议对话模型 */
const PREFERRED = ['deepseek-v4.1-flash-1017', 'claude-haiku-5-5', 'gpt-6-luna'];

function costOf(m: PlatformModel) {
  return (m.pricing?.input_per_million ?? 0) + (m.pricing?.output_per_million ?? 0);
}

export function pickChatModel(models: PlatformModel[], selected = '', preferred: string[] = PREFERRED): string | null {
  const chat = models.filter((m) => m.mode === 'chat' && m.protocol === 'openai');
  if (!chat.length) return null;
  for (const id of [process.env.AIGC_CHAT_MODEL, selected, ...preferred]) {
    if (!id) continue;
    const hit = chat.find((m) => m.id === id);
    if (hit) return hit.id;
  }
  return [...chat].sort((a, b) => costOf(a) - costOf(b))[0]?.id || null;
}

export class PlatformCatalog {
  private cache: { base: string; models: PlatformModel[]; at: number } | null = null;
  private inflight: Promise<PlatformModel[]> | null = null;

  constructor(private readonly config: () => AccountConfig) {}

  private base() {
    return (this.config().gatewayBase || 'https://api.callfansai.com').replace(/\/+$/, '');
  }

  /** 免令牌模型清单；502/503 是网关暂时读不到配置，不代表没有模型 */
  async models(force = false): Promise<PlatformModel[]> {
    const base = this.base();
    const now = Date.now();
    const hit = this.cache;
    if (!force && hit && hit.base === base && now - hit.at < CATALOG_TTL_MS) return hit.models;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const res = await fetch(`${base}/models`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }).catch((e) => {
        throw new PlatformError(0, `连不上平台模型网关：${(e as Error).message}`, 'catalog_unreachable');
      });
      const text = await res.text();
      const body: unknown = (() => {
        try {
          return text ? JSON.parse(text) : null;
        } catch {
          return null;
        }
      })();
      if (!res.ok) {
        const code = (body as { code?: string } | null)?.code;
        const message =
          res.status === 404
            ? '平台没有开放模型清单'
            : res.status === 502 || res.status === 503
              ? '平台模型清单暂时读不到，稍后重试'
              : `平台模型清单返回 HTTP ${res.status}`;
        throw new PlatformError(res.status, message, code || 'model_catalog_unavailable');
      }
      const list = Array.isArray(body) ? body : ((body as { data?: unknown } | null)?.data as unknown);
      const models = Array.isArray(list) ? (list as PlatformModel[]).filter((m) => !!m?.id) : [];
      this.cache = { base, models, at: Date.now() };
      return models;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /** 当前该用哪个对话模型；selected 是用户在界面上选的（空 = 自动） */
  async chatModel(selected = ''): Promise<string | null> {
    return pickChatModel(await this.models(), selected);
  }

  /** 「模型与价格」用：清单 + 当前选中的辅助模型 */
  async summary(selected: string, force = false): Promise<PlatformModelsReply> {
    const models = await this.models(force);
    return {
      gatewayBase: this.base(),
      models: models.map((m) => ({
        id: m.id,
        protocol: m.protocol,
        mode: m.mode,
        contextWindow: m.context_window ?? null,
        maxOutputTokens: m.max_output_tokens ?? null,
        inputPerMillion: m.pricing?.input_per_million ?? null,
        outputPerMillion: m.pricing?.output_per_million ?? null,
      })),
      selected,
      chatModel: pickChatModel(models, selected),
      at: Date.now(),
    };
  }
}

interface ChatReply {
  choices?: { message?: { content?: unknown } }[];
  error?: { message?: string; code?: string } | string;
}

function contentOf(body: ChatReply): string {
  const c = body?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === 'string' ? p : typeof (p as { text?: string })?.text === 'string' ? (p as { text: string }).text : ''))
      .join('');
  }
  return '';
}

export async function platformChat(opts: {
  baseUrl: string;
  key: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeout = opts.timeoutMs ?? GATEWAY_TIMEOUT_MS;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.key}`,
    },
    body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: false }),
    signal,
  }).catch((e) => {
    if ((e as Error).name === 'TimeoutError') throw new PlatformError(504, '模型调用超时，请稍后再试', 'timeout');
    throw new PlatformError(0, `连不上平台模型网关：${(e as Error).message}`, 'gateway_unreachable');
  });
  const text = await res.text();
  const body: unknown = (() => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  })();
  if (!res.ok) {
    const b = (body || {}) as ChatReply;
    const detail = typeof b.error === 'string' ? b.error : b.error?.message || '';
    const code = typeof b.error === 'object' ? b.error?.code : undefined;
    throw new PlatformError(res.status, gatewayMessage(res.status, detail), code);
  }
  const content = contentOf((body || {}) as ChatReply).trim();
  if (!content) throw new PlatformError(res.status, '模型没有返回内容', 'empty_reply');
  return content;
}

function gatewayMessage(status: number, detail: string) {
  if (status === 401) return '模型密钥已失效：重新登录后再试';
  if (status === 422) return '积分不足：这个账号在该应用的积分用完了，充值后再试';
  if (status === 429) return '模型服务限流，请稍后再试';
  if (status === 400) return `模型请求不合法：${detail || '检查模型名与参数'}`;
  if (status >= 500) return '平台模型服务暂时不可用，稍后重试';
  return detail || `平台模型网关返回 HTTP ${status}`;
}
