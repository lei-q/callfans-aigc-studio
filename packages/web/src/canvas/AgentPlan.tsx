import { RATIOS, VIDEO_RATIOS } from '@aigc/shared';
import { Icon } from '../components/common';
import { useStore } from '../store';
import { modelsFor } from '../store/selectors';
import { agentCard, agentPlanConfirm, agentPlanCost, agentPlanEdit, agentPlanGoal, agentPlanRemove, agentPlanRun } from './ops';

const CARDS = [
  { k: 'group', ic: 'grid', n: '做一组图', d: '以选中的图为锚点出一组' },
  { k: 'replicate', ic: 'film', n: '复刻爆款视频', d: '拆镜头再生成' },
  { k: 'edit', ic: 'pen', n: '改这张图', d: '在图上标哪里怎么改' },
  { k: 'adapt', ic: 'crop', n: '平台尺寸适配', d: '一键裁成各平台比例' },
] as const;

/* Agent 计划：写目标（或点能力卡）→ 看计划 → 改模型 / 比例 / 时长 → 确认后才建任务。
   计划阶段只调文本模型，不生成、不扣生成点数；AI 只给建议，参数你说了算。 */
export function AgentPlanSection() {
  const s = useStore();
  const p = s.agentPlan;
  const total = agentPlanCost(s);
  return (
    <div className="agent-sec">
      <div className="agent-sec-t">
        <Icon name="wand" />
        想做什么
        <span className="chip neutral">计划免费</span>
      </div>
      <div className="agent-cards">
        {CARDS.map((c) => (
          <button key={c.k} className="agent-card" onClick={() => agentCard(c.k)}>
            <Icon name={c.ic} />
            <b>{c.n}</b>
            <span>{c.d}</span>
          </button>
        ))}
      </div>
      <textarea className="prompt-input" rows={2} value={p.goal} placeholder="或者直接写目标：例如「做一组春季饮品的小红书配图，再配一条 5 秒短视频」" onChange={(e) => agentPlanGoal(e.target.value)} />
      <button className="btn sm primary" disabled={p.loading || p.goal.trim().length < 2} onClick={() => void agentPlanRun()}>
        <Icon name="sparkles" />
        {p.loading ? '规划中…' : '生成计划'}
      </button>
      {p.error && <div className="agent-hint" style={{ color: '#B91C1C' }}>{p.error}</div>}
      {p.steps && (
        <div className="plan-steps">
          {p.summary && <div className="agent-text">{p.summary}</div>}
          {p.steps.map((x, i) => {
            const models = modelsFor(s, x.kind);
            return (
              <div key={x.id} className="plan-step">
                <div className="ps-head">
                  <span className="num ps-n">{i + 1}</span>
                  <b>{x.title}</b>
                  <span className="chip neutral">{x.kind === 'image' ? '图片' : '视频'}</span>
                  <span className="grow" />
                  <button className="icon-btn xs" title="删掉这一步" onClick={() => agentPlanRemove(x.id)}>
                    <Icon name="x" />
                  </button>
                </div>
                <textarea className="prompt-input" rows={3} value={x.prompt} onChange={(e) => agentPlanEdit(x.id, { prompt: e.target.value })} />
                <div className="ps-row">
                  <select className="form-select" value={x.model} onChange={(e) => agentPlanEdit(x.id, { model: e.target.value })}>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <select className="form-select" value={x.ratio} onChange={(e) => agentPlanEdit(x.id, { ratio: e.target.value })}>
                    {(x.kind === 'video' ? VIDEO_RATIOS.map((r) => r[0]) : [...new Set([...RATIOS, '3:4'])]).map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                  {x.kind === 'image' ? (
                    <label className="tiny dim">
                      张数
                      <input className="form-input ps-num" type="number" min={1} max={4} value={x.count} onChange={(e) => agentPlanEdit(x.id, { count: Math.min(4, Math.max(1, Number(e.target.value) || 1)) })} />
                    </label>
                  ) : (
                    <label className="tiny dim">
                      秒
                      <input className="form-input ps-num" type="number" min={2} max={15} value={x.dur || 5} onChange={(e) => agentPlanEdit(x.id, { dur: Math.min(15, Math.max(2, Number(e.target.value) || 5)) })} />
                    </label>
                  )}
                </div>
                {x.why && <div className="tiny dim">AI 建议 · {x.why}</div>}
              </div>
            );
          })}
          <div className="ps-foot">
            <span className="tiny dim">{p.steps.length ? `${p.steps.length} 步 · 约 ${total} 点（平台渠道以实际用量为准）；没选素材时参考画布前 4 个素材` : '计划里没有步骤了'}</span>
            <span className="grow" />
            <button className="btn sm primary" disabled={!p.steps.length || p.submitting} onClick={() => void agentPlanConfirm()}>
              <Icon name="check" />
              {p.submitting ? '提交中…' : '确认并生成'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
