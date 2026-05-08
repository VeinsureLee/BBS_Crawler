import type { Page, BrowserContext } from 'playwright';
import type {
  SiteAdapter,
  Thread,
  ThreadSummary,
  ListParams,
  SearchParams,
} from './site-adapter';
import {
  SessionExpiredError,
  NavigationTimeoutError,
  RateLimitedError,
} from './errors';
import { logger } from '../util/logger';
import { shouldSkipFetch } from '../repository/threads';

export interface CrawlerServiceDeps {
  rateLimiter: { acquire: (siteKey: string) => Promise<() => void> };
  browserPool: {
    acquire: (siteKey: string) => Promise<{
      context: BrowserContext;
      saveStorageState: () => Promise<void>;
      release: () => void;
    }>;
    wipeStorageState: (siteKey: string) => Promise<void>;
  };
  auth: {
    ensureLoggedIn: (page: Page, adapter: SiteAdapter) => Promise<void>;
    detectSessionExpired: (page: Page, adapter: SiteAdapter) => Promise<SessionExpiredError | null>;
  };
  registry: { getAdapter: (siteKey: string) => SiteAdapter };
  persistThread: (siteKey: string, thread: Thread) => Promise<number>;
  appendFetchLog: (row: {
    siteKey: string;
    tool: string;
    args: Record<string, unknown>;
    status: 'ok' | 'error' | 'rate_limited';
    errorCode?: string;
    durationMs: number;
  }) => Promise<void>;
  /** Test seam — production uses real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchThreadInput { siteKey: string; url: string; maxReplies?: number | undefined; persist?: boolean | undefined; }
export interface FetchThreadOutput {
  siteKey: string;
  fetchedAt: string;
  thread: Thread;
  persisted: boolean;
  threadId?: number | undefined;
}

export interface ListThreadsInput extends ListParams { siteKey: string; persist?: boolean | undefined; }
export interface ListThreadsOutput {
  siteKey: string;
  fetchedAt: string;
  results: ThreadSummary[];
  page: number;
  hasMore: boolean;
  persisted: boolean;
}

export interface SearchInput extends SearchParams { siteKey: string; persist?: boolean | undefined; }
export interface SearchOutput {
  siteKey: string;
  fetchedAt: string;
  results: ThreadSummary[];
  page: number;
  hasMore: boolean;
  persisted: boolean;
}

const NAV_TIMEOUT_BACKOFFS_MS = [500, 1500];   // 2 retries
const RATE_LIMITED_BACKOFF_MS = 30_000;        // 1 retry

export class CrawlerService {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: CrawlerServiceDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async fetchThread(input: FetchThreadInput): Promise<FetchThreadOutput> {
    return this.run('forum_get_thread', input.siteKey, input as unknown as Record<string, unknown>, async (page, adapter) => {
      const params: { url: string; maxReplies?: number } = { url: input.url };
      if (input.maxReplies !== undefined) params.maxReplies = input.maxReplies;
      const thread = await adapter.getThread(page, params);
      let persisted = false;
      let threadId: number | undefined;
      if (input.persist) {
        threadId = await this.deps.persistThread(input.siteKey, thread);
        persisted = true;
      }
      const output: FetchThreadOutput = { siteKey: input.siteKey, fetchedAt: thread.fetchedAt, thread, persisted };
      if (threadId !== undefined) output.threadId = threadId;
      return output;
    });
  }

  async listThreads(input: ListThreadsInput): Promise<ListThreadsOutput> {
    return this.run('forum_list_threads', input.siteKey, input as unknown as Record<string, unknown>, async (page, adapter) => {
      const params: { board?: string; page?: number; pageSize?: number } = {};
      if (input.board !== undefined) params.board = input.board;
      if (input.page !== undefined) params.page = input.page;
      if (input.pageSize !== undefined) params.pageSize = input.pageSize;
      const results = await adapter.listThreads(page, params);
      return {
        siteKey: input.siteKey,
        fetchedAt: new Date().toISOString(),
        results,
        page: input.page ?? 1,
        hasMore: results.length > 0,
        persisted: false,
      };
    });
  }

  async search(input: SearchInput): Promise<SearchOutput> {
    return this.run('forum_search', input.siteKey, input as unknown as Record<string, unknown>, async (page, adapter) => {
      const params: { keyword: string; page?: number } = { keyword: input.keyword };
      if (input.page !== undefined) params.page = input.page;
      const results = await adapter.search(page, params);
      return {
        siteKey: input.siteKey,
        fetchedAt: new Date().toISOString(),
        results,
        page: input.page ?? 1,
        hasMore: results.length > 0,
        persisted: false,
      };
    });
  }

  /**
   * Runs `body` once with two layers of retry:
   *   - Outer: SessionExpired triggers one retry after wiping storageState.
   *   - Inner: NavigationTimeout retries up to 2 times with [500ms, 1500ms]; RateLimited retries once after 30s.
   *
   * Audit logging never breaks the success path: failures inside appendFetchLog are downgraded to a warn log.
   */
  private async run<T>(
    tool: string,
    siteKey: string,
    args: Record<string, unknown>,
    body: (page: Page, adapter: SiteAdapter) => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    let lastErr: unknown;

    for (let outer = 0; outer < 2; outer++) {
      const release = await this.deps.rateLimiter.acquire(siteKey);
      const acquired = await this.deps.browserPool.acquire(siteKey);
      const page = await acquired.context.newPage();
      try {
        const adapter = this.deps.registry.getAdapter(siteKey);
        await this.deps.auth.ensureLoggedIn(page, adapter);
        const out = await this.runBodyWithInnerRetries(() => body(page, adapter));
        this.safeAppendFetchLog({
          siteKey, tool, args, status: 'ok', durationMs: Date.now() - started,
        });
        return out;
      } catch (e) {
        lastErr = e;
        if (e instanceof SessionExpiredError && outer === 0) {
          logger.warn({ siteKey, tool }, 'session expired, wiping storageState and retrying');
          await this.deps.browserPool.wipeStorageState(siteKey);
          continue;
        }
        const code = (e as { code?: string }).code;
        const status: 'error' | 'rate_limited' = e instanceof RateLimitedError ? 'rate_limited' : 'error';
        this.safeAppendFetchLog({
          siteKey, tool, args, status,
          errorCode: typeof code === 'string' ? code : 'INTERNAL',
          durationMs: Date.now() - started,
        });
        throw e;
      } finally {
        await page.close().catch(() => {});
        acquired.release();
        release();
      }
    }
    throw lastErr;
  }

  private async runBodyWithInnerRetries<T>(call: () => Promise<T>): Promise<T> {
    let navAttempts = 0;
    let rateAttempts = 0;
    while (true) {
      try { return await call(); }
      catch (e) {
        if (e instanceof NavigationTimeoutError && navAttempts < NAV_TIMEOUT_BACKOFFS_MS.length) {
          await this.sleep(NAV_TIMEOUT_BACKOFFS_MS[navAttempts]!);
          navAttempts++;
          continue;
        }
        if (e instanceof RateLimitedError && rateAttempts < 1) {
          await this.sleep(RATE_LIMITED_BACKOFF_MS);
          rateAttempts++;
          continue;
        }
        throw e;
      }
    }
  }

  private safeAppendFetchLog(row: {
    siteKey: string;
    tool: string;
    args: Record<string, unknown>;
    status: 'ok' | 'error' | 'rate_limited';
    errorCode?: string;
    durationMs: number;
  }): void {
    this.deps.appendFetchLog(row).catch((err) => {
      logger.warn({ err: String(err), tool: row.tool, siteKey: row.siteKey }, 'fetch_log write failed');
    });
  }
}
