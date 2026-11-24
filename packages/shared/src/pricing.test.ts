import { describe, expect, it } from 'vitest';
import { singleUnitCost } from './pricing';
import type { JobParams, ModelInfo } from './types';

describe('singleUnitCost：平台渠道不再是 0 点', () => {
  const p = { count: 4, dur: 5 } as JobParams;
  it('平台图片按清单标价折算，且只算 1 张', () => {
    const m = { price: 0, usageBilling: true, usdPer: 0.04 } as ModelInfo;
    expect(singleUnitCost('image', p, m)).toBeCloseTo(0.29, 2);
  });
  it('平台模型没有标价才是 0；本地价照旧', () => {
    expect(singleUnitCost('image', p, { price: 0, usageBilling: true } as ModelInfo)).toBe(0);
    expect(singleUnitCost('image', p, { price: 3 } as ModelInfo)).toBe(3);
  });
});
