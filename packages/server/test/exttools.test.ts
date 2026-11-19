import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { Core } from '../src/core';
import { checkUrl, parseWhisperJson, srtTime, toSrt } from '../src/exttasks';
import { findTool } from '../src/tools';
import { findFfmpeg } from '../src/render';

/* 外部工具：yt-dlp / whisper 用「假命令」验证我们这一侧的集成（参数、进度、结果入库、错误与取消）。
   真实的 yt-dlp / whisper 没有在这里跑——它们的行为由各自项目负责。 */

const ffmpeg = findFfmpeg();
const unix = process.platform !== 'win32';
const envKeys = ['AIGC_YTDLP', 'AIGC_WHISPER', 'AIGC_WHISPER_MODEL', 'PATH'] as const;
const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const H = { host: 'localhost', 'x-aigc-client': '1' };
async function makeApp() {
  const core = await Core.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-ext-')), mode: 'web', desktop: false, version: 't', memory: true, account: { provider: 'mock' } });
  return { core, app: await buildApp(core), ws: core.store.projects.all()[0].id };
}
const script = (name: string, body: string) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-fake-')), name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
};
const waitTask = async (app: Awaited<ReturnType<typeof makeApp>>['app'], url: string) => {
  for (let i = 0; i < 100; i++) {
    const t = (await app.inject({ method: 'GET', url, headers: H })).json().task;
    if (t.status !== 'running') return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('任务超时');
};

describe('纯逻辑', () => {
  it('链接校验：只放行 http(s)，拒绝本机 / 元数据地址', () => {
    expect(checkUrl('https://www.bilibili.com/video/BV1xx').hostname).toBe('www.bilibili.com');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1:5780/x', 'http://localhost/x', 'http://169.254.169.254/latest', 'http://[::1]/x', 'not a url']) expect(() => checkUrl(bad)).toThrow();
  });

  it('SRT 时间与结构；whisper json 解析', () => {
    expect(srtTime(3661.5)).toBe('01:01:01,500');
    expect(srtTime(0.9996)).toBe('00:00:01,000');
    const r = parseWhisperJson(JSON.stringify({ language: 'zh', text: ' 你好 世界 ', segments: [{ start: 0, end: 1.2, text: ' 你好 ' }, { start: 1.2, end: 2, text: '' }, { start: 2, end: 3.5, text: '世界' }] }));
    expect(r.language).toBe('zh');
    expect(r.segments).toHaveLength(2);
    expect(r.srt).toBe('1\n00:00:00,000 --> 00:00:01,200\n你好\n\n2\n00:00:02,000 --> 00:00:03,500\n世界\n');
    expect(toSrt([])).toBe('');
  });

  it('找工具：环境变量优先；配错了就是找不到（不悄悄回退到 PATH）', () => {
    process.env.AIGC_YTDLP = '/nonexistent/yt-dlp';
    expect(findTool('ytdlp')).toBeNull();
    const f = script('yt-dlp', 'exit 0');
    process.env.AIGC_YTDLP = f;
    expect(findTool('ytdlp')).toBe(f);
  });
});

describe('缺工具时给安装指引', () => {
  it('/api/tools 列出状态；没装 yt-dlp / whisper 时接口返回 501 + 工具信息与安装命令', async () => {
    process.env.AIGC_YTDLP = '/nonexistent/yt-dlp';
    process.env.AIGC_WHISPER = '/nonexistent/whisper';
    const { core, app, ws } = await makeApp();
    try {
      const tools = (await app.inject({ method: 'GET', url: '/api/tools', headers: H })).json().tools as { name: string; found: boolean; badEnv: boolean }[];
      expect(tools.find((t) => t.name === 'ytdlp')).toMatchObject({ found: false, badEnv: true });
      const r = await app.inject({ method: 'POST', url: '/api/link/probe', headers: H, payload: { url: 'https://example.com/v' } });
      expect(r.statusCode).toBe(501);
      expect(r.json().tool.install.mac[0]).toContain('brew install yt-dlp');
      const d = await app.inject({ method: 'POST', url: '/api/link/download', headers: H, payload: { url: 'https://example.com/v', ws } });
      expect(d.statusCode).toBe(501);
      core.store.results.put({ id: 'rv', job: null, type: 'video', ws, title: 'v', src: '/files/media/none.mp4', ratio: '1:1', model: 'm', seed: 1, createdAt: 1, status: 'new', tags: [], dur: 3, home: 'library' });
      const t = await app.inject({ method: 'POST', url: '/api/transcribe', headers: H, payload: { sourceId: 'rv' } });
      expect([400, 501]).toContain(t.statusCode); /* 文件不存在先拒绝；文件在时才轮到缺 whisper */
    } finally {
      await app.close();
      core.close();
    }
  });
});

describe.skipIf(!unix || !ffmpeg)('用假命令验证集成', () => {
  it('链接下载：解析 → 下载（带进度）→ 入库为本机视频；参数里有 -- 和 --no-playlist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-fakesrc-'));
    const sample = path.join(dir, 'sample.mp4');
    execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=25:duration=2', '-pix_fmt', 'yuv420p', sample]);
    const argsLog = path.join(dir, 'args.log');
    process.env.AIGC_YTDLP = script(
      'yt-dlp',
      `echo "$@" >> "${argsLog}"
case "$*" in
  *--dump-single-json*) echo '{"title":"测试视频","duration":2,"uploader":"某UP","extractor_key":"Fake"}'; exit 0;;
esac
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && OUT="$2"; shift; done
echo "[download]  10.0% of 1MiB"; echo "[download]  60.0% of 1MiB"; cp "${sample}" "$OUT"; echo "[download] 100% of 1MiB"; exit 0`,
    );
    const { core, app, ws } = await makeApp();
    try {
      const probe = (await app.inject({ method: 'POST', url: '/api/link/probe', headers: H, payload: { url: 'https://example.com/watch?v=1' } })).json();
      expect(probe).toMatchObject({ title: '测试视频', duration: 2, uploader: '某UP' });
      const start = await app.inject({ method: 'POST', url: '/api/link/download', headers: H, payload: { url: 'https://example.com/watch?v=1', ws, title: '测试视频' } });
      expect(start.statusCode).toBe(200);
      const t = await waitTask(app, `/api/link/download/${start.json().task.id}`);
      expect(t.status).toBe('done');
      expect(t.result.result).toMatchObject({ type: 'video', ws, title: '测试视频', ratio: '9:16', home: 'canvas', tags: ['链接下载'] });
      expect(fs.existsSync(core.localPathOf(t.result.result.src)!)).toBe(true);
      expect(core.store.results.get(t.result.result.id)).toBeTruthy();
      const log = fs.readFileSync(argsLog, 'utf8');
      expect(log).toContain('--no-playlist');
      expect(log).toContain('-- https://example.com/watch?v=1');
      /* 危险链接在到达 yt-dlp 之前就被拒绝 */
      expect((await app.inject({ method: 'POST', url: '/api/link/download', headers: H, payload: { url: 'http://127.0.0.1:5780/x', ws } })).statusCode).toBe(400);
    } finally {
      await app.close();
      core.close();
    }
  });

  it('链接下载：yt-dlp 失败时带回它的错误原因，不留半成品；可以取消', async () => {
    process.env.AIGC_YTDLP = script('yt-dlp', 'echo "ERROR: Sign in to confirm your age" >&2; exit 1');
    const { core, app, ws } = await makeApp();
    try {
      const probe = await app.inject({ method: 'POST', url: '/api/link/probe', headers: H, payload: { url: 'https://example.com/v' } });
      expect(probe.statusCode).toBe(502);
      expect(probe.json().detail).toContain('Sign in');
      const start = await app.inject({ method: 'POST', url: '/api/link/download', headers: H, payload: { url: 'https://example.com/v', ws } });
      const t = await waitTask(app, `/api/link/download/${start.json().task.id}`);
      expect(t).toMatchObject({ status: 'failed' });
      expect(t.error).toContain('Sign in');
      expect(core.store.results.all().filter((r) => r.tags.includes('链接下载'))).toHaveLength(0);
      expect(fs.readdirSync(core.mediaDir)).toHaveLength(0);

      process.env.AIGC_YTDLP = script('yt-dlp', 'sleep 30');
      const s2 = await app.inject({ method: 'POST', url: '/api/link/download', headers: H, payload: { url: 'https://example.com/v', ws } });
      const id = s2.json().task.id;
      expect((await app.inject({ method: 'POST', url: `/api/link/download/${id}/cancel`, headers: H })).json().ok).toBe(true);
      expect((await app.inject({ method: 'GET', url: `/api/link/download/${id}`, headers: H })).json().task.status).toBe('canceled');
    } finally {
      await app.close();
      core.close();
    }
  });

  it('转写：提取音轨 → whisper → 文本 + 时间轴 + SRT；用的模型来自环境变量', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-fakeasr-'));
    const argsLog = path.join(dir, 'args.log');
    process.env.AIGC_WHISPER_MODEL = 'large-v3';
    process.env.AIGC_WHISPER = script(
      'whisper',
      `echo "$@" > "${argsLog}"
OUTDIR=""; while [ $# -gt 0 ]; do [ "$1" = "--output_dir" ] && OUTDIR="$2"; shift; done
echo '{"language":"zh","text":"你好世界","segments":[{"start":0,"end":1.5,"text":"你好"},{"start":1.5,"end":3,"text":"世界"}]}' > "$OUTDIR/audio.json"`,
    );
    const { core, app, ws } = await makeApp();
    try {
      const v = core.newMediaFile('mp4');
      execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2', '-shortest', '-pix_fmt', 'yuv420p', v.file]);
      core.store.results.put({ id: 'rv', job: null, type: 'video', ws, title: '口播', src: v.src, ratio: '4:3', model: 'm', seed: 1, createdAt: 1, status: 'new', tags: [], dur: 2, home: 'library' });
      const start = await app.inject({ method: 'POST', url: '/api/transcribe', headers: H, payload: { sourceId: 'rv', language: 'zh' } });
      expect(start.statusCode).toBe(200);
      const t = await waitTask(app, `/api/transcribe/${start.json().task.id}`);
      expect(t.status).toBe('done');
      expect(t.result).toMatchObject({ text: '你好世界', language: 'zh' });
      expect(t.result.segments).toHaveLength(2);
      expect(t.result.srt).toContain('00:00:01,500 --> 00:00:03,000');
      const log = fs.readFileSync(argsLog, 'utf8');
      expect(log).toContain('--model large-v3');
      expect(log).toContain('--language zh');
      expect((await app.inject({ method: 'POST', url: '/api/transcribe', headers: H, payload: { sourceId: 'nope' } })).statusCode).toBe(404);
    } finally {
      await app.close();
      core.close();
    }
  });
});
