/**
 * Thread metadata — stored in the per-forum SQLite file resolved by board key.
 *
 * Threads live in one of two tables:
 *   - pinned_threads / pinned_posts  (sticky/top threads)
 *   - plain_threads  / plain_posts   (regular threads)
 *
 * A URL is in EITHER table, never both. When a thread's sticky status flips
 * between crawls, the upsert functions DELETE the row from the opposite table
 * before INSERT/UPDATE in the target table — FK cascade removes the matching
 * posts. The caller then writes posts into the correct posts table via
 * `upsertPinnedPosts` / `upsertPlainPosts`.
 *
 * `upsertPinnedThread` / `upsertPlainThread` return the forum db handle
 * alongside the inserted thread id so callers can chain
 * `upsertPinnedPosts(forumDb, threadId, posts)` (or the plain variant)
 * without paying for a second routing lookup.
 */
import { getForumDb, type Db } from './db';
import { DatabaseError } from '../core/errors';
import { resolveBoardRoute } from './boards';
import { logger } from '../util/logger';
import type { Thread, ThreadSummary } from '../core/site-adapter';

export type ThreadKind = 'pinned' | 'plain';

export interface UpsertThreadResult {
  threadId: number;
  /** Forum db handle the thread was written into. Pass this to the matching `upsertPinnedPosts` / `upsertPlainPosts`. */
  forumDb: Db;
}

export interface ThreadExistsResult {
  exists: boolean;
  threadId?: number;
  lastFetchedAt?: string;
  lastReplyAt?: string | undefined;
  replyCount?: number | undefined;
}

export interface FetchSkippedResult {
  skipped: boolean;
  threadId?: number;
}

const THREADS_TABLE: Record<ThreadKind, string> = {
  pinned: 'pinned_threads',
  plain: 'plain_threads',
};

function oppositeKind(k: ThreadKind): ThreadKind {
  return k === 'pinned' ? 'plain' : 'pinned';
}

async function routeForBoard(
  siteKey: string,
  boardKey: string,
): Promise<{ boardNodeId: number; forumDb: Db }> {
  logger.debug({ boardKey }, '    routeForBoard: resolveBoardRoute');
  const route = await resolveBoardRoute(siteKey, boardKey);
  logger.debug({ dbFile: route.forumDbFile, boardNodeId: route.boardNodeId }, '    routeForBoard: resolveBoardRoute 完成');
  logger.debug({}, '    routeForBoard: getForumDb');
  const forumDb = getForumDb(route.forumDbFile);
  logger.debug({}, '    routeForBoard: getForumDb 完成');
  return { boardNodeId: route.boardNodeId, forumDb };
}

function threadAuthor(t: Thread): string | null {
  return t.posts[0]?.author ?? null;
}

async function existsInForumDb(
  forumDb: Db,
  url: string,
  kind: ThreadKind,
): Promise<ThreadExistsResult> {
  const r = await forumDb.query<{
    id: number;
    last_fetched_at: string;
    last_reply_at: string | null;
    reply_count: number | null;
  }>(
    `SELECT id, last_fetched_at, last_reply_at, reply_count
       FROM ${THREADS_TABLE[kind]} WHERE url = $1`,
    [url],
  );
  if (r.rows.length === 0) return { exists: false };
  const row = r.rows[0]!;
  return {
    exists: true,
    threadId: Number(row.id),
    lastFetchedAt: row.last_fetched_at,
    lastReplyAt: row.last_reply_at ?? undefined,
    replyCount: row.reply_count ?? undefined,
  };
}

/**
 * Remove the row (and its cascaded posts) for `url` from the opposite-kind
 * table, if present. Cheap when nothing matches — single indexed delete.
 */
async function evictFromOpposite(
  forumDb: Db,
  url: string,
  targetKind: ThreadKind,
): Promise<void> {
  const opp = oppositeKind(targetKind);
  await forumDb.query(
    `DELETE FROM ${THREADS_TABLE[opp]} WHERE url = $1`,
    [url],
  );
}

/**
 * Look up a thread by (siteKey, boardKey, url) in the given kind's table.
 * boardKey is required — after Phase 3 we need it to find which forum db
 * holds the thread.
 */
