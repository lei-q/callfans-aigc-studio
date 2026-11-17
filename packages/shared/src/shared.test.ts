import { describe, expect, it } from 'vitest';
import { affordable, dailyFreeLeft } from './wallet';
import { applyFix, estPoints, imageSizeOf, pickImageSize, pickVideoResolution, unitPrice, validateJob, maxResFromSizes, videoResLabel } from './pricing';
import { pointsText } from './format';
import { agentReadBoard } from './agent';
import type { Job, ModelInfo, WalletDto } from './cloud';

const wallet = (): WalletDto => ({ balance: 10, freeToday: 0.5, updatedAt: 0 });

const job = (cost: number, type: Job['type'] = 'image'): Job => ({
  id: 'j1', name: 't', type, ws: 'w1', model: 'm', prompt: 'p', refs: [], cost,
  status: 'queued', createdAt: 0, results: [],
});

const U2: ModelInfo = { id: 'u2', name: 'U2', type: 'image', price: 0.3, basis: '张', status: 'on', channel: 'cloud', maxRes: '2k', note: '', caps: [], limit: '' };
const X1: ModelInfo = { ...U2, id: 'x1', name: 'X1', price: 0.45, maxRes: '4k' };
const C1: ModelInfo = { id: 'c1', name: 'C1', type: 'video', price: 0.8, basis: '秒', status: 'on', channel: 'cloud', durs: [3, 5, 8], note: '', caps: [], limit: '' };
/* 平台渠道的两个模型：标价是美元，实际扣点以账本为准 */
const IMG: ModelInfo = { ...U2, id: 'cloud:img', usageBilling: true, usdPer: 0.025 };
const VID: ModelInfo = { ...C1, id: 'cloud:vid', usageBilling: true, usdPer: 0.04, usdPerByRes: { '720p': 0.025, '1080p': 0.041256 } };

describe('wallet（云端钱包的本地展示计算）', () => {
  it('免费额度与可支付判断', () => {
    const w = wallet();
    expect(dailyFreeLeft(w)).toBe(0.5);
    expect(affordable(w, 10.5)).toBe(true);
    expect(affordable(w, 10.6)).toBe(false);
    expect(affordable(null, 1)).toBe(false);
  });
});

