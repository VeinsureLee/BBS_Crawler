/**
 * Init runners — the work behind `npm run init:*` scripts and the public
 * runInit* API. All four runners (sections / boards / pinned / refresh)
 * accept the same shape of opts: { concurrency, retryConcurrency,
 * maxRetryPasses, onProgress } and return a structured result.
 *
 * Section discovery (entries.yml path) is the one exception — it does no
 * network at all, so concurrency / retry options are accepted but ignored.
 */
import type { BrowserContext, Page } from 'playwright';
import { getAdapter } from '../registry.js';
import { logger } from '../util/logger.js';
import { upsertSite } from '../repository/sites.js';
import {
  listTopLevelSections,
  upsertSection,
  type SectionRow,
} from '../repository/sections.js';
import {
  upsertBoard,
  type BoardRow,
} from '../repository/boards.js';
import { upsertThread } from '../repository/threads.js';
import { upsertPosts } from '../repository/posts.js';
import { upsertDailyTraffic } from '../repository/daily-traffic.js';
import { findBoardByName } from '../repository/boards-lookup.js';
import { getStructureDb } from '../repository/db.js';
import { loadSiteConfig, loadSiteEntries, validateConfigConsistency } from '../config/site-config.js';
import { runWithPagePool, BrowserDeadError, type PoolDeps, type PoolProgressEvent } from './page-pool.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Public progress event shape — emitted by every runInit*'s onProgress hook.
// ============================================================================

export type InitStage = 'init.sections' | 'init.boards' | 'init.pinned' | 'init.refresh';

export interface InitProgressEvent {
  stage: InitStage;
  /** 0 = primary pass; 1+ = retry pass. */
  pass: number;
  /** total items in THIS pass. */
  total: number;
  /** ok + failed so far in THIS pass. */
  done: number;
  ok: number;
  failed: number;
  /** worker id (1..concurrency) that emitted this event. */
  workerId: number;
  /** transition this event represents. */
  phase: 'started' | 'ok' | 'failed';
  /** human-readable name of the item (board key, section key, etc.). */
  itemName: string;
  /** captured error for phase='failed'. */
  error?: string;
}

export interface InitOpts {
  concurrency?: number | undefined;
  retryConcurrency?: number | undefined;
  maxRetryPasses?: number | undefined;
  onProgress?: ((e: InitProgressEvent) => void) | undefined;
}

export interface AcquireContext {
  (): Promise<{
    context: BrowserContext;
    ensureLoggedIn: (page: Page) => Promise<void>;
    release: () => void;
  }>;
}

// ============================================================================
// Section discovery (no network when entries.yml is present)
// ============================================================================

export interface RunInitSectionsResult {
  sectionsAdded: number;
  source: 'entries.yml' | 'adapter';
}

export async function runInitSections(
  siteKey: string,
  withPage: <T>(fn: (page: Page) => Promise<T>) => Promise<T>,
): Promise<RunInitSectionsResult> {
  const adapter = getAdapter(siteKey);
  await upsertSite({ siteKey: adapter.siteKey, displayName: adapter.displayName, baseUrl: adapter.baseUrl });
  validateConfigConsistency(siteKey);
  const entries = loadSiteEntries(siteKey);
  if (entries && entries.forums.length > 0) {
    for (const f of entries.forums) {
      await upsertSection({ siteKey, sectionKey: f.sectionKey, name: f.name });
    }
    logger.info(
      { category: 'init.sections', siteKey, count: entries.forums.length, source: 'entries.yml' },
      `init: 入库 ${entries.forums.length} 个顶级讨论区（来源：entries.yml）`,
    );
    return { sectionsAdded: entries.forums.length, source: 'entries.yml' };
  }
  if (!adapter.listSections) {
    throw new Error(`Adapter "${siteKey}" has no listSections and entries.yml is missing/empty`);
  }
  logger.warn(
    { category: 'init.sections', siteKey, source: 'adapter.listSections' },
    'entries.yml 缺失或为空，回退到 adapter.listSections 爬首页',
  );
  return withPage(async (page) => {
    const sections = await adapter.listSections!(page);
    for (const s of sections) {
      await upsertSection({ siteKey, sectionKey: s.sectionKey, name: s.name });
    }
    logger.info(
      { category: 'init.sections', siteKey, count: sections.length, source: 'adapter' },
      `init: 入库 ${sections.length} 个顶级讨论区（来源：adapter）`,
    );
    return { sectionsAdded: sections.length, source: 'adapter' as const };
  });
}

