import { DEFAULT_DAILY_FREE } from './constants';
import { dayKey, round1 } from './format';
import type { Job, Project, Wallet } from './types';

/** 跨天重置当日免费额度：当日有效、不累积 */
export function ensureDaily(w: Wallet, now = Date.now()) {
  const k = dayKey(now);
  if (w.dailyDate !== k) {
    w.dailyDate = k;
    w.dailyUsed = 0;
    if (!w.dailyFree) w.dailyFree = DEFAULT_DAILY_FREE;
  }
  return w;
}

export const dailyFreeLeft = (w: Wallet) => round1(Math.max(0, w.dailyFree - w.dailyUsed));
export const spentTotal = (w: Wallet) => round1(w.spent.image + w.spent.video + w.spent.audio);
/** 余额 + 当日免费额度够不够付这一笔 */
export const affordable = (w: Wallet, cost: number) => cost <= round1(w.balance + dailyFreeLeft(w));

/**
 * 计费口径：任务创建即扣费；先用当日免费点数抵扣，剩余从余额扣。
 * 用 charged 标记保证「取消 → 重跑」的净支出正好等于一次费用。
 */
export function chargeJob(w: Wallet, j: Job, project?: Project) {
  if (j.charged) return false;
  const free = Math.min(dailyFreeLeft(w), j.cost);
  j.usedFree = 0;
  if (free > 0) {
    w.dailyUsed = round1(w.dailyUsed + free);
    j.usedFree = round1(free);
  }
  w.balance = round1(w.balance - (j.cost - (j.usedFree || 0)));
  w.spent[j.type] = round1(w.spent[j.type] + j.cost);
  if (project) project.used = round1(project.used + j.cost);
  j.charged = true;
  return true;
}

/** 取消或失败：退回当初扣的那一笔。免费额度退回额度，余额退回余额，不会重复退 */
export function refundJob(w: Wallet, j: Job, project?: Project) {
  if (!j.charged) return false;
  const free = j.usedFree || 0;
  if (free) w.dailyUsed = Math.max(0, round1(w.dailyUsed - free));
  w.balance = round1(w.balance + (j.cost - free));
  w.spent[j.type] = Math.max(0, round1(w.spent[j.type] - j.cost));
  if (project) project.used = Math.max(0, round1(project.used - j.cost));
  j.usedFree = 0;
  j.charged = false;
  return true;
}

/** 充值：首充翻倍，每人一次 */
export function topup(w: Wallet, amount: number) {
  const double = !w.firstTopupDone;
  const got = double ? amount * 2 : amount;
  w.balance = round1(w.balance + got);
  if (double) w.firstTopupDone = true;
  return { got, double };
}
