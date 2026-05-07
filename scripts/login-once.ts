import 'dotenv/config';
import { parseConfig } from '../src/core/config.js';
import { BrowserPool } from '../src/core/browser-pool.js';
import { AuthManager } from '../src/core/auth-manager.js';
import { getAdapter } from '../src/core/registry.js';
import { addRedactedSecret } from '../src/util/logger.js';
import '../src/adapters/index.js';

const siteKey = process.argv[2];
if (!siteKey) {
  // eslint-disable-next-line no-console
  console.error('usage: tsx scripts/login-once.ts <siteKey>');
  process.exit(2);
}

const cfg = parseConfig(process.env);
const pool = new BrowserPool({
  headless: false, // visible browser so the human can observe
  executablePath: cfg.browserExecutablePath,
  userAgent: cfg.browserUserAgent,
  storageStateDir: cfg.storageStateDir,
  idleTimeoutMs: cfg.idleTimeoutMs,
});

(async () => {
  const adapter = getAdapter(siteKey);
  const auth = new AuthManager({
    env: process.env,
    saveStorageState: async (k) => {
      const ctx = await pool.acquire(k);
      try { await ctx.saveStorageState(); } finally { ctx.release(); }
    },
    addRedactedSecret,
  });
  const ctx = await pool.acquire(siteKey);
  try {
    const page = await ctx.context.newPage();
    try { await auth.ensureLoggedIn(page, adapter); }
    finally { await page.close().catch(() => {}); }
    // eslint-disable-next-line no-console
    console.log(`storageState saved for ${siteKey} -> ${pool.storageStatePathFor(siteKey)}`);
  } finally {
    ctx.release();
    await pool.close();
  }
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('login-once failed:', err);
  process.exit(1);
});
