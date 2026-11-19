import { Icon } from '../components/common';
import { setState, useStore } from '../store';
import { canvasItems, jobById, resultById } from '../store/selectors';
import { checkConsistency, type CheckItem } from './consistency';

/* 一致性检查：只比声明出来的参数，不做像素比对。 */
export function CheckModal() {
  const s = useStore();
  const d = s.check;
  if (!d) return null;
  const items: CheckItem[] = d.ids
    .map((id) => canvasItems(s).find((i) => i.id === id))
    .filter((i): i is NonNullable<typeof i> => !!i && i.kind === 'media')
    .map((i) => {
      const r = resultById(s, i.rid);
      const j = r ? jobById(s, r.job) : undefined;
      return { id: i.id, title: i.t || r?.title || '未命名', job: j, ratio: j?.ratio || r?.ratio };
    });
  const lines = checkConsistency(items);
  const warns = lines.filter((l) => l.level === 'warn').length;
  const close = () => setState((st) => void (st.check = null));
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal-card check-modal">
        <div className="modal-head">
          <Icon name="shield" />
          <b>一致性检查</b>
          <span className="tiny dim">{items.length} 个素材 · {warns ? `${warns} 项需要留意` : '没有发现声明层面的差异'}</span>
          <span className="grow" />
          <button className="icon-btn" onClick={close}>
            <Icon name="x" />
          </button>
        </div>
        <div className="check-body">
          {lines.map((l) => (
            <div key={l.key} className={`check-line ${l.level}`}>
              <Icon name={l.level === 'ok' ? 'check' : l.level === 'warn' ? 'alert' : 'eye'} />
              <div>
                <b>{l.title}</b>
                <div className="tiny dim">{l.detail}</div>
              </div>
            </div>
          ))}
          <div className="tiny dim">只比较模型、画幅、分辨率、负面词、参考图和提示词这些「声明出来的」信息；画面像不像、色调准不准要用眼睛看——可以用「并排对比」。</div>
        </div>
      </div>
    </div>
  );
}
