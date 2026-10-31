import { memo, useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { CanvasItem } from '@aigc/shared';
import { FILE_KINDS, TYPES, hostOf, humanSize, postPlatformOf, seededSeries, videoPlatformOf } from '@aigc/shared';
import { Icon } from '../components/common';
import { setState } from '../store';
import { CVS_H_FILE, CVS_H_POST, CVS_H_WEB, TEXT_MAX_W, cvsItemAR, cvsItemH, cvsItemW, cvsLayer, cvsTransform } from './geometry';
import { keepAesthetic, measureText, openParamsPop, removeOne, setCover, setGroupName, setItemText } from './ops';

interface Props {
  it: CanvasItem;
  idx: number;
  sel: boolean;
  saved: boolean;
  editing: boolean;
  anchor: boolean;
  groupCount: number;
}

/* 一个画布元素。静止时就是一张纯粹的图——类型角标与标题只在悬停或选中时浮出来 */
export const CanvasEl = memo(function CanvasEl({ it, idx, sel, saved, editing, anchor, groupCount }: Props) {
  const w = cvsItemW(it);
  const tf = cvsTransform(it);
  const common: CSSProperties = {
    left: it.x,
    top: it.y,
    width: w,
    zIndex: cvsLayer(it, idx),
    ...(tf ? { transform: tf } : {}),
    ...(it.op != null && it.op < 1 ? { opacity: it.op } : {}),
  };
  const ops = (
    <>
      <div className="cvs-el-ops">
        {it.rid && (
          <button className="cvs-op cvs-param" title="查看生成时的参数" onClick={(e) => openParamsPop(it.rid!, e.currentTarget.getBoundingClientRect())}>
            <Icon name="cpu" />
          </button>
        )}
        {it.url && (
          <button className="cvs-op" title="在浏览器打开" onClick={() => window.open(it.url, '_blank', 'noopener')}>
            <Icon name="link" />
          </button>
        )}
        {(it.kind === 'media' || it.kind === 'web' || it.kind === 'post') && (
          <button className="cvs-op" title="收进审美库" onClick={() => void keepAesthetic(it.id)}>
            <Icon name="star" />
          </button>
        )}
        {(it.kind === 'web' || it.kind === 'post') && (
          <button className="cvs-op" title={it.cover ? '换封面' : '补一张封面'} onClick={() => void setCover(it.id)}>
            <Icon name="upload" />
          </button>
        )}
        <button className="cvs-op cvs-del" title="移除" data-remove="1" onClick={() => removeOne(it.id)}>
          <Icon name="x" />
        </button>
      </div>
      <span className="cvs-grip" data-grip={it.id} title="拖动改大小" />
    </>
  );
  const cls = (k: string, extra = '') => `cvs-el cvs-${k} ${sel ? 'sel' : ''} ${extra}`;

  if (it.kind === 'web') {
    return (
      <div className={cls('web')} data-id={it.id} style={{ ...common, height: it.cover ? CVS_H_WEB + 76 : CVS_H_WEB }}>
        {it.cover && (
          <div className="cvs-cover">
            <img src={it.cover} alt="" draggable={false} />
          </div>
        )}
        <div className="cvs-web-bar">
          <span className="cvs-web-fav">
            <Icon name="globe" />
          </span>
          <span className="cvs-web-host">{it.site || hostOf(it.url)}</span>
        </div>
        <div className="cvs-web-body">
          <div className="cvs-web-title">{it.t || '未命名页面'}</div>
          <div className="cvs-web-url">{it.url}</div>
        </div>
        {ops}
      </div>
    );
  }

  if (it.kind === 'group') {
    return (
      <div className={cls('group')} data-id={it.id} style={{ left: it.x, top: it.y, width: w, height: cvsItemH(it), zIndex: cvsLayer(it, idx) }}>
        <div className="cvs-group-head" data-group-head={it.id}>
          <Icon name="grid" />
          <GroupName id={it.id} text={it.t} />
          <span className="grow" />
          <span className="cvs-group-n num">{groupCount}</span>
          <button className="cvs-op cvs-del" title="移除分组框（组里的元素保留）" data-remove="1" onClick={() => removeOne(it.id)}>
            <Icon name="x" />
          </button>
        </div>
      </div>
    );
  }

  if (it.kind === 'node') return <NodeEl it={it} idx={idx} sel={sel} editing={editing} ops={ops} />;
  if (it.kind === 'text') return <TextEl it={it} idx={idx} sel={sel} editing={editing} common={common} />;

  if (it.kind === 'post') {
    const pf = videoPlatformOf(it.url) || postPlatformOf(it.url) || { n: '链接', color: '#8A90A2', label: '网页', ic: 'link' };
    const hasStats = it.like || it.save || it.cmt || it.vdur;
    return (
      <div className={cls('post')} data-id={it.id} style={{ ...common, height: cvsItemH(it) }}>
        {it.cover && (
          <div className="cvs-cover">
            <img src={it.cover} alt="" draggable={false} />
          </div>
        )}
        <div className="cvs-post-bar" style={{ background: `${pf.color}1A`, color: pf.color }}>
          <span className="cvs-post-pf" style={{ background: pf.color }}>
            <Icon name={pf.ic} />
          </span>
          <b>{pf.n}</b>
          <span className="cvs-post-kind">{pf.label}</span>
        </div>
        <div className="cvs-post-body" style={{ height: CVS_H_POST - 34 }}>
          <div className="cvs-post-title">{it.t}</div>
          <div className="cvs-post-author">{it.author ? `@${it.author}` : it.site || hostOf(it.url)}</div>
          {hasStats ? (
            <div className="cvs-post-stats">
              {it.isVideo && it.vdur && (
                <span>
                  <Icon name="clock" />
                  {it.vdur}
                </span>
              )}
              {it.like && (
                <span>
                  <Icon name="star" />
                  {it.like}
                </span>
              )}
              {!it.isVideo && it.save && (
                <span>
                  <Icon name="bookmark" />
                  {it.save}
                </span>
              )}
              {it.cmt && (
                <span>
                  <Icon name="send" />
                  {it.cmt}
                </span>
              )}
            </div>
          ) : (
            <div className="cvs-post-desc">{it.desc || '平台互动数据需要登录才能看到，标题与封面可以自己补'}</div>
          )}
        </div>
        {ops}
      </div>
    );
  }

  if (it.kind === 'file') {
    const fk = FILE_KINDS.find((x) => x.k === it.ftype) || { n: '文件', ic: 'box' };
    return (
      <div className={cls('file')} data-id={it.id} style={{ ...common, height: CVS_H_FILE }} onDoubleClick={() => it.src && window.open(it.src, '_blank', 'noopener')}>
        <span className="cvs-file-ic">
          <Icon name={fk.ic} />
        </span>
        <div className="cvs-file-body">
          <div className="cvs-file-name" title={it.t}>
            {it.t}
          </div>
          <div className="cvs-file-meta">
            {fk.n}
            {it.bytes ? ` · ${humanSize(it.bytes)}` : ''}
          </div>
        </div>
        {ops}
      </div>
    );
  }

  if (it.kind === 'draw') {
    const h = cvsItemH(it);
    return (
      <div className={cls('draw')} data-id={it.id} style={{ ...common, height: h }}>
        <svg className="cvs-draw-svg" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          <polyline
            points={(it.pts || []).map(([x, y]) => `${x},${y}`).join(' ')}
            fill="none"
            stroke={it.color || '#4F46E5'}
            strokeWidth={it.lw || 3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {ops}
      </div>
    );
  }

  const type = it.type || 'image';
  const ar = cvsItemAR(it);
  const showVideo = type === 'video' && !it.thumb && it.src;
  return (
    <div className={cls('media', `${saved ? 'saved' : ''} ${anchor ? 'anchor' : ''}`)} data-id={it.id} style={common}>
      {showVideo ? (
        <>
          <video
            className="cvs-video"
            src={it.src}
            muted
            loop
            playsInline
            preload="metadata"
            style={{ aspectRatio: `${1 / ar}` }}
            onDoubleClick={(e) => {
              const v = e.currentTarget;
              if (v.paused) void v.play();
              else v.pause();
            }}
          />
          <span className="cvs-play">
            <Icon name="play" />
          </span>
        </>
      ) : type === 'audio' && !it.thumb ? (
        <div className="cvs-audio" style={{ height: Math.round(w * ar) }}>
          <div className="cvs-audio-wave">
            {seededSeries(it.seed || 4207, 26, 26, 96).map((v, i) => (
              <i key={i} style={{ height: `${v.toFixed(0)}%` }} />
            ))}
          </div>
        </div>
      ) : (
        <img src={it.thumb || it.src} alt={it.t} draggable={false} style={{ aspectRatio: `${1 / ar}` }} />
      )}
      <span className={`cvs-kind k-${type}`}>
        <Icon name={TYPES[type].ic} />
      </span>
      {it.local && (
        <span className="cvs-kind k-local" title="本地文件">
          <Icon name="upload" />
        </span>
      )}
      {it.link && (
        <span className="cvs-kind k-local" title="链接视频">
          <Icon name="link" />
        </span>
      )}
      {anchor && (
        <span className="cvs-anchor-badge" title="风格基准">
          <Icon name="bookmark" />
          基准
        </span>
      )}
      {saved && (
        <span className="cvs-saved">
          <Icon name="check" />
          已存素材库
        </span>
      )}
      <span className="cvs-cap">{it.t || '未命名'}</span>
      {ops}
    </div>
  );
});

/* 分组名可编辑：文本由我们自己写进 DOM，React 只认这个空 span。
   可编辑节点里的文本节点会被浏览器（输入法、全选替换）整体换掉，若 React 也管着这些节点，
   之后提交阶段按自己的记录去 removeChild 就会抛 NotFoundError。 */
function GroupName({ id, text }: { id: string; text?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const n = ref.current;
    if (!n || document.activeElement === n) return;
    const t = text || '未命名分组';
    if (n.textContent !== t) n.textContent = t;
  }, [text]);
  return (
    <span
      ref={ref}
      className="cvs-group-name"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={(e) => setGroupName(id, e.currentTarget.textContent || '')}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLElement).blur())}
    />
  );
}