export async function checkThreadExists(
  siteKey: string,
  boardKey: string,
  url: string,
  kind: ThreadKind,
): Promise<ThreadExistsResult> {
  try {
    const { forumDb } = await routeForBoard(siteKey, boardKey);
    return await existsInForumDb(forumDb, url, kind);
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`checkThreadExists failed for ${url}`, e);
  }
}

/**
 * Return the set of already-crawled URLs for a single board, restricted to
 * one kind's table. Used by crawl-board scripts for quick "have I seen this
 * thread?" checks.
 */
export async function getCrawledThreadUrls(
  siteKey: string,
  boardKey: string,
  kind: ThreadKind,
): Promise<Set<string>> {
  try {
    const { boardNodeId, forumDb } = await routeForBoard(siteKey, boardKey);
    const r = await forumDb.query<{ url: string }>(
      `SELECT url FROM ${THREADS_TABLE[kind]} WHERE board_node_id = $1`,
      [boardNodeId],
    );
    return new Set(r.rows.map((row) => row.url));
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError('getCrawledThreadUrls failed', e);
  }
}

/**
 * Decide whether to skip a fetch. Skip if:
 *   - thread exists in `kind`'s table AND
 *   - (summary replyCount matches existing OR within freshness window)
 */
export async function shouldSkipFetch(
  siteKey: string,
  boardKey: string,
  url: string,
  kind: ThreadKind,
  summaryReplyCount?: number,
  freshnessHours: number = 24,
): Promise<FetchSkippedResult> {
  const existing = await checkThreadExists(siteKey, boardKey, url, kind);
  if (!existing.exists || !existing.threadId) return { skipped: false };

  if (summaryReplyCount !== undefined && existing.replyCount === summaryReplyCount) {
    return { skipped: true, threadId: existing.threadId };
  }

  if (existing.lastFetchedAt) {
    const lastFetched = new Date(existing.lastFetchedAt);
    const now = new Date();
    const hoursSinceFetched = (now.getTime() - lastFetched.getTime()) / (1000 * 60 * 60);
    if (hoursSinceFetched < freshnessHours) {
      return { skipped: true, threadId: existing.threadId };
    }
  }

  return { skipped: false };
}

async function upsertThreadInto(
  siteKey: string,
  t: Thread,
  kind: ThreadKind,
): Promise<UpsertThreadResult> {
  if (!t.board) {
    throw new DatabaseError(`upsertThread: thread for ${t.url} has no board key`);
  }
  const table = THREADS_TABLE[kind];
  try {
    logger.debug({ url: t.url, board: t.board, kind }, '  upsertThread: routeForBoard');
    const { boardNodeId, forumDb } = await routeForBoard(siteKey, t.board);
    logger.debug({ boardNodeId, kind }, '  upsertThread: routeForBoard 完成');

    await evictFromOpposite(forumDb, t.url, kind);

    logger.debug({ kind }, '  upsertThread: existsInForumDb');
    const existing = await existsInForumDb(forumDb, t.url, kind);
    logger.debug({ exists: existing.exists, threadId: existing.threadId, kind }, '  upsertThread: existsInForumDb 完成');

    if (existing.exists && existing.threadId) {
      logger.debug({ kind }, '  upsertThread: UPDATE');
      await forumDb.query(
        `UPDATE ${table}
           SET title           = $1,
               author          = COALESCE($2, author),
               board_node_id   = $3,
               posted_at       = COALESCE($4, posted_at),
               last_reply_at   = COALESCE($5, last_reply_at),
               reply_count     = COALESCE($6, reply_count),
               view_count      = COALESCE($7, view_count),
               raw             = COALESCE($8, raw),
               last_fetched_at = datetime('now')
         WHERE id = $9`,
        [
          t.title,
          threadAuthor(t),
          boardNodeId,
          t.posts[0]?.postedAt ?? null,
          t.posts[t.posts.length - 1]?.postedAt ?? null,
          t.posts.length > 0 ? t.posts.length - 1 : null,
          null,
          t.raw ? JSON.stringify(t.raw) : null,
          existing.threadId,
        ],
      );
      logger.debug({ kind }, '  upsertThread: UPDATE 完成');
      return { threadId: existing.threadId, forumDb };
    }

    logger.debug({ kind }, '  upsertThread: INSERT');
    await forumDb.query(
      `INSERT INTO ${table}
         (board_node_id, url, title, author,
          posted_at, last_reply_at, reply_count, view_count, raw,
          last_fetched_at, first_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, datetime('now'), datetime('now'))`,
      [
        boardNodeId,
        t.url,
        t.title,
        threadAuthor(t),
        t.posts[0]?.postedAt ?? null,
        t.posts[t.posts.length - 1]?.postedAt ?? null,
        t.posts.length > 0 ? t.posts.length - 1 : null,
        null,
        t.raw ? JSON.stringify(t.raw) : null,
      ],
    );
    const r = await forumDb.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    logger.debug({ id: r.rows[0]?.id, kind }, '  upsertThread: 拿到 id');
    return { threadId: Number(r.rows[0]!.id), forumDb };
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`upsertThread (${kind}) failed for ${t.url}`, e);
  }
}

