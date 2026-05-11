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
import { initDbs, closeDbs, getStructureDb } from '../../src/repository/db';
import { getAdapter } from '../../src/core/registry';
import { listBoards } from '../../src/repository/boards';
import { upsertThread } from '../../src/repository/threads';
import { upsertPosts } from '../../src/repository/posts';
import { logger } from '../../src/util/logger';

/**
 * Per-forum progress aggregator. Logs a structured snapshot every N seconds
 * so the operator can see "本站站务 23/58, 北邮校园 0/2, ..." live.
 *
 * Retry-safe: each board's outcome (pinned/plain/failed) is tracked; if the
 * same board reappears (e.g., main pass failure → retry pass success), the
 * previous outcome is reverted before applying the new one.
 */
interface ForumStat {
  forumKey: string;
  forumName: string;
  total: number;
  done: number;
  pinned: number;
  failed: number;
}

class ProgressReporter {
  private forums = new Map<string, ForumStat>();
  private boardToForum = new Map<string, string>();
  private boardOutcomes = new Map<string, 'pinned' | 'plain' | 'failed'>();
  private orphans = 0;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = Date.now();

  async init(siteKey: string): Promise<void> {
    const r = await getStructureDb().query<{ board_key: string; forum_key: string; forum_name: string }>(
      `WITH RECURSIVE up(board_id, ancestor_id, depth) AS (
         SELECT b.id, b.parent_id, 0 FROM nodes b
          WHERE b.site_key = $1 AND b.type = 'board'
         UNION ALL
         SELECT u.board_id, n.parent_id, u.depth + 1
           FROM up u JOIN nodes n ON n.id = u.ancestor_id
          WHERE u.ancestor_id IS NOT NULL
            AND n.parent_id <> u.ancestor_id
            AND u.depth < 20
       )
       SELECT b.node_key AS board_key, f.node_key AS forum_key, f.name AS forum_name
         FROM nodes b
         JOIN up u ON u.board_id = b.id
         JOIN nodes f ON f.id = u.ancestor_id AND f.type = 'forum'
        WHERE b.site_key = $1 AND b.type = 'board'`,
      [siteKey],
    );
    for (const row of r.rows) {
      this.boardToForum.set(row.board_key, row.forum_key);
      const existing = this.forums.get(row.forum_key);
      if (existing) {
        existing.total++;
      } else {
        this.forums.set(row.forum_key, {
          forumKey: row.forum_key,
          forumName: row.forum_name,
          total: 1,
          done: 0,
          pinned: 0,
          failed: 0,
        });
      }
    }
  }

  private apply(boardKey: string, newStatus: 'pinned' | 'plain' | 'failed'): void {
    const fk = this.boardToForum.get(boardKey);
    if (!fk) {
      this.orphans++;
      return;
    }
    const s = this.forums.get(fk);
    if (!s) return;
    const prev = this.boardOutcomes.get(boardKey);
    if (!prev) {
      s.done++;
    } else {
      if (prev === 'pinned') s.pinned--;
      if (prev === 'failed') s.failed--;
    }
    if (newStatus === 'pinned') s.pinned++;
    if (newStatus === 'failed') s.failed++;
    this.boardOutcomes.set(boardKey, newStatus);
  }

  recordSuccess(boardKey: string, hadPinned: boolean): void {
    this.apply(boardKey, hadPinned ? 'pinned' : 'plain');
  }

  recordFailure(boardKey: string): void {
    this.apply(boardKey, 'failed');
  }

  start(intervalMs: number = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.emit('tick'), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit('final');
  }

  private emit(stage: 'tick' | 'final'): void {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    let totalAll = 0, doneAll = 0, pinnedAll = 0, failedAll = 0;
    const perForum: Record<string, { name: string; done: number; total: number; pinned: number; failed: number }> = {};
    const lines: string[] = [];
    for (const [, s] of this.forums) {
      totalAll += s.total;
      doneAll += s.done;
      pinnedAll += s.pinned;
      failedAll += s.failed;
      perForum[s.forumKey] = { name: s.forumName, done: s.done, total: s.total, pinned: s.pinned, failed: s.failed };
      lines.push(`${s.forumName} ${s.done}/${s.total}${s.pinned > 0 ? ` pin=${s.pinned}` : ''}${s.failed > 0 ? ` fail=${s.failed}` : ''}`);
    }
    const pct = totalAll > 0 ? Math.floor((doneAll / totalAll) * 100) : 0;
    logger.info(
      { stage: `progress.${stage}`, elapsed, totalAll, doneAll, pinnedAll, failedAll, orphans: this.orphans, perForum },
      `进度 ${doneAll}/${totalAll} (${pct}%) elapsed=${elapsed}s${pinnedAll > 0 ? ` pinned=${pinnedAll}` : ''}${failedAll > 0 ? ` failed=${failedAll}` : ''}${this.orphans > 0 ? ` orphans=${this.orphans}` : ''} | ${lines.join(' | ')}`,
    );
  }
}

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