// ============================================================================
// Board discovery — parallel BFS over the section tree
// ============================================================================

export interface RunInitBoardsResult {
  sectionsVisited: number;
  boardsAdded: number;
  failures: { sectionKey: string; error: string }[];
}

interface BoardsLevelItem {
  sectionId: number;
  sectionKey: string;
  depth: number;
}

/**
 * BFS: at each level, every section currently in the frontier is fetched in
 * parallel via the page pool. Its child boards are persisted; its child
 * sub-sections become the next level's frontier. Loop until frontier is
 * empty or maxDepth reached.
 */
export async function runInitBoards(
  deps: { acquireContext: AcquireContext },
  siteKey: string,
  opts: InitOpts & { sections?: SectionRow[] } = {},
): Promise<RunInitBoardsResult> {
  const adapter = getAdapter(siteKey);
  if (!adapter.listSectionChildren) throw new Error(`Adapter ${siteKey} has no listSectionChildren`);
  const cfg = loadSiteConfig(siteKey);
  const concurrency = opts.concurrency ?? cfg.crawl.concurrency;
  const interval = cfg.crawl.structureRequestIntervalMs;
  const onProgress = opts.onProgress;
  const MAX_DEPTH = 20;

  const targets = opts.sections ?? (await listTopLevelSections(siteKey));

  let frontier: BoardsLevelItem[] = targets.map((s) => ({
    sectionId: s.id, sectionKey: s.sectionKey, depth: 1,
  }));
  const visited = new Set<string>();
  let totalBoardsAdded = 0;
  let totalSectionsVisited = 0;
  const allFailures: { sectionKey: string; error: string }[] = [];

  const acquired = await deps.acquireContext();
  try {
    for (let pass = 0; frontier.length > 0; pass++) {
      const items = frontier.filter((it) => {
        if (visited.has(it.sectionKey)) {
          logger.warn(
            { category: 'init.boards', sectionKey: it.sectionKey, depth: it.depth },
            `已访问过 ${it.sectionKey}，跳过避免环`,
          );
          return false;
        }
        if (it.depth > MAX_DEPTH) {
          logger.warn(
            { category: 'init.boards', sectionKey: it.sectionKey, depth: it.depth },
            `depth > ${MAX_DEPTH}，跳过 ${it.sectionKey}`,
          );
          return false;
        }
        return true;
      });
      for (const it of items) visited.add(it.sectionKey);

      if (items.length === 0) break;

      const nextFrontier: BoardsLevelItem[] = [];

      const results = await runWithPagePool(
        acquired,
        items,
        concurrency,
        async (item, { page }) => {
          // Per-item delay so a worker doesn't slam the server back-to-back.
          await sleep(interval);
          const children = await adapter.listSectionChildren!(page, item.sectionKey);
          let boardsAdded = 0;
          for (const b of children.boards) {
            const { boardId } = await upsertBoard({
              siteKey, boardKey: b.boardKey, name: b.name,
              sectionId: item.sectionId, moderators: b.moderators,
            });
            await upsertDailyTraffic(boardId, b.stats);
            boardsAdded++;
          }
          const childSubsections: BoardsLevelItem[] = [];
          for (const sub of children.subSections) {
            if (sub.sectionKey === item.sectionKey) {
              logger.warn(
                { category: 'init.boards', parentSectionKey: item.sectionKey },
                `listSectionChildren 把 ${item.sectionKey} 列为自己的子节点，跳过`,
              );
              continue;
            }
            const { sectionId } = await upsertSection({
              siteKey, sectionKey: sub.sectionKey, name: sub.name,
              parentSectionId: item.sectionId,
            });
            childSubsections.push({ sectionId, sectionKey: sub.sectionKey, depth: item.depth + 1 });
          }
          return { boardsAdded, childSubsections };
        },
        (ev) => onProgress?.({
          stage: 'init.boards',
          pass,
          total: ev.total,
          done: ev.ok + ev.failed,
          ok: ev.ok,
          failed: ev.failed,
          workerId: ev.workerId,
          phase: ev.phase,
          itemName: ev.item.sectionKey,
          ...(ev.error ? { error: String((ev.error as Error).message ?? ev.error) } : {}),
        }),
      );

      for (const r of results) {
        if (r.ok) {
          totalBoardsAdded += r.result.boardsAdded;
          totalSectionsVisited++;
          nextFrontier.push(...r.result.childSubsections);
          logger.info(
            { category: 'init.boards', sectionKey: r.item.sectionKey, boardsAdded: r.result.boardsAdded, depth: r.item.depth },
            `init.boards: ${r.item.sectionKey} 入库 ${r.result.boardsAdded} 个 board`,
          );
        } else {
          const msg = (r.error as Error)?.message ?? String(r.error);
          allFailures.push({ sectionKey: r.item.sectionKey, error: msg });
          logger.error(
            { category: 'init.boards', sectionKey: r.item.sectionKey, err: msg },
            `init.boards: ${r.item.sectionKey} 失败: ${msg}`,
          );
        }
      }

      frontier = nextFrontier;
    }
  } finally {
    acquired.release();
  }

  logger.info(
    { category: 'init.boards', siteKey, sectionsVisited: totalSectionsVisited, boardsAdded: totalBoardsAdded, failed: allFailures.length },
    `init.boards 完成：${totalSectionsVisited} sections, ${totalBoardsAdded} boards, ${allFailures.length} failures`,
  );
  return { sectionsVisited: totalSectionsVisited, boardsAdded: totalBoardsAdded, failures: allFailures };
}

