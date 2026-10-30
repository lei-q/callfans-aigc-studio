import fs from 'node:fs';
import path from 'node:path';
import type { AppInfo, Bootstrap, Channel, ModelInfo, RunMode, SessionInfo, Settings } from '@aigc/shared';
import { DEFAULT_PORT, uid } from '@aigc/shared';
import { AccountSession } from './account/session';
import { PlatformCatalog } from './account/platform';
import { CloudSession } from './cloud/session';
import { Db } from './db';
import { EventHub } from './events';
import { CloudProvider, gatewayModelToModelInfo } from './providers/cloud';
import { TreeCloudProvider } from './providers/treecloud';
import type { Provider } from './providers/types';
import { JobRunner } from './runner';
import { Secrets } from './secrets';
import { seedClean } from './seed';
import { Store } from './store';

export interface CoreOptions {
  dataDir: string;
  webDir?: string;
  mode: RunMode;
  desktop: boolean;
  version: string;
  /** 测试用：不落盘 */
  memory?: boolean;
  cloudPollMs?: number;
  directPollMs?: number;
  /** 测试 / 开发：覆盖账号服务地址与提供方 */
  account?: Partial<import('@aigc/shared').AccountConfig>;
}

/** 运行模式：桌面 / Web、端口、是否允许局域网访问。Electron 启动前就要读，所以单独存成文件 */
export interface LaunchConfig {
  mode?: RunMode;
  host?: string;
  port?: number;
  lan?: boolean;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
};
const EXT_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));
EXT_MIME.jpeg = 'image/jpeg';
export const extOfMime = (mime: string) => MIME_EXT[mime.split(';')[0].trim()] || 'bin';
export const mimeOfExt = (ext: string) => EXT_MIME[ext.toLowerCase().replace(/^\./, '')] || 'application/octet-stream';

export class Core {
  readonly store: Store;
  readonly secrets: Secrets;
  readonly events = new EventHub();
  /** Fast-SSO 账号会话（登录 / 注册 / 积分 / 充值） */
  readonly accounts: AccountSession;
  /** 平台模型网关的模型清单（免令牌，运行时拉取并缓存） */
  readonly platform: PlatformCatalog;
  /** 开发用 Mock 云的设备码会话；生产模式下只作为可选的生成网关客户端 */
  readonly session: CloudSession;
  readonly cloud: CloudProvider;
  readonly direct: TreeCloudProvider;
  readonly runner: JobRunner;
  readonly mediaDir: string;
  readonly uploadsDir: string;

  private constructor(
    readonly db: Db,
    readonly opts: CoreOptions,
  ) {
    this.store = new Store(db);
    this.secrets = new Secrets(opts.dataDir);
    this.mediaDir = path.join(opts.dataDir, 'media');
    this.uploadsDir = path.join(opts.dataDir, 'uploads');
    fs.mkdirSync(this.mediaDir, { recursive: true });
    fs.mkdirSync(this.uploadsDir, { recursive: true });

    this.accounts = new AccountSession(this.store, this.secrets, this.events, () => this.store.settings.account);
    this.platform = new PlatformCatalog(() => this.store.settings.account);
    this.session = new CloudSession(this.store, this.secrets, this.events, () => this.store.settings.cloud.baseUrl);
    this.cloud = new CloudProvider(
      () => this.session,
      () => this.store.settings.prices,
      () => this.store.settings.runner.concurrency,
      opts.cloudPollMs,
    );
    this.direct = new TreeCloudProvider(
      () => {
        const s = this.store.settings;
        return {
          baseUrl: s.direct.baseUrl,
          apiKey: this.secrets.decrypt(s.direct.keyEnc),
          concurrency: s.runner.concurrency,
          prices: s.prices,
          pollMs: opts.directPollMs,
        };
      },
      () => this.store.directModels,
    );
    this.runner = new JobRunner(this);
  }

