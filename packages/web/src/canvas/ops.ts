import type { AgentEnhanceReply, AgentResult, Board, CanvasItem, CanvasView, MediaType, TextSize } from '@aigc/shared';
import {
  DIVERGE_AXES,
  DIVERGE_DEFAULT,
  MAX_REFS,
  PLATFORM_DEFAULT,
  PLATFORMS,
  SEED_PROMPTS,
  TYPES,
  agentParamText,
  agentReadBoard,
  clamp,
  fileKindOf,
  hostOf,
  isDirectVideo,
  postPlatformOf,
  round1,
  singleUnitCost,
  uid,
  videoPlatformOf,
  type CreateJobBody,
  type Job,
  type LinkPreview,
} from '@aigc/shared';
import { api } from '../lib/api';
import { copyText, downloadText, pickFiles, readText, thumbOf } from '../lib/util';
import { getState, setState, type State } from '../store';
import { canAfford, refOfResult, uploadFiles, addToAesthetic, jobBody } from '../store/actions';
import { fixParams, silently } from '../store/data';
import { boardOf, canvasHas, canvasItems, canvasLinks, canvasSelItems, emptyBoard, jobById, modelOf, resultById, savedToLib, wsShort } from '../store/selectors';
import { toast, toastError } from '../store/toast';
import { CVS_AR, CVS_H_NODE, CVS_H_POST, CVS_H_WEB, CVS_K_MAX, CVS_K_MIN, CVS_W, CVS_W_TEXT, TEXT_H, TEXT_SIZE_NAME, cvsBounds, cvsItemH, cvsItemW, cvsZ, inGroup } from './geometry';

/* ============================================================================
   画布动作：所有对画板数据的修改都从这里走（撤销快照与持久化由数据层统一处理）
   ========================================================================== */

/** 视口：平移缩放期间先改这里和 DOM，停下来再写回 store */
export const live: { ws: string; view: CanvasView | null } = { ws: '', view: null };

export const currentView = (s: State = getState()): CanvasView =>
  live.ws === s.ws && live.view ? live.view : boardOf(s).view || { x: 40, y: 40, k: 1 };

export const viewportEl = () => document.getElementById('cvsViewport');

export function mutateBoard(fn: (b: Board, s: State) => void) {
  setState((s) => {
    if (!s.ws) return;
    const b = (s.boards[s.ws] = s.boards[s.ws] || emptyBoard());
    fn(b, s);
  });
}

export function setView(v: CanvasView) {
  live.ws = getState().ws;
  live.view = v;
  mutateBoard((b) => {
    b.view = { x: Math.round(v.x), y: Math.round(v.y), k: v.k };
  });
}

const selected = () => canvasSelItems(getState());

/* ---------------- 进画布 ---------------- */

function nextSpot(s: State) {
  const n = canvasItems(s).length;
  return { x: 40 + (n % 4) * (CVS_W + 24), y: 40 + Math.floor(n / 4) * 210 };
}

/** 把一条产出放进画布：收件箱里算「留用」，草稿箱里算「捞回来」 */
export function keepResult(rid: string, at?: { x: number; y: number }) {
  const s = getState();
  const r = resultById(s, rid);
  if (!r) return;
  if (canvasHas(s, rid)) {
    toast('info', '已经在画布上了', r.title);
    return;
  }
  const from = r.home;
  const pos = at || nextSpot(s);
  const id = uid('c');
  const j = jobById(s, r.job);
  mutateBoard((b) => {
    b.items.push({
      id,
      kind: 'media',
      type: r.type,
      src: r.src,
      thumb: thumbOf(r) || undefined,
      t: r.title,
      rid,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      ar: r.type === 'image' && r.ratio ? ratioAr(r.ratio) : undefined,
      dur: r.dur || undefined,
      seed: r.seed,
    });
    /* 从某张图发散 / 适配出来的，拖进来时自动连回源元素——产出天然有结构 */
    if (j?.fromCvsId && b.items.some((x) => x.id === j.fromCvsId)) b.links.push({ id: uid('L'), from: j.fromCvsId, to: id });
  });
  setState((st) => {
    st.canvasOpen = true;
    const res = st.results.find((x) => x.id === rid);
    if (res && (from === 'inbox' || from === 'draft')) res.home = 'canvas';
  });
  if (from === 'inbox' || from === 'draft') void api.patch(`/api/results/${rid}`, { home: 'canvas' }).catch(() => {});
  toast('success', from === 'draft' ? '已从草稿箱捞回画布' : '已放进画布', `${r.title} · 满意后可以保存到素材库`);
}

const ratioAr = (ratio: string) => {
  const [w, h] = ratio.split(':').map(Number);
  return w && h ? h / w : undefined;
};

export const addResultToCanvas = (rid: string) => {
  setState((s) => {
    s.page = 'studio';
    s.studioTab = 'gen';
    s.drawer = null;
  });
  keepResult(rid);
};

/** 屏幕坐标落点 → 世界坐标 */
export function dropPoint(clientX: number | null, clientY: number | null, offX = CVS_W / 2, offY = 60) {
  const vp = viewportEl();
  const v = currentView();
  if (!vp) return { x: 40, y: 40 };
  const rect = vp.getBoundingClientRect();
  const cx = clientX == null ? rect.left + rect.width / 2 : clientX;
  const cy = clientY == null ? rect.top + rect.height / 2 : clientY;
  return { x: Math.round((cx - rect.left - v.x) / v.k - offX), y: Math.round((cy - rect.top - v.y) / v.k - offY) };
}

