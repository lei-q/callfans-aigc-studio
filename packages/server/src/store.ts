import type {
  Snapshot,
  StoredAnnot,
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
  runtime: { tokenHash?: string };
}

export interface StoredApiKey extends ApiKey {
  hash: string;
}

export const DEFAULT_ACCOUNT: AccountConfig = {
  provider: (process.env.AIGC_ACCOUNT_PROVIDER === 'mock' ? 'mock' : 'fastsso') as AccountProvider,
  issuer: process.env.AIGC_SSO_ISSUER || 'https://sso.callfansai.com/realms/consumer',
  enterpriseIssuer: process.env.AIGC_SSO_ENTERPRISE_ISSUER || '',
  apiBase: process.env.AIGC_ACCOUNT_API || 'https://account.callfansai.com/api/v1',
  gatewayBase: process.env.AIGC_GATEWAY_URL || 'https://api.callfansai.com',
  clientId: process.env.AIGC_SSO_CLIENT_ID || 'aigc-callfans',
  enterpriseClientId: process.env.AIGC_SSO_ENTERPRISE_CLIENT_ID || '',
  redirectUri: process.env.AIGC_SSO_REDIRECT || 'http://127.0.0.1:5781/auth/callback',
};

export const DEFAULT_SETTINGS: SettingsInternal = {
  account: DEFAULT_ACCOUNT,
  cloud: { baseUrl: process.env.AIGC_CLOUD_URL || '' },
  runner: { concurrency: 2 },
  direct: { enabled: false, baseUrl: TREECLOUD_BASE_URL },
  channel: 'cloud',
  models: { cloud: { text: '', image: '', video: '', audio: '' }, direct: { text: '', image: '', video: '', audio: '' } },
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
  readonly snapshots: Collection<Snapshot>;

  constructor(readonly db: Db) {
    this.projects = new Collection(db, 'projects');
    this.jobs = new Collection(db, 'jobs');
    this.results = new Collection(db, 'results');
    this.boards = new Collection(db, 'boards');
    this.aesthetic = new Collection(db, 'aesthetic');
    this.posts = new Collection(db, 'posts');
    this.apiKeys = new Collection(db, 'api_keys');
    this.snapshots = new Collection(db, 'snapshots');
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
      /* 自定义渠道的界面入口已经收起：选着自定义渠道却没有 Key 的，模型目录是空的又切不回来，直接回到平台渠道 */
      channel: s?.channel === 'direct' && s?.direct?.keyEnc ? 'direct' : 'cloud',
      models: {
        cloud: { ...DEFAULT_SETTINGS.models.cloud, ...s?.models?.cloud, ...(s?.models?.cloud?.text ? {} : { text: legacy }) },
        direct: { ...DEFAULT_SETTINGS.models.direct, ...s?.models?.direct },
      },
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
    if (v == null) this.db.kvDel('cloud_session');
    else this.db.kvSet('cloud_session', v);
  }

  /** Fast-SSO 账号会话（加密后的令牌）；null = 未登录 */
  get accountSession(): string | null {
    return this.db.kvGet<string>('account_session');
  }
  set accountSession(v: string | null) {
    if (v == null) this.db.kvDel('account_session');
    else this.db.kvSet('account_session', v);
  }

  /** 平台模型密钥：账号 id → 加密后的 sk-…；只在后端，永不进前端 */
  llmKeyOf(accountId: string): string | null {
    return this.db.kvGet<Record<string, string>>('llm_keys')?.[accountId] || null;
  }
  setLlmKey(accountId: string, enc: string | null, unified = false) {
    const all = { ...(this.db.kvGet<Record<string, string>>('llm_keys') || {}) };
    if (enc) all[accountId] = enc;
    else delete all[accountId];
    this.db.kvSet('llm_keys', all);
    const mark = { ...(this.db.kvGet<Record<string, true>>('llm_keys_unified') || {}) };
    if (enc && unified) mark[accountId] = true;
    else delete mark[accountId];
    this.db.kvSet('llm_keys_unified', mark);
  }
  /** 本机这把 Key 是不是 2026-11-23 之后从统一契约取到的（个人账号的老副本是按应用签发的旧 Key，平台会吊销） */
  llmKeyIsUnified(accountId: string): boolean {
    return !!this.db.kvGet<Record<string, true>>('llm_keys_unified')?.[accountId];
  }

  /** 平台模型健康：网关明确拒绝（没有可用通道）后记一笔，短期内不再把它列成可选 */
  modelHealth(): Record<string, { at: number; reason: string }> {
    return this.db.kvGet<Record<string, { at: number; reason: string }>>('model_health') || {};
  }
  setModelHealth(id: string, v: { at: number; reason: string }) {
    const all = { ...this.modelHealth(), [id]: v };
    this.db.kvSet('model_health', all);
  }
  clearModelHealth(id: string) {
    const all = this.modelHealth();
    if (!all[id]) return;
    delete all[id];
    this.db.kvSet('model_health', all);
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

  /** 批注：项目 → 画布元素 id → 批注列表（整份存 kv，量很小） */
  annotations(): Record<string, Record<string, StoredAnnot[]>> {
    return this.db.kvGet('annotations') || {};
  }
  setAnnotations(ws: string, v: Record<string, StoredAnnot[]>) {
    const all = this.annotations();
    if (Object.keys(v).length) all[ws] = v;
    else delete all[ws];
    this.db.kvSet('annotations', all);
  }

  saveBoard(ws: string, board: Board) {
    this.boards.put({ id: ws, ...board });
  }

  flush() {
    this.db.flush();
  }
}
