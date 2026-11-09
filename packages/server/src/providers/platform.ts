import type { AudioUse, Channel, Job, ModelInfo } from '@aigc/shared';
import { estSeconds, platformGenerationType, VOICES } from '@aigc/shared';
import type { AccountSession } from '../account/session';
import type { PlatformModel } from '../account/platform';
import { PlatformError } from '../account/platform';
import { abortError, sleep } from './sleep';
import { mp3Duration, sniffImageMime } from './treecloud';
import { ProviderError, type Provider, type ProviderOutput, type RunContext } from './types';

/* ============================================================================
   平台生成 Provider：用账号会话里的 LiteLLM 密钥调 https://api.callfansai.com
   - 图片：无参考素材走 POST /v1/images/generations（b64_json 落本机）；
           有参考素材走 POST /v1/images/edits（multipart image[]，最多 4 张）；不自动重试
   - 视频：POST /v1/videos（model / prompt / seconds / size；有首帧时改用 multipart 带 input_reference）
           → 原样保存返回的 id → 每 3–5 秒 GET /v1/videos/{id}（最多 10 分钟）
           → GET /v1/videos/{id}/content 取 mp4
   - 语音：POST /v1/audio/speech（OpenAI 兼容），二进制音频落本机
   创建成功（200）即已按用量计费，失败也不退：失败后绝不自动重建。
   模型与价格一律以 /models 的 mode 与 pricing 为准。
   ========================================================================== */

/** 生成任务认图片 / 视频 / 语音合成；音频转写和实时语音不是创作能力 */
export function platformMediaType(mode?: string): 'image' | 'video' | 'audio' | null {
  return platformGenerationType(mode);
}