// ============================================================================
// Pinned thread crawling — parallel pool with retry passes
// ============================================================================

export interface RunInitPinnedResult {
  boardsAttempted: number;
  boardsOk: number;
  boardsFailed: number;
  threadsAdded: number;
  passesUsed: number;
  failures: { boardKey: string; error: string }[];
}

interface PinnedWorkerResult {
  threadsAdded: number;
  threadsSkipped: number;
}

export async function runInitPinned(
  deps: { acquireContext: AcquireContext },
  siteKey: string,
  boards: BoardRow[],
  opts: InitOpts = {},
): Promise<RunInitPinnedResult> {
  const adapter = getAdapter(siteKey);
  if (!adapter.listPinnedThreadIds) throw new Error(`Adapter ${siteKey} has no listPinnedThreadIds`);
  const cfg = loadSiteConfig(siteKey);
  const concurrency = opts.concurrency ?? cfg.crawl.concurrency;
  const retryConcurrency = opts.retryConcurrency ?? 1;
  const maxRetryPasses = opts.maxRetryPasses ?? cfg.crawl.maxRetryPasses;
  const interval = cfg.crawl.requestIntervalMs;
  const maxPinnedThreadPages = cfg.crawl.maxPinnedThreadPages;
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');
  const onProgress = opts.onProgress;

  const runOnePass = async (
    pool: PoolDeps,
    items: BoardRow[],
    poolConcurrency: number,
    pass: number,
  ): Promise<{ ok: BoardRow[]; failed: { board: BoardRow; error: string }[]; threadsAdded: number }> => {
    let threadsAdded = 0;
    const results = await runWithPagePool(
      pool,
      items,
      poolConcurrency,
      async (board, { page }): Promise<PinnedWorkerResult> => {
        const ids = await adapter.listPinnedThreadIds!(page, board.boardKey);
        let added = 0;
        let skipped = 0;
        for (const articleId of ids) {
          await sleep(interval);
          const url = `${baseUrl.replace(/\/+$/, '')}/article/${board.boardKey}/${articleId}`;
          try {
            const thread = await adapter.getThread(page, { url, maxPages: maxPinnedThreadPages });
            thread.raw = { ...(thread.raw ?? {}), pinned: true };
            const { threadId, boardDb } = await upsertThread(siteKey, thread, { isPinned: true });
            await upsertPosts(boardDb, threadId, thread.posts);
            added++;
          } catch (e) {
            skipped++;
            logger.warn(
              { category: 'init.pinned', boardKey: board.boardKey, articleId, err: (e as Error).message },
              `init.pinned: pinned thread fetch failed; skipping`,
            );
          }
        }
        return { threadsAdded: added, threadsSkipped: skipped };
      },
      (ev) => onProgress?.({
        stage: 'init.pinned',
        pass,
        total: ev.total,
        done: ev.ok + ev.failed,
        ok: ev.ok,
        failed: ev.failed,
        workerId: ev.workerId,
        phase: ev.phase,
        itemName: ev.item.boardKey,
        ...(ev.error ? { error: String((ev.error as Error).message ?? ev.error) } : {}),
      }),
    );

    const ok: BoardRow[] = [];
    const failed: { board: BoardRow; error: string }[] = [];
    for (const r of results) {
      if (r.ok) {
        threadsAdded += r.result.threadsAdded;
        ok.push(r.item);
        logger.info(
          { category: 'init.pinned', boardKey: r.item.boardKey, threadsAdded: r.result.threadsAdded, threadsSkipped: r.result.threadsSkipped, pass },
          `init.pinned: ${r.item.boardKey} pinned=${r.result.threadsAdded} skipped=${r.result.threadsSkipped}`,
        );
      } else {
        const msg = (r.error as Error)?.message ?? String(r.error);
        failed.push({ board: r.item, error: msg });
        logger.error(
          { category: 'init.pinned', boardKey: r.item.boardKey, err: msg, pass },
          `init.pinned: ${r.item.boardKey} failed: ${msg}`,
        );
      }
    }
    return { ok, failed, threadsAdded };
  };

  const acquired = await deps.acquireContext();
  let okBoards: BoardRow[] = [];
  let totalThreads = 0;
  let passesUsed = 1;
  let allFailures: { boardKey: string; error: string }[] = [];

  try {
    // Primary pass.
    const primary = await runOnePass(acquired, boards, concurrency, 0);
    okBoards = primary.ok;
    totalThreads += primary.threadsAdded;
    let failedBoards = primary.failed.map((f) => f.board);

    // Retry passes.
    let pass = 1;
    while (failedBoards.length > 0 && pass <= maxRetryPasses) {
      logger.info(
        { category: 'init.pinned', pass, retrying: failedBoards.length, maxRetryPasses, concurrency: retryConcurrency },
        `init.pinned 重试轮 ${pass}/${maxRetryPasses}: ${failedBoards.length} 个版面，并发=${retryConcurrency}`,
      );
      const retry = await runOnePass(acquired, failedBoards, retryConcurrency, pass);
      okBoards.push(...retry.ok);
      totalThreads += retry.threadsAdded;
      failedBoards = retry.failed.map((f) => f.board);
      passesUsed = pass + 1;
      pass++;
    }

    allFailures = failedBoards.map((b) => ({
      boardKey: b.boardKey,
      error: `still failing after ${maxRetryPasses} retries`,
    }));
  } catch (e) {
    if (e instanceof BrowserDeadError) {
      logger.error(
        { category: 'init.pinned', err: e.message },
        `init.pinned 中止：浏览器/context 已死。原因: ${e.deadCause}`,
      );
      throw e;
    }
    throw e;
  } finally {
    acquired.release();
  }

  logger.info(
    { category: 'init.pinned', siteKey, boardsAttempted: boards.length, boardsOk: okBoards.length, boardsFailed: allFailures.length, threadsAdded: totalThreads, passesUsed },
    `init.pinned 完成：${okBoards.length}/${boards.length} boards ok, ${totalThreads} threads, ${allFailures.length} failures, ${passesUsed} passes`,
  );

  return {
    boardsAttempted: boards.length,
    boardsOk: okBoards.length,
    boardsFailed: allFailures.length,
    threadsAdded: totalThreads,
    passesUsed,
    failures: allFailures,
  };
}

