import { useEffect, useRef, useState } from 'react';
import type { CreateJobBody, Job } from '@aigc/shared';
import { ratioLabel, round1, singleUnitCost } from '@aigc/shared';
import { Icon } from '../components/common';
import { api } from '../lib/api';
import { getState, setState, useStore } from '../store';
import { canAfford, uploadFiles } from '../store/actions';
import { canvasItems, modelOf, modelsFor } from '../store/selectors';
import { toast, toastError } from '../store/toast';
import { annotPrompt, boxAnnot, brushAnnot, pointAnnot, type Annot } from './annot';

/* ============================================================================
   批注改图：在图上框选 / 涂抹 / 点选要改的地方，每处写一句改法；
   生成时把原图 + 带编号的标注示意图一起作为参考图交给图像模型。
   批注按画布元素缓存在本次会话里：关掉弹层再打开还在，生成提交后清掉。
   ========================================================================== */

type Tool = 'box' | 'brush' | 'point';

/** 把原图和标注画成一张示意图（红框 / 涂抹 / 圆点 + 编号），长边不超过 1600 */
async function renderOverlay(img: HTMLImageElement, annots: Annot[]): Promise<Blob> {
  const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * k);
  const H = Math.round(img.naturalHeight * k);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  g.drawImage(img, 0, 0, W, H);
  const lw = Math.max(3, Math.round(Math.max(W, H) / 280));
  g.lineWidth = lw;
  g.strokeStyle = '#E11D48';
  g.fillStyle = 'rgba(225, 29, 72, .28)';
  g.lineJoin = g.lineCap = 'round';
  for (const a of annots) {
    if (a.kind === 'box') {
      g.fillRect(a.x * W, a.y * H, a.w * W, a.h * H);
      g.strokeRect(a.x * W, a.y * H, a.w * W, a.h * H);
    } else if (a.kind === 'brush' && a.pts) {
      g.save();
      g.lineWidth = lw * 5;
      g.strokeStyle = 'rgba(225, 29, 72, .42)';
      g.beginPath();
      a.pts.forEach(([px, py], i) => (i ? g.lineTo(px * W, py * H) : g.moveTo(px * W, py * H)));
      g.stroke();
      g.restore();
    } else {
      g.beginPath();
      g.arc(a.x * W, a.y * H, lw * 4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    const bx = a.kind === 'point' ? a.x * W + lw * 4 : a.x * W;
    const by = a.kind === 'point' ? a.y * H - lw * 4 : a.y * H;
    const r = Math.max(12, lw * 4);
    g.fillStyle = '#E11D48';
    g.beginPath();
    g.arc(bx, by, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = `700 ${Math.round(r * 1.3)}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(a.id), bx, by + 1);
    g.fillStyle = 'rgba(225, 29, 72, .28)';
  }
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('示意图生成失败'))), 'image/jpeg', 0.88));
}

export function AnnotModal() {
  const s = useStore();
  const d = s.annot;
  const it = d ? canvasItems(s).find((i) => i.id === d.srcId) : undefined;
  const cached = it ? s.annotCache[it.id] : undefined;
  const annots = cached || [];
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>('box');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [temp, setTemp] = useState<{ kind: Tool; a: [number, number]; pts: [number, number][]; b: [number, number] } | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!it?.src) return;
    setImg(null);
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = it.src;
  }, [it?.id, it?.src]);

  if (!d || !it) return null;
  const set = (list: Annot[]) => setState((st) => void (st.annotCache[it.id] = list));
  const close = () => setState((st) => void (st.annot = null));
  const W = img?.naturalWidth || 0;
  const H = img?.naturalHeight || 0;
  const k = W ? Math.min(640 / W, 440 / H, 1) : 1;
  const nextId = () => (annots.length ? Math.max(...annots.map((a) => a.id)) + 1 : 1);

  const at = (e: React.PointerEvent): [number, number] => {
    const r = stage.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const down = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = at(e);
    setTemp({ kind: tool, a: p, b: p, pts: [p] });
  };
  const move = (e: React.PointerEvent) => {
    if (!temp) return;
    const p = at(e);
    setTemp({ ...temp, b: p, pts: temp.kind === 'brush' ? [...temp.pts, p] : temp.pts });
  };
  const up = () => {
    if (!temp) return;
    const t = temp;
    setTemp(null);
    if (t.kind === 'point') return set([...annots, pointAnnot(nextId(), t.a[0], t.a[1])]);
    if (t.kind === 'box') {
      if (Math.abs(t.b[0] - t.a[0]) < 0.015 || Math.abs(t.b[1] - t.a[1]) < 0.015) return;
      return set([...annots, boxAnnot(nextId(), t.a[0], t.a[1], t.b[0], t.b[1])]);
    }
    if (t.pts.length < 3) return;
    set([...annots, brushAnnot(nextId(), t.pts)]);
  };

  const p = s.params.image;
  const model = modelOf(s, p.model);
  const usable = annots.filter((a) => a.text.trim());
  const unit = singleUnitCost('image', { ...p, count: 1 }, model);
  const total = round1(unit);
  const ratio = it.ar ? ratioLabel(1, it.ar) : '1:1';
  const noModel = !modelsFor(s, 'image').length;

  const run = async () => {
    if (!usable.length || !img) return;
    if (noModel) return toast('warn', '没有可用的图像模型', '先登录账号，或到「模型与价格」检查模型');
    if (!canAfford(getState(), total)) return toast('warn', '点数不够', `需要约 ${total} 点，当前余额 ${getState().wallet?.balance ?? 0} 点`);
    setBusy(true);
    try {
      const blob = await renderOverlay(img, annots.filter((a) => a.text.trim()));
      const [up] = await uploadFiles([new File([blob], `批注示意-${it.id}.jpg`, { type: 'image/jpeg' })]);
      const body: CreateJobBody = {
        type: 'image',
        ws: getState().ws,
        model: p.model,
        prompt: annotPrompt(annots, { hasOverlay: true, note }),
        refs: [
          { src: it.src!, w: 0.9, from: 'canvas', rid: it.rid, t: it.t },
          { src: up.url, w: 0.5, from: 'canvas', t: '批注示意图' },
        ],
        ratio,
        count: 1,
        res: p.res,
        name: `批注改图 · ${usable.length} 处`,
        fromCvsId: it.id,
      };
      await api.post<{ jobs: Job[] }>('/api/jobs', { jobs: [body] });
      toast('success', '已加入生成队列', `按 ${usable.length} 处批注改「${it.t || '这张图'}」，新图会连回原图；约 ${total} 点`);
      setState((st) => void delete st.annotCache[it.id]);
      close();
    } catch (e) {
      toastError(e, '没能提交批注改图');
    } finally {
      setBusy(false);
    }
  };

  const pct = (n: number) => `${n * 100}%`;
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="modal-card annot-modal">
        <div className="modal-head">
          <Icon name="pen" />
          <b>批注改图</b>
          <span className="tiny dim">「{it.t || '图片'}」</span>
          <span className="grow" />
          <div className="annot-tools">
            {(
              [
                ['box', '框选'],
                ['brush', '涂抹'],
                ['point', '点选'],
              ] as [Tool, string][]
            ).map(([t, n]) => (
              <button key={t} className={`btn sm ${tool === t ? 'primary' : 'ghost'}`} onClick={() => setTool(t)}>
                {n}
              </button>
            ))}
          </div>
          <button className="icon-btn" onClick={close} disabled={busy}>
            <Icon name="x" />
          </button>
        </div>
        <div className="annot-body">
          <div className="annot-stage-wrap">
            {!img ? (
              <div className="crop-empty">读取图片中…</div>
            ) : (
              <div ref={stage} className="annot-stage" style={{ width: W * k, height: H * k }} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
                <img src={it.src} alt="" draggable={false} />
                <svg className="annot-svg" viewBox="0 0 1 1" preserveAspectRatio="none">
                  {annots.map((a) =>
                    a.kind === 'box' ? (
                      <rect key={a.id} x={a.x} y={a.y} width={a.w} height={a.h} className="annot-shape" vectorEffect="non-scaling-stroke" />
                    ) : a.kind === 'brush' ? (
                      <polyline key={a.id} points={(a.pts || []).map((q) => q.join(',')).join(' ')} className="annot-brush" vectorEffect="non-scaling-stroke" />
                    ) : (
                      <circle key={a.id} cx={a.x} cy={a.y} r={0.012} className="annot-shape" vectorEffect="non-scaling-stroke" />
                    ),
                  )}
                  {temp?.kind === 'box' && <rect x={Math.min(temp.a[0], temp.b[0])} y={Math.min(temp.a[1], temp.b[1])} width={Math.abs(temp.b[0] - temp.a[0])} height={Math.abs(temp.b[1] - temp.a[1])} className="annot-shape draft" vectorEffect="non-scaling-stroke" />}
                  {temp?.kind === 'brush' && <polyline points={temp.pts.map((q) => q.join(',')).join(' ')} className="annot-brush draft" vectorEffect="non-scaling-stroke" />}
                </svg>
                {annots.map((a) => (
                  <span key={a.id} className="annot-num num" style={{ left: pct(a.x), top: pct(a.y) }}>
                    {a.id}
                  </span>
                ))}
              </div>
            )}
            <div className="tiny dim">在图上{tool === 'box' ? '拖出一个框' : tool === 'brush' ? '涂抹要改的区域' : '点一下要改的位置'}，然后在右边写这一处的改法</div>
          </div>
          <div className="annot-list">
            {annots.length === 0 && <div className="tiny dim">还没有批注。选一个工具，在图上标出要改的地方。</div>}
            {annots.map((a) => (
              <div key={a.id} className="annot-row">
                <span className="annot-num static num">{a.id}</span>
                <input
                  className="form-input"
                  autoFocus={a.id === annots[annots.length - 1].id && !a.text}
                  placeholder={a.kind === 'point' ? '这一点要怎么改' : '这一处要怎么改，例如：换成红色'}
                  value={a.text}
                  onChange={(e) => set(annots.map((x) => (x.id === a.id ? { ...x, text: e.target.value } : x)))}
                />
                <button className="icon-btn xs" title="删除这处批注" onClick={() => set(annots.filter((x) => x.id !== a.id))}>
                  <Icon name="x" />
                </button>
              </div>
            ))}
            <label className="regen-f">
              <span>补充说明（可选）</span>
              <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：整体保持暖色调" />
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <span className="tiny dim">
            {usable.length ? `${usable.length} 处有改法` : annots.length ? '每处都要写一句改法' : ''} · {model.name} · 约 {total} 点（平台渠道以实际用量为准）
          </span>
          <span className="grow" />
          {annots.length > 0 && (
            <button className="btn sm ghost" onClick={() => set([])} disabled={busy}>
              清空批注
            </button>
          )}
          <button className="btn sm primary" onClick={() => void run()} disabled={!usable.length || busy || !img}>
            <Icon name="wand" />
            {busy ? '提交中…' : '按批注生成'}
          </button>
        </div>
      </div>
    </div>
  );
}