  static async create(opts: CoreOptions) {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    const db = await Db.open(opts.memory ? null : path.join(opts.dataDir, 'db.sqlite'));
    const core = new Core(db, opts);
    if (db.isNew) {
      seedClean(core.store);
      db.metaSet('seeded', '1');
      db.metaSet('installed_at', String(Date.now()));
    }
    if (opts.account) {
      core.store.settings = { ...core.store.settings, account: { ...core.store.settings.account, ...opts.account } };
    }
    if (core.provider === 'mock') await core.session.restore();
    else await core.accounts.restore();
    return core;
  }

  /** 账号服务提供方：fastsso（生产）或 mock（开发 / CI） */
  get provider() {
    return this.store.settings.account.provider;
  }

  /** 当前生效的账号会话：两套实现对登录 / 钱包 / 资料的方法签名保持一致 */
  get account(): CloudSession | AccountSession {
    return this.provider === 'mock' ? this.session : this.accounts;
  }

  get loggedIn() {
    return this.account.loggedIn;
  }

  /* ---------------- 运行配置 ---------------- */

  get launchFile() {
    return path.join(this.opts.dataDir, 'launch-mode.json');
  }

  readLaunch(): LaunchConfig {
    try {
      return JSON.parse(fs.readFileSync(this.launchFile, 'utf8')) as LaunchConfig;
    } catch {
      return {};
    }
  }

  writeLaunch(patch: LaunchConfig) {
    const next = { ...this.readLaunch(), ...patch };
    fs.writeFileSync(this.launchFile, JSON.stringify(next, null, 2));
    return next;
  }

  /* ---------------- 模型与渠道 ---------------- */

  providers(): Provider[] {
    /* 平台生成网关尚未接入时（Fast-SSO 只提供账号与充值），只保留直连渠道 */
    return this.provider === 'mock' ? [this.cloud, this.direct] : [this.direct];
  }

  models(): ModelInfo[] {
    const prices = this.store.settings.prices;
    if (this.provider !== 'mock') return this.direct.models();
    const cloudCached = this.session.loggedIn ? this.session.models : this.store.cloudModelsCache;
    return [...cloudCached.map((g) => gatewayModelToModelInfo(g, prices[`cloud:${g.id}`])), ...this.direct.models()];
  }

  modelById(id: string) {
    return this.models().find((m) => m.id === id);
  }

  providerOf(model: ModelInfo): Provider {
    return model.channel === 'direct' ? this.direct : this.cloud;
  }

  /** 模型所属渠道当前是否可用：云端要登录，直连要启用且配了 Key */
  routeError(model: ModelInfo): string | null {
    if (model.channel === 'direct') {
      const d = this.store.settings.direct;
      if (!d.enabled) return '直连模式没有启用：到「设置 · 直连 TreeCloud」里启用';
      if (!d.keyEnc) return '直连模式还没有配置 Key：到「设置 · 直连 TreeCloud」里填入你自己的 Key';
      return null;
    }
    if (this.provider !== 'mock') return '平台生成网关还没有接入：当前版本请到「设置 · 直连」填自己的 TreeCloud Key 生成';
    if (!this.session.loggedIn) return '还没有登录账号：登录后才能用平台点数生成；也可以在「设置」里启用直连模式';
    return null;
  }

  channels(): Channel[] {
    return this.providers().map((p) => p.channel());
  }

  emitModels() {
    this.events.emit({ type: 'models', models: this.models(), channels: this.channels() });
  }

  /* ---------------- 设置 ---------------- */

  publicSettings(): Settings {
    const s = this.store.settings;
    const launch = this.readLaunch();
    return {
      account: { ...s.account },
      cloud: { baseUrl: s.cloud.baseUrl },
      runner: { concurrency: s.runner.concurrency },
      direct: {
        enabled: s.direct.enabled,
        baseUrl: s.direct.baseUrl,
        hasKey: !!s.direct.keyEnc,
        keyHint: s.direct.keyHint,
        lastCheck: s.direct.lastCheck,
      },
      prices: s.prices,
      runtime: {
        mode: launch.mode || this.opts.mode,
        host: launch.host || '127.0.0.1',
        port: launch.port || DEFAULT_PORT,
        lan: !!launch.lan,
        hasToken: !!s.runtime.tokenHash,
      },
    };
  }

