/**
 * Database access layer — layered storage.
 *
 *   structure.db        one global file with:
 *                       - sites
 *                       - nodes (recursive tree: forum / sub_forum / board)
 *                       - fetch_log (API call audit)
 *
 *   forums/<key>.db     one file per top-level forum, with:
 *                       - threads (incl. is_pinned flag)
 *                       - posts (linked to threads via thread_id)
 *                       - board_crawl_state (per-board incremental progress)
 *                       - daily_traffic (per-board daily snapshots)
 *
 * Forum dbs are opened lazily on first reference via `getForumDb(dbFile)`.
 * The path stored in structure.db's `nodes.db_file` is the source of truth
 * for "which forum lives in which file".
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseError } from '../core/errors';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  affectedRows?: number | undefined;
}

export interface TxClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  transaction<R>(fn: (tx: TxClient) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export interface DbConfig {
  dataDir: string;
}

// ---------------------------------------------------------------------------
// Schema constants (idempotent — uses CREATE TABLE IF NOT EXISTS)
// ---------------------------------------------------------------------------

export const STRUCTURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS migrations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sites (
  site_key     TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  base_url     TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id       INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  site_key        TEXT NOT NULL REFERENCES sites(site_key) ON DELETE CASCADE,
  node_key        TEXT NOT NULL,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('forum','sub_forum','board')),
  level           INTEGER NOT NULL,
  db_file         TEXT,
  moderators      TEXT,
  stats           TEXT,
  raw             TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_crawled_at TEXT,
  UNIQUE (site_key, node_key)
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent     ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_site_type  ON nodes(site_key, type);

CREATE TABLE IF NOT EXISTS fetch_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_key    TEXT NOT NULL,
  tool        TEXT NOT NULL,
  args        TEXT NOT NULL,
  status      TEXT NOT NULL,
  error_code  TEXT,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fetch_log_created ON fetch_log(created_at);
`;

export const FORUM_SCHEMA = `
CREATE TABLE IF NOT EXISTS migrations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS threads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  board_node_id   INTEGER NOT NULL,
  url             TEXT NOT NULL,
  title           TEXT NOT NULL,
  author          TEXT,
  posted_at       TEXT,
  last_reply_at   TEXT,
  reply_count     INTEGER,
  view_count      INTEGER,
  raw             TEXT,
  is_pinned       INTEGER NOT NULL DEFAULT 0,
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (url)
);

CREATE INDEX IF NOT EXISTS idx_threads_board        ON threads(board_node_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_board_pinned ON threads(board_node_id, is_pinned, posted_at DESC);

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id     INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  floor         INTEGER NOT NULL,
  author        TEXT NOT NULL,
  posted_at     TEXT,
  content_html  TEXT NOT NULL,
  content_text  TEXT NOT NULL,
  attachments   TEXT,
  raw           TEXT,
  UNIQUE (thread_id, floor)
);

CREATE TABLE IF NOT EXISTS board_crawl_state (
  board_node_id           INTEGER PRIMARY KEY,
  deepest_page_crawled    INTEGER NOT NULL DEFAULT 0,
  latest_thread_posted_at TEXT,
  last_crawled_at         TEXT,
  last_thread_key         TEXT
);

CREATE TABLE IF NOT EXISTS daily_traffic (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  board_node_id INTEGER NOT NULL,
  date          TEXT NOT NULL,
  online        INTEGER,
  today_posts   INTEGER,
  threads       INTEGER,
  posts         INTEGER,
  snapshot_at   TEXT,
  UNIQUE (board_node_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_traffic_date ON daily_traffic(date);
`;

// ---------------------------------------------------------------------------
// SQLiteDb — Promise-shaped wrapper over the synchronous better-sqlite3 driver.
// ---------------------------------------------------------------------------

export class SQLiteDb implements Db {
  private readonly _db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
  }

  /** Idempotent schema application. Called once when the file is first opened. */
  applySchema(schemaSql: string): void {
    this._db.exec(schemaSql);
  }

  /** Synchronous read for setup/migration code (PRAGMA, etc.). */
  rawAll<T = Record<string, unknown>>(sql: string): T[] {
    return this._db.prepare(sql).all() as T[];
  }

  /** Synchronous exec for setup/migration code. */
  rawExec(sql: string): void {
    this._db.exec(sql);
  }

  private convertParams(sql: string, params?: unknown[]): { sql: string; params: Record<string, unknown> } {
    if (!params || params.length === 0) return { sql, params: {} };
    let convertedSql = sql;
    const convertedParams: Record<string, unknown> = {};
    for (let i = 0; i < params.length; i++) {
      convertedSql = convertedSql.replaceAll(`$${i + 1}`, `:${i + 1}`);
      convertedParams[`${i + 1}`] = params[i];
    }
    return { sql: convertedSql, params: convertedParams };
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    try {
      const { sql: convertedSql, params: convertedParams } = this.convertParams(sql, params);
      const stmt = this._db.prepare(convertedSql);
      const trimmed = convertedSql.trim().toUpperCase();
      const isReader = trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');
      if (isReader) {
        const rows = stmt.all(convertedParams) as T[];
        return { rows };
      }
      const result = stmt.run(convertedParams);
      return { rows: [], affectedRows: result.changes };
    } catch (e) {
      throw new DatabaseError(`Query failed: ${sql}`, e);
    }
  }

  async exec(sql: string): Promise<void> {
    try {
      this._db.exec(sql);
    } catch (e) {
      throw new DatabaseError('Exec failed', e);
    }
  }

  async transaction<R>(fn: (tx: TxClient) => Promise<R>): Promise<R> {
    const txClient: TxClient = {
      query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
        this.query<T>(sql, params),
    };
    await this.exec('BEGIN DEFERRED TRANSACTION');
    try {
      const result = await fn(txClient);
      await this.exec('COMMIT');
      return result;
    } catch (e) {
      await this.exec('ROLLBACK');
      throw e;
    }
  }

  async close(): Promise<void> {
    this._db.close();
  }
}

