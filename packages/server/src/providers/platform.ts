import type { AudioUse, Channel, Job, ModelInfo } from '@aigc/shared';
import { estSeconds, imageSizeOf, platformGenerationType, pickVideoResolution, VIDEO_DUR_DEF, videoResEdge, VOICES } from '@aigc/shared';
import Jimp from 'jimp';
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
   - 视频：POST /v1/videos（文生视频用 JSON 传 model / prompt / seconds / size / ratio / resolution；
           有首帧时改用 multipart：网关会忽略 ratio / size，所以在本地把首帧裁成目标画幅后
           用 input_reference 上传，resolution 仍照常透传）
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
  /* 平台按分辨率分档计价，pricing 的键就是上游真正支持的清晰度档位 */
  const videoRes =
    type === 'video'
      ? Object.keys(m.pricing?.per_video_second_by_resolution || {}).sort((a, b) => videoResEdge(a) - videoResEdge(b))
      : [];
  const usdPerByRes = type === 'video' ? (m.pricing?.per_video_second_by_resolution ?? undefined) : undefined;
  return {
    id: `cloud:${m.id}`,
    name: m.id,
    type,
    /* 实际扣点由平台按用量结算；这里带上美元标价，界面只用来做预估 */
    price: 0,
    basis: type === 'image' ? '张' : type === 'video' ? '秒' : '字',
    status: 'on',
    channel: 'cloud',
    upstream: m.id,
    secPer: 30,
    usageBilling: true,
    usdPer: type === 'image' ? (m.pricing?.per_image ?? undefined) : type === 'video' ? (m.pricing?.per_video_second ?? undefined) : undefined,
    ...(usdPerByRes && Object.keys(usdPerByRes).length ? { usdPerByRes } : {}),
    note: '平台渠道 · 按平台实际用量扣点',
    caps: m.protocol ? [m.protocol] : [],
    limit: audio ? '单条文案 ≤ 4096 字' : '',
    ...(audio ? { uses: ['tts'] as AudioUse[] } : {}),
    /* 平台目录没有时长清单：时长由用户自定义，不虚构上限与下限（上游可能自行取整） */
    ...(type === 'video' && videoRes.length ? { videoRes } : {}),
  };
}

export function platformMediaModels(models: PlatformModel[]): ModelInfo[] {
  return models.map(platformMediaModelInfo).filter((m): m is ModelInfo => !!m);
}

/** 比例 + 短边像素 → `宽x高`（偶数）；size 与首帧裁切共用这一套换算 */
export function ratioSize(ratio: string | undefined, short: number): string {
  const [rw, rh] = (ratio || '16:9').split(':').map(Number);
  const ar = rw && rh ? rw / rh : 16 / 9;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return ar >= 1 ? `${even(short * ar)}x${short}` : `${short}x${even(short / ar)}`;
}

/** 比例 + 清晰度档位 → 平台视频接口的 size（如 1280x720）；档位决定短边 */
export function videoSize(ratio?: string, vres?: string): string {
  return ratioSize(ratio, videoResEdge(vres) || 720);
}

/**
 * 上游 resolution 的写法：参考协议是 720P / 1080P / 2K（大写 P / K）。
 * 之前按小写 768p 传，MiniMax 之类只认大写档位的上游会忽略这个字段，
 * 画幅和清晰度就一起失效了。
 */
export function videoResolutionParam(tier?: string): string | undefined {
  if (!tier) return undefined;
  return tier.toUpperCase();
}

/**
 * 把首帧参考图统一裁成目标画幅。
 * 上游在「首帧模式」下会跟随输入图片的比例，所以先把参考图裁成用户选的画幅，
 * 让画幅在两种上游行为下都成立。
 * 同时压成 720–1440 短边的 JPEG，避免大 PNG 触发网关 413。
 */
