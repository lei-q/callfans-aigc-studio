import { useEffect, useRef } from 'react';
import { setState, useStore } from '../store';
import { toast } from '../store/toast';
import { Icon } from './common';

/* ============================================================================
   自动更新界面：主进程负责检查、下载、等空闲、安装；这里只展示状态和触发动作。
   只在桌面应用里出现（window.aigcDesktop.update），Web 模式不显示。
   ========================================================================== */

const bridge = () => window.aigcDesktop?.update;

const timeOf = (ts?: number) => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '');

/** 订阅主进程的更新状态；App 挂载时调用一次 */
export function useUpdater() {
  useEffect(() => {
    const u = bridge();
    if (!u) return;
    let alive = true;
    void u.getState().then((st) => {
      if (alive && st) setState((s) => void (s.update = st));
    });
    u.onState((st) => setState((s) => void (s.update = st)));
    return () => {
      alive = false;
      u.offState();
    };
  }, []);
}

/** 状态变化时的提醒：只在进入「已下载」或「失败」的那一次提示，避免轮询重复弹 */
export function useUpdateToasts() {
  const stage = useStore((s) => s.update?.stage);
  const message = useStore((s) => s.update?.message);
  const prev = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (stage === 'waiting' && prev.current !== 'waiting') toast('info', '更新已下载', '等当前任务全部结束后会自动安装');
    if (stage === 'error' && prev.current !== 'error' && message) toast('warn', '更新失败', message);
    prev.current = stage;
  }, [stage, message]);
}

/** 有可用更新时的确认弹窗；点「稍后」后本次版本不再打扰，可在设置里继续 */
export function UpdatePrompt() {
  const st = useStore((s) => s.update);
  const u = bridge();
  if (!u || !st || st.stage !== 'available' || st.dismissed) return null;
  return (
    <div className="modal-wrap">
      <div className="modal update-modal">
        <div className="modal-head">
          <span className="auth-wait-ic">
            <Icon name="download" />
          </span>
          <div>
            <div className="modal-title">发现新版本 v{st.version}</div>
            <div className="modal-sub">
              当前版本 v{st.currentVersion}
              {st.size ? ` · 安装包 ${(st.size / 1024 / 1024).toFixed(1)} MB` : ''}
            </div>
          </div>
        </div>
        <div className="modal-body">
          <p className="update-lead">建议在空闲时更新：确认后先在后台下载，不会打断你正在做的事。</p>
          <p className="tiny dim">
            下载完成后会自动检查任务队列：有任务在执行或排队时每分钟检查一次，等全部结束后再启动安装并重启应用。
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={() => void u.download()}>
            <Icon name="download" />
            下载并更新
          </button>
          <button className="btn ghost" onClick={() => u.dismiss()}>
            稍后
          </button>
          <span className="grow" />
          {st.pageUrl && (
            <button className="link-btn" onClick={() => window.aigcDesktop?.openExternal(st.pageUrl!)}>
              查看更新说明
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 下载 / 等待 / 安装时常驻右下角的小卡片，让用户知道更新进度但可以继续用 */
export function UpdateFloat() {
  const st = useStore((s) => s.update);
  const drawerOpen = useStore((s) => !!s.drawer);
  if (drawerOpen || !st || (st.stage !== 'downloading' && st.stage !== 'waiting' && st.stage !== 'installing')) return null;
  const percent = st.percent ?? 0;
  return (
    <div className="update-float">
      <div className="uf-head">
        <Icon name="refresh" />
        <b>更新 v{st.version}</b>
        <span className="grow" />
        <span className="tiny dim">
          {st.stage === 'downloading' ? `${percent}%` : st.stage === 'waiting' ? '等待空档' : '安装中'}
        </span>
      </div>
      {st.stage === 'downloading' && (
        <div className="update-bar">
          <i style={{ width: `${Math.max(2, percent)}%` }} />
        </div>
      )}
      <div className="tiny dim uf-text">
        {st.stage === 'downloading'
          ? '下载完成后会在任务全部结束时自动安装，可以继续使用。'
          : st.stage === 'waiting'
            ? st.busy
              ? `还有 ${st.busy} 个任务在执行或排队，每分钟检查一次。`
              : '正在确认任务状态，空闲后自动安装…'
            : '正在启动安装程序，应用马上退出。'}
      </div>
    </div>
  );
}

/** 设置 · 关于里的更新状态与手动检查入口 */
export function UpdateStatus() {
  const st = useStore((s) => s.update);
  const u = bridge();
  if (!u) return <span className="tiny dim">Web 服务模式下由菜单栏图标检查更新：托盘菜单 →「检查更新」。</span>;
  if (!st) return <span className="tiny dim">正在读取更新状态…</span>;

  const check = async () => {
    const r = await u.check();
    if (r?.stage === 'idle') toast('success', '已经是最新版本', `当前 v${r.currentVersion}`);
    else if (r?.stage === 'available') toast('ai', `发现新版本 v${r.version}`, '点「下载并更新」开始下载');
  };

  const progress = (
    <span className="update-inline-bar">
      <i style={{ width: `${Math.max(2, st.percent ?? 0)}%` }} />
    </span>
  );

  if (st.stage === 'checking') return <span className="tiny dim">正在检查更新…</span>;
  if (st.stage === 'downloading') {
    return (
      <span className="update-row">
        <span>正在下载 v{st.version}（{st.percent ?? 0}%）</span>
        {progress}
      </span>
    );
  }
  if (st.stage === 'waiting') {
    return (
      <span className="tiny dim">
        已下载 v{st.version}，{st.busy ? `还有 ${st.busy} 个任务在执行或排队，` : ''}每分钟检查一次
        {st.nextCheckAt ? `，下次 ${timeOf(st.nextCheckAt)}` : ''}；空闲后自动安装。
      </span>
    );
  }
  if (st.stage === 'installing') return <span className="tiny dim">正在启动安装程序，应用即将退出…</span>;
  if (st.stage === 'available') {
    return (
      <span className="update-row">
        <span>
          发现新版本 <b>v{st.version}</b>
        </span>
        <button className="btn sm primary" onClick={() => void u.download()}>
          下载并更新
        </button>
        {st.pageUrl && (
          <button className="link-btn" onClick={() => window.aigcDesktop?.openExternal(st.pageUrl!)}>
            更新说明
          </button>
        )}
      </span>
    );
  }
  if (st.stage === 'error') {
    return (
      <span className="update-row">
        <span className="text-red">{st.message || '检查更新失败'}</span>
        <button className="btn sm ghost" onClick={() => void check()}>
          重新检查
        </button>
      </span>
    );
  }
  return (
    <span className="update-row">
      <span className="tiny dim">
        已是最新版本{st.checkedAt ? `（上次检查 ${timeOf(st.checkedAt)}）` : ''}；每天自动检查两次
      </span>
      <button className="btn sm ghost" onClick={() => void check()}>
        <Icon name="refresh" />
        检查更新
      </button>
    </span>
  );
}