/** 从电脑拖进来、或者粘贴：上传到本机，刷新后也还在 */
export async function addLocalFiles(files: File[], clientX: number | null, clientY: number | null) {
  if (!files.length) return;
  const base = dropPoint(clientX, clientY);
  let ups;
  try {
    ups = await uploadFiles(files);
  } catch (e) {
    toastError(e, '文件没能放进画布');
    return;
  }
  const counts: Record<string, number> = {};
  const added: CanvasItem[] = [];
  files.forEach((f, idx) => {
    const up = ups[idx];
    if (!up) return;
    const x = base.x + idx * 26;
    const y = base.y + idx * 26;
    const name = f.name.replace(/\.[^.]+$/, '').slice(0, 40) || '未命名';
    const m = /^(image|video|audio)\//.exec(f.type || '');
    if (m) {
      const type = m[1] as MediaType;
      added.push({
        id: uid('c'),
        kind: 'media',
        type,
        src: up.url,
        local: true,
        t: name,
        x,
        y,
        seed: 4000 + Math.floor(Math.random() * 9000),
        ar: type === 'image' ? CVS_AR : type === 'video' ? 0.62 : 0.5,
      });
      counts[type] = (counts[type] || 0) + 1;
    } else {
      const fk = fileKindOf(f.type, f.name);
      added.push({ id: uid('c'), kind: 'file', ftype: fk.k, t: f.name.slice(0, 48), bytes: f.size, src: up.url, x, y });
      counts['文档'] = (counts['文档'] || 0) + 1;
    }
  });
  mutateBoard((b) => void b.items.push(...added));
  setState((s) => void (s.canvasOpen = true));
  /* 拿到真实尺寸后再摆一次，图片和视频都适用 */
  added.forEach((it) => probeMedia(it));
  const name = (k: string) => (k === '文档' ? '文档' : k === 'image' ? '图片' : k === 'video' ? '视频' : '音频');
  toast('success', `已放进画布：${Object.keys(counts).map((k) => `${counts[k]} 个${name(k)}`).join(' · ')}`, '本地文件保存在本机，不会进素材库');
}

function probeMedia(it: CanvasItem) {
  if (it.kind !== 'media' || !it.src) return;
  const apply = (ar?: number, dur?: number) =>
    silently(() =>
      mutateBoard((b) => {
        const x = b.items.find((y) => y.id === it.id);
        if (!x) return;
        if (ar && isFinite(ar)) x.ar = ar;
        if (dur) x.dur = dur;
      }),
    );
  if (it.type === 'image') {
    const im = new Image();
    im.onload = () => im.naturalWidth && apply(im.naturalHeight / im.naturalWidth);
    im.src = it.src;
  } else if (it.type === 'video') {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => v.videoWidth && apply(v.videoHeight / v.videoWidth, Math.round(v.duration) || 0);
    v.src = it.src;
  }
}

/** 链接拖进来 / 粘贴进来：直链视频能播，平台链接落成卡片，服务端抓标题和封面 */
export async function addLink(url: string, clientX: number | null, clientY: number | null) {
  const clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) return false;
  if (isDirectVideo(clean)) {
    const p = dropPoint(clientX, clientY);
    const item: CanvasItem = {
      id: uid('c'),
      kind: 'media',
      type: 'video',
      src: clean,
      link: true,
      t: decodeURIComponent((clean.split('/').pop() || '').split('?')[0]).slice(0, 40) || '视频链接',
      ...p,
    };
    mutateBoard((b) => void b.items.push(item));
    setState((s) => void (s.canvasOpen = true));
    probeMedia(item);
    toast('success', '已放进画布：视频链接', '直链视频可以直接在画布上播放');
    return true;
  }
  const vpf = videoPlatformOf(clean);
  const pf = vpf || postPlatformOf(clean);
  const id = uid('c');
  if (pf) {
    const p = dropPoint(clientX, clientY, CVS_W / 2, CVS_H_POST / 2);
    mutateBoard((b) => void b.items.push({ id, kind: 'post', url: clean, platform: pf.k, isVideo: !!vpf, t: `${pf.n}${pf.label}`, ...p }));
    toast('success', `已放进画布：${pf.n}${vpf ? '视频' : pf.label}`, '正在抓标题与封面；抓不到也可以自己补封面');
  } else {
    const p = dropPoint(clientX, clientY, CVS_W / 2, CVS_H_WEB / 2);
    mutateBoard((b) => void b.items.push({ id, kind: 'web', url: clean, t: hostOf(clean), ...p }));
    toast('success', '已放进画布', `${hostOf(clean)} · 正在抓取页面标题`);
  }
  setState((s) => void (s.canvasOpen = true));
  try {
    const prev = await api.get<LinkPreview & { error?: string }>(`/api/link-preview?url=${encodeURIComponent(clean)}`);
    silently(() =>
      mutateBoard((b) => {
        const it = b.items.find((x) => x.id === id);
        if (!it) return;
        if (prev.title) it.t = prev.title.slice(0, 80);
        if (prev.author) it.author = prev.author.slice(0, 40);
        if (prev.site) it.site = prev.site;
        if (prev.desc) it.desc = prev.desc;
        if (prev.image && !it.cover) it.cover = prev.image;
      }),
    );
  } catch {
    /* 抓不到就保持域名 */
  }
  return true;
}

/* ---------------- 选择 / 删除 / 复制 ---------------- */

export function selectAll() {
  setState((s) => {
    s.canvasSel = canvasItems(s).map((i) => i.id);
    s.cvsMenu = null;
  });
  const n = getState().canvasSel.length;
  if (n) toast('info', `已选中全部 ${n} 个元素`);
}

export const clearSel = () => setState((s) => void (s.canvasSel = []));

export function removeItem(id: string) {
  mutateBoard((b, s) => {
    b.items = b.items.filter((i) => i.id !== id);
    b.links = b.links.filter((l) => l.from !== id && l.to !== id);
    s.canvasSel = s.canvasSel.filter((x) => x !== id);
    if (b.anchor?.cvsId === id) b.anchor = null;
  });
}

export function removeOne(id: string) {
  const it = canvasItems(getState()).find((x) => x.id === id);
  removeItem(id);
  toast('info', it?.kind === 'group' ? '分组框移除了' : '已从画布移除', it?.kind === 'group' ? '组里的元素都还在画板上' : '素材库里的产出不受影响');
}

export function deleteSel() {
  const s = getState();
  const ids = s.canvasSel.slice();
  if (!ids.length) return;
  const hadGroup = ids.some((id) => canvasItems(s).find((x) => x.id === id)?.kind === 'group');
  mutateBoard((b, st) => {
    const set = new Set(ids);
    b.items = b.items.filter((i) => !set.has(i.id));
    b.links = b.links.filter((l) => !set.has(l.from) && !set.has(l.to));
    if (b.anchor && set.has(b.anchor.cvsId)) b.anchor = null;
    st.canvasSel = [];
    st.cvsMenu = null;
  });
  toast('info', `已移除 ${ids.length} 个元素`, hadGroup ? '分组框移除了，组里的元素都还在画板上' : '素材库里的产出不受影响');
}

