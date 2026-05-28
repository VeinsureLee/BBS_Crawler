import { describe, it, expect, vi } from 'vitest';
import { BrowserPool } from '../../../src/session/browser-pool';

function mockBrowserAndCtx() {
  const ctx = { close: vi.fn(async () => {}), newPage: vi.fn(), storageState: vi.fn() };
  const browser = { newContext: vi.fn(async () => ctx), close: vi.fn(async () => {}) };
  return { browser, ctx };
}

describe('BrowserPool idle close', () => {
  it('does NOT schedule idle close when idleTimeoutMs is 0', async () => {
    const { browser } = mockBrowserAndCtx();
    const launcher = vi.fn(async () => browser as any);
    const pool = new BrowserPool({
      headless: true,
      storageStateDir: '/tmp/x',
      idleTimeoutMs: 0,
      launcher,
    });
    const acq = await pool.acquire('s');
    acq.release();
    expect((pool as any).idleTimer).toBeNull();
    expect(browser.close).not.toHaveBeenCalled();
  });

  it('DOES schedule idle close when idleTimeoutMs > 0', async () => {
    const { browser } = mockBrowserAndCtx();
    const launcher = vi.fn(async () => browser as any);
    const pool = new BrowserPool({
      headless: true,
      storageStateDir: '/tmp/x',
      idleTimeoutMs: 100,
      launcher,
    });
    const acq = await pool.acquire('s');
    acq.release();
    try {
      expect((pool as any).idleTimer).not.toBeNull();
    } finally {
      if ((pool as any).idleTimer) clearTimeout((pool as any).idleTimer);
    }
  });
});
