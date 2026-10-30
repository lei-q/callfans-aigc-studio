import crypto from 'node:crypto';
import type { AudioUse, Channel, Job, MediaType, ModelInfo } from '@aigc/shared';
import { estSeconds, maxResFromSizes, pickImageSize, resoOf, VOICES } from '@aigc/shared';
import { abortError, sleep } from './sleep';
import { ProviderError, type ChatMessage, type Provider, type ProviderOutput, type RunContext } from './types';

/* ============================================================================
   TreeCloud Provider：https://api.jtreecloud.com
   - 图片：POST /v1/images/generations；有参考图走 /v1/images/edits（images[].image_url 用 data URL）
   - 视频：POST /api/v3/contents/generations/tasks → 轮询 GET …/{id} → content.video_url
   - 语音：POST /v1/audio/speech（二进制）
   - 对话：POST /v1/chat/completions
   约定：图片请求绝不自动重试——超时不代表没执行，重提会再次计费。
   ========================================================================== */

export interface TreeCloudConfig {
  baseUrl: string;
  apiKey: string | null;
  concurrency: number;
  prices: Record<string, number>;
  pollMs?: number;
}

export interface TreeCloudCatalog {
  models: ModelInfo[];
  chat: string[];
  at: number;
}

const DEFAULT_PRICE: Record<MediaType, { price: number; basis: string }> = {
  image: { price: 0.3, basis: '张' },
  video: { price: 0.8, basis: '秒' },
  audio: { price: 0.5, basis: '30 秒' },
};

interface RawCapability {
  feature?: string;
  runtime_status?: string;
  surfaces?: string[];
  limits?: {
    max_input_images?: number;
    max_outputs?: number;
    image_sizes?: string[];
    qualities?: string[];
  };
}
interface RawModel {
  id: string;
  name?: string;
  type?: string;
  api_interfaces?: { protocol?: string; method?: string; path?: string }[];
  capabilities?: RawCapability[];
}

const RUNNABLE = new Set(['enabled', 'canary']);

/** 只认能分类的模型：图像 / 视频 / 语音合成 / 对话 */
export function classify(m: RawModel): MediaType | 'chat' | null {
  const t = (m.type || '').toLowerCase();
  const paths = (m.api_interfaces || []).map((x) => (x.path || '').toLowerCase());
  const has = (re: RegExp) => paths.some((p) => re.test(p));
  if (t === 'image' || has(/\/images/)) return 'image';
  if (t === 'video' || has(/videos|contents\/generations/)) return 'video';
  if (t === 'tts' || t === 'audio' || t === 'speech' || has(/audio\/speech/)) return 'audio';
  if (has(/transcriptions|embeddings/) || /embed|whisper|transcri/i.test(m.id)) return null;
  if (t === 'chat' || t === 'text' || t === 'llm' || has(/chat\/completions|\/responses|\/messages/)) return 'chat';
  if (/image|img|dall|flux|seedream|imagen|banana|mj|midjourney/i.test(m.id)) return 'image';
  if (/video|seedance|kling|veo|sora|hailuo|wan|vidu/i.test(m.id)) return 'video';
  if (/tts|speech/i.test(m.id)) return 'audio';
  return 'chat';
}

export function toModelInfo(raw: RawModel, type: MediaType, prices: Record<string, number>): ModelInfo {
  const id = `tc:${raw.id}`;
  const caps = raw.capabilities || [];
  const runnable = caps.filter((c) => RUNNABLE.has((c.runtime_status || '').toLowerCase()));
  /* 有能力声明却一个都不可执行：fail-closed */
  const status: ModelInfo['status'] = caps.length && !runnable.length ? 'off' : 'on';
  const sizes = [...new Set(runnable.flatMap((c) => c.limits?.image_sizes || []))];
  const maxOutputs = Math.max(0, ...runnable.map((c) => c.limits?.max_outputs || 0)) || undefined;
  const refCap = runnable.find((c) => /edit|reference/i.test(c.feature || ''));
  const maxInputImages = caps.length ? refCap?.limits?.max_input_images ?? (refCap ? 4 : 0) : undefined;
  const def = DEFAULT_PRICE[type];
  const featureNames = runnable.map((c) => c.feature).filter((x): x is string => !!x);
  const base: ModelInfo = {
    id,
    name: raw.name || raw.id,
    type,
    price: prices[id] ?? def.price,
    basis: def.basis,
    status,
    channel: 'direct',
    upstream: raw.id,
    note: `TreeCloud 模型 · ${raw.id}`,
    caps: featureNames.length ? featureNames.slice(0, 4) : ['TreeCloud'],
    limit: '',
  };
  if (type === 'image') {
    base.imageSizes = sizes.length ? sizes : undefined;
    base.maxRes = maxResFromSizes(sizes);
    base.maxOutputs = maxOutputs;
    base.maxInputImages = maxInputImages;
    base.secPer = 30;
    base.limit = sizes.length ? `尺寸 ${sizes.slice(0, 4).join(' / ')}` : '尺寸按模型能力';
    if (base.maxRes) base.caps = [...base.caps, `最高 ${resoOf(base.maxRes).n}`];
  } else if (type === 'video') {
    base.durs = [5, 8, 10];
    base.maxDur = 15;
    base.secPer = 30;
    base.limit = '时长 4–15 秒（以模型能力为准）';
  } else {
    base.uses = ['tts'] as AudioUse[];
    base.limit = '单条文案 ≤ 4096 字';
    base.caps = ['语音合成', ...base.caps.filter((c) => c !== 'TreeCloud')];
  }
  return base;
}

