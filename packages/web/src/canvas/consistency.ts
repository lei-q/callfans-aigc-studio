import type { Job } from '@aigc/shared';

/* 一致性检查：只比「声明出来的」参数（模型、画幅、分辨率、负面词、参考图、提示词主干），
   不做像素比对——像素层面的「像不像」要人眼看，这里不假装能判断。纯函数，单测覆盖。 */

export interface CheckItem {
  id: string;
  title: string;
  /** 生成这个素材的任务；本地上传 / 编辑器改出来的没有 */
  job?: Pick<Job, 'model' | 'res' | 'negative' | 'prompt' | 'refs' | 'vres' | 'dur'>;
  ratio?: string;
}

export type CheckLevel = 'ok' | 'warn' | 'info';
export interface CheckLine {
  key: string;
  level: CheckLevel;
  title: string;
  detail: string;
  /** 和多数不一致的素材标题 */
  odd?: string[];
}

/** 取值最多的那个；返回 [多数值, 不同于它的素材] */
function majority<T>(items: CheckItem[], get: (i: CheckItem) => T | undefined): { value: T; odd: CheckItem[]; known: CheckItem[] } | null {
  const known = items.filter((i) => get(i) !== undefined && get(i) !== '');
  if (!known.length) return null;
  const count = new Map<T, number>();
  for (const i of known) count.set(get(i)!, (count.get(get(i)!) || 0) + 1);
  const [value] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  return { value, odd: known.filter((i) => get(i) !== value), known };
}

const bigrams = (s: string) => {
  const t = s.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
export function similarity(a: string, b: string) {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  x.forEach((g) => y.has(g) && n++);
  return n / (x.size + y.size - n);
}

export function checkConsistency(items: CheckItem[]): CheckLine[] {
  const lines: CheckLine[] = [];
  const withJob = items.filter((i) => i.job);
  const noJob = items.length - withJob.length;
  if (noJob) {
    lines.push({
      key: 'nojob',
      level: 'info',
      title: `${noJob} 个素材没有生成记录`,
      detail: '本地上传或编辑器改出来的素材没有模型 / 提示词，只能检查画幅。',
      odd: items.filter((i) => !i.job).map((i) => i.title),
    });
  }

  const simple: { key: string; name: string; get: (i: CheckItem) => string | number | undefined; fmt?: (v: string | number) => string; need?: number }[] = [
    { key: 'model', name: '模型', get: (i) => i.job?.model },
    { key: 'ratio', name: '画幅', get: (i) => i.ratio },
    { key: 'res', name: '分辨率', get: (i) => i.job?.res },
    { key: 'vres', name: '视频清晰度', get: (i) => i.job?.vres },
    { key: 'neg', name: '负面词', get: (i) => (i.job ? (i.job.negative || '').trim() || '（无）' : undefined) },
  ];
  for (const c of simple) {
    const m = majority(items, c.get);
    if (!m || m.known.length < 2) continue;
    if (!m.odd.length) lines.push({ key: c.key, level: 'ok', title: `${c.name}一致`, detail: `${m.known.length} 个都是 ${String(m.value)}` });
    else lines.push({ key: c.key, level: 'warn', title: `${c.name}不一致`, detail: `多数是 ${String(m.value)}，另有 ${m.odd.length} 个不同：${m.odd.map((i) => `${i.title}（${String(c.get(i))}）`).join('、')}`, odd: m.odd.map((i) => i.title) });
  }

  /* 参考图：有没有一张所有素材共用的（风格基准的作用） */
  const refSets = withJob.map((i) => new Set((i.job!.refs || []).map((r) => r.src)));
  if (withJob.length >= 2) {
    const shared = [...(refSets[0] || [])].filter((src) => refSets.every((s) => s.has(src)));
    const none = withJob.filter((_, k) => refSets[k].size === 0);
    if (shared.length) lines.push({ key: 'refs', level: 'ok', title: '共用同一张参考图', detail: `${withJob.length} 个都以同一张图为参考，风格更容易对齐` });
    else
      lines.push({
        key: 'refs',
        level: 'warn',
        title: '没有共用的参考图',
        detail: none.length === withJob.length ? '都没有带参考图，只靠提示词控制风格；想要一致可以设一张「风格基准」。' : '每个素材的参考图都不同，风格可能各走各的。',
        odd: none.map((i) => i.title),
      });
  }

  /* 提示词主干：和第一条（多数）差太多的标出来 */
  if (withJob.length >= 2) {
    const base = withJob[0].job!.prompt;
    const far = withJob.filter((i) => similarity(base, i.job!.prompt) < 0.35);
    if (!far.length) lines.push({ key: 'prompt', level: 'ok', title: '提示词主干接近', detail: '各条提示词描述的是同一类内容' });
    else lines.push({ key: 'prompt', level: 'warn', title: '提示词差异较大', detail: `和「${withJob[0].title}」相比差别很大：${far.map((i) => i.title).join('、')}。如果本来就是不同主题可以忽略。`, odd: far.map((i) => i.title) });
  }

  if (!lines.some((l) => l.level !== 'info') && items.length >= 2) lines.push({ key: 'few', level: 'info', title: '可比较的信息不够', detail: '这些素材缺少模型 / 画幅等声明信息。' });
  return lines;
}
