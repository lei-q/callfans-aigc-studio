import { useEffect, useState } from 'react';
import type { Job, Result } from '@aigc/shared';
import { HELP_TOPICS, MAX_REFS, POST_PLATFORMS, TOPUP_PACKS, TYPES, mmss, paramsBrief, timeLabel } from '@aigc/shared';
import { useStore } from '../store';
import {
  addRefItem,
  adoptResult,
  cancelJob,
  closeDrawer,
  copyPromptOf,
  deleteProject,
  deleteResult,
  downloadResult,
  favResult,
  fixJob,
  goJobs,
  goStudio,
  helpJump,
  makeVariant,
  openInEditor,
  postCopy,
  postDel,
  postExport,
  postItemAdd,
  postItemDel,
  postItemMove,
  postItemShift,
  postPlatform,
  postSave,
  refPool,
  renameProject,
  retryJob,
  saveMeta,
  topupPoints,
} from '../store/actions';
import { addResultToCanvas } from '../canvas/ops';
import { togglePlay } from '../store/player';
import { balance, dailyFreeLeft, jobById, libResults, modelOf, queueJobs, resultById, spentTotal } from '../store/selectors';
import { thumbOf, cssOfEdit } from '../lib/util';
import { Empty, Icon, MediaThumb, ProjectMini, StatusChip, TaskIc, TypeChip, Wave } from '../components/common';

export function Drawer() {
  const d = useStore((s) => s.drawer);
  useEffect(() => {
    document.body.classList.toggle('drawer-open', !!d);
  }, [d]);
  if (!d) return null;
  return (
    <>
      <div className="overlay" onClick={closeDrawer} />
      <aside className="drawer">
        {d.type === 'result' && <ResultDrawer id={d.id!} />}
        {d.type === 'help' && <HelpDrawer />}
        {d.type === 'queue' && <QueueDrawer />}
        {d.type === 'ref-add' && <RefAddDrawer />}
        {d.type === 'topup' && <TopupDrawer />}
        {d.type === 'edit' && <EditMetaDrawer id={d.id!} />}
        {d.type === 'post' && <PostDrawer id={d.id!} />}
        {d.type === 'project' && <ProjectDrawer />}
      </aside>
    </>
  );
}

function Head({ ic, icCls, title, sub, children }: { ic?: string; icCls?: string; title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="drawer-head">
      {ic && <TaskIc icon={ic} cls={icCls || 'violet'} />}
      <div className="grow">
        <div className="drawer-title">{title}</div>
        {sub && <div className="drawer-sub">{sub}</div>}
      </div>
      {children}
      <button className="icon-btn drawer-close" onClick={closeDrawer}>
        <Icon name="x" />
      </button>
    </div>
  );
}

/* ---------------- 结果详情 ---------------- */

