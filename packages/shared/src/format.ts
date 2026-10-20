import { MOODS, VOICES, resoOf } from './constants';
import type { Job, JobParams, MediaType } from './types';

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** 确定性伪随机：同一种子得到同一波形 */
export function seededSeries(seed: number, n: number, min: number, max: number) {
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x = (x * 16807) % 2147483647;
    out.push(min + (x / 2147483647) * (max - min));
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** 今天只显示时分，昨天带「昨天」，更早带日期 */
export function timeLabel(ts: number, now = Date.now()) {
  if (!ts) return '';
  const k = dayKey(ts);
  if (k === dayKey(now)) return hhmm(ts);
  if (k === dayKey(now - 86400000)) return `昨天 ${hhmm(ts)}`;
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(ts)}`;
}
export const isToday = (ts: number, now = Date.now()) => dayKey(ts) === dayKey(now);

export function durationText(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${pad(s % 60)} 秒`;
}

export const humanSize = (n?: number) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export const voiceName = (k?: string) => (VOICES.find((x) => x.k === k) || VOICES[0]).n;
export const moodName = (k?: string) => (MOODS.find((x) => x.k === k) || MOODS[0]).n;
export const useName = (u?: string) => (u === 'music' ? '音乐' : u === 'sfx' ? '音效' : '配音');

/** 参数一句话摘要：任务行、参数浮层共用 */
export function paramsBrief(j: Pick<Job, 'type'> & JobParams) {
  if (j.type === 'image') return `${j.ratio} · ${j.count} 张 · ${resoOf(j.res).n}`;
  if (j.type === 'video') return `${j.ratio} · ${j.dur}s · ${j.cam || '固定'}`;
  const v = j.use === 'tts' ? voiceName(j.voice) : j.use === 'music' ? moodName(j.mood) : '短音效';
  return `${useName(j.use)} · ${j.dur}s · ${v}`;
}

export function agentParamText(type: MediaType, p: JobParams) {
  if (type === 'image') return `${p.ratio} · ${p.count} 张 · ${resoOf(p.res).n}`;
  if (type === 'video') return `${p.ratio} · ${p.dur} 秒 · ${p.cam}`;
  return `${p.dur} 秒 · ${useName(p.use)}`;
}

/** 新产出的差异标签：一眼看出两张结果差在哪 */
export function resultTags(job: Job) {
  const hasRefs = job.refs && job.refs.length > 0;
  if (job.type === 'image') return [resoOf(job.res).n, hasRefs ? '参考图生成' : '纯文生'];
  if (job.type === 'video') return [job.cam || '固定', hasRefs && job.firstFrame !== false ? '首帧参考' : '纯文生'];
  if (job.use === 'tts') {
    const v = voiceName(job.voice);
    return ['配音', v.split(' · ')[1] || v];
  }
  if (job.use === 'music') return ['音乐', moodName(job.mood)];
  return ['音效', '短音效'];
}

export const promptBrief = (p: string, n = 44) => (p.length > n ? `${p.slice(0, n)}…` : p);

/** 生成短 id：时间 + 随机，避免恢复的数据和新建的撞 id */
export function uid(prefix: string) {
  const t = Date.now().toString(36).slice(-5);
  const r = Math.random().toString(36).slice(2, 7);
  return `${prefix}${t}${r}`;
}
