import type { Page, BrowserContext } from 'playwright';
import type { SiteAdapter } from '../contract/site-adapter.js';

export interface AuthStatus {
  siteKey: string;
  loggedIn: boolean;
  checkedAt: string;
}

export interface WarmUpResult {
  siteKey: string;
  loggedIn: boolean;
  warmedAt: string;
}

export interface SessionOpsDeps {
  browserPool: {
    acquire: (siteKey: string) => Promise<{
      context: BrowserContext;
      saveStorageState: () => Promise<void>;
      release: () => void;
    }>;
  };
  getAdapter: (siteKey: string) => SiteAdapter;
  ensureLoggedIn: (page: Page, adapter: SiteAdapter) => Promise<void>;
  /** Site home URL — needed because adapter.isLoggedIn checks the CURRENT page. */
  baseUrl: string;
  /** Test seam — production uses real clock. */
  now?: () => string;
}

const NAV_TIMEOUT_MS = 30_000;

/**
 * Read-only login-state probe. Navigates to baseUrl then asks the adapter
 * whether the page shows a logged-in indicator. NEVER triggers a login —
 * use warmUp() for that.
 */
export async function checkAuthStatus(deps: SessionOpsDeps, siteKey: string): Promise<AuthStatus> {
  const now = deps.now ?? (() => new Date().toISOString());
  const adapter = deps.getAdapter(siteKey);
  const acquired = await deps.browserPool.acquire(siteKey);
  const page = await acquired.context.newPage();
  try {
    if (deps.baseUrl) {
      await page.goto(deps.baseUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    }
    const loggedIn = await adapter.isLoggedIn(page);
    return { siteKey, loggedIn, checkedAt: now() };
  } finally {
    await page.close().catch(() => {});
    acquired.release();
  }
}

/**
 * Launch browser + establish/verify a logged-in session, fetching NO data.
 * Used at server startup to make the first real request fast. Throws if login
 * cannot be established (propagates the adapter/auth error).
 */
export async function warmUp(deps: SessionOpsDeps, siteKey: string): Promise<WarmUpResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const adapter = deps.getAdapter(siteKey);
  const acquired = await deps.browserPool.acquire(siteKey);
  const page = await acquired.context.newPage();
  try {
    await deps.ensureLoggedIn(page, adapter);
    const loggedIn = await adapter.isLoggedIn(page);
    return { siteKey, loggedIn, warmedAt: now() };
  } finally {
    await page.close().catch(() => {});
    acquired.release();
  }
}
