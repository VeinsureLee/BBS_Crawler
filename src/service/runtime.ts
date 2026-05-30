import { createCrawler, type Crawler, type CrawlerConfig } from './factory.js';
import type { AuthStatus, WarmUpResult } from './session-ops.js';

export interface CrawlerRuntimeOptions {
  /** Passed verbatim to createCrawler() on init(). */
  config?: CrawlerConfig;
  /** Test seam: override the factory used to build the Crawler. */
  createCrawlerFn?: typeof createCrawler;
}

/**
 * Lightweight, global-free lifecycle wrapper around a single Crawler.
 * A consumer (e.g. an MCP server) constructs one, calls init() at startup,
 * holds it for the process lifetime, and calls shutdown() on exit. Whether to
 * hold it as a singleton is the consumer's decision — this class owns no globals.
 */
export class CrawlerRuntime {
  private crawler: Crawler | null = null;
  private readonly config: CrawlerConfig;
  private readonly factory: typeof createCrawler;

  constructor(opts: CrawlerRuntimeOptions = {}) {
    this.config = opts.config ?? {};
    this.factory = opts.createCrawlerFn ?? createCrawler;
  }

  /** Build the underlying Crawler. Idempotent — a second call is a no-op. */
  async init(): Promise<void> {
    if (this.crawler) return;
    this.crawler = await this.factory(this.config);
  }

  isReady(): boolean {
    return this.crawler !== null;
  }

  private ready(): Crawler {
    if (!this.crawler) {
      throw new Error('CrawlerRuntime not initialized — call init() first');
    }
    return this.crawler;
  }

  get service(): Crawler['service'] { return this.ready().service; }
  get readers(): Crawler['readers'] { return this.ready().readers; }

  authStatus(): Promise<AuthStatus> { return this.ready().authStatus(); }
  warmUp(): Promise<WarmUpResult> { return this.ready().warmUp(); }

  /** Release browser + db. Idempotent — safe to call when never/already shut down. */
  async shutdown(): Promise<void> {
    if (!this.crawler) return;
    const c = this.crawler;
    this.crawler = null;
    await c.shutdown();
  }
}
