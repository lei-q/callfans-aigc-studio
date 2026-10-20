import { resoOf, resRank, RESOS } from './constants';
import { round1 } from './format';
import type { Job, JobFail, JobParams, MediaType, ModelInfo } from './types';

/** 单价与预估消耗：和原型同一套算法 */
export function unitPrice(type: MediaType, p: JobParams, m: Pick<ModelInfo, 'price'>) {
  if (type === 'image') return round1(m.price * resoOf(p.res).mul * (p.count || 1));
  if (type === 'video') return round1(m.price * (p.dur || 5));
  if (p.use === 'sfx') return m.price;
  return round1(m.price * Math.max(1, Math.ceil((p.dur || 30) / 30)));
}

/** 发散 / 适配：单个方向的花费，图像按 1 张算 */
export function singleUnitCost(type: MediaType, p: JobParams, m: Pick<ModelInfo, 'price'>) {
  return unitPrice(type, type === 'image' ? { ...p, count: 1 } : p, m);
}

/** 预计耗时：把「要等多久」提前说清楚 */
export function estSeconds(type: MediaType, p: JobParams, m?: Pick<ModelInfo, 'secPer'>) {
  let sec: number;
  if (type === 'image') {
    const per = m?.secPer ?? 40;
    const qmul = p.res === '4k' ? 2.2 : p.res === '1080p' ? 0.7 : 1;
    sec = per * (p.count || 1) * qmul;
  } else if (type === 'video') {
    sec = (m?.secPer ?? 44) * (p.dur || 5);
  } else {
    sec = p.use === 'sfx' ? 10 : Math.round((p.dur || 30) * 1.2);
  }
  return Math.max(5, Math.round(sec / 5) * 5);
}
export function estTimeText(type: MediaType, p: JobParams, m?: Pick<ModelInfo, 'secPer'>) {
  const sec = estSeconds(type, p, m);
  return sec < 60 ? `约 ${sec} 秒` : `约 ${Math.round(sec / 60)} 分钟`;
}

/** 视频时长上限：模型声明的上限，或可选时长里最大的那个 */
export const maxDurOf = (m: ModelInfo) => m.maxDur ?? (m.durs && m.durs.length ? Math.max(...m.durs) : undefined);

/** 参数校验：只认真实的模型约束——分辨率超上限、时长超上限 */
export function validateJob(type: MediaType, p: JobParams, m: ModelInfo, siblings: ModelInfo[]): JobFail | null {
  if (type === 'image' && m.maxRes && resRank(p.res) > resRank(m.maxRes)) {
    const better = siblings.find((x) => x.type === 'image' && x.status === 'on' && x.maxRes && resRank(x.maxRes) >= resRank(p.res));
    const cap = resoOf(m.maxRes);
    return {
      code: 'E-PRM-04',
      reason: `${resoOf(p.res).n}（${resoOf(p.res).px}）超出 ${m.name} 上限 ${cap.n}`,
      fix: better ? `改用 ${better.name}，或降到 ${cap.n}` : `降到 ${cap.n}`,
    };
  }
  const maxDur = type === 'video' ? maxDurOf(m) : undefined;
  if (type === 'video' && maxDur && (p.dur || 0) > maxDur) {
    return {
      code: 'E-DUR-02',
      reason: `时长 ${p.dur}s 超过 ${m.name} 上限 ${maxDur}s`,
      fix: `按时长上限 ${maxDur}s 重试，或拆成两段`,
    };
  }
  return null;
}

/** 按建议修复参数：返回改动摘要，并按新参数重算费用（降档不按失败时的高价收） */
export function applyFix(job: Job, m: ModelInfo): string[] {
  const log: string[] = [];
  if (!job.fail) return log;
  if (job.fail.code === 'E-PRM-04' && m.maxRes) {
    const before = resoOf(job.res).n;
    job.res = m.maxRes;
    log.push(`${before} → ${resoOf(job.res).n}`);
  }
  if (job.fail.code === 'E-DUR-02') {
    const cap = maxDurOf(m);
    const before = job.dur || 0;
    if (cap && before > cap) {
      job.dur = cap;
      log.push(`时长 ${before}s → ${cap}s`);
    }
  }
  job.cost = unitPrice(job.type, job, m);
  /* 任务名不再残留超限标记 */
  job.name = job.name.replace(/（\s*4096\s*）/g, '').replace(/\b4K\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  return log;
}

/** 把比例 + 分辨率换算成像素尺寸，再落到模型支持的尺寸里最接近的一档 */
export function pickImageSize(ratio: string | undefined, res: string | undefined, supported?: string[]): string | undefined {
  const [rw, rh] = (ratio || '1:1').split(':').map(Number);
  const edge = (RESOS.find((x) => x.k === res) || RESOS[1]).edge;
  const ar = rw && rh ? rw / rh : 1;
  const w0 = ar >= 1 ? edge : Math.round(edge * ar);
  const h0 = ar >= 1 ? Math.round(edge / ar) : edge;
  if (!supported || !supported.length) return undefined;
  const parsed = supported
    .map((s) => {
      const m = /^(\d+)x(\d+)$/.exec(s);
      return m ? { s, w: Number(m[1]), h: Number(m[2]) } : null;
    })
    .filter((x): x is { s: string; w: number; h: number } => !!x);
  if (!parsed.length) return undefined;
  let best = parsed[0];
  let bestScore = Infinity;
  for (const c of parsed) {
    const arDiff = Math.abs(Math.log(c.w / c.h / ar));
    const areaDiff = Math.abs(Math.log((c.w * c.h) / (w0 * h0)));
    const score = arDiff * 4 + areaDiff;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best.s;
}

/** 按图像尺寸列表推断分辨率上限 */
export function maxResFromSizes(sizes?: string[]) {
  if (!sizes || !sizes.length) return undefined;
  let edge = 0;
  for (const s of sizes) {
    const m = /^(\d+)x(\d+)$/.exec(s);
    if (m) edge = Math.max(edge, Number(m[1]), Number(m[2]));
  }
  if (!edge) return undefined;
  if (edge <= 1536) return '1080p' as const;
  if (edge <= 3000) return '2k' as const;
  return '4k' as const;
}
