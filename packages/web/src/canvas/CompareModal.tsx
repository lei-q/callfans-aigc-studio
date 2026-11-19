import { useRef, useState } from 'react';
import { Icon } from '../components/common';
import { setState, useStore } from '../store';
import { adoptResult, favResult } from '../store/actions';
import { canvasItems, jobById, modelOf, resultById } from '../store/selectors';

/* ============================================================================
   并排对比：把选中的 2–4 个素材摆成一排，图片共用同一个缩放 / 平移（看细节时各图对得齐），
   视频各自播放。挑出满意的直接「采用 / 收藏」，不用来回翻素材库。
   ========================================================================== */

export function CompareModal() {
  const s = useStore();
  const d = s.compare;
  const [z, setZ] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);
  if (!d) return null;
  const items = d.ids.map((id) => canvasItems(s).find((i) => i.id === id)).filter((i): i is NonNullable<typeof i> => !!i && i.kind === 'media');
  if (items.length < 2) return null;
  const close = () => setState((st) => void (st.compare = null));

  const onWheel = (e: React.WheelEvent) => {
    const k = Math.min(8, Math.max(1, z.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    setZ(k === 1 ? { k, x: 0, y: 0 } : { ...z, k });
  };
  const onDown = (e: React.PointerEvent) => {
    if (z.k === 1) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, x: z.x, y: z.y };
  };
  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (g) setZ({ ...z, x: g.x + e.clientX - g.sx, y: g.y + e.clientY - g.sy });
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal-card compare-modal">
        <div className="modal-head">
          <Icon name="grid" />
          <b>并排对比</b>
          <span className="tiny dim">{items.length} 个 · 滚轮放大、拖动平移，所有图同步</span>
          <span className="grow" />
          <button className="btn sm ghost" onClick={() => setZ({ k: 1, x: 0, y: 0 })} disabled={z.k === 1}>
            还原 {Math.round(z.k * 100)}%
          </button>
          <button className="icon-btn" onClick={close}>
            <Icon name="x" />
          </button>
        </div>
        <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
          {items.map((it, i) => {
            const r = resultById(s, it.rid);
            const j = r ? jobById(s, r.job) : undefined;
            return (
              <div key={it.id} className="compare-cell">
                <div className="compare-stage" onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} style={{ cursor: z.k > 1 ? 'grab' : 'default' }}>
                  {it.type === 'video' ? (
                    <video src={it.src} controls loop muted playsInline />
                  ) : (
                    <img src={it.thumb || it.src} alt="" draggable={false} style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.k})` }} />
                  )}
                  <span className="compare-idx num">{i + 1}</span>
                </div>
                <div className="compare-meta">
                  <b title={it.t}>{it.t || '未命名'}</b>
                  <span className="tiny dim">
                    {j ? `${modelOf(s, j.model).name} · ${j.ratio || r?.ratio || ''}${j.seed ? ` · 种子 ${j.seed}` : ''}` : r ? `${r.ratio}` : '本地素材'}
                  </span>
                  {j && (
                    <span className="tiny dim compare-prompt" title={j.prompt}>
                      {j.prompt}
                    </span>
                  )}
                </div>
                <div className="compare-ops">
                  <button className={`btn sm ${r?.status === 'adopted' ? 'ghost' : 'primary'}`} disabled={!r} onClick={() => r && adoptResult(r.id)}>
                    <Icon name="check" />
                    {r?.status === 'adopted' ? '已采用' : '采用这个'}
                  </button>
                  <button className="btn sm ghost" disabled={!r} onClick={() => r && void favResult(r.id)}>
                    <Icon name="star" />
                    {r?.status === 'fav' ? '已收藏' : '收藏'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
