import pg from 'pg';
import { DatabaseError } from '../core/errors';

let pool: pg.Pool | null = null;

export function initDb(databaseUrl: string): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: databaseUrl });
  pool.on('error', (err) => {
    // Swallow idle-client errors; the pool will recreate connections.
    // eslint-disable-next-line no-console
    console.error('[pg pool] idle client error:', err.message);
  });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new DatabaseError('initDb has not been called');
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Inject a pg.Pool directly. Used by tests with pg-mem. */
export function _setPoolForTests(p: pg.Pool | null): void {
  pool = p;
}