describe('pricing & validation', () => {
  it('图像按张计价，分辨率不再进单价', () => {
    expect(unitPrice('image', { count: 4, res: '2k' }, U2)).toBe(1.2);
    expect(unitPrice('image', { count: 4, res: '1080p' }, U2)).toBe(1.2);
    expect(unitPrice('image', { count: 2, res: '4k' }, X1)).toBe(0.9);
  });
  it('音频按 30 秒向上取整，音效按条', () => {
    const tts = { price: 0.5 };
    expect(unitPrice('audio', { use: 'tts', dur: 15 }, tts)).toBe(0.5);
    expect(unitPrice('audio', { use: 'tts', dur: 60 }, tts)).toBe(1);
    expect(unitPrice('audio', { use: 'sfx', dur: 8 }, { price: 0.1 })).toBe(0.1);
  });
  it('平台渠道：美元标价折成预估点数，按张 / 按秒，便宜模型保留两位', () => {
    /* $0.025/张 → 0.18 点；只留一位会被抹平成 0.2 */
    expect(estPoints('image', { count: 1 }, IMG)).toBe(0.18);
    expect(estPoints('image', { count: 4 }, IMG)).toBe(0.72);
    /* 视频按所选清晰度档位的单价 × 秒数 */
    expect(estPoints('video', { dur: 3, vres: '720p' }, VID)).toBe(0.54);
    expect(estPoints('video', { dur: 3, vres: '1080p' }, VID)).toBe(0.89);
    /* 清单没配价时没有预估，界面只能等平台流水 */
    expect(estPoints('image', { count: 1 }, { ...IMG, usdPer: undefined })).toBeNull();
    /* 自定义渠道按本地价，不走美元换算 */
    expect(estPoints('image', { count: 2 }, U2)).toBe(0.6);
  });
  it('点数展示：最多两位小数且去掉尾零', () => {
    expect(pointsText(0.18)).toBe('0.18');
    expect(pointsText(1.5)).toBe('1.5');
    expect(pointsText(2)).toBe('2');
    expect(pointsText(0.555)).toBe('0.56');
  });
  it('图像尺寸：档位固定长边，比例决定另一边，长宽都是偶数', () => {
    expect(imageSizeOf('1:1', '1080p')).toBe('1080x1080');
    expect(imageSizeOf('16:9', '1080p')).toBe('1080x608');
    expect(imageSizeOf('1:1', '2k')).toBe('2048x2048');
    expect(imageSizeOf('9:16', '2k')).toBe('1152x2048');
    expect(imageSizeOf('4:5', '4k')).toBe('3276x4096');
  });
  it('E-PRM-04：分辨率超过模型上限，并给出可用模型', () => {
    const fail = validateJob('image', { res: '4k', count: 2 }, U2, [U2, X1]);
    expect(fail?.code).toBe('E-PRM-04');
    expect(fail?.fix).toContain('X1');
  });
  it('E-DUR-02：视频时长超过模型上限', () => {
    expect(validateJob('video', { dur: 12 }, C1, [C1])?.code).toBe('E-DUR-02');
    expect(validateJob('video', { dur: 8 }, C1, [C1])).toBeNull();
  });
  it('修复后按新参数重算费用', () => {
    const j: Job = { ...job(1.32), model: 'u2', res: '4k', count: 2, name: '大幅面 4K 2 张' };
    j.fail = validateJob('image', j, U2, [U2, X1])!;
    const log = applyFix(j, U2);
    expect(j.res).toBe('2k');
    expect(j.cost).toBe(0.6);
    expect(log[0]).toBe('4K → 2K');
    expect(j.name).not.toMatch(/4K/);
  });
  it('视频清晰度落到模型支持的档位', () => {
    expect(pickVideoResolution('768p', ['2k', '768p'])).toBe('768p');
    expect(pickVideoResolution('720p', ['2k', '768p'])).toBe('768p');
    expect(pickVideoResolution('720p', ['480p', '1080p'])).toBe('480p');
    expect(pickVideoResolution('1080p', ['2k', '768p'])).toBe('768p');
    expect(pickVideoResolution('4k', ['480p', '1080p'])).toBe('1080p');
    /* 没有档位信息时不擅自改用户的选择 */
    expect(pickVideoResolution('1080p', undefined)).toBe('1080p');
    expect(videoResLabel('2k')).toBe('2K');
    expect(videoResLabel('768p')).toBe('768p');
  });
  it('尺寸落到模型支持的最接近一档', () => {
    expect(pickImageSize('16:9', '2k', ['1024x1024', '1536x1024', '1024x1536'])).toBe('1536x1024');
    expect(pickImageSize('1:1', '2k', undefined)).toBeUndefined();
    expect(maxResFromSizes(['1024x1024', '2048x2048'])).toBe('2k');
  });
});

describe('agent', () => {
  const resolve = (rid: string) =>
    rid === 'r1'
      ? { prompt: '暖橙主色背景，哑光纸杯居中，顶部柔光', type: 'image' as const, ratio: '1:1', res: '2k' as const }
      : rid === 'r2'
        ? { prompt: '暖橙主色背景，可颂平铺，顶部柔光', type: 'image' as const, ratio: '4:5', res: '2k' as const }
        : null;

  it('没有来源时如实说明（prompts 为 0）', () => {
    const r = agentReadBoard({
      items: [{ id: 'a', kind: 'media', type: 'image', t: '本地图', x: 0, y: 0, local: true }],
      links: [], scoped: false, resolve, fallbackType: 'image',
    });
    expect(r.counts.prompts).toBe(0);
    expect(r.guess).toBe('本地图');
  });

  it('主流类型优先，提取高频词，节点文字优先于提示词', () => {
    const r = agentReadBoard({
      items: [
        { id: 'a', kind: 'media', type: 'image', rid: 'r1', x: 0, y: 0 },
        { id: 'b', kind: 'media', type: 'image', rid: 'r2', x: 0, y: 0 },
        { id: 'c', kind: 'media', type: 'video', x: 0, y: 0 },
        { id: 'n', kind: 'node', text: '留白多一点', x: 0, y: 0 },
      ],
      links: [{ id: 'l1', from: 'n', to: 'a', label: '参考' }, { id: 'l2', from: 'b', to: 'a' }],
      scoped: true, resolve, fallbackType: 'video',
    });
    expect(r.mainType).toBe('image');
    expect(r.topWords).toContain('暖橙主色背景');
    expect(r.guess.startsWith('留白多一点')).toBe(true);
    expect(r.draft.startsWith('留白多一点')).toBe(true);
    expect(r.linkLabels).toEqual(['参考']);
    expect(r.hubName).toBe('未命名元素');
  });
});

