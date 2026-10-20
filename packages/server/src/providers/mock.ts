import type { Channel, Job, ModelInfo } from '@aigc/shared';
import { TYPES } from '@aigc/shared';
import { ASSET_POOL, MOCK_MODELS, sampleSrc, sampleThumb } from './mock-catalog';
import { ProviderError, type Provider, type ProviderOutput, type RunContext } from './types';

/* 演示渠道：不调用真实模型，按原型的节奏模拟进度，用示意素材出片。
   没配 TreeCloud Key 时，用户也能把「生成 → 收件箱 → 画布 → 素材库」整条链路走通。 */
export class MockProvider implements Provider {
  readonly id = 'mock' as const;
  private cursor = { image: 0, video: 0, audio: 0 };

  constructor(
    private readonly prices: () => Record<string, number>,
    private readonly tickMs = 700,
  ) {}

  channel(): Channel {
    return { id: 'mock', name: '演示渠道', note: '本地模拟生成，用示意素材出片，不产生真实费用', kind: 'mock', ready: true };
  }

  models(): ModelInfo[] {
    const prices = this.prices();
    return MOCK_MODELS.map((m) => (prices[m.id] != null ? { ...m, price: prices[m.id] } : m));
  }

  concurrency() {
    return 1;
  }

  async run(job: Job, _model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    const step = job.type === 'image' ? 9 : job.type === 'video' ? 6 : 12;
    let p = 4;
    ctx.progress(p, '生成中…');
    while (p < 100) {
      await sleep(this.tickMs, ctx.signal);
      p = Math.min(100, p + step);
      ctx.progress(p, '生成中…');
    }
    if (/\b(fail|失败测试)\b/i.test(job.prompt)) {
      throw new ProviderError('E-UPS-50', '演示渠道按提示词模拟了一次上游失败', '去掉提示词里的「失败测试」后重试');
    }
    const pool = ASSET_POOL[job.type];
    const n = job.type === 'image' ? job.count || 1 : 1;
    const out: ProviderOutput[] = [];
    for (let i = 0; i < n; i++) {
      const a = pool[this.cursor[job.type] % pool.length];
      this.cursor[job.type] += 1;
      out.push({
        src: sampleSrc(a.f),
        thumb: sampleThumb(a.f),
        simulated: job.type !== 'image',
        title: a.t || `${TYPES[job.type].name}产出`,
        dur: job.type === 'image' ? 0 : job.dur || 5,
      });
    }
    return out;
  }
}

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