export function duplicateSel() {
  const sel = selected();
  if (!sel.length) return;
  const all = canvasItems(getState());
  const added: CanvasItem[] = [];
  const topIds: string[] = [];
  sel.forEach((i) => {
    const id = uid('c');
    topIds.push(id);
    added.push({ ...JSON.parse(JSON.stringify(i)), id, x: i.x + 26, y: i.y + 26 });
  });
  /* 复制分组时把成员一起带上，否则副本是个空框 */
  sel
    .filter((i) => i.kind === 'group')
    .forEach((g) => {
      all
        .filter((x) => x.kind !== 'group' && !sel.includes(x) && inGroup(x, g))
        .forEach((m) => added.push({ ...JSON.parse(JSON.stringify(m)), id: uid('c'), x: m.x + 26, y: m.y + 26 }));
    });
  mutateBoard((b, s) => {
    b.items.push(...added);
    s.canvasSel = topIds;
    s.cvsMenu = null;
  });
  const extra = added.length - sel.length;
  toast('success', `已复制 ${sel.length} 个`, extra ? `含组内 ${extra} 个成员，副本在原位置右下角` : '副本在原位置右下角，可以直接拖走');
}

export function nudge(dx: number, dy: number) {
  mutateBoard((b, s) => {
    for (const i of b.items) if (s.canvasSel.includes(i.id)) {
      i.x += dx;
      i.y += dy;
    }
  });
}

/* ---------------- 对齐 / 分布 / 层级 / 变换 ---------------- */

export function align(mode: string) {
  const sel = selected();
  if (sel.length < 2) return;
  const b = cvsBounds(sel)!;
  mutateBoard((bd, s) => {
    for (const i of bd.items) {
      if (!s.canvasSel.includes(i.id)) continue;
      const w = cvsItemW(i);
      const h = cvsItemH(i);
      if (mode === 'left') i.x = b.x1;
      else if (mode === 'hcenter') i.x = Math.round(b.x1 + (b.w - w) / 2);
      else if (mode === 'right') i.x = b.x2 - w;
      else if (mode === 'top') i.y = b.y1;
      else if (mode === 'vcenter') i.y = Math.round(b.y1 + (b.h - h) / 2);
      else if (mode === 'bottom') i.y = b.y2 - h;
    }
    s.cvsMenu = null;
  });
  toast('success', '已对齐', `${sel.length} 个元素`);
}

export function distribute(axis: 'h' | 'v') {
  const sel = selected();
  if (sel.length < 3) {
    toast('info', '至少要选 3 个', '两个元素之间没有「中间」可分布');
    return;
  }
  const list = sel.slice().sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y));
  const first = list[0];
  const last = list[list.length - 1];
  const pos: Record<string, number> = {};
  if (axis === 'h') {
    const span = last.x + cvsItemW(last) - first.x;
    const gap = (span - list.reduce((n, i) => n + cvsItemW(i), 0)) / (list.length - 1);
    let cur = first.x;
    list.forEach((i) => {
      pos[i.id] = Math.round(cur);
      cur += cvsItemW(i) + gap;
    });
  } else {
    const span = last.y + cvsItemH(last) - first.y;
    const gap = (span - list.reduce((n, i) => n + cvsItemH(i), 0)) / (list.length - 1);
    let cur = first.y;
    list.forEach((i) => {
      pos[i.id] = Math.round(cur);
      cur += cvsItemH(i) + gap;
    });
  }
  mutateBoard((b, s) => {
    for (const i of b.items) {
      if (pos[i.id] == null) continue;
      if (axis === 'h') i.x = pos[i.id];
      else i.y = pos[i.id];
    }
    s.cvsMenu = null;
  });
  toast('success', axis === 'h' ? '已水平均分' : '已垂直均分', `${list.length} 个元素`);
}

export function reorder(mode: 'front' | 'back') {
  if (!selected().length) return;
  mutateBoard((b, s) => {
    const zs = b.items.map((i, idx) => cvsZ(i, idx));
    const top = Math.max(...zs);
    const bottom = Math.min(...zs);
    let k = 0;
    for (const i of b.items) {
      if (!s.canvasSel.includes(i.id)) continue;
      i.z = mode === 'front' ? top + 1 + k : bottom - 1 - k;
      k += 1;
    }
    s.cvsMenu = null;
  });
  toast('info', mode === 'front' ? '已置顶' : '已置底');
}

function transformSel(fn: (i: CanvasItem) => void, label: string) {
  const n = selected().length;
  if (!n) {
    toast('info', '先选中元素', '单击或框选都可以');
    return;
  }
  mutateBoard((b, s) => {
    for (const i of b.items) if (s.canvasSel.includes(i.id)) fn(i);
    s.cvsMenu = null;
  });
  toast('success', label, `${n} 个元素`);
}

export const flip = (axis: 'h' | 'v') =>
  transformSel((i) => (axis === 'h' ? (i.flipH = !i.flipH) : (i.flipV = !i.flipV)), axis === 'h' ? '已水平翻转' : '已垂直翻转');
export const rotate = (d: number) => transformSel((i) => void (i.rot = ((i.rot || 0) + d + 360) % 360), d > 0 ? '已顺时针转 90°' : '已逆时针转 90°');
export const opacity = (op: number) => transformSel((i) => void (i.op = op), op < 1 ? '已设为半透明' : '已恢复不透明');
export const resetEl = () =>
  transformSel((i) => {
    i.rot = 0;
    i.flipH = false;
    i.flipV = false;
    i.op = 1;
    /* 节点、分组、文字的宽度不是素材默认宽，跟着重置会变形 */
    if (i.kind !== 'node' && i.kind !== 'group' && i.kind !== 'text') i.w = CVS_W;
  }, '已恢复原状');

export function resizeItem(id: string, w: number) {
  mutateBoard((b) => {
    const it = b.items.find((x) => x.id === id);
    if (it) it.w = Math.round(w);
  });
}

export function moveItems(pos: Record<string, { x: number; y: number }>) {
  mutateBoard((b) => {
    for (const i of b.items) {
      const p = pos[i.id];
      if (p) {
        i.x = Math.round(p.x);
        i.y = Math.round(p.y);
      }
    }
  });
}

/* ---------------- 视口 ---------------- */

export function fitAll(padding = 56) {
  const vp = viewportEl();
  const s = getState();
  const b = cvsBounds(canvasItems(s));
  if (!vp) return;
  if (!b) {
    setView({ x: 40, y: 40, k: 1 });
    return;
  }
  const vw = vp.clientWidth - padding * 2;
  const vh = vp.clientHeight - padding * 2;
  const k = Math.round(clamp(Math.min(vw / b.w, vh / b.h), CVS_K_MIN, CVS_K_MAX) * 100) / 100;
  setView({ k, x: Math.round(padding + (vw - b.w * k) / 2 - b.x1 * k), y: Math.round(padding + (vh - b.h * k) / 2 - b.y1 * k) });
}

