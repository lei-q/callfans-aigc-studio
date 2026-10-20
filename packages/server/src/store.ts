import type {
  AestheticItem,
  ApiKey,
  ApiUsage,
  Board,
  Job,
  ModelInfo,
  Post,
  Project,
  ProviderId,
  Result,
  Wallet,
} from '@aigc/shared';
import { DEFAULT_DAILY_FREE, dayKey, TREECLOUD_BASE_URL } from '@aigc/shared';
import type { Db } from './db';

/* ============================================================================
   仓储：单进程、单用户，所以内存里放一份全量，写入时同步落库。
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
  provider: {
    active: ProviderId;
    concurrency: number;
    treecloud: {
      baseUrl: string;
      keyEnc?: string;
      keyHint?: string;
      lastCheck?: { ok: boolean; at: number; message: string };
    };
  };
  chat: { enabled: boolean; model: string };
  prices: Record<string, number>;
  runtime: { tokenHash?: string };
}

export interface StoredApiKey extends ApiKey {
  hash: string;
}

export const DEFAULT_SETTINGS: SettingsInternal = {
  provider: { active: 'mock', concurrency: 2, treecloud: { baseUrl: TREECLOUD_BASE_URL } },
  chat: { enabled: false, model: '' },
  prices: {},
  runtime: {},
};

export const defaultWallet = (): Wallet => ({
  balance: 10,
  spent: { image: 0, video: 0, audio: 0 },
  dailyFree: DEFAULT_DAILY_FREE,
  dailyUsed: 0,
  dailyDate: dayKey(Date.now()),
  firstTopupDone: false,
});

export class Store {
  readonly projects: Collection<Project>;
  readonly jobs: Collection<Job>;
  readonly results: Collection<Result>;
  readonly boards: Collection<StoredBoard>;
  readonly aesthetic: Collection<AestheticItem>;
  readonly posts: Collection<Post>;
  readonly apiKeys: Collection<StoredApiKey>;
  readonly apiUsage: Collection<ApiUsage>;

  constructor(readonly db: Db) {
    this.projects = new Collection(db, 'projects');
    this.jobs = new Collection(db, 'jobs');
    this.results = new Collection(db, 'results');
    this.boards = new Collection(db, 'boards');
    this.aesthetic = new Collection(db, 'aesthetic');
    this.posts = new Collection(db, 'posts');
    this.apiKeys = new Collection(db, 'api_keys');
    this.apiUsage = new Collection(db, 'api_usage');
  }

  get wallet(): Wallet {
    return this.db.kvGet<Wallet>('wallet') || defaultWallet();
  }
  set wallet(w: Wallet) {
    this.db.kvSet('wallet', w);
  }

  get settings(): SettingsInternal {
    const s = this.db.kvGet<SettingsInternal>('settings');
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      provider: {
        ...DEFAULT_SETTINGS.provider,
        ...s?.provider,
        treecloud: { ...DEFAULT_SETTINGS.provider.treecloud, ...s?.provider?.treecloud },
      },
      chat: { ...DEFAULT_SETTINGS.chat, ...s?.chat },
      prices: { ...s?.prices },
      runtime: { ...s?.runtime },
    };
  }
  set settings(s: SettingsInternal) {
    this.db.kvSet('settings', s);
  }

  get ui(): Record<string, unknown> {
    return this.db.kvGet<Record<string, unknown>>('ui') || {};
  }
  set ui(u: Record<string, unknown>) {
    this.db.kvSet('ui', u);
  }

  get treecloudModels(): { models: ModelInfo[]; chat: string[]; at: number } {
    return this.db.kvGet('tc_models') || { models: [], chat: [], at: 0 };
  }
  set treecloudModels(v: { models: ModelInfo[]; chat: string[]; at: number }) {
    this.db.kvSet('tc_models', v);
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