/** 从 MP3 首帧估算时长（CBR 足够准；VBR 是近似值） */
export function mp3Duration(buf: Buffer): number {
  const kbps1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const kbps2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  let i = 0;
  if (buf.slice(0, 3).toString('latin1') === 'ID3' && buf.length > 10) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + size;
  }
  const end = Math.min(buf.length - 4, i + 65536);
  for (; i < end; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const ver = (buf[i + 1] >> 3) & 3;
      const idx = (buf[i + 2] >> 4) & 15;
      const kbps = (ver === 3 ? kbps1 : kbps2)[idx];
      if (kbps) return Math.max(1, Math.round(((buf.length - i) * 8) / (kbps * 1000)));
    }
  }
  return 0;
}

export function sniffImageMime(buf: Buffer) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  return 'image/png';
}

export class TreeCloudProvider implements Provider {
  readonly id = 'direct' as const;

  constructor(
    private readonly cfg: () => TreeCloudConfig,
    private readonly catalog: () => TreeCloudCatalog,
  ) {}

  private origin() {
    return (this.cfg().baseUrl || 'https://api.jtreecloud.com').replace(/\/+$/, '').replace(/\/(api\/)?v\d+(beta)?$/, '');
  }

  channel(): Channel {
    const ready = !!this.cfg().apiKey;
    return {
      id: 'direct',
      name: '自定义渠道',
      note: ready ? '你自己填写的上游渠道（TreeCloud 兼容），费用在上游结算，不扣平台点数' : '在「模型与价格 · 自定义渠道」填入 Base URL 与 API Key 后自动启用',
      kind: 'direct',
      ready,
    };
  }

  models(): ModelInfo[] {
    const prices = this.cfg().prices;
    return this.catalog().models.map((m) => (prices[m.id] != null ? { ...m, price: prices[m.id] } : m));
  }

  concurrency() {
    return Math.max(1, Math.min(8, this.cfg().concurrency || 2));
  }

  /* ---------------- 底层请求 ---------------- */

