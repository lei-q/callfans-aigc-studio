import type { Channel, Job, ModelInfo } from '@aigc/shared';
import { estSeconds, platformModeType } from '@aigc/shared';
import type { AccountSession } from '../account/session';
import type { PlatformModel } from '../account/platform';
import { PlatformError } from '../account/platform';
import { abortError, sleep } from './sleep';
import { sniffImageMime } from './treecloud';
import { ProviderError, type Provider, type ProviderOutput, type RunContext } from './types';

/* ============================================================================
   平台生成 Provider：用账号会话里的 LiteLLM 密钥调 https://api.callfansai.com
   - 图片：POST /v1/images/generations，b64_json 落本机；不自动重试
   - 视频：POST /v1/videos（model / prompt / seconds / size，不传 resolution）
           → 原样保存返回的 id → 每 3–5 秒 GET /v1/videos/{id}（最多 10 分钟）
           → GET /v1/videos/{id}/content 取 mp4
   创建成功（200）即已按秒计费，失败也不退：失败后绝不自动重建。
   模型与价格一律以 /models 的 mode 与 pricing 为准。
   ========================================================================== */

/** 生成任务只认图片 / 视频；文本走对话，音频暂未开放 */
export function platformMediaType(mode?: string): 'image' | 'video' | null {
  const t = platformModeType(mode);
  return t === 'image' || t === 'video' ? t : null;
}

export function platformMediaModelInfo(m: PlatformModel): ModelInfo | null {
  const type = platformMediaType(m.mode);
  if (!type) return null;
  return {
    id: `cloud:${m.id}`,
    name: m.id,
    type,
    /* 实际扣点由平台按用量结算；本地不做假的点数预估 */
    price: 0,
    basis: type === 'image' ? '张' : '秒',
    status: 'on',
    channel: 'cloud',
    upstream: m.id,
    secPer: type === 'image' ? 30 : 30,
    usageBilling: true,
    note: '平台渠道 · 按平台实际用量扣点',
    caps: m.protocol ? [m.protocol] : [],
    limit: '',
  };
}

export function platformMediaModels(models: PlatformModel[]): ModelInfo[] {
  return models.map(platformMediaModelInfo).filter((m): m is ModelInfo => !!m);
}

/** 时长 + 分辨率 → 平台视频接口的 size（如 1280x720）；不传 resolution */
export function videoSize(ratio?: string, vres?: string): string {
  const short = vres === '1080p' ? 1080 : vres === '480p' ? 480 : 720;
  const [rw, rh] = (ratio || '16:9').split(':').map(Number);
  const ar = rw && rh ? rw / rh : 16 / 9;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return ar >= 1 ? `${even(short * ar)}x${short}` : `${short}x${even(short / ar)}`;
}

const VIDEO_TIMEOUT_MS = 10 * 60_000;
const VIDEO_POLL_MS = 4000;

interface ImageReply {
  data?: { b64_json?: string; url?: string; media_type?: string }[];
}

interface VideoReply {
  id?: string;
  status?: string;
  seconds?: number;
  duration?: number;
  error?: { code?: string; message?: string } | string;
}

export class PlatformMediaProvider implements Provider {
  readonly id = 'cloud' as const;

  constructor(
    private readonly deps: {
      accounts: () => AccountSession;
      models: () => ModelInfo[];
      loggedIn: () => boolean;
      concurrency: () => number;
      /** 测试 / 调整轮询间隔 */
      pollMs?: number;
    },
  ) {}

  channel(): Channel {
    const ready = this.deps.loggedIn();
    return {
      id: 'cloud',
      name: '平台渠道',
      note: ready ? '平台提供模型，按实际用量扣点' : '登录后用平台点数生成',
      kind: 'cloud',
      ready,
    };
  }

  models(): ModelInfo[] {
    return this.deps.models();
  }

  concurrency() {
    return Math.max(1, Math.min(8, this.deps.concurrency()));
  }

  private get pollMs() {
    return this.deps.pollMs ?? VIDEO_POLL_MS;
  }

