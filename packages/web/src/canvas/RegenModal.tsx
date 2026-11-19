import { useEffect, useState } from 'react';
import type { CreateJobBody, Job } from '@aigc/shared';
import { RESOS, VIDEO_RATIOS, RATIOS, VIDEO_RES, round1, singleUnitCost } from '@aigc/shared';
import { Icon } from '../components/common';
import { api } from '../lib/api';
import { getState, setState, useStore } from '../store';
import { autoSnapshot } from './ops';
import { canAfford } from '../store/actions';
import { canvasItems, jobById, modelOf, modelsFor, resultById } from '../store/selectors';
import { toast, toastError } from '../store/toast';

/* ============================================================================
   改参数再生成：从这个素材当初的任务出发，改提示词 / 模型 / 比例 / 清晰度 / 数量后重新生成。
   和「按这套再来一次」的区别：不用跳回创作页，新产出会连回这个素材，一眼能看出改了什么。
   ========================================================================== */

export function RegenModal() {
  const s = useStore();
  const d = s.regen;
  const it = d ? canvasItems(s).find((i) => i.id === d.srcId) : undefined;
  const r = it ? resultById(s, it.rid) : undefined;
  const job = r ? jobById(s, r.job) : undefined;
  const [f, setF] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setF(job ? { ...job } : null);
  }, [job?.id, d?.srcId]);
  if (!d || !it || !job || !f) return null;
  const type = job.type;
  const close = () => setState((st) => void (st.regen = null));
  const set = (patch: Partial<Job>) => setF({ ...f, ...patch });
  const models = modelsFor(s, type);
  const model = modelOf(s, f.model);
  const count = type === 'image' ? f.count || 1 : 1;
  const unit = singleUnitCost(type, f, model);
  const total = round1(unit * count);
  const changed = (['prompt', 'model', 'ratio', 'res', 'count', 'dur', 'vres', 'negative'] as const).filter((k) => (f[k] ?? '') !== (job[k] ?? ''));

  const run = async () => {
    if (!f.prompt.trim()) return toast('warn', '提示词为空');
    if (!canAfford(getState(), total)) return toast('warn', '点数不够', `需要约 ${total} 点，当前余额 ${getState().wallet?.balance ?? 0} 点`);
    setBusy(true);
    try {
      autoSnapshot('改参数再生成前');
      const body: CreateJobBody = {
        type,
        ws: getState().ws,
        model: f.model,
        prompt: f.prompt.trim(),
        negative: f.negative || undefined,
        refs: job.refs || [],
        ratio: f.ratio,
        ...(type === 'image' ? { count: f.count || 1, res: f.res, seed: f.seed || undefined, format: f.format, refWeight: f.refWeight } : {}),
        ...(type === 'video' ? { dur: f.dur, cam: f.cam, loop: f.loop, firstFrame: f.firstFrame, vres: f.vres } : {}),
        name: `改参数 · ${changed.length ? changed.map((k) => ({ prompt: '提示词', model: '模型', ratio: '比例', res: '分辨率', count: '数量', dur: '时长', vres: '清晰度', negative: '负面词' })[k]).join('/') : '原样'}`,
        fromCvsId: it.id,
      };
      await api.post<{ jobs: Job[] }>('/api/jobs', { jobs: [body] });
      toast('success', '已加入生成队列', `新产出会连回「${it.t || '这个素材'}」；${total} 点（平台渠道以实际用量为准）`);
      close();
    } catch (e) {
      toastError(e, '没能加入队列');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="modal-card regen-modal">
        <div className="modal-head">
          <Icon name="refresh" />
          <b>改参数再生成</b>
          <span className="tiny dim">「{it.t || '素材'}」当初的任务：{job.name}</span>
          <span className="grow" />
          <button className="icon-btn" onClick={close} disabled={busy}>
            <Icon name="x" />
          </button>
        </div>
        <div className="regen-body">
          <label className="regen-f">
            <span>提示词</span>
            <textarea className="prompt-input" rows={4} value={f.prompt} onChange={(e) => set({ prompt: e.target.value })} />
          </label>
          <label className="regen-f">
            <span>负面词</span>
            <input className="form-input" value={f.negative || ''} onChange={(e) => set({ negative: e.target.value })} />
          </label>
          <div className="regen-row">
            <label className="regen-f">
              <span>模型</span>
              <select className="form-select" value={f.model} onChange={(e) => set({ model: e.target.value })}>
                {!models.some((m) => m.id === f.model) && <option value={f.model}>{model.name}（当前不可用）</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="regen-f">
              <span>比例</span>
              <select className="form-select" value={f.ratio || ''} onChange={(e) => set({ ratio: e.target.value })}>
                {(type === 'video' ? VIDEO_RATIOS.map((x) => x[0]) : RATIOS).map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            {type === 'image' && (
              <>
                <label className="regen-f">
                  <span>分辨率</span>
                  <select className="form-select" value={f.res || '2k'} onChange={(e) => set({ res: e.target.value as Job['res'] })}>
                    {RESOS.map((x) => (
                      <option key={x.k} value={x.k}>
                        {x.n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="regen-f">
                  <span>数量</span>
                  <input className="form-input" type="number" min={1} max={8} value={f.count || 1} onChange={(e) => set({ count: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })} />
                </label>
              </>
            )}
            {type === 'video' && (
              <>
                <label className="regen-f">
                  <span>时长（秒）</span>
                  <input className="form-input" type="number" min={1} value={f.dur || 5} onChange={(e) => set({ dur: Math.max(1, Number(e.target.value) || 1) })} />
                </label>
                <label className="regen-f">
                  <span>清晰度</span>
                  <select className="form-select" value={f.vres || ''} onChange={(e) => set({ vres: e.target.value })}>
                    <option value="">默认</option>
                    {VIDEO_RES.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
          {job.refs?.length > 0 && <div className="tiny dim">沿用原来的 {job.refs.length} 张参考图。</div>}
        </div>
        <div className="modal-foot">
          <span className="tiny dim">{changed.length ? `改了 ${changed.length} 项` : '还没有改动（也可以原样再来一次）'} · 约 {total} 点</span>
          <span className="grow" />
          <button className="btn sm ghost" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="btn sm primary" onClick={() => void run()} disabled={busy}>
            <Icon name="wand" />
            {busy ? '提交中…' : '重新生成'}
          </button>
        </div>
      </div>
    </div>
  );
}