export function resetView() {
  setView({ x: 40, y: 40, k: 1 });
  toast('info', '画布已回到原点', '缩放回到 100%');
}

export function zoomTo100() {
  const v = currentView();
  setView({ ...v, k: 1 });
}

/** 按当前视口宽度把所有元素排成规整网格 */
export function arrange() {
  const s = getState();
  const items = canvasItems(s);
  if (!items.length) {
    toast('info', '画布是空的', '先往里面丢点东西');
    return;
  }
  const vp = viewportEl();
  const v = currentView();
  const usable = vp ? Math.max(240, vp.clientWidth / v.k - 80) : 900;
  const gap = 20;
  let x = 40;
  let y = 40;
  let rowH = 0;
  const pos: Record<string, { x: number; y: number }> = {};
  items.forEach((it) => {
    const w = cvsItemW(it);
    const h = cvsItemH(it);
    if (x > 40 && x + w > 40 + usable) {
      x = 40;
      y += rowH + gap;
      rowH = 0;
    }
    pos[it.id] = { x, y };
    x += w + gap;
    rowH = Math.max(rowH, h);
  });
  moveItems(pos);
  setState((st) => void (st.cvsMenu = null));
  toast('success', '已整理', `${items.length} 个元素排成网格`);
}

function viewportCenter(w: number, h: number) {
  const vp = viewportEl();
  const v = currentView();
  return {
    x: Math.round(vp ? (vp.clientWidth / 2 - v.x) / v.k - w / 2 : 40),
    y: Math.round(vp ? (vp.clientHeight / 2 - v.y) / v.k - h / 2 : 40),
  };
}

/* ---------------- 节点 / 文字 / 分组 / 导图 ---------------- */

export function newText() {
  const id = uid('c');
  const c = viewportCenter(CVS_W_TEXT, TEXT_H.md);
  mutateBoard((b, s) => {
    b.items.push({ id, kind: 'text', text: '', size: 'md', ...c, w: CVS_W_TEXT, h: TEXT_H.md });
    s.canvasSel = [id];
    s.editTextId = id;
    s.cvsMenu = null;
  });
}

export function textSize(size: TextSize) {
  const sel = selected().filter((i) => i.kind === 'text');
  if (!sel.length) return;
  mutateBoard((b, s) => {
    for (const i of b.items) if (s.canvasSel.includes(i.id) && i.kind === 'text') {
      i.size = size;
      i.h = TEXT_H[size];
    }
    s.cvsMenu = null;
  });
  toast('success', `字号：${TEXT_SIZE_NAME[size]}`, `${sel.length} 个文字`);
}

export function setItemText(id: string, text: string, w?: number, h?: number) {
  const it = canvasItems(getState()).find((x) => x.id === id);
  if (!it) return;
  if (it.text === text && (w == null || it.w === w) && (h == null || it.h === h)) return;
  mutateBoard((b) => {
    const x = b.items.find((y) => y.id === id);
    if (!x) return;
    x.text = text;
    if (w) x.w = w;
    if (h) x.h = h;
  });
}

/** 文字实测宽高回写：不进撤销栈 */
export function measureText(id: string, w: number, h: number) {
  const it = canvasItems(getState()).find((x) => x.id === id);
  if (!it || (it.w === w && it.h === h)) return;
  silently(() =>
    mutateBoard((b) => {
      const x = b.items.find((y) => y.id === id);
      if (x) {
        x.w = w;
        x.h = h;
      }
    }),
  );
}

export function setGroupName(id: string, name: string) {
  mutateBoard((b) => {
    const g = b.items.find((x) => x.id === id);
    if (g) g.t = name.trim().slice(0, 24) || '未命名分组';
  });
}

export function newNode() {
  const id = uid('c');
  const c = viewportCenter(CVS_W, CVS_H_NODE);
  mutateBoard((b, s) => {
    b.items.push({ id, kind: 'node', text: '', ...c, w: 180, h: CVS_H_NODE });
    s.canvasSel = [id];
    s.linkFrom = id;
    s.cvsMenu = null;
  });
  toast('info', '节点已建好，接着连一个目标', '点另一个元素把它连起来；按 Esc 只留节点');
}

export function groupSelection() {
  const s = getState();
  const sel = canvasSelItems(s).filter((i) => i.kind !== 'group');
  setState((st) => void (st.cvsMenu = null));
  if (sel.length < 2) {
    toast('info', '至少选两个元素', '分组是把一批相关的东西圈在一起');
    return;
  }
  const pad = 26;
  const head = 30;
  const x1 = Math.min(...sel.map((i) => i.x)) - pad;
  const y1 = Math.min(...sel.map((i) => i.y)) - pad - head;
  const x2 = Math.max(...sel.map((i) => i.x + cvsItemW(i))) + pad;
  const y2 = Math.max(...sel.map((i) => i.y + cvsItemH(i))) + pad;
  mutateBoard((b, st) => {
    b.items.unshift({ id: uid('c'), kind: 'group', t: `${wsShort(st, st.ws).name} · 一组`, x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1 + head) });
    st.canvasSel = [];
  });
  toast('success', `已归为一组（${sel.length} 个）`, '拖分组标题栏可以整组移动，标题可以直接改');
}

export function groupAll() {
  setState((s) => void (s.canvasSel = canvasItems(s).filter((i) => i.kind !== 'group').map((i) => i.id)));
  groupSelection();
}

