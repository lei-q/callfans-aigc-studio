import { useState } from 'react';
import { TYPES, TYPE_KEYS } from '@aigc/shared';
import { useStore } from '../store';
import { createProject, openDrawer, openQueue, pickType, pickWs, switchPage } from '../store/actions';
import { balance, failJobs, libResults, openJobs, topupOpen } from '../store/selectors';
import { Icon } from './common';

export function Topbar() {
  const s = useStore();
  const w = s.projects.find((p) => p.id === s.ws);
  const fail = failJobs(s).length;
  const queue = openJobs(s).length;
  const bal = balance(s);
  const low = bal < 3;
  const canTopup = topupOpen(s);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const submitNew = () => {
    const n = name.trim();
    if (!n) return;
    void createProject(n);
    setName('');
    setNaming(false);
  };

  return (
    <header className="topbar">
      <div className="tb-left">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="sparkles" />
          </span>
          <span className="brand-col">
            <span className="brand-name">AIGC 创作台</span>
            <span className="brand-sub">
              {s.app?.desktop ? '桌面版' : 'Web 版'} · v{s.app?.version || '—'}
            </span>
          </span>
        </div>
      </div>
      <div className="tb-center">
        <div className="context-bar">
          <div className="ws-select">
            <button className="ws-btn" onClick={() => useStore.setState((st) => void (st.wsMenu = !st.wsMenu))}>
              <span className="ws-dot" style={{ background: w?.dot }} />
              {w?.name || '选择项目'}
              <Icon name="chev-down" />
            </button>
            {s.wsMenu && (
              <div className="ws-menu" onMouseDown={(e) => e.stopPropagation()}>
                <div className="wm-head">切换项目</div>
                {s.projects.map((x) => {
                  const f = s.jobs.filter((j) => j.ws === x.id && j.status === 'failed').length;
                  return (
                    <button key={x.id} className={x.id === s.ws ? 'active' : ''} onClick={() => pickWs(x.id)}>
                      <span className="ws-dot" style={{ background: x.dot }} />
                      {x.name}
                      <span className="wm-meta">
                        {f ? <span className="text-red">失败 {f}</span> : <span className="dim">正常</span>} <span className="dim">· 已用 {x.used} 点</span>
                      </span>
                    </button>
                  );
                })}
                <div style={{ height: 1, background: 'var(--border)', margin: '5px 4px' }} />
                {naming ? (
                  <div className="wm-new">
                    <input
                      className="form-input"
                      autoFocus
                      value={name}
                      maxLength={40}
                      placeholder="项目名，例如：咖啡店 · 秋季上新"
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitNew();
                        if (e.key === 'Escape') setNaming(false);
                      }}
                    />
                    <button className="btn sm primary" onClick={submitNew}>
                      创建
                    </button>
                  </div>
                ) : (
                  <div className="wm-actions">
                    <button className="btn sm ghost" onClick={() => setNaming(true)}>
                      <Icon name="plus" />
                      新建项目
                    </button>
                    <button
                      className="btn sm ghost"
                      onClick={() => {
                        useStore.setState((st) => void (st.wsMenu = false));
                        openDrawer('project');
                      }}
                    >
                      <Icon name="pen" />
                      管理项目
                    </button>
                  </div>
                )}
                <div className="wm-sum">
                  {s.session?.loggedIn ? `账号 ${s.session.profile?.nickname || ''} · 余额 ${bal} 点` : '还没有登录：点数跟着账号走，登录后充值与产出记录都能跨设备找回'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="tb-right">
        <div className="todo-group">
          {fail > 0 && (
            <button className="todo-chip danger pulse" onClick={() => openQueue(true)}>
              <span className="tdot" />
              <span className="tnum num">{fail}</span>
              <span className="tlabel">失败</span>
            </button>
          )}
          {queue > 0 && (
            <button className="todo-chip info" onClick={() => openQueue(false)}>
              <span className="tdot" />
              <span className="tnum num">{queue}</span>
              <span className="tlabel">队列</span>
            </button>
          )}
          {!fail && !queue && (
            <span className="todo-chip all-clear">
              <span className="tdot" />
              没有进行中的任务
            </span>
          )}
          {!s.online && (
            <span className="todo-chip danger">
              <span className="tdot" />
              本机服务已断开
            </span>
          )}
        </div>
        {s.session?.loggedIn ? (
          <button className={`balance-chip ${low ? 'low' : ''}`} onClick={() => openDrawer(canTopup ? 'topup' : 'account')} title={canTopup ? '点数余额：点击充值' : '点数余额：充值暂未开放'}>
            <Icon name="coins" />
            <span className="bc-num num">{bal}</span>
            <span className="bc-unit">点</span>
            {canTopup && <span className="bc-topup">{low ? '去充值' : '充值'}</span>}
          </button>
        ) : (
          <button className="balance-chip login" onClick={() => openDrawer('account')} title="登录账号：点数跟着账号走">
            <Icon name="user" />
            <span className="bc-topup">登录</span>
          </button>
        )}
        <button className="icon-btn tb-help" onClick={() => openDrawer('help')} title="使用地图">
          ?
        </button>
        <button className="avatar" title="设置" onClick={() => switchPage('settings')}>
          <Icon name="gear" />
        </button>
      </div>
    </header>
  );
}

export function Sidebar() {
  const s = useStore();
  const lib = libResults(s);
  const open = openJobs(s).length;
  const loggedIn = s.session?.loggedIn;
  const directOn = !!(s.settings?.direct.enabled && s.settings.direct.hasKey);
  return (
    <aside className="sidebar">
      <div className="side-sec">
        <div className="side-sec-title">创作</div>
        {TYPE_KEYS.map((k) => {
          const x = TYPES[k];
          const n = lib.filter((r) => r.type === k && r.ws === s.ws).length;
          return (
            <button key={k} className={`side-item ${s.page === 'studio' && s.type === k ? 'active' : ''}`} onClick={() => pickType(k)}>
              <Icon name={x.ic} />
              <span className="side-label">{x.name}创作</span>
              <span className="side-badge num">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="side-sec">
        <div className="side-sec-title">我的</div>
        <button className={`side-item ${s.page === 'jobs' ? 'active' : ''}`} onClick={() => switchPage('jobs')}>
          <Icon name="list" />
          <span className="side-label">任务记录</span>
          {open > 0 && <span className="side-badge blue num">{open}</span>}
        </button>
        <button className={`side-item ${s.page === 'library' ? 'active' : ''}`} onClick={() => switchPage('library')}>
          <Icon name="inbox" />
          <span className="side-label">素材库</span>
          <span className="side-badge num">{lib.length}</span>
        </button>
        <button className={`side-item ${s.page === 'aesthetic' ? 'active' : ''}`} onClick={() => switchPage('aesthetic')}>
          <Icon name="star" />
          <span className="side-label">审美库</span>
          <span className="side-badge num">{s.aesthetic.length}</span>
        </button>
      </div>
      <div className="side-sec">
        <div className="side-sec-title">开发与计费</div>
        <button className={`side-item ${s.page === 'api' ? 'active' : ''}`} onClick={() => switchPage('api')}>
          <Icon name="cpu" />
          <span className="side-label">API 接入</span>
        </button>
        <button className={`side-item ${s.page === 'models' ? 'active' : ''}`} onClick={() => switchPage('models')}>
          <Icon name="coins" />
          <span className="side-label">模型与价格</span>
        </button>
        <button className={`side-item ${s.page === 'settings' ? 'active' : ''}`} onClick={() => switchPage('settings')}>
          <Icon name="gear" />
          <span className="side-label">设置</span>
          {!loggedIn && !directOn && <span className="side-badge num">未接入</span>}
        </button>
      </div>
      <div className="side-spacer" />
      <div className="side-foot">
        <Icon name="coins" />
        <span>
          1 点 = ¥1 · 按次扣费 · 点数不过期。
          {s.settings?.account.provider === 'fastsso'
            ? directOn
              ? '当前为直连模式：用你自己的 TreeCloud Key 生成，费用在 TreeCloud 结算。'
              : '登录后提示词助手与 Agent 用平台模型（扣点数）；图片 / 视频生成请在「设置 · 直连 TreeCloud」填自己的 Key。'
            : loggedIn
              ? '生成走云端网关，按真实用量扣点数；失败自动退回。'
              : directOn
                ? '当前为直连模式：用你自己的 TreeCloud Key 生成，费用在 TreeCloud 结算。'
                : '登录后用微信 / 支付宝充值点数即可生成；也可以在设置里填自己的 TreeCloud Key 直连。'}
        </span>
      </div>
    </aside>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const drawerOpen = useStore((s) => !!s.drawer);
  const map: Record<string, string> = { ai: 'sparkles', success: 'check', info: 'bell', warn: 'alert' };
  return (
    <div className={`toast-layer ${drawerOpen ? 'drawer-shift' : ''}`}>
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type} ${t.out ? 'out' : ''}`}>
          <Icon name={map[t.type] || 'bell'} />
          <div>
            <div className="t-title">{t.title}</div>
            {t.desc ? <div className="t-desc">{t.desc}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
