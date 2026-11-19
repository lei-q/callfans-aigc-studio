import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Result } from '@aigc/shared';
import { uid } from '@aigc/shared';
import type { Core } from './core';
import { mimeOfExt } from './core';
import { HttpError } from './runner';
import { findTool, requireTool, runTool, ToolMissing, type RunHandle } from './tools';

/* ============================================================================
   依赖外部工具的长任务：链接下载视频（yt-dlp）、语音转文字（whisper）。
   任务在内存里，界面轮询；没有工具时由路由层返回 501 + 安装指引，不静默失败。
   ========================================================================== */

export type TaskStatus = 'running' | 'done' | 'failed' | 'canceled';
export interface Task<R = unknown> {
  id: string;
  kind: 'download' | 'transcribe';
  status: TaskStatus;
  progress: number;
  stage: string;
  error?: string;
  result?: R;
  createdAt: number;
}

interface Live<R> extends Task<R> {
  handles: RunHandle[];
  cleanup: string[];
}

export class TaskBook {
  private map = new Map<string, Live<unknown>>();

  create<R>(kind: Task['kind'], stage: string): Live<R> {
    const t: Live<R> = { id: uid('t'), kind, status: 'running', progress: 0, stage, createdAt: Date.now(), handles: [], cleanup: [] };
    this.map.set(t.id, t as Live<unknown>);
    for (const [id, o] of this.map) if (o.status !== 'running' && Date.now() - o.createdAt > 3600_000) this.map.delete(id);
    return t;
  }
  get(id: string) {
    return this.map.get(id);
  }
  view(id: string): Task | null {
    const t = this.map.get(id);
    if (!t) return null;
    const { handles: _h, cleanup: _c, ...pub } = t;
    return pub;
  }
  cancel(id: string) {
    const t = this.map.get(id);
    if (!t || t.status !== 'running') return false;
    t.status = 'canceled';
    t.stage = '已取消';
    t.handles.forEach((h) => h.kill());
    return true;
  }
  stopAll() {
    for (const id of this.map.keys()) this.cancel(id);
  }
}

const rm = (p: string) => fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});

/* ---------------- 链接下载 ---------------- */

/** 只放行 http(s)；回环 / 链路本地地址（含云元数据 169.254.*）一律拒绝，免得被拿来探本机服务 */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, '不是有效的链接');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, '只支持 http / https 链接');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1' || /^127\./.test(h) || /^169\.254\./.test(h) || /^fe80:/.test(h)) {
    throw new HttpError(400, '不支持本机 / 链路本地地址');
  }
  return u;
}

export interface ProbeReply {
  title: string;
  duration: number | null;
  uploader: string | null;
  thumbnail: string | null;
  site: string | null;
}

export async function probeLink(url: string): Promise<ProbeReply> {
  const u = checkUrl(url);
  const bin = requireTool('ytdlp');
  const r = await runTool(bin, ['--dump-single-json', '--no-playlist', '--no-warnings', '--', u.toString()], { timeoutMs: 60_000 }).done;
  if (r.code !== 0) throw new HttpError(502, '解析不了这个链接', lastLine(r.stderr) || '链接可能需要登录、已失效，或这个网站暂不支持');
  try {
    const j = JSON.parse(r.stdout) as { title?: string; duration?: number; uploader?: string; thumbnail?: string; extractor_key?: string };
    return { title: j.title || u.hostname, duration: j.duration ?? null, uploader: j.uploader ?? null, thumbnail: j.thumbnail ?? null, site: j.extractor_key ?? null };
  } catch {
    throw new HttpError(502, '解析结果读不懂', '把 yt-dlp 升级到最新版再试');
  }
}

const lastLine = (s: string) => s.trim().split('\n').filter(Boolean).slice(-1)[0]?.replace(/^ERROR:\s*/, '') || '';

export interface DownloadResult {
  result: Result;
}