/** 展开为导图：以素材为中心向右生成六个方向节点；再点一次就重新布局 */
export function mindmap() {
  const s = getState();
  const it = canvasSelItems(s).find((i) => i.kind === 'media');
  setState((st) => void (st.cvsMenu = null));
  if (!it) {
    toast('info', '先选中一个素材', '导图以它为中心展开');
    return;
  }
  const old = canvasItems(s).filter((x) => x.kind === 'node' && x.mm === it.id);
  const cx = it.x + cvsItemW(it) / 2;
  const cy = it.y + cvsItemH(it) / 2;
  const gap = 118;
  const startY = cy - ((DIVERGE_AXES.length - 1) * gap) / 2 - 27;
  const ids: string[] = [];
  mutateBoard((b, st) => {
    if (old.length) {
      const oldIds = new Set(old.map((x) => x.id));
      b.items = b.items.filter((x) => !oldIds.has(x.id));
      b.links = b.links.filter((l) => !oldIds.has(l.from) && !oldIds.has(l.to));
    }
    DIVERGE_AXES.forEach((a, i) => {
      const nid = uid('c');
      b.items.push({ id: nid, kind: 'node', text: a.n, w: 150, h: 54, mm: it.id, mmAxis: a.k, x: Math.round(cx + 240), y: Math.round(startY + i * gap) });
      b.links.push({ id: uid('L'), from: it.id, to: nid });
      ids.push(nid);
    });
    st.canvasSel = [it.id, ...ids];
  });
  toast('success', old.length ? '导图已重新展开' : '已展开为导图', `${DIVERGE_AXES.length} 个方向分支 · 节点文字可以直接改，再点一次会重新布局`);
}

/* ---------------- 连线 ---------------- */

const linkHas = (from: string, to: string) => canvasLinks(getState()).some((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from));

export function linkPair() {
  const sel = getState().canvasSel;
  setState((s) => void (s.cvsMenu = null));
  if (sel.length !== 2) {
    toast('info', '要选两个元素', '先框选或按住 Shift 点选两个');
    return;
  }
  if (linkHas(sel[0], sel[1])) {
    toast('info', '这两个已经连过了');
    return;
  }
  mutateBoard((b) => void b.links.push({ id: uid('L'), from: sel[0], to: sel[1] }));
  toast('success', '已连线', '线表示关系，Agent 会读它来判断你的意图');
}

export function linkStart(id: string) {
  setState((s) => {
    s.linkFrom = id;
    s.cvsMenu = null;
  });
  toast('info', '选一个目标元素', '点谁就连到谁；按 Esc 取消');
}

export function linkTo(target: string | null) {
  const from = getState().linkFrom;
  setState((s) => void (s.linkFrom = null));
  if (!from || !target || target === from) return;
  if (linkHas(from, target)) {
    toast('info', '这两个已经连过了');
    return;
  }
  mutateBoard((b) => void b.links.push({ id: uid('L'), from, to: target }));
  toast('success', '已连线');
}

export function linkLabelStart(id: string) {
  setState((s) => {
    s.linkLabelEdit = id;
    s.cvsMenu = null;
  });
}

export function linkLabelSave(text: string) {
  const id = getState().linkLabelEdit;
  const label = text.trim().slice(0, 12);
  mutateBoard((b, s) => {
    const l = b.links.find((x) => x.id === id);
    if (l) l.label = label;
    s.linkLabelEdit = null;
  });
  if (label) toast('success', `线已命名：${label}`, 'Agent 读画板时会带上这个关系');
}

export function linkLabelClear() {
  const id = getState().linkSel;
  mutateBoard((b, s) => {
    const l = b.links.find((x) => x.id === id);
    if (l) l.label = '';
    s.cvsMenu = null;
  });
}

export function linkRemove() {
  const id = getState().linkSel;
  if (!id) return;
  mutateBoard((b, s) => {
    b.links = b.links.filter((l) => l.id !== id);
    s.linkSel = null;
    s.cvsMenu = null;
  });
  toast('info', '已删除连线');
}

/* ---------------- 封面 / 审美库 / 基准 ---------------- */

export async function setCover(id: string) {
  const [f] = await pickFiles('image/*', false);
  if (!f) return;
  try {
    const [up] = await uploadFiles([f]);
    mutateBoard((b) => {
      const it = b.items.find((x) => x.id === id);
      if (it) it.cover = up.url;
    });
    toast('success', '封面已补上', '链接卡片现在有预览图了');
  } catch (e) {
    toastError(e);
  }
}

export async function keepAesthetic(id: string) {
  const s = getState();
  setState((st) => void (st.cvsMenu = null));
  const it = canvasItems(s).find((x) => x.id === id);
  if (!it) return;
  if (it.kind === 'web' || it.kind === 'post') {
    const pf = postPlatformOf(it.url);
    await addToAesthetic({
      key: `w:${it.url}`,
      kind: 'web',
      src: it.cover || it.url || '',
      url: it.url,
      t: it.t || hostOf(it.url),
      note: pf ? `${pf.n}${pf.label}${it.like ? ` · ${it.like} 赞` : ''}` : it.desc || '',
      tags: pf ? [pf.n, '爆款参考'] : ['网页参考'],
      from: wsShort(s, s.ws).name,
    });
    return;
  }
  if (it.kind !== 'media') {
    toast('info', '这个暂不支持收藏', '审美库目前收图片、视频和网页');
    return;
  }
  const r = resultById(s, it.rid);
  await addToAesthetic({
    key: it.rid ? `r:${it.rid}` : `c:${it.src}`,
    kind: it.type || 'image',
    src: it.thumb || it.src || '',
    t: it.t || '未命名',
    note: r ? (r.tags || []).slice(0, 2).join(' · ') : '',
    tags: r ? r.tags : [it.local ? '外部收藏' : '生成产出'],
    from: it.local ? '画板' : wsShort(s, s.ws).name,
  });
  if (r && r.status !== 'adopted') {
    setState((st) => {
      const x = st.results.find((y) => y.id === r.id);
      if (x) x.status = 'fav';
    });
    void api.patch(`/api/results/${r.id}`, { status: 'fav' }).catch(() => {});
  }
}

/** 系列一致性：钉住一个风格基准，一个项目同时只钉一个 */
export function anchorToggle(id: string) {
  const s = getState();
  const b = boardOf(s);
  setState((st) => void (st.cvsMenu = null));
  if (b.anchor?.cvsId === id) {
    mutateBoard((bd) => void (bd.anchor = null));
    toast('info', '已取消风格基准', '后续生成不再自动带上它');
    return;
  }
  const it = canvasItems(s).find((x) => x.id === id);
  if (!it || it.kind !== 'media' || !it.type) {
    toast('info', '只有素材能当风格基准');
    return;
  }
  const r = resultById(s, it.rid);
  const j = r ? jobById(s, r.job) : undefined;
  const p = s.params[it.type];
  const params =
    it.type === 'image'
      ? { type: 'image' as const, ratio: j?.ratio || r?.ratio || p.ratio || '1:1', res: j?.res || p.res || '2k' }
      : it.type === 'video'
        ? { type: 'video' as const, ratio: j?.ratio || p.ratio || '9:16', dur: j?.dur || p.dur || 5, cam: j?.cam || p.cam || '固定' }
        : { type: 'audio' as const, use: j?.use || p.use || 'tts', dur: j?.dur || p.dur || 30 };
  mutateBoard((bd) => void (bd.anchor = { cvsId: id, params }));
  toast('success', '已设为风格基准', `${it.t} · 后续生成会自动带上它，保证系列一致`);
}

