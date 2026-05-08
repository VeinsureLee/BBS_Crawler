/**
 * Fetch the first page of a board (thread list) and dump the HTML to
 * exploration/board/ for offline analysis.
 *
 * Usage:
 *   npx tsx scripts/crawl-board.ts <boardPath>
 *   e.g. npx tsx scripts/crawl-board.ts /board/BYRatSH
 *
 * The site is a hashbang SPA, so /board/X is reached as <baseUrl>/#!board/X.
 *
 * Requires:
 *   - SCHOOL_BBS_BASE_URL in .env
 *   - .state/school-bbs.json produced by scripts/do-login.ts
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { loadSiteConfig, buildRouteUrl } from '../../src/core/site-config';

const config = loadSiteConfig('school-bbs');
const ui = config.selectors;

const EXPLORATION_DIR = path.join(process.cwd(), 'exploration');
const BOARD_DIR = path.join(EXPLORATION_DIR, 'board');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeHtml(content: string): string {
  return content
    .replace(/charset=["']?GBK["']?/i, 'charset="UTF-8"')
    .replace(/charset=["']?gb2312["']?/i, 'charset="UTF-8"')
    .replace(/></g, '>\n<')
    .replace(/\n\s*\n/g, '\n');
}

async function main() {
  const boardPath = process.argv[2];
  if (!boardPath || !boardPath.startsWith('/')) {
    console.error('Usage: tsx scripts/crawl-board.ts <boardPath>');
    console.error('  boardPath must start with "/", e.g. /board/BYRatSH');
    process.exit(1);
  }

  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) {
    console.error('SCHOOL_BBS_BASE_URL not set in .env');
    process.exit(1);
  }

  const stateDir = process.env.STORAGE_STATE_DIR || './.state';
  const statePath = path.join(stateDir, 'school-bbs.json');
  if (!fs.existsSync(statePath)) {
    console.error(`Storage state not found at ${statePath}.`);
    console.error('Run "tsx scripts/do-login.ts" first to produce it.');
    process.exit(1);
  }

  ensureDir(BOARD_DIR);

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({ storageState: statePath });
  const page = await ctx.newPage();

  try {
    const boardKey = boardPath.replace(/^\/board\//, '').replace(/\/+$/, '');
    if (!boardKey) {
      console.error('boardPath must look like "/board/<key>"');
      process.exit(1);
    }
    const target = buildRouteUrl(baseUrl, config.routes.board, { key: boardKey });

    console.log(`Navigating to board page...`);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the SPA to inject thread rows before snapshotting.
    await page.waitForSelector(ui.board.threadRowReady, { timeout: 15000 });
    await page.waitForTimeout(500);

    const finalUrl = page.url();
    const title = await page.title();
    const html = normalizeHtml(await page.content());

    const slug = boardPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\//g, '_');
    const htmlPath = path.join(BOARD_DIR, `${slug}.html`);
    const metaPath = path.join(BOARD_DIR, `${slug}.meta.json`);

    fs.writeFileSync(htmlPath, html, 'utf-8');
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          boardPath,
          finalUrl,
          title,
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf-8',
    );

    console.log(`Saved HTML  -> ${htmlPath}`);
    console.log(`Saved meta  -> ${metaPath}`);
    console.log(`Final URL: ${finalUrl}`);
    console.log(`Title:     ${title}`);
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Crawl board failed:', err);
  process.exit(1);
});
