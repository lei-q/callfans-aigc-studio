import type { MediaType } from '@aigc/shared';
import {
  AU_DURS,
  AUDIO_USES,
  CAMS,
  EXPAND_THRESHOLD,
  LANGS,
  MAX_REFS,
  MOODS,
  RATIOS,
  RESOS,
  SEED_PROMPTS,
  SFX_DURS,
  TYPES,
  VIDEO_RATIOS,
  VIDEO_RES,
  VOICES,
  estTimeText,
  resoOf,
} from '@aigc/shared';
import { Icon, TaskIc, jobIconCls } from '../components/common';
import { AgentDock } from '../canvas/AgentDock';
import { CanvasPanel } from '../canvas/CanvasPanel';
import { anchorApply, anchorToggle, toggleForm } from '../canvas/ops';
import { setState, useStore } from '../store';
import {
  applyOptimize,
  canAfford,
  changeModel,
  clearPrompt,
  copyPrompt,
  cycleRef,
  dismissOptimize,
  estCost,
  gen,
  openDrawer,
  openLibraryType,
  openQueue,
  optimizePrompt,
  removeRef,
  setNegative,
  setParam,
  setPrompt,
  switchPage,
  toggleAdv,
} from '../store/actions';
import { balance, boardOf, canvasItems, dailyFreeLeft, libResults, modelOf, modelsFor, queueJobs, routeInfo, topupOpen } from '../store/selectors';
import { Editor } from './Editor';

export function Studio() {
  const type = useStore((s) => s.type);
  const tab = useStore((s) => s.studioTab);
  const ws = useStore((s) => s.ws);
  const libN = useStore((s) => libResults(s).filter((r) => r.type === s.type && r.ws === ws).length);
  const qN = useStore((s) => queueJobs(s).length);
  const canvasOpen = useStore((s) => s.canvasOpen);
  const full = useStore((s) => s.cvsFull);
  const formOpen = useStore((s) => s.formOpen);
  const T = TYPES[type];
  const editing = tab === 'edit';
  return (
    <div className="page">
      <div className="studio-head">
        <TaskIc type={type} />
        <div className="page-title-block">
          <span className="page-title">{T.name}创作</span>
          <span className="page-sub">{editing ? '选一条已有产出做基础处理，保存后成为新产出' : `${T.hint} · 写一句提示词就能生成`}</span>
        </div>
        <span className="grow" />
        <button className="btn ghost" onClick={() => openLibraryType(type)}>
          <Icon name="inbox" />
          {T.name}素材 {libN}
        </button>
        <button className="btn ghost" onClick={() => openQueue(false)}>
          <Icon name="clock" />
          队列{qN ? ` ${qN}` : ''}
        </button>
        <div className="studio-tabs">
          <button className={editing ? '' : 'on'} onClick={() => setState((s) => void (s.studioTab = 'gen'))}>
            <Icon name="wand" />
            生成
          </button>
          <button className={editing ? 'on' : ''} onClick={() => setState((s) => void (s.studioTab = 'edit'))}>
            <Icon name="crop" />
            编辑
          </button>
        </div>
      </div>
      {editing ? (
        <div className="solo-col">
          <Editor />
        </div>
      ) : (
        <>
          <div className={`studio-split ${canvasOpen ? '' : 'cvs-closed'} ${full ? 'cvs-full' : ''} ${formOpen ? '' : 'form-closed'}`}>
            <div className="split-main">{formOpen ? <Composer /> : <FormStrip type={type} />}</div>
            <div className="split-side" id="canvasHost">
              <CanvasPanel />
            </div>
          </div>
          <AgentDock />
        </>
      )}
    </div>
  );
}

function FormStrip({ type }: { type: MediaType }) {
  const T = TYPES[type];
  return (
    <button className="form-strip" onClick={toggleForm} title="展开生成表单（[）">
      <span className="fs-ic">
        <Icon name={T.ic} />
      </span>
      <span className="fs-label">{T.name}生成</span>
      <span className="fs-go">
        <Icon name="chev-right" />
      </span>
    </button>
  );
}

const PARAM_NOTE = (
  <div className="param-note">
    <Icon name="check" />
    <span>以下为推荐值，不改也能直接生成；对结果不满意时再回来调整。</span>
  </div>
);

