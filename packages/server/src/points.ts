import type { Job } from '@aigc/shared';
import { microToPoints } from './account/consumer';
import type { FssLedgerEntry } from './account/consumer';
import type { Core } from './core';

/* ============================================================================
   平台渠道的点数对账：每个任务实际花了多少点，唯一权威是账号流水。

   账号服务把模型调用的扣点写成 `reason = litellm usage` 的 debit 流水条目；
   这里把「跑完但还没对上流水」的任务按时间窗与流水条目匹配：
   - 每次运行单独结算：重跑是另一次运行，会再记一笔，累计到 pointsSpent；
   - 一条流水只能被认领一次（ledgerEntryIds 记着已经用过的条目）；
   - 流水有延迟，没对上就留空并标「待结算」，之后再补；
   - Mock 云没有这套流水，走网关返回的 cost 字段，不经过这里。
   ========================================================================== */

/** 流水可能比任务完成晚几秒到几十秒：把任务开始前的宽限算进去 */
const LEDGER_LOOKBACK_MS = 5 * 60_000;
/** 时间窗右端留一点余量，容忍时钟偏差 */
const MATCH_SLACK_MS = 3 * 60_000;
const PENDING_NOTE = '平台流水尚未返回，稍后自动对账';

const isUsage = (e: FssLedgerEntry) => e.direction === 'debit' && /litellm\s*usage/i.test(e.reason || '');

/** 本次运行的起点：exec 开始时会写 runStartedAt，没有就退回创建时间 */
const runFrom = (j: Job) => j.runStartedAt || j.startedAt || j.createdAt;

/** 这次运行是否已经对过账 */
const isSettled = (j: Job) => j.settledRunAt != null && j.settledRunAt === j.runStartedAt;

/**
 * 拉一次流水，把能对上的任务补上实际消耗。
 * 返回本次有变化的任务（调用方负责推送）。
 */
export async function settlePoints(core: Core): Promise<Job[]> {
  if (core.provider === 'mock' || !core.accounts.loggedIn) return [];
  const all = core.store.jobs.all();
  /* 早期任务没记 usageBilling：平台模型的 ID 前缀是稳定依据，顺手补上 */
  for (const j of all) {
    if (!j.usageBilling && j.model.startsWith('cloud:')) {
      j.usageBilling = true;
      core.store.jobs.put(j);
    }
  }
  const jobs = all.filter((j) => j.usageBilling);
  /* 还在跑的等它跑完；排队中的还没产生消耗；已结算的运行不再重复消费流水 */
  const waiting = jobs
    .filter((j) => j.status === 'succeeded' || j.status === 'failed' || j.status === 'canceled')
    .filter((j) => !isSettled(j))
    .sort((a, b) => runFrom(a) - runFrom(b));
  if (!waiting.length) return [];

  let entries: FssLedgerEntry[];
  try {
    entries = await core.accounts.ledger(200);
  } catch {
    /* 流水读不到不影响任务本身；下一轮再试（也不要把任务标成待结算，免得误导） */
    return [];
  }
  const usage = entries.filter(isUsage).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));

  /* 已经被认领的流水不能再算一次（历史运行用掉的也算） */
  const claimed = new Set(jobs.flatMap((j) => j.ledgerEntryIds || []));
  const free = usage.filter((e) => !claimed.has(e.entryId));

  const changed: Job[] = [];
  for (const job of waiting) {
    const from = runFrom(job) - LEDGER_LOOKBACK_MS;
    const to = (job.finishedAt || Date.now()) + MATCH_SLACK_MS;
    const hit = free.find((e) => {
      const at = Date.parse(e.occurredAt);
      return Number.isFinite(at) && at >= from && at <= to;
    });
    if (!hit) {
      /* 流水还没回来：标成待结算，让界面说清楚「不是 0 点」 */
      if (job.pointsNote !== PENDING_NOTE) {
        job.pointsNote = PENDING_NOTE;
        changed.push(job);
      }
      continue;
    }
    free.splice(free.indexOf(hit), 1);
    job.pointsSpent = Math.round(((job.pointsSpent || 0) + microToPoints(hit.amountMicro)) * 10) / 10;
    job.ledgerEntryIds = [...(job.ledgerEntryIds || []), hit.entryId];
    job.settledRunAt = job.runStartedAt;
    delete job.pointsNote;
    changed.push(job);
  }
  for (const j of changed) core.store.jobs.put(j);
  return changed;
}

/** 任务结束后延迟对账：流水通常几秒到几十秒才落账，退避重试几次就够 */
export function scheduleSettle(core: Core, emit: (job: Job) => void) {
  const delays = [3_000, 10_000, 30_000, 90_000];
  for (const ms of delays) {
    setTimeout(() => {
      void settlePoints(core)
        .then((jobs) => jobs.forEach(emit))
        .catch(() => {});
    }, ms).unref?.();
  }
}