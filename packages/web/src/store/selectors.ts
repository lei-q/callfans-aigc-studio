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
    name: id.replace(/^(tc:|cloud:)/, '') || '未选择',
    type: 'image',
    price: 0,
    basis: '张',
    status: 'off',
    channel: 'cloud',
    note: id ? '模型已不在当前目录里' : '还没有可用模型',
    caps: [],
    limit: '',
  };

/** 渠道是否可用：云端要登录，直连要启用且配了 Key */
export const channelReady = (s: State, ch: 'cloud' | 'direct') =>
  ch === 'cloud' ? !!s.session?.loggedIn : !!(s.settings?.direct.enabled && s.settings.direct.hasKey);

/** 当前某类型可用的模型；音频再按用途过滤 */
export function modelsFor(s: State, type: MediaType, use?: AudioUse) {
  return s.models.filter((m) => m.type === type && channelReady(s, m.channel) && (type !== 'audio' || !use || !m.uses || m.uses.includes(use)));
}

/** 当前生成走哪条路：云端网关扣点数；直连由 TreeCloud 结算 */
export function routeInfo(s: State, type: MediaType, use?: AudioUse): { kind: 'cloud' | 'direct'; model?: ModelInfo } | { kind: null; reason: string } {
  const ready = modelsFor(s, type, use);
  const cloud = ready.find((m) => m.channel === 'cloud');
  if (cloud) return { kind: 'cloud', model: cloud };
  const direct = ready.find((m) => m.channel === 'direct');
  if (direct) return { kind: 'direct', model: direct };
  /* Fast-SSO 账号只有积分 / 充值，没有平台生成网关：生成只能走直连 */
  if (s.settings?.account.provider === 'fastsso') {
    if (!s.settings.direct.enabled || !s.settings.direct.hasKey) return { kind: null, reason: '平台生成网关还没有接入：到「设置 · 直连 TreeCloud」填好自己的 Key 后生成' };
    return { kind: null, reason: '直连模式下没有该类型的可用模型，到「设置」里刷新模型列表' };
  }
  if (!s.session?.loggedIn && s.settings?.direct.enabled && s.settings.direct.hasKey) return { kind: null, reason: '直连模式下没有该类型的可用模型，到「设置」里刷新模型列表' };
  if (!s.session?.loggedIn) return { kind: null, reason: s.session?.cloudReachable ? '登录后才能用平台点数生成' : '还没有配置云端地址：到「设置 · 云端连接」填写，或启用直连模式' };
  return { kind: null, reason: '当前账号下没有该类型的可用模型' };
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

export const balance = (s: State) => round1(s.wallet?.balance ?? 0);
export const dailyFreeLeft = (s: State) => round1(Math.max(0, s.wallet?.freeToday ?? 0));

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

/** 云端是否开放充值：明确返回空渠道才算未开放，未知时按开放处理（避免探测失败误藏入口） */
export const topupOpen = (s: State) => !s.session || s.session.payChannels === undefined || s.session.payChannels.length > 0;
