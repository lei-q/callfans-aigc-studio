import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { audioArgs, audioFormat, findFfmpeg, parseInfo, probe, renderAudio, renderVideo, tempoOf, videoArgs } from '../src/render';

/* 编辑渲染：参数 → ffmpeg 命令是纯逻辑，一定测；真渲染只在本机有 ffmpeg 时跑 */

describe('参数到 ffmpeg 命令', () => {
  it('解析 ffmpeg -i 打印的流信息', () => {
    const info = parseInfo(`  Duration: 00:01:02.50, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1280x720 [SAR 1:1 DAR 16:9], 800 kb/s, 24 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706d), 44100 Hz, stereo, fltp, 96 kb/s`);
    expect(info).toEqual({ dur: 62.5, w: 1280, h: 720, hasVideo: true, hasAudio: true });
  });

  it('视频：裁剪、变速、静音、字幕都进了命令', () => {
    const info = { dur: 10, w: 1281, h: 721, hasVideo: true, hasAudio: true };
    const { args, dur } = videoArgs('in.mp4', 'out.mp4', { in: 2, out: 6, speed: 2, mute: false, cover: '首帧' }, info);
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4)).toEqual(['-ss', '2.000', '-t', '4.000']);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('setpts=PTS/2');
    expect(graph).toContain('atempo=2');
    expect(dur).toBe(2);

    const muted = videoArgs('in.mp4', 'out.mp4', { in: 0, out: 5, speed: 1, mute: true, cover: '首帧' }, info).args;
    expect(muted).toContain('-an');
    expect(muted.join(' ')).not.toContain('atempo');

    const cap = videoArgs('in.mp4', 'out.mp4', { in: 0, out: 5, speed: 1, mute: false, cover: '首帧' }, info, 'cap.png').args;
    expect(cap.filter((a) => a === '-i')).toHaveLength(2);
    expect(cap[cap.indexOf('-filter_complex') + 1]).toContain('scale=1280:-1[cap]');
  });

  it('入出点越界会被夹住，变速限制在 0.5–2', () => {
    const info = { dur: 5, w: 640, h: 360, hasVideo: true, hasAudio: false };
    const { args, dur } = videoArgs('in.mp4', 'out.mp4', { in: -3, out: 99, speed: 8, mute: false, cover: '首帧' }, info);
    expect(args[args.indexOf('-ss') + 1]).toBe('0.000');
    expect(args[args.indexOf('-t') + 1]).toBe('5.000');
    expect(tempoOf(8)).toBe(2);
    expect(dur).toBe(2.5);
  });

  it('音频：降噪、标准化、音量、淡入淡出按顺序，标准化在音量之前', () => {
    const { args } = audioArgs('in.mp3', 'out.mp3', { in: 1, out: 11, volume: 80, fadeIn: 1, fadeOut: 2, denoise: true, norm: true }, 30, ['-c:a', 'libmp3lame']);
    const af = args[args.indexOf('-af') + 1].split(',');
    expect(af[0]).toContain('afftdn');
    expect(af[1]).toContain('loudnorm');
    expect(af[2]).toBe('volume=0.8');
    expect(af[3]).toBe('afade=t=in:st=0:d=1.000');
    expect(af[4]).toBe('afade=t=out:st=8.000:d=2.000');
    expect(args).toContain('-vn');
  });

  it('音频输出格式跟着来源走', () => {
    expect(audioFormat('.wav').ext).toBe('wav');
    expect(audioFormat('.m4a').ext).toBe('m4a');
    expect(audioFormat('.mp3').ext).toBe('mp3');
    expect(audioFormat('.ogg').ext).toBe('mp3');
  });
});

const ffmpeg = findFfmpeg();

