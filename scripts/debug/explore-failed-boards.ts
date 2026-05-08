/**
 * Explore failed boards to see what their pages look like
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

const EXPLORE_DIR = path.join(process.cwd(), 'exploration', 'failed-boards');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeHtml(content: string): string {
  return content
    .replace(/charset=["']?GBK["']?/ig, 'charset="UTF-8"')
    .replace(/charset=["']?gb2312["']?/ig, 'charset="UTF-8"')
    .replace(/>/g, '>\n')
    .replace(/\n\s*\n/g, '\n');
}

async function exploreBoard(page: any, baseUrl: string, boardKey: string) {
  const target = buildRouteUrl(baseUrl, cfg.routes.board, { key: boardKey });
  console.log(`\n[${boardKey}] Navigating to: ${target}`);

  await page.goto('about:blank');
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait a bit for SPA to render
  await page.waitForTimeout(2000);

  const html = normalizeHtml(await page.content());
  const htmlPath = path.join(EXPLORE_DIR, `${boardKey}.html`);
  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log(`[${boardKey}] Saved HTML to: ${htmlPath}`);

  // Check for common elements
  const hasArticleLinks = await page.$('a[href^="/article/"]').catch(() => false);
  const hasBoardList = await page.$('table.board-list').catch(() => false);
  const hasTopRows = await page.$('tr.top').catch(() => false);
  const currentUrl = page.url();

  console.log(`[${boardKey}] URL: ${currentUrl}`);
  console.log(`[${boardKey}] Has article links: ${!!hasArticleLinks}`);
  console.log(`[${boardKey}] Has board-list: ${!!hasBoardList}`);
  console.log(`[${boardKey}] Has top rows: ${!!hasTopRows}`);

  // Try to find any links
  const allLinks = await page.$$eval('a', (anchors: any[]) =>
    anchors.slice(0, 20).map((a: any) => ({
      href: a.getAttribute('href'),
      text: (a.textContent || '').trim().slice(0, 50),
    }))
  );
  console.log(`[${boardKey}] Sample links:`, allLinks);
}

async function main() {
  const boardKeys = process.argv.slice(2);
  if (boardKeys.length === 0) {
    console.error('Usage: npx tsx scripts/explore-failed-boards.ts SL STE Music Constellations Shuttlecock');
    process.exit(1);
  }

  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');

  ensureDir(EXPLORE_DIR);

  const statePath = path.join(appCfg.storageStateDir, `${siteKey}.json`);
  if (!fs.existsSync(statePath)) {
    throw new Error(`Storage state not found at ${statePath}. Run do-login first.`);
  }

  const browser = await chromium.launch({
    headless: false, // 有头模式，方便观察
    executablePath: appCfg.browserExecutablePath,
  });
  const ctx = await browser.newContext({
    storageState: statePath,
    userAgent: appCfg.browserUserAgent,
  });
  const page = await ctx.newPage();

  try {
    for (const boardKey of boardKeys) {
      await exploreBoard(page, baseUrl, boardKey);
      await page.waitForTimeout(1000);
    }

    console.log('\nDone! Check exploration/failed-boards/ for HTML files.');
    console.log('Press Ctrl+C or close browser to exit...');
    await new Promise(() => {}); // Keep open
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
