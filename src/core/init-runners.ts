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
import { getAdapter } from './registry';
import { logger } from '../util/logger';
import { upsertSite } from '../repository/sites';
import {
  listTopLevelSections,
  upsertSection,
  type SectionRow,
} from '../repository/sections';
import {
  upsertBoard,
  type BoardRow,
} from '../repository/boards';
import { upsertThread } from '../repository/threads';
import { upsertPosts } from '../repository/posts';
import { loadSiteConfig, loadSiteEntries, validateConfigConsistency } from './site-config';

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
      await upsertBoard({
        siteKey, boardKey: b.boardKey, name: b.name,
        sectionId: sec.id, moderators: b.moderators, stats: b.stats,
      });
    }
    for (const sub of children.subSections) {
      const { sectionId } = await upsertSection({
        siteKey, sectionKey: sub.sectionKey, name: sub.name, parentSectionId: sec.id,
      });
      await sleep(interval);
      const nested = await adapter.listSectionChildren(page, sub.sectionKey);
      for (const b of nested.boards) {
        await upsertBoard({
          siteKey, boardKey: b.boardKey, name: b.name,
          sectionId, moderators: b.moderators, stats: b.stats,
        });
      }
    }
    await sleep(interval);
    logger.info({ siteKey, sectionKey: sec.sectionKey }, 'init: section children persisted');
  }
}

/**
 * For each board in `boards`, fetch its pinned-thread ids, then fetch each
 * thread and persist with is_pinned=true. Sequential (no concurrency) — the
 * MCP-triggered path runs one board at a time so it stays predictable; the
 * standalone `init:pinned` script keeps its parallel implementation.
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
        const { threadId, forumDb } = await upsertThread(siteKey, thread, { isPinned: true });
        await upsertPosts(forumDb, threadId, thread.posts);
      } catch (e) {
        logger.warn({ siteKey, board: board.boardKey, articleId, err: String(e) }, 'init: pinned thread fetch failed; skipping');
      }
    }
    logger.info({ siteKey, board: board.boardKey, count: ids.length }, 'init: pinned threads persisted');
  }
}
