import { describe, expect, it } from 'vitest';
import { annotPrompt, boxAnnot, brushAnnot, pointAnnot, whereOf } from './annot';

describe('批注改图', () => {
  it('框选：两个对角点无论怎么拖都规整成 x/y/w/h，并夹在 0–1 内', () => {
    const a = boxAnnot(1, 0.8, 0.9, 0.2, 1.4);
    expect(a).toMatchObject({ kind: 'box', x: 0.2, y: 0.9 });
    expect(a.w).toBeCloseTo(0.6);
    expect(a.h).toBeCloseTo(0.1);
  });

  it('涂抹：外接矩形来自轨迹', () => {
    const a = brushAnnot(2, [[0.1, 0.2], [0.3, 0.5], [0.2, 0.9]]);
    expect(a).toMatchObject({ kind: 'brush', x: 0.1, y: 0.2 });
    expect(a.w).toBeCloseTo(0.2);
    expect(a.h).toBeCloseTo(0.7);
    expect(a.pts).toHaveLength(3);
  });

  it('位置用 3×3 宫格说成人话', () => {
    expect(whereOf(boxAnnot(1, 0, 0, 0.2, 0.2))).toContain('画面左上');
    expect(whereOf(boxAnnot(1, 0.4, 0.4, 0.6, 0.6))).toContain('画面中央');
    expect(whereOf(boxAnnot(1, 0.8, 0.4, 1, 0.6))).toContain('画面右侧');
    expect(whereOf(boxAnnot(1, 0.4, 0.8, 0.6, 1))).toContain('画面下方');
    expect(whereOf(pointAnnot(1, 0.9, 0.9))).toBe('画面右下的一个点');
  });

  it('提示词：保持其余不变 + 逐条修改；没写改法的批注不进去；示意图只用来定位', () => {
    const a = boxAnnot(1, 0, 0, 0.3, 0.2);
    a.text = '把外套换成红色';
    const b = pointAnnot(2, 0.5, 0.5);
    b.text = '  ';
    const c = brushAnnot(3, [[0.8, 0.8], [0.9, 0.95]]);
    c.text = '去掉这块污渍';
    const p = annotPrompt([a, b, c], { hasOverlay: true, note: '整体偏暖' });
    expect(p).toContain('保持不变');
    expect(p).toContain('1. 画面左上框出的区域');
    expect(p).toContain('：把外套换成红色');
    expect(p).not.toContain('2. ');
    expect(p).toContain('3. 画面右下涂抹的区域');
    expect(p).toContain('不要把标注画进成图');
    expect(p).toContain('补充：整体偏暖');
    expect(annotPrompt([a], { hasOverlay: false })).not.toContain('参考图 2');
  });
});
