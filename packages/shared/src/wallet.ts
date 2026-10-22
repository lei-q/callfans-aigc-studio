import { round1 } from './format';
import type { WalletDto } from './cloud';

/* 钱包的权威在云端；本地只做展示用的纯计算 */
export const dailyFreeLeft = (w: WalletDto | null) => round1(Math.max(0, w?.freeToday || 0));
export const affordable = (w: WalletDto | null, cost: number) => !!w && cost <= round1(w.balance + dailyFreeLeft(w));
