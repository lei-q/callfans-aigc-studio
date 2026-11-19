import { useRef, useState } from 'react';
import type { Result } from '@aigc/shared';
import { Icon } from '../components/common';
import { api } from '../lib/api';
import { getState, setState, useStore } from '../store';
import { canvasItems } from '../store/selectors';
import { toast, toastError } from '../store/toast';
import { ensureRid, placeDerived } from './ops';

/* ============================================================================
   视频工具：取帧（把当前画面存成图片）、裁时长（裁出一段新视频）。
   都由本机 ffmpeg 处理，不调模型、不扣点；结果是新产出，摆在视频下面并连回视频。
   ========================================================================== */

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${String(Math.floor((t % 1) * 10))}`;

export function VtoolModal() {
  const s = useStore();
  const d = s.vtool;
  const it = d ? canvasItems(s).find((i) => i.id === d.srcId) : undefined;
  const ref = useRef<HTMLVideoElement>(null);
  const [dur, setDur] = useState(0);
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  const [busy, setBusy] = useState('');
  if (!d || !it) return null;
  const close = () => setState((st) => void (st.vtool = null));
  const now = () => ref.current?.currentTime || 0;

  const frame = async () => {
    const rid = await ensureRid(it.id);
    if (!rid) return;
    setBusy('正在取帧…');
    try {
      const { result } = await api.post<{ result: Result }>('/api/video/frame', { sourceId: rid, t: now() });
      placeDerived(it.id, [result]);
      toast('success', '已取帧', `${result.title}，摆在视频下面并连回视频；也在素材库里`);
    } catch (e) {
      toastError(e, '取帧失败');
    } finally {
      setBusy('');
    }
  };

  const trim = async () => {
    const out = b || dur;
    if (out - a < 0.2) {
      toast('warn', '这一段太短了', '入点和出点至少隔 0.2 秒');
      return;
    }
    const rid = await ensureRid(it.id);
    if (!rid) return;
    setBusy('正在裁切并重新编码…');
    try {
      const { result } = await api.post<{ result: Result }>('/api/results/edited', {
        sourceId: rid,
        ws: getState().ws,
        title: `${(it.t || '视频').replace(/（已编辑）$/, '')} · ${fmt(a)}–${fmt(out)}`,
        tags: ['裁时长'],
        edit: { ops: { in: a, out, speed: 1, mute: false, cover: '首帧', caption: '' } },
      });
      placeDerived(it.id, [result]);
      toast('success', '已裁出一段', `${result.title} · ${result.dur}s，摆在视频下面并连回视频`);
    } catch (e) {
      toastError(e, '裁切失败');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="modal-card vtool-modal">
        <div className="modal-head">
          <Icon name="film" />
          <b>视频工具</b>
          <span className="tiny dim">「{it.t || '视频'}」</span>
          <span className="grow" />
          <button className="icon-btn" onClick={close} disabled={!!busy}>
            <Icon name="x" />
          </button>
        </div>
        <div className="vtool-body">
          <video
            ref={ref}
            className="vtool-video"
            src={it.src}
            controls
            preload="metadata"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget.duration || 0;
              setDur(v);
              setB(Math.round(v * 10) / 10);
            }}
          />
          <div className="vtool-row">
            <b>取帧</b>
            <span className="tiny dim">拖到想要的画面，点右边按钮，存成图片（保持视频原分辨率）</span>
            <span className="grow" />
            <button className="btn sm primary" onClick={() => void frame()} disabled={!!busy}>
              <Icon name="image" />
              取当前画面
            </button>
          </div>
          <div className="vtool-row col">
            <div className="vtool-line">
              <b>裁时长</b>
              <span className="tiny dim">共 {dur ? `${dur.toFixed(1)}s` : '读取中'}，保留 {Math.max(0, (b || dur) - a).toFixed(1)}s</span>
            </div>
            <div className="vtool-line">
              <label>
                入点
                <input className="form-input" type="number" min={0} max={dur} step={0.1} value={a} onChange={(e) => setA(Math.max(0, Number(e.target.value)))} />
              </label>
              <button className="btn sm ghost" onClick={() => setA(Math.round(now() * 10) / 10)}>
                设为当前
              </button>
              <label>
                出点
                <input className="form-input" type="number" min={0} max={dur} step={0.1} value={b} onChange={(e) => setB(Math.min(dur, Number(e.target.value)))} />
              </label>
              <button className="btn sm ghost" onClick={() => setB(Math.round(now() * 10) / 10)}>
                设为当前
              </button>
              <span className="grow" />
              <button className="btn sm primary" onClick={() => void trim()} disabled={!!busy || !dur}>
                <Icon name="film" />
                裁出这一段
              </button>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="tiny dim">{busy || '本机 ffmpeg 处理，不调模型、不扣点；原视频不变。更多编辑（变速、字幕、静音）在「编辑」页'}</span>
        </div>
      </div>
    </div>
  );
}
