import type { Page } from 'playwright';
import { loadAndResolvePaths, type PathOptions } from '../config/paths.js';

export interface CrawlerConfig extends PathOptions {
  /** Target site adapter key. Defaults to 'school-bbs'. */
  siteKey?: string | undefined;
  /**
   * Override BrowserPool idle-close timeout (ms). 0 = never auto-close.
   * Default: read from env (IDLE_TIMEOUT_MS via parseConfig).
   */
  idleTimeoutMs?: number | undefined;
}

export interface Crawler {
  service: import('./crawler-service.js').CrawlerService;
  readers: typeof import('../read/readers.js');
  runInitSections: () => Promise<void>;
  runInitBoards: (opts?: { sections?: import('../repository/sections.js').SectionRow[] }) => Promise<void>;
  runInitPinned: (boards: import('../repository/boards.js').BoardRow[]) => Promise<void>;
  runRefreshBoardStats: (opts: import('./init-runners.js').RefreshBoardStatsOpts) => Promise<import('./init-runners.js').RefreshBoardStatsResult>;
  withLoggedInPage: <T>(fn: (page: Page) => Promise<T>) => Promise<T>;
  shutdown: () => Promise<void>;
}

export async function createCrawler(config: CrawlerConfig = {}): Promise<Crawler> {
  // MCP uses stdio for JSON-RPC; never let the crawler's logger touch stdout
  // unless the embedder explicitly allows it. Must be set before importing the logger.
  if (process.env.LOG_STDOUT_DISABLED === undefined) {
    process.env.LOG_STDOUT_DISABLED = 'true';
  }

  const paths = loadAndResolvePaths(config);
  const siteKey = config.siteKey ?? 'school-bbs';

  // Side-effect import registers built-in adapters into the registry.
  await import('../adapters/index.js');

  const { parseConfig } = await import('../config/app-config.js');
  const { initDb, closeAllDbs } = await import('../repository/db.js');
  const { BrowserPool } = await import('../session/browser-pool.js');
  const { AuthManager } = await import('../session/auth-manager.js');
  const { createRateLimiter } = await import('../session/rate-limiter.js');
  const { CrawlerService } = await import('./crawler-service.js');
  const { getAdapter } = await import('../registry.js');
  const { upsertThread } = await import('../repository/threads.js');
  const { upsertPosts } = await import('../repository/posts.js');
  const { appendFetchLog } = await import('../repository/fetch-log.js');
  const { addRedactedSecret } = await import('../util/logger.js');
  const { runInitSections, runInitBoards, runInitPinned, runRefreshBoardStats } = await import('./init-runners.js');
  const readers = await import('../read/readers.js');

  const app = parseConfig(process.env);
  // initDb is a process-level singleton: a second createCrawler() in the same
  // process with a different dataDir is ignored (the first one wins).
  initDb({ dataDir: paths.dataDir });

  const browserPool = new BrowserPool({
    headless: app.browserHeadless,
    executablePath: app.browserExecutablePath,
    userAgent: app.browserUserAgent,
    storageStateDir: app.storageStateDir,
    idleTimeoutMs: config.idleTimeoutMs ?? app.idleTimeoutMs,
  });

  const auth = new AuthManager({
    env: process.env,
    saveStorageState: async (sk) => {
      const ctx = await browserPool.acquire(sk);
      try { await ctx.saveStorageState(); } finally { ctx.release(); }
    },
    addRedactedSecret,
  });

  const rateLimiter = createRateLimiter({
    minIntervalMs: app.rateMinIntervalMs,
    jitterMs: app.rateJitterMs,
    maxConcurrency: app.rateMaxConcurrency,
  });

  const service = new CrawlerService({
    rateLimiter,
    browserPool: {
      acquire: (sk) => browserPool.acquire(sk),
      wipeStorageState: (sk) => browserPool.wipeStorageState(sk),
    },
    auth,
    registry: { getAdapter },
    // The fetchThread path always persists with isPinned:false; pinned status
    // is injected separately by runInitPinned.
    persistThread: async (sk, thread) => {
      const { threadId, boardDb } = await upsertThread(sk, thread, { isPinned: false });
      await upsertPosts(boardDb, threadId, thread.posts);
      return threadId;
    },
    appendFetchLog,
  });

  async function withLoggedInPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const acquired = await browserPool.acquire(siteKey);
    const page = await acquired.context.newPage();
    try {
      await auth.ensureLoggedIn(page, getAdapter(siteKey));
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
      acquired.release();
    }
  }

  return {
    service,
    readers,
    runInitSections: () => runInitSections(siteKey, withLoggedInPage),
    runInitBoards: (opts) => withLoggedInPage((page) => runInitBoards(page, siteKey, opts ?? {})),
    runInitPinned: (boards) => withLoggedInPage((page) => runInitPinned(page, siteKey, boards)),
    runRefreshBoardStats: (opts) => withLoggedInPage((page) => runRefreshBoardStats(page, siteKey, opts)),
    withLoggedInPage,
    async shutdown() {
      await browserPool.close();
      await closeAllDbs();
    },
  };
}
