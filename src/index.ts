import 'dotenv/config';
import './adapters/index'; // side-effect adapter registration
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseConfig } from './core/config';
import { initDb } from './repository/db';
import { BrowserPool } from './core/browser-pool';
import { createRateLimiter } from './core/rate-limiter';
import { AuthManager } from './core/auth-manager';
import { CrawlerService } from './core/crawler-service';
import { getAdapter, listAdapters } from './core/registry';
import { upsertThread } from './repository/threads';
import { upsertPosts } from './repository/posts';
import { upsertSite } from './repository/sites';
import { appendFetchLog } from './repository/fetch-log';
import { hasSections, sectionsMissingBoards } from './repository/sections';
import { boardsMissingPinned } from './repository/boards';
import { InitOrchestrator } from './core/init-orchestrator';
import { runInitSections, runInitBoards, runInitPinned } from './core/init-runners';
import { registerTools } from './server/tools';
import { addRedactedSecret, logger } from './util/logger';

async function main(): Promise<void> {
  const cfg = parseConfig(process.env);
  initDb(cfg.pgDataDir);

  const browserPool = new BrowserPool({
    headless: cfg.browserHeadless,
    executablePath: cfg.browserExecutablePath,
    userAgent: cfg.browserUserAgent,
    storageStateDir: cfg.storageStateDir,
    idleTimeoutMs: cfg.idleTimeoutMs,
  });

  const rateLimiter = createRateLimiter({
    minIntervalMs: cfg.rateMinIntervalMs,
    jitterMs: cfg.rateJitterMs,
    maxConcurrency: cfg.rateMaxConcurrency,
  });

  const auth = new AuthManager({
    env: process.env,
    saveStorageState: async (siteKey) => {
      const ctx = await browserPool.acquire(siteKey);
      try { await ctx.saveStorageState(); } finally { ctx.release(); }
    },
    addRedactedSecret,
  });

  for (const adapter of listAdapters()) {
    await upsertSite({
      siteKey: adapter.siteKey,
      displayName: adapter.displayName,
      baseUrl: adapter.baseUrl,
    });
  }

  // Helper: acquire a logged-in page, run `fn`, release everything.
  // Used by InitOrchestrator so init flows go through the same browser pool
  // / storageState as regular tool calls.
  const runWithPage = async <T>(siteKey: string, fn: (page: import('playwright').Page) => Promise<T>): Promise<T> => {
    const ctx = await browserPool.acquire(siteKey);
    const page = await ctx.context.newPage();
    try {
      await auth.ensureLoggedIn(page, getAdapter(siteKey));
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
      ctx.release();
    }
  };

  const initOrchestrator = new InitOrchestrator({
    hasSections,
    sectionsMissingBoards,
    boardsMissingPinned,
    runWithPage,
    runInitSections,
    runInitBoards,
    runInitPinned,
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
    initOrchestrator,
  });

  const server = new McpServer({ name: 'bbs-crawler', version: '0.1.0' });
  registerTools(server, {
    crawler,
    storageStatePathFor: (siteKey) => browserPool.storageStatePathFor(siteKey),
    isLoggedIn: async (siteKey) => {
      const ctx = await browserPool.acquire(siteKey);
      try {
        const page = await ctx.context.newPage();
        try { return await getAdapter(siteKey).isLoggedIn(page); }
        finally { await page.close().catch(() => {}); }
      } finally { ctx.release(); }
    },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('bbs-crawler MCP server connected via stdio');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
