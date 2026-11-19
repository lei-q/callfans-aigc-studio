import type { AccountConfig, PlatformModelsReply } from '@aigc/shared';
import type { ChatMessage } from '../providers/types';

/* ============================================================================
   平台模型清单与网关（LiteLLM，https://api.callfansai.com）：
   - 清单 GET {accountApi}/public/apps/models?clientId=…，免令牌，缓存 60 秒。
     走账号服务而不是网关的 /models：账号服务按应用返回**本应用真正能调用**的模型，
     网关清单里还包含没绑给本应用的模型，选了也没法生成。
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
  pricing?: {
    input_per_million?: number;
    output_per_million?: number;
    per_image?: number;
    per_video_second?: number;
    per_video_second_by_resolution?: Record<string, number>;
    per_character?: number;
    per_audio_second?: number;
    /** 实际结算折扣：0.8 = 8 折；per_* 都是折前上游标价 */
    discount_rate?: number;
  } | null;
}

export class PlatformError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /**
     * 网关把上游 4xx 包成 5xx 返回时（例如图像接口把上游的 400 invalid_value
     * 报成 503），这里保留上游的真实状态码。判定「这是参数错误还是服务故障」
     * 必须看它，不能看 status。
     */
    readonly upstreamStatus?: number,
    /** 这次请求的现场：HTTP 状态、等了多久、经过的网关、LiteLLM 日志 ID。用来和平台后台日志对上号 */
    readonly trace?: string,
  ) {
    super(message);
  }
}

/** 网关 / 代理层把长请求切断时返回的状态码：请求到不了「成功返回」这一步，但平台那边可能已经做完并计费了 */
export const GATEWAY_CUT_STATUSES = [502, 504, 524, 408];

/**
 * 记下一次失败响应的现场。LiteLLM 后台能用 x-litellm-call-id 查到这次请求，
 * 前面的 nginx / Cloudflare 之类的代理则能从 server / cf-ray 和 HTML 报错页认出来。
 */
export function traceOf(res: { status: number; headers: { get(name: string): string | null } }, elapsedMs: number, bodyText = ''): string {
  const h = (n: string) => res.headers.get(n);
  const callId = h('x-litellm-call-id') || h('x-litellm-request-id') || h('x-request-id');
  const via = h('cf-ray') ? `Cloudflare（${h('cf-ray')}）` : h('server');
  const html = /^\s*</.test(bodyText) ? bodyText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return [`HTTP ${res.status}`, `等了 ${Math.round(elapsedMs / 1000)}s`, via ? `经过 ${via}` : '', callId ? `日志 ID ${callId}` : '', html ? `网关页面：${html}` : ''].filter(Boolean).join(' · ');
}

const CATALOG_TTL_MS = 60_000;
const GATEWAY_TIMEOUT_MS = 120_000;

/** 提示词辅助用的模型偏好；清单里没有就按标价取最便宜的 openai 协议对话模型 */
const PREFERRED = ['deepseek-v4.1-flash-1017', 'claude-haiku-5-5', 'gpt-6-luna'];

/** 折扣率只认 (0, 1] 的数字；平台没返回或给了不合理的值就当没有，界面据此显示「折扣率未返回」，不编数字 */
export function validDiscount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : null;
}

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

/** 清单接口返回的原始结构：{appId, data:[模型卡片]} */
interface AppModelsReply {
  appId?: string;
  data?: PlatformModel[];
  code?: string;
  message?: string;
}

export class PlatformCatalog {
  private cache: { key: string; models: PlatformModel[]; appId?: string; url: string; at: number } | null = null;
  private inflight: Promise<PlatformModel[]> | null = null;

  constructor(private readonly config: () => AccountConfig) {}

  private base() {
    return (this.config().gatewayBase || 'https://api.callfansai.com').replace(/\/+$/, '');
  }

  private apiBase() {
    return (this.config().apiBase || 'https://account.callfansai.com/api/v1').replace(/\/+$/, '');
  }

  /** 清单接口地址：账号服务按应用返回本应用能用的模型 */
  catalogUrl() {
    const clientId = this.config().clientId || 'aigc-callfans';
    return `${this.apiBase()}/public/apps/models?clientId=${encodeURIComponent(clientId)}`;
  }

