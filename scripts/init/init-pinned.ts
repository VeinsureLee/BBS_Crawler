/**
 * Init step 3: for every board already in DB, discover its pinned threads
 * (rows with class="top" on the board page), fetch each thread across all
 * pages, and persist a cleaned record into `threads` + `posts`.
 *
 * Usage:
 *   npx tsx scripts/init-pinned.ts [siteKey] [--limit N] [--concurrency K] [--skip-done]
 *
 * Defaults to siteKey="school-bbs", concurrency from site config. --limit caps the number
 * of boards processed (handy for testing). --concurrency K runs K worker
 * pages in parallel against the same login session (overrides config). --skip-done skips boards
 * already recorded as completed in ./.init-pinned.progress.json — delete that
 * file to force a full re-crawl.
 *
 * Requires:
 *   - boards already populated by scripts/init-boards.ts
 *   - .state/<siteKey>.json from scripts/do-login.ts
 *
 * Failure handling:
 *   Boards that fail during concurrent crawl are pushed to a retry stack. After the main pass,
 *   the script retries all failed boards sequentially (and any that failed during retry)
 *   with concurrency=1 until no failures remain or a retry limit is hit.
 */
import 'dotenv/config';
import '../../src/adapters/index';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Page } from 'playwright';
import { parseConfig } from '../../src/core/config';
import { loadSiteConfig } from '../../src/core/site-config';
import { initDb, closeDb } from '../../src/repository/db';
import { getAdapter } from '../../src/core/registry';
import { listBoards } from '../../src/repository/boards';
import { upsertThread } from '../../src/repository/threads';
import { upsertPosts } from '../../src/repository/posts';

const PROGRESS_FILE = './.init-pinned.progress.json';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CliArgs {
  siteKey: string;
  limit: number | undefined;
  concurrency: number | undefined;
  skipDone: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let limit: number | undefined;
  let concurrency: number | undefined;
  let skipDone = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') {
      const v = args[i + 1];
      if (v) {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) limit = n;
      }
      i++;
    } else if (args[i] === '--concurrency') {
      const v = args[i + 1];
      if (v) {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) concurrency = n;
      }
      i++;
    } else if (args[i] === '--skip-done') {
      skipDone = true;
    } else {
      positional.push(args[i]!);
    }
  }
  return { siteKey: positional[0] ?? 'school-bbs', limit, concurrency, skipDone };
}

interface ProgressFile { [siteKey: string]: string[] }

function readProgress(): ProgressFile {
  if (!fs.existsSync(PROGRESS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8')) as ProgressFile;
  } catch {
    return {};
  }
}

function writeProgress(p: ProgressFile): void {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2), 'utf-8');
}

interface ProcessResult {
  success: boolean;
  pinned?: number;
  postsTotal?: number;
  truncated?: number;
  error?: string;
}