export async function fitFirstFrame(
  image: { buf: Buffer; mime: string },
  ratio: string,
  tier?: string,
): Promise<{ buf: Buffer; mime: string }> {
  /* 尺寸换算与文本请求共用一套公式；首帧再压到 720–1440 短边，避免大图触发网关 413 */
  const short = Math.min(1440, Math.max(720, videoResEdge(tier) || 720));
  const [w, h] = ratioSize(ratio, short).split('x').map(Number);
  if (!w || !h) return image;
  try {
    const img = await Jimp.read(image.buf);
    img.cover(w, h);
    img.quality(85);
    return { buf: await img.getBufferAsync(Jimp.MIME_JPEG), mime: 'image/jpeg' };
  } catch {
    /* 罕见格式（如 WebP）读不了时退回原图：画幅可能不准，但至少不会因为预处理直接失败 */
    return image;
  }
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
      /** 网关说模型没有可用通道：让上层把它暂时从可选列表里拿掉 */
      onModelDown?: (id: string, reason: string) => void;
      /** 同一个模型又能用了 */
      onModelUp?: (id: string) => void;
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

  private toProviderError(e: unknown, model?: ModelInfo): ProviderError {
    if (e instanceof ProviderError) return e;
    if (e instanceof PlatformError) {
      /* 上游 4xx 被网关包成 5xx 时按上游状态归类：参数错误要报参数错误，
         否则用户只会对着「服务暂时不可用」反复重试同一个必然失败的请求。 */
      const status = e.status >= 500 && e.upstreamStatus ? e.upstreamStatus : e.status;
      if (status === 422) return new ProviderError('E-BAL-02', '点数余额不足', '到顶栏账号里用微信 / 支付宝充值');
      if (status === 401) return new ProviderError('E-AUTH-01', e.message || '模型密钥已失效', '重新登录后重试');
      if (status === 429) return new ProviderError('E-RATE-29', e.message, '稍后重试');
      if (status === 400) return new ProviderError('E-PRM-04', e.message, '检查提示词与模型参数后重试');
      if (status === 403) {
        /* 平台把“模型没绑到可用上游”报成 403 GROUP_ROUTING_FAILED；换个模型就能继续，
           所以把原因和下一步说清楚，并让上层把这个模型暂时标成不可用 */
        const noRoute = /GROUP_ROUTING_FAILED|No authorized bound group/i.test(e.message);
        return new ProviderError(
          'E-MOD-06',
          noRoute ? `平台暂时没有为 ${model?.name || '这个模型'} 开通可用通道` : `平台拒绝使用 ${model?.name || '这个模型'}：当前账号没有权限`,
          '换一个模型再试；如果必须用这个模型，请联系平台开通',
        );
      }
      if (e.status === 504 || e.code === 'timeout') return new ProviderError('E-NET-05', e.message, '稍后重试；不要在超时后重复提交');
      return new ProviderError('E-UPS-50', e.message || '平台生成失败', '稍后重试；如果反复失败，换一个模型');
    }
    return new ProviderError('E-UPS-50', `平台生成失败：${(e as Error)?.message || String(e)}`, '稍后重试');
  }

  async run(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    try {
      const out =
        job.type === 'image'
          ? await this.runImage(job, model, ctx)
          : job.type === 'video'
            ? await this.runVideo(job, model, ctx)
            : job.type === 'audio'
              ? await this.runSpeech(job, model, ctx)
              : (() => {
                  throw new ProviderError('E-MOD-05', '平台渠道暂不支持这个类型', '改用图像、视频或配音');
                })();
      this.deps.onModelUp?.(model.id);
      return out;
    } catch (e) {
      if (ctx.signal.aborted) throw abortError();
      const err = this.toProviderError(e, model);
      if (err.code === 'E-MOD-06') this.deps.onModelDown?.(model.id, '平台没有为该模型配置可用通道');
      throw err;
    }
  }

  async resume(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    if (job.type === 'video' && job.upstreamTaskId) {
      try {
        const out = await this.pollVideo(job, model, job.upstreamTaskId, ctx);
        this.deps.onModelUp?.(model.id);
        return out;
      } catch (e) {
        if (ctx.signal.aborted) throw abortError();
        const err = this.toProviderError(e, model);
        if (err.code === 'E-MOD-06') this.deps.onModelDown?.(model.id, '平台没有为该模型配置可用通道');
        throw err;
      }
    }
    throw new ProviderError('E-NET-03', '应用退出时请求还没完成，结果未知', '为避免重复扣费不会自动重试；可在任务记录里重跑');
  }

  private async runImage(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    const upstream = model.upstream || model.id.replace(/^cloud:/, '');
    let prompt = job.prompt.trim();
    /* 尺寸是真实接口字段（size），提示词里再写一遍画幅方便上游理解构图 */
    const size = imageSizeOf(job.ratio, job.res);
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
      /* 编辑接口也带 size：不传时上游按参考图尺寸出图，和用户选的分辨率对不上 */
      const submit = (withSize: boolean) => {
        const form = new FormData();
        form.append('model', upstream);
        form.append('prompt', prompt);
        form.append('n', String(count));
        if (withSize && size) form.append('size', size);
        images.forEach((im, i) => {
          form.append('image[]', new Blob([im.buf], { type: im.mime }), `reference-${i + 1}.${imageExt(im.mime)}`);
        });
        return this.deps.accounts().gatewayJson<ImageReply>('/v1/images/edits', {
          method: 'POST',
          form,
          signal: ctx.signal,
          timeoutMs: 600_000,
        });
      };
      let reply: ImageReply;
      try {
        reply = await submit(true);
      } catch (e) {
        /* 与文生图同一条原则：只有网关在派发前明确拒绝 size 才去掉它重发 */
        if (!size || !isUnsupportedParam(e, 'size')) throw e;
        reply = await submit(false);
      }
      return this.saveImageReply(reply, ctx);
    }

    ctx.progress(6, '提交到平台…');
    /* 不传 response_format：部分上游（如 qwen-image 系列）不支持该参数，LiteLLM 会直接报
       UnsupportedParamsError。默认返回结构里 url / b64_json 两种都已在 saveImageReply 处理。

       size 同理：有的上游不认这个参数。先在提交前报错、没有产生扣费时才去掉它重试一次；
       已经提交过（可能已计费）就绝不再提交。 */
    const body = { model: upstream, prompt, n: count, ...(size ? { size } : {}) };
    let reply: ImageReply;
    try {
      reply = await this.deps.accounts().gatewayJson<ImageReply>('/v1/images/generations', {
        method: 'POST',
        json: body,
        signal: ctx.signal,
        timeoutMs: 600_000,
      });
    } catch (e) {
      if (!size || !isUnsupportedParam(e, 'size')) throw e;
      const { size: _drop, ...rest } = body;
      reply = await this.deps.accounts().gatewayJson<ImageReply>('/v1/images/generations', {
        method: 'POST',
        json: rest,
        signal: ctx.signal,
        timeoutMs: 600_000,
      });
    }
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
    /* 时长是用户自定义的整秒；上游会自行取整或截到自己的档位，这里不做本地猜测 */
    const seconds = String(Math.max(1, Math.round(job.dur || VIDEO_DUR_DEF)));
    const tier = pickVideoResolution(job.vres, model.videoRes);
    const ratio = job.ratio || '16:9';
    /* 画幅与清晰度分开传，且不传 size：
       - 文档 §6.3：同传 size 与 resolution 时以档位为准，而 720P / 1080P / 2K 不含宽高比，
         上游会退回默认 16:9 —— 这正是「选 9:16 出 16:9」的直接原因；
       - 实测画幅丢失时还会随机落到 768x768 / 2560x1440，说明 size 与 resolution 在互相打架。
       按文档 §6.2 的写法只给 `resolution` + `ratio`，两者互补、互不覆盖。 */
    const resolution = tier ? videoResolutionParam(tier) : undefined;
    /* 首帧参考图按平台约定用 multipart 的 input_reference 上传；
       不支持首帧的模型会在创建阶段返回 400（此时还没有计费）。 */
    const first = job.firstFrame !== false ? job.refs[0] : undefined;
    const ref = first ? await ctx.resolveRef(first.src) : null;
    const image = ref ? await imageBytes(ref) : null;
    /* 选了首帧却读不出来时不要悄悄退回纯文生视频，否则成片和用户预期完全无关 */
    if (first && !image) throw new ProviderError('E-PRM-04', '首帧参考图读取失败，未提交生成', '重新拖入图片后再试；本次没有提交，不会扣点');
    ctx.progress(3, '提交到平台…');
    const base: Record<string, string> = {
      model: upstream,
      prompt,
      seconds,
      ratio,
      ...(resolution ? { resolution } : {}),
    };
    let created: VideoReply;
    if (image) {
      /* 首帧模式下上游会跟随参考图比例，所以先按所选画幅裁好再上传，双重保证画幅 */
      const framed = await fitFirstFrame(image, ratio, tier);
      const form = new FormData();
      for (const [k, v] of Object.entries(base)) form.append(k, v);
      form.append('input_reference', new Blob([framed.buf], { type: framed.mime }), 'first-frame.jpg');
      created = await this.deps.accounts().gatewayJson<VideoReply>('/v1/videos', {
        method: 'POST',
        form,
        signal: ctx.signal,
        timeoutMs: 130_000,
      });
    } else {
      /* 纯文生视频走 JSON：multipart 会丢掉 ratio / resolution，只有 JSON 才能按画幅出片。
         不能在这里带 data URL 参考图：该网关只接受 multipart 文件或公网 URL。 */
      created = await this.deps.accounts().gatewayJson<VideoReply>('/v1/videos', {
        method: 'POST',
        json: base,
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

/**
 * 网关是否明确因为「不认识这个参数」拒了请求。
 * 只认这类错误才敢去掉参数重发：400 是网关在派发上游之前做的校验，没有产生扣费；
 * 超时、5xx 等情况可能已经执行，绝不能重发。
 */
function isUnsupportedParam(e: unknown, param: string): boolean {
  if (!(e instanceof PlatformError)) return false;
  /* 网关会把上游的 400 包成 503 返回，此时 status 是 5xx，但上游状态仍是 400。
     两处都看：真正的 5xx（上游真的挂了）不能重发，只有上游明确拒绝参数才行。 */
  const status = e.status >= 500 && e.upstreamStatus ? e.upstreamStatus : e.status;
  if (status !== 400) return false;
  const msg = e.message || '';
  return /unsupported|unrecognized|unknown|invalid|not support/i.test(msg) && new RegExp(param, 'i').test(msg);
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
