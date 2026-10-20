import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';

/* ============================================================================
   本地数据库：sql.js（WASM 版 SQLite），零原生依赖。
   写入后防抖落盘：先写临时文件再 rename，断电也不会留下半个库。
   ========================================================================== */

function wasmPath() {
  const local = path.join(__dirname, 'sql-wasm.wasm');
  if (fs.existsSync(local)) return local;
  return require.resolve('sql.js/dist/sql-wasm.wasm');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  col TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (col, id)
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const SCHEMA_VERSION = 1;

export class Db {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  private constructor(
    private readonly db: Database,
    private readonly file: string | null,
  ) {}

  static async open(file: string | null) {
    const SQL = await initSqlJs({ locateFile: () => wasmPath() });
    let db: Database;
    if (file && fs.existsSync(file)) {
      db = new SQL.Database(fs.readFileSync(file));
    } else {
      db = new SQL.Database();
    }
    db.exec(SCHEMA);
    const inst = new Db(db, file);
    const v = inst.metaGet('schema_version');
    if (!v) inst.metaSet('schema_version', String(SCHEMA_VERSION));
    return inst;
  }

  get isNew() {
    return this.metaGet('seeded') !== '1';
  }

  metaGet(key: string): string | null {
    const st = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    try {
      st.bind([key]);
      return st.step() ? String(st.getAsObject().value) : null;
    } finally {
      st.free();
    }
  }

  metaSet(key: string, value: string) {
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
    this.touch();
  }

  all<T>(col: string): T[] {
    const st = this.db.prepare('SELECT data FROM docs WHERE col = ? ORDER BY updated ASC');
    const out: T[] = [];
    try {
      st.bind([col]);
      while (st.step()) out.push(JSON.parse(String(st.getAsObject().data)) as T);
    } finally {
      st.free();
    }
    return out;
  }

  put(col: string, id: string, data: unknown) {
    this.db.run(
      'INSERT INTO docs (col, id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data, updated = excluded.updated',
      [col, id, JSON.stringify(data), Date.now()],
    );
    this.touch();
  }

  del(col: string, id: string) {
    this.db.run('DELETE FROM docs WHERE col = ? AND id = ?', [col, id]);
    this.touch();
  }

  kvGet<T>(key: string): T | null {
    const st = this.db.prepare('SELECT value FROM kv WHERE key = ?');
    try {
      st.bind([key]);
      return st.step() ? (JSON.parse(String(st.getAsObject().value)) as T) : null;
    } finally {
      st.free();
    }
  }

  kvSet(key: string, value: unknown) {
    this.db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
    this.touch();
  }

  private touch() {
    this.dirty = true;
    if (!this.file) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  /** 立即落盘（退出前调用） */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.file || !this.dirty) return;
    const data = this.db.export();
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  close() {
    this.flush();
    this.db.close();
  }
}
