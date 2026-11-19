import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ============================================================================
   本机外部工具：ffmpeg / yt-dlp / whisper。都不随安装包分发（ffmpeg 除外），
   找不到时界面给出安装指引，而不是静默失败。查找顺序：环境变量 → PATH → 常见安装目录
   （macOS 的图形应用拿不到 shell 的 PATH，Homebrew 装的工具要额外找 /opt/homebrew/bin）。
   每次现查，用户装好后点「重新检测」就能生效，不用重启。
   ========================================================================== */

export type ToolName = 'ffmpeg' | 'ytdlp' | 'whisper';

const SPEC: Record<ToolName, { exe: string; env: string }> = {
  ffmpeg: { exe: 'ffmpeg', env: 'AIGC_FFMPEG' },
  ytdlp: { exe: 'yt-dlp', env: 'AIGC_YTDLP' },
  whisper: { exe: 'whisper', env: 'AIGC_WHISPER' },
};

function extraDirs() {
  const home = os.homedir();
  return process.platform === 'win32'
    ? [path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'), path.join(home, 'AppData', 'Roaming', 'Python', 'Scripts'), 'C:\\ProgramData\\chocolatey\\bin', path.join(home, 'scoop', 'shims')]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.local', 'bin'), path.join(home, 'bin')];
}

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export function findTool(name: ToolName): string | null {
  const { exe, env } = SPEC[name];
  const fromEnv = process.env[env];
  if (fromEnv) return isFile(fromEnv) ? fromEnv : null; /* 显式配置了就只认它，配错了要报出来 */
  const names = process.platform === 'win32' ? [`${exe}.exe`, `${exe}.cmd`, exe] : [exe];
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...extraDirs()];
  for (const d of dirs) for (const n of names) if (isFile(path.join(d, n))) return path.join(d, n);
  return null;
}

export interface ToolInfo {
  name: ToolName;
  title: string;
  purpose: string;
  found: boolean;
  path: string | null;
  /** 环境变量配了但路径不对 */
  badEnv: boolean;
  env: string;
  /** 安装指引：按系统给命令 */
  install: { mac: string[]; win: string[]; linux: string[]; note?: string };
}

const INSTALL: Record<ToolName, ToolInfo['install']> = {
  ffmpeg: { mac: ['brew install ffmpeg'], win: ['winget install Gyan.FFmpeg'], linux: ['sudo apt install ffmpeg'], note: '安装包自带 ffmpeg；这里只在从源码运行时才需要自己装。' },
  ytdlp: { mac: ['brew install yt-dlp'], win: ['winget install yt-dlp.yt-dlp'], linux: ['pipx install yt-dlp', '或：sudo apt install yt-dlp'], note: '用来从视频链接下载视频到画布。装好后点「重新检测」。' },
  whisper: {
    mac: ['pip3 install -U openai-whisper'],
    win: ['pip install -U openai-whisper'],
    linux: ['pip3 install -U openai-whisper'],
    note: '用来把视频 / 音频转成文字。需要 Python 3.9+ 和 ffmpeg；首次转写会下载语音模型（small 约 460MB，可用环境变量 AIGC_WHISPER_MODEL 换成 base / medium / large-v3）。目前支持 openai-whisper 命令行。',
  },
};

const TITLES: Record<ToolName, [string, string]> = { ffmpeg: ['ffmpeg', '视频 / 音频编辑、取帧'], ytdlp: ['yt-dlp', '链接下载视频'], whisper: ['whisper', '语音转文字'] };

export function toolInfo(name: ToolName): ToolInfo {
  const p = findTool(name);
  const env = SPEC[name].env;
  return { name, title: TITLES[name][0], purpose: TITLES[name][1], found: !!p, path: p, badEnv: !!process.env[env] && !p, env, install: INSTALL[name] };
}

export const allTools = () => (['ffmpeg', 'ytdlp', 'whisper'] as ToolName[]).map(toolInfo);

/** 找不到工具时抛出的错误：状态码 501，detail 里带安装命令，界面据此展示指引 */
export class ToolMissing extends Error {
  constructor(readonly tool: ToolName) {
    const i = toolInfo(tool);
    super(i.badEnv ? `${SPEC[tool].env} 指向的文件不存在` : `没有找到 ${i.title}`);
  }
}

export const requireTool = (name: ToolName) => {
  const p = findTool(name);
  if (!p) throw new ToolMissing(name);
  return p;
};

export interface RunHandle {
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  kill(): void;
}

/** 跑外部命令：参数数组（不经过 shell）、可取消、输出按行回调 */
export function runTool(bin: string, args: string[], opts: { onLine?: (line: string) => void; timeoutMs?: number; cwd?: string } = {}): RunHandle {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: opts.cwd });
  let stdout = '';
  let stderr = '';
  let buf = '';
  const feed = (d: Buffer) => {
    const t = d.toString();
    buf += t;
    let i: number;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) opts.onLine?.(line);
    }
  };
  p.stdout.on('data', (d: Buffer) => {
    stdout = (stdout + d.toString()).slice(-2_000_000);
    feed(d);
  });
  p.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-20_000);
    feed(d);
  });
  const t = opts.timeoutMs ? setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs) : null;
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    p.once('error', (e) => {
      if (t) clearTimeout(t);
      reject(e);
    });
    p.once('close', (code) => {
      if (t) clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
  return { done, kill: () => p.kill('SIGKILL') };
}
