/**
 * Thread metadata — stored in the per-forum SQLite file resolved by board key.
 *
 * `upsertThread` returns the forum db handle alongside the inserted thread id
 * so callers can chain `upsertPosts(forumDb, threadId, posts)` without paying
 * for a second routing lookup.
 */
import { getForumDb, type Db } from './db';
import { DatabaseError } from '../core/errors';
import { resolveBoardRoute } from './boards';
import { logger } from '../util/logger';
import type { Thread, ThreadSummary } from '../core/site-adapter';

export interface UpsertThreadResult {
  threadId: number;
  /** Forum db handle the thread was written into. Pass this to `upsertPosts`. */
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

export interface UpsertThreadOptions {
  /** Sticky/pinned status. OR-merged into DB so init-marked pins survive. */
  isPinned?: boolean;
}

async function routeForBoard(
  siteKey: string,
  boardKey: string,
): Promise<{ boardNodeId: number; forumDb: Db }> {
  logger.info({ boardKey }, '    routeForBoard: resolveBoardRoute');
  const route = await resolveBoardRoute(siteKey, boardKey);
  logger.info({ dbFile: route.forumDbFile, boardNodeId: route.boardNodeId }, '    routeForBoard: resolveBoardRoute 完成');
  logger.info({}, '    routeForBoard: getForumDb');
  const forumDb = getForumDb(route.forumDbFile);
  logger.info({}, '    routeForBoard: getForumDb 完成');
  return { boardNodeId: route.boardNodeId, forumDb };
}

function threadAuthor(t: Thread): string | null {
  return t.posts[0]?.author ?? null;
}

async function existsInForumDb(forumDb: Db, url: string): Promise<ThreadExistsResult> {
  const r = await forumDb.query<{
    id: number;
    last_fetched_at: string;
    last_reply_at: string | null;
    reply_count: number | null;
  }>(
    `SELECT id, last_fetched_at, last_reply_at, reply_count
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
  };
}

/**
 * Look up a thread by (siteKey, boardKey, url). Note: boardKey is required —
 * after Phase 3 we need it to find which forum db holds the thread.
 */
export async function checkThreadExists(
  siteKey: string,
  boardKey: string,
  url: string,
): Promise<ThreadExistsResult> {
  try {
    const { forumDb } = await routeForBoard(siteKey, boardKey);
    return await existsInForumDb(forumDb, url);
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`checkThreadExists failed for ${url}`, e);
  }
}

/**
 * Return the set of already-crawled URLs for a single board. Used by
 * crawl-board scripts for quick "have I seen this thread?" checks.
 */
export async function getCrawledThreadUrls(
  siteKey: string,
  boardKey: string,
): Promise<Set<string>> {
  try {
    const { boardNodeId, forumDb } = await routeForBoard(siteKey, boardKey);
    const r = await forumDb.query<{ url: string }>(
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
 * Insert or update a full thread (used by getThread persistence path).
 * Returns the threadId AND the forum db handle so the caller can chain
 * `upsertPosts(forumDb, threadId, thread.posts)`.
 */
export async function upsertThread(
  siteKey: string,
  t: Thread,
  options: UpsertThreadOptions = {},
): Promise<UpsertThreadResult> {
  const isPinned = options.isPinned ?? false;
  if (!t.board) {
    throw new DatabaseError(`upsertThread: thread for ${t.url} has no board key`);
  }
  try {
    logger.info({ url: t.url, board: t.board }, '  upsertThread: routeForBoard');
    const { boardNodeId, forumDb } = await routeForBoard(siteKey, t.board);
    logger.info({ boardNodeId }, '  upsertThread: routeForBoard 完成');

    logger.info({}, '  upsertThread: existsInForumDb');
    const existing = await existsInForumDb(forumDb, t.url);
    logger.info({ exists: existing.exists, threadId: existing.threadId }, '  upsertThread: existsInForumDb 完成');

    if (existing.exists && existing.threadId) {
      logger.info({}, '  upsertThread: UPDATE');
      await forumDb.query(
        `UPDATE threads
           SET title           = $1,
               author          = COALESCE($2, author),
               board_node_id   = $3,
               posted_at       = COALESCE($4, posted_at),
               last_reply_at   = COALESCE($5, last_reply_at),
               reply_count     = COALESCE($6, reply_count),
               view_count      = COALESCE($7, view_count),
               raw             = COALESCE($8, raw),
               is_pinned       = is_pinned OR $9,
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
          isPinned ? 1 : 0,
          existing.threadId,
        ],
      );
      logger.info({}, '  upsertThread: UPDATE 完成');
      return { threadId: existing.threadId, forumDb };
    }

    logger.info({}, '  upsertThread: INSERT');
    await forumDb.query(
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
        isPinned ? 1 : 0,
      ],
    );
    logger.info({}, '  upsertThread: INSERT 完成，取 id');
    const r = await forumDb.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    logger.info({ id: r.rows[0]?.id }, '  upsertThread: 拿到 id');
    return { threadId: Number(r.rows[0]!.id), forumDb };
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`upsertThread failed for ${t.url}`, e);
  }
}

/**
 * Lightweight upsert for thread-list rows (no post bodies). Same OR-merge
 * semantics on is_pinned as `upsertThread`.
 */
export async function upsertThreadSummary(
  siteKey: string,
  s: ThreadSummary,
  options: UpsertThreadOptions = {},
): Promise<UpsertThreadResult> {
  const isPinned = options.isPinned ?? false;
  if (!s.board) {
    throw new DatabaseError(`upsertThreadSummary: summary for ${s.url} has no board key`);
  }
  try {
    const { boardNodeId, forumDb } = await routeForBoard(siteKey, s.board);
    const existing = await existsInForumDb(forumDb, s.url);

    if (existing.exists && existing.threadId) {
      await forumDb.query(
        `UPDATE threads
           SET title           = $1,
               author          = COALESCE($2, author),
               board_node_id   = $3,
               posted_at       = COALESCE($4, posted_at),
               last_reply_at   = COALESCE($5, last_reply_at),
               reply_count     = COALESCE($6, reply_count),
               view_count      = COALESCE($7, view_count),
               raw             = COALESCE($8, raw),
               is_pinned       = is_pinned OR $9,
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
          isPinned ? 1 : 0,
          existing.threadId,
        ],
      );
      return { threadId: existing.threadId, forumDb };
    }

    await forumDb.query(
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
        isPinned ? 1 : 0,
      ],
    );
    const r = await forumDb.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    return { threadId: Number(r.rows[0]!.id), forumDb };
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`upsertThreadSummary failed for ${s.url}`, e);
  }
}
