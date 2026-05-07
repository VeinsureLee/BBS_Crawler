import { describe, it, expect, beforeEach } from 'vitest';
import { newDb } from 'pg-mem';
import { _setPoolForTests, getPool } from '../../../../src/repository/db';
import { appendFetchLog } from '../../../../src/repository/fetch-log';

beforeEach(() => {
  const mem = newDb();
  mem.public.none(`
    CREATE TABLE fetch_log (
      id bigserial PRIMARY KEY,
      site_key text NOT NULL,
      tool text NOT NULL,
      args jsonb NOT NULL,
      status text NOT NULL,
      error_code text,
      duration_ms int,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const { Pool } = mem.adapters.createPg();
  _setPoolForTests(new Pool());
});

describe('appendFetchLog', () => {
  it('inserts an ok row', async () => {
    await appendFetchLog({ siteKey: 's', tool: 'forum_get_thread', args: { url: 'u' }, status: 'ok', durationMs: 42 });
    const r = await getPool().query('SELECT site_key, tool, status, duration_ms FROM fetch_log');
    expect(r.rows).toEqual([{ site_key: 's', tool: 'forum_get_thread', status: 'ok', duration_ms: 42 }]);
  });

  it('inserts an error row with error_code', async () => {
    await appendFetchLog({ siteKey: 's', tool: 'forum_get_thread', args: {}, status: 'error', errorCode: 'NAVIGATION_TIMEOUT', durationMs: 99 });
    const r = await getPool().query('SELECT status, error_code FROM fetch_log');
    expect(r.rows[0]).toEqual({ status: 'error', error_code: 'NAVIGATION_TIMEOUT' });
  });
});
