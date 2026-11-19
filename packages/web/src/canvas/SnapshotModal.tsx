import { useEffect, useState } from 'react';
import type { Board, Project, SnapshotMeta } from '@aigc/shared';
import { DangerButton, Icon } from '../components/common';
import { api } from '../lib/api';
import { downloadUrl } from '../lib/util';
import { setState, useStore } from '../store';
import { pickWs } from '../store/actions';
import { toast, toastError } from '../store/toast';
import { timeLabel } from '@aigc/shared';

/* 项目快照：手动保存 + 关键动作前自动保存；只读回看，恢复时另存为新项目，不覆盖当前画布。
   也是「上下文包」的出口：zip 里有画布、产出来历、批注与方案、快照和帖子，交给外部 Agent。 */
export function SnapshotModal() {
  const s = useStore();
  const [list, setList] = useState<SnapshotMeta[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const open = s.snapOpen;
  const ws = s.ws;
  const load = () => api.get<{ snapshots: SnapshotMeta[] }>(`/api/snapshots?ws=${ws}`).then((r) => setList(r.snapshots)).catch((e) => toastError(e, '读取快照失败'));
  useEffect(() => {
    if (open) void load();
  }, [open, ws]);
  if (!open) return null;
  const close = () => setState((st) => void (st.snapOpen = false));
  const save = async () => {
    const n = name.trim() || `手动快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
    setBusy(true);
    try {
      await api.post('/api/snapshots', { ws, name: n });
      setName('');
      toast('success', '已保存快照', n);
      await load();
    } catch (e) {
      toastError(e, '保存快照失败');
    } finally {
      setBusy(false);
    }
  };
  const restore = async (id: string) => {
    try {
      const { project, board } = await api.post<{ project: Project; board: Board }>(`/api/snapshots/${id}/restore`);
      setState((st) => {
        if (!st.projects.some((p) => p.id === project.id)) st.projects.push(project);
        st.boards[project.id] = board;
      });
      pickWs(project.id);
      toast('success', '已恢复为新项目', `${project.name}；当前画布没有动`);
      close();
    } catch (e) {
      toastError(e, '恢复失败');
    }
  };
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal-card snap-modal">
        <div className="modal-head">
          <Icon name="clock" />
          <b>项目快照与上下文包</b>
          <span className="grow" />
          <button className="icon-btn" onClick={close}>
            <Icon name="x" />
          </button>
        </div>
        <div className="snap-body">
          <div className="snap-new">
            <input className="form-input" value={name} maxLength={60} placeholder="给这一刻起个名字（可留空）" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
            <button className="btn sm primary" onClick={() => void save()} disabled={busy}>
              <Icon name="check" />
              保存快照
            </button>
          </div>
          <div className="snap-list">
            {list.length === 0 && <div className="tiny dim">还没有快照。清空画布、提交组图 / 批注 / 再生成之前会自动存一份。</div>}
            {list.map((x) => (
              <div key={x.id} className="snap-row">
                <div className="grow">
                  <b>{x.name}</b>
                  <div className="tiny dim">
                    {timeLabel(x.createdAt)} · {x.items} 个元素 · {x.links} 条连线 {x.auto && <span className="chip neutral">自动</span>}
                  </div>
                </div>
                <button className="btn sm ghost" title="另存为新项目，当前画布不动" onClick={() => void restore(x.id)}>
                  恢复为新项目
                </button>
                <DangerButton className="btn sm danger-ghost" label="删除" confirmLabel="再点一次" onConfirm={() => void api.del(`/api/snapshots/${x.id}`).then(load)} />
              </div>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <span className="tiny dim">上下文包含提示词和本机地址，只发给你信任的工具</span>
          <span className="grow" />
          <button className="btn sm primary" onClick={() => downloadUrl(`/api/projects/${ws}/context-pack`)}>
            <Icon name="download" />
            导出上下文包（zip）
          </button>
        </div>
      </div>
    </div>
  );
}
