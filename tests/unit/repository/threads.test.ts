import { describe, it, expect, beforeEach } from 'vitest';
import { newDb } from 'pg-mem';
import { _setPoolForTests, getPool } from '../../../src/repository/db';
import { upsertSite } from '../../../src/repository/sites';
import { upsertThread } from '../../../src/repository/threads';

beforeEach(async () => {
  const mem = newDb();
  mem.public.none(`
    CREATE TABLE sites (
      site_key text PRIMARY KEY, display_name text NOT NULL,
      base_url text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE threads (
      id bigserial PRIMARY KEY,
      site_key text NOT NULL REFERENCES sites(site_key),
      url text NOT NULL,
      title text NOT NULL,
      author text,
      board_key text,
      posted_at timestamptz,
      last_reply_at timestamptz,
      reply_count int,
      view_count int,
      raw jsonb,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_fetched_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (site_key, url)
    );
  `);
  const { Pool } = mem.adapters.createPg();
  _setPoolForTests(new Pool());
  await upsertSite({ siteKey: 's', displayName: 'S', baseUrl: 'https://s.example' });
});

describe('upsertThread', () => {
  it('inserts a thread and returns its id', async () => {
    const { threadId } = await upsertThread('s', {
      url: 'https://s.example/t/1',
      title: 'Hi',
      posts: [],
      fetchedAt: new Date().toISOString(),
    });
    expect(typeof threadId).toBe('number');
    const r = await getPool().query('SELECT title FROM threads WHERE id=$1', [threadId]);
    expect(r.rows[0].title).toBe('Hi');
  });

  it('updates last_fetched_at on conflict (site_key, url)', async () => {
    const a = await upsertThread('s', {
      url: 'https://s.example/t/1',
      title: 'V1',
      posts: [],
      fetchedAt: '2026-01-01T00:00:00Z',
    });
    const b = await upsertThread('s', {
      url: 'https://s.example/t/1',
      title: 'V2',
      posts: [],
      fetchedAt: '2026-01-02T00:00:00Z',
    });
    expect(b.threadId).toBe(a.threadId);
    const r = await getPool().query('SELECT title FROM threads WHERE id=$1', [a.threadId]);
    expect(r.rows[0].title).toBe('V2');
  });
});
