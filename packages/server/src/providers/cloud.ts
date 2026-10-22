import type { Channel, GatewayJob, GatewayModel, Job, ModelInfo } from '@aigc/shared';
import { CLOUD_ERROR, estSeconds } from '@aigc/shared';
import type { CloudSession } from '../cloud/session';
import { CloudError } from '../cloud/client';
import { abortError, sleep } from './sleep';
import { ProviderError, type ChatMessage, type Provider, type ProviderOutput, type RunContext } from './types';

/* ============================================================================
   云端网关 Provider：生成与对话都走云端（平台持有上游 Key，按真实用量扣点数）。
   客户端只负责提交任务、轮询、把结果媒体下载到本机。
   ========================================================================== */

export function gatewayModelToModelInfo(g: GatewayModel, priceOverride?: number): ModelInfo {
  return {
    id: `cloud:${g.id}`,
    name: g.name,
    type: g.type,
    price: priceOverride ?? g.price,
    basis: g.basis,
    status: 'on',
    channel: 'cloud',
    maxRes: g.maxRes,
    durs: g.durs,
    maxDur: g.durs && g.durs.length ? Math.max(...g.durs) : undefined,
    uses: g.uses,
    note: g.note,
    caps: g.caps,
    limit: g.limit,
    secPer: g.type === 'image' ? 30 : g.type === 'video' ? 30 : undefined,
  };
}

export class CloudProvider implements Provider {
  readonly id = 'cloud' as const;

  constructor(
    private readonly session: () => CloudSession,
    private readonly prices: () => Record<string, number>,
    private readonly concurrencyOf: () => number,
    private readonly pollMs = 3000,
  ) {}

  channel(): Channel {
    const s = this.session();
    return {
      id: 'cloud',
      name: '云端网关',
      note: s.loggedIn
        ? '平台统一接入与计费，按真实用量扣点数'
        : s.client.configured
          ? '登录后即可使用平台点数生成'
          : '在「设置」里配置云端地址后登录使用',
      kind: 'cloud',
      ready: s.loggedIn,
    };
  }

  models(): ModelInfo[] {
    const prices = this.prices();
    return this.session().models.map((g) => gatewayModelToModelInfo(g, prices[`cloud:${g.id}`]));
  }

  concurrency() {
    return Math.max(1, Math.min(8, this.concurrencyOf()));
  }

  private client() {
    return this.session().client;
  }

  private toProviderError(e: unknown): ProviderError {
    if (e instanceof CloudError) {
      if (e.isBalance) return new ProviderError('E-BAL-02', '点数余额不足', '到顶栏账号里用微信 / 支付宝充值');
      if (e.isAuth) return new ProviderError('E-AUTH-01', e.message || '登录已失效', '重新登录后重试');
      if (e.code === CLOUD_ERROR.RATE_LIMITED) return new ProviderError('E-RATE-29', e.message, '稍后重试');
      if (e.code === CLOUD_ERROR.UPSTREAM_FAILED) return new ProviderError('E-UPS-50', e.message, e.requestId ? `带上请求 ID ${e.requestId} 联系支持` : '稍后重试');
      return new ProviderError('E-CLD-50', e.message, '稍后重试；持续失败请检查云端地址与网络');
    }
    return new ProviderError('E-CLD-50', `云端请求失败：${(e as Error).message}`, '检查网络与云端地址');
  }

  async run(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]> {
    const refs: { dataUrl: string; weight?: number }[] = [];
    for (const r of job.refs) {
      const d = await ctx.resolveRef(r.src);
      if (d && d.mime.startsWith('image/')) refs.push({ dataUrl: d.dataUrl, weight: r.w });
    }
    ctx.progress(4, '提交到云端…');
    let gj: GatewayJob;
    try {
      gj = await this.client().request<GatewayJob>('/gateway/jobs', {
        json: {
          type: job.type,
          model: model.id.replace(/^cloud:/, ''),
          prompt: job.prompt,
          negative: job.negative,
          ratio: job.ratio,
          count: job.count,
          res: job.res,
          dur: job.dur,
          cam: job.cam,
          vres: job.vres,
          use: job.use,
          voice: job.voice,
          mood: job.mood,
          lang: job.lang,
          seed: job.seed ? Number(job.seed) : undefined,
          fps: job.fps,
          loop: job.loop,
          firstFrame: job.firstFrame,
          refs: refs.length ? refs : undefined,
          clientJobId: job.id,
        },
        signal: ctx.signal,
        timeoutMs: 60_000,
      });
    } catch (e) {
      if (ctx.signal.aborted) throw abortError();
      throw this.toProviderError(e);
    }
    if (gj.balanceAfter != null) this.session().setWallet({ balance: gj.balanceAfter, freeToday: this.session().wallet?.freeToday || 0, updatedAt: Date.now() });
    job.upstreamTaskId = gj.id;
    ctx.setUpstream(gj.id, gj.requestId);
    return this.poll(job, model, gj.id, ctx);
  }

