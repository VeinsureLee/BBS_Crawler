import { describe, it, expect, beforeEach } from 'vitest';
import { newDb } from 'pg-mem';
import { _setPoolForTests, getPool } from '../../../../src/repository/db';
import { upsertSite } from '../../../../src/repository/sites';
import { upsertThread } from '../../../../src/repository/threads';
import { upsertPosts } from '../../../../src/repository/posts';

beforeEach(async () => {
  const mem = newDb();
  mem.public.none(`
    CREATE TABLE sites (
      site_key text PRIMARY KEY, display_name text NOT NULL,
      base_url text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE threads (
      id bigserial PRIMARY KEY, site_key text NOT NULL REFERENCES sites(site_key),
      url text NOT NULL, title text NOT NULL, author text, board_key text,
      posted_at timestamptz, last_reply_at timestamptz, reply_count int, view_count int,
      raw jsonb, first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_fetched_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (site_key, url)
    );
    CREATE TABLE posts (
      id bigserial PRIMARY KEY,
      thread_id bigint NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      floor int NOT NULL,
      author text NOT NULL,
      posted_at timestamptz,
      content_html text NOT NULL,
      content_text text NOT NULL,
      attachments jsonb,
      raw jsonb,
      UNIQUE (thread_id, floor)
    );
  `);
  const { Pool } = mem.adapters.createPg();
  _setPoolForTests(new Pool());
  await upsertSite({ siteKey: 's', displayName: 'S', baseUrl: 'https://s.example' });
});

async function makeThread(): Promise<number> {
  const { threadId } = await upsertThread('s', {
    url: 'https://s.example/t/1',
    title: 'T',
    posts: [],
    fetchedAt: new Date().toISOString(),
  });
  return threadId;
}

describe('upsertPosts', () => {
  it('inserts new posts', async () => {
    const tid = await makeThread();
    await upsertPosts(tid, [
      { floor: 1, author: 'a', contentHtml: '<p>x</p>', contentText: 'x' },
      { floor: 2, author: 'b', contentHtml: '<p>y</p>', contentText: 'y' },
    ]);
    const r = await getPool().query('SELECT floor, author FROM posts WHERE thread_id=$1 ORDER BY floor', [tid]);
    expect(r.rows).toEqual([{ floor: 1, author: 'a' }, { floor: 2, author: 'b' }]);
  });

  it('updates content on conflict (thread_id, floor)', async () => {
    const tid = await makeThread();
    await upsertPosts(tid, [{ floor: 1, author: 'a', contentHtml: '<p>x</p>', contentText: 'x' }]);
    await upsertPosts(tid, [{ floor: 1, author: 'a', contentHtml: '<p>x2</p>', contentText: 'x2' }]);
    const r = await getPool().query('SELECT content_text FROM posts WHERE thread_id=$1 AND floor=1', [tid]);
    expect(r.rows[0].content_text).toBe('x2');
  });
});