/** Insert/update a thread into `pinned_threads`. Evicts any plain row first. */
export async function upsertPinnedThread(siteKey: string, t: Thread): Promise<UpsertThreadResult> {
  return upsertThreadInto(siteKey, t, 'pinned');
}

/** Insert/update a thread into `plain_threads`. Evicts any pinned row first. */
export async function upsertPlainThread(siteKey: string, t: Thread): Promise<UpsertThreadResult> {
  return upsertThreadInto(siteKey, t, 'plain');
}

async function upsertThreadSummaryInto(
  siteKey: string,
  s: ThreadSummary,
  kind: ThreadKind,
): Promise<UpsertThreadResult> {
  if (!s.board) {
    throw new DatabaseError(`upsertThreadSummary: summary for ${s.url} has no board key`);
  }
  const table = THREADS_TABLE[kind];
  try {
    const { boardNodeId, forumDb } = await routeForBoard(siteKey, s.board);
    await evictFromOpposite(forumDb, s.url, kind);
    const existing = await existsInForumDb(forumDb, s.url, kind);

    if (existing.exists && existing.threadId) {
      await forumDb.query(
        `UPDATE ${table}
           SET title           = $1,
               author          = COALESCE($2, author),
               board_node_id   = $3,
               posted_at       = COALESCE($4, posted_at),
               last_reply_at   = COALESCE($5, last_reply_at),
               reply_count     = COALESCE($6, reply_count),
               view_count      = COALESCE($7, view_count),
               raw             = COALESCE($8, raw),
               last_fetched_at = datetime('now')
         WHERE id = $9`,
        [
          s.title,
          s.author ?? null,
          boardNodeId,
          s.postedAt ?? null,
          s.lastReplyAt ?? null,
          s.replyCount ?? null,
          s.viewCount ?? null,
          s.raw ? JSON.stringify(s.raw) : null,
          existing.threadId,
        ],
      );
      return { threadId: existing.threadId, forumDb };
    }

    await forumDb.query(
      `INSERT INTO ${table}
         (board_node_id, url, title, author,
          posted_at, last_reply_at, reply_count, view_count, raw,
          last_fetched_at, first_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, datetime('now'), datetime('now'))`,
      [
        boardNodeId,
        s.url,
        s.title,
        s.author ?? null,
        s.postedAt ?? null,
        s.lastReplyAt ?? null,
        s.replyCount ?? null,
        s.viewCount ?? null,
        s.raw ? JSON.stringify(s.raw) : null,
      ],
    );
    const r = await forumDb.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    return { threadId: Number(r.rows[0]!.id), forumDb };
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`upsertThreadSummary (${kind}) failed for ${s.url}`, e);
  }
}

/** Lightweight upsert for a pinned thread-list row (no post bodies). */
export async function upsertPinnedThreadSummary(siteKey: string, s: ThreadSummary): Promise<UpsertThreadResult> {
  return upsertThreadSummaryInto(siteKey, s, 'pinned');
}

/** Lightweight upsert for a plain thread-list row (no post bodies). */
export async function upsertPlainThreadSummary(siteKey: string, s: ThreadSummary): Promise<UpsertThreadResult> {
  return upsertThreadSummaryInto(siteKey, s, 'plain');
}
