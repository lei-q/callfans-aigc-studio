import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CanvasItem, CanvasView } from '@aigc/shared';
import { DIVERGE_AXES, PEN_COLORS, PLATFORMS, TYPES, TYPE_KEYS, clamp, paramsBrief, round1, singleUnitCost, timeLabel } from '@aigc/shared';
import { Icon } from '../components/common';
import { getState, setState, useStore } from '../store';
import { copyPromptOf, openResult, reuseParams } from '../store/actions';
import { redo, undo } from '../store/data';
import { boardOf, canvasItems, jobById, modelOf, resultById, savedToLib } from '../store/selectors';
import { thumbOf } from '../lib/util';
import { CanvasEl } from './CanvasEl';
import { CVS_K_MAX, CVS_K_MIN, CVS_W_MAX, CVS_W_MIN, cvsCenter, cvsItemH, cvsItemW, gridStyle, inGroup, linkMid, linkPath, toWorld } from './geometry';
import { menuItems, uploadFromMenu } from './menu';
import * as op from './ops';

type Act =
  | { mode: 'pan'; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { mode: 'move'; sx: number; sy: number; k: number; origin: Record<string, { x: number; y: number }>; moved: boolean; ex?: number; ey?: number; collapseTo?: string }
  | { mode: 'resize'; id: string; sx: number; sy: number; w0: number; k: number; moved: boolean }
  | { mode: 'marquee'; sx: number; sy: number; ox: number; oy: number; additive: boolean; base: string[]; moved: boolean; ex?: number; ey?: number }
  | { mode: 'draw'; sx: number; sy: number; pts: [number, number][]; moved: boolean };

export function CanvasPanel() {
  const open = useStore((s) => s.canvasOpen);
  const count = useStore((s) => boardOf(s).items.length);
  if (!open) {
    return (
      <div className="cvs-panel closed">
        <button className="cvs-rail" onClick={op.toggleCanvas} title="展开画布">
          <Icon name="layers" />
          <span className="cvs-rail-txt">画布</span>
          {count > 0 && <span className="cvs-rail-n num">{count}</span>}
          <Icon name="chev-left" className="cvs-rail-arrow" />
        </button>
      </div>
    );
  }
  return <OpenCanvas />;
}

function OpenCanvas() {
  const ws = useStore((s) => s.ws);
  const board = useStore((s) => boardOf(s));
  const sel = useStore((s) => s.canvasSel);
  const linkSel = useStore((s) => s.linkSel);
  const linkFrom = useStore((s) => s.linkFrom);
  const pen = useStore((s) => s.cvsPen);
  const full = useStore((s) => s.cvsFull);
  const editTextId = useStore((s) => s.editTextId);
  const linkLabelEdit = useStore((s) => s.linkLabelEdit);
  const histN = useStore((s) => (s.history[s.ws] || []).length);
  const futN = useStore((s) => (s.future[s.ws] || []).length);
  const results = useStore((s) => s.results);
  const space = useStore((s) => s.cvsSpace);

  const vpRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLSpanElement>(null);
  const actRef = useRef<Act | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const items = board.items;
  const media = items.filter((i) => i.kind !== 'draw').length;

  /* ---------------- 视口：平移缩放只改 transform，不重渲染 ---------------- */
  const applyView = (v: CanvasView) => {
    if (worldRef.current) worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    if (gridRef.current) Object.assign(gridRef.current.style, gridStyle(v));
    if (zoomRef.current) zoomRef.current.textContent = `${Math.round(v.k * 100)}%`;
  };
  useLayoutEffect(() => {
    op.live.ws = ws;
    op.live.view = { ...board.view };
    applyView(board.view);
  }, [ws, board.view]);
  const commitView = () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => op.live.view && op.setView(op.live.view), 200);
  };

  /* ---------------- 连线：拖动中直接改 path，跟得上手指 ---------------- */
  const syncLinksLive = () => {
    const world = worldRef.current;
    if (!world) return;
    const b = boardOf(getState());
    const pos = (id: string) => {
      const it = b.items.find((x) => x.id === id);
      if (!it) return null;
      const n = world.querySelector<HTMLElement>(`.cvs-el[data-id="${id}"]`);
      return cvsCenter(it, n && n.style.left ? { x: parseFloat(n.style.left), y: parseFloat(n.style.top) } : undefined);
    };
    for (const l of b.links) {
      const a = pos(l.from);
      const c = pos(l.to);
      if (!a || !c) continue;
      const d = linkPath(a, c);
      world.querySelectorAll<SVGPathElement>(`path[data-link="${l.id}"]`).forEach((p) => p.setAttribute('d', d));
      const g = world.querySelector<SVGGElement>(`g[data-link="${l.id}"]`);
      if (g) {
        const m = linkMid(a, c);
        const rect = g.querySelector('rect');
        const text = g.querySelector('text');
        const w = Number(rect?.getAttribute('width') || 30);
        rect?.setAttribute('x', String(m.x - w / 2));
        rect?.setAttribute('y', String(m.y - 11));
        text?.setAttribute('x', String(m.x));
        text?.setAttribute('y', String(m.y + 4));
      }
    }
  };

  /* ---------------- 指针交互 ---------------- */
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;

    const refZoneAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-ref-drop]') || null;
    /* 拖动过程中参考区整体高亮，明确「松手就加进去」 */
    const setHot = (zone: HTMLElement | null) => {
      if (getState().refDropHot !== !!zone) setState((st) => void (st.refDropHot = !!zone));
    };

    const marqueeRect = (a: Extract<Act, { mode: 'marquee' }>, ex: number, ey: number) => {
      const rect = vp.getBoundingClientRect();
      const v = op.currentView();
      const cx = clamp(ex - rect.left, 0, rect.width);
      const cy = clamp(ey - rect.top, 0, rect.height);
      return {
        x: Math.min(a.ox, cx),
        y: Math.min(a.oy, cy),
        w: Math.abs(cx - a.ox),
        h: Math.abs(cy - a.oy),
        wx1: (Math.min(a.ox, cx) - v.x) / v.k,
        wy1: (Math.min(a.oy, cy) - v.y) / v.k,
        wx2: (Math.max(a.ox, cx) - v.x) / v.k,
        wy2: (Math.max(a.oy, cy) - v.y) / v.k,
      };
    };
    const hitIds = (a: Extract<Act, { mode: 'marquee' }>, r: ReturnType<typeof marqueeRect>) => {
      const hit = new Set(a.base);
      for (const i of canvasItems(getState())) {
        if (i.x < r.wx2 && i.x + cvsItemW(i) > r.wx1 && i.y < r.wy2 && i.y + cvsItemH(i) > r.wy1) hit.add(i.id);
      }
      return [...hit];
    };

    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!vp.contains(t)) return;
      if (t.closest('.cvs-menu, .cvs-pop, .cvs-link-input')) return;
      const s = getState();
      /* 点别处关掉菜单与参数浮层 */
      if (s.cvsMenu || s.cvsPop || s.linkLabelEdit) setState((st) => void ((st.cvsMenu = null), (st.cvsPop = null), (st.linkLabelEdit = null)));
      if (e.button === 2) return;
      /* 画笔与空格平移是「模式」，优先于一切元素操作 */
      if (s.cvsPen.on && e.button === 0) {
        e.preventDefault();
        const rect = vp.getBoundingClientRect();
        const p = toWorld(op.currentView(), rect, e.clientX, e.clientY);
        actRef.current = { mode: 'draw', sx: e.clientX, sy: e.clientY, pts: [[p.x, p.y]], moved: false };
        document.body.classList.add('cvs-acting');
        return;
      }
      if (s.cvsSpace || e.button === 1) {
        e.preventDefault();
        const v = op.currentView();
        actRef.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, moved: false };
        document.body.classList.add('cvs-acting');
        return;
      }
      if (e.button !== 0) return;
      const el = t.closest<HTMLElement>('.cvs-el');
      const v = op.currentView();

      /* 拖分组标题栏：整组一起移动 */
      const ghead = t.closest<HTMLElement>('[data-group-head]');
      if (ghead && !t.closest('button') && !t.closest('[contenteditable="true"]')) {
        const g = canvasItems(s).find((x) => x.id === ghead.dataset.groupHead);
        if (!g) return;
        e.preventDefault();
        const origin: Record<string, { x: number; y: number }> = {};
        [g, ...canvasItems(s).filter((x) => x.kind !== 'group' && inGroup(x, g))].forEach((x) => (origin[x.id] = { x: x.x, y: x.y }));
        actRef.current = { mode: 'move', sx: e.clientX, sy: e.clientY, k: v.k, origin, moved: false };
        document.body.classList.add('cvs-acting');
        return;
      }

      /* 点连线：选中它（在元素之前判断，因为线在底层） */
      const linkEl = t.closest<SVGElement>('.cvs-link-hit, .cvs-link');
      if (linkEl) {
        const id = linkEl.dataset.link || null;
        setState((st) => {
          st.linkSel = st.linkSel === id ? null : id;
          st.canvasSel = [];
        });
        return;
      }
      if (el) setState((st) => void (st.linkSel = null));

      /* 连线模式：点谁就连到谁 */
      if (s.linkFrom) {
        op.linkTo(el?.dataset.id || null);
        return;
      }

      /* 右下角手柄：改元素尺寸 */
      const grip = t.closest<HTMLElement>('[data-grip]');
      if (grip) {
        const it = canvasItems(s).find((x) => x.id === grip.dataset.grip);
        if (!it) return;
        e.preventDefault();
        e.stopPropagation();
        actRef.current = { mode: 'resize', id: it.id, sx: e.clientX, sy: e.clientY, w0: cvsItemW(it), k: v.k, moved: false };
        document.body.classList.add('cvs-acting');
        return;
      }

      /* 正在编辑的文字：让光标正常工作 */
      if (el && s.editTextId === el.dataset.id && t.closest('textarea, .cvs-text-body')) return;
      if (t.closest('button')) return;

      if (el) {
        const id = el.dataset.id!;
        const isSel = s.canvasSel.includes(id);
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        let nextSel = s.canvasSel;
        if (additive) nextSel = isSel ? s.canvasSel.filter((x) => x !== id) : [...s.canvasSel, id];
        else if (!isSel) nextSel = [id];
        if (nextSel !== s.canvasSel) {
          setState((st) => void (st.canvasSel = nextSel));
          op.agentResync();
        }
        e.preventDefault();
        const origin: Record<string, { x: number; y: number }> = {};
        for (const x of canvasItems(getState())) if (nextSel.includes(x.id)) origin[x.id] = { x: x.x, y: x.y };
        /* 点在已选中的元素上且没拖动：松手时收窄成只选它（多选拖动不受影响） */
        const collapseTo = !additive && isSel && s.canvasSel.length > 1 ? id : undefined;
        actRef.current = { mode: 'move', sx: e.clientX, sy: e.clientY, k: v.k, origin, moved: false, collapseTo };
        document.body.classList.add('cvs-acting');
        return;
      }

      /* 只剩「在空白处拖」：框选 */
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const rect = vp.getBoundingClientRect();
      actRef.current = {
        mode: 'marquee',
        sx: e.clientX,
        sy: e.clientY,
        ox: e.clientX - rect.left,
        oy: e.clientY - rect.top,
        additive: e.shiftKey || e.ctrlKey || e.metaKey,
        base: e.shiftKey || e.ctrlKey || e.metaKey ? s.canvasSel.slice() : [],
        moved: false,
      };
      document.body.classList.add('cvs-acting');
    };

    let raf = 0;
    const onMove = (e: MouseEvent) => {
      const a = actRef.current;
      if (!a) return;
      const dx = e.clientX - a.sx;
      const dy = e.clientY - a.sy;
      if (!a.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      a.moved = true;
      if (a.mode === 'draw') {
        const rect = vp.getBoundingClientRect();
        const v = op.currentView();
        const p = toWorld(v, rect, e.clientX, e.clientY);
        a.pts.push([p.x, p.y]);
        let svg = vp.querySelector<SVGSVGElement>('#cvsPenPreview');
        if (!svg) {
          svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.id = 'cvsPenPreview';
          svg.setAttribute('class', 'cvs-pen-preview');
          vp.appendChild(svg);
        }
        const pen = getState().cvsPen;
        svg.setAttribute('viewBox', `${-v.x / v.k} ${-v.y / v.k} ${vp.clientWidth / v.k} ${vp.clientHeight / v.k}`);
        svg.innerHTML = `<polyline points="${a.pts.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${pen.color}" stroke-width="${pen.lw}" stroke-linecap="round" stroke-linejoin="round" />`;
        return;
      }
      if (a.mode === 'pan') {
        const v = op.currentView();
        op.live.view = { ...v, x: a.ox + dx, y: a.oy + dy };
        applyView(op.live.view);
        return;
      }
      if (a.mode === 'resize') {
        const n = worldRef.current?.querySelector<HTMLElement>(`.cvs-el[data-id="${a.id}"]`);
        const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        if (n) n.style.width = `${Math.round(clamp(a.w0 + d / a.k, CVS_W_MIN, CVS_W_MAX))}px`;
        syncLinksLive();
        return;
      }
      if (a.mode === 'marquee') {
        a.ex = e.clientX;
        a.ey = e.clientY;
        const r = marqueeRect(a, e.clientX, e.clientY);
        let box = vp.querySelector<HTMLDivElement>('#cvsMarquee');
        if (!box) {
          box = document.createElement('div');
          box.id = 'cvsMarquee';
          box.className = 'cvs-marquee';
          vp.appendChild(box);
        }
        box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            const cur = actRef.current;
            if (cur?.mode !== 'marquee') return;
            const ids = hitIds(cur, marqueeRect(cur, cur.ex!, cur.ey!));
            const prev = getState().canvasSel;
            if (ids.length !== prev.length || ids.some((x, i) => x !== prev[i])) setState((st) => void (st.canvasSel = ids));
          });
        }
        return;
      }
      /* move */
      a.ex = e.clientX;
      a.ey = e.clientY;
      for (const id of Object.keys(a.origin)) {
        const n = worldRef.current?.querySelector<HTMLElement>(`.cvs-el[data-id="${id}"]`);
        if (!n) continue;
        const o = a.origin[id];
        n.style.left = `${Math.round(o.x + dx / a.k)}px`;
        n.style.top = `${Math.round(o.y + dy / a.k)}px`;
      }
      syncLinksLive();
      setHot(refZoneAt(e.clientX, e.clientY));
    };

    const onUp = (e: MouseEvent) => {
      const a = actRef.current;
      if (!a) return;
      actRef.current = null;
      document.body.classList.remove('cvs-acting');
      if (a.mode === 'draw') {
        vp.querySelector('#cvsPenPreview')?.remove();
        if (a.moved && a.pts.length > 1) op.addDrawing(a.pts, getState().cvsPen.color, getState().cvsPen.lw);
        return;
      }
      if (a.mode === 'pan') {
        if (a.moved) commitView();
        else {
          const s = getState();
          if (s.canvasSel.length || s.cvsPop) setState((st) => void ((st.canvasSel = []), (st.cvsPop = null)));
        }
        return;
      }
      if (a.mode === 'resize') {
        const n = worldRef.current?.querySelector<HTMLElement>(`.cvs-el[data-id="${a.id}"]`);
        if (a.moved && n) op.resizeItem(a.id, parseFloat(n.style.width));
        return;
      }
      if (a.mode === 'marquee') {
        vp.querySelector('#cvsMarquee')?.remove();
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (!a.moved) {
          if (!a.additive && getState().canvasSel.length) setState((st) => void (st.canvasSel = []));
          op.agentResync();
          return;
        }
        const ids = hitIds(a, marqueeRect(a, e.clientX, e.clientY));
        setState((st) => void (st.canvasSel = ids));
        op.agentResync();
        return;
      }
      if (!a.moved) {
        if (a.collapseTo) {
          const id = a.collapseTo;
          setState((st) => void (st.canvasSel = [id]));
          op.agentResync();
        }
        return;
      }
      /* 松手时落在参考素材区：加入参考，位置不动 */
      const zone = refZoneAt(e.clientX, e.clientY);
      setHot(null);
      if (zone) {
        const world = worldRef.current;
        for (const [id, o] of Object.entries(a.origin)) {
          const n = world?.querySelector<HTMLElement>(`.cvs-el[data-id="${id}"]`);
          if (n) {
            n.style.left = `${o.x}px`;
            n.style.top = `${o.y}px`;
          }
        }
        syncLinksLive();
        op.toRefs(Object.keys(a.origin));
        return;
      }
      const dx = e.clientX - a.sx;
      const dy = e.clientY - a.sy;
      const pos: Record<string, { x: number; y: number }> = {};
      for (const [id, o] of Object.entries(a.origin)) pos[id] = { x: o.x + dx / a.k, y: o.y + dy / a.k };
      op.moveItems(pos);
    };

    /* 以鼠标位置为锚点缩放 */
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = op.currentView();
      const rect = vp.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      /* 触控板捏合（ctrlKey）步子小一点；普通滚轮一格 12% */
      const factor = e.ctrlKey ? Math.exp(-e.deltaY / 100) : e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const k2 = Math.round(clamp(v.k * factor, CVS_K_MIN, CVS_K_MAX) * 100) / 100;
      if (k2 === v.k) return;
      op.live.view = { x: mx - ((mx - v.x) / v.k) * k2, y: my - ((my - v.y) / v.k) * k2, k: k2 };
      applyView(op.live.view);
      commitView();
    };

    const onContext = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!vp.contains(t) || t.closest('.cvs-menu, .cvs-pop, .cvs-link-input')) return;
      e.preventDefault();
      const el = t.closest<HTMLElement>('.cvs-el');
      const linkEl = t.closest<SVGElement>('.cvs-link-hit, .cvs-link');
      const rect = vp.getBoundingClientRect();
      setState((st) => {
        if (linkEl) {
          st.linkSel = linkEl.dataset.link || null;
          st.canvasSel = [];
        } else if (el) {
          st.linkSel = null;
          if (!st.canvasSel.includes(el.dataset.id!)) st.canvasSel = [el.dataset.id!];
        } else {
          st.canvasSel = [];
          st.linkSel = null;
        }
        st.cvsPop = null;
        st.cvsMenu = { x: Math.max(6, e.clientX - rect.left), y: Math.max(6, e.clientY - rect.top) };
      });
    };

    /* 双击进入文字编辑：节点和文字共用 */
    const onDbl = (e: MouseEvent) => {
      const box = (e.target as HTMLElement).closest<HTMLElement>('.cvs-el');
      if (!box || !vp.contains(box)) return;
      const it = canvasItems(getState()).find((x) => x.id === box.dataset.id);
      if (!it || (it.kind !== 'node' && it.kind !== 'text')) return;
      e.preventDefault();
      setState((st) => void (st.editTextId = it.id));
    };

    document.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('contextmenu', onContext);
    document.addEventListener('dblclick', onDbl);
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('contextmenu', onContext);
      document.removeEventListener('dblclick', onDbl);
      vp.removeEventListener('wheel', onWheel);
    };
  }, [ws]);

  /* ---------------- 拖放：本地文件、链接、素材库与收件箱里的产出 ---------------- */
  const [dropOn, setDropOn] = useState<'' | 'rid' | 'file'>('');
  const hasFiles = (dt: DataTransfer) => [...(dt.types || [])].includes('Files');
  const hasLink = (dt: DataTransfer) => [...(dt.types || [])].includes('text/uri-list');
  const onDragOver = (e: React.DragEvent) => {
    const rid = getState().dragRid;
    if (!rid && !hasFiles(e.dataTransfer) && !hasLink(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropOn(rid ? 'rid' : 'file');
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropOn('');
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) {
      void op.addLocalFiles(files, e.clientX, e.clientY);
      return;
    }
    const rid = getState().dragRid || e.dataTransfer.getData('text/x-aigc-rid');
    setState((st) => void (st.dragRid = null));
    if (rid && resultById(getState(), rid)) {
      op.keepResult(rid, op.dropPoint(e.clientX, e.clientY));
      return;
    }
    const link = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (link && /^https?:\/\//i.test(link.trim())) void op.addLink(link.trim().split('\n')[0], e.clientX, e.clientY);
  };

  const v = board.view;
  const groupCount = (g: CanvasItem) => items.filter((x) => x.kind !== 'group' && inGroup(x, g)).length;
  const sorted = items.map((it, idx) => ({ it, idx })).sort((a, b) => (a.it.z ?? 100 + a.idx) - (b.it.z ?? 100 + b.idx));
  const center = (id: string) => {
    const it = items.find((x) => x.id === id);
    return it ? cvsCenter(it) : null;
  };

  return (
    <div className="cvs-panel">
      <div className="cvs-head">
        <span className="cvs-head-ic">
          <Icon name="layers" />
        </span>
        <div className="cvs-head-txt">
          <b>画布</b>
          <span>{items.length ? `${media} 个素材` : '把图片丢进来，随手可用'}</span>
        </div>
        <span className="grow" />
        {sel.length > 0 && <span className="cvs-sel-chip">已选 {sel.length} 项</span>}
        <button className="icon-btn" title="撤销（Ctrl+Z）" disabled={!histN} onClick={undo}>
          <Icon name="undo" />
        </button>
        <button className="icon-btn" title="重做（Ctrl+Shift+Z）" disabled={!futN} onClick={redo}>
          <Icon name="redo" />
        </button>
        <button className="icon-btn" title="从电脑选文件" onClick={() => void uploadFromMenu()}>
          <Icon name="upload" />
        </button>
        <button className={`icon-btn ${pen.on ? 'on' : ''}`} title="手绘标注（B）" onClick={op.togglePen}>
          <Icon name="pen" />
        </button>
        <button className="icon-btn" title="保存画板" onClick={op.saveBoardFile}>
          <Icon name="download" />
        </button>
        <button className="icon-btn" title="导入画板" onClick={() => void op.loadBoardFile()}>
          <Icon name="box" />
        </button>
        <button className="icon-btn" title="整理成网格" onClick={op.arrange}>
          <Icon name="grid" />
        </button>
        <button className="icon-btn" title="适应窗口（F）" onClick={() => op.fitAll()}>
          <Icon name="expand" />
        </button>
        <button className="icon-btn" title="回到原点（0）" onClick={op.resetView}>
          <Icon name="target" />
        </button>
        <button
          className={`icon-btn ${full ? 'on' : ''}`}
          title={full ? '退出专注（Esc）' : '专注模式'}
          onClick={() => setState((s) => void ((s.cvsFull = !s.cvsFull), (s.canvasOpen = true)))}
        >
          <Icon name="eye" />
        </button>
        {!full && (
          <button className="icon-btn" title="收起画布" onClick={op.toggleCanvas}>
            <Icon name="chev-right" />
          </button>
        )}
      </div>
      <InboxBar results={results} />
      {pen.on && (
        <div className="cvs-penbar">
          <span className="cvs-penbar-label">
            <Icon name="pen" />
            画笔
          </span>
          {PEN_COLORS.map((c) => (
            <button key={c} className={`cvs-swatch ${pen.color === c ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => setState((s) => void (s.cvsPen.color = c))} />
          ))}
          <span className="cvs-penbar-sep" />
          {[2, 4, 7].map((w) => (
            <button key={w} className={`cvs-lw ${pen.lw === w ? 'on' : ''}`} title={`${w}px`} onClick={() => setState((s) => void (s.cvsPen.lw = w))}>
              <i style={{ height: w }} />
            </button>
          ))}
          <span className="grow" />
          <span className="tiny dim">拖动即可标注 · 按 B 或 Esc 退出</span>
        </div>
      )}
      <div
        className={`cvs-viewport ${dropOn ? 'drop-on' : ''} ${dropOn === 'file' ? 'drop-file' : ''} ${pen.on ? 'pen-on' : ''} ${space ? 'space-on' : ''}`}
        id="cvsViewport"
        ref={vpRef}
        onDragOver={onDragOver}
        onDragLeave={(e) => !vpRef.current?.contains(e.relatedTarget as Node) && setDropOn('')}
        onDrop={onDrop}
      >
        <div className="cvs-grid" id="cvsGrid" ref={gridRef} style={gridStyle(v)} />
        <div className="cvs-world" id="cvsWorld" ref={worldRef} style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.k})` }}>
          <svg className="cvs-links" id="cvsLinks" viewBox="-2000 -2000 8000 8000">
            <defs>
              <marker id="cvsArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {board.links.map((l) => {
              const a = center(l.from);
              const b = center(l.to);
              if (!a || !b) return null;
              const d = linkPath(a, b);
              return (
                <g key={l.id}>
                  <path className="cvs-link-hit" data-link={l.id} d={d} />
                  <path className={`cvs-link ${linkSel === l.id ? 'sel' : ''}`} data-link={l.id} d={d} markerEnd="url(#cvsArrow)" />
                </g>
              );
            })}
          </svg>
          {sorted.map(({ it, idx }) => (
            <CanvasEl
              key={it.id}
              it={it}
              idx={idx}
              sel={sel.includes(it.id)}
              saved={!!it.rid && savedToLib(getState(), it.rid)}
              editing={editTextId === it.id}
              anchor={board.anchor?.cvsId === it.id}
              groupCount={it.kind === 'group' ? groupCount(it) : 0}
            />
          ))}
          <svg className="cvs-links cvs-links-top" id="cvsLinksTop" viewBox="-2000 -2000 8000 8000">
            {board.links.map((l) => {
              if (!l.label || linkLabelEdit === l.id) return null;
              const a = center(l.from);
              const b = center(l.to);
              if (!a || !b) return null;
              const m = linkMid(a, b);
              const w = Math.max(30, l.label.length * 11 + 14);
              return (
                <g key={l.id} className="cvs-link-tag" data-link={l.id}>
                  <rect x={m.x - w / 2} y={m.y - 11} width={w} height={22} rx={11} />
                  <text x={m.x} y={m.y + 4} textAnchor="middle">
                    {l.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <ParamsPop />
        <LinkLabelInput />
        <CanvasMenu />
        {!items.length && (
          <div className="cvs-blank">
            <div className="cvs-blank-ic">
              <Icon name="layers" />
            </div>
            <div className="cvs-blank-t">画布还空着</div>
            <div className="cvs-blank-d">
              从素材库把产出拖过来，或者直接拖本地文件、<b>Ctrl+V</b> 贴截图。
              <br />
              粘贴网址和帖子链接也能放进来自动识别。<b>右键</b>是全部操作。
            </div>
          </div>
        )}
      </div>
      {linkFrom && (
        <div className="cvs-hint-bar">
          <Icon name="link" />
          <span>连线中 · 点一个元素把它连过来</span>
          <span className="grow" />
          <button className="btn sm ghost" onClick={() => setState((s) => void (s.linkFrom = null))}>
            取消
          </button>
        </div>
      )}
      <DivergePanel />
      <PlatformPanel />
      <CanvasFoot zoomRef={zoomRef} />
    </div>
  );
}

/* ---------------- 收件箱：最新一批生成结果停在这里 ---------------- */

function InboxBar({ results }: { results: ReturnType<typeof getState>['results'] }) {
  const ws = useStore((s) => s.ws);
  const list = results.filter((r) => r.home === 'inbox' && r.ws === ws);
  if (!list.length) return null;
  return (
    <div className="cvs-inbox" id="cvsInbox">
      <div className="cvs-inbox-head">
        <Icon name="inbox" />
        <b>最新生成</b>
        <span className="cvs-inbox-n num">{list.length} 项</span>
        <span className="grow" />
        <span className="cvs-inbox-hint">拖进画布留用，不拖的下次生成时进草稿箱</span>
        <button className="btn sm ghost" onClick={() => void op.dropInbox()}>
          <Icon name="trash" />
          全部不收
        </button>
      </div>
      <div className="cvs-inbox-strip">
        {list.map((r) => (
          <div
            key={r.id}
            className="cvs-inbox-card"
            draggable
            title={`${r.title} · 拖进画布`}
            onDragStart={(e) => {
              setState((s) => void (s.dragRid = r.id));
              document.body.classList.add('cvs-dragging');
              e.dataTransfer.effectAllowed = 'copy';
              e.dataTransfer.setData('text/x-aigc-rid', r.id);
            }}
            onDragEnd={() => {
              setState((s) => void (s.dragRid = null));
              document.body.classList.remove('cvs-dragging');
            }}
          >
            {thumbOf(r) ? <img src={thumbOf(r)} alt="" draggable={false} /> : r.type === 'video' ? <video src={`${r.src}#t=0.1`} muted preload="metadata" /> : <div className="audio-tile sm"><Icon name="waveform" /></div>}
            <span className={`cvs-kind k-${r.type}`}>
              <Icon name={TYPES[r.type].ic} />
            </span>
            <button className="cvs-inbox-add" title="放进画布" onClick={() => op.keepResult(r.id)}>
              <Icon name="plus" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- 生成参数浮层 ---------------- */

function ParamsPop() {
  const pop = useStore((s) => s.cvsPop);
  const s = useStore();
  if (!pop) return null;
  const r = resultById(s, pop.rid);
  if (!r) return null;
  const j = jobById(s, r.job);
  const rows: [string, string, boolean?][] = [
    ['标题', r.title],
    ['模型', modelOf(s, r.model).name],
  ];
  if (j) {
    rows.push(['提示词', j.prompt, true]);
    rows.push(['参数', paramsBrief(j)]);
    if (j.refs.length) rows.push(['参考图', `${j.refs.length} 项`]);
    rows.push(['消耗', modelOf(s, r.model).usageBilling ? '按实际用量' : `${j.cost} 点`]);
    rows.push(['来源任务', j.name]);
    rows.push(['完成时间', timeLabel(j.finishedAt || j.createdAt)]);
  } else {
    rows.push(['来源', '在编辑器中修改后保存']);
    rows.push(['改动', (r.tags || []).join(' · ') || '—']);
    rows.push(['时间', timeLabel(r.createdAt)]);
  }
  rows.push(['随机种子', String(r.seed)]);
  return (
    <div className="cvs-pop" style={{ left: pop.sx, top: pop.sy }}>
      <div className="cvs-pop-head">
        <Icon name="cpu" />
        <b>生成参数</b>
        <span className="grow" />
        <button className="icon-btn" onClick={() => setState((st) => void (st.cvsPop = null))}>
          <Icon name="x" />
        </button>
      </div>
      <div className="cvs-pop-body">
        {rows.map(([k, val, wide]) => (
          <div key={k} className={`cvs-pop-row ${wide ? 'wide' : ''}`}>
            <span className="cpk">{k}</span>
            <span className={`cpv ${wide ? 'prompt' : ''}`}>{val}</span>
          </div>
        ))}
      </div>
      <div className="cvs-pop-foot">
        {j && (
          <>
            <button className="btn sm ghost" onClick={() => copyPromptOf(r.id)}>
              <Icon name="copy" />
              复制提示词
            </button>
            <button className="btn sm primary" onClick={() => reuseParams(r.id)}>
              <Icon name="wand" />
              按这套再来一次
            </button>
          </>
        )}
        <span className="grow" />
        <button className="icon-btn" title="完整详情" onClick={() => openResult(r.id)}>
          <Icon name="more" />
        </button>
      </div>
    </div>
  );
}

/* ---------------- 给线写名字 ---------------- */

function LinkLabelInput() {
  const id = useStore((s) => s.linkLabelEdit);
  const board = useStore((s) => boardOf(s));
  const [val, setVal] = useState('');
  const l = board.links.find((x) => x.id === id);
  useEffect(() => setVal(l?.label || ''), [id]);
  if (!id || !l) return null;
  const a = board.items.find((x) => x.id === l.from);
  const b = board.items.find((x) => x.id === l.to);
  if (!a || !b) return null;
  const v = op.currentView();
  const m = linkMid(cvsCenter(a), cvsCenter(b));
  return (
    <div className="cvs-link-input" style={{ left: Math.round(m.x * v.k + v.x), top: Math.round(m.y * v.k + v.y) }}>
      <input
        autoFocus
        value={val}
        maxLength={12}
        placeholder="这条线是什么意思…"
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') op.linkLabelSave(val);
          if (e.key === 'Escape') setState((s) => void (s.linkLabelEdit = null));
        }}
      />
      <button className="btn sm primary" onClick={() => op.linkLabelSave(val)}>
        确定
      </button>
    </div>
  );
}

/* ---------------- 右键菜单 ---------------- */

function CanvasMenu() {
  const m = useStore((s) => s.cvsMenu);
  useStore((s) => s.canvasSel);
  useStore((s) => s.linkSel);
  useStore((s) => s.canvasConfirm);
  useStore((s) => s.cvsPen.on);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const vp = op.viewportEl();
    if (!m || !el || !vp) return;
    const x = Math.min(m.x, Math.max(6, vp.clientWidth - el.offsetWidth - 8));
    const y = Math.min(m.y, Math.max(6, vp.clientHeight - el.offsetHeight - 8));
    setPos({ x, y });
  }, [m]);
  if (!m) return null;
  const items = menuItems();
  return (
    <div className="cvs-menu" ref={ref} style={{ left: pos?.x ?? m.x, top: pos?.y ?? m.y }}>
      {items.map((it, i) =>
        'sep' in it ? (
          <div key={i} className="cvs-menu-sep" />
        ) : 'label' in it ? (
          <div key={i} className="cvs-menu-label">
            {it.label}
          </div>
        ) : (
          <button
            key={i}
            className={`cvs-menu-item ${it.danger ? 'danger' : ''}`}
            onClick={() => {
              it.run();
              if (it.t !== '清空画板') setState((s) => void (s.cvsMenu = null));
            }}
          >
            <span>{it.t}</span>
            {it.k && <span className="cvs-menu-key">{it.k}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/* ---------------- 底部操作条 ---------------- */

function CanvasFoot({ zoomRef }: { zoomRef: React.RefObject<HTMLSpanElement | null> }) {
  const s = useStore();
  const sel = canvasItems(s).filter((i) => s.canvasSel.includes(i.id));
  const k = boardOf(s).view.k;
  const zoom = (
    <span className="cvs-zoom num" ref={zoomRef}>
      {Math.round((op.live.ws === s.ws && op.live.view ? op.live.view.k : k) * 100)}%
    </span>
  );
  if (!sel.length) {
    return (
      <div className="cvs-foot">
        <span className="cvs-foot-hint">
          <Icon name="target" />
          从素材库拖进来 · 拖空白框选 · 空格拖平移 · 滚轮缩放 · 右键更多
        </span>
        <span className="grow" />
        {zoom}
      </div>
    );
  }
  const hasMedia = sel.some((i) => i.kind === 'media');
  const unsaved = sel.filter((i) => i.rid && !savedToLib(s, i.rid)).length;
  return (
    <div className="cvs-foot on">
      <span className="cvs-foot-count">
        已选 <b className="num">{sel.length}</b> 项
      </span>
      {zoom}
      <button className="btn sm ghost cvs-clear" onClick={op.clearSel}>
        <Icon name="x" />
        取消选择
      </button>
      <div className="cvs-use-row">
        {(hasMedia || sel.some((i) => i.kind === 'text' || i.kind === 'node')) &&
          TYPE_KEYS.map((t) => (
            <button key={t} className="btn sm soft" onClick={() => op.canvasUse(t)}>
              <Icon name={TYPES[t].ic} />
              带去做{TYPES[t].name}
            </button>
          ))}
        {unsaved > 0 && (
          <>
            <span className="cvs-use-sep" />
            <button className="btn sm primary" onClick={op.saveSelToLib}>
              <Icon name="check" />
              保存到素材库{unsaved > 1 ? ` ${unsaved} 项` : ''}
            </button>
          </>
        )}
        {sel.length === 1 && sel[0].kind === 'media' && (
          <>
            <span className="cvs-use-sep" />
            <button className="btn sm ai" onClick={op.divergeOpen}>
              <Icon name="sparkles" />
              发散
            </button>
            {sel[0].type === 'image' && (
              <button className="btn sm ghost" onClick={op.platformsOpen}>
                <Icon name="crop" />
                适配平台
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- 发散 / 适配面板 ---------------- */

function DivergePanel() {
  const s = useStore();
  const d = s.diverge;
  if (!d) return null;
  const it = canvasItems(s).find((i) => i.id === d.srcId);
  if (!it || !it.type) return null;
  const p = s.params[it.type];
  const unit = singleUnitCost(it.type, p, modelOf(s, p.model));
  const picked = d.axes.length;
  const base = op.sourceBase(s, it);
  return (
    <div className="diverge-panel">
      <div className="diverge-head">
        <span className="diverge-ic">
          <Icon name="sparkles" />
        </span>
        <div className="diverge-title">
          <b>发散</b>
          <span>从「{it.t}」沿不同方向各试一个</span>
        </div>
        <span className="grow" />
        <button className="icon-btn" onClick={() => setState((st) => void (st.diverge = null))}>
          <Icon name="x" />
        </button>
      </div>
      <div className="diverge-body">
        <div className="diverge-base">
          <Icon name="pen" />
          <span>
            {base.slice(0, 70)}
            {base.length > 70 ? '…' : ''}
          </span>
        </div>
        <div className="diverge-axes">
          {DIVERGE_AXES.map((a) => (
            <button
              key={a.k}
              className={`diverge-axis ${d.axes.includes(a.k) ? 'on' : ''}`}
              onClick={() => setState((st) => void (st.diverge && (st.diverge.axes = st.diverge.axes.includes(a.k) ? st.diverge.axes.filter((x) => x !== a.k) : [...st.diverge.axes, a.k])))}
            >
              <span className="da-check">{d.axes.includes(a.k) && <Icon name="check" />}</span>
              <span className="da-main">
                <b>{a.n}</b>
                <span>{a.d}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="diverge-note">
          <Icon name="alert" />
          <span>发散出来的是不同方向，不是同一张图的多次采样——要精度用「变体」，要可能性用发散。</span>
        </div>
      </div>
      <div className="diverge-foot">
        <span className="diverge-cost">{picked ? `${picked} 个方向 · 约 ${round1(unit * picked)} 点` : '先选方向'}</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => setState((st) => void (st.diverge = null))}>
          取消
        </button>
        <button className={`btn sm primary ${picked ? '' : 'disabled'}`} disabled={!picked} onClick={() => void op.divergeRun()}>
          <Icon name="wand" />
          开始发散
        </button>
      </div>
    </div>
  );
}

function PlatformPanel() {
  const s = useStore();
  const d = s.platforms;
  if (!d) return null;
  const it = canvasItems(s).find((i) => i.id === d.srcId);
  if (!it) return null;
  const p = s.params.image;
  const unit = singleUnitCost('image', p, modelOf(s, p.model));
  const picked = d.picks.length;
  const base = op.sourceBase(s, it);
  return (
    <div className="diverge-panel">
      <div className="diverge-head">
        <span className="diverge-ic">
          <Icon name="crop" />
        </span>
        <div className="diverge-title">
          <b>适配多平台</b>
          <span>从「{it.t}」按各平台比例各出一版</span>
        </div>
        <span className="grow" />
        <button className="icon-btn" onClick={() => setState((st) => void (st.platforms = null))}>
          <Icon name="x" />
        </button>
      </div>
      <div className="diverge-body">
        <div className="diverge-base">
          <Icon name="pen" />
          <span>
            {base.slice(0, 70)}
            {base.length > 70 ? '…' : ''}
          </span>
        </div>
        <div className="diverge-axes">
          {PLATFORMS.map((pf) => (
            <button
              key={pf.k}
              className={`diverge-axis ${d.picks.includes(pf.k) ? 'on' : ''}`}
              onClick={() =>
                setState((st) => void (st.platforms && (st.platforms.picks = st.platforms.picks.includes(pf.k) ? st.platforms.picks.filter((x) => x !== pf.k) : [...st.platforms.picks, pf.k])))
              }
            >
              <span className="da-check">{d.picks.includes(pf.k) && <Icon name="check" />}</span>
              <span className="da-main">
                <b>
                  <Icon name={pf.ic} />
                  {pf.n} · {pf.ratio}
                </b>
                <span>{pf.note}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="diverge-note">
          <Icon name="alert" />
          <span>每个比例都是重新构图，不是把原图裁一刀——裁剪会把主体切掉，重出才能保证每个尺寸都成立。</span>
        </div>
      </div>
      <div className="diverge-foot">
        <span className="diverge-cost">{picked ? `${picked} 个平台 · 约 ${round1(unit * picked)} 点` : '先选平台'}</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => setState((st) => void (st.platforms = null))}>
          取消
        </button>
        <button className={`btn sm primary ${picked ? '' : 'disabled'}`} disabled={!picked} onClick={() => void op.platformsRun()}>
          <Icon name="wand" />
          开始适配
        </button>
      </div>
    </div>
  );
}