// ============================================================================
// Refresh board stats — parallel pool over section pages
// ============================================================================

export interface RefreshBoardStatsOpts extends InitOpts {
  sectionKey?: string | undefined;
  boardName?: string | undefined;
  all?: boolean | undefined;
}

export interface RefreshBoardStatsResult {
  sectionsVisited: number;
  boardsUpdated: number;
  failures: { sectionKey: string; error: string }[];
}

export async function runRefreshBoardStats(
  deps: { acquireContext: AcquireContext },
  siteKey: string,
  opts: RefreshBoardStatsOpts,
): Promise<RefreshBoardStatsResult> {
  const adapter = getAdapter(siteKey);
  if (!adapter.listSectionChildren) {
    throw new Error(`Adapter ${siteKey} has no listSectionChildren`);
  }
  const cfg = loadSiteConfig(siteKey);
  const concurrency = opts.concurrency ?? cfg.crawl.concurrency;
  const interval = cfg.crawl.structureRequestIntervalMs;
  const onProgress = opts.onProgress;

  const targets = await resolveRefreshTargets(siteKey, opts);
  if (targets.length === 0) {
    return { sectionsVisited: 0, boardsUpdated: 0, failures: [] };
  }

  const acquired = await deps.acquireContext();
  let totalBoardsUpdated = 0;
  let sectionsVisited = 0;
  const failures: { sectionKey: string; error: string }[] = [];

  try {
    const results = await runWithPagePool(
      acquired,
      targets,
      concurrency,
      async (t, { page }): Promise<{ boardsUpdated: number }> => {
        await sleep(interval);
        const children = await adapter.listSectionChildren!(page, t.sectionKey);
        let updated = 0;
        for (const b of children.boards) {
          const { boardId } = await upsertBoard({
            siteKey, boardKey: b.boardKey, name: b.name,
            sectionId: t.sectionId, moderators: b.moderators,
          });
          await upsertDailyTraffic(boardId, b.stats);
          updated++;
        }
        return { boardsUpdated: updated };
      },
      (ev) => onProgress?.({
        stage: 'init.refresh',
        pass: 0,
        total: ev.total,
        done: ev.ok + ev.failed,
        ok: ev.ok,
        failed: ev.failed,
        workerId: ev.workerId,
        phase: ev.phase,
        itemName: ev.item.sectionKey,
        ...(ev.error ? { error: String((ev.error as Error).message ?? ev.error) } : {}),
      }),
    );

    for (const r of results) {
      if (r.ok) {
        sectionsVisited++;
        totalBoardsUpdated += r.result.boardsUpdated;
        logger.info(
          { category: 'init.refresh', sectionKey: r.item.sectionKey, boards: r.result.boardsUpdated },
          `refresh: ${r.item.sectionKey} 更新 ${r.result.boardsUpdated} boards`,
        );
      } else {
        const msg = (r.error as Error)?.message ?? String(r.error);
        failures.push({ sectionKey: r.item.sectionKey, error: msg });
        logger.error(
          { category: 'init.refresh', sectionKey: r.item.sectionKey, err: msg },
          `refresh: ${r.item.sectionKey} 失败: ${msg}`,
        );
      }
    }
  } finally {
    acquired.release();
  }

  return { sectionsVisited, boardsUpdated: totalBoardsUpdated, failures };
}

