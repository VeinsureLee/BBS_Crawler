/**
 * Thread metadata — stored in the per-board SQLite file resolved by board key.
 *
 * Single `threads` table with an `is_pinned INTEGER` column. OR-merge semantic:
 * once a URL is recorded as pinned (is_pinned=1), subsequent upserts never
 * clear the flag back to 0. This matches the documented data contract and
 * removes the old pinned_threads / plain_threads table-name encoding.
 *
 * `upsertThread` / `upsertThreadSummary` return the board db handle alongside
 * the inserted thread id so callers can chain `upsertPosts(boardDb, ...)`
 * without paying for a second routing lookup.
 */
import { getBoardDb, type Db } from './db.js';
import { DatabaseError } from '../core/errors.js';
import { resolveBoardRoute } from './boards.js';
import { logger } from '../util/logger.js';
import type { Thread, ThreadSummary } from '../contract/site-adapter.js';

export interface UpsertThreadOpts {
  isPinned: boolean;
}

export interface UpsertThreadResult {
  threadId: number;
  /** Board db handle the thread was written into. Pass this to `upsertPosts`. */
  boardDb: Db;
}

export interface ThreadExistsResult {
  exists: boolean;
  threadId?: number;
  lastFetchedAt?: string;
  lastReplyAt?: string | undefined;
  replyCount?: number | undefined;
  isPinned?: boolean;
}

export interface FetchSkippedResult {
  skipped: boolean;
  threadId?: number;
}

async function routeForBoard(
  siteKey: string,
  boardKey: string,
): Promise<{ boardNodeId: number; boardDb: Db }> {
  logger.debug({ boardKey }, '    routeForBoard: resolveBoardRoute');
  const route = await resolveBoardRoute(siteKey, boardKey);
  logger.debug({ dbPath: route.dbPath, boardNodeId: route.boardNodeId }, '    routeForBoard: resolveBoardRoute 完成');
  const boardDb = getBoardDb(route.dbPath);
  return { boardNodeId: route.boardNodeId, boardDb };
}

function threadAuthor(t: Thread): string | null {
  return t.posts[0]?.author ?? null;
}

async function existsInBoardDb(
  boardDb: Db,
  url: string,
): Promise<ThreadExistsResult> {
  const r = await boardDb.query<{
    id: number;
    last_fetched_at: string;
    last_reply_at: string | null;
    reply_count: number | null;
    is_pinned: number;
  }>(
    `SELECT id, last_fetched_at, last_reply_at, reply_count, is_pinned
       FROM threads WHERE url = $1`,
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
    isPinned: row.is_pinned === 1,
  };
}

/**
 * Look up a thread by (siteKey, boardKey, url).
 */
export async function checkThreadExists(
  siteKey: string,
  boardKey: string,
  url: string,
): Promise<ThreadExistsResult> {
  try {
    const { boardDb } = await routeForBoard(siteKey, boardKey);
    return await existsInBoardDb(boardDb, url);
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`checkThreadExists failed for ${url}`, e);
  }
}

/**
 * Return the set of already-crawled URLs for a single board.
 */