  /** 免令牌模型清单；502/503 是平台暂时读不到配置，不代表没有模型 */
  async models(force = false): Promise<PlatformModel[]> {
    const key = `${this.apiBase()}|${this.config().clientId || ''}`;
    const now = Date.now();
    const hit = this.cache;
    if (!force && hit && hit.key === key && now - hit.at < CATALOG_TTL_MS) return hit.models;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const url = this.catalogUrl();
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }).catch((e) => {
        throw new PlatformError(0, `连不上平台账号服务：${(e as Error).message}`, 'catalog_unreachable');
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
        const b = (body || {}) as AppModelsReply;
        /* 只有「这个端点根本不存在」才退回老的网关清单：其它 404 都是 clientId 没登记，
           退回旧清单会让人以为模型可用、生成时才失败。 */
        if (res.status === 404 && !b.code) return this.legacyModels();
        throw new PlatformError(res.status, catalogErrorMessage(res.status, b), b.code || 'model_catalog_unavailable');
      }
      const models = normalizeCatalog(body);
      if (!models) throw new PlatformError(0, '模型清单格式不对：缺少 data', 'model_catalog_malformed');
      this.cache = { key, models, appId: (body as AppModelsReply).appId, url, at: Date.now() };
      return models;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /**
   * 老版本账号服务没有 /public/apps/models 时的退路：读网关的全量清单。
   * 全量清单可能含未绑定给本应用的模型，所以只在端点缺失时使用，并记一条提示。
   */
  private async legacyModels(): Promise<PlatformModel[]> {
    const base = this.base();
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
      throw new PlatformError(res.status, `平台模型清单返回 HTTP ${res.status}`, 'model_catalog_unavailable');
    }
    const models = normalizeCatalog(body) || [];
    this.cache = { key: `${this.apiBase()}|${this.config().clientId || ''}`, models, url: `${base}/models`, at: Date.now() };
    return models;
  }

  /** 当前该用哪个对话模型；selected 是用户在界面上选的（空 = 自动） */
  async chatModel(selected = ''): Promise<string | null> {
    return pickChatModel(await this.models(), selected);
  }

  /** 同步读缓存：生成渠道的模型目录要用它（不能在这里发请求） */
  cachedModels(): PlatformModel[] {
    const hit = this.cache;
    return hit && hit.key === `${this.apiBase()}|${this.config().clientId || ''}` ? hit.models : [];
  }

  /** 缓存里记着的清单来源；「模型与价格」用来说明模型是从哪来的 */
  cachedSource(): { url: string; appId?: string } | null {
    const hit = this.cache;
    if (!hit) return null;
    return { url: hit.url, appId: hit.appId };
  }

  /** 「模型与价格」用：清单（按 mode 分组交给界面） */
  async summary(force = false): Promise<PlatformModelsReply> {
    const models = await this.models(force);
    const src = this.cachedSource();
    return {
      gatewayBase: this.base(),
      catalogUrl: src?.url || this.catalogUrl(),
      appId: src?.appId,
      models: models.map((m) => ({
        id: m.id,
        protocol: m.protocol,
        mode: m.mode,
        contextWindow: m.context_window ?? null,
        maxOutputTokens: m.max_output_tokens ?? null,
        inputPerMillion: m.pricing?.input_per_million ?? null,
        outputPerMillion: m.pricing?.output_per_million ?? null,
        perImage: m.pricing?.per_image ?? null,
        perVideoSecond: m.pricing?.per_video_second ?? null,
        perVideoSecondByResolution: m.pricing?.per_video_second_by_resolution ?? null,
        perCharacter: m.pricing?.per_character ?? null,
        perAudioSecond: m.pricing?.per_audio_second ?? null,
        discountRate: validDiscount(m.pricing?.discount_rate),
      })),
      at: Date.now(),
    };
  }
}

/**
 * 清单响应 → 模型数组。新接口是 `{appId, data:[…]}`，老网关是 `{object, data:[…]}`
 * 或裸数组，三种都认；`data` 缺失或不是数组时返回 null（由调用方判定为格式错误）。
 */
export function normalizeCatalog(body: unknown): PlatformModel[] | null {
  const list = Array.isArray(body) ? body : ((body as { data?: unknown } | null)?.data as unknown);
  if (!Array.isArray(list)) return null;
  return (list as PlatformModel[]).filter((m) => !!m?.id);
}

