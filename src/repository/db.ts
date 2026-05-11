/**
 * Database access layer.
 *
 * Two separate SQLite databases:
 *  - structure.db: sites, sections, boards, board_crawl_state
 *  - content.db: threads, posts, fetch_log
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DatabaseError } from '../core/errors';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  affectedRows?: number | undefined;
}

export interface TxClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  /** Run multi-statement DDL/DML. No params; for migrations and similar. */
  exec(sql: string): Promise<void>;
  transaction<R>(fn: (tx: TxClient) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

class SQLiteDb implements Db {
  private db: Database.Database;

  constructor(dataDir: string, dbName: string) {
    // Ensure directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = path.join(dataDir, dbName);
    this.db = new Database(dbPath);
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  private convertParams(sql: string, params?: unknown[]): { sql: string; params: Record<string, unknown> } {
    if (!params || params.length === 0) {
      return { sql, params: {} };
    }

    // Convert $1, $2, ... to :1, :2, ... for better-sqlite3
    let convertedSql = sql;
    const convertedParams: Record<string, unknown> = {};
    for (let i = 0; i < params.length; i++) {
      const placeholder = `$${i + 1}`;
      const namedPlaceholder = `:${i + 1}`;
      convertedSql = convertedSql.replaceAll(placeholder, namedPlaceholder);
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
      const stmt = this.db.prepare(convertedSql);

      // Check if it's a SELECT statement
      const isSelect = convertedSql.trim().toUpperCase().startsWith('SELECT');

      if (isSelect) {
        const rows = stmt.all(convertedParams) as T[];
        return { rows };
      } else {
        const result = stmt.run(convertedParams);
        return {
          rows: [],
          affectedRows: result.changes,
        };
      }
    } catch (e) {
      throw new DatabaseError(`Query failed: ${sql}`, e);
    }
  }

  async exec(sql: string): Promise<void> {
    try {
      this.db.exec(sql);
    } catch (e) {
      throw new DatabaseError(`Exec failed`, e);
    }
  }

  async transaction<R>(fn: (tx: TxClient) => Promise<R>): Promise<R> {
    // For SQLite with async interface, we'll use explicit BEGIN/COMMIT/ROLLBACK
    const txClient: TxClient = {
      query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        return this.query<T>(sql, params);
      }
    };

    // Start transaction
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
    this.db.close();
  }
}

export interface DbConfig {
  dataDir: string;
}

export interface Dbs {
  structureDb: Db;
  contentDb: Db;
}

let structureDbInstance: Db | null = null;
let contentDbInstance: Db | null = null;

/**
 * Initialize both structure and content databases.
 */
export function initDbs(config: DbConfig): Dbs {
  if (!structureDbInstance) {
    structureDbInstance = new SQLiteDb(config.dataDir, 'structure.db');
  }
  if (!contentDbInstance) {
    contentDbInstance = new SQLiteDb(config.dataDir, 'content.db');
  }
  return {
    structureDb: structureDbInstance,
    contentDb: contentDbInstance,
  };
}

/**
 * Get structure database (must call initDbs first).
 */
export function getStructureDb(): Db {
  if (!structureDbInstance) {
    throw new DatabaseError('initDbs has not been called');
  }
  return structureDbInstance;
}

/**
 * Get content database (must call initDbs first).
 */
export function getContentDb(): Db {
  if (!contentDbInstance) {
    throw new DatabaseError('initDbs has not been called');
  }
  return contentDbInstance;
}

/**
 * Close both databases.
 */
export async function closeDbs(): Promise<void> {
  if (structureDbInstance) {
    await structureDbInstance.close();
    structureDbInstance = null;
  }
  if (contentDbInstance) {
    await contentDbInstance.close();
    contentDbInstance = null;
  }
}

// --- Deprecated API for backward compatibility ---

/** @deprecated Use initDbs instead */
export function initDb(dataDir: string): Db {
  initDbs({ dataDir });
  return getStructureDb();
}

/** @deprecated Use getStructureDb or getContentDb instead */
export function getDb(): Db {
  return getStructureDb();
}

/** @deprecated Use closeDbs instead */
export async function closeDb(): Promise<void> {
  await closeDbs();
}
