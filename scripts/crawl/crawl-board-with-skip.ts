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
import { initDb, closeAllDbs } from '../../src/repository/db';
import { loadSiteConfig } from '../../src/config/site-config';
import { BrowserPool } from '../../src/core/browser-pool';
import { createRateLimiter } from '../../src/core/rate-limiter';
import { AuthManager } from '../../src/core/auth-manager';
import { CrawlerService } from '../../src/core/crawler-service';
import { getAdapter } from '../../src/registry';
import { upsertThread } from '../../src/repository/threads';
import { upsertPosts } from '../../src/repository/posts';
import { appendFetchLog } from '../../src/repository/fetch-log';
import { addRedactedSecret, logger } from '../../src/util/logger';
import { shouldSkipFetch, getCrawledThreadUrls } from '../../src/repository/threads';
import { listBoards } from '../../src/repository/boards';

const config = loadSiteConfig('school-bbs');

async function main() {
  const boardKey = process.argv[2];
  const freshnessHours = Number(process.argv[3] ?? 24);
  if (!boardKey) {
    console.error('Usage: tsx scripts/crawl-board-with-skip.ts <boardKey> [freshnessHours]');
    process.exit(1);
  }

  const dataDir = process.env.DATABASE_PATH ?? './data';
  initDb({ dataDir });

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
      const { threadId, boardDb } = await upsertThread(siteKey, thread, { isPinned: false });
      await upsertPosts(boardDb, threadId, thread.posts);
      return threadId;
    },
    appendFetchLog,
  });

  const startedAt = Date.now();
  logger.info({ boardKey, freshnessHours, script: 'crawl-board-with-skip' }, `crawl-board: 列出版面 ${boardKey}`);
  try {
    // listThreadsByName 需要版面显示名；脚本入参是 boardKey，先反查。
    const boards = await listBoards('school-bbs');
    const board = boards.find((b) => b.boardKey === boardKey);
    if (!board || !board.name) {
      throw new Error(`board "${boardKey}" not found in DB. Run init:boards first.`);
    }
    const listResult = await crawler.listThreadsByName({
      siteKey: 'school-bbs',
      boardName: board.name,
      mode: 'pages',
      pages: 1,
    });

    logger.info({ boardKey, found: listResult.threads.length }, `首页发现 ${listResult.threads.length} 帖`);

    // Get already crawled URLs for quick filtering.
    const crawledUrls = await getCrawledThreadUrls('school-bbs', boardKey);
    logger.info({ boardKey, alreadyCrawled: crawledUrls.size }, `本版已爬 ${crawledUrls.size} 帖`);

    const toFetch = [];
    for (const summary of listResult.threads) {
      const skipResult = await shouldSkipFetch(
        'school-bbs',
        boardKey,
        summary.url,
        summary.replyCount,
        freshnessHours,
      );
      if (skipResult.skipped) {
        logger.info({ url: summary.url, title: summary.title }, `[SKIP] ${summary.title} (新鲜)`);
      } else {
        logger.info({ url: summary.url, title: summary.title }, `[FETCH] ${summary.title}`);
        toFetch.push(summary);
      }
    }

    logger.info({ toFetch: toFetch.length }, `准备抓取 ${toFetch.length} 帖`);
    let successCount = 0;
    const skipCount = listResult.threads.length - toFetch.length;

    for (const summary of toFetch) {
      try {
        const result = await crawler.fetchThread({
          siteKey: 'school-bbs',
          url: summary.url,
          persist: true,
        });
        logger.info({ threadId: result.threadId, title: result.thread.title }, `[OK] ${result.thread.title} (id=${result.threadId})`);
        successCount++;
      } catch (e) {
        logger.error({ url: summary.url, err: String(e) }, `[ERROR] ${summary.url}: ${String(e)}`);
      }
    }

    logger.info(
      { boardKey, skipped: skipCount, fetched: successCount, elapsedMs: Date.now() - startedAt },
      `完成：跳过 ${skipCount}，抓取 ${successCount}`,
    );

  } finally {
    await closeAllDbs();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
