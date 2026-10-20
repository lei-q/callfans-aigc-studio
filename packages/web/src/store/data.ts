import type { Board, Bootstrap, MediaType, ServerEvent } from '@aigc/shared';
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

/** 当前参数里的模型不属于当前渠道时，换成这个渠道的第一个可用模型 */
export function fixParams(s: State) {
  for (const t of TYPE_KEYS as MediaType[]) {
    const p = s.params[t];
    const list = modelsFor(s, t, t === 'audio' ? p.use : undefined).filter((m) => m.status === 'on');
    if (!list.some((m) => m.id === p.model) && list.length) p.model = list[0].id;
    const m = s.models.find((x) => x.id === p.model);
    if (t === 'video' && m?.durs?.length && p.dur && !m.durs.includes(p.dur) && m.maxDur && p.dur > m.maxDur) p.dur = m.durs[m.durs.length - 1];
  }
}

const UI_KEYS = ['formOpen', 'agentDock', 'canvasOpen', 'ws', 'type'] as const;

let subscribed = false;

export async function boot() {
  try {
    const b = await api.get<Bootstrap>('/api/bootstrap');
    setState((s) => {
      s.app = b.app;
      s.projects = b.projects;
      s.jobs = b.jobs;
      s.results = b.results;
      s.wallet = b.wallet;
      s.boards = b.boards;
      s.aesthetic = b.aesthetic;
      s.posts = b.posts;
      s.models = b.models;
      s.channels = b.channels;
      s.settings = b.settings;
      s.apiKeys = b.apiKeys;
      s.apiUsage = b.apiUsage;
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
        s.apiUsage = e.apiUsage;
        break;
    }
  });
}

/* ---------------- 画板持久化 + 撤销快照 ---------------- */

const lastSaved = new Map<string, Board>();
const lastSnap = new Map<string, string>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let applyingSnap = false;

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
          setTimeout(() =>
            setState((st) => {
              const h = (st.history[ws] = st.history[ws] || []);
              h.push(last);
              if (h.length > 40) h.shift();
              st.future[ws] = [];
            }),
          );
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