  async resume(job: Job, model: ModelInfo, ctx: RunContext) {
    if (!job.upstreamTaskId) throw new ProviderError('E-NET-03', '应用退出时请求还没完成，结果未知', '为避免重复扣费不会自动重试；可在任务记录里重跑');
    return this.poll(job, model, job.upstreamTaskId, ctx);
  }

  private async poll(job: Job, model: ModelInfo, id: string, ctx: RunContext): Promise<ProviderOutput[]> {
    const total = estSeconds(job.type, job, model) * 1000;
    const t0 = Date.now();
    for (;;) {
      if (ctx.signal.aborted) throw abortError();
      let gj: GatewayJob;
      try {
        gj = await this.client().request<GatewayJob>(`/gateway/jobs/${encodeURIComponent(id)}`, { signal: ctx.signal, timeoutMs: 20_000 });
      } catch (e) {
        if (ctx.signal.aborted) throw abortError();
        /* 轮询瞬断：任务还在云端跑，等一会儿再查 */
        await sleep(this.pollMs, ctx.signal).catch(() => {
          throw abortError();
        });
        continue;
      }
      if (gj.balanceAfter != null) this.session().setWallet({ balance: gj.balanceAfter, freeToday: this.session().wallet?.freeToday || 0, updatedAt: Date.now() });
      if (gj.status === 'succeeded' && gj.results?.length) {
        ctx.progress(96, '下载结果…');
        const out: ProviderOutput[] = [];
        for (const r of gj.results) {
          const buf = await download(r.url, ctx.signal);
          const saved = await ctx.save(buf, r.mime || 'application/octet-stream');
          let thumb: string | undefined;
          if (r.thumbUrl) {
            const tb = await download(r.thumbUrl, ctx.signal).catch(() => null);
            if (tb) thumb = (await ctx.save(tb, 'image/webp').catch(() => null))?.src;
          }
          out.push({ src: saved.src, thumb, mime: saved.mime, seed: r.seed, dur: r.dur });
        }
        return out;
      }
      if (gj.status === 'succeeded') throw new ProviderError('E-UPS-51', '云端任务成功但没有返回结果', '重跑一次；持续失败请带请求 ID 联系支持');
      if (gj.status === 'failed' || gj.status === 'canceled') {
        const f = gj.fail;
        throw new ProviderError(f?.code || 'E-UPS-54', f?.reason || `云端任务${gj.status === 'canceled' ? '被取消' : '失败'}`, f?.fix || '调整参数后重试');
      }
      const p = gj.status === 'running' ? Math.min(92, Math.max(gj.progress || 8, 8 + Math.round(((Date.now() - t0) / total) * 80))) : 6;
      ctx.progress(p, gj.status === 'running' ? '云端生成中…' : '云端排队中…');
      await sleep(this.pollMs, ctx.signal).catch(() => {
        throw abortError();
      });
    }
  }

  async cancel(job: Job) {
    if (!job.upstreamTaskId) return;
    try {
      const gj = await this.client().request<GatewayJob>(`/gateway/jobs/${encodeURIComponent(job.upstreamTaskId)}`, { method: 'DELETE', timeoutMs: 15_000 });
      if (gj.balanceAfter != null) this.session().setWallet({ balance: gj.balanceAfter, freeToday: this.session().wallet?.freeToday || 0, updatedAt: Date.now() });
    } catch {
      /* 取消是尽力而为 */
    }
  }

  async chat(model: string, messages: ChatMessage[], signal?: AbortSignal) {
    try {
      const r = await this.client().request<{ text: string }>('/gateway/chat', { json: { messages, model: model || undefined }, signal, timeoutMs: 60_000 });
      return r.text;
    } catch (e) {
      throw this.toProviderError(e);
    }
  }
}

async function download(url: string, signal?: AbortSignal) {
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) }).catch((e) => {
    if (signal?.aborted) throw abortError();
    throw new ProviderError('E-NET-04', `结果下载失败：${(e as Error).message}`, '云端媒体地址可能已过期，重跑一次');
  });
  if (!res.ok) throw new ProviderError('E-NET-04', `结果下载失败（HTTP ${res.status}）`, '云端媒体地址可能已过期，重跑一次');
  return Buffer.from(await res.arrayBuffer());
}
