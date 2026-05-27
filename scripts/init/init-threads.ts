/**
 * Init step 3: crawl pinned threads (default) and optionally the first page
 * of non-pinned threads (`--with-plain`) for every board in DB.
 *
 * Pinned data → threads + posts with is_pinned = 1
 * Plain data  → threads + posts with is_pinned = 0 (each thread truncated to page 1)
 *
 * Replaces the older `init:pinned` + `init:plain` scripts. The multi-worker
 * model is identical: one BrowserContext, N pages as workers, single
 * shared board queue, retry pass with concurrency=1 for failed boards,
 * `BrowserDeadError` graceful exit.
 *
 * Usage:
 *   npx tsx scripts/init/init-threads.ts [siteKey] [--limit N] [--concurrency K] [--with-plain] [--skip-done]
 *
 * `--skip-done` only applies to the pinned crawl; it reads / writes
 * `./.init-pinned.progress.json` for resumability (kept for backwards
 * compatibility with prior runs).
 *
 * Requires:
 *   - boards already populated by scripts/init/init-boards.ts
 *   - .state/<siteKey>.json from scripts/auth/do-login.ts
 */
import '../../src/config/load-env.js';
import '../../src/adapters/index';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Page } from 'playwright';
import { parseConfig } from '../../src/config/app-config';
import { loadSiteConfig } from '../../src/config/site-config';
import { initDb, closeAllDbs, getStructureDb } from '../../src/repository/db';
import { getAdapter } from '../../src/registry';
import { listBoards } from '../../src/repository/boards';
import { upsertThread } from '../../src/repository/threads';
import { upsertPosts } from '../../src/repository/posts';
import { logger } from '../../src/util/logger';
import { Ui, type ProgressSnapshot, type ForumLine } from './init-ui';

interface ForumStat {
  forumKey: string;
  forumName: string;
  total: number;
  done: number;
  withPinned: number;
  withPlain: number;
  failed: number;
}

