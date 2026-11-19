import type { CanvasItem } from './types';

/* 画布元素的尺寸规则：前端排版和服务端导出画布上下文共用同一份，避免两边算出来不一样 */

export const CVS_W = 168;
export const CVS_W_TEXT = 240;
export const CVS_AR = 0.68;
export const CVS_H_WEB = 96;
export const CVS_H_FILE = 92;
export const CVS_H_POST = 132;
export const CVS_H_NODE = 76;
export const TEXT_H = { sm: 40, md: 64, lg: 96 } as const;

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

/** 常用画幅：像素尺寸最接近哪个就叫哪个（偏差 2% 以内），否则按最简整数比写 */
export const KNOWN_RATIOS: [string, number][] = [
  ['1:1', 1],
  ['4:5', 4 / 5],
  ['3:4', 3 / 4],
  ['9:16', 9 / 16],
  ['2:3', 2 / 3],
  ['16:9', 16 / 9],
  ['4:3', 4 / 3],
  ['3:2', 3 / 2],
  ['21:9', 21 / 9],
];

export function ratioLabel(w: number, h: number): string {
  if (!w || !h) return '1:1';
  const r = w / h;
  const hit = KNOWN_RATIOS.find(([, v]) => Math.abs(v - r) / v < 0.02);
  if (hit) return hit[0];
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(w, h);
  return `${Math.round(w / d)}:${Math.round(h / d)}`;
}
