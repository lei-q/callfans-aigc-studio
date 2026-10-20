import { useRef } from 'react';
import { TYPES, agentParamText, clamp } from '@aigc/shared';
import { Icon } from '../components/common';
import { setState, useStore } from '../store';
import { agentApply, agentClose, agentCopy, agentOpen, agentScopeAll } from './ops';

/* Agent 是画布上的浮层：收起时是一颗悬浮球，展开时是可拖动、可停靠的面板 */
export function AgentDock() {
  const agent = useStore((s) => s.agent);
  const docked = useStore((s) => s.agentDock);
  const pos = useStore((s) => s.agentPos);
  const n = useStore((s) => s.canvasSel.length);
  const boxRef = useRef<HTMLDivElement>(null);

  const placed = !docked && pos;
  const style = placed ? { left: pos.x, top: pos.y } : undefined;

  if (!agent.open) {
    return (
      <button
        className={`agent-fab ${docked ? 'docked' : ''} ${placed ? 'placed' : ''}`}
        style={style}
        title={n ? `分析选中的 ${n} 个元素` : '让 Agent 看一遍画板'}
        onClick={() => void agentOpen()}
      >
        <span className="agent-av">
          <Icon name="sparkles" />
        </span>
        <span className="af-t">{n ? `分析选中 ${n}` : 'Agent'}</span>
        {n > 0 && <span className="af-dot" />}
      </button>
    );
  }

  /* 拖标题栏移动面板，松手后记住位置 */
  const onDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const box = boxRef.current;
    if (!box) return;
    e.preventDefault();
    const br = box.getBoundingClientRect();
    const dx = e.clientX - br.left;
    const dy = e.clientY - br.top;
    let last: { x: number; y: number } | null = null;
    box.classList.remove('docked');
    box.classList.add('placed');
    document.body.classList.add('cvs-acting');
    const move = (ev: MouseEvent) => {
      const x = clamp(ev.clientX - dx, 8, Math.max(8, window.innerWidth - box.offsetWidth - 8));
      const y = clamp(ev.clientY - dy, 8, Math.max(8, window.innerHeight - 60));
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      last = { x, y };
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('cvs-acting');
      if (last) {
        const p = last;
        setState((s) => {
          s.agentPos = p;
          s.agentDock = false;
        });
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const r = agent.result;
  if (!r) return null;
  const total = r.counts.media + r.counts.webs + r.counts.files + r.counts.draws + r.counts.posts + r.counts.nodes;
  const kws = [...new Set([...r.nodeTexts.map((t) => t.slice(0, 8)), ...r.topWords])].slice(0, 6);
  return (
    <div ref={boxRef} className={`agent-float ${docked ? 'docked' : ''} ${placed ? 'placed' : ''}`} style={style}>
      <div className="agent-panel">
        <div className="agent-head" data-agent-drag onMouseDown={onDragStart}>
          <span className="agent-av">
            <Icon name="sparkles" />
          </span>
          <div className="agent-title">
            <b>Agent · {r.scoped ? '选区分析' : '画板分析'}</b>
            <span>{r.scoped ? `只看你圈定的 ${total} 个元素` : `基于整块画板的 ${total} 个元素`}</span>
          </div>
          <span className="grow" />
          <button className="icon-btn" title="重新分析" onClick={() => void agentOpen()}>
            <Icon name="refresh" />
          </button>
          <button
            className="icon-btn"
            title={docked ? '取消停靠' : '停靠到右侧'}
            onClick={() =>
              setState((s) => {
                s.agentDock = !s.agentDock;
                if (s.agentDock) s.agentPos = null;
              })
            }
          >
            <Icon name={docked ? 'expand' : 'grid'} />
          </button>
          <button className="icon-btn" title="收起" onClick={agentClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="agent-body">
          {!total ? (
            <div className="agent-empty">
              {r.scoped ? '选中的东西里没有可读的内容。' : '画板还是空的。'}先把参考图、社媒帖子或文档放上去，Agent 才有东西可读。
            </div>
          ) : (
            <>
              {!r.scoped && total > 6 && <div className="agent-hint">画板有冗余时，先框选一块再分析会更准。</div>}
              <div className="agent-sec">
                <div className="agent-sec-t">
                  <Icon name="layers" />
                  我看到的
                </div>
                <ul className="agent-list">
                  {r.counts.media > 0 && (
                    <li>
                      {r.typeText}
                      {r.counts.prompts ? `，其中 ${r.counts.prompts} 张能追溯到原始提示词` : '，都还没有来源记录'}
                    </li>
                  )}
                  {r.postLines.map((x) => (
                    <li key={x}>参考了 {x}</li>
                  ))}
                  {r.notes.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
              <div className="agent-sec">
                <div className="agent-sec-t">
                  <Icon name="target" />
                  需求理解
                </div>
                <div className="agent-guess">
                  {kws.map((w) => (
                    <span key={w} className="agent-kw">
                      {w}
                    </span>
                  ))}
                </div>
                <div className="agent-text">
                  {r.understanding
                    ? r.understanding
                    : r.counts.prompts
                      ? `${r.scoped ? '你圈定的这块里，' : ''}产出来自 ${r.counts.prompts} 次生成，反复出现的是「${r.guess}」，看起来这是你要的主方向。`
                      : `目前只能从元素标题判断方向：${r.guess}。补几张有来源的产出，我能读得更准。`}
                </div>
                {r.posts.length > 0 && (
                  <div className="agent-text">
                    范围里有 {r.posts.length} 条平台内容参考（{r.posts.map((p) => `${p.platform}${p.like ? ` ${p.like} 赞` : ''}`).join('、')}）。照着这些方向做一版的话，我可以先按它们的结构给提示词。
                  </div>
                )}
                {r.linkCount > 0 && (
                  <div className="agent-text">
                    {r.hubName ? `范围里有 ${r.linkCount} 条连线，${r.hubName} 被连得最多，看起来它是这一组的基准。` : `范围里有 ${r.linkCount} 条连线，我在按这个结构理解你的意图。`}
                    {r.linkLabels.length > 0 && `你给线写了「${r.linkLabels.join('」「')}」——这些关系我会照着理解。`}
                    {r.nodeTexts.length > 0 && `另外你在画板上写了「${r.nodeTexts.join('」「')}」——这几点我会直接带上。`}
                  </div>
                )}
              </div>
              {r.draft && (
                <div className="agent-sec">
                  <div className="agent-sec-t">
                    <Icon name="pen" />
                    建议提示词
                    {agent.loading && <span className="agent-loading">对话模型润色中…</span>}
                    {r.enhanced && <span className="chip ai">LLM 润色</span>}
                  </div>
                  <div className="agent-draft">{r.draft}</div>
                  <div className="agent-params">
                    <Icon name="cpu" />
                    按画板主流类型选了「{TYPES[r.mainType].name}」· {agentParamText(r.mainType, r.params)}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {r.draft && (
          <div className="agent-foot">
            <button className="btn sm primary" onClick={agentApply}>
              <Icon name="wand" />
              用它去生成
            </button>
            <button className="btn sm ghost" onClick={agentCopy}>
              <Icon name="copy" />
              复制提示词
            </button>
            <span className="grow" />
            {r.scoped && (
              <button className="btn sm ghost" onClick={agentScopeAll}>
                改用整个画板
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
