/**
 * Fetch a single section page using a saved storage state and dump the HTML
 * to exploration/section/ for offline analysis.
 *
 * Usage:
 *   npx tsx scripts/crawl-section.ts <sectionPath>
 *   e.g. npx tsx scripts/crawl-section.ts /section/3
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
import { logger } from '../../src/util/logger';

const config = loadSiteConfig('school-bbs');
const ui = config.selectors;

const EXPLORATION_DIR = path.join(process.cwd(), 'exploration');
const SECTION_DIR = path.join(EXPLORATION_DIR, 'section');

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
  const sectionPath = process.argv[2];
  if (!sectionPath || !sectionPath.startsWith('/')) {
    console.error('Usage: tsx scripts/crawl-section.ts <sectionPath>');
    console.error('  sectionPath must start with "/", e.g. /section/3');
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

  ensureDir(SECTION_DIR);

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({ storageState: statePath });
  const page = await ctx.newPage();

  try {
    // Build the SPA hashbang URL from the route template in site config.
    const sectionKey = sectionPath.replace(/^\/section\//, '').replace(/\/+$/, '');
    if (!sectionKey) {
      console.error('sectionPath must look like "/section/<key>"');
      process.exit(1);
    }
    const target = buildRouteUrl(baseUrl, config.routes.section, { key: sectionKey });

    logger.info({ target }, '导航到讨论区页面');
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the SPA to inject the board rows before snapshotting.
    await page.waitForSelector(ui.section.boardRowReady, { timeout: 15000 });
    // small buffer to let remaining rows finish rendering
    await page.waitForTimeout(500);

    const finalUrl = page.url();
    const title = await page.title();
    const html = normalizeHtml(await page.content());

    // file name: /section/3 -> section_3.html
    const slug = sectionPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\//g, '_');
    const htmlPath = path.join(SECTION_DIR, `${slug}.html`);
    const metaPath = path.join(SECTION_DIR, `${slug}.meta.json`);

    fs.writeFileSync(htmlPath, html, 'utf-8');
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          sectionPath,
          finalUrl,
          title,
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf-8',
    );

    logger.info({ htmlPath, metaPath, finalUrl, title }, `已保存：${htmlPath}`);
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Crawl section failed:', err);
  process.exit(1);
});
