import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/* ============================================================================
   视频 / 音频编辑的真渲染：调用 ffmpeg 把编辑器里的参数烘进新文件。
   ffmpeg 的位置：环境变量 AIGC_FFMPEG → 安装包自带（resources/bin/ffmpeg）→ 系统 PATH。
   ========================================================================== */

export class RenderError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly detail?: string,
  ) {
    super(message);
  }
}

let cached: string | null | undefined;

/** 找 ffmpeg；找不到返回 null（界面据此给出明确提示，而不是假装保存成功） */
export function findFfmpeg(): string | null {
  if (cached !== undefined) return cached;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    process.env.AIGC_FFMPEG || '',
    /* 安装包：resources/server/server.cjs 旁边的 ../bin */
    path.resolve(__dirname, '..', 'bin', exe),
    path.resolve(__dirname, 'bin', exe),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return (cached = c);
    } catch {
      /* 下一个 */
    }
  }
  /* 系统 PATH：直接试运行一次 */
  const onPath = spawnSyncOk(exe);
  return (cached = onPath ? exe : null);
}

function spawnSyncOk(cmd: string) {
  try {
    return spawnSync(cmd, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** 测试用：重置缓存 */
export function resetFfmpegCache() {
  cached = undefined;
}

interface RunResult {
  code: number | null;
  stderr: string;
}

function run(ffmpeg: string, args: string[], timeoutMs = 10 * 60_000, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    const kill = () => p.kill('SIGKILL');
    const t = setTimeout(() => {
      kill();
      reject(new RenderError('渲染超时', 504, '素材太长或机器太忙，缩短入出点后重试'));
    }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    p.once('error', (e) => {
      clearTimeout(t);
      reject(new RenderError('没能启动 ffmpeg', 500, e.message));
    });
    p.once('close', (code) => {
      clearTimeout(t);
      resolve({ code, stderr });
    });
  });
}

export interface MediaInfo {
  dur: number;
  w: number;
  h: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** ffmpeg 不带 ffprobe：读 `ffmpeg -i` 打印的流信息（无输出文件时退出码非 0，信息仍在 stderr 里） */
export async function probe(ffmpeg: string, input: string): Promise<MediaInfo> {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', input], 30_000);
  return parseInfo(stderr);
}

export function parseInfo(stderr: string): MediaInfo {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const dur = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  const v = /Stream #[^\n]*Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(stderr);
  return {
    dur,
    w: v ? Number(v[1]) : 0,
    h: v ? Number(v[2]) : 0,
    hasVideo: /Stream #[^\n]*Video:/.test(stderr),
    hasAudio: /Stream #[^\n]*Audio:/.test(stderr),
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
const sec = (n: number) => n.toFixed(3);

/** 串行：同时只跑一个渲染，避免把机器吃满 */
let chain: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

function failure(r: RunResult, what: string): RenderError {
  const tail = r.stderr.trim().split('\n').slice(-4).join('\n');
  return new RenderError(`${what}失败`, 500, tail);
}

export interface VideoRenderOps {
  in: number;
  out: number;
  speed: number;
  mute: boolean;
  cover: string;
}

export interface VideoRenderResult {
  /** 渲染后的时长（秒） */
  dur: number;
}

/** atempo 单级只接受 0.5–2；编辑器只给 0.5 / 1 / 1.5 / 2，这里按范围夹住 */
export const tempoOf = (speed: number) => clamp(speed, 0.5, 2);

export function videoArgs(input: string, output: string, ops: VideoRenderOps, info: MediaInfo, captionPng?: string) {
  const total = info.dur;
  const a = clamp(ops.in, 0, Math.max(0, total - 0.1));
  const b = clamp(ops.out, a + 0.1, total || a + 0.1);
  const len = b - a;
  const speed = tempoOf(ops.speed);
  /* 偶数宽高：yuv420p / x264 不接受奇数 */
  const W = Math.max(2, Math.floor(info.w / 2) * 2);
  const args = ['-hide_banner', '-y', '-ss', sec(a), '-t', sec(len), '-i', input];
  if (captionPng) args.push('-i', captionPng);
  const f: string[] = [];
  const base = `[0:v]${speed !== 1 ? `setpts=PTS/${speed},` : ''}scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  if (captionPng) {
    /* 字幕是前端用系统字体画好的透明 PNG：按视频宽度缩放后贴在底部（不依赖 ffmpeg 的 freetype / 字体文件） */
    f.push(`${base}[v0]`, `[1:v]scale=${W}:-1[cap]`, '[v0][cap]overlay=0:H-h-round(H*0.06)[v]');
  } else {
    f.push(`${base}[v]`);
  }
  const withAudio = info.hasAudio && !ops.mute;
  if (withAudio) f.push(speed !== 1 ? `[0:a]atempo=${speed}[a]` : '[0:a]anull[a]');
  args.push('-filter_complex', f.join(';'), '-map', '[v]');
  if (withAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output);
  return { args, dur: len / speed };
}

export async function renderVideo(
  ffmpeg: string,
  input: string,
  output: string,
  coverOut: string,
  ops: VideoRenderOps,
  captionPng?: string,
  signal?: AbortSignal,
): Promise<VideoRenderResult> {
  const info = await probe(ffmpeg, input);
  if (!info.hasVideo) throw new RenderError('这条素材不是视频文件', 400, '模拟产出或链接素材没有可编辑的视频流');
  const { args, dur } = videoArgs(input, output, ops, info, captionPng);
  const r = await run(ffmpeg, args, undefined, signal);
  if (r.code !== 0 || !fs.existsSync(output)) throw failure(r, '视频渲染');
  /* 封面：按编辑器里选的位置从成片里取一帧 */
  const t = ops.cover === '末帧' ? Math.max(0, dur - 0.1) : ops.cover === '中间' ? dur / 2 : 0;
  const c = await run(ffmpeg, ['-hide_banner', '-y', '-ss', sec(t), '-i', output, '-frames:v', '1', '-q:v', '3', coverOut], 60_000, signal);
  if (c.code !== 0 || !fs.existsSync(coverOut)) throw failure(c, '取封面');
  return { dur: Math.round(dur * 10) / 10 };
}

/** 从视频里取一帧存成 jpg */
export async function renderFrame(ffmpeg: string, input: string, output: string, t: number, signal?: AbortSignal) {
  const info = await probe(ffmpeg, input);
  if (!info.hasVideo) throw new RenderError('这条素材不是视频文件', 400, '模拟产出或链接素材没有可取帧的视频流');
  const at = clamp(t, 0, Math.max(0, info.dur - 0.05));
  const r = await run(ffmpeg, ['-hide_banner', '-y', '-ss', sec(at), '-i', input, '-frames:v', '1', '-q:v', '2', output], 60_000, signal);
  if (r.code !== 0 || !fs.existsSync(output)) throw failure(r, '取帧');
  return { w: info.w, h: info.h, t: at };
}

export interface AudioRenderOps {
  in: number;
  out: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  denoise: boolean;
  norm: boolean;
}

/** 输出格式跟着来源走：wav → wav，m4a / aac → m4a，其余 → mp3 */
export function audioFormat(ext: string): { ext: string; codec: string[] } {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (e === 'wav') return { ext: 'wav', codec: ['-c:a', 'pcm_s16le'] };
  if (e === 'm4a' || e === 'aac') return { ext: 'm4a', codec: ['-c:a', 'aac', '-b:a', '192k'] };
  return { ext: 'mp3', codec: ['-c:a', 'libmp3lame', '-q:a', '2'] };
}

export function audioArgs(input: string, output: string, ops: AudioRenderOps, total: number, codec: string[]) {
  const a = clamp(ops.in, 0, Math.max(0, total - 0.1));
  const b = clamp(ops.out, a + 0.1, total || a + 0.1);
  const len = b - a;
  const chain: string[] = [];
  if (ops.denoise) chain.push('afftdn=nf=-25');
  /* 响度标准化放在音量之前：音量滑块是在标准化之后的相对调整，否则两者会互相抵消 */
  if (ops.norm) chain.push('loudnorm=I=-16:TP=-3:LRA=11');
  const vol = clamp(ops.volume, 0, 200) / 100;
  if (vol !== 1) chain.push(`volume=${vol}`);
  const fi = clamp(ops.fadeIn, 0, len / 2);
  const fo = clamp(ops.fadeOut, 0, len / 2);
  if (fi > 0) chain.push(`afade=t=in:st=0:d=${sec(fi)}`);
  if (fo > 0) chain.push(`afade=t=out:st=${sec(len - fo)}:d=${sec(fo)}`);
  const args = ['-hide_banner', '-y', '-ss', sec(a), '-t', sec(len), '-i', input, '-vn'];
  if (chain.length) args.push('-af', chain.join(','));
  /* loudnorm 内部按 192kHz 输出，统一回 44.1kHz */
  args.push('-ar', '44100', ...codec, output);
  return { args, dur: len };
}

export async function renderAudio(ffmpeg: string, input: string, output: string, ops: AudioRenderOps, codec: string[], signal?: AbortSignal) {
  const info = await probe(ffmpeg, input);
  if (!info.hasAudio) throw new RenderError('这条素材没有音轨', 400, '模拟产出或链接素材没有可编辑的音频流');
  const { args, dur } = audioArgs(input, output, ops, info.dur, codec);
  const r = await run(ffmpeg, args, undefined, signal);
  if (r.code !== 0 || !fs.existsSync(output)) throw failure(r, '音频渲染');
  return { dur: Math.round(dur * 10) / 10 };
}