const USAGE = `Usage: npm run init:pinned -- [siteKey] [--limit N] [--concurrency K] [--skip-done]
  siteKey            default "school-bbs"
  --limit N          cap the number of boards processed (testing)
  --concurrency K    parallel workers (default from site config)
  --skip-done        skip boards already recorded in ./.init-pinned.progress.json`;

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let limit: number | undefined;
  let concurrency: number | undefined;
  let skipDone = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--limit') {
      const v = args[i + 1];
      if (v) {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) limit = n;
      }
      i++;
    } else if (a === '--concurrency') {
      const v = args[i + 1];
      if (v) {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) concurrency = n;
      }
      i++;
    } else if (a === '--skip-done') {
      skipDone = true;
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith('--') || a.startsWith('-')) {
      console.error(`Unknown flag: ${a}\n\n${USAGE}`);
      process.exit(1);
    } else {
      positional.push(a);
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
    logger.info({ boardKey }, `[${boardKey}] step 1: listPinnedThreadIds 开始`);
    const ids = await adapter.listPinnedThreadIds!(page, boardKey);
    logger.info({ boardKey, found: ids.length }, `[${boardKey}] step 1: listPinnedThreadIds 返回 ${ids.length} 个`);
    if (ids.length === 0) return { success: true, pinned: 0, postsTotal: 0, truncated: 0 };

    let postsTotal = 0;
    let truncated = 0;
    for (const articleId of ids) {
      await sleep(requestIntervalMs);
      const url = `${baseUrl.replace(/\/+$/, '')}/article/${boardKey}/${articleId}`;
      logger.info({ boardKey, articleId, url }, `[${boardKey}/${articleId}] step 2: getThread 开始`);
      const thread = await adapter.getThread(page, { url, maxPages: maxPinnedThreadPages });
      logger.info({ boardKey, articleId, posts: thread.posts.length }, `[${boardKey}/${articleId}] step 2: getThread 返回 ${thread.posts.length} 楼`);
      // Tag pinned in raw before persist.
      thread.raw = { ...(thread.raw ?? {}), pinned: true };

      logger.info({ boardKey, articleId }, `[${boardKey}/${articleId}] step 3: upsertThread 开始`);
      const { threadId, forumDb } = await upsertThread(siteKey, thread, { isPinned: true });
      logger.info({ boardKey, articleId, threadId }, `[${boardKey}/${articleId}] step 3: upsertThread 完成 threadId=${threadId}`);

      logger.info({ boardKey, articleId, threadId, posts: thread.posts.length }, `[${boardKey}/${articleId}] step 4: upsertPosts 开始`);
      await upsertPosts(forumDb, threadId, thread.posts);
      logger.info({ boardKey, articleId, threadId }, `[${boardKey}/${articleId}] step 4: upsertPosts 完成`);

      postsTotal += thread.posts.length;
      const raw = thread.raw as { pageCount?: number; crawledPages?: number; truncated?: boolean };
      const pageCount = raw.pageCount ?? 1;
      const crawledPages = raw.crawledPages ?? pageCount;
      const wasTruncated = raw.truncated ?? false;
      if (wasTruncated) truncated++;
      logger.info(
        {
          boardKey,
          articleId,
          title: thread.title,
          posts: thread.posts.length,
          crawledPages,
          pageCount,
          truncated: wasTruncated,
        },
        `置顶帖入库 [${articleId}] "${thread.title}" — ${thread.posts.length} 楼 / ${crawledPages}/${pageCount} 页${wasTruncated ? ' (截断)' : ''}`,
      );
    }
    return { success: true, pinned: ids.length, postsTotal, truncated };
  } catch (err) {
    logger.error({ boardKey, err: String(err) }, `[${boardKey}] processBoard 抛错: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
}

interface BoardWithKey {
  boardKey: string;
  id?: number;
}

class BrowserDeadError extends Error {
  constructor(public readonly cause: string) {
    super(`Browser/context died mid-run: ${cause}`);
  }
}

function isBrowserDeadError(msg: string | undefined): boolean {
  if (!msg) return false;
  return /(?:browser|context|target page).*(?:closed|crashed|disconnected)/i.test(msg)
      || /Target closed/i.test(msg);
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
  reporter: ProgressReporter,
): Promise<BoardWithKey[]> {
  const failed: BoardWithKey[] = [];
  let nextIdx = 0;
  const total = boards.length;
  let browserDeadCause: string | null = null;

  if (total === 0) return failed;

  const runWorker = async (workerId: number, page: Page): Promise<void> => {
    logger.info({ workerId, pass: passLabel }, `[${passLabel}] worker ${workerId} 启动`);
    while (true) {
      if (browserDeadCause) {
        logger.warn({ workerId, pass: passLabel }, `[${passLabel}] worker ${workerId} 浏览器已死，退出`);
        return;
      }
      const i = nextIdx++;
      if (i >= total) {
        logger.info({ workerId, pass: passLabel }, `[${passLabel}] worker ${workerId} 队列空，退出`);
        return;
      }
      const b = boards[i]!;
      logger.info(
        { workerId, idx: i + 1, total, boardKey: b.boardKey, pass: passLabel },
        `[${passLabel} w${workerId} ${i + 1}/${total}] 开始处理 ${b.boardKey}`,
      );
      const result = await processBoard(
        page, adapter, siteKey, baseUrl, b.boardKey, requestIntervalMs, maxPinnedThreadPages,
      );
      if (result.success) {
        if (result.pinned === 0) {
          logger.info(
            { pass: passLabel, worker: workerId, idx: i + 1, total, boardKey: b.boardKey, pinned: 0 },
            `[${passLabel} w${workerId} ${i + 1}/${total}] ${b.boardKey}: 0 置顶`,
          );
          reporter.recordSuccess(b.boardKey, false);
        } else {
          stats.boardsWithPinned++;
          stats.totalPinned += result.pinned!;
          stats.totalPosts += result.postsTotal!;
          stats.totalTruncated += result.truncated!;
          logger.info(
            {
              pass: passLabel,
              worker: workerId,
              idx: i + 1,
              total,
              boardKey: b.boardKey,
              pinned: result.pinned,
              posts: result.postsTotal,
              truncated: result.truncated,
            },
            `[${passLabel} w${workerId} ${i + 1}/${total}] ${b.boardKey}: ${result.pinned} 置顶, ${result.postsTotal} 楼${result.truncated! > 0 ? ` (${result.truncated} 截断)` : ''}`,
          );
          reporter.recordSuccess(b.boardKey, true);
        }
        recordDone(b.boardKey);
      } else {
        if (isBrowserDeadError(result.error)) {
          // First worker to see this sets the flag; others will skip the
          // remaining boards. Don't count this board as "failed" — its
          // status is "didn't get a chance".
          if (!browserDeadCause) {
            browserDeadCause = result.error ?? 'unknown';
            logger.error(
              { pass: passLabel, worker: workerId, boardKey: b.boardKey, err: result.error },
              `[${passLabel}] 浏览器/context 已关闭，中止剩余 worker。原因: ${result.error}`,
            );
          }
          // Leave this board unprocessed (it'll be retried on next run with --skip-done).
          return;
        }
        logger.error(
          {
            pass: passLabel,
            worker: workerId,
            idx: i + 1,
            total,
            boardKey: b.boardKey,
            err: result.error,
          },
          `[${passLabel} w${workerId} ${i + 1}/${total}] ${b.boardKey} 失败: ${result.error}`,
        );
        reporter.recordFailure(b.boardKey);
        failed.push(b);
      }
      await sleep(requestIntervalMs);
    }
  };

  logger.info({ concurrency, pass: passLabel }, `[${passLabel}] 开始打开 ${concurrency} 个 page`);
  const pages: Page[] = [];
  for (let k = 0; k < concurrency; k++) {
    pages.push(await ctx.newPage());
    logger.info({ pass: passLabel, opened: k + 1, total: concurrency }, `[${passLabel}] page ${k + 1}/${concurrency} 打开成功`);
  }
  logger.info({ concurrency, pass: passLabel, boards: total }, `[${passLabel}] 全部 page 就绪，启动 worker`);
  await Promise.all(pages.map((p, i) => runWorker(i + 1, p)));
  // Clean up pages after pass (best-effort — browser may already be dead)
  for (const p of pages) await p.close().catch(() => {});

  if (browserDeadCause) {
    throw new BrowserDeadError(browserDeadCause);
  }

  return failed;
}

async function main() {
  const { siteKey, limit, concurrency: concurrencyOverride, skipDone } = parseArgs();
  const cfg = parseConfig(process.env);
  const siteConfig = loadSiteConfig(siteKey);
  initDbs({ dataDir: cfg.dataDir });

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
      logger.info({ siteKey, skipped: skipped.length }, `所有版面均已完成（跳过 ${skipped.length} 个）`);
      return;
    }
    throw new Error(`No boards in DB for ${siteKey}. Run init:boards first.`);
  }
  if (skipped.length > 0) {
    logger.info({ siteKey, skipped: skipped.length }, `--skip-done: 跳过 ${skipped.length} 个已完成版面`);
  }

  const statePath = path.join(cfg.storageStateDir, `${siteKey}.json`);
  if (!fs.existsSync(statePath)) {
    throw new Error(`Storage state not found at ${statePath}.`);
  }

  const browser = await chromium.launch({
    headless: cfg.browserHeadless,
    ...(cfg.browserExecutablePath ? { executablePath: cfg.browserExecutablePath } : {}),
  });
  const ctx = await browser.newContext({
    storageState: statePath,
    ...(cfg.browserUserAgent ? { userAgent: cfg.browserUserAgent } : {}),
  });

  const stats = { boardsWithPinned: 0, totalPinned: 0, totalPosts: 0, totalTruncated: 0 };

  const recordDone = (boardKey: string): void => {
    doneSet.add(boardKey);
    progress[siteKey] = [...doneSet];
    try { writeProgress(progress); }
    catch (e) { logger.warn({ err: (e as Error).message, boardKey }, '进度文件写入失败'); }
  };

  const startedAt = Date.now();
  logger.info(
    {
      siteKey,
      script: 'init-pinned',
      boards: boards.length,
      concurrency,
      maxPinnedThreadPages,
    },
    `init-pinned: 开始（并发=${concurrency}, ${boards.length} 个版面, 每帖最多 ${maxPinnedThreadPages} 页）`,
  );

  const reporter = new ProgressReporter();
  await reporter.init(siteKey);
  reporter.start(5000);

  let failedBoards: BoardWithKey[] = [];
  let browserDied = false;
  try {
    // Main pass with requested concurrency
    failedBoards = await runPass(
      boards, ctx, adapter, siteKey, baseUrl, requestIntervalMs, maxPinnedThreadPages,
      stats, doneSet, progress, recordDone, concurrency, 'main', reporter,
    );

    // Retry passes with concurrency=1
    let retryPass = 0;
    while (failedBoards.length > 0 && retryPass < maxRetryPasses) {
      retryPass++;
      logger.info(
        { retryPass, maxRetryPasses, failed: failedBoards.length },
        `=== 重试轮 ${retryPass}/${maxRetryPasses}: ${failedBoards.length} 个失败版面，并发=1`,
      );
      const boardsToRetry = [...failedBoards];
      failedBoards = await runPass(
        boardsToRetry, ctx, adapter, siteKey, baseUrl, requestIntervalMs, maxPinnedThreadPages,
        stats, doneSet, progress, recordDone, 1, `retry${retryPass}`, reporter,
      );
    }

    if (failedBoards.length > 0) {
      logger.warn(
        { failedBoards: failedBoards.map((b) => b.boardKey), maxRetryPasses },
        `${failedBoards.length} 个版面经 ${maxRetryPasses} 轮重试仍失败`,
      );
    }

    logger.info(
      {
        siteKey,
        boards: boards.length,
        boardsWithPinned: stats.boardsWithPinned,
        threads: stats.totalPinned,
        posts: stats.totalPosts,
        truncated: stats.totalTruncated,
        maxPinnedThreadPages,
        elapsedMs: Date.now() - startedAt,
      },
      `init-pinned: 完成（${stats.boardsWithPinned}/${boards.length} 版面有置顶，${stats.totalPinned} 帖，${stats.totalPosts} 楼${stats.totalTruncated > 0 ? `，${stats.totalTruncated} 长帖截断至 ${maxPinnedThreadPages} 页` : ''}）`,
    );
  } catch (e) {
    if (e instanceof BrowserDeadError) {
      browserDied = true;
      logger.error(
        { err: e.message, elapsedMs: Date.now() - startedAt },
        `init-pinned 中止：浏览器/context 已死。已处理的版面会写进 .init-pinned.progress.json。\n` +
          `恢复方法：\n` +
          `  1. 等几秒让 chrome 进程退干净\n` +
          `  2. npm run init:pinned -- --skip-done --concurrency 8\n` +
          `     (用 --concurrency 8 比 16 安全，浏览器不易爆 memory)`,
      );
    } else {
      throw e;
    }
  } finally {
    reporter.stop();
    // Best-effort cleanup. If browser died, these would throw — swallow.
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await closeDbs();
    if (browserDied) process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('init-pinned failed:', err);
  process.exit(1);
});
