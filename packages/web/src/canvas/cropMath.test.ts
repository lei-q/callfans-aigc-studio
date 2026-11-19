import { describe, expect, it } from 'vitest';
import { clampRect, maxRect, ratioNum, resizeRect } from './cropMath';

describe('裁切框几何', () => {
  it('比例解析', () => {
    expect(ratioNum('4:5')).toBeCloseTo(0.8);
    expect(ratioNum('16:9')).toBeCloseTo(16 / 9);
  });

  it('默认框是该比例能放下的最大框，并且居中', () => {
    /* 横图 4000×3000 裁 1:1：高顶满，左右各留 500 */
    expect(maxRect(4000, 3000, 1)).toEqual({ x: 500, y: 0, w: 3000 });
    /* 竖图 3000×4000 裁 16:9：宽顶满，上下居中 */
    const r = maxRect(3000, 4000, 16 / 9);
    expect(r.w).toBe(3000);
    expect(r.x).toBe(0);
    expect(r.y).toBeCloseTo((4000 - 3000 / (16 / 9)) / 2);
    /* 同比例：整张图 */
    expect(maxRect(1600, 900, 16 / 9)).toEqual({ x: 0, y: 0, w: 1600 });
  });

  it('移动不能出图', () => {
    const c = clampRect({ x: -50, y: 9999, w: 1000 }, 4000, 3000, 1);
    expect(c.x).toBe(0);
    expect(c.y).toBe(3000 - 1000);
    const d = clampRect({ x: 3900, y: 0, w: 1000 }, 4000, 3000, 1);
    expect(d.x).toBe(3000);
  });

  it('缩放：左上角不动，宽度到边为止，且比例锁定（高 = 宽 / 比例）', () => {
    const base = { x: 100, y: 100, w: 500 };
    expect(resizeRect(base, 200, 4000, 3000, 0.8)).toEqual({ x: 100, y: 100, w: 700 });
    /* 往大了拖：受右边和下边中更紧的那个限制（这里下边：(3000-100)*0.8=2320，右边 3900） */
    expect(resizeRect(base, 99999, 4000, 3000, 0.8).w).toBeCloseTo(2320);
    /* 往小了拖：不会小到 32px 以下或变负 */
    expect(resizeRect(base, -99999, 4000, 3000, 0.8).w).toBe(32);
  });

  it('极小的图也不会算出 NaN / 负数', () => {
    const c = clampRect({ x: 0, y: 0, w: 5 }, 20, 20, 1);
    expect(c.w).toBeGreaterThan(0);
    expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true);
  });
});