export function anchorApply() {
  const a = boardOf(getState()).anchor;
  if (!a) return;
  setState((s) => {
    s.type = a.params.type;
    s.studioTab = 'gen';
    const { type: _t, ...rest } = a.params;
    Object.assign(s.params[a.params.type], rest);
    fixParams(s);
  });
  toast('success', '已应用基准参数');
}

/* ---------------- 发散 / 适配 ---------------- */

/** 来源素材的基础提示词：优先原始提示词，其次标题 */
export function sourceBase(s: State, it: CanvasItem) {
  const r = resultById(s, it.rid);
  const j = r ? jobById(s, r.job) : undefined;
  return j?.prompt || it.t || '';
}

export function divergeOpen() {
  const it = selected()[0];
  if (!it) {
    toast('info', '先选中一个元素', '单击画板上的图片或视频');
    return;
  }
  if (it.kind !== 'media') {
    toast('info', '这个不能发散', '发散的对象是图片或视频素材');
    return;
  }
  setState((s) => {
    s.diverge = { srcId: it.id, axes: [...DIVERGE_DEFAULT] };
    s.platforms = null;
    s.cvsMenu = null;
  });
}

export function platformsOpen() {
  const it = selected()[0];
  setState((s) => void (s.cvsMenu = null));
  if (!it) {
    toast('info', '先选中一个素材');
    return;
  }
  if (it.kind !== 'media' || it.type !== 'image') {
    toast('info', '平台适配目前只支持图片', '视频和音频各平台的规格差异更大，后面单独做');
    return;
  }
  setState((s) => {
    s.platforms = { srcId: it.id, picks: [...PLATFORM_DEFAULT] };
    s.diverge = null;
  });
}

const refFromItem = (s: State, it: CanvasItem) => {
  const r = resultById(s, it.rid);
  if (r) return refOfResult(r, 0.6, 'canvas');
  const src = it.type === 'image' ? it.src : it.thumb;
  return src ? { src, w: 0.6, from: 'canvas' as const, t: it.t } : null;
};

async function submitJobs(bodies: CreateJobBody[], okTitle: string, okDesc: string) {
  try {
    await api.post<{ jobs: Job[] }>('/api/jobs', { jobs: bodies });
    setState((s) => {
      s.diverge = null;
      s.platforms = null;
      s.canvasSel = [];
    });
    toast('success', okTitle, okDesc);
  } catch (e) {
    toastError(e);
  }
}

export async function divergeRun() {
  const s = getState();
  const d = s.diverge;
  const it = d ? canvasItems(s).find((i) => i.id === d.srcId) : undefined;
  if (!d || !it || !it.type || !d.axes.length) return;
  const base = sourceBase(s, it);
  if (!base.trim()) {
    toast('warn', '这个元素没有可用的描述', '换一个来自生成的素材试试');
    return;
  }
  const type = it.type;
  const p = s.params[type];
  const model = modelOf(s, p.model);
  const unit = singleUnitCost(type, p, model);
  const axes = DIVERGE_AXES.filter((a) => d.axes.includes(a.k));
  const total = round1(unit * axes.length);
  if (!canAfford(s, total)) {
    toast('warn', '点数不够发散这么多方向', `需要 ${total} 点，当前余额 ${s.wallet?.balance ?? 0} 点`);
    return;
  }
  const ref = refFromItem(s, it);
  const tpl = jobBody(s, type);
  const bodies = axes.map((a) => ({
    ...tpl,
    refs: ref ? [ref] : [],
    prompt: `${base.replace(/[。.]+$/, '')}。${a.add}`,
    name: `发散 · ${a.n}`,
    divergeAxis: a.n,
    fromCvsId: it.id,
    ...(type === 'image' ? { count: 1 } : {}),
  }));
  await submitJobs(bodies, `已沿 ${axes.length} 个方向发散`, `${total} 点 · 产出会落到画板顶部的「最新生成」`);
}

export async function platformsRun() {
  const s = getState();
  const d = s.platforms;
  const it = d ? canvasItems(s).find((i) => i.id === d.srcId) : undefined;
  if (!d || !it || !d.picks.length) return;
  const base = sourceBase(s, it);
  if (!base.trim()) {
    toast('warn', '这个元素没有可用的描述');
    return;
  }
  const p = s.params.image;
  const unit = singleUnitCost('image', p, modelOf(s, p.model));
  const list = PLATFORMS.filter((pf) => d.picks.includes(pf.k));
  const total = round1(unit * list.length);
  if (!canAfford(s, total)) {
    toast('warn', '点数不够适配这么多平台', `需要 ${total} 点，当前余额 ${s.wallet?.balance ?? 0} 点`);
    return;
  }
  const ref = refFromItem(s, it);
  const tpl = jobBody(s, 'image');
  const bodies = list.map((pf) => ({
    ...tpl,
    refs: ref ? [ref] : [],
    prompt: `${base.replace(/[。.]+$/, '')}。按 ${pf.ratio} 重新构图：${pf.note}`,
    name: `适配 · ${pf.n} ${pf.ratio}`,
    platform: pf.n,
    ratio: pf.ratio,
    count: 1,
    fromCvsId: it.id,
  }));
  await submitJobs(bodies, `已按 ${list.length} 个平台比例排队`, `${total} 点 · 每个比例重新构图，产出会落进「最新生成」`);
}

/* ---------------- Agent ---------------- */

export function computeAgent(s: State): AgentResult {
  const sel = canvasSelItems(s);
  const scoped = sel.length > 0;
  return agentReadBoard({
    items: scoped ? sel : canvasItems(s),
    links: canvasLinks(s),
    scoped,
    fallbackType: s.type,
    resolve: (rid) => {
      const r = resultById(s, rid);
      const j = r ? jobById(s, r.job) : undefined;
      if (!j) return null;
      const tags = r?.tags?.length ? `，${r.tags.join('，')}` : '';
      return { prompt: j.prompt + (r?.note ? `，${r.note}` : '') + tags, type: j.type, model: j.model, ratio: j.ratio, res: j.res, dur: j.dur, cam: j.cam, use: j.use };
    },
  });
}

