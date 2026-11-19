import { describe, expect, it } from 'vitest';
import { checkConsistency, similarity, type CheckItem } from './consistency';

const job = (over: Partial<NonNullable<CheckItem['job']>> = {}) => ({ model: 'cloud:img-a', res: '2k' as const, negative: '', prompt: '山地徒步，保持羊毛颈套产品与配色，晨光', refs: [{ src: '/files/uploads/anchor.jpg', w: 0.8 }], ...over });
const item = (id: string, over: Partial<CheckItem> = {}): CheckItem => ({ id, title: `图${id}`, job: job(), ratio: '4:5', ...over });
const by = (ls: ReturnType<typeof checkConsistency>, k: string) => ls.find((l) => l.key === k);

describe('一致性检查（声明式）', () => {
  it('全部一致：模型 / 画幅 / 分辨率 / 参考图 / 提示词都是 ok', () => {
    const ls = checkConsistency([item('1'), item('2'), item('3')]);
    for (const k of ['model', 'ratio', 'res', 'refs', 'prompt', 'neg']) expect(by(ls, k)?.level).toBe('ok');
    expect(ls.some((l) => l.level === 'warn')).toBe(false);
  });

  it('不一致的列出是哪几个、取值是什么', () => {
    const ls = checkConsistency([item('1'), item('2'), item('3', { job: job({ model: 'cloud:img-b' }), ratio: '16:9' })]);
    expect(by(ls, 'model')).toMatchObject({ level: 'warn', odd: ['图3'] });
    expect(by(ls, 'model')!.detail).toContain('cloud:img-b');
    expect(by(ls, 'ratio')!.detail).toContain('16:9');
  });

  it('没有共用参考图 → 提醒设风格基准；都没参考图和各用各的说法不同', () => {
    const none = checkConsistency([item('1', { job: job({ refs: [] }) }), item('2', { job: job({ refs: [] }) })]);
    expect(by(none, 'refs')!.detail).toContain('风格基准');
    const diff = checkConsistency([item('1', { job: job({ refs: [{ src: 'a', w: 1 }] }) }), item('2', { job: job({ refs: [{ src: 'b', w: 1 }] }) })]);
    expect(by(diff, 'refs')!.detail).toContain('各走各的');
  });

  it('提示词差太多才警告；相近的不警告', () => {
    expect(similarity('一杯咖啡放在窗边', '一杯咖啡放在窗边的桌上')).toBeGreaterThan(0.5);
    const ls = checkConsistency([item('1'), item('2', { job: job({ prompt: '赛博朋克城市夜景，霓虹雨夜，飞行汽车' }) })]);
    expect(by(ls, 'prompt')).toMatchObject({ level: 'warn', odd: ['图2'] });
  });

  it('没有生成记录的素材：只比画幅，并说明', () => {
    const ls = checkConsistency([item('1'), item('2', { job: undefined })]);
    expect(by(ls, 'nojob')).toMatchObject({ level: 'info', odd: ['图2'] });
    expect(by(ls, 'model')).toBeUndefined();
    expect(by(ls, 'ratio')?.level).toBe('ok');
  });

  it('只有一条可比较信息时不乱下结论', () => {
    const ls = checkConsistency([{ id: '1', title: 'a' }, { id: '2', title: 'b' }]);
    expect(ls.some((l) => l.level === 'ok' || l.level === 'warn')).toBe(false);
    expect(by(ls, 'few')).toBeTruthy();
  });
});