function AnchorBar() {
  const s = useStore();
  const a = boardOf(s).anchor;
  if (!a) return null;
  const it = canvasItems(s).find((i) => i.id === a.cvsId);
  if (!it) return null;
  const p = a.params;
  const txt = p.type === 'image' ? `${p.ratio} · ${resoOf(p.res).n}` : p.type === 'video' ? `${p.ratio} · ${p.dur}s` : `${p.dur}s`;
  return (
    <div className="anchor-bar">
      <span className="anchor-thumb">{it.thumb || it.type === 'image' ? <img src={it.thumb || it.src} alt="" /> : <Icon name={TYPES[it.type || 'image'].ic} />}</span>
      <div className="anchor-txt">
        <b>
          <Icon name="bookmark" />
          风格基准 · {it.t}
        </b>
        <span>
          {p.type === s.type ? '每次生成都会带上它作参考，' : `基准是${TYPES[p.type].name}，切到${TYPES[p.type].name}页生成时生效；`}参数沿用 {txt}
        </span>
      </div>
      <span className="grow" />
      <button className="btn sm ghost" onClick={anchorApply}>
        <Icon name="refresh" />
        应用参数
      </button>
      <button className="btn sm ghost" onClick={() => anchorToggle(it.id)}>
        <Icon name="x" />
        取消
      </button>
    </div>
  );
}

