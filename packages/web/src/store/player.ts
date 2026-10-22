import { getState, setState } from './index';
import { resultById } from './selectors';

/* ============================================================================
   播放：真实音频用全局 <audio>，进度回写到这里；
   真实视频由卡片 / 舞台里的 <video> 元素自己播。
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
