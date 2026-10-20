import { useEffect, useRef } from 'react';
import type { AudioEditOps, ImageEditOps, MediaType, Result, VideoEditOps } from '@aigc/shared';
import { EDIT_CROPS, EDIT_FILTERS, TYPES, clamp, mmss, round1, seededSeries } from '@aigc/shared';
import { Empty, Icon, MediaThumb, ProjectMini, jobIconCls } from '../components/common';
import { setState, useStore } from '../store';
import { editInput, editOp, editPick, editPicked, editPool, editReset, editSave } from '../store/actions';
import { reportTime, stopPlay, togglePlay } from '../store/player';
import { cssOfEdit, editCss, editTransform, thumbOf } from '../lib/util';

const trimOf = (type: MediaType, ops: { in: number; out: number }, cur: Result | null) => {
  const total = (cur && cur.dur) || (type === 'video' ? 5 : 30);
  const gap = type === 'video' ? 0.5 : 1;
  const a = clamp(ops.in, 0, Math.max(0, total - gap));
  const b = clamp(ops.out, a + gap, total);
  return { a, b, total, len: round1(b - a) };
};

export function Editor() {
  const s = useStore();
  const t = s.type;
  const pool = editPool(s, t);
  const cur = editPicked(s, t);
  const ops = s.editOps[t];
  return (
    <div className="edit-grid">
      <div className="edit-col">
        <section className="card composer-card">
          <div className="composer-head">
            <span className={`task-ic ${jobIconCls(t)}`}>
              <Icon name="crop" />
            </span>
            <div>
              <div className="ch-title">基础编辑 · {TYPES[t].name}</div>
              <div className="ch-sub">只做简单处理，保存后生成一条新产出，原素材不受影响</div>
            </div>
          </div>
          <div className="composer-body">
            <div className="field-block">
              <div className="field-head">
                <span className="field-label">
                  <Icon name="layers" />
                  选择素材
                </span>
                <span className="field-hint">{pool.length} 项 · 点缩略图切换</span>
                <span className="grow" />
                {(
                  [
                    ['ws', '当前项目'],
                    ['all', '全部项目'],
                  ] as const
                ).map(([k, n]) => (
                  <button key={k} className={`fchip ${s.editScope === k ? 'on' : ''}`} onClick={() => setState((st) => void (st.editScope = k))}>
                    {n}
                  </button>
                ))}
              </div>
              {pool.length ? (
                <div className="src-strip">
                  {pool.slice(0, 12).map((r) => (
                    <button key={r.id} className={`src-thumb ${cur && cur.id === r.id ? 'on' : ''}`} title={r.title} onClick={() => editPick(r.id)}>
                      <MediaThumb r={r} />
                      <span className="st-name">{r.title}</span>
                      <span className="st-ws">
                        <ProjectMini ws={r.ws} />
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="tiny dim">
                  素材库里还没有{TYPES[t].name}产出。{s.editScope === 'ws' ? '可切到「全部项目」，或' : ''}先到「生成」产出一条并保存到素材库。
                </div>
              )}
            </div>
            {t === 'image' ? <ImageOps ops={ops as ImageEditOps} /> : t === 'video' ? <VideoOps ops={ops as VideoEditOps} cur={cur} /> : <AudioOps ops={ops as AudioEditOps} cur={cur} />}
            <div className="edit-foot">
              <button className="btn ghost" onClick={editReset}>
                <Icon name="refresh" />
                重置参数
              </button>
              <span className="grow" />
              <button className="btn primary" onClick={() => void editSave()}>
                <Icon name="check" />
                保存为新产出
              </button>
            </div>
          </div>
        </section>
      </div>
      <div className="edit-col">
        <section className="card">
          <div className="edit-stage-head">
            <span className="field-label">
              <Icon name="eye" />
              预览
            </span>
            <span className="grow" />
            <span className="tiny dim">{cur ? cur.title : ''}</span>
          </div>
          <div className="edit-stage">
            <Stage t={t} cur={cur} />
          </div>
        </section>
      </div>
    </div>
  );
}

function Range({ label, k, val, min, max, unit, step = 1 }: { label: string; k: string; val: number; min: number; max: number; unit: string; step?: number }) {
  return (
    <div className="form-row">
      <span className="form-label">{label}</span>
      <div className="edit-slider">
        <input type="range" min={min} max={max} step={step} value={val} onChange={(e) => editInput(k, e.target.value)} />
        <span className="esv num">
          {val}
          {unit}
        </span>
      </div>
    </div>
  );
}

function OpPill({ k, v, on, children }: { k: string; v: string; on: boolean; children: React.ReactNode }) {
  return (
    <button className={`opt-pill ${on ? 'on' : ''}`} onClick={() => editOp(k, v)}>
      {children}
    </button>
  );
}

function ImageOps({ ops }: { ops: ImageEditOps }) {
  return (
    <>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">
            <Icon name="palette" />
            滤镜
          </span>
          <span className="field-hint">直接作用在画面色调上</span>
        </div>
        <div className="opt-pills">
          {EDIT_FILTERS.map((f) => (
            <OpPill key={f.k} k="filter" v={f.k} on={ops.filter === f.k}>
              {f.n}
            </OpPill>
          ))}
        </div>
      </div>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">
            <Icon name="refresh" />
            翻转
          </span>
        </div>
        <div className="opt-pills">
          <OpPill k="flipH" v="1" on={ops.flipH}>
            水平翻转
          </OpPill>
          <OpPill k="flipV" v="1" on={ops.flipV}>
            垂直翻转
          </OpPill>
        </div>
      </div>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">
            <Icon name="crop" />
            明暗与色彩
          </span>
          <span className="field-hint">0 为保持原样</span>
        </div>
        <Range label="亮度" k="brightness" val={ops.brightness} min={-50} max={50} unit="%" />
        <Range label="对比度" k="contrast" val={ops.contrast} min={-50} max={50} unit="%" />
        <Range label="饱和度" k="saturate" val={ops.saturate} min={-50} max={50} unit="%" />
      </div>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">
            <Icon name="expand" />
            裁剪比例
          </span>
          <span className="field-hint">决定导出规格</span>
        </div>
        <div className="opt-pills">
          {EDIT_CROPS.map((c) => (
            <OpPill key={c} k="crop" v={c} on={ops.crop === c}>
              {c}
            </OpPill>
          ))}
        </div>
      </div>
    </>
  );
}

function VideoOps({ ops, cur }: { ops: VideoEditOps; cur: Result | null }) {
  const clip = trimOf('video', ops, cur);
  return (
    <>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">
            <Icon name="film" />
            裁剪时长
          </span>
          <span className="field-hint">
            保留 {clip.len}s / 共 {clip.total}s
          </span>
        </div>
        <Range label="入点" k="in" val={clip.a} min={0} max={clip.total} unit="s" step={0.5} />
        <Range label="出点" k="out" val={clip.b} min={0} max={clip.total} unit="s" step={0.5} />
      </div>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">
            <Icon name="zap" />
            变速
          </span>
        </div>
        <div className="opt-pills">
          {[0.5, 1, 1.5, 2].map((v) => (
            <OpPill key={v} k="speed" v={String(v)} on={ops.speed === v}>
              {v}x
            </OpPill>
          ))}
        </div>
      </div>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">
            <Icon name="volume" />
            声音与封面
          </span>
        </div>
        <div className="opt-pills">
          <OpPill k="mute" v="1" on={ops.mute}>
            静音
          </OpPill>
          {['首帧', '中间', '末帧'].map((c) => (
            <OpPill key={c} k="cover" v={c} on={ops.cover === c}>
              封面 {c}
            </OpPill>
          ))}
        </div>
      </div>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">
            <Icon name="pen" />
            叠加字幕
          </span>
          <span className="field-hint">留空则不加</span>
        </div>
        <input className="form-input" value={ops.caption} onChange={(e) => editInput('caption', e.target.value)} placeholder="例如：春天第一杯冷萃" />
      </div>
    </>
  );
}

function AudioOps({ ops, cur }: { ops: AudioEditOps; cur: Result | null }) {
  const clip = trimOf('audio', ops, cur);
  return (
    <>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">
            <Icon name="waveform" />
            裁剪时长
          </span>
          <span className="field-hint">
            保留 {clip.len}s / 共 {clip.total}s
          </span>
        </div>
        <Range label="入点" k="in" val={clip.a} min={0} max={clip.total} unit="s" />
        <Range label="出点" k="out" val={clip.b} min={0} max={clip.total} unit="s" />
      </div>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">
            <Icon name="volume" />
            音量与包络
          </span>
        </div>
        <Range label="音量" k="volume" val={ops.volume} min={0} max={150} unit="%" step={5} />
        <Range label="淡入" k="fadeIn" val={ops.fadeIn} min={0} max={3} unit="s" step={0.5} />
        <Range label="淡出" k="fadeOut" val={ops.fadeOut} min={0} max={3} unit="s" step={0.5} />
      </div>
      <div className="field-block">
        <div className="field-head">
          <span className="field-label">
            <Icon name="shield" />
            清理
          </span>
        </div>
        <div className="opt-pills">
          <OpPill k="denoise" v="1" on={ops.denoise}>
            降噪
          </OpPill>
          <OpPill k="norm" v="1" on={ops.norm}>
            响度标准化 -3dB
          </OpPill>
        </div>
      </div>
    </>
  );
}

function Readout({ items }: { items: string[] }) {
  return (
    <div className="edit-readout">
      {items.map((x) => (
        <span key={x} className="er-chip">
          {x}
        </span>
      ))}
    </div>
  );
}

const sgn = (n: number) => (n > 0 ? `+${n}` : `${n}`);

function PlayRow({ cur, from, to, onToggle }: { cur: Result; from: number; to: number; onToggle: () => void }) {
  const play = useStore((s) => (s.play.id === cur.id ? s.play.t : -1));
  const playing = play >= 0;
  const total = cur.dur || (cur.type === 'video' ? 5 : 30);
  const t = playing ? play : from;
  return (
    <div className="edit-play-row">
      <button className="sc-btn" title={playing ? '暂停' : '试看 / 试听当前剪辑'} onClick={onToggle}>
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
      <div className="stage-track">
        <i style={{ width: `${((t / total) * 100).toFixed(1)}%` }} />
      </div>
      <span className="stage-time">
        {mmss(t)} / {mmss(to)}
      </span>
    </div>
  );
}

function Stage({ t, cur }: { t: MediaType; cur: Result | null }) {
  const s = useStore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const playing = useStore((st) => !!cur && st.play.id === cur.id);
  const vops = s.editOps.video;
  const clipV = trimOf('video', vops, cur);

  /* 真实视频：在入点到出点之间按倍速播放 */
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !cur || cur.simulated) return;
    v.playbackRate = vops.speed;
    v.muted = vops.mute;
    if (playing) {
      v.currentTime = clipV.a;
      void v.play().catch(() => stopPlay());
    } else {
      v.pause();
      v.currentTime = vops.cover === '首帧' ? clipV.a : vops.cover === '末帧' ? Math.max(clipV.a, clipV.b - 0.1) : (clipV.a + clipV.b) / 2;
    }
  }, [playing, cur?.id, vops.speed, vops.mute, vops.cover, clipV.a, clipV.b]);

  useEffect(() => () => stopPlay(), []);

  if (!cur) {
    return <Empty icon="image" title={`还没有可编辑的${TYPES[t].name}`} desc="先切换到「生成」产出一条并保存到素材库，再回来做基础处理。" />;
  }

  if (t === 'image') {
    const ops = s.editOps.image;
    const crop = ops.crop === '原图' ? cur.ratio || '1:1' : ops.crop;
    const tf = editTransform(ops);
    return (
      <>
        <div className="es-media">
          <div className="es-cropframe" style={{ aspectRatio: crop.replace(':', ' / ') }}>
            <img src={cur.src} alt={cur.title} style={{ ...cssOfEdit(cur.edit?.css), filter: editCss(ops), transform: tf || undefined }} />
          </div>
        </div>
        <div className="trim-labels">
          <span>原图 {cur.ratio || '1:1'}</span>
          <span className="num">导出比例 {crop}</span>
        </div>
        <Readout
          items={[
            `滤镜 ${EDIT_FILTERS.find((f) => f.k === ops.filter)?.n || '原图'}`,
            `亮度 ${sgn(ops.brightness)}`,
            `对比度 ${sgn(ops.contrast)}`,
            `饱和度 ${sgn(ops.saturate)}`,
            `裁剪 ${ops.crop}`,
          ]}
        />
      </>
    );
  }

  if (t === 'video') {
    const pos = vops.cover === '首帧' ? 'center top' : vops.cover === '末帧' ? 'center bottom' : 'center';
    return (
      <>
        <PlayRow cur={cur} from={clipV.a} to={clipV.b} onToggle={() => togglePlay(cur.id, { from: clipV.a, to: clipV.b, rate: vops.speed })} />
        <div className="es-media">
          {cur.simulated ? (
            <img src={thumbOf(cur)} alt={cur.title} style={{ objectPosition: pos }} />
          ) : (
            <video
              ref={videoRef}
              src={cur.src}
              playsInline
              preload="auto"
              onTimeUpdate={(e) => {
                if (!playing) return;
                const v = e.currentTarget;
                if (v.currentTime >= clipV.b) stopPlay();
                else reportTime(cur.id, v.currentTime);
              }}
              onEnded={() => playing && stopPlay()}
            />
          )}
          {vops.caption && <span className="es-caption">{vops.caption}</span>}
          <span className="es-flag">
            <Icon name="volume" />
            {vops.mute ? '已静音' : '保留原声'}
          </span>
        </div>
        <div className="trim-wrap">
          <div className="trim-bar">
            <i className="trim-seg" style={{ left: `${(clipV.a / clipV.total) * 100}%`, width: `${(clipV.len / clipV.total) * 100}%` }} />
          </div>
          <div className="trim-labels">
            <span>0s</span>
            <span className="num">
              保留 {mmss(clipV.a)} – {mmss(clipV.b)} · {clipV.len}s
            </span>
            <span>{clipV.total}s</span>
          </div>
        </div>
        <Readout items={[`变速 ${vops.speed}x`, vops.mute ? '已静音' : '保留原声', `封面 ${vops.cover}`, vops.caption ? '含字幕' : '无字幕']} />
      </>
    );
  }

  const aops = s.editOps.audio;
  const clip = trimOf('audio', aops, cur);
  const bars = seededSeries(cur.seed, 64, 22, 100);
  const playT = s.play.id === cur.id ? s.play.t : -1;
  const played = playT >= 0 ? Math.round(64 * (playT / clip.total)) : 0;
  return (
    <>
      <PlayRow cur={cur} from={clip.a} to={clip.b} onToggle={() => togglePlay(cur.id, { from: clip.a, to: clip.b, volume: aops.volume })} />
      <div className="edit-wave">
        {bars.map((v, i) => (
          <i key={i} className={i < played ? 'play' : ''} style={{ height: `${v.toFixed(0)}%` }} />
        ))}
        <div className="ew-sel" style={{ left: `${(clip.a / clip.total) * 100}%`, width: `${(clip.len / clip.total) * 100}%` }} />
      </div>
      <div className="trim-labels">
        <span>0s</span>
        <span className="num">
          保留 {mmss(clip.a)} – {mmss(clip.b)} · {clip.len}s
        </span>
        <span>{clip.total}s</span>
      </div>
      <Readout
        items={[`音量 ${aops.volume}%`, `淡入 ${aops.fadeIn}s`, `淡出 ${aops.fadeOut}s`, aops.denoise ? '已降噪' : '未降噪', aops.norm ? '响度标准化' : '不标准化']}
      />
      {!cur.simulated && <div className="tiny dim">剪辑参数作为非破坏性设置保存：试听与播放时生效，原文件不变。</div>}
    </>
  );
}
