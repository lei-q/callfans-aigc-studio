import type { CanvasItem, CanvasView } from '@aigc/shared';

/* 画布几何：尺寸、包围盒、连线曲线。和原型同一套常量 */

export const CVS_W = 168;
export const CVS_W_TEXT = 240;
export const TEXT_MAX_W = 420;
export const CVS_W_MIN = 64;
export const CVS_W_MAX = 720;
export const CVS_AR = 0.68;
export const CVS_K_MIN = 0.35;
export const CVS_K_MAX = 2.6;
export const CVS_H_WEB = 96;
export const CVS_H_FILE = 92;
export const CVS_H_POST = 132;
export const CVS_H_NODE = 76;
export const TEXT_H = { sm: 40, md: 64, lg: 96 } as const;
export const TEXT_SIZE_NAME = { sm: '小（备注）', md: '中（正文）', lg: '大（标题）' } as const;

export const cvsItemW = (i: CanvasItem) => Math.round(i.w || (i.kind === 'text' ? CVS_W_TEXT : CVS_W));
export const cvsItemAR = (i: CanvasItem) => i.ar || CVS_AR;
export function cvsItemH(i: CanvasItem) {
  if (i.kind === 'web') return CVS_H_WEB + (i.cover ? 76 : 0);
  if (i.kind === 'post') return CVS_H_POST + (i.cover ? 76 : 0);
  if (i.kind === 'file') return CVS_H_FILE;
  if (i.kind === 'draw') return Math.max(24, i.h || 60);
  if (i.kind === 'group') return Math.max(120, i.h || 260);
  if (i.kind === 'node') return Math.max(44, i.h || CVS_H_NODE);
  if (i.kind === 'text') return Math.max(30, i.h || TEXT_H[i.size || 'md'] || TEXT_H.md);
  return Math.round(cvsItemW(i) * cvsItemAR(i)) + 2;
}

/** 元素层级：z 越大越靠上，未设置时按数组顺序 */
export const cvsZ = (i: CanvasItem, idx: number) => (i.z != null ? i.z : 100 + idx);
/** 分组永远垫在最底层，不遮元素 */
export const cvsLayer = (i: CanvasItem, idx: number) => (i.kind === 'group' ? -1000 + (cvsZ(i, idx) % 500) : cvsZ(i, idx));

export function cvsBounds(list: CanvasItem[]) {
  if (!list.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const i of list) {
    x1 = Math.min(x1, i.x);
    y1 = Math.min(y1, i.y);
    x2 = Math.max(x2, i.x + cvsItemW(i));
    y2 = Math.max(y2, i.y + cvsItemH(i));
  }
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

export const inGroup = (it: CanvasItem, g: CanvasItem) =>
  it.x + cvsItemW(it) > g.x && it.x < g.x + cvsItemW(g) && it.y + cvsItemH(it) > g.y && it.y < g.y + cvsItemH(g);

export const cvsCenter = (i: CanvasItem, pos?: { x: number; y: number }) => ({
  x: (pos?.x ?? i.x) + cvsItemW(i) / 2,
  y: (pos?.y ?? i.y) + cvsItemH(i) / 2,
});

/** 二次贝塞尔：控制点向法线方向偏一点，线不会和元素边重合 */
export function linkPath(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(56, len * 0.16);
  const nx = -dy / len;
  const ny = dx / len;
  return `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2 + nx * off} ${(a.y + b.y) / 2 + ny * off} ${b.x} ${b.y}`;
}

/** 二次贝塞尔在 t=0.5 的位置 */
export function linkMid(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(56, len * 0.16);
  const cx = (a.x + b.x) / 2 + (-dy / len) * off;
  const cy = (a.y + b.y) / 2 + (dx / len) * off;
  return { x: 0.25 * a.x + 0.5 * cx + 0.25 * b.x, y: 0.25 * a.y + 0.5 * cy + 0.25 * b.y };
}

export function cvsTransform(i: CanvasItem) {
  const parts: string[] = [];
  if (i.rot) parts.push(`rotate(${i.rot}deg)`);
  if (i.flipH || i.flipV) parts.push(`scale(${i.flipH ? -1 : 1}, ${i.flipV ? -1 : 1})`);
  return parts.join(' ');
}

export const gridStyle = (v: CanvasView) => ({
  backgroundSize: `${26 * v.k}px ${26 * v.k}px, ${26 * v.k}px ${26 * v.k}px, ${130 * v.k}px ${130 * v.k}px, ${130 * v.k}px ${130 * v.k}px`,
  backgroundPosition: `${v.x}px ${v.y}px`,
});

/** 屏幕坐标 → 世界坐标 */
export const toWorld = (v: CanvasView, rect: DOMRect, cx: number, cy: number) => ({
  x: (cx - rect.left - v.x) / v.k,
  y: (cy - rect.top - v.y) / v.k,
});
