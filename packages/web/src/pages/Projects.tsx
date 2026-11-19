import { useState } from 'react';
import { Icon } from '../components/common';
import { setState, useStore } from '../store';
import { createProject, pickWs } from '../store/actions';

/* 项目画板：每个项目一张卡片——封面（画布上最新的几个素材）、元素数、素材数；点开进入这个项目的画布。 */
export function ProjectsPage() {
  const s = useStore();
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const open = (id: string) => {
    pickWs(id);
    setState((st) => void ((st.page = 'studio'), (st.studioTab = 'gen'), (st.canvasOpen = true)));
  };
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    await createProject(n);
    setName('');
    setAdding(false);
    setState((st) => void ((st.page = 'studio'), (st.studioTab = 'gen'), (st.canvasOpen = true)));
  };
  return (
    <div className="page">
      <div className="toolbar">
        <div className="page-title-block">
          <span className="page-title">项目画板</span>
          <span className="page-sub">{s.projects.length} 个项目 · 点开进入它的画布</span>
        </div>
        <span className="grow" />
        <button className="btn ghost" onClick={() => setState((st) => void (st.drawer = { type: 'project' }))}>
          <Icon name="gear" />
          重命名 / 删除
        </button>
      </div>
      <div className="proj-grid">
        {s.projects.map((p) => {
          const items = s.boards[p.id]?.items || [];
          const media = items.filter((i) => i.kind === 'media');
          const covers = media.filter((i) => i.thumb || i.src).slice(-4).reverse();
          const saved = s.results.filter((r) => r.ws === p.id && r.home === 'library').length;
          return (
            <button key={p.id} className={`proj-card ${p.id === s.ws ? 'cur' : ''}`} onClick={() => open(p.id)}>
              <div className={`proj-cover ${covers.length < 2 ? 'one' : ''}`}>
                {covers.length ? (
                  covers.map((i) =>
                    i.type === 'video' && !i.thumb ? <video key={i.id} src={`${i.src}#t=0.1`} muted preload="metadata" /> : <img key={i.id} src={i.thumb || (i.type === 'image' ? i.src : '')} alt="" draggable={false} />,
                  )
                ) : (
                  <div className="empty">画布还是空的</div>
                )}
              </div>
              <div className="proj-info">
                <b>
                  <i className="proj-dot" style={{ background: p.dot }} />
                  {p.name}
                  {p.id === s.ws && <span className="chip info">当前</span>}
                </b>
                <span className="tiny dim">
                  {items.length} 个元素 · {media.length} 个素材 · {saved} 个已存素材库
                </span>
              </div>
            </button>
          );
        })}
        {adding ? (
          <div className="proj-new" style={{ cursor: 'default' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '80%' }}>
              <input className="form-input" autoFocus placeholder="项目名称" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn sm primary" onClick={() => void create()} disabled={!name.trim()}>
                  创建
                </button>
                <button className="btn sm ghost" onClick={() => setAdding(false)}>
                  取消
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button className="proj-new" onClick={() => setAdding(true)}>
            <span>
              <Icon name="plus" /> 新建项目
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
