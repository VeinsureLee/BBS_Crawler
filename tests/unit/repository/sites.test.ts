import { describe, it, expect, beforeEach } from 'vitest';
import { newDb } from 'pg-mem';
import { _setPoolForTests, getPool } from '../../../src/repository/db';
import { upsertSite } from '../../../src/repository/sites';

beforeEach(() => {
  const mem = newDb();
  // Minimal schema for this test.
  mem.public.none(`
    CREATE TABLE sites (
      site_key text PRIMARY KEY,
      display_name text NOT NULL,
      base_url text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const { Pool } = mem.adapters.createPg();
  _setPoolForTests(new Pool());
});

describe('upsertSite', () => {
  it('inserts a new site', async () => {
    await upsertSite({ siteKey: 'a', displayName: 'A', baseUrl: 'https://a.example' });
    const r = await getPool().query('SELECT site_key, display_name FROM sites');
    expect(r.rows).toEqual([{ site_key: 'a', display_name: 'A' }]);
  });

  it('updates display_name on conflict', async () => {
    await upsertSite({ siteKey: 'a', displayName: 'A', baseUrl: 'https://a.example' });
    await upsertSite({ siteKey: 'a', displayName: 'A2', baseUrl: 'https://a.example' });
    const r = await getPool().query('SELECT display_name FROM sites WHERE site_key=$1', ['a']);
    expect(r.rows[0].display_name).toBe('A2');
  });
});
