/**
 * Init runners — the work behind `npm run init:*` scripts, factored out so
 * the InitOrchestrator can reuse them when an MCP tool call hits an empty
 * or partially-initialized DB.
 *
 * Each runner takes an already-logged-in Playwright Page (the orchestrator
 * acquires it via the browser pool + AuthManager). They write to the same
 * sections / boards / threads tables the standalone scripts target.
 */
import type { Page } from 'playwright';
import { getAdapter } from './registry.js';
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
import { loadSiteConfig, loadSiteEntries, validateConfigConsistency } from './site-config.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Persist top-level sections. Idempotent — uses upsert.
 *
 * Source priority:
 *   1. config/sites/<siteKey>.entries.yml (when present + non-empty)
 *   2. adapter.listSections(page) — crawl the homepage (legacy fallback)
 *
 * The config-driven path is preferred because it decouples init from the
 * forum's homepage layout; the homepage can change without breaking init.
 */
export async function runInitSections(page: Page, siteKey: string): Promise<void> {
  const adapter = getAdapter(siteKey);

  await upsertSite({
    siteKey: adapter.siteKey,
    displayName: adapter.displayName,
    baseUrl: adapter.baseUrl,
  });

  validateConfigConsistency(siteKey);
  const entries = loadSiteEntries(siteKey);

  if (entries && entries.forums.length > 0) {
    for (const f of entries.forums) {
      await upsertSection({ siteKey, sectionKey: f.sectionKey, name: f.name });
    }
    logger.info(
      { siteKey, count: entries.forums.length, source: 'entries.yml' },
      `init: 入库 ${entries.forums.length} 个顶级讨论区（来源：entries.yml）`,
    );
    return;
  }

  if (!adapter.listSections) {
    throw new Error(
      `Adapter "${siteKey}" has no listSections and entries.yml is missing/empty`,
    );
  }

  logger.warn(
    { siteKey, source: 'adapter.listSections' },
    'entries.yml 缺失或为空，回退到 adapter.listSections 爬首页',
  );
  const sections = await adapter.listSections(page);
  for (const s of sections) {
    await upsertSection({ siteKey, sectionKey: s.sectionKey, name: s.name });
  }
  logger.info(
    { siteKey, count: sections.length, source: 'adapter' },
    `init: 入库 ${sections.length} 个顶级讨论区（来源：adapter）`,
  );
}

/**
 * Crawl boards (and one level of sub-sections) for `sections`. If `sections`
 * is omitted, all top-level sections in DB are processed.
 */
export async function runInitBoards(
  page: Page,
  siteKey: string,
  opts: { sections?: SectionRow[] } = {},
): Promise<void> {
  const adapter = getAdapter(siteKey);
  if (!adapter.listSectionChildren) throw new Error(`Adapter ${siteKey} has no listSectionChildren`);
  const cfg = loadSiteConfig(siteKey);
  const interval = cfg.crawl.structureRequestIntervalMs;

  const targets = opts.sections ?? (await listTopLevelSections(siteKey));
  for (const sec of targets) {
    const children = await adapter.listSectionChildren(page, sec.sectionKey);
    for (const b of children.boards) {
      const { boardId } = await upsertBoard({
        siteKey, boardKey: b.boardKey, name: b.name,
        sectionId: sec.id, moderators: b.moderators,
      });
      await upsertDailyTraffic(boardId, b.stats);
    }
    for (const sub of children.subSections) {
      const { sectionId } = await upsertSection({
        siteKey, sectionKey: sub.sectionKey, name: sub.name, parentSectionId: sec.id,
      });
      await sleep(interval);
      const nested = await adapter.listSectionChildren(page, sub.sectionKey);
      for (const b of nested.boards) {
        const { boardId } = await upsertBoard({
          siteKey, boardKey: b.boardKey, name: b.name,
          sectionId, moderators: b.moderators,
        });
        await upsertDailyTraffic(boardId, b.stats);
      }
    }
    await sleep(interval);
    logger.info({ siteKey, sectionKey: sec.sectionKey }, 'init: section children persisted');
  }
}

