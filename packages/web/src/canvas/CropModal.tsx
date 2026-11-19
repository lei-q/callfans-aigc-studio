import { useEffect, useRef, useState } from 'react';
import type { Result } from '@aigc/shared';
import { Icon } from '../components/common';
import { api } from '../lib/api';
import { getState, setState, useStore } from '../store';
import { canvasItems } from '../store/selectors';
import { toast, toastError } from '../store/toast';
import { CROP_RATIOS, clampRect, maxRect, ratioNum, resizeRect, type CropRect } from './cropMath';
import { ensureRid, placeDerived } from './ops';

/* ============================================================================
   裁切 / 平台尺寸：在浏览器里本机裁图，不调模型、不扣点。
   一次可以选多个比例，每个比例的裁切框可以单独拖动 / 缩放（比例锁定）；
   每个成品都是一条新产出，摆在原图下面一排并连回原图，原图不变。
   ========================================================================== */


const MAX_OUT = 3000;

export function CropModal() {
  const s = useStore();
  const d = s.crop;
  const it = d ? canvasItems(s).find((i) => i.id === d.srcId) : undefined;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [picks, setPicks] = useState<string[]>(['1:1', '4:5', '16:9']);
  const [active, setActive] = useState('1:1');
  const [rects, setRects] = useState<Record<string, CropRect>>({});
  const [busy, setBusy] = useState('');
  const drag = useRef<{ mode: 'move' | 'size'; sx: number; sy: number; rc: CropRect } | null>(null);

  useEffect(() => {
    if (!it?.src) return;
    setImg(null);
    setLoadErr('');
    setRects({});
    const im = new Image();
    im.onload = () => setImg(im);
    im.onerror = () => setLoadErr('图片读不出来：文件可能已被删除');
    im.src = it.src;
  }, [it?.id, it?.src]);

  if (!d || !it) return null;
  const close = () => setState((st) => void (st.crop = null));
  const W = img?.naturalWidth || 0;
  const H = img?.naturalHeight || 0;
  const k = W ? Math.min(640 / W, 420 / H, 1) : 1;
  const rectOf = (ratio: string): CropRect => rects[ratio] || maxRect(W, H, ratioNum(ratio));
  const r = ratioNum(active);
  const rc = W ? rectOf(active) : { x: 0, y: 0, w: 0 };
  const h = rc.w / r;

  const onDown = (mode: 'move' | 'size') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, rc };
  };
  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g || !W) return;
    const dx = (e.clientX - g.sx) / k;
    const dy = (e.clientY - g.sy) / k;
    const next = g.mode === 'move' ? clampRect({ ...g.rc, x: g.rc.x + dx, y: g.rc.y + dy }, W, H, r) : resizeRect(g.rc, Math.abs(dx) > Math.abs(dy) * r ? dx : dy * r, W, H, r);
    setRects((cur) => ({ ...cur, [active]: next }));
  };
  const onUp = () => (drag.current = null);

  const toggle = (ratio: string) => {
    setActive(ratio);
    setPicks((p) => (p.includes(ratio) ? (p.length > 1 && ratio === active ? p.filter((x) => x !== ratio) : p) : [...p, ratio]));
  };

  const run = async () => {
    if (!img || !picks.length) return;
    const rid = await ensureRid(it.id);
    if (!rid) return;
    const ws = getState().ws;
    const made: Result[] = [];
    try {
      for (const [i, ratio] of picks.entries()) {
        setBusy(`正在裁切 ${i + 1}/${picks.length}（${ratio}）…`);
        const c = rectOf(ratio);
        const ch = c.w / ratioNum(ratio);
        const scale = Math.min(1, MAX_OUT / Math.max(c.w, ch));
        const ow = Math.max(1, Math.round(c.w * scale));
        const oh = Math.max(1, Math.round(ch * scale));
        const cv = document.createElement('canvas');
        cv.width = ow;
        cv.height = oh;
        cv.getContext('2d')!.drawImage(img, c.x, c.y, c.w, ch, 0, 0, ow, oh);
        const png = /\.png(\?|$)/i.test(it.src || '');
        const dataUrl = cv.toDataURL(png ? 'image/png' : 'image/jpeg', 0.92);
        const { result } = await api.post<{ result: Result }>('/api/results/edited', {
          sourceId: rid,
          ws,
          title: `${(it.t || '素材').replace(/（已编辑）$/, '')} · ${ratio}`,
          tags: ['裁切', ratio],
          edit: { ops: { crop: { ratio, x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(ch) } } },
          dataUrl,
          ratio,
        });
        made.push(result);
      }
      placeDerived(it.id, made);
      toast('success', `已裁出 ${made.length} 张`, `${picks.join(' · ')}，摆在原图下面并连回原图；原图没有改动，成品也在素材库里`);
      close();
    } catch (e) {
      if (made.length) placeDerived(it.id, made);
      toastError(e, made.length ? `裁到第 ${made.length + 1} 张时失败（前面 ${made.length} 张已保存）` : '裁切失败');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="modal-card crop-modal">
        <div className="modal-head">
          <Icon name="crop" />
          <b>裁切 / 平台尺寸</b>
          <span className="tiny dim">「{it.t || '素材'}」{W ? ` · ${W}×${H}` : ''}</span>
          <span className="grow" />
          <button className="icon-btn" onClick={close} disabled={!!busy}>
            <Icon name="x" />
          </button>
        </div>
        <div className="crop-body">
          <div className="crop-stage-wrap">
            {loadErr ? (
              <div className="crop-empty">{loadErr}</div>
            ) : !img ? (
              <div className="crop-empty">读取图片中…</div>
            ) : (
              <div className="crop-stage" style={{ width: W * k, height: H * k }} onPointerMove={onMove} onPointerUp={onUp}>
                <img src={it.src} alt="" draggable={false} />
                <div className="crop-shade" />
                <div
                  className="crop-box"
                  style={{ left: rc.x * k, top: rc.y * k, width: rc.w * k, height: h * k }}
                  onPointerDown={onDown('move')}
                >
                  <div className="crop-clip" style={{ backgroundImage: `url(${it.src})`, backgroundSize: `${W * k}px ${H * k}px`, backgroundPosition: `${-rc.x * k}px ${-rc.y * k}px` }} />
                  <span className="crop-tag">
                    {active} · {Math.round(rc.w)}×{Math.round(h)}
                  </span>
                  <i className="crop-handle" onPointerDown={onDown('size')} />
                </div>
              </div>
            )}
            <div className="tiny dim">拖动裁切框移位，拖右下角缩放（比例锁定）；点右边的比例切换要调整的那一个</div>
          </div>
          <div className="crop-ratios">
            {CROP_RATIOS.map((x) => (
              <button key={x.k} className={`crop-ratio ${picks.includes(x.k) ? 'on' : ''} ${active === x.k ? 'cur' : ''}`} onClick={() => toggle(x.k)}>
                <span className="cr-check">{picks.includes(x.k) && <Icon name="check" />}</span>
                <span className="cr-main">
                  <b>{x.k}</b>
                  <span>{x.note}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <span className="tiny dim">{busy || `${picks.length} 个比例 · 本机裁切，不扣点`}</span>
          <span className="grow" />
          <button className="btn sm ghost" onClick={close} disabled={!!busy}>
            取消
          </button>
          <button className="btn sm primary" onClick={() => void run()} disabled={!img || !picks.length || !!busy}>
            <Icon name="crop" />
            裁出 {picks.length} 张
          </button>
        </div>
      </div>
    </div>
  );
}