let agentSeq = 0;
export async function agentOpen() {
  const s = getState();
  const result = computeAgent(s);
  const seq = ++agentSeq;
  const llm = !!s.session?.loggedIn;
  setState((st) => void (st.agent = { open: true, result, loading: llm && !!result.draft }));
  if (!llm || !result.draft) return;
  try {
    const items = result.scoped ? canvasSelItems(s) : canvasItems(s);
    const prompts = items
      .map((i) => resultById(s, i.rid))
      .map((r) => (r ? jobById(s, r.job)?.prompt : undefined))
      .filter((p): p is string => !!p);
    const facts = [result.typeText, ...result.postLines, ...result.notes].filter(Boolean);
    const { enhanced } = await api.post<{ enhanced: AgentEnhanceReply | null }>('/api/assist/agent', {
      mainType: result.mainType,
      facts,
      prompts,
      nodeTexts: result.nodeTexts,
      draft: result.draft,
    });
    if (seq !== agentSeq) return;
    setState((st) => {
      if (!st.agent.result) return;
      st.agent.loading = false;
      if (enhanced) {
        st.agent.result.draft = enhanced.draft;
        st.agent.result.understanding = enhanced.understanding;
        st.agent.result.enhanced = true;
      }
    });
  } catch {
    if (seq === agentSeq) setState((st) => void (st.agent.loading = false));
  }
}

/** 选区一变就重算，否则结论和范围对不上 */
export function agentResync() {
  if (getState().agent.open) void agentOpen();
}

export function agentScopeAll() {
  setState((s) => void (s.canvasSel = []));
  void agentOpen();
}

export const agentClose = () => setState((s) => void (s.agent = { open: false, result: null, loading: false }));

export function agentApply() {
  const r = getState().agent.result;
  if (!r || !r.draft) return;
  const t = r.mainType;
  setState((s) => {
    s.type = t;
    s.page = 'studio';
    s.studioTab = 'gen';
    s.prompt[t] = r.draft;
    s.optimize = null;
    Object.assign(s.params[t], r.params);
    s.agent = { open: false, result: null, loading: false };
    if (!s.formOpen) s.formOpen = true;
    fixParams(s);
  });
  toast('success', '已按 Agent 的建议填好', `${TYPES[t].name} · ${agentParamText(t, r.params)}`);
}

export function agentCopy() {
  const r = getState().agent.result;
  if (!r) return;
  copyText(r.draft);
  toast('success', '已复制提示词');
}

/* ---------------- 带去做 / 参考 / 存素材库 ---------------- */

/** 选中的素材写进该类型的参考素材，文字一并写进提示词 */
export function canvasUse(type: MediaType) {
  const s = getState();
  const sel = canvasSelItems(s);
  if (!sel.length) return;
  const media = sel.filter((i) => i.kind === 'media');
  const texts = sel.filter((i) => (i.kind === 'text' || i.kind === 'node') && (i.text || '').trim());
  const prevRefs = s.refs[type].length;
  setState((st) => {
    if (media.length) {
      st.refs[type] = media
        .slice(0, MAX_REFS)
        .map((i) => refFromItem(st, i))
        .filter((x): x is NonNullable<typeof x> => !!x)
        .map((x) => ({ ...x, w: type === 'image' ? 0.6 : 0.5 }));
    }
    if (texts.length) {
      const joined = texts.map((i) => (i.text || '').trim()).join('，');
      const cur = (st.prompt[type] || '').trim();
      const isSeed = !cur || cur === SEED_PROMPTS[type].trim();
      st.prompt[type] = isSeed ? joined : `${cur}，${joined}`;
    }
    st.type = type;
    st.page = 'studio';
    st.studioTab = 'gen';
    st.optimize = null;
    if (!st.formOpen) st.formOpen = true;
  });
  toast(
    'ai',
    '已把画布内容带过来',
    `${media.length ? `${media.length} 项素材作为参考` : '未选素材'}${texts.length ? ` · ${texts.length} 处文字已写进提示词` : ''}${media.length && prevRefs ? `（替换了原有 ${prevRefs} 项）` : ''}`,
  );
}

/** 画布元素拖到「参考素材」区：类型要对得上，最多 4 项；元素回到原位（引用不是移动） */
export function toRefs(ids: string[]) {
  const s = getState();
  const t = s.type;
  const items = ids.map((id) => canvasItems(s).find((i) => i.id === id)).filter((i): i is CanvasItem => !!i);
  const media = items.filter((i) => i.kind === 'media');
  if (!media.length) {
    toast('warn', items.some((i) => i.kind === 'node' || i.kind === 'text') ? '这条不是素材' : '这里没有素材', '先选中一张图片');
    return false;
  }
  const other = media.find((i) => i.type !== t);
  if (other && other.type) {
    toast('warn', `这是${TYPES[other.type].name}，当前在${TYPES[t].name}页`, `切到「${TYPES[other.type].name}创作」的生成页再拖一次`);
    return false;
  }
  const room = MAX_REFS - s.refs[t].length;
  if (room <= 0) {
    toast('warn', '参考素材已满 4 项', '先移除一项再加');
    return false;
  }
  let n = 0;
  setState((st) => {
    for (const i of media.slice(0, room)) {
      const ref = refFromItem(st, i);
      if (!ref || st.refs[t].some((r) => r.src === ref.src)) continue;
      st.refs[t].push(ref);
      n += 1;
    }
  });
  if (!n) toast('info', '已经在参考里了', media[0].t);
  else toast('success', `已加入 ${n} 项参考素材`, '生成时它们会作为参考图影响结果');
  return true;
}

export function saveSelToLib() {
  const s = getState();
  const sel = canvasSelItems(s).filter((i) => i.rid && !savedToLib(s, i.rid));
  setState((st) => void (st.cvsMenu = null));
  if (!sel.length) {
    toast('info', '没有需要保存的内容', '选中的都已经在素材库里了');
    return;
  }
  setState((st) => {
    for (const i of sel) {
      const r = st.results.find((x) => x.id === i.rid);
      if (r) {
        r.home = 'library';
        r.isNew = false;
      }
    }
  });
  sel.forEach((i) => void api.patch(`/api/results/${i.rid}`, { home: 'library', isNew: false }).catch(() => {}));
  toast('success', `已保存 ${sel.length} 项到素材库`, '画布上的元素不会消失，只是多了「已存素材库」标记');
}