async function processBoard(
  page: Page,
  adapter: ReturnType<typeof getAdapter>,
  siteKey: string,
  baseUrl: string,
  boardKey: string,
  requestIntervalMs: number,
  maxPinnedThreadPages: number,
): Promise<ProcessResult> {
  try {
    const ids = await adapter.listPinnedThreadIds!(page, boardKey);
    if (ids.length === 0) return { success: true, pinned: 0, postsTotal: 0, truncated: 0 };

    let postsTotal = 0;
    let truncated = 0;
    for (const articleId of ids) {
      await sleep(requestIntervalMs);
      const url = `${baseUrl.replace(/\/+$/, '')}/article/${boardKey}/${articleId}`;
      const thread = await adapter.getThread(page, { url, maxPages: maxPinnedThreadPages });
      // Tag pinned in raw before persist.
      thread.raw = { ...(thread.raw ?? {}), pinned: true };

      const { threadId } = await upsertThread(siteKey, thread);
      await upsertPosts(threadId, thread.posts);
      postsTotal += thread.posts.length;
      const raw = thread.raw as { pageCount?: number; crawledPages?: number; truncated?: boolean };
      const pageCount = raw.pageCount ?? 1;
      const crawledPages = raw.crawledPages ?? pageCount;
      const wasTruncated = raw.truncated ?? false;
      if (wasTruncated) truncated++;
      console.log(
        `    [${articleId}] "${thread.title}" — ${thread.posts.length} posts across ${crawledPages}/${pageCount} page(s)${wasTruncated ? ' [TRUNCATED]' : ''}`,
      );
    }
    return { success: true, pinned: ids.length, postsTotal, truncated };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

interface BoardWithKey {
  boardKey: string;
  id?: number;
}

async function runPass(
  boards: BoardWithKey[],
  ctx: any,
  adapter: ReturnType<typeof getAdapter>,
  siteKey: string,
  baseUrl: string,
  requestIntervalMs: number,
  maxPinnedThreadPages: number,
  stats: { boardsWithPinned: number; totalPinned: number; totalPosts: number; totalTruncated: number; },
  doneSet: Set<string>,
  progress: ProgressFile,
  recordDone: (boardKey: string) => void,
  concurrency: number,
  passLabel: string,
): Promise<BoardWithKey[]> {
  const failed: BoardWithKey[] = [];
  let nextIdx = 0;
  const total = boards.length;

  if (total === 0) return failed;

  const runWorker = async (workerId: number, page: Page): Promise<void> => {
    while (true) {
      const i = nextIdx++;
      if (i >= total) return;
      const b = boards[i]!;
      const result = await processBoard(
        page, adapter, siteKey, baseUrl, b.boardKey, requestIntervalMs, maxPinnedThreadPages,
      );
      if (result.success) {
        if (result.pinned === 0) {
          console.log(`[${passLabel} w${workerId} ${i + 1}/${total}] ${b.boardKey}: 0 pinned`);
        } else {
          stats.boardsWithPinned++;
          stats.totalPinned += result.pinned!;
          stats.totalPosts += result.postsTotal!;
          stats.totalTruncated += result.truncated!;
          console.log(
            `[${passLabel} w${workerId} ${i + 1}/${total}] ${b.boardKey}: ${result.pinned} pinned, ${result.postsTotal} posts${result.truncated > 0 ? ` (${result.truncated} truncated)` : ''}`,
          );
        }
        recordDone(b.boardKey);
      } else {
        console.error(
          `[${passLabel} w${workerId} ${i + 1}/${total}] ${b.boardKey} FAILED:`,
          result.error,
        );
        failed.push(b);
      }
      await sleep(requestIntervalMs);
    }
  };

  const pages: Page[] = [];
  for (let k = 0; k < concurrency; k++) pages.push(await ctx.newPage());
  await Promise.all(pages.map((p, i) => runWorker(i + 1, p)));
  // Clean up pages after pass
  for (const p of pages) await p.close();

  return failed;
}

async function main() {
  const { siteKey, limit, concurrency: concurrencyOverride, skipDone } = parseArgs();
  const cfg = parseConfig(process.env);
  const siteConfig = loadSiteConfig(siteKey);
  initDb(cfg.pgDataDir);

  const adapter = getAdapter(siteKey);
  if (!adapter.listPinnedThreadIds || !adapter.getThread) {
    throw new Error(`Adapter "${siteKey}" missing listPinnedThreadIds or getThread`);
  }
  const baseUrl = adapter.baseUrl;
  if (!baseUrl) throw new Error(`Adapter "${siteKey}" has empty baseUrl`);

  const concurrency = concurrencyOverride ?? siteConfig.crawl.concurrency;
  const requestIntervalMs = siteConfig.crawl.requestIntervalMs;
  const maxPinnedThreadPages = siteConfig.crawl.maxPinnedThreadPages;
  const maxRetryPasses = siteConfig.crawl.maxRetryPasses;

  let boards = await listBoards(siteKey);
  const progress = readProgress();
  const doneSet = new Set<string>(progress[siteKey] ?? []);
  const skipped: string[] = [];
  if (skipDone && doneSet.size > 0) {
    boards = boards.filter((b) => {
      if (doneSet.has(b.boardKey)) {
        skipped.push(b.boardKey);
        return false;
      }
      return true;
    });
  }
  if (limit) boards = boards.slice(0, limit);
  if (boards.length === 0) {
    if (skipped.length > 0) {
      console.log(`All boards already done (${skipped.length} skipped). Nothing to do.`);
      return;
    }
    throw new Error(`No boards in DB for ${siteKey}. Run init:boards first.`);
  }
  if (skipped.length > 0) {
    console.log(`--skip-done: skipping ${skipped.length} already-done boards`);
  }

  const statePath = path.join(cfg.storageStateDir, `${siteKey}.json`);
  if (!fs.existsSync(statePath)) {
    throw new Error(`Storage state not found at ${statePath}.`);
  }

  const browser = await chromium.launch({
    headless: cfg.browserHeadless,
    executablePath: cfg.browserExecutablePath,
  });
  const ctx = await browser.newContext({
    storageState: statePath,
    userAgent: cfg.browserUserAgent,
  });

  const stats = { boardsWithPinned: 0, totalPinned: 0, totalPosts: 0, totalTruncated: 0 };

  const recordDone = (boardKey: string): void => {
    doneSet.add(boardKey);
    progress[siteKey] = [...doneSet];
    try { writeProgress(progress); }
    catch (e) { console.warn('progress write failed:', (e as Error).message); }
  };

  console.log(`Starting main pass with concurrency=${concurrency} over ${boards.length} boards (max ${maxPinnedThreadPages} pages/thread)`);
  let failedBoards: BoardWithKey[] = [];
  try {
    // Main pass with requested concurrency
    failedBoards = await runPass(
      boards, ctx, adapter, siteKey, baseUrl, requestIntervalMs, maxPinnedThreadPages,
      stats, doneSet, progress, recordDone, concurrency, 'main',
    );

    // Retry passes with concurrency=1
    let retryPass = 0;
    while (failedBoards.length > 0 && retryPass < maxRetryPasses) {
      retryPass++;
      console.log(
        `\n=== Retry pass ${retryPass}/${maxRetryPasses}: ${failedBoards.length} failed boards with concurrency=1`,
      );
      const boardsToRetry = [...failedBoards];
      failedBoards = await runPass(
        boardsToRetry, ctx, adapter, siteKey, baseUrl, requestIntervalMs, maxPinnedThreadPages,
        stats, doneSet, progress, recordDone, 1, `retry${retryPass}`,
      );
    }

    if (failedBoards.length > 0) {
      console.log(
        `\nWARNING: ${failedBoards.length} boards still failed after ${maxRetryPasses} retries:`,
      );
      for (const b of failedBoards) {
        console.log(`  - ${b.boardKey}`);
      }
    }

    console.log(
      `\nDone. ${stats.boardsWithPinned}/${boards.length} boards had pinned threads. ` +
        `${stats.totalPinned} threads, ${stats.totalPosts} posts persisted. ` +
        (stats.totalTruncated > 0 ? `${stats.totalTruncated} long threads truncated to ${maxPinnedThreadPages} pages.` : ''),
    );
  } finally {
    await ctx.close();
    await browser.close();
    await closeDb();
  }
}

main().catch((err) => {
  console.error('init-pinned failed:', err);
  process.exit(1);
});