/** 清单接口的错误说明：404 是应用没登记，403 是应用停用，都不该被当成「稍后重试」 */
export function catalogErrorMessage(status: number, body?: AppModelsReply) {
  const detail = body?.message?.trim();
  if (status === 404) {
    return `平台没有登记这个应用的模型清单${detail ? `（${detail}）` : ''}：检查 clientId 配置`;
  }
  if (status === 403) {
    return `平台上的这个应用已停用${detail ? `（${detail}）` : ''}：到平台控制台启用后再试`;
  }
  if (status === 502 || status === 503) return '平台模型清单暂时读不到，稍后重试';
  if (status === 400) return '平台模型清单请求不合法：缺少 clientId';
  return `平台模型清单返回 HTTP ${status}${detail ? `：${detail}` : ''}`;
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
    const upstreamStatus = upstreamStatusOf(body);
    throw new PlatformError(res.status, gatewayMessage(res.status, detail, upstreamStatus), code, upstreamStatus);
  }
  const content = contentOf((body || {}) as ChatReply).trim();
  if (!content) throw new PlatformError(res.status, '模型没有返回内容', 'empty_reply');
  return content;
}

/**
 * 网关状态码 → 给人看的一句话。
 *
 * {@code upstreamStatus} 是网关包装上游失败时附带的真实状态码：上游 400 被
 * 报成 503 时，按 400 处理——那是用户改参数就能解决的客户端错误，不该提示
 * 「稍后重试」。
 */
export function gatewayMessage(status: number, detail: string, upstreamStatus?: number) {
  const client = status >= 500 && upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 500
    ? upstreamStatus
    : status;
  if (client === 401) return '模型密钥已失效：重新登录后再试';
  if (client === 422) return '积分不足：这个账号在该应用的积分用完了，充值后再试';
  if (client === 429) return '模型服务限流，请稍后再试';
  if (client === 400) return `模型请求不合法：${detail || '检查模型名与参数'}`;
  if (status >= 500) return '平台模型服务暂时不可用，稍后重试';
  return detail || `平台模型网关返回 HTTP ${status}`;
}

/**
 * 网关把上游 4xx 包装成 5xx 时，响应体里的原始状态码。
 *
 * 图像路由错误的那一刻最典型：上游说 `400 invalid_value: Invalid size
 * '1080x608'. Width and height must both be divisible by 16`，网关按
 * 「上游调用失败」回 503，于是这条本可以照着改参数解决的客户端错误，
 * 被统一显示成「平台服务暂时不可用，稍后重试」——用户只会反复重试同一个
 * 必然失败的请求。
 *
 * LiteLLM 把上游信息放在 `message` 里那段上游 JSON 的 `upstream.http_status`，
 * 也有版本直接用 `error.upstream_status` / `upstream_status`。都读一遍；
 * 只有 4xx 才算，5xx 仍旧是服务故障。
 */
export function upstreamStatusOf(body: unknown): number | undefined {
  const found = findUpstreamStatus(body, 0);
  return found && found >= 400 && found < 500 ? found : undefined;
}

function findUpstreamStatus(node: unknown, depth: number): number | undefined {
  if (!node || depth > 4) return undefined;
  if (typeof node === 'string') {
    /* message 是 JSON 字符串时（"{\"error\":{...}}"）解析一层再看 */
    const text = node.trim();
    if (text.startsWith('{')) {
      try {
        return findUpstreamStatus(JSON.parse(text), depth + 1);
      } catch {
        return undefined;
      }
    }
    /* 兜底：上游原文里带 http_status。不解析 JSON 也能认出最常见的写法 */
    const m = /"http_status"\s*:\s*(\d{3})/.exec(text);
    return m ? Number(m[1]) : undefined;
  }
  if (typeof node !== 'object') return undefined;
  const o = node as Record<string, unknown>;
  for (const key of ['upstream_status', 'upstreamStatus']) {
    const v = o[key];
    if (typeof v === 'number') return v;
  }
  for (const key of ['upstream', 'error', 'message', 'detail']) {
    const found = findUpstreamStatus(o[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** 网关错误体 → PlatformError（详情与 code 尽量保留，便于排查） */
export function platformError(status: number, body: unknown, trace?: string): PlatformError {
  const b = (body || {}) as { error?: { message?: string; code?: string } | string; message?: string; code?: string; detail?: string };
  const detail = typeof b.error === 'string' ? b.error : b.error?.message || b.message || b.detail || (typeof body === 'string' ? body : '');
  const code = typeof b.error === 'object' ? b.error?.code || b.code : b.code;
  const upstreamStatus = upstreamStatusOf(body);
  return new PlatformError(status, gatewayMessage(status, detail, upstreamStatus), code, upstreamStatus, trace);
}
