import type { Board, Bootstrap, MediaType, ServerEvent, WalletDto } from '@aigc/shared';
import { TYPE_KEYS, VIDEO_DUR_DEF, VIDEO_DUR_MIN, pickVideoResolution } from '@aigc/shared';
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
    /* 时长是自定义输入：只把超出模型上限的值收回来，不再往固定档位上对齐 */
    if (t === 'video') {
      const cap = m?.maxDur;
      if (!Number.isFinite(p.dur) || (p.dur || 0) < VIDEO_DUR_MIN) p.dur = VIDEO_DUR_DEF;
      else if (cap && p.dur! > cap) p.dur = cap;
    }
    if (t === 'video' && m?.videoRes?.length) p.vres = pickVideoResolution(p.vres, m.videoRes);
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
    /* 本地有没写进服务的画板改动：以本地为准（再补写一次），别让服务端的旧版本盖掉 */
    const keep = new Map<string, Board>();
    for (const ws of dirtyBoards) {
      const local = getState().boards[ws];
      if (local && b.projects.some((p) => p.id === ws)) keep.set(ws, local);
    }
    /* 重连补拉不是用户操作：不进撤销栈 */
    silently(() => setState((s) => {
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
      for (const [ws, local] of keep) s.boards[ws] = local;
      for (const p of b.projects) if (!s.boards[p.id]) s.boards[p.id] = emptyBoard();
      fixParams(s);
      s.ready = true;
      s.bootError = null;
    }));
    for (const [ws, board] of Object.entries(getState().boards)) {
      lastSaved.set(ws, board);
      lastSnap.set(ws, snapOf(board));
    }
    for (const ws of keep.keys()) scheduleSave(ws);
    /* 批注：服务端存着的先灌回来（和刷新前一样继续标） */
    void api
      .get<{ annotations: Record<string, Record<string, import('../canvas/annot').Annot[]>> }>('/api/annotations')
      .then((r) => {
        const merged: Record<string, import('../canvas/annot').Annot[]> = {};
        for (const [ws, m] of Object.entries(r.annotations)) {
          annotSaved.set(ws, JSON.stringify(m));
          Object.assign(merged, m);
        }
        if (Object.keys(merged).length) setState((st) => void (st.annotCache = { ...merged, ...st.annotCache }));
      })
      .catch(() => {});
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
      case 'job.deleted':
        s.jobs = s.jobs.filter((j) => j.id !== e.id);
        delete s.expanded[e.id];
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
        /* 登录流程由轮询结果（成功 / 被拒 / 过期）收尾；这里清掉会把「登录失败的原因」一起吞掉 */
        if (!e.session.loggedIn) {
          s.wallet = null;
          /* 订单是账号的：退出后换另一个账号登录，不能还看到上一个账号的订单与进行中的支付 */
          s.orders = [];
          s.activeOrder = null;
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
        /* 服务端连带删了这个项目的任务、产出、帖子，只发了一个事件：本地也要一起清，否则「全部项目」里还有点不开的幽灵产出 */
        s.jobs = s.jobs.filter((j) => j.ws !== e.id);
        s.results = s.results.filter((r) => r.ws !== e.id);
        s.posts = s.posts.filter((p) => p.ws !== e.id);
        delete s.history[e.id];
        delete s.future[e.id];
        s.libSelect = [];
        dirtyBoards.delete(e.id);
        lastSaved.delete(e.id);
        lastSnap.delete(e.id);
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
/** 改了但还没确认写进本机服务的画板：断线重连后要保留本地版本并补写，不能被服务端旧版本覆盖 */
const dirtyBoards = new Set<string>();
let applyingSnap = false;
/** 正在写撤销栈：嵌套 setState 通知时不要再当成一次画板改动 */
let recordingHistory = false;

/**
 * 产出从画布上拿掉（删除 / 撤销 / 清空）后：没有任何画板还引用它、又没存进素材库的，退回草稿箱。
 * 否则它的 home 停在 canvas，收件箱、草稿箱、素材库三处都列不出来。
 */
export function releaseCanvasOrphans() {
  const s = getState();
  const used = new Set<string>();
  for (const b of Object.values(s.boards)) for (const i of b.items) if (i.rid) used.add(i.rid);
  const orphans = s.results.filter((r) => r.home === 'canvas' && !used.has(r.id));
  if (!orphans.length) return;
  setState((st) => {
    for (const r of st.results) if (r.home === 'canvas' && !used.has(r.id)) r.home = 'draft';
  });
  for (const r of orphans) void api.patch(`/api/results/${r.id}`, { home: 'draft' }).catch(() => {});
}

export const snapOf = (b: Board) => JSON.stringify({ i: b.items, l: b.links });

function scheduleSave(ws: string) {
  dirtyBoards.add(ws);
  const t = saveTimers.get(ws);
  if (t) clearTimeout(t);
  saveTimers.set(
    ws,
    setTimeout(() => {
      saveTimers.delete(ws);
      const b = getState().boards[ws];
      if (!b || !getState().projects.some((p) => p.id === ws)) {
        dirtyBoards.delete(ws);
        return;
      }
      api
        .put(`/api/boards/${ws}`, b)
        .then(() => {
          /* 写的过程中又改了的话，新的那次定时器会负责，这里不能提前清标记 */
          if (getState().boards[ws] === b) dirtyBoards.delete(ws);
        })
        .catch(() => toast('warn', '画板没能保存', '本机服务可能已停止，恢复连接后会自动补写'));
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
        /* 本次会话新建的项目没有快照：以改动前的画板作为第一个撤销点 */
        const last = lastSnap.get(ws) ?? snapOf(prevBoard);
        if (k === last) {
          lastSnap.set(ws, k);
          continue;
        }
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
    if (s.annotCache !== prev.annotCache) scheduleAnnots();
  });
}

/* 批注也要落盘：上下文包要用，刷新后也不该丢。按项目拆开存，key 是画布元素 id */
let annotTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAnnots() {
  if (annotTimer) clearTimeout(annotTimer);
  annotTimer = setTimeout(() => {
    const s = getState();
    for (const [ws, board] of Object.entries(s.boards)) {
      const ids = new Set(board.items.map((i) => i.id));
      const mine = Object.fromEntries(Object.entries(s.annotCache).filter(([id, list]) => ids.has(id) && list.length));
      const key = JSON.stringify(mine);
      if (annotSaved.get(ws) === key) continue;
      annotSaved.set(ws, key);
      api.put(`/api/annotations/${ws}`, mine).catch(() => annotSaved.delete(ws));
    }
  }, 700);
}
const annotSaved = new Map<string, string>();

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
  releaseCanvasOrphans();
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