function ResultDrawer({ id }: { id: string }) {
  const s = useStore();
  const r = resultById(s, id);
  if (!r) return <Head title="产出不存在" />;
  const j = jobById(s, r.job);
  const m = modelOf(s, r.model);
  const isMedia = r.type !== 'image';
  const playing = s.play.id === r.id;
  const project = s.projects.find((p) => p.id === r.ws);
  return (
    <>
      <div className="drawer-head">
        <TaskIc type={r.type} />
        <div className="grow">
          <div className="drawer-title">{r.title}</div>
          <div className="drawer-sub">
            <TypeChip type={r.type} />
            <span>{m.name}</span>
            <span className="dim">·</span>
            <span>{timeLabel(r.createdAt)}</span>
            <span className="dim">·</span>
            <span>{project?.name || '—'}</span>
          </div>
        </div>
        <button className="icon-btn drawer-close" onClick={closeDrawer}>
          <Icon name="x" />
        </button>
      </div>
      <div className="drawer-body">
        <div className="d-section">
          <div className="stage">
            <div className={`stage-media ${playing ? 'playing' : ''}`}>
              {r.simulated || r.type === 'image' ? (
                <img src={r.type === 'image' ? r.src : thumbOf(r)} alt={r.title} style={cssOfEdit(r.edit?.css)} />
              ) : r.type === 'video' ? (
                <video src={r.src} controls playsInline style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }} />
              ) : (
                <div className="audio-tile big">
                  <Icon name="waveform" className="lg" />
                </div>
              )}
            </div>
            {isMedia && (r.simulated || r.type === 'audio') && (
              <div className="stage-ctrl">
                <button className="sc-btn" onClick={() => togglePlay(r.id)}>
                  <Icon name={playing ? 'pause' : 'play'} />
                </button>
                <div className="stage-track">
                  <i style={{ width: `${playing ? Math.min(100, (s.play.t / (r.dur || 5)) * 100) : 0}%` }} />
                </div>
                <span className="stage-time">
                  {mmss(playing ? s.play.t : 0)} / {mmss(r.dur)}
                </span>
                <Icon name={r.type === 'audio' ? 'volume' : 'film'} />
              </div>
            )}
          </div>
          <div className="tiny dim" style={{ marginTop: 6 }}>
            {r.simulated
              ? '演示渠道的示意产物：只有封面图，播放进度为本地模拟。'
              : r.type === 'image'
                ? '原件已保存在本机，可直接下载或带去继续生成。'
                : '原件已保存在本机，可直接播放与下载。'}
          </div>
        </div>

        <div className="d-section">
          <div className="summary-strip">
            <div className="summary-cell">
              <span className="k">模型</span>
              <span className="v" style={{ fontSize: 12.5 }}>
                {m.name}
              </span>
            </div>
            <div className="summary-cell">
              <span className="k">比例 / 时长</span>
              <span className="v num">
                {r.ratio}
                {r.dur ? ` · ${r.dur}s` : ''}
              </span>
            </div>
            <div className="summary-cell">
              <span className="k">随机种子</span>
              <span className="v num">{r.seed}</span>
            </div>
            <div className="summary-cell">
              <span className="k">状态</span>
              <span className="v" style={{ fontSize: 12.5 }}>
                {r.status === 'adopted' ? '已采用' : r.status === 'fav' ? '收藏' : '待选'}
              </span>
            </div>
          </div>
        </div>

        {r.type === 'audio' && (
          <div className="d-section">
            <div className="d-section-title">
              <Icon name="waveform" />
              波形
            </div>
            <div className="d-card d-card-pad">
              <Wave r={r} cls="wave-lg" bars={56} />
            </div>
          </div>
        )}

        <div className="d-section">
          <div className="d-section-title">
            <Icon name="pen" />
            提示词
          </div>
          <div className="d-card d-card-pad">
            <div className="prompt-quote">{j ? j.prompt : '——'}</div>
            <div className="flex mt8">
              <button className="btn sm ghost" onClick={() => copyPromptOf(r.id)}>
                <Icon name="copy" />
                复制提示词
              </button>
              <button className="btn sm ghost" onClick={() => makeVariant(r.id)}>
                <Icon name="refresh" />
                以此为参考生成变体
              </button>
            </div>
          </div>
        </div>

        <div className="d-section">
          <div className="d-section-title">
            <Icon name="link" />
            参数与来源
          </div>
          <div className="d-card d-card-pad">
            <div className="snap-row">
              <span className="sk">来源任务</span>
              <span className="sv">{j ? `${j.name} · ${paramsBrief(j)}` : r.edit ? '在编辑器中修改后保存' : '——'}</span>
            </div>
            <div className="snap-row">
              <span className="sk">参考素材</span>
              <span className="sv">{j && j.refs.length ? `本次引用了 ${j.refs.length} 张参考图（含权重）` : '纯文生（无参考）'}</span>
            </div>
            <div className="snap-row">
              <span className="sk">点数消耗</span>
              <span className="sv">{j ? `${j.cost} 点（任务级）` : '——'} · 失败自动退回</span>
            </div>
            {j?.requestId && (
              <div className="snap-row">
                <span className="sk">请求 ID</span>
                <span className="sv num">{j.requestId}</span>
              </div>
            )}
            <div className="snap-row">
              <span className="sk">标签</span>
              <span className="sv">
                {r.tags.map((t) => (
                  <span key={t} className="cap-chip">
                    {t}
                  </span>
                ))}
              </span>
            </div>
            {r.note && (
              <div className="snap-row">
                <span className="sk">说明</span>
                <span className="sv">{r.note}</span>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="drawer-foot">
        <button className={`btn ${r.status === 'adopted' ? 'ghost' : 'primary'}`} onClick={() => adoptResult(r.id)}>
          <Icon name="check" />
          {r.status === 'adopted' ? '已采用' : '采用这项'}
        </button>
        <button className="btn ghost" onClick={() => void favResult(r.id)}>
          <Icon name="star" />
          {r.status === 'fav' ? '已收藏' : '收藏'}
        </button>
        <button className="btn ghost" onClick={() => openInEditor(r.id)}>
          <Icon name="crop" />
          在编辑器中打开
        </button>
        <button className="btn ghost" onClick={() => downloadResult(r.id)}>
          <Icon name="download" />
          下载原件
        </button>
        <button className="btn ghost" onClick={() => addResultToCanvas(r.id)}>
          <Icon name="layers" />
          加入画布
        </button>
        <span className="grow" />
        <DangerButton label="删除" confirmLabel="再点一次删除" onConfirm={() => void deleteResult(r.id)} />
      </div>
    </>
  );
}

