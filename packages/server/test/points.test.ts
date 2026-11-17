import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Core } from '../src/core';
import { settlePoints } from '../src/points';

/* 点数对账：任务的实际消耗来自账号流水的 litellm usage 条目。
   这里只测匹配与幂等，不发真实请求。 */

const cores: Core[] = [];
afterEach(() => {
  while (cores.length) cores.pop()!.close();
});

async function makeCore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-points-'));
  const core = await Core.create({
    dataDir,
    mode: 'web',
    desktop: false,
    version: 'test',
    memory: true,
    account: { provider: 'fastsso', apiBase: 'http://account.test/api/v1', gatewayBase: 'http://gw.test' },
  });
  cores.push(core);
  core.accounts.status = 'logged_in';
  (core.accounts as unknown as { tokens: unknown }).tokens = {
    accessToken: 'at-test',
    refreshToken: 'rt-test',
    expiresAt: Date.now() + 3600_000,
  };
  core.accounts.profile = { id: 'u1', nickname: '测试', createdAt: Date.now() };
  /* 模型目录用清单形状直接给出来，不依赖网关请求 */
  vi.spyOn(core, 'models').mockReturnValue([
    {
      id: 'cloud:gemini-3.1-flash-image',
      name: 'gemini-3.1-flash-image',
      type: 'image',
      price: 0,
      basis: '张',
      status: 'on',
      channel: 'cloud',
      upstream: 'gemini-3.1-flash-image',
      usageBilling: true,
      note: '',
      caps: [],
      limit: '',
    },
  ]);
  return core;
}

/** 建一条模型已跑完、但还没对上流水的平台任务 */
function fakeJob(core: Core, opts: { startedAt: number; finishedAt: number; status?: 'succeeded' | 'failed'; cost?: number }) {
  const job = {
    id: `j${Math.random().toString(36).slice(2, 8)}`,
    name: 't',
    type: 'image' as const,
    ws: 'w1',
    model: 'cloud:gemini-3.1-flash-image',
    prompt: '海报',
    refs: [],
    cost: 0,
    usageBilling: true,
    pointsEst: 1.2,
    status: opts.status ?? ('succeeded' as const),
    createdAt: opts.startedAt,
    startedAt: opts.startedAt,
    runStartedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
    results: [],
    upstreamTaskId: 'task-1',
  };
  core.store.jobs.put(job as never);
  return job;
}

const usage = (id: string, at: number, micro: number) => ({
  entryId: id,
  amountMicro: micro,
  direction: 'debit' as const,
  reason: 'litellm usage',
  occurredAt: new Date(at).toISOString(),
});

describe('平台点数对账', () => {
  it('把流水里的扣点对到任务上，一条流水只记一次', async () => {
    const core = await makeCore();
    const now = Date.now();
    const a = fakeJob(core, { startedAt: now - 60_000, finishedAt: now - 30_000 });
    const ledger = vi.spyOn(core.accounts, 'ledger').mockResolvedValue([
      usage('e1', now - 40_000, 1_800_000),
      usage('e2', now - 10_000, 900_000),
    ]);

    const changed = await settlePoints(core);
    expect(changed.map((j) => j.id)).toContain(a.id);
    expect(core.store.jobs.get(a.id)!.pointsSpent).toBe(1.8);
    expect(core.store.jobs.get(a.id)!.ledgerEntryIds).toEqual(['e1']);

    /* 再对一次：这次运行已结算，不再拉流水 */
    const again = await settlePoints(core);
    expect(again).toHaveLength(0);
    expect(ledger).toHaveBeenCalledTimes(1);
    expect(core.store.jobs.get(a.id)!.settledRunAt).toBe(core.store.jobs.get(a.id)!.runStartedAt);
  });

  it('流水还没回来时标成待结算，且不把消耗当成 0', async () => {
    const core = await makeCore();
    const now = Date.now();
    const a = fakeJob(core, { startedAt: now - 5_000, finishedAt: now - 1_000 });
    vi.spyOn(core.accounts, 'ledger').mockResolvedValue([]);

    await settlePoints(core);
    const got = core.store.jobs.get(a.id)!;
    expect(got.pointsSpent).toBeUndefined();
    expect(got.pointsNote).toContain('尚未返回');
    expect(got.pointsEst).toBe(1.2);
  });

  it('失败任务也会对账：平台创建成功即计费，失败不退', async () => {
    const core = await makeCore();
    const now = Date.now();
    const a = fakeJob(core, { startedAt: now - 60_000, finishedAt: now - 20_000, status: 'failed' });
    vi.spyOn(core.accounts, 'ledger').mockResolvedValue([usage('e9', now - 30_000, 2_500_000)]);
    await settlePoints(core);
    expect(core.store.jobs.get(a.id)!.pointsSpent).toBe(2.5);
  });

  it('重跑是另一次运行：新流水累加到同一个任务的消耗上', async () => {
    const core = await makeCore();
    const now = Date.now();
    const a = fakeJob(core, { startedAt: now - 120_000, finishedAt: now - 100_000 });
    const ledger = vi.spyOn(core.accounts, 'ledger');
    ledger.mockResolvedValue([usage('e1', now - 110_000, 1_000_000)]);
    await settlePoints(core);
    expect(core.store.jobs.get(a.id)!.pointsSpent).toBe(1);

    /* 用户在任务记录里重跑了：runStartedAt 刷新，结算标记失效 */
    const job = core.store.jobs.get(a.id)!;
    job.runStartedAt = now - 30_000;
    job.startedAt = now - 30_000;
    job.finishedAt = now - 10_000;
    job.status = 'succeeded';
    core.store.jobs.put(job);

    ledger.mockResolvedValue([usage('e1', now - 110_000, 1_000_000), usage('e2', now - 20_000, 1_500_000)]);
    const changed = await settlePoints(core);
    expect(changed.map((j) => j.id)).toContain(a.id);
    const after = core.store.jobs.get(a.id)!;
    expect(after.pointsSpent).toBe(2.5);
    expect(after.ledgerEntryIds).toEqual(['e1', 'e2']);
    expect(after.settledRunAt).toBe(job.runStartedAt);
  });

  it('充值等非模型调用流水不参与对账', async () => {
    const core = await makeCore();
    const now = Date.now();
    const a = fakeJob(core, { startedAt: now - 60_000, finishedAt: now - 30_000 });
    vi.spyOn(core.accounts, 'ledger').mockResolvedValue([
      { entryId: 'c1', amountMicro: 50_000_000, direction: 'credit' as const, reason: 'recharge CREDIT_50', occurredAt: new Date(now - 45_000).toISOString() },
    ]);
    await settlePoints(core);
    expect(core.store.jobs.get(a.id)!.pointsSpent).toBeUndefined();
  });

  it('未登录时不发请求', async () => {
    const core = await makeCore();
    core.accounts.status = 'logged_out';
    (core.accounts as unknown as { tokens: unknown }).tokens = null;
    const ledger = vi.spyOn(core.accounts, 'ledger');
    expect(await settlePoints(core)).toEqual([]);
    expect(ledger).not.toHaveBeenCalled();
  });
});