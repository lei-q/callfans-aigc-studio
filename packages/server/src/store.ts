import type {
  AccountConfig,
  AccountProvider,
  AestheticItem,
  ApiKey,
  Board,
  ChannelId,
  GatewayModel,
  Job,
  ModelInfo,
  ModelPicks,
  Post,
  Project,
  Result,
} from '@aigc/shared';
import { TREECLOUD_BASE_URL } from '@aigc/shared';
import type { Db } from './db';

/* ============================================================================
   仓储：单进程、单用户，所以内存里放一份全量，写入时同步落库。
   点数钱包的权威在云端，本地只存会话 token（加密）与展示缓存。
   ========================================================================== */

export class Collection<T extends { id: string }> {
  private map = new Map<string, T>();

  constructor(
    private readonly db: Db,
    private readonly name: string,
  ) {
    for (const d of db.all<T>(name)) this.map.set(d.id, d);
  }

  get(id: string | null | undefined) {
    return id ? this.map.get(id) : undefined;
  }

  all() {
    return [...this.map.values()];
  }

  put(doc: T) {
    this.map.set(doc.id, doc);
    this.db.put(this.name, doc.id, doc);
    return doc;
  }

  del(id: string) {
    this.map.delete(id);
    this.db.del(this.name, id);
  }

  get size() {
    return this.map.size;
  }
}

export interface StoredBoard extends Board {
  id: string;
}

export interface SettingsInternal {
  account: AccountConfig;
  cloud: { baseUrl: string };
  runner: { concurrency: number };
  direct: {
    enabled: boolean;
    baseUrl: string;
    keyEnc?: string;
    keyHint?: string;
    lastCheck?: { ok: boolean; at: number; message: string };
  };
  channel: ChannelId;
  models: Record<ChannelId, ModelPicks>;
  prices: Record<string, number>;
  runtime: { tokenHash?: string };
}

export interface StoredApiKey extends ApiKey {
  hash: string;
}

export const DEFAULT_ACCOUNT: AccountConfig = {
  provider: (process.env.AIGC_ACCOUNT_PROVIDER === 'mock' ? 'mock' : 'fastsso') as AccountProvider,
  issuer: process.env.AIGC_SSO_ISSUER || 'https://sso.callfansai.com/realms/consumer',
  apiBase: process.env.AIGC_ACCOUNT_API || 'https://account.callfansai.com/api/v1',
  gatewayBase: process.env.AIGC_GATEWAY_URL || 'https://api.callfansai.com',
  clientId: process.env.AIGC_SSO_CLIENT_ID || 'aigc-callfans',
  redirectUri: process.env.AIGC_SSO_REDIRECT || 'http://127.0.0.1:5781/auth/callback',
};

export const DEFAULT_SETTINGS: SettingsInternal = {
  account: DEFAULT_ACCOUNT,
  cloud: { baseUrl: process.env.AIGC_CLOUD_URL || '' },
  runner: { concurrency: 2 },
  direct: { enabled: false, baseUrl: TREECLOUD_BASE_URL },
  channel: 'cloud',
  models: { cloud: { text: '', image: '', video: '', audio: '' }, direct: { text: '', image: '', video: '', audio: '' } },
  prices: {},
  runtime: {},
};

export class Store {
  readonly projects: Collection<Project>;
  readonly jobs: Collection<Job>;
  readonly results: Collection<Result>;
  readonly boards: Collection<StoredBoard>;
  readonly aesthetic: Collection<AestheticItem>;
  readonly posts: Collection<Post>;
  readonly apiKeys: Collection<StoredApiKey>;

  constructor(readonly db: Db) {
    this.projects = new Collection(db, 'projects');
    this.jobs = new Collection(db, 'jobs');
    this.results = new Collection(db, 'results');
    this.boards = new Collection(db, 'boards');
    this.aesthetic = new Collection(db, 'aesthetic');
    this.posts = new Collection(db, 'posts');
    this.apiKeys = new Collection(db, 'api_keys');
  }

