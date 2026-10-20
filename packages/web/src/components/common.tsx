import { memo, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { JobStatus, MediaType, Result } from '@aigc/shared';
import { TYPES, clamp, seededSeries } from '@aigc/shared';
import { useStore } from '../store';
import { reportTime, stopPlay } from '../store/player';
import { cssOfEdit, thumbOf } from '../lib/util';

const FILL = new Set(['play', 'pause', 'more']);

export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return (
    <svg className={`ic ${FILL.has(name) ? 'fill' : ''} ${className}`}>
      <use href={`#i-${name}`} />
    </svg>
  );
}

const STATUS: Record<JobStatus, [string, string]> = {
  succeeded: ['success', '成功'],
  running: ['info', '生成中'],
  queued: ['warn', '排队中'],
  failed: ['danger', '失败'],
  canceled: ['neutral', '已取消'],
};

export function StatusChip({ status }: { status: JobStatus }) {
  const [cls, label] = STATUS[status] || STATUS.queued;
  return (
    <span className={`chip ${cls}`}>
      <span className="cdot" />
      {label}
    </span>
  );
}

export function TypeChip({ type }: { type: MediaType }) {
  return (
    <span className={`chip ${type === 'image' ? 'brand' : type === 'video' ? 'ai' : 'info'}`}>
      <Icon name={TYPES[type].ic} />
      {TYPES[type].name}
    </span>
  );
}

export const jobIconCls = (t: MediaType) => (t === 'image' ? 'violet' : t === 'video' ? 'blue' : 'amber');

export function TaskIc({ type, icon, cls }: { type?: MediaType; icon?: string; cls?: string }) {
  return (
    <span className={`task-ic ${cls || (type ? jobIconCls(type) : 'violet')}`}>
      <Icon name={icon || (type ? TYPES[type].ic : 'sparkles')} />
    </span>
  );
}

export function Empty({ icon, title, desc, children }: { icon: string; title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="es-ic">
        <Icon name={icon} />
      </div>
      <div className="es-title">{title}</div>
      {desc ? <div className="es-desc">{desc}</div> : null}
      {children}
    </div>
  );
}

/** 音频波形：按种子生成确定性柱形，播放进度着色 */
export function Wave({ r, cls, bars = 40 }: { r: Result; cls?: string; bars?: number }) {
  const play = useStore((s) => (s.play.id === r.id ? s.play.t : -1));
  const series = seededSeries(r.seed, bars, 22, 100);
  const pct = play >= 0 ? clamp(play / (r.dur || 30), 0, 1) : 0;
  const played = Math.round(bars * pct);
  return (
    <div className={`wave ${cls || ''}`}>
      {series.map((v, i) => (
        <i key={i} className={i < played ? 'play' : ''} style={{ height: `${v.toFixed(0)}%` }} />
      ))}
    </div>
  );
}

/** 产出的媒体：有封面就用封面；真实视频直接用 <video> 首帧；真实音频画一块波形底 */
export const MediaThumb = memo(function MediaThumb({ r, style, playable }: { r: Result; style?: CSSProperties; playable?: boolean }) {
  const thumb = thumbOf(r);
  const editStyle = { ...cssOfEdit(r.edit?.css), ...style };
  if (thumb) return <img src={thumb} alt={r.title} style={editStyle} draggable={false} loading="lazy" />;
  if (r.type === 'video') return <CardVideo r={r} style={editStyle} playable={playable} />;
  return (
    <div className="audio-tile">
      <Icon name="waveform" className="lg" />
    </div>
  );
});

/** 卡片里的真实视频：点播放才真的播，进度回写到全局播放状态 */
function CardVideo({ r, style, playable }: { r: Result; style?: CSSProperties; playable?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const playing = useStore((s) => s.play.id === r.id);
  useEffect(() => {
    const v = ref.current;
    if (!v || !playable) return;
    if (playing) v.play().catch(() => stopPlay());
    else {
      v.pause();
      v.currentTime = 0.1;
    }
  }, [playing, playable]);
  return (
    <video
      ref={ref}
      src={`${r.src}#t=0.1`}
      muted
      playsInline
      preload="metadata"
      style={style}
      onTimeUpdate={(e) => playing && reportTime(r.id, e.currentTarget.currentTime)}
      onEnded={() => playing && stopPlay()}
    />
  );
}

export function ProjectMini({ ws }: { ws: string }) {
  const p = useStore((s) => s.projects.find((x) => x.id === ws));
  const name = p ? p.name.split(' · ')[0] : '已删除项目';
  return (
    <span className="ws-mini">
      <i style={{ background: p?.dot || '#B3B8C6' }} />
      {name}
    </span>
  );
}
