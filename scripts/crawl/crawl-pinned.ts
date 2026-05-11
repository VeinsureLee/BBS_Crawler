/**
 * Find pinned threads on a board and dump each one's HTML to
 * exploration/pinned/ for offline analysis.
 *
 * Usage:
 *   npx tsx scripts/crawl-pinned.ts <boardKey>
 *   e.g. npx tsx scripts/crawl-pinned.ts BYRatSH
 *
 * Pinned threads are identified by `tr.top` rows on the board page.
 * If the board has no pinned threads, the script reports that and exits 0.
 *
 * Output:
 *   exploration/pinned/<boardKey>__index.json    list of pinned thread URLs
 *   exploration/pinned/<boardKey>_<id>.html      raw HTML of each pinned thread
 *
 * Requires .state/school-bbs.json from scripts/do-login.ts.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { loadSiteConfig, buildRouteUrl } from '../../src/core/site-config';
import { logger } from '../../src/util/logger';

const SITE = 'school-bbs';
const config = loadSiteConfig(SITE);
const PINNED_DIR = path.join(process.cwd(), 'exploration', 'pinned');

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
  const boardKey = process.argv[2];
  if (!boardKey) {
    console.error('Usage: tsx scripts/crawl-pinned.ts <boardKey>');
    process.exit(1);
  }

  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');

  const stateDir = process.env.STORAGE_STATE_DIR || './.state';
  const statePath = path.join(stateDir, `${SITE}.json`);
  if (!fs.existsSync(statePath)) {
    throw new Error(`Storage state not found at ${statePath}.`);
  }

  ensureDir(PINNED_DIR);

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({ storageState: statePath });
  const page = await ctx.newPage();

  try {
    const boardUrl = buildRouteUrl(baseUrl, config.routes.board, { key: boardKey });
    logger.info({ boardKey, boardUrl }, `[board] ${boardUrl}`);
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(config.selectors.board.threadRowReady, { timeout: 15000 });
    await page.waitForTimeout(500);

    // Pinned threads: <tr class="top"> rows. Each has at least one /article/<board>/<id> link.
    const pinned = await page.$$eval('tr.top', (trs) => {
      const out: Array<{ href: string; title: string }> = [];
      const seen = new Set<string>();
      for (let i = 0; i < trs.length; i++) {
        const tr = trs[i];
        const links = tr.querySelectorAll('a[href*="/article/"]');
        for (let j = 0; j < links.length; j++) {
          const a = links[j];
          const href = a.getAttribute('href') || '';
          const m = /\/article\/([^/]+)\/(\d+)(?:[/?#]|$)/.exec(href);
          if (!m) continue;
          const key = m[1] + '/' + m[2];
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ href, title: (a.textContent || '').trim() });
        }
      }
      return out;
    });

    logger.info({ boardKey, count: pinned.length }, `[board] ${boardKey}: ${pinned.length} 个置顶`);
    if (pinned.length === 0) {
      logger.info({ boardKey }, `${boardKey} 无置顶，跳过`);
      return;
    }

    const indexEntries: Array<{ articleId: string; url: string; title: string; htmlFile: string }> = [];

    for (const p of pinned) {
      const m = /\/article\/([^/]+)\/(\d+)/.exec(p.href)!;
      const articleId = m[2]!;
      // SPA route: /#!article/<board>/<id>
      const target = buildRouteUrl(baseUrl, config.routes.thread, {
        boardKey,
        threadId: articleId,
      });
      logger.info({ articleId, title: p.title, target }, `[${articleId}] ${p.title}`);
      // Force a full reload between hash routes — otherwise Playwright's
      // hash-only navigation doesn't trigger the SPA to re-render.
      await page.goto('about:blank');
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Wait for the SPA's article view to finish rendering.
      try {
        await page.waitForFunction(
          () => /^#!article\//.test(location.hash) &&
                !!document.querySelector('table.article, .a-content, .article'),
          undefined,
          { timeout: 15000 },
        );
      } catch {
        logger.warn({ articleId, target }, '帖子视图未检测到，仍保存当前已渲染内容');
      }
      await page.waitForTimeout(800);

      const html = normalizeHtml(await page.content());
      const fileName = `${boardKey}_${articleId}.html`;
      const filePath = path.join(PINNED_DIR, fileName);
      fs.writeFileSync(filePath, html, 'utf-8');

      indexEntries.push({
        articleId,
        url: page.url(),
        title: p.title,
        htmlFile: fileName,
      });
    }

    const indexPath = path.join(PINNED_DIR, `${boardKey}__index.json`);
    fs.writeFileSync(
      indexPath,
      JSON.stringify(
        {
          boardKey,
          fetchedAt: new Date().toISOString(),
          count: indexEntries.length,
          pinned: indexEntries,
        },
        null,
        2,
      ),
      'utf-8',
    );

    logger.info(
      { count: indexEntries.length, dir: PINNED_DIR, indexPath },
      `已保存 ${indexEntries.length} 个置顶帖至 ${PINNED_DIR}`,
    );
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error('crawl-pinned failed:', err);
  process.exit(1);
});
