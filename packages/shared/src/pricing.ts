import { resoOf, resRank, RESOS, USD_TO_POINTS, VIDEO_DUR_DEF } from './constants';
import { round1, round2 } from './format';
import type { Job, JobFail, JobParams, MediaType, ModelInfo } from './types';

/** 单价与预估消耗：分辨率不再有价格倍率，图像按张、视频按秒 */
export function unitPrice(type: MediaType, p: JobParams, m: Pick<ModelInfo, 'price'>) {
  if (type === 'image') return round1(m.price * (p.count || 1));
  if (type === 'video') return round1(m.price * (p.dur || VIDEO_DUR_DEF));
  if (p.use === 'sfx') return m.price;
  return round1(m.price * Math.max(1, Math.ceil((p.dur || 30) / 30)));
}

/**
 * 平台渠道的预估点数：清单里是美元标价，按 USD_TO_POINTS 折成点。
 * 保留两位小数——便宜模型单张不到 0.2 点，只留一位会把差异抹平。
 * 实际扣点以平台账本为准；拿不到标价时返回 null（界面显示「按实际用量」）。
 */
export function estPoints(type: MediaType, p: JobParams, m: ModelInfo): number | null {
  if (!m.usageBilling) return unitPrice(type, p, m);
  if (type === 'image') {
    if (m.usdPer == null) return null;
    return round2(m.usdPer * USD_TO_POINTS * (p.count || 1));
  }
  if (type === 'video') {
    const tiers = m.usdPerByRes && Object.keys(m.usdPerByRes).length ? m.usdPerByRes : undefined;
    const tier = pickVideoResolution(p.vres, tiers ? Object.keys(tiers) : undefined);
    const per = (tier ? tiers?.[tier] : undefined) ?? m.usdPer;
    if (per == null) return null;
    return round2(per * USD_TO_POINTS * (p.dur || VIDEO_DUR_DEF));
  }
  return null;
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
    sec = (m?.secPer ?? 44) * (p.dur || VIDEO_DUR_DEF);
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

/**
 * 比例 + 分辨率档位 → 平台图像接口的像素尺寸。
 * 平台图像接口没有「档位名」字段，只有 size（如 1024x1536），所以必须自己算。
 * 档位固定的是**长边**（1080 / 2048 / 4096）：2K、4K 这类叫法本来就是按长边命名，
 * 固定短边会让 9:16 的面积翻倍（2K 竖版会到 3640 高），既超出预期也更容易被上游拒绝。
 */
export function imageSizeOf(ratio: string | undefined, res: string | undefined): string | undefined {
  const [rw, rh] = (ratio || '1:1').split(':').map(Number);
  if (!rw || !rh) return undefined;
  const ar = rw / rh;
  const long = (RESOS.find((x) => x.k === res) || RESOS[1]).edge;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return ar >= 1 ? `${even(long)}x${even(long / ar)}` : `${even(long * ar)}x${even(long)}`;
}

/** 视频清晰度换算成短边像素：2K / 4K 在视频里通常按长边命名，这里取常见短边值参与比较 */
const VIDEO_RES_EDGE: Record<string, number> = {
  '480p': 480,
  '720p': 720,
  '768p': 768,
  '1080p': 1080,
  '2k': 1440,
  '4k': 2160,
};

export function videoResEdge(r?: string): number {
  return VIDEO_RES_EDGE[(r || '').toLowerCase()] || 0;
}

/** 界面上展示的清晰度标签：2k → 2K、4k → 4K，其余按小写（480p / 768p） */
export function videoResLabel(r: string): string {
  return /^\d+k$/i.test(r) ? r.toUpperCase() : r.toLowerCase();
}

/**
 * 把用户选的清晰度落到模型支持的档位：有同档就用同档，
 * 否则取短边像素最接近的一档；距离相同时取更低的一档（少扣点）
 */
export function pickVideoResolution(want: string | undefined, tiers: string[] | undefined): string | undefined {
  if (!tiers || !tiers.length) return want;
  if (want) {
    const exact = tiers.find((t) => t.toLowerCase() === want.toLowerCase());
    if (exact) return exact;
  }
  const target = videoResEdge(want) || 720;
  let best = tiers[0];
  let bestDiff = Infinity;
  for (const t of tiers) {
    const edge = videoResEdge(t);
    const diff = Math.abs(edge - target);
    if (diff < bestDiff || (diff === bestDiff && edge < videoResEdge(best))) {
      bestDiff = diff;
      best = t;
    }
  }
  return best;
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
