import { useEffect } from 'react';
import { Icon } from './components/common';
import { Sidebar, Toasts, Topbar } from './components/Shell';
import { Drawer } from './drawers/Drawers';
import { getState, setState, useStore } from './store';
import { boot, redo, startPersistence, undo } from './store/data';
import { isTyping } from './lib/util';
import * as op from './canvas/ops';
import { Studio } from './pages/Studio';
import { JobsPage, LibraryPage } from './pages/Lists';
import { AestheticPage, ApiPage, ModelsPage, SettingsPage } from './pages/Other';

function Main() {
  const page = useStore((s) => s.page);
  if (page === 'jobs') return <JobsPage />;
  if (page === 'library') return <LibraryPage />;
  if (page === 'aesthetic') return <AestheticPage />;
  if (page === 'api') return <ApiPage />;
  if (page === 'models') return <ModelsPage />;
  if (page === 'settings') return <SettingsPage />;
  return <Studio />;
}

const onCanvas = () => {
  const s = getState();
  return s.page === 'studio' && s.studioTab === 'gen' && s.canvasOpen && !s.drawer;
};

/** 全局键盘：桌面软件的肌肉记忆 */
function useKeys() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const s = getState();
      const typing = isTyping(e.target);
      /* 空格是 PureRef 的平移键，按住时光标变抓手 */
      if (e.code === 'Space' && !typing && onCanvas()) {
        if (!s.cvsSpace) {
          setState((st) => void (st.cvsSpace = true));
          document.body.classList.add('cvs-space');
        }
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        if (s.editTextId) {
          (document.activeElement as HTMLElement | null)?.blur();
          setState((st) => void (st.editTextId = null));
          return;
        }
        if (s.linkLabelEdit) return setState((st) => void (st.linkLabelEdit = null));
        if (s.cvsMenu) return setState((st) => void (st.cvsMenu = null));
        if (s.linkFrom) return setState((st) => void (st.linkFrom = null));
        if (s.platforms) return setState((st) => void (st.platforms = null));
        if (s.diverge) return setState((st) => void (st.diverge = null));
        if (s.cvsPen.on) return setState((st) => void (st.cvsPen.on = false));
        if (s.agent.open) return op.agentClose();
        if (s.cvsPop) return setState((st) => void (st.cvsPop = null));
        if (s.cvsFull) return setState((st) => void (st.cvsFull = false));
        if (s.drawer) return setState((st) => void (st.drawer = null));
        if (s.wsMenu) return setState((st) => void (st.wsMenu = false));
        return;
      }
      if (typing) return;
      const mod = e.ctrlKey || e.metaKey;
      /* [ 收起 / 展开生成表单 */
      if (e.key === '[' && !mod && !e.altKey && s.page === 'studio' && s.studioTab === 'gen') {
        op.toggleForm();
        return;
      }
      if (!onCanvas()) return;
      const k = e.key.toLowerCase();
      if (mod && !e.altKey && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && k === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && k === 'a') {
        e.preventDefault();
        op.selectAll();
        return;
      }
      if (mod && k === 'd') {
        e.preventDefault();
        op.duplicateSel();
        return;
      }
      if (mod) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.linkSel) {
          e.preventDefault();
          op.linkRemove();
          return;
        }
        if (!s.canvasSel.length) return;
        e.preventDefault();
        op.deleteSel();
        return;
      }
      if (k === 'f') {
        e.preventDefault();
        op.fitAll();
        return;
      }
      if (k === 'b') {
        e.preventDefault();
        op.togglePen();
        return;
      }
      if (k === 'v' && s.cvsPen.on) {
        setState((st) => void (st.cvsPen.on = false));
        return;
      }
      if (e.key === '0') {
        op.zoomTo100();
        return;
      }
      /* 方向键微调位置，按住 Shift 走大步 */
      if (e.key.startsWith('Arrow') && s.canvasSel.length) {
        e.preventDefault();
        const step = e.shiftKey ? 24 : 4;
        op.nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && getState().cvsSpace) {
        setState((st) => void (st.cvsSpace = false));
        document.body.classList.remove('cvs-space');
      }
    };
    const blur = () => {
      if (getState().cvsSpace) setState((st) => void (st.cvsSpace = false));
      document.body.classList.remove('cvs-space');
    };
    /* Ctrl+V 直接贴截图或网址 */
    const paste = (e: ClipboardEvent) => {
      if (!onCanvas() || isTyping(e.target)) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const files = [...(cd.items || [])]
        .filter((it) => it.kind === 'file')
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length) {
        e.preventDefault();
        void op.addLocalFiles(files.map((f, i) => (f.name ? f : new File([f], `截图-${Date.now()}-${i}.png`, { type: f.type }))), null, null);
        return;
      }
      const text = (cd.getData('text/plain') || '').trim();
      if (/^https?:\/\/\S+$/i.test(text)) {
        e.preventDefault();
        void op.addLink(text, null, null);
      }
    };
    const closeMenus = (e: MouseEvent) => {
      if (getState().wsMenu && !(e.target as HTMLElement).closest('.ws-select')) setState((st) => void (st.wsMenu = false));
    };
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    document.addEventListener('paste', paste);
    document.addEventListener('mousedown', closeMenus);
    return () => {
      document.removeEventListener('keydown', down);
      document.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      document.removeEventListener('paste', paste);
      document.removeEventListener('mousedown', closeMenus);
    };
  }, []);
}

export function App() {
  const ready = useStore((s) => s.ready);
  const err = useStore((s) => s.bootError);
  useEffect(() => {
    startPersistence();
    void boot();
  }, []);
  useKeys();
  if (!ready) {
    return (
      <div className="boot-screen">
        <span className="brand-mark">
          <Icon name="sparkles" />
        </span>
        {err ? (
          <>
            <b>连不上本机服务</b>
            <span>{err}</span>
            <button className="btn primary" onClick={() => void boot()}>
              重试
            </button>
          </>
        ) : (
          <span>AIGC 创作台启动中…</span>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="app">
        <Topbar />
        <div className="workspace">
          <Sidebar />
          <main className="main">
            <Main />
          </main>
        </div>
      </div>
      <Drawer />
      <Toasts />
    </>
  );
}
