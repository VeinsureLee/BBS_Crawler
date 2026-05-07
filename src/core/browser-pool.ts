import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';
import { logger } from '../util/logger';

export interface BrowserPoolOptions {
  headless: boolean;
  userAgent?: string | undefined;
  storageStateDir: string;
  idleTimeoutMs: number;
  /** Test seam: inject a custom launcher. */
  launcher?: (opts: LaunchOptions) => Promise<Browser>;
}

export interface AcquiredContext {
  context: BrowserContext;
  /** Persist the current storageState to disk (call after a successful login). */
  saveStorageState(): Promise<void>;
  release(): void;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private contexts = new Map<string, BrowserContext>();
  private inFlight = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: BrowserPoolOptions) {}

  async acquire(siteKey: string): Promise<AcquiredContext> {
    if (!this.browser) {
      const launch = this.opts.launcher ?? ((o) => chromium.launch(o));
      this.browser = await launch({ headless: this.opts.headless });
      logger.info({ siteKey }, 'browser launched');
    }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.inFlight++;

    let ctx = this.contexts.get(siteKey) ?? null;
    if (!ctx) {
      const statePath = this.storageStatePathFor(siteKey);
      const storageState = await this.tryReadJson(statePath) ?? undefined;
      const ctxOptions: Parameters<typeof this.browser.newContext>[0] = {};
      if (storageState) ctxOptions.storageState = storageState as any;
      if (this.opts.userAgent) ctxOptions.userAgent = this.opts.userAgent;
      ctx = await this.browser.newContext(ctxOptions);
      this.contexts.set(siteKey, ctx);
    }

    return {
      context: ctx,
      saveStorageState: async () => {
        const p = this.storageStatePathFor(siteKey);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await ctx!.storageState({ path: p });
        try { await fs.chmod(p, 0o600); } catch { /* best effort on Windows */ }
      },
      release: () => {
        this.inFlight--;
        if (this.inFlight === 0) this.scheduleIdleClose();
      },
    };
  }

  storageStatePathFor(siteKey: string): string {
    return path.join(this.opts.storageStateDir, `${siteKey}.storageState.json`);
  }

  async wipeStorageState(siteKey: string): Promise<void> {
    const p = this.storageStatePathFor(siteKey);
    try { await fs.rm(p); } catch { /* ignore missing */ }
    const ctx = this.contexts.get(siteKey);
    if (ctx) { await ctx.close(); this.contexts.delete(siteKey); }
  }

  async close(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    for (const [, ctx] of this.contexts) { await ctx.close().catch(() => {}); }
    this.contexts.clear();
    if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; }
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.close().catch(() => {}); }, this.opts.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private async tryReadJson(filePath: string): Promise<unknown | null> {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return null; }
  }
}