function Composer() {
  const s = useStore();
  const t = s.type;
  const p = s.params[t];
  const T = TYPES[t];
  const m = modelOf(s, p.model);
  const cost = estCost(s);
  const fastsso = s.settings?.account.provider === 'fastsso';
  const route = routeInfo(s, t, t === 'audio' ? p.use : undefined);
  const enough = route.kind === 'direct' ? true : route.kind === 'cloud' ? canAfford(s, cost) : false;
  const opt = s.optimize;
  const prompt = s.prompt[t];
  const plen = prompt.trim().length;
  const thin = plen < EXPAND_THRESHOLD;
  const seeded = prompt === SEED_PROMPTS[t];
  const free = dailyFreeLeft(s);
  const refs = s.refs[t];
  const models = modelsFor(s, t, t === 'audio' ? p.use : undefined);

  return (
    <section className="card composer-card">
      <div className="composer-head">
        <span className={`task-ic ${jobIconCls(t)}`}>
          <Icon name={T.ic} />
        </span>
        <div>
          <div className="ch-title">新建生成 · {T.name}</div>
          <div className="ch-sub">写提示词 → 调整必要参数 → 进队列</div>
        </div>
        <span className="grow" />
        <button className="icon-btn" onClick={toggleForm} title="收起生成表单，只留画布（[）">
          <Icon name="chev-left" />
        </button>
      </div>
      <div className="composer-body">
        <div className="field-block">
          <AnchorBar />
          <div className="field-head">
            <span className="field-label">
              <Icon name="pen" />
              {t === 'audio' && p.use === 'tts' ? '配音文案' : '提示词'}
            </span>
            {seeded && (
              <span className="chip outline">
                <Icon name="sparkles" />
                示例内容，可直接改或清空
              </span>
            )}
            {opt && (
              <span className="ai-suggest">
                <Icon name="sparkles" />
                优化建议待应用
              </span>
            )}
            <span className="grow" />
            <button className="btn sm ai" onClick={() => void optimizePrompt()} disabled={s.optimizing}>
              <Icon name="sparkles" />
              {s.optimizing ? '思考中…' : thin ? '帮我写详细' : '补充细节'}
            </button>
          </div>
          <div className="prompt-box">
            <textarea
              className="prompt-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t === 'audio' && p.use === 'tts' ? '要念的文案：写下完整的口播稿，模型会按所选音色朗读' : '描述画面 / 镜头 / 声音：主体、场景、光线、材质、运镜、语气…'}
            />
            <div className="prompt-foot">
              <button className="btn sm ghost" onClick={clearPrompt}>
                <Icon name="x" />
                清空
              </button>
              <button className="btn sm ghost" onClick={copyPrompt}>
                <Icon name="copy" />
                复制
              </button>
              <span className="prompt-count">
                {plen} 字 · {thin ? '写一句大白话就行，点右上「帮我写详细」' : '描述已足够完整'}
              </span>
            </div>
          </div>
          {opt && (
            <div className="diff-box" style={{ marginTop: 8 }}>
              <div className="diff-row">
                <span className="diff-key">{opt.mode === 'expand' ? '改写后' : '优化方向'}</span>
                <span className="diff-val">{opt.mode === 'expand' ? <span className="diff-new">{opt.result}</span> : <span className="diff-plain">{opt.note}</span>}</span>
              </div>
              {opt.mode !== 'expand' && (
                <div className="diff-row">
                  <span className="diff-key">建议追加</span>
                  <span className="diff-val">
                    <span className="diff-new">+ {opt.add}</span>
                  </span>
                </div>
              )}
              <div className="diff-row">
                <span className="diff-key">建议负面词</span>
                <span className="diff-val">
                  <span className="diff-plain">{opt.neg}</span>
                </span>
              </div>
              <div className="diff-row">
                <span className="diff-key">操作</span>
                <span className="diff-val">
                  <button className="btn sm primary" onClick={applyOptimize}>
                    <Icon name="check" />
                    {opt.mode === 'expand' ? '用这段提示词' : '应用到提示词'}
                  </button>
                  <button className="btn sm ghost" onClick={dismissOptimize}>
                    忽略
                  </button>
                  {opt.llm && <span className="chip ai">对话模型</span>}
                </span>
              </div>
            </div>
          )}
        </div>

        {t !== 'audio' && (
          <div className={`field-block ref-block ${s.refDropHot ? 'hot' : ''}`} data-ref-drop>
            <div className="field-head">
              <span className="field-label">
                <Icon name="upload" />
                参考素材
              </span>
              <span className="field-hint">
                {refs.length} / {MAX_REFS} · 从画布拖过来，或点缩略图切换参考强度
              </span>
            </div>
            <div className="ref-row">
              {refs.map((r, i) => (
                <div key={`${r.src}-${i}`} className="ref-thumb" title="点击调整参考强度" onClick={() => cycleRef(i)}>
                  <img src={r.src} alt="参考素材" />
                  <span className="rf-weight">{r.w.toFixed(2)}</span>
                  {r.from === 'canvas' && <span className="rf-from">画布</span>}
                  {r.from === 'anchor' && <span className="rf-from">基准</span>}
                  <span
                    className="rf-x"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRef(i);
                    }}
                  >
                    <Icon name="x" />
                  </span>
                </div>
              ))}
              {refs.length < MAX_REFS && (
                <button className="ref-add" title="从素材库添加参考素材" onClick={() => openDrawer('ref-add')}>
                  <Icon name="plus" />
                </button>
              )}
            </div>
            <div className="ref-note">
              <Icon name="shield" />
              {m.channel === 'direct' && t === 'image' && m.maxInputImages === 0
                ? '当前模型不支持参考图，生成时会忽略参考素材。'
                : t === 'video'
                  ? '第一张参考图会作为首帧（可在下面切换为纯文生视频）；参考图只用于本次生成，不会进入素材库。'
                  : '参考图只用于本次生成，不会进入素材库。'}
            </div>
          </div>
        )}

        <div className="field-block">
          {PARAM_NOTE}
          <div className="field-head">
            <span className="field-label">
              <Icon name="cpu" />
              模型
            </span>
            <span className="field-hint">{models.length ? m.note : ''}</span>
          </div>
          {models.length ? (
            <select className="form-select" value={p.model} onChange={(e) => changeModel(e.target.value)}>
              {models.map((x) => (
                <option key={x.id} value={x.id} disabled={x.status !== 'on'}>
                  {x.name} · {x.price} 点/{x.basis}
                  {x.status !== 'on' ? '（未开放）' : ''}
                </option>
              ))}
            </select>
          ) : (
            <div className="channel-note">
              <Icon name="alert" />
              <span>{route.kind === null ? route.reason : `当前没有可用的${T.name}模型，到「设置」里刷新模型列表。`}</span>
              {route.kind === null && (
                <button className="btn sm primary" onClick={() => openDrawer(s.session?.loggedIn ? 'topup' : 'account')}>
                  <Icon name={s.session?.loggedIn ? 'coins' : 'user'} />
                  {s.session?.loggedIn ? '去充值' : '去登录'}
                </button>
              )}
            </div>
          )}
          <Params t={t} />
        </div>

        <div className={`adv-toggle ${s.adv ? 'open' : ''}`} onClick={toggleAdv}>
          <Icon name="chev-right" />
          高级参数{s.adv ? '' : t === 'image' ? '（负面提示 · 种子 · 导出格式）' : t === 'video' ? '（负面提示 · 清晰度 · 帧率 · 循环点）' : '（负面提示 · 输出音量）'}
        </div>
        {s.adv && <Advanced t={t} />}

        <div className="cost-row">
          <div className="cost-box">
            <span className="ck">本次消耗</span>
            <span className="cv num" style={{ color: enough ? 'var(--t1)' : 'var(--red)' }}>
              {cost} 点
            </span>
          </div>
          <div className="cost-sep" />
          <div className="cost-box">
            <span className="ck">余额</span>
            <span className="cv num">{balance(s)}</span>
          </div>
          <div className="cost-sep" />
          <div className="cost-box">
            <span className="ck">预计耗时</span>
            <span className="cv num" style={{ fontSize: 14 }}>
              {estTimeText(t, p, m)}
            </span>
          </div>
          <span className="grow" />
          <span className="tiny dim">
            {route.kind === 'direct'
              ? '自定义渠道：费用由你自己的上游结算，不扣平台点数'
              : free > 0
                ? `今日免费 ${free} 点优先抵扣`
                : '1 点 = ¥1 · 生成失败自动退回'}
          </span>
        </div>

        {s.genLock ? (
          <button className="btn primary gen-btn" disabled style={{ opacity: 0.7 }}>
            <Icon name="check" />
            已加入队列
          </button>
        ) : route.kind === null ? (
          <button
            className="btn primary gen-btn"
            onClick={() => (fastsso ? switchPage('models') : openDrawer(s.session?.loggedIn ? 'topup' : 'account'))}
          >
            <Icon name={fastsso ? 'coins' : s.session?.loggedIn ? 'coins' : 'user'} />
            {fastsso ? '选择模型 · 进入模型与价格' : s.session?.loggedIn ? '没有可用模型 · 查看设置' : '登录后生成'}
          </button>
        ) : enough ? (
          <button className="btn primary gen-btn" onClick={() => void gen()}>
            <Icon name="send" />
            生成{t === 'image' ? ` ${p.count} 张` : ` ${p.dur}s`} · {cost} 点
          </button>
        ) : (
          <button className="btn primary gen-btn" onClick={() => openDrawer('topup')} style={{ background: 'var(--amber)' }}>
            <Icon name="coins" />
            {topupOpen(s) ? '点数不足 · 去充值' : '点数不足 · 充值暂未开放'}
          </button>
        )}
        <div className="tiny dim">
          生成后进入队列，可继续写下一条，不必等待完成。
          {route.kind === 'cloud' ? '点数在云端按真实用量结算，失败自动退回。' : ''}
        </div>
      </div>
    </section>
  );
}

