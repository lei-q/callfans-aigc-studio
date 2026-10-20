import type { AudioUse, Board, CanvasItem, CanvasLink, Job, MediaType, ModelInfo, Result } from '@aigc/shared';
import { round1 } from '@aigc/shared';
import type { State } from './index';

export const emptyBoard = (): Board => ({ items: [], links: [], view: { x: 40, y: 40, k: 1 }, anchor: null });

export const projectOf = (s: State, id: string) => s.projects.find((p) => p.id === id) || s.projects[0];
export const wsShort = (s: State, id: string) => {
  const p = projectOf(s, id);
  return { name: p ? p.name.split(' · ')[0] : '未命名', dot: p ? p.dot : '#8A90A2' };
};

export const modelOf = (s: State, id: string): ModelInfo =>
  s.models.find((m) => m.id === id) || {
    id,
    name: id.replace(/^tc:/, ''),
    type: 'image',
    price: 0,
    basis: '张',
    status: 'off',
    channel: 'mock',
    note: '模型已不在当前目录里',
    caps: [],
    limit: '',
  };

export const activeChannel = (s: State) => s.settings?.provider.active || 'mock';

/** 当前渠道下某类型可用的模型；音频再按用途过滤 */
export function modelsFor(s: State, type: MediaType, use?: AudioUse) {
  const ch = activeChannel(s);
  return s.models.filter((m) => m.type === type && m.channel === ch && (type !== 'audio' || !use || !m.uses || m.uses.includes(use)));
}

export const resultById = (s: State, id?: string | null) => (id ? s.results.find((r) => r.id === id) : undefined);
export const jobById = (s: State, id?: string | null) => (id ? s.jobs.find((j) => j.id === id) : undefined);
export const resultsOfJob = (s: State, j: Job) => j.results.map((id) => resultById(s, id)).filter((r): r is Result => !!r);

export const libResults = (s: State) => s.results.filter((r) => r.home === 'library');
export const draftResults = (s: State) => s.results.filter((r) => r.home === 'draft');
export const inboxResults = (s: State) => s.results.filter((r) => r.home === 'inbox' && r.ws === s.ws);
export const inScope = (s: State, r: { ws: string }) => s.libScope === 'all' || r.ws === s.ws;

export const queueJobs = (s: State) => s.jobs.filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'failed');
export const failJobs = (s: State) => s.jobs.filter((j) => j.status === 'failed');
export const openJobs = (s: State) => s.jobs.filter((j) => j.status === 'running' || j.status === 'queued');

export const spentTotal = (s: State) => round1(s.wallet.spent.image + s.wallet.spent.video + s.wallet.spent.audio);
export const balance = (s: State) => round1(s.wallet.balance);
export const dailyFreeLeft = (s: State) => round1(Math.max(0, s.wallet.dailyFree - s.wallet.dailyUsed));

/* ---------------- 画布 ---------------- */

/** 没有画板时返回同一个空对象，避免选择器每次返回新引用 */
const EMPTY_BOARD: Board = Object.freeze(emptyBoard()) as Board;
export const boardOf = (s: State, ws = s.ws): Board => s.boards[ws] || EMPTY_BOARD;
export const canvasItems = (s: State): CanvasItem[] => boardOf(s).items;
export const canvasLinks = (s: State): CanvasLink[] => boardOf(s).links;
export const canvasSelItems = (s: State) => canvasItems(s).filter((i) => s.canvasSel.includes(i.id));
export const canvasHas = (s: State, rid: string) => canvasItems(s).some((i) => i.rid === rid);
export const savedToLib = (s: State, rid?: string) => !!rid && resultById(s, rid)?.home === 'library';

/** 顺着 rid → result → job 拿到当时那条提示词 */
export function sourcePrompt(s: State, rid?: string) {
  const r = resultById(s, rid);
  const j = r ? jobById(s, r.job) : undefined;
  return { r, j };
}
