import { describe, it, expect, beforeEach } from 'vitest';
import { newDb } from 'pg-mem';
import { _setPoolForTests } from '../../src/repository/db';
import { upsertSite } from '../../src/repository/sites';
import { register, getAdapter, _resetForTests as resetRegistry } from '../../src/core/registry';
import { createRateLimiter } from '../../src/core/rate-limiter';
import { AuthManager } from '../../src/core/auth-manager';
import { CrawlerService } from '../../src/core/crawler-service';
import { upsertThread } from '../../src/repository/threads';
import { upsertPosts } from '../../src/repository/posts';
import { appendFetchLog } from '../../src/repository/fetch-log';
import { createStubAdapter } from '../fixtures/stub-adapter';
import type { Thread } from '../../src/core/site-adapter';

const fakePage = { close: async () => {} } as never;
const fakeContext = { newPage: async () => fakePage } as never;
function fakeBrowserPool() {
  return {
    acquire: async () => ({ context: fakeContext, saveStorageState: async () => {}, release: () => {} }),
    wipeStorageState: async () => {},
  };
}

const sampleThread: Thread = {
  url: 'https://stub.example.invalid/t/1',
  title: 'Hello',
  posts: [{ floor: 1, author: 'a', contentHtml: '<p>hi</p>', contentText: 'hi' }],
  fetchedAt: '2026-05-07T00:00:00Z',
};

beforeEach(async () => {
  resetRegistry();
  const mem = newDb();
  mem.public.none(`
    CREATE TABLE sites (site_key text PRIMARY KEY, display_name text NOT NULL, base_url text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE threads (id bigserial PRIMARY KEY, site_key text NOT NULL REFERENCES sites(site_key), url text NOT NULL, title text NOT NULL, author text, board_key text, posted_at timestamptz, last_reply_at timestamptz, reply_count int, view_count int, raw jsonb, first_seen_at timestamptz NOT NULL DEFAULT now(), last_fetched_at timestamptz NOT NULL DEFAULT now(), UNIQUE (site_key, url));
    CREATE TABLE posts (id bigserial PRIMARY KEY, thread_id bigint NOT NULL REFERENCES threads(id) ON DELETE CASCADE, floor int NOT NULL, author text NOT NULL, posted_at timestamptz, content_html text NOT NULL, content_text text NOT NULL, attachments jsonb, raw jsonb, UNIQUE (thread_id, floor));
    CREATE TABLE fetch_log (id bigserial PRIMARY KEY, site_key text NOT NULL, tool text NOT NULL, args jsonb NOT NULL, status text NOT NULL, error_code text, duration_ms int, created_at timestamptz NOT NULL DEFAULT now());
  `);
  const { Pool } = mem.adapters.createPg();
  _setPoolForTests(new Pool());
  await upsertSite({ siteKey: 'stub', displayName: 'Stub', baseUrl: 'https://stub.example.invalid' });
  register(createStubAdapter({ siteKey: 'stub', thread: sampleThread, initiallyLoggedIn: true }));
});

describe('end-to-end: CrawlerService + stub adapter + pg-mem', () => {
  it('forum_get_thread with persist=true writes thread and posts', async () => {
    const auth = new AuthManager({
      env: {}, saveStorageState: async () => {}, addRedactedSecret: () => {},
    });
    const crawler = new CrawlerService({
      rateLimiter: createRateLimiter({ minIntervalMs: 0, jitterMs: 0, maxConcurrency: 1 }),
      browserPool: fakeBrowserPool(),
      auth,
      registry: { getAdapter },
      persistThread: async (siteKey, thread) => {
        const { threadId } = await upsertThread(siteKey, thread);
        await upsertPosts(threadId, thread.posts);
        return threadId;
      },
      appendFetchLog,
    });

    const out = await crawler.fetchThread({ siteKey: 'stub', url: sampleThread.url, persist: true });
    expect(out.persisted).toBe(true);
    expect(typeof out.threadId).toBe('number');
  });
});