  get settings(): SettingsInternal {
    const s = this.db.kvGet<SettingsInternal>('settings');
    const legacy = (s as { platform?: { chatModel?: string } } | undefined)?.platform?.chatModel || '';
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      account: { ...DEFAULT_SETTINGS.account, ...s?.account },
      cloud: { ...DEFAULT_SETTINGS.cloud, ...s?.cloud },
      runner: { ...DEFAULT_SETTINGS.runner, ...s?.runner },
      direct: { ...DEFAULT_SETTINGS.direct, ...s?.direct },
      channel: s?.channel === 'direct' ? 'direct' : 'cloud',
      models: {
        cloud: { ...DEFAULT_SETTINGS.models.cloud, ...s?.models?.cloud, ...(s?.models?.cloud?.text ? {} : { text: legacy }) },
        direct: { ...DEFAULT_SETTINGS.models.direct, ...s?.models?.direct },
      },
      prices: { ...s?.prices },
      runtime: { ...s?.runtime },
    };
  }
  set settings(s: SettingsInternal) {
    this.db.kvSet('settings', s);
  }

  /** 云端会话的 refresh token（加密串）；null = 未登录 */
  get cloudSession(): string | null {
    return this.db.kvGet<string>('cloud_session');
  }
  set cloudSession(v: string | null) {
    if (v == null) this.db.del('kv', 'cloud_session');
    else this.db.kvSet('cloud_session', v);
  }

  /** Fast-SSO 账号会话（加密后的令牌）；null = 未登录 */
  get accountSession(): string | null {
    return this.db.kvGet<string>('account_session');
  }
  set accountSession(v: string | null) {
    if (v == null) this.db.del('kv', 'account_session');
    else this.db.kvSet('account_session', v);
  }

  /** 平台模型密钥：账号 id → 加密后的 sk-…；只在后端，永不进前端 */
  llmKeyOf(accountId: string): string | null {
    return this.db.kvGet<Record<string, string>>('llm_keys')?.[accountId] || null;
  }
  setLlmKey(accountId: string, enc: string | null) {
    const all = { ...(this.db.kvGet<Record<string, string>>('llm_keys') || {}) };
    if (enc) all[accountId] = enc;
    else delete all[accountId];
    this.db.kvSet('llm_keys', all);
  }

  /** 设备指纹：注册 / 签到风控用，只在本机生成一次 */
  get deviceFingerprint(): string {
    let fp = this.db.kvGet<string>('device_fp');
    if (!fp) {
      fp = `aigc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      this.db.kvSet('device_fp', fp);
    }
    return fp;
  }

  get ui(): Record<string, unknown> {
    return this.db.kvGet<Record<string, unknown>>('ui') || {};
  }
  set ui(u: Record<string, unknown>) {
    this.db.kvSet('ui', u);
  }

  /** 直连渠道的模型目录缓存 */
  get directModels(): { models: ModelInfo[]; chat: string[]; at: number } {
    return this.db.kvGet('direct_models') || { models: [], chat: [], at: 0 };
  }
  set directModels(v: { models: ModelInfo[]; chat: string[]; at: number }) {
    this.db.kvSet('direct_models', v);
  }

  /** 云端模型目录缓存（会话内存里也有一份，这里用于重启后展示） */
  get cloudModelsCache(): GatewayModel[] {
    return this.db.kvGet<GatewayModel[]>('cloud_models') || [];
  }
  set cloudModelsCache(v: GatewayModel[]) {
    this.db.kvSet('cloud_models', v);
  }

  board(ws: string): Board {
    const b = this.boards.get(ws);
    if (b) {
      const { id: _id, ...rest } = b;
      return { ...rest, anchor: rest.anchor ?? null };
    }
    return { items: [], links: [], view: { x: 40, y: 40, k: 1 }, anchor: null };
  }

  saveBoard(ws: string, board: Board) {
    this.boards.put({ id: ws, ...board });
  }

  flush() {
    this.db.flush();
  }
}