// ---------------------------------------------------------------------------
// Singletons + forum-db pool
// ---------------------------------------------------------------------------

let structureDb_: SQLiteDb | null = null;
let dataDir_: string | null = null;

/** dbFile string → open SQLiteDb. dbFile is whatever `nodes.db_file` stored. */
const forumDbCache = new Map<string, SQLiteDb>();

/**
 * Initialize the structure database. Idempotent — calling twice with the same
 * dataDir returns the existing instance.
 */
export function initDb(config: DbConfig): SQLiteDb {
  if (structureDb_) return structureDb_;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'structure.db');
  structureDb_ = new SQLiteDb(dbPath);
  structureDb_.applySchema(STRUCTURE_SCHEMA);
  dataDir_ = config.dataDir;
  return structureDb_;
}

export function getStructureDb(): SQLiteDb {
  if (!structureDb_) throw new DatabaseError('initDb has not been called');
  return structureDb_;
}

/**
 * Open (or fetch from cache) a forum db at the given relative path. The path
 * comes from structure.db's nodes.db_file column. Schema is applied on first
 * open (idempotent), so this also works for brand-new forum files.
 *
 * Accepts an absolute path too, primarily for tests using ':memory:' or tmp dirs.
 */
export function getForumDb(dbFile: string): SQLiteDb {
  const cached = forumDbCache.get(dbFile);
  if (cached) return cached;

  const abs = path.isAbsolute(dbFile) || dbFile === ':memory:'
    ? dbFile
    : (dataDir_ ?? (() => { throw new DatabaseError('initDb has not been called'); })()) + path.sep + dbFile;
  const normalized = abs === ':memory:' ? abs : path.normalize(abs);

  const db = new SQLiteDb(normalized);
  db.applySchema(FORUM_SCHEMA);
  ensureDailyTrafficColumns(db);
  forumDbCache.set(dbFile, db);
  return db;
}

/**
 * Idempotent ALTER for forum dbs created before snapshot_at existed.
 * SQLite has no "ADD COLUMN IF NOT EXISTS", so we inspect table_info first.
 */
function ensureDailyTrafficColumns(db: SQLiteDb): void {
  const cols = db.rawAll<{ name: string }>(`PRAGMA table_info(daily_traffic)`);
  if (!cols.some((c) => c.name === 'snapshot_at')) {
    db.rawExec(`ALTER TABLE daily_traffic ADD COLUMN snapshot_at TEXT`);
  }
}

/** Closes all open dbs and resets singletons. Idempotent. */
export async function closeAllDbs(): Promise<void> {
  for (const [, db] of forumDbCache) {
    try { await db.close(); } catch { /* best effort */ }
  }
  forumDbCache.clear();
  if (structureDb_) {
    try { await structureDb_.close(); } catch { /* best effort */ }
    structureDb_ = null;
  }
  dataDir_ = null;
}

/** Test-only — resets state without closing. Production code should not call this. */
export function _resetForTests(): void {
  structureDb_ = null;
  dataDir_ = null;
  forumDbCache.clear();
}

// ---------------------------------------------------------------------------
// Deprecated aliases — kept so the upcoming migration commit doesn't break in
// the middle. Will be removed once all callers are off the old API.
// ---------------------------------------------------------------------------

/** @deprecated Use initDb instead. */
export function initDbs(config: DbConfig): { structureDb: Db } {
  return { structureDb: initDb(config) };
}

/** @deprecated Use closeAllDbs instead. */
export async function closeDbs(): Promise<void> {
  await closeAllDbs();
}
