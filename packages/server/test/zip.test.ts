import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Result } from '@aigc/shared';
import { buildApp } from '../src/app';
import { Core } from '../src/core';
import { uniqueNames, zipStream } from '../src/zip';

const hasUnzip = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;

async function collect(s: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe('批量下载 zip', () => {
  it('重名与危险字符：加序号、替换分隔符', () => {
    expect(uniqueNames(['a.png', 'a.png', 'A.png', '../x/y.png', 'b'])).toEqual(['a.png', 'a (2).png', 'A (3).png', '.._x_y.png'.replace(/^\.+/, '_'), 'b']);
  });

  it.skipIf(!hasUnzip)('生成的是合法 zip：unzip 校验通过，中文文件名与内容无损', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-zip-'));
    const a = path.join(dir, 'a.bin');
    const b = path.join(dir, 'b.bin');
    fs.writeFileSync(a, Buffer.from('hello zip'));
    fs.writeFileSync(b, Buffer.alloc(300_000, 7));
    const out = path.join(dir, 'out.zip');
    fs.writeFileSync(out, await collect(zipStream([{ name: '发散 · 更暖 #1.png', file: a }, { name: 'big.mp4', file: b }])));
    expect(execFileSync('unzip', ['-tq', out]).toString()).toContain('No errors');
    /* 文件名按 UTF-8 标志解码：用 python 的 zipfile 读（各平台的 unzip 对 UTF-8 名字支持不一） */
    const py = `import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);import hashlib;print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()},ensure_ascii=False))`;
    const got = JSON.parse(execFileSync('python3', ['-I', '-c', py, out]).toString()) as Record<string, string>;
    expect(Object.keys(got)).toEqual(['发散 · 更暖 #1.png', 'big.mp4']);
    const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    expect(got['发散 · 更暖 #1.png']).toBe(sha(a));
    expect(got['big.mp4']).toBe(sha(b));
  });

  it('接口：按 id 打包，跳过没有本机文件的；全都没有时 404', async () => {
    const core = await Core.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-zipapi-')), mode: 'web', desktop: false, version: 'test', memory: true, account: { provider: 'mock' } });
    try {
      const ws = core.store.projects.all()[0].id;
      const f = core.newMediaFile('png');
      fs.writeFileSync(f.file, 'png-bytes');
      const base = { job: null, type: 'image' as const, ws, ratio: '1:1', model: 'm', seed: 1, createdAt: 1, status: 'new' as const, tags: [] as string[], dur: 0, home: 'library' as const };
      core.store.results.put({ ...base, id: 'r1', title: '图一', src: f.src } satisfies Result);
      core.store.results.put({ ...base, id: 'r2', title: '链接图', src: 'https://example.com/x.png' } satisfies Result);
      const app = await buildApp(core);
      const ok = await app.inject({ method: 'GET', url: '/api/download/zip?ids=r1,r2,nope&name=测试', headers: { host: 'localhost' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toBe('application/zip');
      expect(ok.headers['x-zip-count']).toBe('1');
      expect(ok.headers['x-zip-skipped']).toBe('2');
      expect(decodeURIComponent(String(ok.headers['content-disposition']))).toContain('测试.zip');
      expect(ok.rawPayload.subarray(0, 4).toString('hex')).toBe('504b0304');
      const none = await app.inject({ method: 'GET', url: '/api/download/zip?ids=r2', headers: { host: 'localhost' } });
      expect(none.statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/download/zip', headers: { host: 'localhost' } })).statusCode).toBe(400);
      await app.close();
    } finally {
      core.close();
    }
  });
});
