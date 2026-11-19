/* 批注改图的数据与提示词：纯函数，单测覆盖；弹层只负责界面 */

export interface Annot {
  id: number;
  kind: 'box' | 'brush' | 'point';
  /** 外接矩形，坐标都是 0–1 的比例（相对整张图） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 涂抹的轨迹（同样是 0–1 比例） */
  pts?: [number, number][];
  /** 这一处想怎么改 */
  text: string;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function boxAnnot(id: number, x1: number, y1: number, x2: number, y2: number): Annot {
  const x = clamp01(Math.min(x1, x2));
  const y = clamp01(Math.min(y1, y2));
  return { id, kind: 'box', x, y, w: clamp01(Math.max(x1, x2)) - x, h: clamp01(Math.max(y1, y2)) - y, text: '' };
}

export function brushAnnot(id: number, pts: [number, number][]): Annot {
  const xs = pts.map((p) => clamp01(p[0]));
  const ys = pts.map((p) => clamp01(p[1]));
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { id, kind: 'brush', x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, pts: pts.map(([a, b]) => [clamp01(a), clamp01(b)]), text: '' };
}

export const pointAnnot = (id: number, x: number, y: number): Annot => ({ id, kind: 'point', x: clamp01(x), y: clamp01(y), w: 0, h: 0, text: '' });

/** 一处批注在画面里的大致位置，用 3×3 宫格说成人话，给模型看 */
export function whereOf(a: Annot): string {
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const col = cx < 1 / 3 ? '左' : cx > 2 / 3 ? '右' : '中';
  const row = cy < 1 / 3 ? '上' : cy > 2 / 3 ? '下' : '中';
  const pos = row === '中' && col === '中' ? '画面中央' : row === '中' ? `画面${col}侧` : col === '中' ? `画面${row}方` : `画面${col}${row}`;
  if (a.kind === 'point') return `${pos}的一个点`;
  const pw = Math.round(a.w * 100);
  const ph = Math.round(a.h * 100);
  return `${pos}${a.kind === 'brush' ? '涂抹的区域' : '框出的区域'}（约占宽 ${pw}% 高 ${ph}%）`;
}

/**
 * 把批注写成给图像模型的修改指令。
 * 参考图 1 是原图，参考图 2 是带编号标注的示意图（红框 / 涂抹 / 圆点 + 编号）。
 */
export function annotPrompt(annots: Annot[], opts: { hasOverlay: boolean; note?: string }): string {
  const list = annots.filter((a) => a.text.trim());
  const lines = list.map((a) => `${a.id}. ${whereOf(a)}：${a.text.trim()}`);
  return [
    '请在参考图 1 的基础上做局部修改，其余部分——构图、光线、色调、人物与产品的细节、画面风格——保持不变。',
    opts.hasOverlay ? '参考图 2 是同一张图加了编号标注的示意（红框、涂抹或圆点标出要改的位置，数字对应下面的编号），只用来定位，不要把标注画进成图。' : '',
    '修改要求：',
    ...lines,
    opts.note?.trim() ? `补充：${opts.note.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