export async function getCrawledThreadUrls(
  siteKey: string,
  boardKey: string,
): Promise<Set<string>> {
  try {
    const { boardNodeId, boardDb } = await routeForBoard(siteKey, boardKey);
    const r = await boardDb.query<{ url: string }>(
      `SELECT url FROM threads WHERE board_node_id = $1`,
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
 *   - thread exists AND
 *   - (summary replyCount matches existing OR within freshness window)
 */
export async function shouldSkipFetch(
  siteKey: string,
  boardKey: string,
  url: string,
  summaryReplyCount?: number,
  freshnessHours: number = 24,
): Promise<FetchSkippedResult> {
  const existing = await checkThreadExists(siteKey, boardKey, url);
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

/**
 * Insert or update a thread row. `opts.isPinned` is OR-merged with existing
 * value: once a URL has been recorded as pinned, it stays pinned.
 */
export async function upsertThread(
  siteKey: string,
  t: Thread,
  opts: UpsertThreadOpts,
): Promise<UpsertThreadResult> {
  if (!t.board) {
    throw new DatabaseError(`upsertThread: thread for ${t.url} has no board key`);
  }
  const isPinnedInt = opts.isPinned ? 1 : 0;
  try {
    logger.debug({ url: t.url, board: t.board, isPinned: opts.isPinned }, '  upsertThread: routeForBoard');
    const { boardNodeId, boardDb } = await routeForBoard(siteKey, t.board);

    const existing = await existsInBoardDb(boardDb, t.url);

    if (existing.exists && existing.threadId) {
      const mergedPinned = (existing.isPinned ? 1 : 0) | isPinnedInt;
      await boardDb.query(
        `UPDATE threads
           SET title           = $1,
               author          = COALESCE($2, author),
               board_node_id   = $3,
               posted_at       = COALESCE($4, posted_at),
               last_reply_at   = COALESCE($5, last_reply_at),
               reply_count     = COALESCE($6, reply_count),
               view_count      = COALESCE($7, view_count),
               raw             = COALESCE($8, raw),
               is_pinned       = $9,
               last_fetched_at = datetime('now')
         WHERE id = $10`,
        [
          t.title,
          threadAuthor(t),
          boardNodeId,
          t.posts[0]?.postedAt ?? null,
          t.posts[t.posts.length - 1]?.postedAt ?? null,
          t.posts.length > 0 ? t.posts.length - 1 : null,
          null,
          t.raw ? JSON.stringify(t.raw) : null,
          mergedPinned,
          existing.threadId,
        ],
      );
      return { threadId: existing.threadId, boardDb };
    }

    await boardDb.query(
      `INSERT INTO threads
         (board_node_id, url, title, author,
          posted_at, last_reply_at, reply_count, view_count, raw, is_pinned,
          last_fetched_at, first_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, datetime('now'), datetime('now'))`,
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
        isPinnedInt,
      ],
    );
    const r = await boardDb.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    return { threadId: Number(r.rows[0]!.id), boardDb };
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`upsertThread failed for ${t.url}`, e);
  }
}

/**
 * Lightweight upsert for a thread-list row (no post bodies). Same OR-merge
 * pinning behaviour as `upsertThread`.
 */
export async function upsertThreadSummary(
  siteKey: string,
  s: ThreadSummary,
  opts: UpsertThreadOpts,
): Promise<UpsertThreadResult> {
  if (!s.board) {
    throw new DatabaseError(`upsertThreadSummary: summary for ${s.url} has no board key`);
  }
  const isPinnedInt = opts.isPinned ? 1 : 0;
  try {
    const { boardNodeId, boardDb } = await routeForBoard(siteKey, s.board);
    const existing = await existsInBoardDb(boardDb, s.url);

    if (existing.exists && existing.threadId) {
      const mergedPinned = (existing.isPinned ? 1 : 0) | isPinnedInt;
      await boardDb.query(
        `UPDATE threads
           SET title           = $1,
               author          = COALESCE($2, author),
               board_node_id   = $3,
               posted_at       = COALESCE($4, posted_at),
               last_reply_at   = COALESCE($5, last_reply_at),
               reply_count     = COALESCE($6, reply_count),
               view_count      = COALESCE($7, view_count),
               raw             = COALESCE($8, raw),
               is_pinned       = $9,
               last_fetched_at = datetime('now')
         WHERE id = $10`,
        [
          s.title,
          s.author ?? null,
          boardNodeId,
          s.postedAt ?? null,
          s.lastReplyAt ?? null,
          s.replyCount ?? null,
          s.viewCount ?? null,
          s.raw ? JSON.stringify(s.raw) : null,
          mergedPinned,
          existing.threadId,
        ],
      );
      return { threadId: existing.threadId, boardDb };
    }

    await boardDb.query(
      `INSERT INTO threads
         (board_node_id, url, title, author,
          posted_at, last_reply_at, reply_count, view_count, raw, is_pinned,
          last_fetched_at, first_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, datetime('now'), datetime('now'))`,
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
        isPinnedInt,
      ],
    );
    const r = await boardDb.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    return { threadId: Number(r.rows[0]!.id), boardDb };
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`upsertThreadSummary failed for ${s.url}`, e);
  }
}
