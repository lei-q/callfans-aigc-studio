import { useEffect, useState } from 'react';
import type { MediaType, ModelInfo, UsageRequest, UsageSummary } from '@aigc/shared';
import { DEFAULT_PORT, TYPES, TYPE_KEYS, hostOf, round1, timeLabel } from '@aigc/shared';
import { Empty, Icon, TaskIc, jobIconCls } from '../components/common';
import { setState, useStore } from '../store';
import { aestheticAddFile, apiCreateKey, apiDelete, apiToggle, logout, openDrawer, patchSettings, removeAesthetic } from '../store/actions';
import { balance, channelReady, modelOf } from '../store/selectors';
import { toast } from '../store/toast';
import { api } from '../lib/api';
import { copyText } from '../lib/util';

declare global {
  interface Window {
    aigcDesktop?: {
      relaunch(): void;
      openPath(p: string): void;
      openExternal(url: string): void;
      mode: 'desktop' | 'web';
    };
  }
}

/* ---------------- 审美库 ---------------- */

export function AestheticPage() {
  const s = useStore();
  const all = s.aesthetic;
  const list = all.filter((a) => s.aestheticFilter === 'all' || a.kind === s.aestheticFilter);
  const c = (k: string) => (k === 'all' ? all.length : all.filter((a) => a.kind === k).length);
  return (
    <div className="page">
      <div className="toolbar">
        <div className="page-title-block">
          <span className="page-title">审美库</span>
          <span className="page-sub">{all.length} 件藏品 · 跨项目、跨来源，长期积累你自己的判断标准</span>
        </div>
        <span className="grow" />
        <button className="btn ghost" onClick={() => void aestheticAddFile()}>
          <Icon name="upload" />
          从电脑收藏
        </button>
      </div>
      <div className="aes-note">
        <Icon name="star" />
        <span>
          <b>审美库和素材库不是一回事。</b>
          素材库装这个项目产出的、要交付的东西；审美库装你个人认可的、代表你品味的东西——跨项目、可以是外部内容、长期留着。看得多了，你才知道自己要什么。
        </span>
      </div>
      <div className="lib-filters">
        <span className="of-label">类型</span>
        {(
          [
            ['all', '全部'],
            ['image', '图片'],
            ['video', '视频'],
            ['web', '网页'],
          ] as const
        ).map(([k, n]) => (
          <button key={k} className={`fchip ${s.aestheticFilter === k ? 'on' : ''}`} onClick={() => setState((st) => void (st.aestheticFilter = k))}>
            {n} <i className="num">{c(k)}</i>
          </button>
        ))}
        <span className="grow" />
        <span className="tiny dim">共 {list.length} 件</span>
      </div>
      {list.length ? (
        <div className="aes-grid">
          {list.map((a) => (
            <article key={a.id} className="aes-card">
              <div className="aes-media">
                {a.kind === 'web' && (!a.src || a.src === a.url) ? (
                  <div className="aes-web">
                    <Icon name="globe" />
                    <span>{hostOf(a.url || a.src)}</span>
                  </div>
                ) : /\.(mp4|mov|webm)$/i.test(a.src) ? (
                  <video src={`${a.src}#t=0.1`} muted preload="metadata" />
                ) : (
                  <img src={a.src} alt={a.t} />
                )}
                <div className="aes-shade" />
                <button className="aes-del" title="移出审美库" onClick={() => void removeAesthetic(a.id)}>
                  <Icon name="x" />
                </button>
              </div>
              <div className="aes-body">
                <div className="aes-title" title={a.t}>
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noreferrer">
                      {a.t}
                    </a>
                  ) : (
                    a.t
                  )}
                </div>
                {a.note && <div className="aes-note-line">{a.note}</div>}
                <div className="aes-meta">
                  {(a.tags || []).slice(0, 2).map((t) => (
                    <span key={t} className="mini-tag">
                      {t}
                    </span>
                  ))}
                  <span className="grow" />
                  <span className="tiny dim">
                    {a.from || '外部收藏'} · {timeLabel(a.createdAt)}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty icon="star" title="审美库还是空的" desc="在画板或素材库里点收藏，就会收到这里；也可以直接从电脑收藏图片。" />
      )}
      <div className="table-note">
        <Icon name="link" />
        <span>收藏的外部图片会存一份在本机，原文件删了也还在。</span>
      </div>
    </div>
  );
}

/* ---------------- API 接入 ---------------- */

const snippets = (origin: string): Record<'curl' | 'python' | 'node', string> => ({
  curl: `curl ${origin}/openapi/v1/images/generations \\
  -H "Authorization: Bearer $AIGC_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "暖橙主色背景，哑光纸杯居中，顶部柔光，留出标题安全区",
    "size": "1024x1024",
    "n": 2
  }'`,
  python: `import os, requests

res = requests.post(
    "${origin}/openapi/v1/images/generations",
    headers={"Authorization": f"Bearer {os.environ['AIGC_API_KEY']}"},
    json={"prompt": "暖橙主色背景，哑光纸杯居中，顶部柔光", "n": 2},
    timeout=600,
)
res.raise_for_status()
for img in res.json()["data"]:
    print(img["url"])`,
  node: `const res = await fetch("${origin}/openapi/v1/images/generations", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.AIGC_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ prompt: "暖橙主色背景，哑光纸杯居中，顶部柔光", n: 2 }),
});
const { data } = await res.json();
console.log(data.map((d) => d.url));`,
});

export function ApiPage() {
  const s = useStore();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [reqs, setReqs] = useState<UsageRequest[]>([]);
  const loggedIn = !!s.session?.loggedIn;
  useEffect(() => {
    if (!loggedIn) return;
    api
      .get<UsageSummary>('/api/usage/summary')
      .then(setUsage)
      .catch(() => setUsage(null));
    api
      .get<{ items: UsageRequest[] }>('/api/usage/requests')
      .then((r) => setReqs(r.items))
      .catch(() => setReqs([]));
  }, [loggedIn, s.apiKeys.length]);
  const origin = window.location.origin;
  const code = snippets(origin)[s.apiLang];
  const chName = (id: string) => s.channels.find((c) => c.id === id)?.name || id;
  return (
    <div className="page">
      <div className="toolbar">
        <div className="page-title-block">
          <span className="page-title">API 接入</span>
          <span className="page-sub">用同一份点数按量计费，不额外收费 · 适合接进 agent、脚本或批量工具</span>
        </div>
        <span className="grow" />
        <button className="btn primary" onClick={() => openDrawer('topup')}>
          <Icon name="coins" />
          充值点数
        </button>
      </div>
      <div className="api-wallet">
        <Icon name="coins" />
        <div>
          <div className="aw-balance">
            {loggedIn ? balance(s) : '—'}
            <span>点</span>
          </div>
          <div className="tiny dim">
            {loggedIn
              ? `网页与 API 共用这一份余额 · 近 7 天调用 ${usage?.requests ?? 0} 次，消耗 ${usage?.points ?? 0} 点`
              : '登录后才能用 API 计费：点数跟着账号走'}
          </div>
        </div>
        <span className="grow" />
        {loggedIn ? (
          <span className="chip success">
            <Icon name="check" />
            计费互通
          </span>
        ) : (
          <button className="btn sm primary" onClick={() => openDrawer('account')}>
            去登录
          </button>
        )}
      </div>

      {s.newKeySecret && (
        <div className="alert-bar key-once">
          <Icon name="shield" />
          <span>
            <b>新 Key 只展示这一次：</b>
            <code className="num">{s.newKeySecret}</code>
          </span>
          <span className="right">
            <button
              className="btn sm ghost"
              onClick={() => {
                copyText(s.newKeySecret!);
                toast('success', '已复制 Key');
              }}
            >
              <Icon name="copy" />
              复制
            </button>
            <button className="btn sm ghost" onClick={() => setState((st) => void (st.newKeySecret = null))}>
              我已保存
            </button>
          </span>
        </div>
      )}

      <div className="catalog-sec">
        <div className="catalog-sec-name">密钥</div>
        <div className="card table-card">
          <div className="key-head">
            <span>名称</span>
            <span>Key</span>
            <span>创建时间</span>
            <span>计费渠道</span>
            <span className="th-right">操作</span>
          </div>
          {s.apiKeys.map((k) => (
            <div key={k.id} className={`key-row ${k.on ? '' : 'off'}`}>
              <span className="kr-name">{k.name}</span>
              <span className="kr-key">{k.masked}</span>
              <span className="tiny dim">{timeLabel(k.createdAt)}</span>
              <span className="ch-chip">{chName(k.channel)}</span>
              <div className="row-actions">
                <button className="btn sm ghost" onClick={() => void apiToggle(k.id, !k.on)}>
                  {k.on ? '停用' : '启用'}
                </button>
                <button className="btn sm ghost" onClick={() => void apiDelete(k.id)}>
                  <Icon name="trash" />
                  删除
                </button>
              </div>
            </div>
          ))}
          <div className="key-row key-new">
            <button className="btn sm primary" onClick={() => void apiCreateKey()}>
              <Icon name="plus" />
              创建新 Key
            </button>
            <span className="tiny dim">Key 只在创建时完整展示一次；调用按当前路由计费（云端扣点数 / 直连记用量）</span>
          </div>
        </div>
      </div>

      <div className="catalog-sec">
        <div className="catalog-sec-name">按量价格</div>
        <div className="card table-card price-table">
          <div className="key-head">
            <span>模型</span>
            <span>单价</span>
            <span>常见用法</span>
            <span className="th-right">约合</span>
          </div>
          {s.models.map((m) => (
            <div key={m.id} className="key-row">
              <span className="kr-name">
                {m.name}
                <span className="ch-chip">{chName(m.channel)}</span>
              </span>
              <span>
                {m.price} 点 / {m.basis}
              </span>
              <span className="tiny dim">{m.sample || m.note}</span>
              <span className="right tiny dim">¥{m.price}</span>
            </div>
          ))}
          {!s.models.length && (
            <div className="key-row">
              <span className="tiny dim">还没有可用模型：登录云端账号，或在「设置 · 直连」里配置 Key。</span>
            </div>
          )}
        </div>
        <div className="table-note">
          <Icon name="shield" />
          <span>调用失败不扣费；同时排队与生成中的 API 任务超过 8 个返回 429；按量计费，没有月费与最低消费。</span>
        </div>
      </div>

      <div className="catalog-sec">
        <div className="catalog-sec-name">用量与账单</div>
        <div className="card table-card">
          <div className="key-head">
            <span>时间</span>
            <span>模型</span>
            <span>用量</span>
            <span className="th-right">消耗</span>
          </div>
          {loggedIn ? (
            reqs.slice(0, 30).map((u) => (
              <div key={u.id} className="key-row">
                <span className="num">{timeLabel(u.at)}</span>
                <span>{modelOf(s, `cloud:${u.model}`).name || u.model}</span>
                <span className="tiny dim">
                  {u.tokens?.image ? `${u.tokens.image} 张` : u.videoSeconds ? `${u.videoSeconds} 秒` : u.ttsChars ? `${u.ttsChars} 字` : u.tokens ? `${u.tokens.input || 0}/${u.tokens.output || 0} tokens` : '—'}
                </span>
                <span className="right num">{u.points} 点</span>
              </div>
            ))
          ) : (
            <div className="key-row">
              <span className="tiny dim">登录后查看调用日志与 token 用量（由云端记录）。</span>
            </div>
          )}
          {loggedIn && (
            <div className="key-row key-sum">
              <span className="tiny dim">近 7 天合计</span>
              <span />
              <span className="num tiny dim">{usage?.requests ?? 0} 次</span>
              <span className="right num">{usage?.points ?? 0} 点</span>
            </div>
          )}
        </div>
      </div>

      <div className="catalog-sec">
        <div className="catalog-sec-name">快速开始</div>
        <div className="card code-card">
          <div className="code-head">
            <span className="field-label">
              <Icon name="cpu" />
              示例代码
            </span>
            <span className="grow" />
            <div className="mini-tabs">
              {(['curl', 'python', 'node'] as const).map((l) => (
                <button key={l} className={s.apiLang === l ? 'active' : ''} onClick={() => setState((st) => void (st.apiLang = l))}>
                  {l}
                </button>
              ))}
            </div>
            <button
              className="btn sm ghost"
              onClick={() => {
                copyText(code);
                toast('success', '已复制示例代码', `当前语言：${s.apiLang}`);
              }}
            >
              <Icon name="copy" />
              复制
            </button>
          </div>
          <pre className="code-block">{code}</pre>
          <div className="code-foot">
            <Icon name="link" />
            <span>
              把 Key 放进环境变量 <b>AIGC_API_KEY</b>，不要写死在代码里。异步任务用 <b>POST /openapi/v1/jobs</b> 提交、<b>GET /openapi/v1/jobs/:id</b> 轮询。
            </span>
          </div>
        </div>
      </div>

      <div className="catalog-sec">
        <div className="catalog-sec-name">渠道</div>
        <div className="card table-card">
          <div className="key-head ch-head">
            <span>渠道</span>
            <span>说明</span>
            <span className="th-right">覆盖模型</span>
          </div>
          {s.channels.map((c) => (
            <div key={c.id} className="key-row ch-row">
              <span className="kr-name">
                {c.name}
                {!c.ready && <span className="ch-chip">未就绪</span>}
              </span>
              <span className="tiny dim">{c.note}</span>
              <span className="right num">{s.models.filter((m) => m.channel === c.id).length} 个</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 模型与价格 ---------------- */

export function ModelsPage() {
  const s = useStore();
  return (
    <div className="page">
      <div className="toolbar">
        <div className="page-title-block">
          <span className="page-title">模型与价格</span>
          <span className="page-sub">
            按次计费，没有订阅 · 1 点 = ¥1 · {s.session?.loggedIn ? `当前余额 ${balance(s)} 点` : '登录后显示余额'}
          </span>
        </div>
        <span className="grow" />
        <button className="btn primary" onClick={() => openDrawer('topup')}>
          <Icon name="coins" />
          充值点数
        </button>
      </div>
      <div className="promise-row">
        {(
          [
            ['check', '不订阅', '用多少扣多少，没有月费'],
            ['refresh', '失败自动退回', '生成失败的点数原路退回'],
            ['clock', '点数不过期', '不会每月清零'],
            ['shield', '可商用', '产出可直接商用'],
          ] as const
        ).map(([ic, b, d]) => (
          <div key={b} className="promise">
            <span className="pm-ic">
              <Icon name={ic} />
            </span>
            <b>{b}</b>
            <span>{d}</span>
          </div>
        ))}
      </div>
      {TYPE_KEYS.map((t) => (
        <ModelSection key={t} t={t} models={s.models.filter((m) => m.type === t && channelReady(s, m.channel))} />
      ))}
      <div className="table-note">
        <Icon name="link" />
        <span>要批量调用？到「API 接入」创建 Key，用同一份点数按量计费，不额外收费。</span>
      </div>
    </div>
  );
}

function ModelSection({ t, models }: { t: MediaType; models: ModelInfo[] }) {
  return (
    <div className="catalog-sec">
      <div className="catalog-sec-name">{TYPES[t].name}模型</div>
      {models.length ? (
        <div className="model-grid">
          {models.map((m) => (
            <div key={m.id} className="card model-card">
              <div className="model-top">
                <span className={`task-ic ${jobIconCls(t)}`}>
                  <Icon name="cpu" />
                </span>
                <div>
                  <div className="model-name">{m.name}</div>
                  <div className="model-id">
                    约 ¥{m.price} / {m.basis}
                  </div>
                </div>
                <div className="model-price">
                  <div className="p num">{m.price}</div>
                  <div className="u">点 / {m.basis}</div>
                </div>
              </div>
              <div className="small t2">{m.note}</div>
              <div className="model-caps">
                {m.caps.map((c) => (
                  <span key={c} className="cap-chip">
                    {c}
                  </span>
                ))}
              </div>
              {m.limit && <div className="tiny dim">限制：{m.limit}</div>}
              <div className="model-foot">
                <span className="chip success">
                  <span className="cdot" />
                  可用
                </span>
                <span className="grow" />
                <span className="tiny dim">{m.channel === 'cloud' ? '云端网关' : '直连'}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="table-note">
          <Icon name="alert" />
          <span>当前没有可用的{TYPES[t].name}模型：登录云端账号，或在「设置 · 直连」里配置 Key。</span>
        </div>
      )}
    </div>
  );
}

/* ---------------- 设置 ---------------- */

export function SettingsPage() {
  const s = useStore();
  const st = s.settings;
  const [cloudUrl, setCloudUrl] = useState(st?.cloud.baseUrl || '');
  const [directUrl, setDirectUrl] = useState(st?.direct.baseUrl || '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [port, setPort] = useState(String(st?.runtime.port || DEFAULT_PORT));
  const [token, setToken] = useState('');
  useEffect(() => {
    if (st) {
      setCloudUrl(st.cloud.baseUrl);
      setDirectUrl(st.direct.baseUrl);
      setPort(String(st.runtime.port));
    }
  }, [st?.cloud.baseUrl, st?.direct.baseUrl, st?.runtime.port]);
  if (!st) return null;
  const d = st.direct;
  const loggedIn = !!s.session?.loggedIn;
  const desktop = !!window.aigcDesktop;

  const connectDirect = async () => {
    setBusy(true);
    const ok = await patchSettings({ direct: { baseUrl: directUrl.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) } });
    setBusy(false);
    if (!ok) return;
    setKey('');
    const c = useStore.getState().settings?.direct.lastCheck;
    if (c?.ok) toast('success', '直连已就绪', c.message);
    else if (c) toast('warn', '连接失败', c.message);
  };

  return (
    <div className="page settings-page">
      <div className="toolbar">
        <div className="page-title-block">
          <span className="page-title">设置</span>
          <span className="page-sub">账号与云端、直连 Key、预估单价与运行模式</span>
        </div>
      </div>

      <div className="catalog-sec">
        <div className="catalog-sec-name">账号与云端</div>
        <div className="card set-card">
          <div className="set-account-row">
            {loggedIn ? (
              <>
                <span className="avatar sm">{(s.session?.profile?.nickname || '账')[0]}</span>
                <div className="grow">
                  <b>{s.session?.profile?.nickname}</b>
                  <span className="tiny dim">
                    {s.session?.profile?.phoneMasked} · 余额 {balance(s)} 点 · 今日免费 {round1(s.wallet?.freeToday || 0)} 点
                  </span>
                </div>
                <button className="btn primary sm" onClick={() => openDrawer('topup')}>
                  <Icon name="coins" />
                  充值
                </button>
                <button className="btn ghost sm" onClick={() => void logout()}>
                  退出登录
                </button>
              </>
            ) : (
              <>
                <div className="grow">
                  <b>还没有登录</b>
                  <span className="tiny dim">{s.session?.cloudReachable ? '登录后点数、订单与用量跟着账号走，换设备不丢。' : s.session?.cloudMessage || '还没有配置云端地址。'}</span>
                </div>
                <button className="btn primary sm" onClick={() => openDrawer('account')}>
                  <Icon name="user" />
                  登录
                </button>
              </>
            )}
          </div>
          <div className="form-row">
            <span className="form-label">云端地址</span>
            <input className="form-input" value={cloudUrl} onChange={(e) => setCloudUrl(e.target.value)} placeholder="https://cloud.example.com（云端上线后填写；开发期可指向本机 Mock 云）" />
            <button
              className="btn sm ghost"
              onClick={() =>
                void patchSettings({ cloud: { baseUrl: cloudUrl.trim() } }).then(async (ok) => {
                  if (!ok) return;
                  const r = await api.post<{ ok: boolean; message: string }>('/api/settings/cloud/refresh').catch(() => null);
                  toast(r?.ok ? 'success' : 'warn', r?.ok ? '云端已连接' : '云端连不上', r?.message || '');
                })
              }
            >
              保存并测试
            </button>
          </div>
          <div className="tiny dim">生成、对话辅助、充值与用量都走云端；云端未部署前，可以按 docs/cloud-api-contract.md 自建或跑仓库里的 Mock 云（pnpm --filter @aigc/cloud-mock dev）。</div>
        </div>
      </div>

      <div className="catalog-sec">
        <div className="catalog-sec-name">直连 TreeCloud（高级）</div>
        <div className="set-grid">
          <button className={`set-choice ${d.enabled ? 'on' : ''}`} onClick={() => void patchSettings({ direct: { enabled: !d.enabled } }, d.enabled ? '已关闭直连，生成走云端点数' : '已启用直连')}>
            <TaskIc icon="globe" cls="violet" />
            <span>
              <b>启用直连模式</b>
              <span>用你自己的 TreeCloud Key 直接生成：费用在 TreeCloud 结算，不扣平台点数。适合有自己的上游合同或要跑批量的用户。</span>
            </span>
            {d.enabled && <Icon name="check" />}
          </button>
        </div>
        <div className="card set-card">
          <div className="form-row">
            <span className="form-label">Base URL</span>
            <input className="form-input" value={directUrl} onChange={(e) => setDirectUrl(e.target.value)} placeholder="https://api.jtreecloud.com" />
          </div>
          <div className="form-row">
            <span className="form-label">API Key</span>
            <input
              className="form-input"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={d.hasKey ? `已保存 ${d.keyHint || ''}，留空则不修改` : 'sk-tc-…（在 TreeCloud 控制台创建）'}
            />
          </div>
          <div className="form-row">
            <span className="form-label">对话模型</span>
            <select className="form-select" value={st.chat.model} disabled={!st.chat.available.length} onChange={(e) => void patchSettings({ chat: { model: e.target.value } })}>
              {!st.chat.available.length && <option value="">（连接后可选，用于提示词辅助）</option>}
              {st.chat.available.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="set-actions">
            <button className="btn primary" disabled={busy || (!key.trim() && !d.hasKey)} onClick={() => void connectDirect()}>
              <Icon name="link" />
              {busy ? '连接中…' : d.hasKey ? '保存并测试连接' : '保存并连接'}
            </button>
            {d.hasKey && (
              <button
                className="btn ghost"
                onClick={async () => {
                  const r = await api.post<{ settings: unknown }>('/api/settings/direct/refresh').catch(() => null);
                  toast(r ? 'success' : 'warn', r ? '模型列表已刷新' : '刷新失败');
                }}
              >
                <Icon name="refresh" />
                刷新模型列表
              </button>
            )}
            {d.hasKey && (
              <button className="btn ghost" onClick={() => void patchSettings({ direct: { clearKey: true } }, '已清除 Key 并关闭直连')}>
                <Icon name="trash" />
                清除 Key
              </button>
            )}
            <span className="grow" />
            {d.lastCheck && (
              <span className={`chip ${d.lastCheck.ok ? 'success' : 'danger'}`}>
                <span className="cdot" />
                {d.lastCheck.message} · {timeLabel(d.lastCheck.at)}
              </span>
            )}
          </div>
          <div className="tiny dim">Key 加密保存在本机，只会发给你填写的 Base URL。图片请求不会自动重试——超时不代表没执行，重提可能再次计费。TreeCloud 暂不提供音乐与音效生成。</div>
        </div>
      </div>

      <div className="catalog-sec">
        <div className="catalog-sec-name">并发与预估单价</div>
        <div className="card set-card">
          <div className="form-row">
            <span className="form-label">并发数</span>
            <div className="opt-pills">
              {[1, 2, 3, 4].map((n) => (
                <button key={n} className={`opt-pill ${st.runner.concurrency === n ? 'on' : ''}`} onClick={() => void patchSettings({ runner: { concurrency: n } })}>
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="card table-card price-table">
          <div className="key-head">
            <span>模型</span>
            <span>预估单价（点）</span>
            <span>计价单位</span>
            <span className="th-right">操作</span>
          </div>
          {s.models.map((m) => (
            <PriceRow key={m.id} m={m} overridden={st.prices[m.id] != null} />
          ))}
          {!s.models.length && (
            <div className="key-row">
              <span className="tiny dim">登录或配置 Key 后，这里会列出可用模型与单价。</span>
            </div>
          )}
        </div>
        <div className="table-note">
          <Icon name="shield" />
          <span>云端模式的实际扣费以云端账本为准（按真实用量结算）；这里的单价只用于生成前的预估展示。</span>
        </div>
      </div>

      <div className="catalog-sec">
        <div className="catalog-sec-name">运行模式</div>
        <div className="set-grid">
          {(
            [
              ['desktop', '桌面应用', '独立窗口运行，数据只在本机。'],
              ['web', 'Web 服务', '在浏览器里使用；可开放给局域网里的其他设备。'],
            ] as const
          ).map(([k, n, desc]) => (
            <button key={k} className={`set-choice ${st.runtime.mode === k ? 'on' : ''}`} onClick={() => void patchSettings({ runtime: { mode: k } }, '运行模式已保存，重启后生效')}>
              <TaskIc icon={k === 'desktop' ? 'box' : 'globe'} cls={k === 'desktop' ? 'blue' : 'violet'} />
              <span>
                <b>{n}</b>
                <span>{desc}</span>
              </span>
              {st.runtime.mode === k && <Icon name="check" />}
            </button>
          ))}
        </div>
        <div className="card set-card">
          <div className="form-row">
            <span className="form-label">Web 端口</span>
            <input
              className="form-input"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              onBlur={() => Number(port) !== st.runtime.port && Number(port) >= 1024 && void patchSettings({ runtime: { port: Number(port) } }, '端口已保存，重启后生效')}
            />
          </div>
          <div className="form-row">
            <span className="form-label">访问口令</span>
            <input className="form-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={st.runtime.hasToken ? '已设置，留空不修改' : '开放局域网访问前必须设置，至少 6 位'} />
            <button
              className="btn sm ghost"
              disabled={token.length < 6}
              onClick={() =>
                void patchSettings({ runtime: { token } }, '访问口令已保存').then(() => setToken(''))
              }
            >
              保存口令
            </button>
          </div>
          <div className="form-row">
            <span className="form-label">局域网访问</span>
            <div className="opt-pills">
              <button className={`opt-pill ${st.runtime.lan ? 'on' : ''}`} onClick={() => void patchSettings({ runtime: { lan: true } }, '已开放局域网访问，重启后生效')}>
                开放（0.0.0.0）
              </button>
              <button className={`opt-pill ${!st.runtime.lan ? 'on' : ''}`} onClick={() => void patchSettings({ runtime: { lan: false } }, '已改为仅本机访问，重启后生效')}>
                仅本机
              </button>
            </div>
          </div>
          <div className="set-actions">
            {desktop ? (
              <button className="btn primary" onClick={() => window.aigcDesktop?.relaunch()}>
                <Icon name="refresh" />
                重启应用使设置生效
              </button>
            ) : (
              <span className="tiny dim">Web 模式下修改端口或局域网设置后，需要重启服务（桌面托盘「退出」后重新打开，或重启命令行进程）。</span>
            )}
          </div>
        </div>
      </div>

      <div className="catalog-sec">
        <div className="catalog-sec-name">关于</div>
        <div className="card set-card">
          <div className="snap-row">
            <span className="sk">版本</span>
            <span className="sv num">v{s.app?.version}</span>
          </div>
          <div className="snap-row">
            <span className="sk">当前运行</span>
            <span className="sv">
              {s.app?.desktop ? '桌面应用' : 'Web 服务'} · {s.app?.platform}
            </span>
          </div>
          <div className="snap-row">
            <span className="sk">数据目录</span>
            <span className="sv">
              <code>{s.app?.dataDir}</code>
              {desktop && s.app?.dataDir && (
                <button
                  className="btn sm ghost"
                  style={{ marginLeft: 8 }}
                  onClick={() => window.aigcDesktop?.openPath(s.app!.dataDir)}
                >
                  打开
                </button>
              )}
            </span>
          </div>
          <div className="snap-row">
            <span className="sk">开源仓库</span>
            <span className="sv">
              <a href="https://github.com/lei-q/callfans-aigc-studio" target="_blank" rel="noreferrer">
                github.com/lei-q/callfans-aigc-studio
              </a>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PriceRow({ m, overridden }: { m: ModelInfo; overridden: boolean }) {
  const [v, setV] = useState(String(m.price));
  useEffect(() => setV(String(m.price)), [m.price]);
  const save = () => {
    const n = Number(v);
    if (!isFinite(n) || n < 0) {
      setV(String(m.price));
      return;
    }
    if (n !== m.price) void patchSettings({ prices: { [m.id]: n } }, `已更新 ${m.name} 的预估单价`);
  };
  return (
    <div className="key-row">
      <span className="kr-name">
        {m.name}
        {overridden && <span className="ch-chip">已调整</span>}
      </span>
      <span>
        <input className="form-input price-input" value={v} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </span>
      <span className="tiny dim">点 / {m.basis}</span>
      <span className="right">
        {overridden && (
          <button className="btn sm ghost" onClick={() => void patchSettings({ prices: { [m.id]: null } }, '已恢复默认单价')}>
            恢复默认
          </button>
        )}
      </span>
    </div>
  );
}