export async function dropInbox() {
  const s = getState();
  if (!s.results.some((r) => r.home === 'inbox' && r.ws === s.ws)) {
    toast('info', '当前项目没有待处理的产出');
    return;
  }
  try {
    const { count } = await api.post<{ count: number }>(`/api/inbox/${s.ws}/drop`);
    toast('info', '已全部收进草稿箱', `${count} 项 · 想找回就去素材库的「草稿箱」`);
  } catch (e) {
    toastError(e);
  }
}

export function canvasClear() {
  const s = getState();
  if (!s.canvasConfirm) {
    setState((st) => void (st.canvasConfirm = true));
    setTimeout(() => setState((st) => void (st.canvasConfirm = false)), 3500);
    toast('warn', '再点一次确认清空', '只会清空当前项目的画布，素材库与产出不受影响');
    return;
  }
  mutateBoard((b, st) => {
    b.items = [];
    b.links = [];
    b.anchor = null;
    st.canvasConfirm = false;
    st.canvasSel = [];
    st.linkSel = null;
    st.cvsMenu = null;
  });
  setView({ x: 40, y: 40, k: 1 });
  toast('info', '画布已清空', '只清空了当前项目的画布；按 Ctrl+Z 可以撤销');
}

/* ---------------- 保存 / 导入画板 ---------------- */

export function saveBoardFile() {
  const s = getState();
  const items = canvasItems(s);
  if (!items.length) {
    toast('info', '画板是空的', '先往里面放点东西');
    return;
  }
  const p = s.projects.find((x) => x.id === s.ws);
  const b = boardOf(s);
  const local = items.filter((i) => i.local).length;
  const board = {
    kind: 'aigc-studio-board',
    version: 2,
    savedAt: new Date().toISOString(),
    project: { id: s.ws, name: p?.name },
    view: b.view,
    links: b.links,
    anchor: b.anchor,
    items: items.map((i) => ({ ...i, local: i.local ? true : undefined })),
  };
  downloadText(`画板-${p?.name || s.ws}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(board, null, 2), 'application/json');
  toast('success', '画板已保存', `${items.length} 个元素${local ? ` · ${local} 个本地文件只记了引用，换台机器需要重新拖入` : ''}`);
}

export async function loadBoardFile() {
  const [f] = await pickFiles('.json,application/json', false);
  if (!f) return;
  try {
    const board = JSON.parse(await readText(f)) as { kind?: string; items?: CanvasItem[]; links?: Board['links']; view?: CanvasView; anchor?: Board['anchor'] };
    if (!board || board.kind !== 'aigc-studio-board' || !Array.isArray(board.items)) {
      toast('warn', '这不是画板文件', '请选择用「保存画板」导出的 JSON');
      return;
    }
    /* 本地文件只有引用：本机还在就留着，不在就丢掉并告知 */
    const checks = await Promise.all(
      board.items.map(async (i) => {
        if (!i.local || !i.src) return true;
        try {
          const r = await fetch(i.src, { method: 'HEAD' });
          return r.ok;
        } catch {
          return false;
        }
      }),
    );
    const items = board.items.filter((_i, idx) => checks[idx]);
    const dropped = board.items.length - items.length;
    const ids = new Set(items.map((i) => i.id));
    mutateBoard((b, s) => {
      b.items = items;
      b.links = (board.links || []).filter((l) => ids.has(l.from) && ids.has(l.to));
      b.anchor = board.anchor && ids.has(board.anchor.cvsId) ? board.anchor : null;
      s.canvasSel = [];
      s.cvsPop = null;
    });
    if (board.view) setView(board.view);
    toast('success', `已导入画板：${items.length} 个元素`, dropped ? `有 ${dropped} 个本地文件在这台机器上找不到，需要重新拖进来` : '');
  } catch {
    toast('warn', '画板文件读不出来', '文件可能损坏');
  }
}

/* ---------------- 面板开关 ---------------- */

export function toggleCanvas() {
  setState((s) => {
    s.canvasOpen = !s.canvasOpen;
    if (!s.canvasOpen) {
      s.canvasSel = [];
      s.cvsPop = null;
    }
  });
}

export function toggleForm() {
  setState((s) => void (s.formOpen = !s.formOpen));
  const open = getState().formOpen;
  toast('info', open ? '已展开生成表单' : '已收起，现在是纯画布', open ? '' : '按 [ 或点左侧竖条可以展开');
}

export function togglePen() {
  setState((s) => {
    s.cvsPen.on = !s.cvsPen.on;
    if (s.cvsPen.on) {
      s.cvsMenu = null;
      s.cvsPop = null;
    }
  });
  const on = getState().cvsPen.on;
  toast('info', on ? '画笔已开启' : '画笔已关闭', on ? '在画布上拖动即可标注，再点一次关闭' : '');
}

export function addDrawing(pts: [number, number][], color: string, lw: number) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(12, Math.round(Math.max(...xs) - x));
  const h = Math.max(12, Math.round(Math.max(...ys) - y));
  mutateBoard((b) =>
    b.items.push({
      id: uid('c'),
      kind: 'draw',
      color,
      lw,
      pts: pts.map(([px, py]) => [Math.round(px - x), Math.round(py - y)] as [number, number]),
      x: Math.round(x),
      y: Math.round(y),
      w,
      h,
    }),
  );
}

/** 生成参数浮层：贴着按钮右对齐，并且不越出画布 */
export function openParamsPop(rid: string, btn: DOMRect) {
  const vp = viewportEl();
  if (!vp) return;
  const vr = vp.getBoundingClientRect();
  const w = 312;
  const sx = clamp(btn.right - vr.left - w, 8, Math.max(8, vr.width - w - 8));
  let sy = btn.bottom - vr.top + 6;
  if (sy > vr.height - 220) sy = Math.max(8, btn.top - vr.top - 230);
  setState((s) => {
    s.cvsPop = { rid, sx, sy };
    s.cvsMenu = null;
  });
}

export function menuParams() {
  const s = getState();
  const it = canvasSelItems(s)[0];
  setState((st) => void (st.cvsMenu = null));
  if (!it?.rid) return;
  const node = document.querySelector(`#cvsWorld .cvs-el[data-id="${it.id}"]`);
  if (node) openParamsPop(it.rid, node.getBoundingClientRect());
}

export { CVS_W, CVS_AR, CVS_H_NODE };