  private async request(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number }) {
    const key = this.cfg().apiKey;
    if (!key) throw new ProviderError('E-AUTH-00', '还没有配置 TreeCloud API Key', '到「设置」里填入 sk-tc- 开头的 Key');
    const signals = [AbortSignal.timeout(init.timeoutMs ?? 120_000)];
    if (init.signal) signals.push(init.signal);
    let res: Response;
    try {
      res = await fetch(`${this.origin()}${path}`, {
        method: init.method || (init.json ? 'POST' : 'GET'),
        headers: {
          Authorization: `Bearer ${key}`,
          ...(init.json ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        body: init.json ? JSON.stringify(init.json) : undefined,
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (init.signal?.aborted) throw abortError();
      const err = e as Error;
      if (err.name === 'TimeoutError') {
        throw new ProviderError('E-NET-02', '请求超时，上游可能仍在处理', '超时不代表没有执行：先到 TreeCloud 控制台用请求 ID 核对，再决定是否重试');
      }
      throw new ProviderError('E-NET-01', `连不上 TreeCloud：${err.message}`, '检查网络与「设置」里的 Base URL');
    }
    if (!res.ok) throw await mapError(res);
    return res;
  }

  async listRaw(signal?: AbortSignal): Promise<RawModel[]> {
    const res = await this.request('/v1/models', { signal, timeoutMs: 20_000 });
    const body = (await res.json()) as { data?: RawModel[] };
    return Array.isArray(body.data) ? body.data : [];
  }

  /** 拉取当前 Key 可用的模型，按类型归类 */
  async fetchCatalog(signal?: AbortSignal): Promise<TreeCloudCatalog> {
    const raw = await this.listRaw(signal);
    const models: ModelInfo[] = [];
    const chat: string[] = [];
    for (const m of raw) {
      const t = classify(m);
      if (!t) continue;
      if (t === 'chat') chat.push(m.id);
      else models.push(toModelInfo(m, t, this.cfg().prices));
    }
    return { models, chat, at: Date.now() };
  }

  /* ---------------- 生成 ---------------- */

  async run(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    if (job.type === 'image') return this.runImage(job, model, ctx);
    if (job.type === 'video') return this.runVideo(job, model, ctx);
    if (job.use && job.use !== 'tts') {
      throw new ProviderError('E-CAP-01', `TreeCloud 暂不支持${job.use === 'music' ? '音乐' : '音效'}生成`, '改用「配音」，音乐与音效等 TreeCloud 提供后再支持');
    }
    return this.runSpeech(job, model, ctx);
  }

  async resume(job: Job, model: ModelInfo, ctx: RunContext) {
    if (job.type !== 'video' || !job.upstreamTaskId) {
      throw new ProviderError('E-NET-03', '应用退出时请求还没完成，结果未知', '为避免重复计费不会自动重试；可到 TreeCloud 控制台核对后手动重试');
    }
    return this.pollVideo(job, model, job.upstreamTaskId, ctx);
  }

  async cancel(job: Job) {
    if (job.type === 'video' && job.upstreamTaskId) {
      try {
        await this.request(`/api/v3/contents/generations/tasks/${encodeURIComponent(job.upstreamTaskId)}`, { method: 'DELETE', timeoutMs: 15_000 });
      } catch {
        /* 取消是尽力而为 */
      }
    }
  }

  /** 等待期间按预估耗时推进进度，最多到 92%，真正完成才到 100% */
  private progressTicker(job: Job, model: ModelInfo, ctx: RunContext, label: string) {
    const total = estSeconds(job.type, job, model) * 1000;
    const t0 = Date.now();
    ctx.progress(4, label);
    const timer = setInterval(() => {
      const p = Math.min(92, 4 + Math.round(((Date.now() - t0) / total) * 88));
      ctx.progress(p, label);
    }, 1000);
    return () => clearInterval(timer);
  }

  private async refsAsDataUrls(job: Job, max: number, ctx: RunContext) {
    const out: string[] = [];
    for (const r of job.refs.slice(0, max)) {
      const d = await ctx.resolveRef(r.src);
      if (d && d.mime.startsWith('image/')) out.push(d.dataUrl);
    }
    return out;
  }

  private async runImage(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    const maxRefs = model.maxInputImages ?? 4;
    const images = maxRefs > 0 ? await this.refsAsDataUrls(job, maxRefs, ctx) : [];
    const size = pickImageSize(job.ratio, job.res, model.imageSizes);
    let prompt = job.prompt.trim();
    if (!size && job.ratio) prompt += `。画幅 ${job.ratio}`;
    if (job.negative?.trim()) prompt += `。避免出现：${job.negative.trim()}`;

    const want = Math.max(1, job.count || 1);
    const perReq = Math.max(1, Math.min(want, model.maxOutputs || want));
    const stop = this.progressTicker(job, model, ctx, '上游生成中…');
    const outputs: ProviderOutput[] = [];
    try {
      while (outputs.length < want) {
        const n = Math.min(perReq, want - outputs.length);
        const body: Record<string, unknown> = { model: model.upstream, prompt };
        if (n > 1) body.n = n;
        if (size) body.size = size;
        if (images.length) body.images = images.map((url) => ({ image_url: url }));
        const res = await this.request(images.length ? '/v1/images/edits' : '/v1/images/generations', {
          json: body,
          signal: ctx.signal,
          timeoutMs: 600_000,
        });
        const reqId = res.headers.get('x-request-id') || undefined;
        if (reqId) ctx.setUpstream('', reqId);
        const data = ((await res.json()) as { data?: { b64_json?: string; url?: string; media_type?: string }[] }).data || [];
        if (!data.length) break;
        for (const d of data) {
          let buf: Buffer;
          let mime = d.media_type;
          if (d.b64_json) buf = Buffer.from(d.b64_json, 'base64');
          else if (d.url) {
            const got = await download(d.url, ctx.signal);
            buf = got.buf;
            mime = mime || got.mime;
          } else continue;
          const saved = await ctx.save(buf, mime && mime.startsWith('image/') ? mime : sniffImageMime(buf));
          outputs.push({ src: saved.src, thumb: saved.src, mime: saved.mime, seed: randomSeed() });
        }
        /* 上游返回得比要的少：按实际数量交付，不重复提交 */
        if (data.length < n) break;
      }
    } finally {
      stop();
    }
    if (!outputs.length) throw new ProviderError('E-UPS-51', '上游没有返回图片', '换个描述或模型再试');
    return outputs;
  }

  private async runVideo(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    const images = await this.refsAsDataUrls(job, 2, ctx);
    let text = job.prompt.trim();
    if (job.cam && job.cam !== '固定') text += `，运镜：${job.cam}`;
    else if (job.cam === '固定') text += '，固定机位';
    if (job.loop) text += '，首尾可无缝循环';
    if (job.negative?.trim()) text += `。避免：${job.negative.trim()}`;
    const content: Record<string, unknown>[] = [{ type: 'text', text }];
    images.forEach((url, i) => {
      content.push({
        type: 'image_url',
        image_url: { url },
        role: i === 0 && job.firstFrame !== false ? 'first_frame' : 'reference_image',
      });
    });
    const body: Record<string, unknown> = {
      model: model.upstream,
      content,
      ratio: job.ratio || '16:9',
      resolution: job.vres || '720p',
      duration: job.dur || 5,
    };
    if (job.seed && /^\d+$/.test(job.seed)) body.seed = Number(job.seed);
    const requestId = crypto.randomUUID();
    ctx.progress(3, '提交到上游…');
    const res = await this.request('/api/v3/contents/generations/tasks', {
      json: body,
      headers: { 'X-Request-Id': requestId },
      signal: ctx.signal,
      timeoutMs: 60_000,
    });
    const created = (await res.json()) as { id?: string };
    if (!created.id) throw new ProviderError('E-UPS-52', '上游没有返回任务 ID', '稍后重试');
    ctx.setUpstream(created.id, res.headers.get('x-request-id') || requestId);
    job.upstreamTaskId = created.id;
    return this.pollVideo(job, model, created.id, ctx);
  }

  private async pollVideo(job: Job, model: ModelInfo, taskId: string, ctx: RunContext): Promise<ProviderOutput[]> {
    const total = estSeconds('video', job, model) * 1000;
    const t0 = job.startedAt || Date.now();
    const pollMs = this.cfg().pollMs ?? 5000;
    for (;;) {
      if (ctx.signal.aborted) {
        await this.cancel(job);
        throw abortError();
      }
      let task: {
        status?: string;
        content?: { video_url?: string };
        duration?: number;
        seed?: number;
        error?: { code?: string; message?: string };
      };
      try {
        const res = await this.request(`/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`, { signal: ctx.signal, timeoutMs: 30_000 });
        task = (await res.json()) as typeof task;
      } catch (e) {
        if (e instanceof ProviderError && e.code.startsWith('E-NET')) {
          /* 轮询断网：任务还在上游跑，等一会儿再查 */
          await sleep(pollMs, ctx.signal).catch(async (err) => {
            await this.cancel(job);
            throw err;
          });
          continue;
        }
        throw e;
      }
      const st = (task.status || '').toLowerCase();
      if (st === 'succeeded') {
        const url = task.content?.video_url;
        if (!url) throw new ProviderError('E-UPS-53', '任务成功但没有视频地址', '到 TreeCloud 控制台用任务 ID 下载');
        ctx.progress(96, '下载视频…');
        const got = await download(url, ctx.signal);
        const saved = await ctx.save(got.buf, got.mime.startsWith('video/') ? got.mime : 'video/mp4');
        return [{ src: saved.src, mime: saved.mime, dur: task.duration || job.dur || 5, seed: task.seed ?? randomSeed() }];
      }
      if (st === 'failed' || st === 'expired' || st === 'cancelled' || st === 'canceled') {
        const code = task.error?.code || st;
        throw new ProviderError(
          'E-UPS-54',
          `上游任务${st === 'expired' ? '已过期' : st === 'failed' ? '失败' : '被取消'}：${task.error?.message || code}`,
          '调整提示词或参数后重试；持续失败请带上任务 ID 联系 TreeCloud',
        );
      }
      const p = st === 'running' ? Math.min(92, 10 + Math.round(((Date.now() - t0) / total) * 82)) : 6;
      ctx.progress(p, st === 'running' ? '上游生成中…' : '上游排队中…');
      await sleep(pollMs, ctx.signal).catch(async (err) => {
        await this.cancel(job);
        throw err;
      });
    }
  }

  private async runSpeech(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    const voice = VOICES.find((v) => v.k === job.voice)?.upstream || 'alloy';
    const stop = this.progressTicker(job, model, ctx, '合成中…');
    try {
      const res = await this.request('/v1/audio/speech', {
        json: { model: model.upstream, input: job.prompt.slice(0, 4096), voice, response_format: 'mp3', speed: 1 },
        signal: ctx.signal,
        timeoutMs: 300_000,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new ProviderError('E-UPS-55', '上游返回了空音频', '换一段文案再试');
      const ctype = res.headers.get('content-type') || 'audio/mpeg';
      const saved = await ctx.save(buf, ctype.startsWith('audio/') ? ctype : 'audio/mpeg');
      const dur = mp3Duration(buf) || Math.max(1, Math.round(job.prompt.length / 4.5));
      return [{ src: saved.src, mime: saved.mime, dur, seed: randomSeed() }];
    } finally {
      stop();
    }
  }

  async chat(model: string, messages: ChatMessage[], signal?: AbortSignal) {
    const res = await this.request('/v1/chat/completions', {
      json: { model, messages, stream: false, temperature: 0.7 },
      signal,
      timeoutMs: 60_000,
    });
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content || '';
  }
}

const randomSeed = () => 10000 + Math.floor(Math.random() * 89999);

async function download(url: string, signal?: AbortSignal) {
  const signals = [AbortSignal.timeout(180_000)];
  if (signal) signals.push(signal);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.any(signals) });
  } catch (e) {
    if (signal?.aborted) throw abortError();
    throw new ProviderError('E-NET-04', `结果下载失败：${(e as Error).message}`, '上游地址可能已过期，到 TreeCloud 控制台重新下载');
  }
  if (!res.ok) throw new ProviderError('E-NET-04', `结果下载失败（HTTP ${res.status}）`, '上游地址可能已过期，到 TreeCloud 控制台重新下载');
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, mime: (res.headers.get('content-type') || '').split(';')[0].trim() };
}

/** 把上游错误翻译成「原因 + 修复建议」 */
export async function mapError(res: Response): Promise<ProviderError> {
  const reqId = res.headers.get('x-request-id');
  let msg = '';
  let code: string | number | undefined;
  let param: string | undefined;
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { error?: { message?: string; code?: string | number; param?: string }; message?: string; code?: string | number };
      msg = body.error?.message || body.message || '';
      code = body.error?.code ?? body.code;
      param = body.error?.param;
    } catch {
      msg = text.slice(0, 200);
    }
  } catch {
    /* 读不到 body 就只看状态码 */
  }
  const tail = reqId ? `（请求 ID ${reqId}）` : '';
  const c = String(code ?? '');
  if (res.status === 401) return new ProviderError('E-AUTH-01', `API Key 无效或已停用${tail}`, '到「设置」里检查 TreeCloud Key');
  if (res.status === 403) {
    return new ProviderError(
      'E-PERM-03',
      `${c === '17056' ? 'IP 不在白名单内' : '当前 Key 没有这个模型的权限'}${tail}`,
      '到 TreeCloud 控制台检查 Key 的模型白名单与 IP 白名单',
    );
  }
  if (res.status === 402) return new ProviderError('E-BAL-02', `TreeCloud 钱包余额或套餐额度不足${tail}`, '到 TreeCloud 控制台充值后重试');
  if (res.status === 429) {
    return new ProviderError(
      'E-RATE-29',
      `${c === '17003' ? '已超出这个 Key 的消费限额' : '触发了并发或速率限制'}${tail}`,
      c === '17003' ? '到 TreeCloud 控制台调高 Key 的消费限额' : '稍后重试，或在「设置」里调低并发数',
    );
  }
  if (res.status === 404 || c === '17004' || c === '17006') {
    return new ProviderError('E-MOD-04', `模型不存在、已下架或不在白名单内${tail}`, '到「设置」里刷新模型列表后换一个模型');
  }
  if (res.status === 400 || res.status === 422) {
    return new ProviderError(
      'E-PRM-05',
      `上游不接受这组参数${param ? `（${param}）` : ''}：${msg || '参数不受所选模型支持'}${tail}`,
      param === 'size' ? '换一个比例或分辨率，或换模型' : '调整参数后重试',
    );
  }
  return new ProviderError('E-UPS-50', `上游服务异常（HTTP ${res.status}）${msg ? `：${msg}` : ''}${tail}`, '稍后重试；持续失败请带上请求 ID 联系 TreeCloud');
}
