/**
 * Database access layer.
 *
 * Backed by PGlite (https://pglite.dev) — a real PostgreSQL compiled to
 * WASM/native that stores its data in a local directory. Zero external
 * services, zero install for end users beyond `npm install`.
 *
 * Repository code talks to a small `Db` interface (query + transaction) so
 * tests can inject a fake without touching the PGlite implementation.
 */
import { PGlite } from '@electric-sql/pglite';
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

class PGliteDb implements Db {
  constructor(private pg: PGlite) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const r = await this.pg.query<T>(sql, params as unknown[] | undefined);
    return { rows: r.rows, affectedRows: r.affectedRows };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async transaction<R>(fn: (tx: TxClient) => Promise<R>): Promise<R> {
    return this.pg.transaction(async (t) => {
      const tx: TxClient = {
        query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
          const r = await t.query<T>(sql, params as unknown[] | undefined);
          return { rows: r.rows, affectedRows: r.affectedRows };
        },
      };
      return fn(tx);
    }) as R;
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

let db: Db | null = null;

export function initDb(dataDir: string): Db {
  if (db) return db;
  const pg = new PGlite(dataDir);
  db = new PGliteDb(pg);
  return db;
}

export function getDb(): Db {
  if (!db) throw new DatabaseError('initDb has not been called');
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}

/** Inject a Db implementation directly. Used by tests. */
export function _setDbForTests(d: Db | null): void {
  db = d;
}

/**
 * Backwards-compat shim: some repository code still imports getPool().
 * Deprecated — use getDb() instead.
 * @deprecated
 */
export function getPool(): Db {
  return getDb();
}