export function startDownload(core: Core, book: TaskBook, body: { url: string; ws: string; title?: string }) {
  const u = checkUrl(body.url);
  if (!core.store.projects.get(body.ws)) throw new HttpError(404, '项目不存在');
  const bin = requireTool('ytdlp');
  const out = core.newMediaFile('mp4');
  const task = book.create<DownloadResult>('download', '连接中…');
  const ffmpeg = findTool('ffmpeg');
  const args = [
    '-f', 'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '--no-playlist', '--no-warnings', '--newline',
    '--max-filesize', '2G',
    ...(ffmpeg ? ['--ffmpeg-location', ffmpeg] : []),
    '-o', out.file,
    '--', u.toString(),
  ];
  const h = runTool(bin, args, {
    onLine: (line) => {
      const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
      if (m && task.status === 'running') {
        task.progress = Math.min(99, Number(m[1]));
        task.stage = '下载中…';
      } else if (/\[Merger\]|\[ffmpeg\]/.test(line)) task.stage = '合并音视频…';
    },
  });
  task.handles.push(h);
  task.cleanup.push(out.file);
  void h.done
    .then(async (r) => {
      if (task.status === 'canceled') return void (await rm(out.file));
      if (r.code !== 0 || !fs.existsSync(out.file)) {
        task.status = 'failed';
        task.error = lastLine(r.stderr) || '下载失败';
        return void (await rm(out.file));
      }
      const info = ffmpeg ? await import('./render').then((m) => m.probe(ffmpeg, out.file)).catch(() => null) : null;
      const ratio = info?.w && info.h ? (await import('@aigc/shared')).ratioLabel(info.w, info.h) : '16:9';
      const res: Result = {
        id: uid('r'),
        job: null,
        type: 'video',
        ws: body.ws,
        title: (body.title || u.hostname).slice(0, 80),
        src: out.src,
        mime: mimeOfExt('.mp4'),
        ratio,
        model: 'local',
        seed: Math.floor(Math.random() * 90000),
        createdAt: Date.now(),
        status: 'new',
        tags: ['链接下载'],
        dur: Math.round(info?.dur || 0),
        home: 'canvas',
      };
      core.store.results.put(res);
      core.events.emit({ type: 'result', result: res });
      task.result = { result: res };
      task.progress = 100;
      task.stage = '完成';
      task.status = 'done';
    })
    .catch(async (e: Error) => {
      task.status = task.status === 'canceled' ? 'canceled' : 'failed';
      task.error = e.message;
      await rm(out.file);
    });
  return task;
}

/* ---------------- 转写 ---------------- */

export interface Segment {
  start: number;
  end: number;
  text: string;
}
export interface TranscribeResult {
  text: string;
  language: string | null;
  segments: Segment[];
  srt: string;
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
export function srtTime(t: number) {
  const ms = Math.round((t % 1) * 1000);
  const s = Math.floor(t);
  const carry = ms === 1000 ? 1 : 0;
  return `${pad((s + carry) / 3600)}:${pad(((s + carry) % 3600) / 60)}:${pad((s + carry) % 60)},${pad(ms === 1000 ? 0 : ms, 3)}`;
}
export const toSrt = (segs: Segment[]) => segs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.trim()}\n`).join('\n');

/** openai-whisper 的 json 输出 → 统一结构 */
export function parseWhisperJson(raw: string): TranscribeResult {
  const j = JSON.parse(raw) as { text?: string; language?: string; segments?: { start: number; end: number; text: string }[] };
  const segments = (j.segments || []).map((s) => ({ start: s.start, end: s.end, text: String(s.text || '').trim() })).filter((s) => s.text);
  const text = (j.text || segments.map((s) => s.text).join('\n')).trim();
  return { text, language: j.language ?? null, segments, srt: toSrt(segments) };
}

export function startTranscribe(core: Core, book: TaskBook, body: { sourceId: string; language?: string }) {
  const src = core.store.results.get(body.sourceId);
  if (!src) throw new HttpError(404, '原素材不存在');
  if (src.type === 'image') throw new HttpError(400, '图片没有声音可转写');
  const file = core.localPathOf(src.src);
  if (!file || !fs.existsSync(file)) throw new HttpError(400, '原素材文件不存在', '只有本机文件才能转写；链接素材请先下载到本地');
  const whisper = requireTool('whisper');
  const ffmpeg = requireTool('ffmpeg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-asr-'));
  const wav = path.join(dir, 'audio.wav');
  const task = book.create<TranscribeResult>('transcribe', '提取音轨…');
  task.cleanup.push(dir);
  const model = process.env.AIGC_WHISPER_MODEL || 'small';
  void (async () => {
    const ex = runTool(ffmpeg, ['-hide_banner', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav], { timeoutMs: 10 * 60_000 });
    task.handles.push(ex);
    const e = await ex.done;
    if (task.status !== 'running') return;
    if (e.code !== 0 || !fs.existsSync(wav)) throw new Error('这个文件没有可用的音轨');
    task.progress = 15;
    task.stage = `转写中（模型 ${model}，首次使用会先下载模型）…`;
    const asr = runTool(
      whisper,
      [wav, '--model', model, '--output_format', 'json', '--output_dir', dir, '--fp16', 'False', ...(body.language ? ['--language', body.language] : [])],
      { timeoutMs: 40 * 60_000, onLine: () => void (task.progress = Math.min(90, task.progress + 1)) },
    );
    task.handles.push(asr);
    const r = await asr.done;
    if (task.status !== 'running') return;
    const out = path.join(dir, 'audio.json');
    if (r.code !== 0 || !fs.existsSync(out)) throw new Error(lastLine(r.stderr) || 'whisper 没有产出结果');
    task.result = parseWhisperJson(fs.readFileSync(out, 'utf8'));
    task.progress = 100;
    task.stage = '完成';
    task.status = 'done';
  })()
    .catch((e: Error) => {
      if (task.status === 'running') {
        task.status = 'failed';
        task.error = e.message;
      }
    })
    .finally(() => void rm(dir));
  return task;
}

export { ToolMissing };
