/**
 * Debug a single board - show exactly what's happening
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { loadSiteConfig, buildRouteUrl } from '../../src/core/site-config';
import { parseConfig } from '../../src/core/config';

const siteKey = 'school-bbs';
const cfg = loadSiteConfig(siteKey);
const appCfg = parseConfig(process.env);

const DEBUG_DIR = path.join(process.cwd(), 'exploration', 'debug');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeHtml(content: string): string {
  return content
    .replace(/charset=["']?GBK["']?/ig, 'charset="UTF-8"')
    .replace(/charset=["']?gb2312["']?/ig, 'charset="UTF-8"');
}

async function debugBoard(page: any, baseUrl: string, boardKey: string) {
  console.log(`\n========== DEBUGGING BOARD: ${boardKey} ==========`);

  const target = buildRouteUrl(baseUrl, cfg.routes.board, { key: boardKey });
  console.log(`[1/6] Navigating to: ${target}`);

  await page.goto('about:blank');
  console.log(`[2/6] Gone to about:blank`);

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`[3/6] Page loaded, current URL: ${page.url()}`);

  // Check what the hash is
  const hash = await page.evaluate(() => window.location.hash);
  console.log(`       Hash: ${hash}`);

  // Save HTML before waiting
  const html1 = normalizeHtml(await page.content());
  fs.writeFileSync(path.join(DEBUG_DIR, `${boardKey}-before-wait.html`), html1, 'utf-8');
  console.log(`[4/6] Saved HTML (before wait) to debug/${boardKey}-before-wait.html`);

  // Check if the selector exists right now
  const selector = cfg.selectors.board.threadRowReady;
  const existsNow = await page.$(selector).catch(() => null);
  console.log(`       Selector "${selector}" exists right now: ${!!existsNow}`);

  console.log(`[5/6] Waiting for selector (timeout 15s)...`);
  try {
    await page.waitForSelector(selector, { timeout: 15000 });
    console.log(`       SUCCESS: Selector found!`);
  } catch (e) {
    console.log(`       FAILED: ${(e as Error).message}`);
    // Save HTML after failure
    const html2 = normalizeHtml(await page.content());
    fs.writeFileSync(path.join(DEBUG_DIR, `${boardKey}-after-timeout.html`), html2, 'utf-8');
    console.log(`       Saved HTML (after timeout) to debug/${boardKey}-after-timeout.html`);

    // List all links on page
    const allLinks = await page.$$eval('a', (anchors: any[]) =>
      anchors.map((a: any) => a.getAttribute('href')).filter(Boolean)
    );
    console.log(`\nAll links on page (first 30):`);
    console.log(allLinks.slice(0, 30));

    // Check what's in the body
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
    console.log(`\nBody text preview:\n${bodyText}\n`);

    throw e;
  }

  await page.waitForTimeout(300);

  const ids = await page.$$eval('tr.top', (trs) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < trs.length; i++) {
      const links = trs[i].querySelectorAll('a[href*="/article/"]');
      for (let j = 0; j < links.length; j++) {
        const href = links[j].getAttribute('href') || '';
        const m = /\/article\/[^/]+\/(\d+)(?:[/?#]|$)/.exec(href);
        if (!m) continue;
        const id = m[1]!;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  });

  console.log(`[6/6] Found pinned thread IDs:`, ids);
  return ids;
}

async function main() {
  const boardKey = process.argv[2];
  if (!boardKey) {
    console.error('Usage: npx tsx scripts/debug-board.ts SL');
    process.exit(1);
  }

  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');

  ensureDir(DEBUG_DIR);

  const statePath = path.join(appCfg.storageStateDir, `${siteKey}.json`);
  if (!fs.existsSync(statePath)) {
    throw new Error(`Storage state not found at ${statePath}. Run do-login first.`);
  }

  const browser = await chromium.launch({
    headless: false, // 有头模式看发生了什么
    slowMo: 100, // 稍微慢一点，方便观察
    ...(appCfg.browserExecutablePath ? { executablePath: appCfg.browserExecutablePath } : {}),
  });
  const ctx = await browser.newContext({
    storageState: statePath,
    ...(appCfg.browserUserAgent ? { userAgent: appCfg.browserUserAgent } : {}),
  });
  const page = await ctx.newPage();

  try {
    await debugBoard(page, baseUrl, boardKey);
    console.log('\nSUCCESS! Keep browser open for inspection...');
    console.log('Press Ctrl+C to exit');
    await new Promise(() => {});
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error('\nERROR:', e);
  process.exit(1);
});
