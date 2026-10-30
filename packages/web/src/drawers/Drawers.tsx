import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { AccountDocuments, ForgotReply, Job, OrderDto, RegisterStartReply, Result } from '@aigc/shared';
import { HELP_TOPICS, MAX_REFS, POST_PLATFORMS, TYPES, mmss, paramsBrief, timeLabel } from '@aigc/shared';
import { useStore } from '../store';
import {
  addRefItem,
  adoptResult,
  cancelJob,
  cancelOrder,
  closeActiveOrder,
  closeDrawer,
  copyPromptOf,
  createOrder,
  deleteProject,
  deleteResult,
  downloadResult,
  favResult,
  fixJob,
  forgotPassword,
  goJobs,
  goStudio,
  helpJump,
  loadAccountDocuments,
  loadOrders,
  loadPacks,
  loginCancel,
  loginStart,
  logout,
  makeVariant,
  openDrawer,
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
  prepayOrder,
  refPool,
  registerComplete,
  registerStart,
  renameProject,
  resetPassword,
  retryJob,
  saveMeta,
} from '../store/actions';
import { addResultToCanvas } from '../canvas/ops';
import { togglePlay } from '../store/player';
import { balance, dailyFreeLeft, jobById, libResults, modelOf, payChannels, queueJobs, resultById, topupOpen } from '../store/selectors';
import { cssOfEdit } from '../lib/util';
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
        {d.type === 'account' && <AccountDrawer />}
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
              {r.type === 'image' ? (
                <img src={r.src} alt={r.title} style={cssOfEdit(r.edit?.css)} />
              ) : r.type === 'video' ? (
                <video src={r.src} controls playsInline style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }} />
              ) : (
                <div className="audio-tile big">
                  <Icon name="waveform" className="lg" />
                </div>
              )}
            </div>
            {isMedia && r.type === 'audio' && (
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
            {r.type === 'image' ? '原件已保存在本机，可直接下载或带去继续生成。' : '原件已保存在本机，可直接播放与下载。'}
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
  const loggedIn = useStore((s) => !!s.session?.loggedIn);
  const directOn = useStore((s) => !!(s.settings?.direct.enabled && s.settings.direct.hasKey));
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
              {loggedIn ? '当前走云端网关' : directOn ? '当前为直连模式' : '还没有接入生成能力'}
            </div>
            <ul>
              {loggedIn ? (
                <>
                  <li>图像、视频、配音经云端网关真实生成，按用量扣点数，结果保存在本机。</li>
                  <li>生成失败或取消时，冻结的点数自动退回。</li>
                </>
              ) : directOn ? (
                <>
                  <li>用你自己的 TreeCloud Key 直连上游，费用在 TreeCloud 结算，不扣平台点数。</li>
                  <li>登录云端账号后也可以改走平台点数。</li>
                </>
              ) : (
                <li>先登录账号（微信 / 支付宝充值点数），或在「设置 · 直连」填自己的 TreeCloud Key，才能开始生成。</li>
              )}
              <li>图片请求不会自动重试：超时不代表没执行，重提可能再次计费。</li>
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

/* ---------------- 账号：登录 / 注册 / 找回 ---------------- */

/* 汇付聚合正扫当前固定走支付宝，界面按用户看到的支付方式命名 */
const CHANNEL_LABEL: Record<string, string> = { huifu: '支付宝', wechat: '微信支付', alipay: '支付宝' };
const channelName = (c: string) => CHANNEL_LABEL[c] || c;

function Qr({ content, size = 168 }: { content: string; size?: number }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(content, { width: size * 2, margin: 1, color: { dark: '#171A23', light: '#FFFFFF' } })
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setUrl(''));
    return () => {
      alive = false;
    };
  }, [content, size]);
  return url ? <img className="qr-img" src={url} alt="二维码" width={size} height={size} /> : <div className="qr-img qr-empty" style={{ width: size, height: size }} />;
}

