import { GROUP_AXES, round1, singleUnitCost } from '@aigc/shared';
import { Icon } from '../components/common';
import { setState, useStore } from '../store';
import { canvasItems, modelOf } from '../store/selectors';
import { groupRun, sourceBase } from './ops';
import { useState } from 'react';

/* 组图：以一张图为锚点（主体与整体风格不变），选若干条变化轴，每条出一张，
   方案文字可以逐条改；全部以锚点为参考图并连回锚点，完成后整批放进画布并圈成一组。 */
export function GroupModal() {
  const s = useStore();
  const d = s.group;
  const [busy, setBusy] = useState(false);
  const it = d ? canvasItems(s).find((i) => i.id === d.srcId) : undefined;
  if (!d || !it) return null;
  const close = () => setState((st) => void (st.group = null));
  const p = s.params.image;
  const model = modelOf(s, p.model);
  const unit = singleUnitCost('image', { ...p, count: 1 }, model);
  const n = d.axes.length;
  const toggle = (k: string) => setState((st) => void (st.group && (st.group.axes = st.group.axes.includes(k) ? st.group.axes.filter((x) => x !== k) : [...st.group.axes, k])));
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="modal-card group-modal">
        <div className="modal-head">
          <Icon name="grid" />
          <b>组图</b>
          <span className="tiny dim">以「{it.t || '这张图'}」为锚点，主体与整体风格不变</span>
          <span className="grow" />
          <button className="icon-btn" onClick={close} disabled={busy}>
            <Icon name="x" />
          </button>
        </div>
        <div className="group-body">
          <div className="diverge-base">
            <Icon name="pen" />
            <span>{sourceBase(s, it).slice(0, 90)}</span>
          </div>
          <div className="group-axes">
            {GROUP_AXES.map((a) => {
              const on = d.axes.includes(a.k);
              return (
                <div key={a.k} className={`group-axis ${on ? 'on' : ''}`}>
                  <button className="ga-head" onClick={() => toggle(a.k)}>
                    <span className="da-check">{on && <Icon name="check" />}</span>
                    <b>{a.n}</b>
                    <span className="tiny dim">{a.d}</span>
                  </button>
                  {on && (
                    <input
                      className="form-input"
                      value={d.adds[a.k] ?? a.add}
                      onChange={(e) => setState((st) => void (st.group && (st.group.adds[a.k] = e.target.value)))}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="modal-foot">
          <span className="tiny dim">{n ? `${n} 张 · 约 ${round1(unit * n)} 点（${model.name}；平台渠道以实际用量为准）` : '先选变化轴'}</span>
          <span className="grow" />
          <button className="btn sm ghost" onClick={close} disabled={busy}>
            取消
          </button>
          <button
            className="btn sm primary"
            disabled={!n || busy}
            onClick={async () => {
              setBusy(true);
              await groupRun();
              setBusy(false);
            }}
          >
            <Icon name="wand" />
            {busy ? '提交中…' : `出 ${n} 张`}
          </button>
        </div>
      </div>
    </div>
  );
}