  private toProviderError(e: unknown): ProviderError {
    if (e instanceof ProviderError) return e;
    if (e instanceof PlatformError) {
      if (e.status === 422) return new ProviderError('E-BAL-02', '点数余额不足', '到顶栏账号里用微信 / 支付宝充值');
      if (e.status === 401) return new ProviderError('E-AUTH-01', e.message || '模型密钥已失效', '重新登录后重试');
      if (e.status === 429) return new ProviderError('E-RATE-29', e.message, '稍后重试');
      if (e.status === 400) return new ProviderError('E-PRM-04', e.message, '检查提示词与模型参数后重试');
      if (e.status === 504 || e.code === 'timeout') return new ProviderError('E-NET-05', e.message, '稍后重试；不要在超时后重复提交');
      return new ProviderError('E-UPS-50', e.message || '平台生成失败', '稍后重试；持续失败请带上模型与时间联系支持');
    }
    return new ProviderError('E-UPS-50', `平台生成失败：${(e as Error)?.message || String(e)}`, '稍后重试');
  }

  async run(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    try {
      if (job.type === 'image') return await this.runImage(job, model, ctx);
      if (job.type === 'video') return await this.runVideo(job, model, ctx);
      throw new ProviderError('E-MOD-05', `平台渠道暂不支持${job.type === 'audio' ? '音频' : '这个'}类型`, '到「模型与价格」切换到自定义渠道');
    } catch (e) {
      if (ctx.signal.aborted) throw abortError();
      throw this.toProviderError(e);
    }
  }

  async resume(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    if (job.type === 'video' && job.upstreamTaskId) {
      try {
        return await this.pollVideo(job, model, job.upstreamTaskId, ctx);
      } catch (e) {
        if (ctx.signal.aborted) throw abortError();
        throw this.toProviderError(e);
      }
    }
    throw new ProviderError('E-NET-03', '应用退出时请求还没完成，结果未知', '为避免重复扣费不会自动重试；可在任务记录里重跑');
  }

  private async runImage(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    const upstream = model.upstream || model.id.replace(/^cloud:/, '');
    let prompt = job.prompt.trim();
    if (job.ratio) prompt += `。画幅 ${job.ratio}`;
    if (job.negative?.trim()) prompt += `。避免出现：${job.negative.trim()}`;
    const count = Math.max(1, job.count || 1);
    ctx.progress(6, '提交到平台…');
    const reply = await this.deps.accounts().gatewayJson<ImageReply>('/v1/images/generations', {
      method: 'POST',
      json: { model: upstream, prompt, n: count, response_format: 'b64_json' },
      signal: ctx.signal,
      timeoutMs: 600_000,
    });
    const data = reply.data || [];
    if (!data.length) throw new ProviderError('E-UPS-51', '平台没有返回图片', '换个描述或模型再试；如果已被计费请联系支持');

    const outs: ProviderOutput[] = [];
    for (const d of data) {
      let buf: Buffer | null = null;
      let mime = d.media_type;
      if (d.b64_json) {
        buf = Buffer.from(d.b64_json, 'base64');
      } else if (d.url) {
        const got = await download(d.url, ctx.signal);
        buf = got.buf;
        mime = mime || got.mime;
      }
      if (!buf?.length) continue;
      const saved = await ctx.save(buf, mime && mime.startsWith('image/') ? mime : sniffImageMime(buf));
      outs.push({ src: saved.src, thumb: saved.src, mime: saved.mime });
    }
    if (!outs.length) throw new ProviderError('E-UPS-51', '平台返回的图片无法读取', '重跑一次；持续失败请联系支持');
    return outs;
  }

  private async runVideo(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    const upstream = model.upstream || model.id.replace(/^cloud:/, '');
    let prompt = job.prompt.trim();
    if (job.cam && job.cam !== '固定') prompt += `，运镜：${job.cam}`;
    else if (job.cam === '固定') prompt += '，固定机位';
    if (job.loop) prompt += '，首尾可无缝循环';
    if (job.negative?.trim()) prompt += `。避免：${job.negative.trim()}`;
    const seconds = Math.max(1, Math.round(job.dur || 5));
    const size = videoSize(job.ratio, job.vres);
    ctx.progress(3, '提交到平台…');
    const created = await this.deps.accounts().gatewayJson<VideoReply>('/v1/videos', {
      method: 'POST',
      json: { model: upstream, prompt, seconds, size },
      signal: ctx.signal,
      timeoutMs: 60_000,
    });
    const id = created?.id;
    if (!id) throw new ProviderError('E-UPS-52', '平台没有返回视频任务 ID', '稍后重试；如果已被计费请联系支持');
    job.upstreamTaskId = id;
    ctx.setUpstream(id);
    return this.pollVideo(job, model, id, ctx);
  }