class ProgressReporter {
  private forums = new Map<string, ForumStat>();
  private boardToForum = new Map<string, string>();
  private boardOutcomes = new Map<string, { hasPinned: boolean; hasPlain: boolean; failed: boolean }>();
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
          withPinned: 0,
          withPlain: 0,
          failed: 0,
        });
      }
    }
  }

  private apply(boardKey: string, outcome: { hasPinned: boolean; hasPlain: boolean; failed: boolean }): void {
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
      if (prev.hasPinned) s.withPinned--;
      if (prev.hasPlain) s.withPlain--;
      if (prev.failed) s.failed--;
    }
    if (outcome.hasPinned) s.withPinned++;
    if (outcome.hasPlain) s.withPlain++;
    if (outcome.failed) s.failed++;
    this.boardOutcomes.set(boardKey, outcome);
  }

  recordSuccess(boardKey: string, hasPinned: boolean, hasPlain: boolean): void {
    this.apply(boardKey, { hasPinned, hasPlain, failed: false });
  }

  recordFailure(boardKey: string): void {
    this.apply(boardKey, { hasPinned: false, hasPlain: false, failed: true });
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

  /** Read-only snapshot for the in-process TUI. */
  snapshot(): ProgressSnapshot {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    let totalAll = 0, doneAll = 0, withPinnedAll = 0, withPlainAll = 0, failedAll = 0;
    const perForum: ForumLine[] = [];
    const keys = [...this.forums.keys()].sort((a, b) => Number(a) - Number(b));
    for (const k of keys) {
      const s = this.forums.get(k)!;
      totalAll += s.total;
      doneAll += s.done;
      withPinnedAll += s.withPinned;
      withPlainAll += s.withPlain;
      failedAll += s.failed;
      perForum.push({
        name: s.forumName,
        done: s.done,
        total: s.total,
        withPinned: s.withPinned,
        withPlain: s.withPlain,
        failed: s.failed,
      });
    }
    return { elapsed, doneAll, totalAll, withPinnedAll, withPlainAll, failedAll, orphans: this.orphans, perForum };
  }

  private emit(stage: 'tick' | 'final'): void {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    let totalAll = 0, doneAll = 0, withPinnedAll = 0, withPlainAll = 0, failedAll = 0;
    const perForum: Record<string, { name: string; done: number; total: number; withPinned: number; withPlain: number; failed: number }> = {};
    const lines: string[] = [];
    for (const [, s] of this.forums) {
      totalAll += s.total;
      doneAll += s.done;
      withPinnedAll += s.withPinned;
      withPlainAll += s.withPlain;
      failedAll += s.failed;
      perForum[s.forumKey] = { name: s.forumName, done: s.done, total: s.total, withPinned: s.withPinned, withPlain: s.withPlain, failed: s.failed };
      const parts = [`${s.forumName} ${s.done}/${s.total}`];
      if (s.withPinned > 0) parts.push(`pin=${s.withPinned}`);
      if (s.withPlain > 0) parts.push(`plain=${s.withPlain}`);
      if (s.failed > 0) parts.push(`fail=${s.failed}`);
      lines.push(parts.join(' '));
    }
    const pct = totalAll > 0 ? Math.floor((doneAll / totalAll) * 100) : 0;
    const tail: string[] = [];
    if (withPinnedAll > 0) tail.push(`pinned=${withPinnedAll}`);
    if (withPlainAll > 0) tail.push(`plain=${withPlainAll}`);
    if (failedAll > 0) tail.push(`failed=${failedAll}`);
    if (this.orphans > 0) tail.push(`orphans=${this.orphans}`);
    logger.info(
      { stage: `progress.${stage}`, script: 'init-threads', elapsed, totalAll, doneAll, withPinnedAll, withPlainAll, failedAll, orphans: this.orphans, perForum },
      `进度 ${doneAll}/${totalAll} (${pct}%) elapsed=${elapsed}s${tail.length ? ' ' + tail.join(' ') : ''} | ${lines.join(' | ')}`,
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
  withPlain: boolean;
  skipDone: boolean;
  verbose: boolean;
}

const USAGE = `Usage: npm run init:threads -- [siteKey] [--limit N] [--concurrency K] [--with-plain] [--skip-done] [--verbose]
  siteKey            default "school-bbs"
  --limit N          cap the number of boards processed (testing)
  --concurrency K    parallel workers (default from site config)
  --with-plain       also crawl page 1 of non-pinned threads for each board
                     (each thread truncated to its first page)
  --skip-done        skip boards already recorded in ./.init-pinned.progress.json
                     (only affects pinned crawl; plain re-runs every time)
  --verbose, -v      also print a per-board event log above the live progress
                     block (board done / skipped / failed). File logs always
                     contain full per-step detail regardless of this flag.`;

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let limit: number | undefined;
  let concurrency: number | undefined;
  let withPlain = false;
  let skipDone = false;
  let verbose = false;
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
    } else if (a === '--with-plain') {
      withPlain = true;
    } else if (a === '--skip-done') {
      skipDone = true;
    } else if (a === '--verbose' || a === '-v') {
      verbose = true;
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
  return { siteKey: positional[0] ?? 'school-bbs', limit, concurrency, withPlain, skipDone, verbose };
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
  pinnedThreads: number;
  pinnedPosts: number;
  pinnedSkipped: number;
  plainThreads: number;
  plainPosts: number;
  plainSkipped: number;
  truncated: number;
  error?: string;
}

function emptyResult(success: boolean, error?: string): ProcessResult {
  const r: ProcessResult = {
    success,
    pinnedThreads: 0, pinnedPosts: 0, pinnedSkipped: 0,
    plainThreads: 0, plainPosts: 0, plainSkipped: 0,
    truncated: 0,
  };
  if (error) r.error = error;
  return r;
}

async function processBoard(
  page: Page,
  adapter: ReturnType<typeof getAdapter>,
  siteKey: string,
  baseUrl: string,
  boardKey: string,
  requestIntervalMs: number,
  maxPinnedThreadPages: number,
  withPlain: boolean,
): Promise<ProcessResult> {
  const result = emptyResult(true);
  try {
    // -------------------- pinned --------------------
    logger.info({ boardKey }, `[${boardKey}] step P1: listPinnedThreadIds`);
    const pinnedIds = await adapter.listPinnedThreadIds!(page, boardKey);
    logger.info({ boardKey, found: pinnedIds.length }, `[${boardKey}] step P1: ${pinnedIds.length} 个置顶`);

    for (const articleId of pinnedIds) {
      await sleep(requestIntervalMs);
      const url = `${baseUrl.replace(/\/+$/, '')}/article/${boardKey}/${articleId}`;
      logger.info({ boardKey, articleId }, `[${boardKey}/${articleId}] step P2: getThread (pinned)`);
      try {
        const thread = await adapter.getThread(page, { url, maxPages: maxPinnedThreadPages });
        thread.raw = { ...(thread.raw ?? {}), pinned: true };

        const { threadId, boardDb } = await upsertThread(siteKey, thread, { isPinned: true });
        await upsertPosts(boardDb, threadId, thread.posts);

        result.pinnedThreads++;
        result.pinnedPosts += thread.posts.length;
        const raw = thread.raw as { pageCount?: number; crawledPages?: number; truncated?: boolean };
        const pageCount = raw.pageCount ?? 1;
        const crawledPages = raw.crawledPages ?? pageCount;
        const wasTruncated = raw.truncated ?? false;
        if (wasTruncated) result.truncated++;
        logger.info(
          { boardKey, articleId, title: thread.title, posts: thread.posts.length, crawledPages, pageCount, truncated: wasTruncated },
          `置顶帖入库 [${articleId}] "${thread.title}" — ${thread.posts.length} 楼 / ${crawledPages}/${pageCount} 页${wasTruncated ? ' (截断)' : ''}`,
        );
      } catch (err) {
        const msg = (err as Error).message;
        // Browser/context died — surface so the worker can abort cleanly.
        if (isBrowserDeadError(msg)) throw err;
        result.pinnedSkipped++;
        logger.warn(
          { boardKey, articleId, url, err: msg },
          `[${boardKey}/${articleId}] 置顶帖抓取失败，跳过：${msg}`,
        );
      }
    }

    // -------------------- plain (optional) --------------------
    if (withPlain) {
      logger.info({ boardKey }, `[${boardKey}] step L1: listThreads(page=1)`);
      const summaries = await adapter.listThreads(page, { board: boardKey, page: 1 });
      const plain = summaries.filter((s) => !(s.raw && (s.raw as { isPinned?: boolean }).isPinned));
      logger.info(
        { boardKey, total: summaries.length, plain: plain.length },
        `[${boardKey}] step L1: 共 ${summaries.length} 行，非置顶 ${plain.length}`,
      );

      for (const summary of plain) {
        await sleep(requestIntervalMs);
        logger.info({ boardKey, url: summary.url, title: summary.title }, `[${boardKey}] step L2: getThread "${summary.title}"`);
        try {
          const thread = await adapter.getThread(page, { url: summary.url, maxPages: 1 });

          const { threadId, boardDb } = await upsertThread(siteKey, thread, { isPinned: false });
          await upsertPosts(boardDb, threadId, thread.posts);

          result.plainThreads++;
          result.plainPosts += thread.posts.length;
          logger.info(
            { boardKey, threadId, title: thread.title, posts: thread.posts.length },
            `非置顶帖入库 [${threadId}] "${thread.title}" — ${thread.posts.length} 楼`,
          );
        } catch (err) {
          const msg = (err as Error).message;
          if (isBrowserDeadError(msg)) throw err;
          result.plainSkipped++;
          logger.warn(
            { boardKey, url: summary.url, title: summary.title, err: msg },
            `[${boardKey}] 非置顶帖抓取失败，跳过 "${summary.title}"：${msg}`,
          );
        }
      }
    }

    return result;
  } catch (err) {
    logger.error({ boardKey, err: String(err) }, `[${boardKey}] processBoard 抛错: ${(err as Error).message}`);
    return emptyResult(false, (err as Error).message);
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

interface RunStats {
  boardsWithPinned: number;
  boardsWithPlain: number;
  totalPinnedThreads: number;
  totalPinnedPosts: number;
  totalPinnedSkipped: number;
  totalPlainThreads: number;
  totalPlainPosts: number;
  totalPlainSkipped: number;
  totalTruncated: number;
}

async function runPass(
  boards: BoardWithKey[],
  ctx: any,
  adapter: ReturnType<typeof getAdapter>,
  siteKey: string,
  baseUrl: string,
  requestIntervalMs: number,
  maxPinnedThreadPages: number,
  withPlain: boolean,
  stats: RunStats,
  recordDone: (boardKey: string) => void,
  concurrency: number,
  passLabel: string,
  reporter: ProgressReporter,
  ui: Ui,
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
        page, adapter, siteKey, baseUrl, b.boardKey,
        requestIntervalMs, maxPinnedThreadPages, withPlain,
      );
      if (result.success) {
        const hasPinned = result.pinnedThreads > 0;
        const hasPlain = result.plainThreads > 0;
        if (hasPinned) {
          stats.boardsWithPinned++;
          stats.totalPinnedThreads += result.pinnedThreads;
          stats.totalPinnedPosts += result.pinnedPosts;
          stats.totalTruncated += result.truncated;
        }
        if (hasPlain) {
          stats.boardsWithPlain++;
          stats.totalPlainThreads += result.plainThreads;
          stats.totalPlainPosts += result.plainPosts;
        }
        stats.totalPinnedSkipped += result.pinnedSkipped;
        stats.totalPlainSkipped += result.plainSkipped;
        const skippedNote = result.pinnedSkipped > 0 || result.plainSkipped > 0
          ? ` (skipped: pin=${result.pinnedSkipped}, plain=${result.plainSkipped})`
          : '';
        logger.info(
          {
            pass: passLabel, worker: workerId, idx: i + 1, total, boardKey: b.boardKey,
            pinnedThreads: result.pinnedThreads, plainThreads: result.plainThreads,
            pinnedSkipped: result.pinnedSkipped, plainSkipped: result.plainSkipped,
          },
          `[${passLabel} w${workerId} ${i + 1}/${total}] ${b.boardKey}: pinned=${result.pinnedThreads}, plain=${result.plainThreads}${skippedNote}`,
        );
        const marker = (result.pinnedSkipped > 0 || result.plainSkipped > 0) ? '!' : '✓';
        const parts = [
          `${marker} [${passLabel}] ${b.boardKey}`,
          `pinned=${result.pinnedThreads}`,
        ];
        if (withPlain) parts.push(`plain=${result.plainThreads}`);
        if (skippedNote) parts.push(skippedNote.trim().slice(1, -1));
        ui.event(parts.join('  '));
        reporter.recordSuccess(b.boardKey, hasPinned, hasPlain);
        recordDone(b.boardKey);
      } else {
        if (isBrowserDeadError(result.error)) {
          if (!browserDeadCause) {
            browserDeadCause = result.error ?? 'unknown';
            logger.error(
              { pass: passLabel, worker: workerId, boardKey: b.boardKey, err: result.error },
              `[${passLabel}] 浏览器/context 已关闭，中止剩余 worker。原因: ${result.error}`,
            );
            ui.note(`✗ [${passLabel}] 浏览器/context 已关闭，中止剩余 worker。原因: ${result.error}`);
          }
          return;
        }
        logger.error(
          { pass: passLabel, worker: workerId, idx: i + 1, total, boardKey: b.boardKey, err: result.error },
          `[${passLabel} w${workerId} ${i + 1}/${total}] ${b.boardKey} 失败: ${result.error}`,
        );
        ui.event(`✗ [${passLabel}] ${b.boardKey}  失败: ${result.error}`);
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
  for (const p of pages) await p.close().catch(() => {});

  if (browserDeadCause) {
    throw new BrowserDeadError(browserDeadCause);
  }

  return failed;
}

async function main() {
  const { siteKey, limit, concurrency: concurrencyOverride, withPlain, skipDone, verbose } = parseArgs();

  // Silence pino's stdout sink — we'll render our own TUI. File logs still
  // get full detail (so `npm run tail:progress` in another window works).
  // The logger stream wrapper re-reads this env var on every write, so
  // setting it here (before the first logger call in main) is sufficient.
  process.env.LOG_STDOUT_DISABLED = 'true';

  const cfg = parseConfig(process.env);
  const siteConfig = loadSiteConfig(siteKey);
  initDb({ dataDir: cfg.dataDir });

  const adapter = getAdapter(siteKey);
  if (!adapter.listPinnedThreadIds || !adapter.getThread || !adapter.listThreads) {
    throw new Error(`Adapter "${siteKey}" missing listPinnedThreadIds, listThreads, or getThread`);
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

  const stats: RunStats = {
    boardsWithPinned: 0, boardsWithPlain: 0,
    totalPinnedThreads: 0, totalPinnedPosts: 0, totalPinnedSkipped: 0,
    totalPlainThreads: 0, totalPlainPosts: 0, totalPlainSkipped: 0,
    totalTruncated: 0,
  };

  const recordDone = (boardKey: string): void => {
    doneSet.add(boardKey);
    progress[siteKey] = [...doneSet];
    try { writeProgress(progress); }
    catch (e) { logger.warn({ err: (e as Error).message, boardKey }, '进度文件写入失败'); }
  };

  const startedAt = Date.now();
  const startedMsg = `init-threads: 开始（并发=${concurrency}, ${boards.length} 个版面, 置顶最多 ${maxPinnedThreadPages} 页${withPlain ? '，并爬 plain 第一页（每帖首页）' : ''}）`;
  logger.info(
    {
      siteKey, script: 'init-threads',
      boards: boards.length, concurrency, withPlain, maxPinnedThreadPages,
    },
    startedMsg,
  );

  const reporter = new ProgressReporter();
  await reporter.init(siteKey);
  reporter.start(5000);

  const ui = new Ui({ verbose, showPlain: withPlain });
  ui.banner(startedMsg + (verbose ? '   [verbose]' : ''));
  ui.start(() => reporter.snapshot(), 500);

  let failedBoards: BoardWithKey[] = [];
  let browserDied = false;
  try {
    failedBoards = await runPass(
      boards, ctx, adapter, siteKey, baseUrl,
      requestIntervalMs, maxPinnedThreadPages, withPlain,
      stats, recordDone, concurrency, 'main', reporter, ui,
    );

    let retryPass = 0;
    while (failedBoards.length > 0 && retryPass < maxRetryPasses) {
      retryPass++;
      const retryMsg = `=== 重试轮 ${retryPass}/${maxRetryPasses}: ${failedBoards.length} 个失败版面，并发=1`;
      logger.info(
        { retryPass, maxRetryPasses, failed: failedBoards.length },
        retryMsg,
      );
      ui.note(retryMsg);
      const boardsToRetry = [...failedBoards];
      failedBoards = await runPass(
        boardsToRetry, ctx, adapter, siteKey, baseUrl,
        requestIntervalMs, maxPinnedThreadPages, withPlain,
        stats, recordDone, 1, `retry${retryPass}`, reporter, ui,
      );
    }

    if (failedBoards.length > 0) {
      const failMsg = `${failedBoards.length} 个版面经 ${maxRetryPasses} 轮重试仍失败: ${failedBoards.map((b) => b.boardKey).join(', ')}`;
      logger.warn(
        { failedBoards: failedBoards.map((b) => b.boardKey), maxRetryPasses },
        failMsg,
      );
      ui.note(`⚠ ${failMsg}`);
    }

    const skipNote: string[] = [];
    if (stats.totalPinnedSkipped > 0) skipNote.push(`${stats.totalPinnedSkipped} 置顶帖跳过`);
    if (stats.totalPlainSkipped > 0) skipNote.push(`${stats.totalPlainSkipped} 非置顶帖跳过`);
    const finalMsg = `init-threads: 完成（pinned: ${stats.boardsWithPinned}/${boards.length} 版面, ${stats.totalPinnedThreads} 帖, ${stats.totalPinnedPosts} 楼${withPlain ? `; plain: ${stats.boardsWithPlain}/${boards.length} 版面, ${stats.totalPlainThreads} 帖, ${stats.totalPlainPosts} 楼` : ''}${stats.totalTruncated > 0 ? `; ${stats.totalTruncated} 长帖截断` : ''}${skipNote.length > 0 ? `; ${skipNote.join('，')}` : ''}）`;
    logger.info(
      {
        siteKey, boards: boards.length,
        boardsWithPinned: stats.boardsWithPinned,
        boardsWithPlain: stats.boardsWithPlain,
        pinnedThreads: stats.totalPinnedThreads,
        pinnedPosts: stats.totalPinnedPosts,
        pinnedSkipped: stats.totalPinnedSkipped,
        plainThreads: stats.totalPlainThreads,
        plainPosts: stats.totalPlainPosts,
        plainSkipped: stats.totalPlainSkipped,
        truncated: stats.totalTruncated,
        withPlain,
        elapsedMs: Date.now() - startedAt,
      },
      finalMsg,
    );
    ui.stop(finalMsg);
  } catch (e) {
    if (e instanceof BrowserDeadError) {
      browserDied = true;
      const abortMsg = `init-threads 中止：浏览器/context 已死。\n` +
        `恢复方法：\n` +
        `  1. 等几秒让 chrome 进程退干净\n` +
        `  2. npm run init:threads -- --skip-done --concurrency 8${withPlain ? ' --with-plain' : ''}`;
      logger.error({ err: e.message, elapsedMs: Date.now() - startedAt }, abortMsg);
      ui.stop(abortMsg);
    } else {
      throw e;
    }
  } finally {
    reporter.stop();
    if (!browserDied) ui.stop();
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await closeAllDbs();
    if (browserDied) process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('init-threads failed:', err);
  process.exit(1);
});