export function platformMediaModelInfo(m: PlatformModel): ModelInfo | null {
  const type = platformMediaType(m.mode);
  if (!type) return null;
  const audio = type === 'audio';
  return {
    id: `cloud:${m.id}`,
    name: m.id,
    type,
    /* 实际扣点由平台按用量结算；本地不做假的点数预估 */
    price: 0,
    basis: type === 'image' ? '张' : type === 'video' ? '秒' : '字',
    status: 'on',
    channel: 'cloud',
    upstream: m.id,
    secPer: 30,
    usageBilling: true,
    note: '平台渠道 · 按平台实际用量扣点',
    caps: m.protocol ? [m.protocol] : [],
    limit: audio ? '单条文案 ≤ 4096 字' : '',
    ...(audio ? { uses: ['tts'] as AudioUse[] } : {}),
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
      if (job.type === 'audio') return await this.runSpeech(job, model, ctx);
      throw new ProviderError('E-MOD-05', '平台渠道暂不支持这个类型', '改用图像、视频或配音');
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
    const refs = job.refs.slice(0, 4);

    /* 有参考素材时走编辑接口：multipart 上传本地原图（image[]），n 是期望张数 */
    if (refs.length) {
      ctx.progress(4, '读取参考素材…');
      const images = (
        await Promise.all(
          refs.map(async (r) => {
            const got = await ctx.resolveRef(r.src);
            return got ? await imageBytes(got) : null;
          }),
        )
      ).filter((x): x is { buf: Buffer; mime: string } => !!x);
      /* 有参考素材却读不全时不要悄悄退回文生图，否则成片和用户预期完全无关 */
      if (images.length !== refs.length) {
        throw new ProviderError('E-PRM-04', '参考素材读取失败，未提交生成', '重新拖入参考图后再试；本次没有提交，不会扣点');
      }
      if (images.some((im) => im.buf.length > 10 * 1024 * 1024)) {
        throw new ProviderError('E-PRM-04', '参考图超过 10MB', '换一张小一点的参考图；本次没有提交，不会扣点');
      }
      ctx.progress(6, '提交到平台…');
      const form = new FormData();
      form.append('model', upstream);
      form.append('prompt', prompt);
      form.append('n', String(count));
      images.forEach((im, i) => {
        form.append('image[]', new Blob([im.buf], { type: im.mime }), `reference-${i + 1}.${imageExt(im.mime)}`);
      });
      const reply = await this.deps.accounts().gatewayJson<ImageReply>('/v1/images/edits', {
        method: 'POST',
        form,
        signal: ctx.signal,
        timeoutMs: 600_000,
      });
      return this.saveImageReply(reply, ctx);
    }

    ctx.progress(6, '提交到平台…');
    const reply = await this.deps.accounts().gatewayJson<ImageReply>('/v1/images/generations', {
      method: 'POST',
      json: { model: upstream, prompt, n: count, response_format: 'b64_json' },
      signal: ctx.signal,
      timeoutMs: 600_000,
    });
    return this.saveImageReply(reply, ctx);
  }

  /** 生成 / 编辑接口的返回结构一致：b64_json 或 url，统一落盘 */
  private async saveImageReply(reply: ImageReply, ctx: RunContext): Promise<ProviderOutput[]> {
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

  private async runSpeech(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    if (job.use && job.use !== 'tts') {
      throw new ProviderError(
        'E-CAP-01',
        `平台暂不支持${job.use === 'music' ? '音乐' : '音效'}生成`,
        '平台目前提供语音合成；把用途切到「配音」后再试',
      );
    }
    const text = job.prompt.trim();
    if (!text) throw new ProviderError('E-PRM-04', '配音文案是空的', '写下要朗读的文案后再试');
    const voice = VOICES.find((v) => v.k === job.voice)?.upstream || 'alloy';
    const upstream = model.upstream || model.id.replace(/^cloud:/, '');
    ctx.progress(8, '提交到平台…');
    const got = await this.deps.accounts().gatewayBytes('/v1/audio/speech', {
      method: 'POST',
      json: { model: upstream, input: text.slice(0, 4096), voice, response_format: 'mp3', speed: 1 },
      signal: ctx.signal,
      timeoutMs: 300_000,
    });
    if (!got.buf.length) throw new ProviderError('E-UPS-55', '平台返回了空音频', '换一段文案再试；如果已被计费请联系支持');
    ctx.progress(96, '保存音频…');
    const mime = got.mime.startsWith('audio/') ? got.mime.split(';')[0].trim() : 'audio/mpeg';
    const saved = await ctx.save(got.buf, mime);
    const dur = mp3Duration(got.buf) || Math.max(1, Math.round(text.length / 4.5));
    return [{ src: saved.src, mime: saved.mime, dur }];
  }

  private async runVideo(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    const upstream = model.upstream || model.id.replace(/^cloud:/, '');
    let prompt = job.prompt.trim();
    if (job.cam && job.cam !== '固定') prompt += `，运镜：${job.cam}`;
    else if (job.cam === '固定') prompt += '，固定机位';
    if (job.loop) prompt += '，首尾可无缝循环';
    if (job.negative?.trim()) prompt += `。避免：${job.negative.trim()}`;
    const seconds = String(Math.max(1, Math.round(job.dur || 5)));
    const size = videoSize(job.ratio, job.vres);
    /* 首帧参考图按平台约定用 multipart 的 input_reference 上传；
       不支持首帧的模型会在创建阶段返回 400（此时还没有计费）。 */
    const first = job.firstFrame !== false ? job.refs[0] : undefined;
    const ref = first ? await ctx.resolveRef(first.src) : null;
    const image = ref ? await imageBytes(ref) : null;
    /* 选了首帧却读不出来时不要悄悄退回纯文生视频，否则成片和用户预期完全无关 */
    if (first && !image) throw new ProviderError('E-PRM-04', '首帧参考图读取失败，未提交生成', '重新拖入图片后再试；本次没有提交，不会扣点');
    ctx.progress(3, '提交到平台…');
    let created: VideoReply;
    if (image) {
      const form = new FormData();
      form.append('model', upstream);
      form.append('prompt', prompt);
      form.append('seconds', seconds);
      form.append('size', size);
      form.append('input_reference', new Blob([image.buf], { type: image.mime }), `first-frame.${image.mime.includes('jpeg') ? 'jpg' : 'png'}`);
      created = await this.deps.accounts().gatewayJson<VideoReply>('/v1/videos', {
        method: 'POST',
        form,
        signal: ctx.signal,
        /* 网关侧对创建请求的超时是 120 秒；比它再宽一点，让网关自己报 504，而不是本地先断开留下未知状态 */
        timeoutMs: 130_000,
      });
    } else {
      created = await this.deps.accounts().gatewayJson<VideoReply>('/v1/videos', {
        method: 'POST',
        json: { model: upstream, prompt, seconds, size },
        signal: ctx.signal,
        timeoutMs: 130_000,
      });
    }
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

/** 参考图可能是本机 data URL，也可能是远程地址；统一取成字节再上传 */
async function imageBytes(ref: { dataUrl: string; mime: string }): Promise<{ buf: Buffer; mime: string } | null> {  const inline = /^data:([^;,]+);base64,(.*)$/.exec(ref.dataUrl);
  if (inline) return { buf: Buffer.from(inline[2], 'base64'), mime: inline[1] };
  if (/^https?:\/\//i.test(ref.dataUrl)) {
    const got = await download(ref.dataUrl);
    return got.buf.length ? got : null;
  }
  return null;
}

/** 上传文件名要带扩展名，按 MIME 生成；未知格式按 png */
function imageExt(mime: string): string {
  const clean = mime.toLowerCase().split(';')[0].trim();
  if (clean === 'image/jpeg' || clean === 'image/jpg') return 'jpg';
  if (clean === 'image/webp') return 'webp';
  if (clean === 'image/gif') return 'gif';
  return 'png';
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
