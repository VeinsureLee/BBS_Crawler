/**
 * Crawl all threads from a board, skipping those already crawled.
 *
 * Usage:
 *   npx tsx scripts/crawl-board-with-skip.ts <boardKey> [freshnessHours]
 *   e.g. npx tsx scripts/crawl-board-with-skip.ts BYRatSH 24
 *
 * Requires:
 *   - SCHOOL_BBS_BASE_URL in .env
 *   - .state/school-bbs.json produced by scripts/do-login.ts
 */
import 'dotenv/config';
import '../../src/adapters/index';
import { chromium } from 'playwright';
import * as path from 'path';
import { initDbs, closeDbs } from '../../src/repository/db';
import { loadSiteConfig } from '../../src/core/site-config';
import { BrowserPool } from '../../src/core/browser-pool';
import { createRateLimiter } from '../../src/core/rate-limiter';
import { AuthManager } from '../../src/core/auth-manager';
import { CrawlerService } from '../../src/core/crawler-service';
import { getAdapter } from '../../src/core/registry';
import { upsertThread } from '../../src/repository/threads';
import { upsertPosts } from '../../src/repository/posts';
import { appendFetchLog } from '../../src/repository/fetch-log';
import { addRedactedSecret, logger } from '../../src/util/logger';
import { shouldSkipFetch, getCrawledThreadUrls } from '../../src/repository/threads';

const config = loadSiteConfig('school-bbs');

async function main() {
  const boardKey = process.argv[2];
  const freshnessHours = Number(process.argv[3] ?? 24);
  if (!boardKey) {
    console.error('Usage: tsx scripts/crawl-board-with-skip.ts <boardKey> [freshnessHours]');
    process.exit(1);
  }

  const dataDir = process.env.DATABASE_PATH ?? './data';
  initDbs({ dataDir });

  const stateDir = process.env.STORAGE_STATE_DIR || './.state';
  const browserPool = new BrowserPool({
    headless: process.env.BROWSER_HEADLESS !== 'false',
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
    userAgent: process.env.BROWSER_USER_AGENT,
    storageStateDir: stateDir,
    idleTimeoutMs: 60000,
  });

  const rateLimiter = createRateLimiter({
    minIntervalMs: 500,
    jitterMs: 200,
    maxConcurrency: 1,
  });

  const auth = new AuthManager({
    env: process.env,
    saveStorageState: async (siteKey) => {
      const ctx = await browserPool.acquire(siteKey);
      try { await ctx.saveStorageState(); } finally { ctx.release(); }
    },
    addRedactedSecret,
  });

  const crawler = new CrawlerService({
    rateLimiter,
    browserPool: {
      acquire: (siteKey) => browserPool.acquire(siteKey),
      wipeStorageState: (siteKey) => browserPool.wipeStorageState(siteKey),
    },
    auth,
    registry: { getAdapter },
    persistThread: async (siteKey, thread) => {
      const { threadId } = await upsertThread(siteKey, thread);
      await upsertPosts(threadId, thread.posts);
      return threadId;
    },
    appendFetchLog,
  });

  try {
    console.log(`Listing threads from board: ${boardKey}`);
    const listResult = await crawler.listThreads({
      siteKey: 'school-bbs',
      board: boardKey,
      page: 1,
    });

    console.log(`Found ${listResult.results.length} thread(s) on first page`);

    // Get already crawled URLs for quick filtering
    const crawledUrls = await getCrawledThreadUrls('school-bbs', boardKey);
    console.log(`Already crawled ${crawledUrls.size} thread(s) in this board`);

    const toFetch = [];
    for (const summary of listResult.results) {
      const skipResult = await shouldSkipFetch(
        'school-bbs',
        summary.url,
        summary.replyCount,
        freshnessHours,
      );
      if (skipResult.skipped) {
        console.log(`[SKIP] ${summary.title} (already fresh)`);
      } else {
        console.log(`[FETCH] ${summary.title}`);
        toFetch.push(summary);
      }
    }

    console.log(`\nFetching ${toFetch.length} thread(s)...`);
    let successCount = 0;
    let skipCount = listResult.results.length - toFetch.length;

    for (const summary of toFetch) {
      try {
        const result = await crawler.fetchThread({
          siteKey: 'school-bbs',
          url: summary.url,
          persist: true,
        });
        console.log(`[OK] ${result.thread.title} (id=${result.threadId})`);
        successCount++;
      } catch (e) {
        console.error(`[ERROR] ${summary.url}:`, e);
      }
    }

    console.log(`\nDone:`);
    console.log(`  Skipped: ${skipCount}`);
    console.log(`  Fetched: ${successCount}`);

  } finally {
    await closeDbs();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
