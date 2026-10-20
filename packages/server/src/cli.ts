import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PORT } from '@aigc/shared';
import { startServer } from './index';
import { defaultDataDir } from './paths';

/* 桌面主进程直接 require 这个包，复用同一个服务实现 */
export { startServer, defaultDataDir };

/* ============================================================================
   Web 模式的独立入口：
     node server.cjs [--port 5780] [--host 127.0.0.1|0.0.0.0] [--data <dir>] [--open] [--no-seed]
   打包后由桌面程序以 ELECTRON_RUN_AS_NODE=1 启动，没有显示器的 Linux 服务器也能跑。
   ========================================================================== */

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function firstExisting(cands: string[], probe: string) {
  return cands.find((c) => fs.existsSync(path.join(c, probe)));
}

export function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 没有图形环境就算了，地址已经打印出来了 */
  }
}

async function main() {
  const dataDir = arg('data') ? path.resolve(arg('data')!) : defaultDataDir();
  let launch: { host?: string; port?: number; lan?: boolean } = {};
  try {
    launch = JSON.parse(fs.readFileSync(path.join(dataDir, 'launch-mode.json'), 'utf8'));
  } catch {
    /* 没有就用默认值 */
  }
  const host = arg('host') || (flag('lan') ? '0.0.0.0' : launch.lan ? '0.0.0.0' : launch.host || '127.0.0.1');
  const port = Number(arg('port') || launch.port || DEFAULT_PORT);
  const webDir =
    arg('web') ||
    process.env.AIGC_WEB_DIR ||
    firstExisting([path.join(__dirname, 'web'), path.join(__dirname, '..', 'web'), path.join(__dirname, '..', '..', 'web', 'dist')], 'index.html');
  const samplesDir =
    arg('samples') ||
    process.env.AIGC_SAMPLES_DIR ||
    firstExisting(
      [path.join(__dirname, 'samples'), path.join(__dirname, '..', 'samples'), path.join(__dirname, '..', '..', '..', 'resources', 'samples')],
      'thumbs',
    ) ||
    path.join(__dirname, 'samples');

  const srv = await startServer({
    dataDir,
    samplesDir,
    webDir,
    mode: 'web',
    desktop: false,
    host,
    port,
    seed: !flag('no-seed'),
    logger: flag('verbose'),
    mockTickMs: process.env.AIGC_MOCK_TICK ? Number(process.env.AIGC_MOCK_TICK) : undefined,
  });

  const lines = [
    '',
    '  AIGC 创作台 · Web 服务已启动',
    `  本机访问：  ${srv.url}`,
    host === '0.0.0.0' ? '  局域网访问：http://<本机 IP>:' + srv.port : '',
    srv.generatedToken ? `  访问口令：  ${srv.generatedToken}（可在「设置 · 运行模式」里修改）` : '',
    `  数据目录：  ${dataDir}`,
    '  按 Ctrl+C 停止',
    '',
  ].filter(Boolean);
  console.log(lines.join('\n'));
  if (process.send) process.send({ type: 'ready', url: srv.url, port: srv.port, token: srv.generatedToken });
  if (flag('open')) openBrowser(srv.url);

  const shutdown = async () => {
    await srv.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.code === 'EADDRINUSE' ? `端口被占用：${e.message}。用 --port 换一个端口。` : e);
    process.exit(1);
  });
}
