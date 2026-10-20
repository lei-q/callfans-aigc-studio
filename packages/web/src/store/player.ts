import { getState, setState } from './index';
import { resultById } from './selectors';

/* ============================================================================
   播放：演示素材（只有封面）按时间轴模拟推进；真实音频用全局 <audio>，
   真实视频由卡片 / 舞台里的 <video> 自己播，进度回写到这里。
   ========================================================================== */

let timer: ReturnType<typeof setInterval> | null = null;
let audio: HTMLAudioElement | null = null;

export interface PlayOptions {
  /** 编辑器试听：入点 / 出点 / 音量 / 倍速 */
  from?: number;
  to?: number;
  volume?: number;
  rate?: number;
}
let opts: PlayOptions = {};

export function stopPlay() {
  if (timer) clearInterval(timer);
  timer = null;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  setState((s) => {
    s.play = { id: null, t: 0 };
  });
}

export function reportTime(id: string, t: number) {
  setState((s) => {
    if (s.play.id === id) s.play.t = t;
  });
}

export function togglePlay(id: string, o: PlayOptions = {}) {
  const s = getState();
  if (s.play.id === id) {
    stopPlay();
    return;
  }
  stopPlay();
  const r = resultById(s, id);
  if (!r) return;
  opts = o;
  const from = o.from || 0;
  setState((st) => {
    st.play = { id, t: from };
  });
  if (r.simulated) {
    const total = o.to ?? (r.dur || 5);
    const step = 0.25 * (o.rate || 1);
    timer = setInterval(() => {
      const cur = getState().play;
      if (cur.id !== id) return;
      const t = Math.round((cur.t + step) * 100) / 100;
      if (t >= total) stopPlay();
      else reportTime(id, t);
    }, 250);
    return;
  }
  if (r.type === 'audio') {
    audio = audio || new Audio();
    audio.src = r.src;
    audio.currentTime = from;
    audio.volume = Math.max(0, Math.min(1, (o.volume ?? 100) / 100));
    audio.playbackRate = o.rate || 1;
    audio.ontimeupdate = () => {
      if (!audio) return;
      if (opts.to != null && audio.currentTime >= opts.to) {
        stopPlay();
        return;
      }
      reportTime(id, audio.currentTime);
    };
    audio.onended = () => stopPlay();
    audio.play().catch(() => stopPlay());
  }
}

export const playOptions = () => opts;
