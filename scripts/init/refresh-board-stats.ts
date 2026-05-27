/**
 * Lightweight refresh of per-board stats (online / today_posts / threads /
 * posts) for sections already in DB. Visits one section page per request, no
 * thread crawling. Writes both:
 *   - nodes.stats (overwrite, "current snapshot")
 *   - daily_traffic (per-board per-day row, last-write-wins same day)
 *
 * Usage:
 *   npx tsx scripts/init/refresh-board-stats.ts [siteKey] --all
 *   npx tsx scripts/init/refresh-board-stats.ts [siteKey] --section <sectionKey>
 *   npx tsx scripts/init/refresh-board-stats.ts [siteKey] --board <boardName>
 *
 * Defaults to siteKey="school-bbs". Requires:
 *   - Sections + boards already populated (run init first)
 *   - .state/<siteKey>.json from scripts/auth/do-login.ts
 */
import 'dotenv/config';
import '../../src/adapters/index';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import { parseConfig } from '../../src/config/app-config';
import { initDb, closeAllDbs } from '../../src/repository/db';
import { runRefreshBoardStats, type RefreshBoardStatsOpts } from '../../src/core/init-runners';
import { logger } from '../../src/util/logger';

function parseArgs(argv: string[]): { siteKey: string; opts: RefreshBoardStatsOpts } {
  // Positional siteKey is optional. Everything else is --flag form.
  let siteKey = 'school-bbs';
  const opts: RefreshBoardStatsOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--all') {
      opts.all = true;
    } else if (a === '--section') {
      opts.sectionKey = argv[++i];
    } else if (a === '--board') {
      opts.boardName = argv[++i];
    } else if (!a.startsWith('--')) {
      siteKey = a;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return { siteKey, opts };
}

function usage(): never {
  console.error('Usage:');
  console.error('  tsx scripts/init/refresh-board-stats.ts [siteKey] --all');
  console.error('  tsx scripts/init/refresh-board-stats.ts [siteKey] --section <sectionKey>');
  console.error('  tsx scripts/init/refresh-board-stats.ts [siteKey] --board <boardName>');
  process.exit(1);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e));
    usage();
  }
  const { siteKey, opts } = parsed;
  if (!opts.all && !opts.sectionKey && !opts.boardName) usage();

  const cfg = parseConfig(process.env);
  initDb({ dataDir: cfg.dataDir });

  const statePath = path.join(cfg.storageStateDir, `${siteKey}.json`);
  if (!fs.existsSync(statePath)) {
    throw new Error(`Storage state not found at ${statePath}. Run "npm run login" first.`);
  }

  const browser = await chromium.launch({
    headless: cfg.browserHeadless,
    ...(cfg.browserExecutablePath ? { executablePath: cfg.browserExecutablePath } : {}),
  });
  const ctx = await browser.newContext({
    storageState: statePath,
    ...(cfg.browserUserAgent ? { userAgent: cfg.browserUserAgent } : {}),
  });
  const page = await ctx.newPage();

  const startedAt = Date.now();
  logger.info({ siteKey, opts, script: 'refresh-board-stats' }, 'refresh: 开始');
  try {
    const result = await runRefreshBoardStats(page, siteKey, opts);
    logger.info(
      { siteKey, ...result, elapsedMs: Date.now() - startedAt },
      `refresh: 完成（访问 ${result.sectionsVisited} 个 section、更新 ${result.boardsUpdated} 个版面）`,
    );
  } finally {
    await ctx.close();
    await browser.close();
    await closeAllDbs();
  }
}

main().catch((err) => {
  console.error('refresh-board-stats failed:', err);
  process.exit(1);
});