interface RefreshTarget { sectionId: number; sectionKey: string; }

async function resolveRefreshTargets(
  siteKey: string,
  opts: RefreshBoardStatsOpts,
): Promise<RefreshTarget[]> {
  const flags = [opts.sectionKey, opts.boardName, opts.all].filter(Boolean).length;
  if (flags === 0) {
    throw new Error('runRefreshBoardStats: pass one of { sectionKey, boardName, all }');
  }
  if (flags > 1) {
    throw new Error('runRefreshBoardStats: pass exactly one of { sectionKey, boardName, all }');
  }

  const db = getStructureDb();

  if (opts.sectionKey) {
    const r = await db.query<{ id: number; node_key: string }>(
      `SELECT id, node_key FROM nodes
        WHERE site_key = $1 AND node_key = $2 AND type IN ('forum','sub_forum')
        LIMIT 1`,
      [siteKey, opts.sectionKey],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`section "${opts.sectionKey}" not found in ${siteKey}`);
    return [{ sectionId: Number(row.id), sectionKey: row.node_key }];
  }

  if (opts.boardName) {
    const board = await findBoardByName(siteKey, opts.boardName);
    if (!board) throw new Error(`board "${opts.boardName}" not found in ${siteKey}`);
    const r = await db.query<{ id: number; node_key: string }>(
      `SELECT p.id, p.node_key FROM nodes b
         JOIN nodes p ON p.id = b.parent_id
        WHERE b.id = $1`,
      [board.id],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`board "${opts.boardName}" has no parent section`);
    return [{ sectionId: Number(row.id), sectionKey: row.node_key }];
  }

  const r = await db.query<{ id: number; node_key: string }>(
    `SELECT DISTINCT p.id, p.node_key
       FROM nodes b
       JOIN nodes p ON p.id = b.parent_id
      WHERE b.site_key = $1 AND b.type = 'board'
      ORDER BY p.id`,
    [siteKey],
  );
  return r.rows.map((row) => ({ sectionId: Number(row.id), sectionKey: row.node_key }));
}