  private async pollVideo(job: Job, model: ModelInfo, id: string, ctx: RunContext): Promise<ProviderOutput[]> {
    const t0 = Date.now();
    const deadline = t0 + VIDEO_TIMEOUT_MS;
    const total = estSeconds('video', job, model) * 1000;
    for (;;) {
      if (ctx.signal.aborted) throw abortError();
      let task: VideoReply;
      try {
        task = await this.deps.accounts().gatewayJson<VideoReply>(`/v1/videos/${encodeURIComponent(id)}`, {
          signal: ctx.signal,
          timeoutMs: 30_000,
        });
      } catch (e) {
        if (ctx.signal.aborted) throw abortError();
        /* 轮询瞬断：任务还在平台跑，等一会儿再查 */
        if (e instanceof PlatformError && (e.status === 0 || e.status >= 500) && Date.now() < deadline) {
          await sleep(this.pollMs, ctx.signal).catch(() => {
            throw abortError();
          });
          continue;
        }
        throw e;
      }
      const st = (task.status || '').toLowerCase();
      if (st === 'completed' || st === 'succeeded' || st === 'success' || st === 'done') {
        ctx.progress(96, '下载视频…');
        const got = await this.deps.accounts().gatewayBytes(`/v1/videos/${encodeURIComponent(id)}/content`, {
          signal: ctx.signal,
          timeoutMs: 180_000,
        });
        const meta = /json/i.test(got.mime) ? (JSON.parse(got.buf.toString('utf8') || '{}') as { url?: string; video_url?: string }) : null;
        const video = meta ? await download(meta.url || meta.video_url || '', ctx.signal) : got;
        if (!video.buf.length) throw new ProviderError('E-UPS-53', '平台任务完成但没有返回视频文件', '到平台账单里按任务 ID 核对');
        const saved = await ctx.save(video.buf, video.mime.startsWith('video/') ? video.mime : 'video/mp4');
        return [{ src: saved.src, mime: saved.mime, dur: task.seconds || task.duration || job.dur || 5 }];
      }
      if (st === 'failed' || st === 'error' || st === 'canceled' || st === 'cancelled' || st === 'expired') {
        const err = typeof task.error === 'string' ? task.error : task.error?.message || task.error?.code || st;
        throw new ProviderError(
          'E-UPS-54',
          `平台视频任务${st === 'expired' ? '已过期' : st === 'failed' || st === 'error' ? '失败' : '被取消'}：${err}`,
          '平台创建成功即已按秒计费、失败不退；确认原因后再手动重跑',
        );
      }
      if (Date.now() >= deadline) {
        throw new ProviderError('E-NET-05', '视频生成超过 10 分钟仍未完成', '平台已按秒计费且失败不退；确认后再到任务记录里手动重跑');
      }
      const p = st === 'queued' || st === 'pending' || st === 'submitted' ? 6 : Math.min(92, 10 + Math.round(((Date.now() - t0) / total) * 82));
      ctx.progress(p, st === 'queued' || st === 'pending' || st === 'submitted' ? '平台排队中…' : '平台生成中…');
      await sleep(this.pollMs, ctx.signal).catch(() => {
        throw abortError();
      });
    }
  }
}

async function download(url: string, signal?: AbortSignal): Promise<{ buf: Buffer; mime: string }> {
  if (!url) throw new ProviderError('E-UPS-53', '平台没有返回视频下载地址', '稍后重试');
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) }).catch((e) => {
    if (signal?.aborted) throw abortError();
    throw new ProviderError('E-NET-04', `结果下载失败：${(e as Error).message}`, '平台媒体地址可能已过期，重跑一次');
  });
  if (!res.ok) throw new ProviderError('E-NET-04', `结果下载失败（HTTP ${res.status}）`, '平台媒体地址可能已过期，重跑一次');
  return { buf: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || 'application/octet-stream' };
}
