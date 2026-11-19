/* 裁切框的几何：纯函数，单测覆盖；弹层只负责界面 */

export const CROP_RATIOS: { k: string; note: string }[] = [
  { k: '1:1', note: '方图通用 · 头像 / 商品卡' },
  { k: '4:5', note: '竖版信息流' },
  { k: '3:4', note: '小红书封面' },
  { k: '2:3', note: '竖版海报' },
  { k: '9:16', note: '抖音 / 视频号全屏' },
  { k: '16:9', note: '公众号头图 / 横版视频' },
  { k: '4:3', note: '微博横版' },
  { k: '3:2', note: '摄影横版' },
  { k: '21:9', note: '宽幅 Banner' },
];

export const ratioNum = (k: string) => {
  const [a, b] = k.split(':').map(Number);
  return a / b;
};

export interface CropRect {
  x: number;
  y: number;
  w: number;
}

/** 该比例在图里能放下的最大裁切框，居中 */
export function maxRect(W: number, H: number, r: number): CropRect {
  const w = W / H > r ? H * r : W;
  const h = w / r;
  return { x: (W - w) / 2, y: (H - h) / 2, w };
}

/** 拖动 / 缩放都不能出图；缩放时比例锁定 */
export function clampRect(rc: CropRect, W: number, H: number, r: number): CropRect {
  const maxW = Math.min(W, H * r);
  const w = Math.min(Math.max(rc.w, Math.min(32, maxW)), maxW);
  const h = w / r;
  return { w, x: Math.min(Math.max(rc.x, 0), W - w), y: Math.min(Math.max(rc.y, 0), H - h) };
}

/** 缩放：左上角不动，宽度变；放大到顶到边为止 */
export function resizeRect(rc: CropRect, dw: number, W: number, H: number, r: number): CropRect {
  const limit = Math.min(W - rc.x, (H - rc.y) * r);
  const w = Math.min(Math.max(rc.w + dw, Math.min(32, limit)), limit);
  return { ...rc, w };
}

