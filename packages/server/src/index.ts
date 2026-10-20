import crypto from 'node:crypto';
import type { RunMode } from '@aigc/shared';
import { DEFAULT_PORT } from '@aigc/shared';
import { buildApp } from './app';
import { Core } from './core';
import { sha256 } from './secrets';

export { Core } from './core';
export { defaultDataDir, systemLaunchFiles, PRODUCT_DIR } from './paths';

declare const __APP_VERSION__: string | undefined;

export interface StartOptions {
  dataDir: string;
  samplesDir: string;
  webDir?: string;
  mode: RunMode;
  desktop: boolean;
  host?: string;
  port?: number;
  /** 桌面模式：每次启动的会话口令，由 Electron 写进 cookie */
  accessToken?: string;
  seed?: boolean;
  logger?: boolean;
  version?: string;
}

export interface RunningServer {
  url: string;
  host: string;
  port: number;
  core: Core;
  /** 局域网模式下自动生成的访问口令（只在首次生成时返回） */
  generatedToken?: string;
  close(): Promise<void>;
}

const isLoopback = (h: string) => h === '127.0.0.1' || h === 'localhost' || h === '::1';

export async function startServer(o: StartOptions): Promise<RunningServer> {
  const version = o.version || (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev');
  const core = await Core.create({
    dataDir: o.dataDir,
    samplesDir: o.samplesDir,
    webDir: o.webDir,
    mode: o.mode,
    desktop: o.desktop,
    version,
    seed: o.seed,
  });
  const host = o.host || '127.0.0.1';
  const lan = !isLoopback(host);
  let generatedToken: string | undefined;
  if (lan && !o.accessToken && !core.store.settings.runtime.tokenHash) {
    /* 对局域网开放却没有口令：生成一个，避免裸奔 */
    generatedToken = crypto.randomBytes(9).toString('base64url');
    const s = core.store.settings;
    s.runtime.tokenHash = sha256(generatedToken);
    core.store.settings = s;
  }
  const app = await buildApp(core, { accessToken: o.accessToken, lan, logger: o.logger });
  const port = o.port ?? DEFAULT_PORT;
  await app.listen({ host, port });
  const addr = app.server.address();
  const realPort = typeof addr === 'object' && addr ? addr.port : port;
  core.runner.start();
  const shownHost = isLoopback(host) || host === '0.0.0.0' ? '127.0.0.1' : host;
  return {
    url: `http://${shownHost}:${realPort}`,
    host,
    port: realPort,
    core,
    generatedToken,
    async close() {
      core.runner.stop();
      await app.close();
      core.close();
    },
  };
}
