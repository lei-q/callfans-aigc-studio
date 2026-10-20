import fs from 'node:fs';
import path from 'node:path';
import type { AppInfo, Bootstrap, Channel, ModelInfo, RunMode, Settings } from '@aigc/shared';
import { DEFAULT_PORT, ensureDaily, uid } from '@aigc/shared';
import { Db } from './db';
import { EventHub } from './events';
import { MockProvider } from './providers/mock';
import { TreeCloudProvider } from './providers/treecloud';
import type { Provider } from './providers/types';
import { JobRunner } from './runner';
import { Secrets } from './secrets';
import { seedDemo, seedEmpty } from './seed';
import { Store } from './store';

export interface CoreOptions {
  dataDir: string;
  samplesDir: string;
  webDir?: string;
  mode: RunMode;
  desktop: boolean;
  version: string;
  /** 首次启动写入示例数据 */
  seed?: boolean;
  /** 测试用：演示渠道的节拍 */
  mockTickMs?: number;
  /** 测试用：不落盘 */
  memory?: boolean;
  treecloudPollMs?: number;
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
  readonly mock: MockProvider;
  readonly treecloud: TreeCloudProvider;
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
    this.mock = new MockProvider(() => this.store.settings.prices, opts.mockTickMs ?? 700);
    this.treecloud = new TreeCloudProvider(
      () => {
        const s = this.store.settings;
        return {
          baseUrl: s.provider.treecloud.baseUrl,
          apiKey: this.secrets.decrypt(s.provider.treecloud.keyEnc),
          concurrency: s.provider.concurrency,
          prices: s.prices,
          pollMs: opts.treecloudPollMs,
        };
      },
      () => this.store.treecloudModels,
    );
    this.runner = new JobRunner(this);
  }

  static async create(opts: CoreOptions) {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    const db = await Db.open(opts.memory ? null : path.join(opts.dataDir, 'db.sqlite'));
    const core = new Core(db, opts);
    if (db.isNew) {
      if (opts.seed !== false) seedDemo(core.store);
      else seedEmpty(core.store);
      db.metaSet('seeded', '1');
      db.metaSet('installed_at', String(Date.now()));
    }
    const w = core.store.wallet;
    ensureDaily(w);
    core.store.wallet = w;
    return core;
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
    return [this.mock, this.treecloud];
  }

  models(): ModelInfo[] {
    return [...this.mock.models(), ...this.treecloud.models()];
  }

  modelById(id: string) {
    return this.models().find((m) => m.id === id);
  }

  providerOf(model: ModelInfo): Provider {
    return model.channel === 'treecloud' ? this.treecloud : this.mock;
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
      provider: {
        active: s.provider.active,
        concurrency: s.provider.concurrency,
        treecloud: {
          baseUrl: s.provider.treecloud.baseUrl,
          hasKey: !!s.provider.treecloud.keyEnc,
          keyHint: s.provider.treecloud.keyHint,
          lastCheck: s.provider.treecloud.lastCheck,
        },
      },
      chat: { enabled: s.chat.enabled, model: s.chat.model, available: this.store.treecloudModels.chat },
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
    const w = s.wallet;
    ensureDaily(w);
    const boards: Bootstrap['boards'] = {};
    for (const p of s.projects.all()) boards[p.id] = s.board(p.id);
    return {
      app: this.appInfo(),
      projects: s.projects.all().sort((a, b) => a.createdAt - b.createdAt),
      jobs: s.jobs.all().sort((a, b) => b.createdAt - a.createdAt),
      results: s.results.all().sort((a, b) => b.createdAt - a.createdAt),
      wallet: w,
      boards,
      aesthetic: s.aesthetic.all().sort((a, b) => b.createdAt - a.createdAt),
      posts: s.posts.all().sort((a, b) => b.updatedAt - a.updatedAt),
      models: this.models(),
      channels: this.channels(),
      settings: this.publicSettings(),
      apiKeys: s.apiKeys.all().map(({ hash: _h, ...k }) => k),
      apiUsage: s.apiUsage.all().sort((a, b) => b.at - a.at).slice(0, 200),
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

  /** 本机 URL 路径 → 磁盘路径（只认三个目录，防目录穿越） */
  localPathOf(src: string): string | null {
    const clean = decodeURIComponent(src.split('?')[0].split('#')[0]);
    const m = /^\/(files\/media|files\/uploads|samples)\/(.+)$/.exec(clean);
    if (!m) return null;
    const rel = path.normalize(m[2]).replace(/^(\.\.[/\\])+/, '');
    const root = m[1] === 'files/media' ? this.mediaDir : m[1] === 'files/uploads' ? this.uploadsDir : this.opts.samplesDir;
    const base = path.resolve(root);
    const full = path.resolve(base, rel);
    if (!full.startsWith(base + path.sep)) return null;
    return full;
  }

  async resolveRef(src: string): Promise<{ dataUrl: string; mime: string } | null> {
    if (src.startsWith('data:')) {
      const mime = /^data:([^;,]+)/.exec(src)?.[1] || 'application/octet-stream';
      return { dataUrl: src, mime };
    }
    if (/^https:\/\//i.test(src)) {
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
    this.store.flush();
    this.db.close();
  }
}
