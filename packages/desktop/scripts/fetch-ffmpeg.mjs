/* 下载打包要带的 ffmpeg（视频 / 音频编辑的真渲染用它）。
   用法：node scripts/fetch-ffmpeg.mjs [mac-arm64,mac-x64,win-x64,linux-x64]
   不带参数时只取当前这台机器的平台。结果放在 build/ffmpeg/<目标>/ffmpeg(.exe)，
   由 electron-builder 的 extraResources（${os}-${arch}）按目标拷进安装包的 resources/bin。
   二进制来自 eugeneware/ffmpeg-static 的发布（GPL 构建；本项目同为 GPL-3.0）。 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = process.env.FFMPEG_STATIC_TAG || 'b6.1.1';
const ASSET = { 'mac-arm64': 'darwin-arm64', 'mac-x64': 'darwin-x64', 'win-x64': 'win32-x64', 'linux-x64': 'linux-x64' };

const here = `${{ darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]}-${process.arch}`;
const wanted = (process.argv[2] || here)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function download(url) {
  let last;
  for (let i = 1; i <= 4; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw new Error(`下载失败 ${url}：${last?.message}`);
}

for (const target of wanted) {
  const asset = ASSET[target];
  if (!asset) throw new Error(`不认识的目标 ${target}，可选：${Object.keys(ASSET).join(', ')}`);
  const exe = target.startsWith('win') ? 'ffmpeg.exe' : 'ffmpeg';
  const dir = path.join(root, 'build', 'ffmpeg', target);
  const file = path.join(dir, exe);
  if (fs.existsSync(file) && fs.statSync(file).size > 5_000_000) {
    console.log(`ffmpeg ${target}: 已存在，跳过`);
    continue;
  }
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${TAG}/ffmpeg-${asset}.gz`;
  console.log(`ffmpeg ${target}: ${url}`);
  const bin = zlib.gunzipSync(await download(url));
  if (bin.length < 5_000_000) throw new Error(`ffmpeg ${target} 文件太小（${bin.length} 字节），下载内容不对`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, bin, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  console.log(`ffmpeg ${target}: ${(bin.length / 1048576).toFixed(1)} MB → ${path.relative(root, file)}`);
}
