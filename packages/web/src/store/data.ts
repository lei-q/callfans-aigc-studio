import type { Board, Bootstrap, MediaType, ServerEvent, WalletDto } from '@aigc/shared';
import { TYPE_KEYS } from '@aigc/shared';
import { api, subscribe } from '../lib/api';
import { getState, setState, useStore, type State } from './index';
import { emptyBoard, modelsFor } from './selectors';
import { toast } from './toast';

/* ============================================================================
   数据层：首屏一次拉全量，之后靠服务端事件（SSE）增量更新。
   画板改动 350ms 内写回服务端；界面偏好也记在服务端。
   ========================================================================== */

const byCreatedDesc = <T extends { createdAt: number }>(a: T, b: T) => b.createdAt - a.createdAt;

function upsert<T extends { id: string }>(list: T[], item: T, sort?: (a: T, b: T) => number) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else {
    list.unshift(item);
    if (sort) list.sort(sort);
  }
}

/** 当前参数里的模型不属于当前渠道时，换成这个渠道里选定的模型，没选就是第一个可用模型 */
export function fixParams(s: State) {
  const picks = s.settings ? s.settings.models[s.settings.channel] : { text: '', image: '', video: '', audio: '' };
  for (const t of TYPE_KEYS as MediaType[]) {
    const p = s.params[t];
    const list = modelsFor(s, t, t === 'audio' ? p.use : undefined).filter((m) => m.status === 'on');
    if (!list.some((m) => m.id === p.model) && list.length) {
      const want = picks[t];
      p.model = list.some((m) => m.id === want) ? want : list[0].id;
    }
    const m = s.models.find((x) => x.id === p.model);
    if (t === 'video' && m?.durs?.length && p.dur && !m.durs.includes(p.dur) && m.maxDur && p.dur > m.maxDur) p.dur = m.durs[m.durs.length - 1];
  }
}

const UI_KEYS = ['formOpen', 'agentDock', 'canvasOpen', 'ws', 'type'] as const;

let subscribed = false;
let walletPoll: ReturnType<typeof setInterval> | null = null;
let walletBusy = false;

/** 账户积分：主动向账号服务查一次，结果走同一份 store（顶栏、充值抽屉、设置页都会跟着变） */
export async function refreshWallet() {
  if (walletBusy || !getState().session?.loggedIn) return;
  walletBusy = true;
  try {
    const { wallet } = await api.post<{ wallet: WalletDto | null }>('/api/billing/wallet/refresh');
    if (wallet) setState((s) => void (s.wallet = wallet));
  } catch {
    /* 查询失败不打扰用户：积分以服务端账本为准，下一轮再试 */
  } finally {
    walletBusy = false;
  }
}

/** 每 10 秒刷新一次积分；页面在后台时跳过，切回前台立刻补一次 */
const WALLET_POLL_MS = 10_000;
function startWalletPoll() {
  if (walletPoll) return;
  walletPoll = setInterval(() => {
    if (!document.hidden) void refreshWallet();
  }, WALLET_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshWallet();
  });
}

export async function boot() {
  try {
    const b = await api.get<Bootstrap>('/api/bootstrap');
    setState((s) => {
      s.app = b.app;
      s.projects = b.projects;
      s.jobs = b.jobs;
      s.results = b.results;
      s.wallet = b.wallet;
      s.session = b.session;
      s.boards = b.boards;
      s.aesthetic = b.aesthetic;
      s.posts = b.posts;
      s.models = b.models;
      s.channels = b.channels;
      s.settings = b.settings;
      s.apiKeys = b.apiKeys;
      const ui = b.ui as Partial<Record<(typeof UI_KEYS)[number], unknown>>;
      if (typeof ui.formOpen === 'boolean') s.formOpen = ui.formOpen;
      if (typeof ui.agentDock === 'boolean') s.agentDock = ui.agentDock;
      if (typeof ui.canvasOpen === 'boolean') s.canvasOpen = ui.canvasOpen;
      if (typeof ui.type === 'string' && (TYPE_KEYS as string[]).includes(ui.type)) s.type = ui.type as MediaType;
      s.ws = typeof ui.ws === 'string' && b.projects.some((p) => p.id === ui.ws) ? ui.ws : b.projects[0]?.id || '';
      for (const p of b.projects) if (!s.boards[p.id]) s.boards[p.id] = emptyBoard();
      fixParams(s);
      s.ready = true;
      s.bootError = null;
    });
    for (const [ws, board] of Object.entries(getState().boards)) {
      lastSaved.set(ws, board);
      lastSnap.set(ws, snapOf(board));
    }
    startWalletPoll();
    if (!subscribed) {
      subscribed = true;
      subscribe(applyEvent, (ok) => {
        const was = getState().online;
        setState((s) => void (s.online = ok));
        /* 断线重连后补一次全量，避免漏掉断线期间的事件 */
        if (ok && !was) void boot();
      });
      setTimeout(() => toast('ai', '欢迎来到 AIGC 创作台', '写一句提示词就能生成；完成后在画布顶部「最新生成」里挑。'), 400);
    }
  } catch (e) {
    setState((s) => void (s.bootError = (e as Error).message || '连不上本机服务'));
  }
}