/** 验证码倒计时：每次发送（resetKey 变化）从 seconds 重新开始 */
function useResend(seconds: number, resetKey: number) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
  }, [seconds, resetKey]);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return left;
}

function RegisterForm({ onBack }: { onBack: () => void }) {
  const [identifier, setIdentifier] = useState('');
  const [start, setStart] = useState<RegisterStartReply | null>(null);
  const [docs, setDocs] = useState<AccountDocuments | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [done, setDone] = useState<{ username: string } | null>(null);
  const left = useResend(start ? start.resendAfterSeconds : 0, nonce);

  useEffect(() => {
    void loadAccountDocuments()
      .then(setDocs)
      .catch(() => setDocs(null));
  }, []);

  const send = async () => {
    setErr(null);
    if (!identifier.trim()) return setErr('请填写手机号或邮箱');
    setBusy(true);
    try {
      const r = await registerStart(identifier.trim());
      setStart(r);
      setNonce((n) => n + 1);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!start) return;
    setErr(null);
    if (!/^\d{6}$/.test(code.trim())) return setErr('验证码是 6 位数字');
    if (password.length < 10 || password.length > 128) return setErr('密码需要 10–128 位');
    if (!agree) return setErr('请先同意用户协议与隐私政策');
    if (!docs) return setErr('条款版本还没读到，请检查网络后重试');
    setBusy(true);
    try {
      const r = await registerComplete({
        challengeId: start.challengeId,
        identifier: identifier.trim(),
        code: code.trim(),
        password,
        displayName: name.trim() || undefined,
        consents: { termsVersion: docs?.termsVersion || '', privacyVersion: docs?.privacyVersion || '', marketing },
      });
      setDone({ username: r.username });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="auth-wait">
        <div className="auth-wait-ic">
          <Icon name="check" />
        </div>
        <b>账号已创建</b>
        <span className="tiny dim">用户名 {done.username}。现在用刚才的密码登录就能开始使用。</span>
        <button className="btn primary" onClick={onBack}>
          去登录
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">手机号 / 邮箱</span>
        </div>
        <input
          className="form-input"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="用于接收验证码"
          autoComplete="username"
          disabled={!!start}
        />
      </div>
      {!start ? (
        <div className="auth-actions">
          <button className="btn primary" disabled={busy} onClick={() => void send()}>
            {busy ? '正在发送…' : '获取验证码'}
          </button>
        </div>
      ) : (
        <>
          <div className="field-block">
            <div className="field-head">
              <span className="field-label">验证码</span>
              <span className="grow" />
              <button className="link-btn" disabled={left > 0 || busy} onClick={() => void send()}>
                {left > 0 ? `${left}s 后重发` : '重新发送'}
              </button>
            </div>
            <input className="form-input num" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 位数字" inputMode="numeric" autoComplete="one-time-code" />
            <div className="field-hint">验证码已发送到 {start.maskedIdentifier || identifier}</div>
          </div>
          <div className="field-block">
            <div className="field-head">
              <span className="field-label">设置密码</span>
            </div>
            <input className="form-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="10–128 位，含大小写字母、数字和符号" autoComplete="new-password" />
          </div>
          <div className="field-block">
            <div className="field-head">
              <span className="field-label">昵称</span>
              <span className="field-hint">选填</span>
            </div>
            <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="显示在账号里的名字" maxLength={40} />
          </div>
          <div className="field-block">
            <label className="auth-consent">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>
                我已阅读并同意
                {docs ? `《用户协议》${docs.termsVersion} 与《隐私政策》${docs.privacyVersion}` : '用户协议与隐私政策'}
              </span>
            </label>
            <label className="auth-consent">
              <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
              <span>接收产品更新与优惠信息（可随时退订）</span>
            </label>
          </div>
          <div className="auth-actions">
            <button className="btn primary" disabled={busy} onClick={() => void submit()}>
              {busy ? '正在创建…' : '创建账号'}
            </button>
          </div>
        </>
      )}
      {err && <div className="auth-err">{err}</div>}
    </>
  );
}

function ForgotForm({ onBack }: { onBack: () => void }) {
  const [identifier, setIdentifier] = useState('');
  const [start, setStart] = useState<ForgotReply | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const send = async () => {
    setErr(null);
    if (!identifier.trim()) return setErr('请填写手机号或邮箱');
    setBusy(true);
    try {
      setStart(await forgotPassword(identifier.trim()));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!start) return;
    setErr(null);
    if (!/^\d{6}$/.test(code.trim())) return setErr('验证码是 6 位数字');
    if (password.length < 10 || password.length > 128) return setErr('密码需要 10–128 位');
    setBusy(true);
    try {
      await resetPassword({ challengeId: start.challengeId, identifier: identifier.trim(), code: code.trim(), newPassword: password });
      setDone(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="auth-wait">
        <div className="auth-wait-ic">
          <Icon name="check" />
        </div>
        <b>密码已重置</b>
        <span className="tiny dim">用新密码登录即可。</span>
        <button className="btn primary" onClick={onBack}>
          去登录
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">手机号 / 邮箱</span>
        </div>
        <input className="form-input" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="注册时用的号码或邮箱" disabled={!!start} />
      </div>
      {!start ? (
        <div className="auth-actions">
          <button className="btn primary" disabled={busy} onClick={() => void send()}>
            {busy ? '正在发送…' : '获取验证码'}
          </button>
        </div>
      ) : (
        <>
          <div className="field-block">
            <div className="field-head">
              <span className="field-label">验证码</span>
              <span className="grow" />
              <button className="link-btn" disabled={busy} onClick={() => void send()}>
                重新发送
              </button>
            </div>
            <input className="form-input num" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 位数字" inputMode="numeric" autoComplete="one-time-code" />
          </div>
          <div className="field-block">
            <div className="field-head">
              <span className="field-label">新密码</span>
            </div>
            <input className="form-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="10–128 位，含大小写字母、数字和符号" autoComplete="new-password" />
          </div>
          <div className="auth-actions">
            <button className="btn primary" disabled={busy} onClick={() => void submit()}>
              {busy ? '正在重置…' : '重置密码'}
            </button>
          </div>
        </>
      )}
      {err && <div className="auth-err">{err}</div>}
    </>
  );
}

function AccountDrawer() {
  const s = useStore();
  const flow = s.loginFlow;
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  if (s.session?.loggedIn) {
    const p = s.session.profile;
    return (
      <>
        <Head ic="user" title={p?.nickname || '已登录'} sub={<span>{p?.phoneMasked || '云端账号'} · 点数跟着账号走，换设备不丢</span>} />
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
                <div className="tiny dim">今日免费 {dailyFreeLeft(s)} 点</div>
                <div className="wc-split">
                  <span>1 点 = ¥1</span>
                  <span>点数不过期</span>
                </div>
              </div>
            </div>
          </div>
          <div className="d-section">
            <div className="d-section-title">
              <Icon name="clock" />
              最近订单
            </div>
            <OrderList />
          </div>
        </div>
        <div className="drawer-foot">
          <button className="btn primary" onClick={() => openDrawer('topup')}>
            <Icon name="coins" />
            充值
          </button>
          <span className="grow" />
          <button className="btn ghost" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </>
    );
  }
  const registerEnabled = !!s.session?.registerEnabled;
  const browser = flow?.mode === 'browser';
  return (
    <>
      <Head
        ic="user"
        title={mode === 'login' ? '登录账号' : mode === 'register' ? '注册账号' : '找回密码'}
        sub={<span>点数、订单与用量跟着账号走；换一台设备登录就能接着用</span>}
      />
      <div className="drawer-body">
        {mode === 'login' ? (
          <>
            {!flow ? (
              <Empty
                icon="user"
                title="还没有登录"
                desc={
                  s.loginError ||
                  (s.settings?.account.provider === 'fastsso'
                    ? '登录后可以查看余额、充值与订单；生成请在「设置 · 直连 TreeCloud」填自己的 Key。'
                    : '登录后才能用平台点数生成；也可以在「设置 · 直连」里填自己的 TreeCloud Key。')
                }
              >
                <div className="auth-actions">
                  <button className="btn primary" onClick={() => void loginStart()}>
                    <Icon name="user" />
                    {s.session?.loginMode === 'device' ? '开始登录' : '使用账号登录'}
                  </button>
                  {registerEnabled && (
                    <button className="btn ghost" onClick={() => setMode('register')}>
                      注册新账号
                    </button>
                  )}
                </div>
              </Empty>
            ) : browser ? (
              <div className="auth-wait">
                <div className="auth-wait-ic">
                  <Icon name="shield" />
                </div>
                <b>已在浏览器中打开登录页</b>
                <span className="tiny dim">在浏览器里完成登录或注册，授权完成后这个抽屉会自动继续。</span>
                <a className="btn ghost" href={flow.loginUrl} target="_blank" rel="noreferrer">
                  重新打开登录页
                </a>
                <span className="chip info">
                  <span className="cdot" />
                  等待授权…
                </span>
              </div>
            ) : (
              <div className="login-box">
                {flow.qrContent && (
                  <div className="login-qr">
                    <Qr content={flow.qrContent} />
                  </div>
                )}
                <div className="login-steps">
                  <b>{flow.qrContent ? '用手机扫码，或' : '在浏览器中继续'}</b>
                  <a href={flow.loginUrl} target="_blank" rel="noreferrer">
                    在浏览器里打开登录页
                  </a>
                  <span className="tiny dim">在登录页确认后就完成授权；这个抽屉会自动继续。</span>
                  <span className="chip info">
                    <span className="cdot" />
                    等待确认…
                  </span>
                </div>
              </div>
            )}
            <div className="d-section">
              <div className="ai-note">
                <div className="ai-note-head">
                  <Icon name="shield" />
                  账号与点数
                </div>
                <ul>
                  <li>充值走支付宝，点数实时到账，不过期。</li>
                  <li>生成失败或取消，冻结的点数自动退回。</li>
                  <li>本机的项目、画板与素材仍留在这台电脑上；账号负责点数与订单归属。</li>
                </ul>
              </div>
            </div>
            {registerEnabled && !flow && (
              <div className="auth-links">
                <button className="link-btn" onClick={() => setMode('forgot')}>
                  忘记密码？
                </button>
              </div>
            )}
          </>
        ) : mode === 'register' ? (
          <RegisterForm onBack={() => setMode('login')} />
        ) : (
          <ForgotForm onBack={() => setMode('login')} />
        )}
      </div>
      <div className="drawer-foot">
        {flow && (
          <button className="btn ghost" onClick={loginCancel}>
            取消
          </button>
        )}
        {mode !== 'login' && (
          <button className="btn ghost" onClick={() => setMode('login')}>
            返回登录
          </button>
        )}
        <span className="grow" />
        <button className="btn ghost" onClick={closeDrawer}>
          关闭
        </button>
      </div>
    </>
  );
}

function OrderList() {
  const orders = useStore((s) => s.orders);
  const loaded = useStore((s) => s.orders.length > 0);
  useEffect(() => {
    if (!loaded) void loadOrders();
  }, [loaded]);
  if (!orders.length) return <div className="tiny dim">还没有订单。充值后会在这里留下记录。</div>;
  return (
    <div className="order-list">
      {orders.slice(0, 8).map((o) => (
        <div key={o.id} className="order-row">
          <span className="or-ch">
            <Icon name={o.channel === 'wechat' ? 'check' : 'coins'} />
            {channelName(o.channel)}
          </span>
          <span className="grow or-name">{o.packName}</span>
          <span className="num or-pts">+{o.points} 点</span>
          <span className="num tiny dim">¥{o.amountCny.toFixed(2)}</span>
          <span className={`chip ${o.status === 'paid' ? 'success' : o.status === 'created' || o.status === 'paying' ? 'warn' : 'neutral'}`}>
            {o.status === 'paid' ? '已支付' : o.status === 'refunded' ? '已退款' : o.status === 'closed' ? '已关闭' : '待支付'}
          </span>
          <span className="tiny dim">{timeLabel(o.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- 充值：积分档位 / 支付宝 ---------------- */

function TopupDrawer() {
  const s = useStore();
  const order = s.activeOrder;
  const loggedIn = !!s.session?.loggedIn;
  useEffect(() => {
    /* 档位、渠道与订单都要登录后才能读，未登录时不打这两个接口 */
    if (loggedIn) {
      void loadPacks();
      void loadOrders();
    }
    return () => closeActiveOrder();
  }, [loggedIn]);
  const paying = order && (order.status === 'created' || order.status === 'paying');
  /* 渠道以账号服务返回为准；undefined 表示还没读到，不展示选择 */
  const chans = payChannels(s.session);
  /* 临时的自定义测试金额：只接受整数元，且必须是上游已开通的档位 */
  const [customYuan, setCustomYuan] = useState('');
  const [customErr, setCustomErr] = useState('');
  const submitCustom = () => {
    const raw = customYuan.trim();
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
      setCustomErr('请输入整数金额，最低 ¥1');
      return;
    }
    const pack = s.packs.find((p) => p.points === n);
    if (!pack) {
      const have = s.packs.map((p) => `¥${p.amountCny}`).join(' / ') || '暂无';
      setCustomErr(`账号服务没有 ¥${n} 的档位；当前可用：${have}`);
      return;
    }
    setCustomErr('');
    void createOrder(pack.id, s.payChannel);
  };
  return (
    <>
      <Head
        ic="coins"
        icCls="amber"
        title="点数充值"
        sub={
          <span>
            1 点 = ¥1 · 按次扣费 · 点数不过期 · 余额 {balance(s)} 点
          </span>
        }
      />
      <div className="drawer-body">
        {s.session?.loggedIn && !topupOpen(s) ? (
          <Empty icon="coins" title="充值暂未开放" desc="账号服务还没有开通支付渠道。已有的点数和每日免费额度可以继续使用；开放后这里会出现充值入口。" />
        ) : s.session?.loggedIn ? (
          paying && order ? (
            <PayPanel order={order} />
          ) : (
            <>
              <div className="d-section">
                <div className="d-section-title">
                  <Icon name="coins" />
                  选择档位
                </div>
                <div className="pack-grid">
                  {s.packs.map((k) => (
                    <button
                      key={k.id}
                      className={`pack-card ${k.tag === '常用' ? 'hot' : ''}`}
                      onClick={() => void createOrder(k.id, s.payChannel)}
                    >
                      {k.tag === '常用' && <span className="pack-hot">最常用</span>}
                      <span className="pack-tag">{k.tag || k.name}</span>
                      <span className="pack-price num">¥{k.amountCny}</span>
                      <span className="pack-got num">
                        得 {k.points + (k.bonusPoints || 0)} 点{k.bonusPoints ? <i>含赠送 {k.bonusPoints}</i> : null}
                      </span>
                      <span className="pack-note">{k.note}</span>
                    </button>
                  ))}
                </div>
                {s.packsLoading && <div className="tiny dim">正在读取档位…</div>}
                {!s.packsLoading && !s.packs.length && <div className="tiny dim">账号服务暂无可用档位。</div>}
                {/* 临时测试入口：整数元自定义金额，确认可用后删除 */}
                <div className="pack-custom">
                  <span className="pack-tag">自定义金额</span>
                  <div className="pack-custom-row">
                    <span className="num">¥</span>
                    <input
                      className="form-input num"
                      inputMode="numeric"
                      placeholder="整数，最低 1"
                      value={customYuan}
                      onChange={(e) => {
                        setCustomYuan(e.target.value);
                        setCustomErr('');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitCustom();
                      }}
                    />
                    <button className="btn primary sm" disabled={!customYuan.trim()} onClick={submitCustom}>
                      去支付
                    </button>
                  </div>
                  {customErr ? <div className="tiny pack-custom-err">{customErr}</div> : null}
                  <div className="field-hint">临时测试入口：金额需与账号服务已开通的档位一致（1 点 = ¥1）。</div>
                </div>
              </div>
              {chans && chans.length > 0 && (
                <div className="d-section">
                  <div className="d-section-title">
                    <Icon name="link" />
                    支付渠道
                  </div>
                  <div className="mini-tabs">
                    {chans.map((k) => (
                      <button key={k} className={s.payChannel === k ? 'active' : ''} onClick={() => useStore.setState((st) => void (st.payChannel = k))}>
                        {channelName(k)}
                      </button>
                    ))}
                  </div>
                  <div className="tiny dim" style={{ marginTop: 8 }}>
                    选好档位后生成收款码，用手机扫码完成支付；点数实时到账。
                  </div>
                </div>
              )}
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
                </div>
              </div>
              <div className="d-section">
                <div className="d-section-title">
                  <Icon name="clock" />
                  订单记录
                </div>
                <OrderList />
              </div>
            </>
          )
        ) : (
          <Empty icon="user" title="先登录账号" desc="点数跟着账号走：登录后充值，换设备余额也还在。">
            <button
              className="btn primary"
              onClick={() => {
                closeDrawer();
                openDrawer('account');
              }}
            >
              去登录
            </button>
          </Empty>
        )}
      </div>
      <div className="drawer-foot">
        <span className="tiny dim">
          <Icon name="shield" />
          支付由支付宝完成，本平台不接触你的支付密码
        </span>
        <span className="grow" />
        <button className="btn ghost" onClick={closeDrawer}>
          关闭
        </button>
      </div>
    </>
  );
}

function PayPanel({ order }: { order: OrderDto }) {
  const left = Math.max(0, Math.round((order.expireAt - Date.now()) / 1000));
  const [sec, setSec] = useState(left);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setSec(Math.max(0, Math.round((order.expireAt - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [order.expireAt]);
  const ch = channelName(order.channel);
  const qr = order.qrContent || order.cashierUrl || '';
  const paid = order.status === 'paid';
  return (
    <div className="pay-panel">
      <div className="pay-head">
        <span className={`pay-ch ${order.channel}`}>{ch}</span>
        <span className="grow" />
        <span className="tiny dim num">{paid ? '已支付' : `${mmss(sec)} 后过期`}</span>
      </div>
      {qr ? (
        <div className="pay-qr">
          <Qr content={qr} size={190} />
        </div>
      ) : (
        <div className="pay-qr">
          <div className="qr-img qr-empty" style={{ width: 190, height: 190 }} />
          <button
            className="btn ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await prepayOrder(order.id);
              setBusy(false);
            }}
          >
            {busy ? '正在获取…' : '刷新收款码'}
          </button>
        </div>
      )}
      <div className="pay-amount num">¥{order.amountCny.toFixed(2)}</div>
      <div className="pay-pts">到账 {order.points} 点</div>
      <div className="pay-tip tiny dim">
        {paid ? '支付已完成，点数已到账。' : `打开${ch}扫一扫完成支付；支付成功后点数自动到账，这个页面会自动继续。`}
        {order.cashierUrl && (
          <>
            <br />
            电脑端也可以<a href={order.cashierUrl} target="_blank" rel="noreferrer">打开收银台</a>完成支付。
          </>
        )}
      </div>
      <div className="pay-actions">
        <button
          className="btn ghost"
          disabled={cancelling}
          onClick={async () => {
            if (paid) {
              closeActiveOrder();
              return;
            }
            setCancelling(true);
            await cancelOrder(order.id);
            setCancelling(false);
          }}
        >
          {paid ? '完成' : cancelling ? '正在取消…' : '取消这笔订单'}
        </button>
      </div>
    </div>
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