describe.skipIf(!ffmpeg)('真渲染（需要本机有 ffmpeg）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-render-'));
  const sh = (args: string[]) => execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

  it('视频：裁到 2 秒、2 倍速、静音，成品时长约 1 秒并有封面', async () => {
    const input = path.join(dir, 'src.mp4');
    sh(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-pix_fmt', 'yuv420p', '-shortest', input]);
    const out = path.join(dir, 'out.mp4');
    const cover = path.join(dir, 'cover.jpg');
    const r = await renderVideo(ffmpeg!, input, out, cover, { in: 1, out: 3, speed: 2, mute: true, cover: '中间' });
    expect(r.dur).toBe(1);
    const info = await probe(ffmpeg!, out);
    expect(info.hasAudio).toBe(false);
    expect(info.w).toBe(320);
    expect(info.dur).toBeGreaterThan(0.8);
    expect(info.dur).toBeLessThan(1.3);
    expect(fs.statSync(cover).size).toBeGreaterThan(500);
  });

  it('视频：叠加字幕图后仍能正常出片', async () => {
    const input = path.join(dir, 'src2.mp4');
    sh(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-pix_fmt', 'yuv420p', input]);
    const png = path.join(dir, 'cap.png');
    sh(['-f', 'lavfi', '-i', 'color=c=white@0.6:s=640x80,format=rgba', '-frames:v', '1', png]);
    const out = path.join(dir, 'out2.mp4');
    const r = await renderVideo(ffmpeg!, input, out, path.join(dir, 'cover2.jpg'), { in: 0, out: 2, speed: 1, mute: false, cover: '首帧' }, png);
    expect(r.dur).toBe(2);
    expect((await probe(ffmpeg!, out)).hasVideo).toBe(true);
  });

  it('音频：裁剪 + 淡入淡出 + 降噪 + 标准化，时长正确、采样率统一', async () => {
    const input = path.join(dir, 'src.mp3');
    sh(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', input]);
    const out = path.join(dir, 'out.mp3');
    const r = await renderAudio(ffmpeg!, input, out, { in: 1, out: 4, volume: 90, fadeIn: 0.5, fadeOut: 0.5, denoise: true, norm: true }, audioFormat('.mp3').codec);
    expect(r.dur).toBe(3);
    const info = await probe(ffmpeg!, out);
    expect(info.dur).toBeGreaterThan(2.8);
    expect(info.dur).toBeLessThan(3.4);
    expect(info.hasAudio).toBe(true);
  });

  it('不是视频的文件给出明确的 400', async () => {
    const input = path.join(dir, 'a.mp3');
    if (!fs.existsSync(input)) sh(['-f', 'lavfi', '-i', 'sine=duration=1', input]);
    await expect(renderVideo(ffmpeg!, input, path.join(dir, 'x.mp4'), path.join(dir, 'x.jpg'), { in: 0, out: 1, speed: 1, mute: false, cover: '首帧' })).rejects.toMatchObject({ status: 400 });
  });
});

/* 端到端：POST /api/results/edited 对视频 / 音频真的产出了新文件 */
import { execFileSync as exec2 } from 'node:child_process';
import type { Result } from '@aigc/shared';
import { buildApp } from '../src/app';
import { Core } from '../src/core';

describe.skipIf(!ffmpeg)('保存编辑接口（视频 / 音频）', () => {
  it('视频：返回新的 mp4、封面和裁剪后的时长；原素材不变', async () => {
    const core = await Core.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-edit-')), mode: 'web', desktop: false, version: 'test', memory: true, account: { provider: 'mock' } });
    try {
      const orig = core.newMediaFile('mp4');
      exec2(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=4', '-pix_fmt', 'yuv420p', orig.file]);
      const ws = core.store.projects.all()[0].id;
      const src: Result = { id: 'r-src', job: null, type: 'video', ws, title: '原片', src: orig.src, ratio: '4:3', model: 'm', seed: 1, createdAt: 1, status: 'new', tags: [], dur: 4, home: 'library' };
      core.store.results.put(src);
      const app = await buildApp(core);
      const res = await app.inject({
        method: 'POST',
        url: '/api/results/edited',
        headers: { host: 'localhost', 'x-aigc-client': '1' },
        payload: { sourceId: 'r-src', title: '原片（已编辑）', tags: ['已编辑'], edit: { ops: { in: 0, out: 2, speed: 1, mute: true, cover: '末帧', caption: '' } } },
      });
      expect(res.statusCode).toBe(200);
      const out = res.json().result as Result;
      expect(out.src).not.toBe(orig.src);
      expect(out.dur).toBe(2);
      expect(out.mime).toBe('video/mp4');
      expect(out.thumb).toMatch(/\.jpg$/);
      expect(fs.existsSync(core.localPathOf(out.src)!)).toBe(true);
      expect(fs.existsSync(core.localPathOf(out.thumb!)!)).toBe(true);
      expect(core.store.results.get('r-src')!.src).toBe(orig.src);
      await app.close();
    } finally {
      core.close();
    }
  });

  it('找不到 ffmpeg 时给出明确的 501，不假装保存成功', async () => {
    const old = process.env.AIGC_FFMPEG;
    const oldPath = process.env.PATH;
    const { resetFfmpegCache } = await import('../src/render');
    process.env.AIGC_FFMPEG = '/nonexistent/ffmpeg';
    process.env.PATH = '/nonexistent';
    resetFfmpegCache();
    const core = await Core.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-edit2-')), mode: 'web', desktop: false, version: 'test', memory: true, account: { provider: 'mock' } });
    try {
      const ws = core.store.projects.all()[0].id;
      core.store.results.put({ id: 'r-a', job: null, type: 'audio', ws, title: 'a', src: '/files/media/x.mp3', ratio: '1:1', model: 'm', seed: 1, createdAt: 1, status: 'new', tags: [], dur: 3, home: 'library' });
      const app = await buildApp(core);
      const res = await app.inject({ method: 'POST', url: '/api/results/edited', headers: { host: 'localhost', 'x-aigc-client': '1' }, payload: { sourceId: 'r-a', title: 't', tags: [], edit: { ops: { in: 0, out: 3 } } } });
      expect(res.statusCode).toBe(501);
      expect(res.json().error).toContain('ffmpeg');
      await app.close();
    } finally {
      core.close();
      if (old === undefined) delete process.env.AIGC_FFMPEG;
      else process.env.AIGC_FFMPEG = old;
      process.env.PATH = oldPath;
      resetFfmpegCache();
    }
  });
});