/**
 * For each board in `boards`, fetch its pinned-thread ids, then fetch each
 * thread and persist into the unified `threads` + `posts` tables with
 * `is_pinned = 1`. Sequential
 * (no concurrency) — the MCP-triggered path runs one board at a time so it
 * stays predictable; the standalone `init:threads` script keeps its parallel
 * implementation.
 */
export async function runInitPinned(
  page: Page,
  siteKey: string,
  boards: BoardRow[],
): Promise<void> {
  const adapter = getAdapter(siteKey);
  if (!adapter.listPinnedThreadIds) throw new Error(`Adapter ${siteKey} has no listPinnedThreadIds`);
  const cfg = loadSiteConfig(siteKey);
  const interval = cfg.crawl.requestIntervalMs;
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');

  for (const board of boards) {
    let ids: string[];
    try {
      ids = await adapter.listPinnedThreadIds(page, board.boardKey);
    } catch (e) {
      logger.warn({ siteKey, board: board.boardKey, err: String(e) }, 'init: listPinnedThreadIds failed; skipping board');
      continue;
    }
    for (const articleId of ids) {
      await sleep(interval);
      const url = `${baseUrl.replace(/\/+$/, '')}/article/${board.boardKey}/${articleId}`;
      try {
        const thread = await adapter.getThread(page, {
          url, maxPages: cfg.crawl.maxPinnedThreadPages,
        });
        thread.raw = { ...(thread.raw ?? {}), pinned: true };
        const { threadId, boardDb } = await upsertThread(siteKey, thread, { isPinned: true });
        await upsertPosts(boardDb, threadId, thread.posts);
      } catch (e) {
        logger.warn({ siteKey, board: board.boardKey, articleId, err: String(e) }, 'init: pinned thread fetch failed; skipping');
      }
    }
    logger.info({ siteKey, board: board.boardKey, count: ids.length }, 'init: pinned threads persisted');
  }
}

export interface RefreshBoardStatsOpts {
  /** Refresh every board under one section (one HTTP request per section). */
  sectionKey?: string;
  /**
   * Refresh stats for a single board. The crawler still has to fetch the
   * board's parent section page (that's where the numbers live), so all
   * sibling boards under the same parent are refreshed as a side effect.
   */
  boardName?: string;
  /**
   * Refresh every section that owns at least one board. Visits each parent
   * section page exactly once.
   */
  all?: boolean;
}

export interface RefreshBoardStatsResult {
  sectionsVisited: number;
  boardsUpdated: number;
}

/**
 * Lightweight refresh of `daily_traffic` for boards under one or more parent
 * sections. Does NOT crawl threads. Each section page is the source for
 * `online / today / threads / posts`, so the API surface is parent-section-
 * oriented even when the caller specifies a single board.
 */
export async function runRefreshBoardStats(
  page: Page,
  siteKey: string,
  opts: RefreshBoardStatsOpts,
): Promise<RefreshBoardStatsResult> {
  const adapter = getAdapter(siteKey);
  if (!adapter.listSectionChildren) {
    throw new Error(`Adapter ${siteKey} has no listSectionChildren`);
  }
  const cfg = loadSiteConfig(siteKey);
  const interval = cfg.crawl.structureRequestIntervalMs;

  const targets = await resolveRefreshTargets(siteKey, opts);
  let boardsUpdated = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const children = await adapter.listSectionChildren(page, t.sectionKey);
    for (const b of children.boards) {
      const { boardId } = await upsertBoard({
        siteKey,
        boardKey: b.boardKey,
        name: b.name,
        sectionId: t.sectionId,
        moderators: b.moderators,
      });
      await upsertDailyTraffic(boardId, b.stats);
      boardsUpdated++;
    }
    logger.info(
      { siteKey, sectionKey: t.sectionKey, boards: children.boards.length },
      'refresh: section stats persisted',
    );
    if (i < targets.length - 1) await sleep(interval);
  }
  return { sectionsVisited: targets.length, boardsUpdated };
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

  // opts.all — every section that owns at least one board, visited once.
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
