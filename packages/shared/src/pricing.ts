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
export function singleUnitCost(type: MediaType, p: JobParams, m: Pick<ModelInfo, 'price'> & Partial<ModelInfo>) {
  const q = type === 'image' ? { ...p, count: 1 } : p;
  /* 平台渠道没有本地价（price=0），用清单标价折算的预估；拿不到标价才是 0（界面应显示「按实际用量」） */
  if (m.usageBilling) return estPoints(type, q, m as ModelInfo) ?? 0;
  return unitPrice(type, q, m);
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
    const better = siblings.find((x) => x.type === 'image' && x.status === 'on' && m.maxRes && resRank(x.maxRes!) >= resRank(p.res));
    const cap = resoOf(m.maxRes);
    /* 说清实际会发出去的像素：按比例算完还要吸附到 16 的倍数，和档位标称值不完全相同 */
    const wantPx = imageSizeOf(p.ratio, p.res);
    const capPx = imageSizeOf(p.ratio, m.maxRes);
    return {
      code: 'E-PRM-04',
      reason: `${resoOf(p.res).n}${wantPx ? `（${wantPx.replace('x', ' × ')}）` : ''}超出 ${m.name} 上限 ${cap.n}${capPx ? `（${capPx.replace('x', ' × ')}）` : ''}`,
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

/** 图像 size 的边长约束：上游（gpt-image 等）要求宽高都能被 16 整除 */
const SIZE_STEP = 16;
/** 长边向下吸附：宁可少几像素，也不要超出用户选的档位 */
export const snapLongEdge = (n: number) => Math.max(SIZE_STEP, Math.floor(n / SIZE_STEP) * SIZE_STEP);
/** 短边就近吸附：比例更准，且本来就不承担档位语义 */
export const snapShortEdge = (n: number) => Math.max(SIZE_STEP, Math.round(n / SIZE_STEP) * SIZE_STEP);

/**
 * 图像的最小像素面积：1024 × 900 = 921600。
 * 上游对太小或太扁的尺寸直接拒绝（16:9 的 1080p 只有 1072×608，
 * 面积刚过半），本地先放大到合规，别等上游 400。
 */
export const MIN_IMAGE_AREA = 921_600;

/**
 * 比例 + 分辨率档位 → 平台图像接口的像素尺寸。
 * 平台图像接口没有「档位名」字段，只有 size（如 1024x1536），所以必须自己算。
 * 三条硬约束：
 * - 宽高都要能被 16 整除，否则上游直接 400（`1080x608`、`1920x1080` 都不行）；
 * - 档位固定**长边**（1080 / 2048 / 4096）：2K、4K 这类叫法本就按长边命名，
 *   固定短边会让 9:16 面积翻倍；
 * - 面积不小于 {@link MIN_IMAGE_AREA}：宽画幅（16:9 / 9:16）在 1080p 档位下面积偏小，
 *   按同一比例整体放大到够为止，而不是把尺寸交给上游去拒绝。
 * 吸附都落在 16 的倍数上，比例误差在 1.5% 以内。
 */
export function imageSizeOf(ratio: string | undefined, res: string | undefined): string | undefined {
  const [rw, rh] = (ratio || '1:1').split(':').map(Number);
  if (!rw || !rh) return undefined;
  const long = snapLongEdge((RESOS.find((x) => x.k === res) || RESOS[1]).edge);
  /* 长边固定，短边 = 长边 × 短边比例。横版乘 (h/w)，竖版乘 (w/h)，两种写法都 < 1 */
  const short = snapShortEdge(rw >= rh ? long * (rh / rw) : long * (rw / rh));
  if (long * short >= MIN_IMAGE_AREA) return rw >= rh ? `${long}x${short}` : `${short}x${long}`;

  /* 面积不足：按同一比例整体放大（只放大短边会改变画幅）。
     两个维度都向上取整到 16 的倍数会双双偏大，比例也跟着歪，所以再试一次
     以短边为主、长边按比例补的写法，取比例更准的那个候选。 */
  const scale = Math.sqrt(MIN_IMAGE_AREA / (long * short));
  const up = (n: number) => Math.ceil(n / SIZE_STEP) * SIZE_STEP;
  const candidates: [number, number][] = [];
  /* 候选一：两边同倍率放大 */
  const a = up(long * scale);
  const b = up(short * scale);
  candidates.push([Math.max(a, b), Math.min(a, b)]);
  /* 候选二：长边只按面积需求量补齐，短边取整后再回头修正长边 */
  const a2 = up(MIN_IMAGE_AREA / b);
  candidates.push([Math.max(a2, b), Math.min(a2, b)]);
  /* 候选三：反过来以长边为准 */
  const b3 = up(MIN_IMAGE_AREA / a);
  candidates.push([Math.max(a, b3), Math.min(a, b3)]);

  const [big, small] = pickClosest(candidates, Math.max(rw, rh) / Math.min(rw, rh));
  return rw >= rh ? `${big}x${small}` : `${small}x${big}`;
}

/** 在候选尺寸里挑面积达标、且长宽比最接近目标的一个 */
function pickClosest(candidates: [number, number][], targetAr: number): [number, number] {
  const valid = candidates.filter(([big, small]) => big * small >= MIN_IMAGE_AREA && big % SIZE_STEP === 0 && small % SIZE_STEP === 0);
  if (!valid.length) {
    /* 兜底：按面积硬算一个必然达标的方形，至少不会把非法尺寸交给上游 */
    const edge = Math.ceil(Math.sqrt(MIN_IMAGE_AREA) / SIZE_STEP) * SIZE_STEP;
    return [edge, edge];
  }
  return valid.reduce((best, cur) => {
    const err = (c: [number, number]) => Math.abs(c[0] / c[1] / targetAr - 1);
    return err(cur) < err(best) ? cur : best;
  });
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