function Pills<T extends string | number | boolean>({ opts, value, k, icon }: { opts: [T, string][]; value: unknown; k: string; icon?: string }) {
  return (
    <div className="opt-pills">
      {opts.map(([v, label]) => (
        <button key={String(v)} className={`opt-pill ${value === v ? 'on' : ''}`} onClick={() => setParam(k, v)}>
          {icon && <Icon name={icon} />}
          {label}
        </button>
      ))}
    </div>
  );
}

function Params({ t }: { t: MediaType }) {
  const s = useStore();
  const p = s.params[t];
  const m = modelOf(s, p.model);
  if (t === 'image') {
    return (
      <>
        <div className="form-row">
          <span className="form-label">比例</span>
          <Pills k="ratio" value={p.ratio} icon="crop" opts={RATIOS.map((r) => [r, r] as [string, string])} />
        </div>
        <div className="form-row">
          <span className="form-label">数量</span>
          <Pills k="count" value={p.count} opts={[1, 2, 4].map((n) => [n, `${n} 张`] as [number, string])} />
        </div>
        <div className="form-row">
          <span className="form-label">
            分辨率<span className="fl-hint">{m.maxRes ? `该模型最高 ${resoOf(m.maxRes).n}` : '按模型能力'}</span>
          </span>
          <div className="opt-pills">
            {RESOS.map((q) => (
              <button key={q.k} className={`opt-pill ${p.res === q.k ? 'on' : ''}`} title={q.px} onClick={() => setParam('res', q.k)}>
                {q.n}
                {q.mul !== 1 ? ` ×${q.mul}` : ''}
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }
  if (t === 'video') {
    const durs = m.durs && m.durs.length ? m.durs : [3, 5, 8];
    return (
      <>
        <div className="form-row">
          <span className="form-label">比例</span>
          <Pills k="ratio" value={p.ratio} opts={VIDEO_RATIOS} />
        </div>
        <div className="form-row">
          <span className="form-label">
            时长<span className="fl-hint">{m.maxDur ? `上限 ${m.maxDur} 秒` : '上限见模型说明'}</span>
          </span>
          <Pills k="dur" value={p.dur} opts={durs.map((d) => [d, `${d} 秒`] as [number, string])} />
        </div>
        <div className="form-row">
          <span className="form-label">运镜</span>
          <Pills k="cam" value={p.cam} icon="camera" opts={CAMS.map((c) => [c, c] as [string, string])} />
        </div>
        <div className="form-row">
          <span className="form-label">首帧参考</span>
          <Pills
            k="firstFrame"
            value={p.firstFrame}
            opts={[
              [true, '使用参考图作首帧'],
              [false, '纯文生视频'],
            ]}
          />
        </div>
      </>
    );
  }
  return (
    <>
      <div className="form-row">
        <span className="form-label">用途</span>
        <div className="opt-pills">
          {AUDIO_USES.map(([k, n, ic]) => (
            <button key={k} className={`opt-pill ${p.use === k ? 'on' : ''}`} onClick={() => setParam('use', k)}>
              <Icon name={ic} />
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <span className="form-label">时长</span>
        <Pills k="dur" value={p.dur} opts={(p.use === 'sfx' ? SFX_DURS : AU_DURS).map((d) => [d.k, d.n] as [number, string])} />
      </div>
      {p.use === 'tts' && (
        <>
          <div className="form-row">
            <span className="form-label">音色</span>
            <select className="form-select" value={p.voice} onChange={(e) => setParam('voice', e.target.value)}>
              {VOICES.map((v) => (
                <option key={v.k} value={v.k}>
                  {v.n}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <span className="form-label">语言</span>
            <Pills k="lang" value={p.lang} icon="globe" opts={LANGS.map((l) => [l, l] as [string, string])} />
          </div>
        </>
      )}
      {p.use === 'music' && (
        <div className="form-row">
          <span className="form-label">情绪</span>
          <select className="form-select" value={p.mood} onChange={(e) => setParam('mood', e.target.value)}>
            {MOODS.map((x) => (
              <option key={x.k} value={x.k}>
                {x.n}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}

function Advanced({ t }: { t: MediaType }) {
  const s = useStore();
  const p = s.params[t];
  return (
    <div className="adv-body">
      <div className="form-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <span className="form-label">
          负面提示<span className="fl-hint">不想出现的元素，逗号分隔；留空即可</span>
        </span>
        <textarea className="prompt-input neg-input" value={s.negative[t]} onChange={(e) => setNegative(e.target.value)} placeholder="例如：模糊, 多余文字, 水印" />
      </div>
      {t === 'image' && (
        <>
          <div className="form-row">
            <span className="form-label">
              随机种子<span className="fl-hint">留空则每次随机</span>
            </span>
            <input className="form-input" value={p.seed || ''} onChange={(e) => setParam('seed', e.target.value.replace(/\D/g, ''))} placeholder="例如 88213" />
          </div>
          <div className="form-row">
            <span className="form-label">参考强度</span>
            <Pills k="refWeight" value={p.refWeight} opts={[0.3, 0.6, 0.9].map((v) => [v, String(v)] as [number, string])} />
          </div>
          <div className="form-row">
            <span className="form-label">导出格式</span>
            <Pills k="format" value={p.format} opts={['PNG', 'JPG', 'WEBP'].map((f) => [f, f] as [string, string])} />
          </div>
        </>
      )}
      {t === 'video' && (
        <>
          <div className="form-row">
            <span className="form-label">
              清晰度<span className="fl-hint">真实渠道生效</span>
            </span>
            <Pills k="vres" value={p.vres} opts={VIDEO_RES.map((r) => [r, r] as [string, string])} />
          </div>
          <div className="form-row">
            <span className="form-label">帧率</span>
            <Pills k="fps" value={p.fps} opts={[24, 30].map((f) => [f, `${f} fps`] as [number, string])} />
          </div>
          <div className="form-row">
            <span className="form-label">循环点</span>
            <Pills
              k="loop"
              value={p.loop}
              opts={[
                [true, '生成可无缝循环'],
                [false, '普通片段'],
              ]}
            />
          </div>
        </>
      )}
      {t === 'audio' && (
        <div className="form-row">
          <span className="form-label">输出音量</span>
          <Pills k="volume" value={p.volume} opts={[60, 80, 100].map((v) => [v, `${v}%`] as [number, string])} />
        </div>
      )}
    </div>
  );
}