function DangerButton({ label, confirmLabel, onConfirm }: { label: string; confirmLabel: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button className="btn danger-ghost" onClick={() => (armed ? onConfirm() : setArmed(true))}>
      <Icon name="trash" />
      {armed ? confirmLabel : label}
    </button>
  );
}

/* ---------------- 使用地图 ---------------- */

function HelpDrawer() {
  const active = useStore((s) => s.settings?.provider.active || 'mock');
  return (
    <>
      <Head ic="compass" title="使用地图" sub="四步走完一次生成，以及常见异常的处理入口" />
      <div className="drawer-body">
        <div className="d-section">
          <div className="d-section-title">
            <Icon name="target" />
            推荐动线
          </div>
          <div className="d-card d-card-pad">
            <div className="pb-steps">
              <span className="pb-step">
                <b>1</b> 选类型
              </span>
              <Icon name="chev-right" className="pb-arrow" />
              <span className="pb-step">
                <b>2</b> 写提示词 / 帮我写详细
              </span>
              <Icon name="chev-right" className="pb-arrow" />
              <span className="pb-step">
                <b>3</b> 确认点数与参数
              </span>
              <Icon name="chev-right" className="pb-arrow" />
              <span className="pb-step">
                <b>4</b> 生成 → 画布挑选 → 存素材库
              </span>
            </div>
          </div>
        </div>
        <div className="d-section">
          <div className="d-section-title">
            <Icon name="zap" />
            快捷入口
          </div>
          <div className="help-list">
            {HELP_TOPICS.map((h) => (
              <button key={h.t} onClick={() => helpJump(h.act)}>
                <b>{h.t}</b>
                <span>{h.d}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="d-section">
          <div className="d-section-title">
            <Icon name="alert" />
            约定与边界
          </div>
          <div className="ai-note">
            <div className="ai-note-head">
              <Icon name="shield" />
              {active === 'mock' ? '当前为演示渠道' : '当前接入 TreeCloud'}
            </div>
            <ul>
              {active === 'mock' ? (
                <>
                  <li>生成、进度与播放为本地模拟，产出是示意素材，不产生真实费用。</li>
                  <li>到「设置」填入 TreeCloud API Key，即可切换到真实生成。</li>
                </>
              ) : (
                <>
                  <li>图像、视频、配音都会真实调用 TreeCloud，结果保存在本机。</li>
                  <li>本地点数是预算记账；真实扣费以 TreeCloud 控制台账单为准。</li>
                  <li>图片请求不会自动重试：超时不代表没执行，重提可能再次计费。</li>
                </>
              )}
              <li>失败触发规则：所选分辨率超过模型上限，或视频时长超出模型上限。</li>
            </ul>
          </div>
        </div>
      </div>
      <div className="drawer-foot">
        <button
          className="btn ghost"
          onClick={() => {
            closeDrawer();
            goStudio();
          }}
        >
          <Icon name="wand" />
          开始一次生成
        </button>
        <span className="grow" />
        <button className="btn primary" onClick={closeDrawer}>
          知道了
        </button>
      </div>
    </>
  );
}

/* ---------------- 队列 ---------------- */

export function QueueRow({ j }: { j: Job }) {
  const m = useStore((s) => modelOf(s, j.model));
  return (
    <div className="queue-row">
      <TaskIc type={j.type} />
      <div style={{ minWidth: 0 }}>
        <div className="qr-name">{j.name}</div>
        <div className="qr-sub">
          {m.name} · {paramsBrief(j)} · {j.cost} 点
        </div>
      </div>
      <div>
        {j.status === 'running' ? (
          <div className="qbar">
            <i style={{ width: `${j.progress || 0}%` }} />
          </div>
        ) : j.status === 'failed' ? null : (
          <div className="qbar waiting">
            <i style={{ width: '100%' }} />
          </div>
        )}
        {j.status === 'failed' ? (
          <div className="tiny text-red" style={{ marginTop: 4 }}>
            {j.fail?.reason}
          </div>
        ) : (
          <div className="tiny dim" style={{ marginTop: 4 }}>
            {j.status === 'running' ? j.eta || '生成中…' : j.queueNote || '排队中'}
          </div>
        )}
      </div>
      <div>
        <StatusChip status={j.status} />
      </div>
      <div>
        {j.status === 'running' ? (
          <div className="row-actions">
            <span className="tiny dim num qr-pct">{j.progress || 0}%</span>
            <button className="btn sm ghost" onClick={() => void cancelJob(j.id)}>
              取消
            </button>
          </div>
        ) : j.status === 'queued' ? (
          <div className="row-actions">
            <button className="btn sm ghost" onClick={() => void cancelJob(j.id)}>
              取消
            </button>
          </div>
        ) : (
          <div className="row-actions">
            <button className="btn sm ai" title="按建议修复参数后重试" onClick={() => void fixJob(j.id)}>
              <Icon name="wand" />
              修复
            </button>
            <button className="btn sm ghost" title="参数不变，直接重试" onClick={() => void retryJob(j.id)}>
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function QueueDrawer() {
  const s = useStore();
  const all = queueJobs(s);
  const running = all.filter((j) => j.status === 'running');
  const queued = all.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  const failed = all.filter((j) => j.status === 'failed');
  const onlyFailed = s.queueFilter === 'failed';
  return (
    <>
      <Head
        ic={onlyFailed ? 'alert' : 'clock'}
        icCls={onlyFailed ? 'red' : 'violet'}
        title={onlyFailed ? '失败任务' : '生成队列'}
        sub={
          <>
            <span>生成中 {running.length}</span>
            <span className="dim">·</span>
            <span>排队 {queued.length}</span>
            <span className="dim">·</span>
            <span>失败 {failed.length}</span>
          </>
        }
      >
        <div className="mini-tabs" style={{ marginRight: 8 }}>
          {(
            [
              ['all', '全部'],
              ['failed', '只看失败'],
            ] as const
          ).map(([k, n]) => (
            <button key={k} className={s.queueFilter === k ? 'active' : ''} onClick={() => useStore.setState((st) => void (st.queueFilter = k))}>
              {n}
            </button>
          ))}
        </div>
      </Head>
      <div className="drawer-body">
        {!all.length ? (
          <Empty icon="clock" title="队列是空的" desc="在任意类型页写一句提示词就能开始生成，任务会排队执行。" />
        ) : onlyFailed && !failed.length ? (
          <Empty icon="check" title="没有失败任务" desc="当前没有需要处理的失败任务，切回「全部」可看队列里的其他任务。" />
        ) : (
          <div className="qd-list">
            {failed.map((j) => (
              <QueueRow key={j.id} j={j} />
            ))}
            {!onlyFailed && running.map((j) => <QueueRow key={j.id} j={j} />)}
            {!onlyFailed && queued.map((j) => <QueueRow key={j.id} j={j} />)}
          </div>
        )}
      </div>
      <div className="drawer-foot">
        <span className="tiny dim">
          <Icon name="shield" />
          任务完成后会保留在「任务记录」，不会自动清理
        </span>
        <span className="grow" />
        <button className="btn primary" onClick={goJobs}>
          <Icon name="list" />
          查看全部任务
        </button>
      </div>
    </>
  );
}

/* ---------------- 添加参考素材 ---------------- */

function RefAddDrawer() {
  const s = useStore();
  const pool = refPool(s);
  const picked = s.refs[s.type].map((x) => x.rid);
  const full = s.refs[s.type].length >= MAX_REFS;
  return (
    <>
      <Head ic="image" title="添加参考素材" sub={`${TYPES[s.type].name} · ${pool.length} 项可选 · 最多 4 项`} />
      <div className="drawer-body">
        <div className="field-head" style={{ marginBottom: 10 }}>
          <span className="field-hint">当前项目 / 全部项目</span>
          <span className="grow" />
          {(
            [
              ['ws', '当前项目'],
              ['all', '全部项目'],
            ] as const
          ).map(([k, n]) => (
            <button key={k} className={`fchip ${s.refScope === k ? 'on' : ''}`} onClick={() => useStore.setState((st) => void (st.refScope = k))}>
              {n}
            </button>
          ))}
        </div>
        {pool.length ? (
          <div className="cvs-pick">
            {pool.map((r) => {
              const added = picked.includes(r.id);
              return (
                <button key={r.id} className={`cvs-pick-item ${added || full ? 'added' : ''}`} onClick={() => !added && !full && addRefItem(r.id)}>
                  <MediaThumb r={r} />
                  <span className="cpi-meta">
                    <span className="cpi-name">{r.title}</span>
                    <span className="cpi-act">{added ? '已加入' : full ? '已满 4 项' : '+ 添加'}</span>
                  </span>
                  <span className="st-ws">
                    <ProjectMini ws={r.ws} />
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <Empty icon="image" title="还没有可用的素材" desc="先到「生成」产出一条并存进素材库，或切到「全部项目」看看。" />
        )}
      </div>
    </>
  );
}

/* ---------------- 充值 ---------------- */

function TopupDrawer() {
  const s = useStore();
  const w = s.wallet;
  const double = !w.firstTopupDone;
  const free = dailyFreeLeft(s);
  const real = s.settings?.provider.active === 'treecloud';
  return (
    <>
      <Head ic="coins" icCls="amber" title="点数与充值" sub={<span>1 点 = ¥1 · 按次扣费 · 点数不过期</span>} />
      <div className="drawer-body">
        <div className="d-section">
          <div className="wallet-card">
            <div>
              <div className="tiny dim">当前余额</div>
              <div className="wc-balance num">
                {balance(s)}
                <span>点</span>
              </div>
            </div>
            <div className="wc-side">
              <div className="tiny dim">累计消耗 {spentTotal(s)} 点</div>
              <div className="wc-split">
                <span>
                  <i style={{ background: 'var(--primary)' }} />
                  图像 {w.spent.image}
                </span>
                <span>
                  <i style={{ background: 'var(--ai)' }} />
                  视频 {w.spent.video}
                </span>
                <span>
                  <i style={{ background: 'var(--blue)' }} />
                  音频 {w.spent.audio}
                </span>
              </div>
            </div>
          </div>
        </div>
        {free > 0 ? (
          <div className="free-tip">
            <Icon name="sparkles" />
            <span>
              今日还有 <b className="num">{free} 点</b> 免费额度，生成时自动优先抵扣；每天 0 点重置，不累积。
            </span>
          </div>
        ) : (
          <div className="free-tip done">
            <Icon name="check" />
            <span>今日免费额度已用完，明天 0 点重置。</span>
          </div>
        )}
        <div className="d-section">
          <div className="d-section-title">
            <Icon name="coins" />
            充值{double ? ' · 首充翻倍' : ''}
          </div>
          <div className="pack-grid">
            {TOPUP_PACKS.map((k) => (
              <button key={k.p} className={`pack-card ${k.p === 30 ? 'hot' : ''}`} onClick={() => void topupPoints(k.p)}>
                {k.p === 30 && <span className="pack-hot">最常用</span>}
                <span className="pack-tag">{k.tag}</span>
                <span className="pack-price num">¥{k.p}</span>
                <span className="pack-got num">
                  得 {double ? k.p * 2 : k.p} 点{double && <i>首充翻倍</i>}
                </span>
                <span className="pack-note">{k.note}</span>
              </button>
            ))}
          </div>
          {double && (
            <div className="tiny dim" style={{ marginTop: 8 }}>
              <Icon name="sparkles" />
              首次充值翻倍，每人限一次
            </div>
          )}
        </div>
        <div className="d-section">
          <div className="d-section-title">
            <Icon name="shield" />
            你会得到什么
          </div>
          <div className="d-card d-card-pad">
            <div className="snap-row">
              <span className="sk">计费方式</span>
              <span className="sv">按次扣费，用多少扣多少，没有月费</span>
            </div>
            <div className="snap-row">
              <span className="sk">失败处理</span>
              <span className="sv">生成失败的点数自动退回</span>
            </div>
            <div className="snap-row">
              <span className="sk">有效期</span>
              <span className="sv">点数不过期，不会每月清零</span>
            </div>
            <div className="snap-row">
              <span className="sk">商用</span>
              <span className="sv">产出可直接商用，不需要额外授权费</span>
            </div>
            <div className="snap-row">
              <span className="sk">API</span>
              <span className="sv">网页与 API 共用同一份余额</span>
            </div>
          </div>
        </div>
      </div>
      <div className="drawer-foot">
        <span className="tiny dim">
          <Icon name="shield" />
          {real ? '本地点数为预算记账，不涉及真实支付；真实费用在 TreeCloud 控制台结算' : '演示渠道内为模拟充值，不产生真实扣款'}
        </span>
        <span className="grow" />
        <button className="btn ghost" onClick={closeDrawer}>
          关闭
        </button>
      </div>
    </>
  );
}

/* ---------------- 编辑产出元信息 ---------------- */

function EditMetaDrawer({ id }: { id: string }) {
  const s = useStore();
  const r = resultById(s, id);
  const [title, setTitle] = useState(r?.title || '');
  const [note, setNote] = useState(r?.note || '');
  const [tags, setTags] = useState((r?.tags || []).join(' '));
  if (!r) return <Head title="产出不存在" />;
  const j = jobById(s, r.job);
  return (
    <>
      <Head title="编辑产出" sub={<span>{`${TYPES[r.type].name} · ${modelOf(s, r.model).name} · ${r.ratio}`}</span>} />
      <div className="drawer-body">
        <div className="edit-thumb">
          <MediaThumb r={r} />
        </div>
        <div className="field-block">
          <div className="field-head">
            <span className="field-label">标题</span>
          </div>
          <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="给它起个名字" />
        </div>
        <div className="field-block">
          <div className="field-head">
            <span className="field-label">说明</span>
          </div>
          <textarea className="prompt-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="这条打算怎么用？发哪个平台、配什么文案…" />
        </div>
        <div className="field-block">
          <div className="field-head">
            <span className="field-label">标签</span>
          </div>
          <input className="form-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="空格分隔，例如：春季 咖啡 暖橙" />
          <div className="field-hint">标签会显示在卡片上，也是 Agent 读画板时的关键词来源。</div>
        </div>
        {j && (
          <div className="field-block">
            <div className="field-head">
              <span className="field-label">原始提示词</span>
            </div>
            <div className="readonly-box">{j.prompt}</div>
          </div>
        )}
      </div>
      <div className="drawer-foot">
        <button className="btn primary" onClick={() => void saveMeta(id, title, note, tags)}>
          <Icon name="check" />
          保存
        </button>
        <button className="btn ghost" onClick={closeDrawer}>
          取消
        </button>
      </div>
    </>
  );
}

/* ---------------- 帖子草稿 ---------------- */

function PostDrawer({ id }: { id: string }) {
  const s = useStore();
  const p = s.posts.find((x) => x.id === id);
  const [title, setTitle] = useState(p?.title || '');
  const [body, setBody] = useState(p?.body || '');
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  if (!p) return <Head title="帖子不存在" />;
  const items = p.items.map((x) => resultById(s, x)).filter((r): r is Result => !!r);
  const inPost = new Set(p.items);
  const pool = libResults(s)
    .filter((r) => (s.libScope === 'all' || r.ws === s.ws) && !inPost.has(r.id))
    .slice(0, 16);
  return (
    <>
      <Head
        title="帖子草稿"
        sub={
          <>
            <span>
              {items.length} 张配图 · 正文 {body.length} 字
            </span>
            <span>·</span>
            <span>保存在本机，刷新不会丢</span>
          </>
        }
      />
      <div className="drawer-body">
        <div className="field-block">
          <div className="field-head">
            <span className="field-label">标题</span>
          </div>
          <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="这篇要讲什么" />
        </div>
        <div className="field-block">
          <div className="field-head">
            <span className="field-label">正文</span>
            <span className="grow" />
            <span className="field-hint">{body.length} 字</span>
          </div>
          <textarea className="prompt-input post-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="正文…" />
        </div>
        <div className="field-block">
          <div className="field-head">
            <span className="field-label">配图顺序</span>
            <span className="grow" />
            <span className="field-hint">可拖动排序</span>
          </div>
          {items.length ? (
            <div className="post-items">
              {items.map((r, i) => (
                <div
                  key={r.id}
                  className={`post-item ${drag === r.id ? 'dragging' : ''} ${over === r.id && drag !== r.id ? 'over' : ''}`}
                  draggable
                  title={r.title}
                  onDragStart={(e) => {
                    setDrag(r.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', r.id);
                  }}
                  onDragEnd={() => {
                    setDrag(null);
                    setOver(null);
                  }}
                  onDragOver={(e) => {
                    if (!drag) return;
                    e.preventDefault();
                    setOver(r.id);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (drag) postItemMove(p.id, drag, r.id);
                    setDrag(null);
                    setOver(null);
                  }}
                >
                  <span className="pi-idx num">{i + 1}</span>
                  <MediaThumb r={r} />
                  <div className="pi-ops">
                    <button className="pi-op" title="前移" onClick={() => postItemShift(p.id, r.id, -1)}>
                      <Icon name="chev-left" />
                    </button>
                    <button className="pi-op" title="后移" onClick={() => postItemShift(p.id, r.id, 1)}>
                      <Icon name="chev-right" />
                    </button>
                    <button className="pi-op danger" title="移除" onClick={() => postItemDel(p.id, r.id)}>
                      <Icon name="x" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="field-hint">还没有配图，从下面挑几张。</div>
          )}
        </div>
        <div className="field-block">
          <div className="field-head">
            <span className="field-label">从素材库添加</span>
          </div>
          {pool.length ? (
            <div className="post-pool">
              {pool.map((r) => (
                <button key={r.id} className="post-pool-item" title={r.title} onClick={() => postItemAdd(p.id, r.id)}>
                  <MediaThumb r={r} />
                  <span className="pp-add">
                    <Icon name="plus" />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="field-hint">素材库里没有别的产出了。先回创作台生成几张。</div>
          )}
        </div>
        <div className="field-block">
          <div className="field-head">
            <span className="field-label">目标平台</span>
          </div>
          <div className="plat-row">
            {POST_PLATFORMS.map((x) => (
              <button
                key={x.k}
                className={`plat-chip ${p.platform === x.k ? 'on' : ''}`}
                style={p.platform === x.k ? ({ '--pc': x.color } as React.CSSProperties) : undefined}
                onClick={() => postPlatform(p.id, x.k)}
              >
                <i style={{ background: x.color }} />
                {x.n}
              </button>
            ))}
          </div>
          <div className="field-hint">只是记下这条打算发哪儿，方便导出时按平台组织。</div>
        </div>
      </div>
      <div className="drawer-foot">
        <button className="btn primary" onClick={() => postSave(p.id, title, body)}>
          <Icon name="check" />
          保存
        </button>
        <button className="btn ghost" onClick={() => postCopy(p.id, title, body)}>
          <Icon name="copy" />
          复制正文
        </button>
        <button className="btn ghost" onClick={() => postExport(p.id, title, body)}>
          <Icon name="download" />
          导出 Markdown
        </button>
        <span className="grow" />
        <DangerButton label="删除" confirmLabel="再点一次删除" onConfirm={() => void postDel(p.id)} />
      </div>
    </>
  );
}

/* ---------------- 管理项目 ---------------- */

function ProjectDrawer() {
  const projects = useStore((s) => s.projects);
  const counts = useStore((s) => {
    const m: Record<string, { jobs: number; results: number }> = {};
    for (const p of s.projects) m[p.id] = { jobs: 0, results: 0 };
    for (const j of s.jobs) if (m[j.ws]) m[j.ws].jobs += 1;
    for (const r of s.results) if (m[r.ws]) m[r.ws].results += 1;
    return JSON.stringify(m);
  });
  const c = JSON.parse(counts) as Record<string, { jobs: number; results: number }>;
  return (
    <>
      <Head ic="layers" title="管理项目" sub="项目只是分类维度：没有成员、配额与审批" />
      <div className="drawer-body">
        <div className="project-list">
          {projects.map((p) => (
            <ProjectRow key={p.id} id={p.id} name={p.name} dot={p.dot} used={p.used} counts={c[p.id]} canDelete={projects.length > 1} />
          ))}
        </div>
        <div className="table-note">
          <Icon name="alert" />
          <span>删除项目会一并删除它的任务记录、产出、画板与帖子；审美库里的收藏不受影响。</span>
        </div>
      </div>
    </>
  );
}

function ProjectRow({ id, name, dot, used, counts, canDelete }: { id: string; name: string; dot: string; used: number; counts?: { jobs: number; results: number }; canDelete: boolean }) {
  const [val, setVal] = useState(name);
  useEffect(() => setVal(name), [name]);
  return (
    <div className="project-row">
      <span className="ws-dot" style={{ background: dot }} />
      <input
        className="form-input"
        value={val}
        maxLength={40}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => val.trim() && val.trim() !== name && void renameProject(id, val.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="tiny dim num">
        {counts?.jobs || 0} 任务 · {counts?.results || 0} 产出 · 已用 {used} 点
      </span>
      {canDelete && <DangerButton label="删除" confirmLabel="确认删除" onConfirm={() => void deleteProject(id)} />}
    </div>
  );
}