export function applyEvent(raw: unknown) {
  const e = raw as ServerEvent;
  if (e.type === 'notice') {
    toast(e.level, e.title, e.desc);
    return;
  }
  setState((s) => {
    switch (e.type) {
      case 'job':
        upsert(s.jobs, e.job, byCreatedDesc);
        break;
      case 'result':
        upsert(s.results, e.result, byCreatedDesc);
        break;
      case 'result.deleted':
        s.results = s.results.filter((r) => r.id !== e.id);
        s.libSelect = s.libSelect.filter((x) => x !== e.id);
        break;
      case 'wallet':
        s.wallet = e.wallet;
        break;
      case 'session':
        s.session = e.session;
        if (!e.session.loggedIn) {
          s.wallet = null;
          s.loginFlow = null;
        }
        fixParams(s);
        break;
      case 'order':
        upsert(s.orders, e.order, (a, b2) => b2.createdAt - a.createdAt);
        if (s.activeOrder && s.activeOrder.id === e.order.id) s.activeOrder = e.order;
        break;
      case 'project':
        upsert(s.projects, e.project, (a, b) => a.createdAt - b.createdAt);
        if (!s.boards[e.project.id]) s.boards[e.project.id] = emptyBoard();
        break;
      case 'project.deleted':
        s.projects = s.projects.filter((p) => p.id !== e.id);
        delete s.boards[e.id];
        if (s.ws === e.id) s.ws = s.projects[0]?.id || '';
        break;
      case 'models':
        s.models = e.models;
        s.channels = e.channels;
        fixParams(s);
        break;
      case 'settings':
        s.settings = e.settings;
        fixParams(s);
        break;
      case 'api':
        s.apiKeys = e.apiKeys;
        break;
    }
  });
}

/* ---------------- 画板持久化 + 撤销快照 ---------------- */

const lastSaved = new Map<string, Board>();
const lastSnap = new Map<string, string>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let applyingSnap = false;
/** 正在写撤销栈：嵌套 setState 通知时不要再当成一次画板改动 */
let recordingHistory = false;

export const snapOf = (b: Board) => JSON.stringify({ i: b.items, l: b.links });

function scheduleSave(ws: string) {
  const t = saveTimers.get(ws);
  if (t) clearTimeout(t);
  saveTimers.set(
    ws,
    setTimeout(() => {
      const b = getState().boards[ws];
      if (!b || !getState().projects.some((p) => p.id === ws)) return;
      api.put(`/api/boards/${ws}`, b).catch(() => toast('warn', '画板没能保存', '本机服务可能已停止，恢复后会自动重试'));
    }, 350),
  );
}

/** 不进撤销栈的改动（比如文字实测宽高回写）放在这里面执行 */
export function silently(fn: () => void) {
  applyingSnap = true;
  try {
    fn();
  } finally {
    applyingSnap = false;
  }
}

let persisting = false;

export function startPersistence() {
  if (persisting) return;
  persisting = true;
  useStore.subscribe((s, prev) => {
    if (recordingHistory) return;
    if (s.boards !== prev.boards) {
      for (const [ws, board] of Object.entries(s.boards)) {
        if (lastSaved.get(ws) === board) continue;
        lastSaved.set(ws, board);
        scheduleSave(ws);
        const prevBoard = prev.boards[ws];
        if (!prevBoard || (prevBoard.items === board.items && prevBoard.links === board.links)) continue;
        const k = snapOf(board);
        const last = lastSnap.get(ws);
        if (last === undefined) {
          lastSnap.set(ws, k);
          continue;
        }
        if (k === last) continue;
        if (!applyingSnap) {
          /* 同步入栈：拖拽、连线、对齐可能在同一帧里连续发生，延迟入栈会让撤销丢步 */
          recordingHistory = true;
          try {
            setState((st) => {
              const h = (st.history[ws] = st.history[ws] || []);
              h.push(last);
              if (h.length > 40) h.shift();
              st.future[ws] = [];
            });
          } finally {
            recordingHistory = false;
          }
        }
        lastSnap.set(ws, k);
      }
    }
    if (UI_KEYS.some((k) => s[k] !== prev[k])) scheduleUi();
  });
}

let uiTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleUi() {
  if (uiTimer) clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    const s = getState();
    const ui: Record<string, unknown> = {};
    for (const k of UI_KEYS) ui[k] = s[k];
    api.put('/api/ui', ui).catch(() => {});
  }, 600);
}

function applySnap(ws: string, k: string) {
  const b = JSON.parse(k) as { i: Board['items']; l: Board['links'] };
  applyingSnap = true;
  setState((s) => {
    const board = s.boards[ws];
    if (!board) return;
    board.items = b.i;
    board.links = b.l;
    s.canvasSel = [];
    s.linkSel = null;
    s.cvsMenu = null;
  });
  applyingSnap = false;
  lastSnap.set(ws, k);
}

export function undo() {
  const s = getState();
  const ws = s.ws;
  const h = s.history[ws] || [];
  if (!h.length) {
    toast('info', '没有可撤销的操作');
    return;
  }
  const cur = snapOf(s.boards[ws]);
  const prev = h[h.length - 1];
  setState((st) => {
    st.history[ws].pop();
    (st.future[ws] = st.future[ws] || []).push(cur);
  });
  applySnap(ws, prev);
  toast('info', '已撤销', `还能撤 ${h.length - 1} 步`);
}

export function redo() {
  const s = getState();
  const ws = s.ws;
  const f = s.future[ws] || [];
  if (!f.length) {
    toast('info', '没有可重做的操作');
    return;
  }
  const cur = snapOf(s.boards[ws]);
  const next = f[f.length - 1];
  setState((st) => {
    st.future[ws].pop();
    (st.history[ws] = st.history[ws] || []).push(cur);
  });
  applySnap(ws, next);
  toast('info', '已重做');
}