  sessionInfo(): SessionInfo {
    return this.account.info();
  }

  appInfo(): AppInfo {
    return {
      version: this.opts.version,
      mode: this.opts.mode,
      dataDir: this.opts.dataDir,
      platform: process.platform,
      desktop: this.opts.desktop,
    };
  }

  bootstrap(): Bootstrap {
    const s = this.store;
    const boards: Bootstrap['boards'] = {};
    for (const p of s.projects.all()) boards[p.id] = s.board(p.id);
    return {
      app: this.appInfo(),
      projects: s.projects.all().sort((a, b) => a.createdAt - b.createdAt),
      jobs: s.jobs.all().sort((a, b) => b.createdAt - a.createdAt),
      results: s.results.all().sort((a, b) => b.createdAt - a.createdAt),
      wallet: this.account.wallet,
      session: this.sessionInfo(),
      boards,
      aesthetic: s.aesthetic.all().sort((a, b) => b.createdAt - a.createdAt),
      posts: s.posts.all().sort((a, b) => b.updatedAt - a.updatedAt),
      models: this.models(),
      channels: this.channels(),
      settings: this.publicSettings(),
      apiKeys: s.apiKeys.all().map(({ hash: _h, ...k }) => k),
      ui: s.ui,
    };
  }

  /* ---------------- 文件 ---------------- */

  async saveMedia(buf: Buffer, mime: string, dir: 'media' | 'uploads' = 'media') {
    const clean = mime.split(';')[0].trim();
    const name = `${uid(dir === 'media' ? 'm' : 'u')}.${extOfMime(clean)}`;
    await fs.promises.writeFile(path.join(dir === 'media' ? this.mediaDir : this.uploadsDir, name), buf);
    return { src: `/files/${dir}/${name}`, mime: clean };
  }

  /** 本机 URL 路径 → 磁盘路径（只认两个目录，防目录穿越） */
  localPathOf(src: string): string | null {
    const clean = decodeURIComponent(src.split('?')[0].split('#')[0]);
    const m = /^\/files\/(media|uploads)\/(.+)$/.exec(clean);
    if (!m) return null;
    const rel = path.normalize(m[2]).replace(/^(\.\.[/\\])+/, '');
    const base = path.resolve(m[1] === 'media' ? this.mediaDir : this.uploadsDir);
    const full = path.resolve(base, rel);
    if (!full.startsWith(base + path.sep)) return null;
    return full;
  }

  async resolveRef(src: string): Promise<{ dataUrl: string; mime: string } | null> {
    if (src.startsWith('data:')) {
      const mime = /^data:([^;,]+)/.exec(src)?.[1] || 'application/octet-stream';
      return { dataUrl: src, mime };
    }
    if (/^https?:\/\//i.test(src)) {
      const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(src)?.[1] || 'png';
      return { dataUrl: src, mime: mimeOfExt(ext) };
    }
    const file = this.localPathOf(src);
    if (!file || !fs.existsSync(file)) return null;
    const buf = await fs.promises.readFile(file);
    if (buf.length > 20 * 1024 * 1024) return null;
    const mime = mimeOfExt(path.extname(file));
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime };
  }

  /** 删除产出时顺手删掉只被它引用的生成文件 */
  removeMediaIfOrphan(src: string) {
    if (!src.startsWith('/files/media/')) return;
    const still = this.store.results.all().some((r) => r.src === src || r.thumb === src);
    if (still) return;
    const file = this.localPathOf(src);
    if (file) fs.promises.unlink(file).catch(() => {});
  }

  close() {
    this.runner.stop();
    this.session.stop();
    this.accounts.stop();
    this.store.flush();
    this.db.close();
  }
}
