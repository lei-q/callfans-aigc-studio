import type { Job, Result } from '@aigc/shared';
import { TYPES, mmss, paramsBrief, promptBrief, round1, timeLabel } from '@aigc/shared';
import { Empty, Icon, MediaThumb, ProjectMini, StatusChip, TaskIc, Wave } from '../components/common';
import { setState, useStore } from '../store';
import {
  adoptAll,
  adoptResult,
  cancelJob,
  downloadResult,
  draftToLib,
  favResult,
  fixJob,
  goStudio,
  libPack,
  libSel,
  makeVariant,
  openDrawer,
  openInEditor,
  openJob,
  openResult,
  postExport,
  postNew,
  retryJob,
  toggleJob,
} from '../store/actions';
import { keepResult } from '../canvas/ops';
import { togglePlay } from '../store/player';
import { draftResults, failJobs, inScope, jobById, libResults, modelOf, resultById, resultsOfJob, wsShort } from '../store/selectors';
import { POST_PLATFORMS } from '@aigc/shared';

/* ---------------- 任务记录 ---------------- */

export function JobsPage() {
  const s = useStore();
  const all = s.jobs.filter((j) => j.ws === s.ws).sort((a, b) => b.createdAt - a.createdAt);
  const jobs = all.filter((j) => (s.jobFilter === 'failed' ? j.status === 'failed' : s.jobFilter === 'running' ? j.status === 'running' || j.status === 'queued' : true));
  const totalCost = round1(jobs.filter((j) => j.status === 'succeeded').reduce((n, j) => n + j.cost, 0));
  const fails = failJobs(s).length;
  const project = s.projects.find((p) => p.id === s.ws);
  return (
    <div className="page">
      <div className="toolbar">
        <div className="page-title-block">
          <span className="page-title">任务记录</span>
          <span className="page-sub">
            {project?.name} · {jobs.length} 个任务 · 实际消耗 {totalCost} 点（不含失败与已取消）
          </span>
        </div>
        <span className="grow" />
        <div className="mini-tabs">
          {(
            [
              ['all', '全部'],
              ['failed', '失败'],
              ['running', '进行中'],
            ] as const
          ).map(([k, n]) => (
            <button key={k} className={s.jobFilter === k ? 'active' : ''} onClick={() => setState((st) => void (st.jobFilter = k))}>
              {n}
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={() => goStudio()}>
          <Icon name="wand" />
          回到创作台
        </button>
      </div>
      {fails > 0 && (
        <div className="alert-bar">
          <Icon name="alert" />
          <span>
            <b>{fails} 个任务失败</b>：多为参数超限或时长超限，展开行可直接「按建议重试」。
          </span>
          <span className="right">
            <button className="btn sm ai" onClick={() => setState((st) => void (st.jobFilter = 'failed'))}>
              <Icon name="filter" />
              只看失败
            </button>
          </span>
        </div>
      )}
      <div className="card table-card jobs-table">
        <div className="t-head">
          <span />
          <span>任务</span>
          <span>提示词 / 参数</span>
          <span>状态</span>
          <span>耗时</span>
          <span className="th-right">点数</span>
          <span className="th-right">操作</span>
        </div>
        {jobs.length ? (
          jobs.map((j) => <JobRow key={j.id} j={j} open={!!s.expanded[j.id]} />)
        ) : (
          <Empty icon="list" title="这个范围内没有任务" desc="换一个项目或筛选条件，或回创作台发起一次生成。" />
        )}
        <div className="table-foot">
          <span>共 {jobs.length} 个任务</span>
          <span className="dim">·</span>
          <span>
            成功 {jobs.filter((j) => j.status === 'succeeded').length} · 失败 {jobs.filter((j) => j.status === 'failed').length} · 进行中{' '}
            {jobs.filter((j) => j.status === 'running' || j.status === 'queued').length}
          </span>
          <span className="right dim">任务记录永久保留，不会被任何一步隐式删除</span>
        </div>
      </div>
      <div className="table-note">
        <Icon name="alert" />
        <span>点任意一行可展开，查看失败原因、修复建议与该任务的产出。</span>
      </div>
    </div>
  );
}

function JobRow({ j, open }: { j: Job; open: boolean }) {
  const m = useStore((s) => modelOf(s, j.model));
  const project = useStore((s) => s.projects.find((p) => p.id === j.ws));
  return (
    <>
      <div className={`t-row ${open ? 'open' : ''} ${j.status === 'failed' ? 'row-fail' : ''}`} onClick={() => toggleJob(j.id)}>
        <span className="caret">
          <Icon name="chev-right" />
        </span>
        <div className="cell-task">
          <TaskIc type={j.type} />
          <div className="task-main">
            <div className="task-name">
              <span className="name-text">{j.name}</span>
              {j.refs.length > 0 && (
                <span className="chip outline">
                  <Icon name="link" />
                  参考 {j.refs.length}
                </span>
              )}
              {j.fixed && (
                <span className="chip success">
                  <Icon name="check" />
                  已修复{j.fixLog?.length ? ` · ${j.fixLog.join(' · ')}` : ''}
                </span>
              )}
              {j.divergeAxis && (
                <span className="chip ai">
                  <Icon name="sparkles" />
                  发散 · {j.divergeAxis}
                </span>
              )}
              {j.platform && (
                <span className="chip brand">
                  <Icon name="crop" />
                  适配 · {j.platform}
                </span>
              )}
              {j.source === 'api' && <span className="chip outline">API</span>}
            </div>
            <div className="task-meta">
              {m.name}
              <span className="dim">·</span>
              {project?.name || '—'}
              <span className="dim">·</span>
              {timeLabel(j.createdAt)}
              {j.results.length > 0 && (
                <>
                  <span className="dim">·</span>产出 {j.results.length} 项
                </>
              )}
            </div>
          </div>
        </div>
        <div className="cell-detail">
          <span className="prompt-line">{promptBrief(j.prompt)}</span>
          <span className="tiny dim">{paramsBrief(j)}</span>
        </div>
        <div>
          <StatusChip status={j.status} />
          {j.status === 'running' && (
            <div className="qbar" style={{ marginTop: 5 }}>
              <i style={{ width: `${j.progress || 0}%` }} />
            </div>
          )}
        </div>
        <div className="cell-time">
          <span className="time-line">{j.durText || (j.status === 'running' ? `${j.progress || 0}%` : '——')}</span>
          <span className="time-note">
            {j.status === 'failed' ? <span className="fail-link">{j.fail?.code}</span> : j.status === 'queued' ? j.queueNote || '排队中' : ''}
          </span>
        </div>
        <div className="right num strong">{m.usageBilling ? '按量' : j.cost}</div>
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          {j.status === 'failed' && (
            <button className="btn sm ai" onClick={() => void fixJob(j.id)}>
              <Icon name="wand" />
              修复重试
            </button>
          )}
          {j.status === 'succeeded' && (
            <button className="btn sm ghost" onClick={() => openJob(j.id)}>
              {j.results.length ? '看产出' : '详情'}
            </button>
          )}
          {(j.status === 'running' || j.status === 'queued') && (
            <button className="btn sm ghost" onClick={() => void cancelJob(j.id)}>
              取消
            </button>
          )}
          {j.status === 'canceled' && (
            <button className="btn sm ghost" onClick={() => void retryJob(j.id)}>
              重跑
            </button>
          )}
        </div>
      </div>
      {open && <JobSub j={j} />}
    </>
  );
}

function JobSub({ j }: { j: Job }) {
  const s = useStore();
  const items = resultsOfJob(s, j);
  return (
    <div className="sub-wrap">
      <div className="sub-inner">
        {j.status === 'failed' && j.fail && (
          <div className="alert-bar" style={{ marginBottom: 10 }}>
            <Icon name="alert" />
            <span>
              <b>{j.fail.code}</b> · {j.fail.reason}
              <br />
              <span className="tiny">修复建议：{j.fail.fix}</span>
            </span>
            <span className="right">
              <button className="btn sm ai" onClick={() => void fixJob(j.id)}>
                <Icon name="wand" />
                按建议重试
              </button>
              <button className="btn sm ghost" onClick={() => void retryJob(j.id)}>
                原样重试
              </button>
            </span>
          </div>
        )}
        <div className="sub-toolbar">
          <span className="hint">
            {items.length
              ? `产出 ${items.length} 项 · 采用 ${items.filter((r) => r.status === 'adopted').length} 项`
              : j.status === 'running'
                ? '生成中，产出会在完成后自动出现在画布顶部。'
                : j.status === 'queued'
                  ? '排队中，尚未开始生成。'
                  : j.status === 'canceled'
                    ? '任务已取消，可重跑。'
                    : '该任务没有产出。'}
          </span>
          <span className="grow" />
          {items.length > 0 && (
            <>
              <button className="btn sm ghost" onClick={() => adoptAll(j.id)}>
                <Icon name="check" />
                全部采用
              </button>
              <button className="btn sm ghost" onClick={() => setState((st) => void ((st.page = 'library'), (st.libTab = 'lib')))}>
                <Icon name="inbox" />
                在素材库查看
              </button>
            </>
          )}
        </div>
        {items.length > 0 && (
          <div className="sub-table">
            {items.map((r, i) => (
              <div key={r.id} className="sub-row">
                <span className="sub-thumb">
                  <MediaThumb r={r} />
                </span>
                <div>
                  <div className="strong">
                    #{i + 1} {r.title}
                  </div>
                  <div className="tiny dim">
                    {modelOf(s, r.model).name} · 种子 {r.seed} · {r.ratio}
                    {r.dur ? ` · ${r.dur}s` : ''}
                  </div>
                </div>
                <div>
                  {r.status === 'adopted' ? (
                    <span className="chip success">
                      <span className="cdot" />
                      已采用
                    </span>
                  ) : r.status === 'fav' ? (
                    <span className="chip warn">
                      <span className="cdot" />
                      收藏
                    </span>
                  ) : (
                    <span className="chip neutral">
                      <span className="cdot" />
                      待选
                    </span>
                  )}
                </div>
                <div className="tiny dim">{{ inbox: '收件箱', canvas: '画布', library: '素材库', draft: '草稿箱' }[r.home]}</div>
                <div className="row-actions">
                  <button className="icon-btn" title="下载" onClick={() => downloadResult(r.id)}>
                    <Icon name="download" />
                  </button>
                  <button className="icon-btn" title="详情" onClick={() => openResult(r.id)}>
                    <Icon name="eye" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- 素材库 ---------------- */

function LibTabs() {
  const s = useStore();
  const lib = libResults(s).filter((r) => inScope(s, r)).length;
  const draft = draftResults(s).filter((r) => inScope(s, r)).length;
  const posts = s.posts.filter((p) => inScope(s, p)).length;
  const tabs: ['lib' | 'draft' | 'post', string, string, number][] = [
    ['lib', '素材库', 'check', lib],
    ['draft', '草稿箱', 'box', draft],
    ['post', '帖子', 'send', posts],
  ];
  return (
    <div className="lib-tabs">
      {tabs.map(([k, n, ic, c]) => (
        <button key={k} className={s.libTab === k ? 'on' : ''} onClick={() => setState((st) => void ((st.libTab = k), (st.libFilter = 'all')))}>
          <Icon name={ic} />
          {n} <i className="num">{c}</i>
        </button>
      ))}
    </div>
  );
}

function ScopeChips() {
  const scope = useStore((s) => s.libScope);
  return (
    <>
      <span className="of-label">范围</span>
      {(
        [
          ['ws', '当前项目'],
          ['all', '全部项目'],
        ] as const
      ).map(([k, n]) => (
        <button key={k} className={`fchip ${scope === k ? 'on' : ''}`} onClick={() => setState((st) => void (st.libScope = k))}>
          {n}
        </button>
      ))}
    </>
  );
}

const matchSearch = (s: ReturnType<typeof useStore.getState>, r: Result) => {
  if (!s.libSearch) return true;
  const j = jobById(s, r.job);
  return `${r.title} ${j ? j.prompt : ''} ${r.tags.join(' ')} ${r.note || ''}`.toLowerCase().includes(s.libSearch.toLowerCase());
};

export function LibraryPage() {
  const s = useStore();
  if (s.libTab === 'draft') return <DraftsPage />;
  if (s.libTab === 'post') return <PostsPage />;
  const all = libResults(s).filter((r) => inScope(s, r));
  const count = (k: string) => all.filter((r) => (k === 'all' ? true : k === 'adopted' ? r.status === 'adopted' : k === 'fav' ? r.status === 'fav' : r.type === k)).length;
  const list = all
    .filter((r) => (['image', 'video', 'audio'].includes(s.libFilter) ? r.type === s.libFilter : s.libFilter === 'adopted' ? r.status === 'adopted' : s.libFilter === 'fav' ? r.status === 'fav' : true))
    .filter((r) => matchSearch(s, r));
  return (
    <div className="page">
      <div className="toolbar">
        <div className="page-title-block">
          <span className="page-title">素材库</span>
          <span className="page-sub">
            {s.libScope === 'all' ? '全部项目' : wsShort(s, s.ws).name} · {all.length} 项已保存
          </span>
        </div>
        <span className="grow" />
        <LibTabs />
      </div>
      <div className="lib-stats">
        {(
          [
            ['全部产出', all.length, '项'],
            ['已采用', count('adopted'), '项'],
            ['收藏', count('fav'), '项'],
            ['图像 / 视频 / 音频', `${count('image')} / ${count('video')} / ${count('audio')}`, ''],
          ] as const
        ).map(([k, v, u]) => (
          <div key={k} className="lib-stat">
            <span className="k">{k}</span>
            <span className="v num">
              {v}
              <i>{u}</i>
            </span>
          </div>
        ))}
      </div>
      <div className="lib-filters">
        <ScopeChips />
        <span className="tf-sep" />
        <span className="of-label">类型与状态</span>
        {(
          [
            ['all', '全部'],
            ['image', '图像'],
            ['video', '视频'],
            ['audio', '音频'],
            ['adopted', '已采用'],
            ['fav', '收藏'],
          ] as const
        ).map(([k, n]) => (
          <button key={k} className={`fchip ${s.libFilter === k ? 'on' : ''}`} onClick={() => setState((st) => void (st.libFilter = k))}>
            {n} <i className="num">{count(k)}</i>
          </button>
        ))}
        <span className="tf-sep" />
        <div className="search-mini">
          <Icon name="search" />
          <input placeholder="搜索标题 / 提示词 / 标签" value={s.libSearch} onChange={(e) => setState((st) => void (st.libSearch = e.target.value))} />
        </div>
        <span className="grow" />
        <span className="tiny dim">共 {list.length} 项匹配</span>
      </div>
      {s.libSelect.length > 0 && (
        <div className="lib-pack-bar">
          <span className="lpb-n">
            已选 <b className="num">{s.libSelect.length}</b> 项
          </span>
          <span className="tiny dim">选 ≥2 项就能打包成一条帖子</span>
          <span className="grow" />
          <button className="btn sm ghost" onClick={() => setState((st) => void (st.libSelect = []))}>
            清空选择
          </button>
          <button className="btn sm primary" disabled={s.libSelect.length < 2} onClick={libPack}>
            <Icon name="send" />
            打包成帖
          </button>
        </div>
      )}
      {list.length ? (
        <div className="result-grid">
          {list.map((r, i) => (
            <ResultCard key={r.id} r={r} idx={i + 1} picked={s.libSelect.includes(r.id)} />
          ))}
        </div>
      ) : (
        <Empty icon="inbox" title="没有匹配的产出" desc="调整筛选条件或清空搜索词，也可以切到「全部项目」。产出要在画布上「保存到素材库」才会出现在这里。" />
      )}
      <div className="table-note">
        <Icon name="link" />
        <span>卡片可以直接拖进画布当参考；「变体」会把该结果设为参考素材并回填提示词。</span>
      </div>
    </div>
  );
}

const dragProps = (rid: string) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => {
    setState((s) => void (s.dragRid = rid));
    document.body.classList.add('cvs-dragging');
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/x-aigc-rid', rid);
  },
  onDragEnd: () => {
    setState((s) => void (s.dragRid = null));
    document.body.classList.remove('cvs-dragging');
  },
});

function ResultCard({ r, idx, picked }: { r: Result; idx: number; picked: boolean }) {
  const s = useStore();
  const playT = s.play.id === r.id ? s.play.t : -1;
  const playing = playT >= 0;
  const isMedia = r.type !== 'image';
  const adopted = r.status === 'adopted';
  const fav = r.status === 'fav';
  const j = jobById(s, r.job);
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <article className={`result-card ${adopted ? 'adopted' : ''}`} onClick={() => openResult(r.id)} title="拖进画板当参考" {...dragProps(r.id)}>
      <div className={`rc-media ratio-${r.ratio.replace(':', '-')} ${playing ? 'playing' : ''}`}>
        <MediaThumb r={r} playable />
        <div className="rc-shade" />
        <div className="rc-badges">
          <span className="rc-badge">{r.ratio}</span>
          {r.isNew && <span className="rc-badge new">新</span>}
          {j?.divergeAxis && (
            <span className="rc-badge pick">
              <Icon name="sparkles" />
              {j.divergeAxis}
            </span>
          )}
          {r.edit && <span className="rc-badge">已编辑</span>}
          {isMedia && (
            <span className={`rc-badge ${r.type === 'video' ? 'violet' : 'blue'}`}>
              <Icon name={TYPES[r.type].ic} />
              {r.dur}s
            </span>
          )}
          {adopted ? (
            <span className="rc-badge green">
              <Icon name="check" />
              已采用
            </span>
          ) : fav ? (
            <span className="rc-badge">
              <Icon name="star" />
              收藏
            </span>
          ) : null}
        </div>
        <div className="rc-ops">
          <button className={`rc-op ${fav ? 'on' : ''}`} title="收藏到审美库" onClick={stop(() => void favResult(r.id))}>
            <Icon name="star" />
          </button>
          <button className="rc-op" title="在编辑器中打开" onClick={stop(() => openInEditor(r.id))}>
            <Icon name="crop" />
          </button>
          <button className="rc-op" title="以此为参考生成变体" onClick={stop(() => makeVariant(r.id))}>
            <Icon name="refresh" />
          </button>
          <button className="rc-op" title="下载" onClick={stop(() => downloadResult(r.id))}>
            <Icon name="download" />
          </button>
          <button className="rc-op" title="编辑标题 / 说明 / 标签" onClick={stop(() => openDrawer('edit', r.id))}>
            <Icon name="pen" />
          </button>
        </div>
        <button className={`rc-pick ${picked ? 'on' : ''}`} title="选中以打包成帖" onClick={stop(() => libSel(r.id))}>
          <Icon name={picked ? 'check' : 'plus'} />
        </button>
        {isMedia && (
          <button className="rc-center-play" title="播放" onClick={stop(() => togglePlay(r.id))}>
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
        )}
        {isMedia && (
          <div className="rc-now">
            <i style={{ width: `${playing ? Math.min(100, (playT / (r.dur || 5)) * 100) : 0}%` }} />
          </div>
        )}
        {r.type === 'audio' && <Wave r={r} cls="rc-wave" />}
        {isMedia && <span className="rc-dur">{mmss(playing ? playT : r.dur)}</span>}
      </div>
      <div className="rc-foot">
        <div className="rc-line">
          <span className="rc-idx">#{idx}</span>
          <span className="grow">{r.title}</span>
        </div>
        <div className="rc-line">
          <ProjectMini ws={r.ws} />
          <span className="tiny dim">{modelOf(s, r.model).name}</span>
        </div>
        <div className="rc-line rc-tags">
          {(r.tags || [])
            .filter((x) => x !== r.ratio)
            .slice(0, 2)
            .map((x) => (
              <span key={x} className="rc-tag">
                {x}
              </span>
            ))}
        </div>
        <div className="rc-actions">
          <button className={`btn sm ${adopted ? 'ghost' : 'primary'}`} onClick={stop(() => adoptResult(r.id))}>
            {adopted && <Icon name="check" />}
            {adopted ? '已采用' : '采用'}
          </button>
          <button className="btn sm ghost" onClick={stop(() => openResult(r.id))}>
            详情
          </button>
        </div>
      </div>
    </article>
  );
}

function DraftsPage() {
  const s = useStore();
  const all = draftResults(s)
    .filter((r) => inScope(s, r))
    .sort((a, b) => b.createdAt - a.createdAt);
  const list = all.filter((r) => (['image', 'video', 'audio'].includes(s.libFilter) ? r.type === s.libFilter : true)).filter((r) => matchSearch(s, r));
  const c = (k: string) => (k === 'all' ? all.length : all.filter((r) => r.type === k).length);
  return (
    <div className="page">
      <div className="toolbar">
        <div className="page-title-block">
          <span className="page-title">素材库</span>
          <span className="page-sub">
            {s.libScope === 'all' ? '全部项目' : wsShort(s, s.ws).name} · 草稿箱 {all.length} 项
          </span>
        </div>
        <span className="grow" />
        <LibTabs />
      </div>
      <div className="draft-note">
        <Icon name="box" />
        <span>
          <b>草稿箱</b>存放生成后没被拖进画布的内容。它们没有删除——想用的话「捞回画布」再加工，或者直接「存进素材库」。
        </span>
      </div>
      <div className="lib-filters">
        <ScopeChips />
        <span className="tf-sep" />
        <span className="of-label">类型</span>
        {(
          [
            ['all', '全部'],
            ['image', '图像'],
            ['video', '视频'],
            ['audio', '音频'],
          ] as const
        ).map(([k, n]) => (
          <button key={k} className={`fchip ${s.libFilter === k ? 'on' : ''}`} onClick={() => setState((st) => void (st.libFilter = k))}>
            {n} <i className="num">{c(k)}</i>
          </button>
        ))}
        <span className="tf-sep" />
        <div className="search-mini">
          <Icon name="search" />
          <input placeholder="搜索标题 / 提示词 / 标签" value={s.libSearch} onChange={(e) => setState((st) => void (st.libSearch = e.target.value))} />
        </div>
        <span className="grow" />
        <span className="tiny dim">共 {list.length} 项</span>
      </div>
      {list.length ? (
        <div className="result-grid">
          {list.map((r) => (
            <article key={r.id} className="result-card draft" {...dragProps(r.id)}>
              <div className={`rc-media ratio-${r.ratio.replace(':', '-')}`}>
                <MediaThumb r={r} />
                <div className="rc-shade" />
                <div className="rc-badges">
                  <span className="rc-badge">{r.ratio}</span>
                  <span className="rc-badge">
                    <Icon name="box" />
                    草稿
                  </span>
                  {r.type !== 'image' && (
                    <span className={`rc-badge ${r.type === 'video' ? 'violet' : 'blue'}`}>
                      <Icon name={TYPES[r.type].ic} />
                      {r.dur}s
                    </span>
                  )}
                </div>
                <div className="rc-ops">
                  <button className="rc-op" title="捞回画布" onClick={() => toCanvas(r.id)}>
                    <Icon name="layers" />
                  </button>
                  <button className="rc-op" title="存进素材库" onClick={() => draftToLib(r.id)}>
                    <Icon name="check" />
                  </button>
                  <button className="rc-op" title="下载" onClick={() => downloadResult(r.id)}>
                    <Icon name="download" />
                  </button>
                </div>
              </div>
              <div className="rc-foot">
                <div className="rc-line">
                  <span className="grow" title={r.title}>
                    {r.title}
                  </span>
                </div>
                <div className="rc-line">
                  <ProjectMini ws={r.ws} />
                  <span className="tiny dim">{modelOf(s, r.model).name}</span>
                </div>
                <div className="rc-line rc-tags">
                  {(r.tags || [])
                    .filter((x) => x !== r.ratio)
                    .slice(0, 2)
                    .map((x) => (
                      <span key={x} className="rc-tag">
                        {x}
                      </span>
                    ))}
                </div>
                <div className="rc-actions">
                  <button className="btn sm ghost" onClick={() => toCanvas(r.id)}>
                    <Icon name="layers" />
                    捞回画布
                  </button>
                  <button className="btn sm primary" onClick={() => draftToLib(r.id)}>
                    <Icon name="check" />
                    存进素材库
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty icon="check" title="草稿箱是空的" desc="生成之后没拖进画布的内容会落到这里，不用手动清理。" />
      )}
    </div>
  );
}

/** 捞回画布：草稿可能属于别的项目，先切到它的项目再放进去 */
function toCanvas(rid: string) {
  const s = useStore.getState();
  const r = resultById(s, rid);
  if (!r) return;
  setState((st) => {
    if (st.ws !== r.ws) st.ws = r.ws;
    st.page = 'studio';
    st.studioTab = 'gen';
    st.canvasOpen = true;
  });
  keepResult(rid);
}

function PostsPage() {
  const s = useStore();
  const list = s.posts.filter((p) => inScope(s, p)).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="page">
      <div className="toolbar">
        <div className="page-title-block">
          <span className="page-title">素材库</span>
          <span className="page-sub">
            {s.libScope === 'all' ? '全部项目' : wsShort(s, s.ws).name} · {list.length} 条帖子草稿
          </span>
        </div>
        <span className="grow" />
        <button className="btn primary sm" onClick={postNew}>
          <Icon name="plus" />
          新建帖子
        </button>
        <LibTabs />
      </div>
      <div className="draft-note">
        <Icon name="send" />
        <span>
          <b>帖子</b>是素材库攒够之后打包出来的成品：标题 + 正文 + 配图序列。保存在本机，可以导出 Markdown 或直接复制正文。
        </span>
      </div>
      <div className="lib-filters">
        <ScopeChips />
        <span className="grow" />
        <span className="tiny dim">共 {list.length} 条</span>
      </div>
      {list.length ? (
        <div className="result-grid">
          {list.map((p, i) => {
            const items = p.items.map((id) => resultById(s, id)).filter((r): r is Result => !!r);
            const plat = POST_PLATFORMS.find((x) => x.k === p.platform);
            return (
              <article key={p.id} className="result-card post-card" onClick={() => openDrawer('post', p.id)}>
                <div className="pc-media">
                  {items.length ? (
                    items.slice(0, 4).map((r, k) => (
                      <span key={r.id} className={`pc-cell pc-${Math.min(items.length, 4)}`} style={{ '--i': k } as React.CSSProperties}>
                        <MediaThumb r={r} />
                      </span>
                    ))
                  ) : (
                    <span className="pc-empty">
                      <Icon name="image" />
                    </span>
                  )}
                  <span className="pc-count">{items.length} 图</span>
                </div>
                <div className="rc-foot">
                  <div className="rc-line">
                    <span className="rc-idx">#{i + 1}</span>
                    <span className="grow">{p.title || '未命名帖子'}</span>
                  </div>
                  <div className="rc-line">
                    {plat && (
                      <span className="plat-mini">
                        <i style={{ background: plat.color }} />
                        {plat.n}
                      </span>
                    )}
                    <span className="grow" />
                    <span className="tiny dim">
                      {(p.body || '').length} 字 · {timeLabel(p.updatedAt)}
                    </span>
                  </div>
                  <div className="rc-line rc-tags">
                    {(p.body || '').slice(0, 30)}
                    {(p.body || '').length > 30 ? '…' : ''}
                  </div>
                  <div className="rc-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm primary" onClick={() => openDrawer('post', p.id)}>
                      <Icon name="pen" />
                      编辑
                    </button>
                    <button className="btn sm ghost" onClick={() => postExport(p.id)}>
                      导出
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty icon="send" title="还没有帖子草稿" desc="回「素材库」勾选两张以上的产出，点「打包成帖」，就能在这里继续补标题和正文。" />
      )}
    </div>
  );
}
