import type { Page } from 'playwright';
import { loadAndResolvePaths, type PathOptions } from '../config/paths.js';
import type { SiteAdapter } from '../contract/site-adapter.js';
import { checkAuthStatus, warmUp as warmUpSession } from './session-ops.js';
import type { AuthStatus, WarmUpResult } from './session-ops.js';

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
  runInitSections: () => Promise<import('./init-runners.js').RunInitSectionsResult>;
  runInitBoards: (
    opts?: import('./init-runners.js').InitOpts & {
      sections?: import('../repository/sections.js').SectionRow[];
    },
  ) => Promise<import('./init-runners.js').RunInitBoardsResult>;
  runInitPinned: (
    boards: import('../repository/boards.js').BoardRow[],
    opts?: import('./init-runners.js').InitOpts,
  ) => Promise<import('./init-runners.js').RunInitPinnedResult>;
  runRefreshBoardStats: (
    opts: import('./init-runners.js').RefreshBoardStatsOpts,
  ) => Promise<import('./init-runners.js').RefreshBoardStatsResult>;
  withLoggedInPage: <T>(fn: (page: Page) => Promise<T>) => Promise<T>;
  /** Read-only login-state probe — navigates to baseUrl, never logs in. */
  authStatus: () => Promise<AuthStatus>;
  /** Launch browser + establish session, fetching no data. */
  warmUp: () => Promise<WarmUpResult>;
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

  const { parseConfig, credentialEnvKeys } = await import('../config/app-config.js');
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

  const sessionOpsDeps = {
    browserPool: { acquire: (sk: string) => browserPool.acquire(sk) },
    getAdapter,
    ensureLoggedIn: (page: Page, adapter: SiteAdapter) => auth.ensureLoggedIn(page, adapter),
    // adapter.isLoggedIn checks the CURRENT page, so authStatus must navigate to
    // the site home first. baseUrl env key is site-specific (e.g. SCHOOL_BBS_BASE_URL).
    baseUrl: process.env[credentialEnvKeys(siteKey).baseUrl] ?? '',
  };

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

  // Multi-page entry used by parallel runners. Caller is responsible for
  // closing every page it opens via `context.newPage()` and calling release().
  async function acquireContext() {
    const acquired = await browserPool.acquire(siteKey);
    return {
      context: acquired.context,
      ensureLoggedIn: (page: Page) => auth.ensureLoggedIn(page, getAdapter(siteKey)),
      release: acquired.release,
    };
  }

  return {
    service,
    readers,
    runInitSections: () => runInitSections(siteKey, withLoggedInPage),
    runInitBoards: (opts) => runInitBoards({ acquireContext }, siteKey, opts ?? {}),
    runInitPinned: (boards, opts) => runInitPinned({ acquireContext }, siteKey, boards, opts ?? {}),
    runRefreshBoardStats: (opts) => runRefreshBoardStats({ acquireContext }, siteKey, opts),
    withLoggedInPage,
    authStatus: () => checkAuthStatus(sessionOpsDeps, siteKey),
    warmUp: () => warmUpSession(sessionOpsDeps, siteKey),
    async shutdown() {
      await browserPool.close();
      await closeAllDbs();
    },
  };
}