/* 节点：思维导图的构件。双击进编辑、失焦即保存，平时只读，单击拖动不会误触输入 */
function NodeEl({ it, idx, sel, editing, ops }: { it: CanvasItem; idx: number; sel: boolean; editing: boolean; ops: React.ReactNode }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (editing && ta) {
      ta.focus();
      try {
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } catch {
        /* 忽略 */
      }
    }
  }, [editing]);
  return (
    <div
      className={`cvs-el cvs-node ${sel ? 'sel' : ''} ${editing ? 'editing' : ''}`}
      data-id={it.id}
      style={{ left: it.x, top: it.y, width: cvsItemW(it), height: cvsItemH(it), zIndex: cvsLayer(it, idx) }}
    >
      <textarea
        key={`${it.id}:${it.text || ''}`}
        ref={ref}
        className="cvs-node-text"
        data-node-id={it.id}
        readOnly={!editing}
        defaultValue={it.text || ''}
        placeholder="双击写字…"
        onBlur={(e) => {
          setItemText(it.id, e.currentTarget.value);
          endEdit(it.id);
        }}
      />
      {ops}
    </div>
  );
}

/* 文字：就是文字。不画框、不铺底，宽度由内容决定；渲染后实测宽高写回 */
function TextEl({ it, idx, sel, editing, common }: { it: CanvasItem; idx: number; sel: boolean; editing: boolean; common: CSSProperties }) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  /* 同上：可编辑区域里的文字由我们自己写，React 不持有它的文本节点 */
  useLayoutEffect(() => {
    const b = body.current;
    if (!b || editing) return;
    const t = it.text || '';
    if (b.textContent !== t) b.textContent = t;
  }, [it.text, editing]);
  useLayoutEffect(() => {
    const n = box.current;
    if (!n) return;
    const w = Math.ceil(n.offsetWidth);
    const h = Math.ceil(n.offsetHeight);
    if (w && h && (w !== it.w || h !== it.h)) measureText(it.id, w, h);
  });
  useLayoutEffect(() => {
    const b = body.current;
    if (!editing || !b) return;
    b.focus();
    try {
      const r = document.createRange();
      r.selectNodeContents(b);
      r.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    } catch {
      /* 忽略 */
    }
  }, [editing]);
  const { width: _w, ...rest } = common;
  return (
    <div
      ref={box}
      className={`cvs-el cvs-text size-${it.size || 'md'} ${sel ? 'sel' : ''} ${editing ? 'editing' : ''}`}
      data-id={it.id}
      style={{ ...rest, maxWidth: TEXT_MAX_W, zIndex: cvsLayer(it, idx) }}
    >
      <div
        ref={body}
        className="cvs-text-body"
        data-text-id={it.id}
        contentEditable={editing}
        suppressContentEditableWarning
        onBlur={(e) => {
          const n = box.current;
          setItemText(it.id, (e.currentTarget.textContent || '').trim(), n ? Math.ceil(n.offsetWidth) : undefined, n ? Math.ceil(n.offsetHeight) : undefined);
          endEdit(it.id);
        }}
      />
    </div>
  );
}

function endEdit(id: string) {
  setState((s) => {
    if (s.editTextId === id) s.editTextId = null;
  });
}
