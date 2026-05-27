/**
 * Database access layer — layered storage, board-level files.
 *
 *   structure.db                              global index:
 *                                               - sites
 *                                               - nodes (recursive tree: forum / sub_forum / board)
 *                                               - fetch_log (API call audit)
 *
 *   forums/<forum_key>/.../<board_key>.db     one file per board, with:
 *                                               - threads (with is_pinned column)
 *                                               - posts
 *                                               - board_crawl_state (single row)
 *                                               - daily_traffic
 *
 * The directory chain mirrors the structure.db node tree: each forum / sub_forum
 * is a directory, each board is a `.db` leaf. All path components use ASCII
 * `node_key` (URL-derived), so filesystems don't have to deal with CJK names.
 *
 * The path stored in `structure.db`'s `nodes.db_path` (board rows only) is the
 * source of truth. Board dbs are opened lazily via `getBoardDb(dbPath)`.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseError } from '../errors.js';
import { STRUCTURE_SCHEMA, BOARD_SCHEMA } from './schema.js';

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
// Re-export schema constants (now defined in schema.ts)
// ---------------------------------------------------------------------------

export { STRUCTURE_SCHEMA, BOARD_SCHEMA } from './schema.js';

// ---------------------------------------------------------------------------
// SQLiteDb — Promise-shaped wrapper over the synchronous better-sqlite3 driver.
// ---------------------------------------------------------------------------

export class SQLiteDb implements Db {
  private readonly _db: Database.Database;
  private readonly _dbPath: string;
  private _closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this._dbPath = dbPath;
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    // Absorb any leftover -wal from a previous hard-kill so the file is empty
    // by the time we start writing. The sidecar files themselves can only be
    // removed on a clean close (see closeSync below).
    if (dbPath !== ':memory:') {
      try { this._db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    }
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
    this.closeSync();
  }

  /**
   * Synchronous close — safe to call from signal handlers where awaiting a
   * Promise wouldn't run before process exit.
   */
  closeSync(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      if (this._dbPath !== ':memory:' && this._db.open) {
        try { this._db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
        try { this._db.pragma('journal_mode = DELETE'); } catch { /* best effort */ }
      }
    } finally {
      try { this._db.close(); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Singletons + board-db pool
// ---------------------------------------------------------------------------

let structureDb_: SQLiteDb | null = null;
let dataDir_: string | null = null;

/** dbPath string (relative, as stored in nodes.db_path) → open SQLiteDb. */
const boardDbCache = new Map<string, SQLiteDb>();

/**
 * Initialize the structure database. Idempotent.
 */
export function initDb(config: DbConfig): SQLiteDb {
  if (structureDb_) return structureDb_;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'structure.db');
  structureDb_ = new SQLiteDb(dbPath);
  structureDb_.applySchema(STRUCTURE_SCHEMA);
  dataDir_ = config.dataDir;
  registerExitHandlers();
  return structureDb_;
}

// ---------------------------------------------------------------------------
// Process-level cleanup — close dbs on Ctrl+C / SIGTERM / unhandled errors so
// SQLite's -wal/-shm sidecar files don't get left behind.
// ---------------------------------------------------------------------------

let exitHandlersRegistered = false;

function closeAllDbsSync(): void {
  for (const [, db] of boardDbCache) {
    try { db.closeSync(); } catch { /* best effort */ }
  }
  boardDbCache.clear();
  if (structureDb_) {
    try { structureDb_.closeSync(); } catch { /* best effort */ }
    structureDb_ = null;
  }
  dataDir_ = null;
}

function registerExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  const onSignal = (signal: NodeJS.Signals): void => {
    closeAllDbsSync();
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('exit', closeAllDbsSync);
}

export function getStructureDb(): SQLiteDb {
  if (!structureDb_) throw new DatabaseError('initDb has not been called');
  return structureDb_;
}

/**
 * Get the current data directory. Throws if initDb hasn't been called.
 */
export function getDataDir(): string {
  if (!dataDir_) throw new DatabaseError('initDb has not been called');
  return dataDir_;
}

/**
 * Open (or fetch from cache) a board db at the given relative path. The path
 * comes from structure.db's nodes.db_path column (e.g. `forums/Campus/IWisper.db`).
 * Schema is applied on first open (idempotent), so this also works for
 * brand-new board files.
 *
 * Accepts absolute paths or ':memory:' for tests.
 */
export function getBoardDb(dbPath: string): SQLiteDb {
  const cached = boardDbCache.get(dbPath);
  if (cached) return cached;

  const abs = path.isAbsolute(dbPath) || dbPath === ':memory:'
    ? dbPath
    : (dataDir_ ?? (() => { throw new DatabaseError('initDb has not been called'); })()) + path.sep + dbPath;
  const normalized = abs === ':memory:' ? abs : path.normalize(abs);

  const db = new SQLiteDb(normalized);
  db.applySchema(BOARD_SCHEMA);
  boardDbCache.set(dbPath, db);
  return db;
}

/** Closes all open dbs and resets singletons. Idempotent. */
export async function closeAllDbs(): Promise<void> {
  closeAllDbsSync();
}

/** Test-only — resets state without closing. Production code should not call this. */
export function _resetForTests(): void {
  structureDb_ = null;
  dataDir_ = null;
  boardDbCache.clear();
}
