import { getContentDb } from './db';
import { DatabaseError } from '../core/errors';
import type { Thread, ThreadSummary } from '../core/site-adapter';

export interface UpsertThreadResult { threadId: number; }

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

/**
 * Check if a thread already exists in the database by URL.
 */
export async function checkThreadExists(siteKey: string, url: string): Promise<ThreadExistsResult> {
  try {
    const r = await getContentDb().query<{
      id: number;
      last_fetched_at: string;
      last_reply_at: string | null;
      reply_count: number | null;
    }>(
      `SELECT id, last_fetched_at, last_reply_at, reply_count
       FROM threads
       WHERE site_key = $1 AND url = $2`,
      [siteKey, url],
    );
    if (r.rows.length === 0) {
      return { exists: false };
    }
    const row = r.rows[0]!;
    return {
      exists: true,
      threadId: Number(row.id),
      lastFetchedAt: row.last_fetched_at,
      lastReplyAt: row.last_reply_at ?? undefined,
      replyCount: row.reply_count ?? undefined,
    };
  } catch (e) {
    throw new DatabaseError(`checkThreadExists failed for ${url}`, e);
  }
}

/**
 * Get all thread URLs for a site and board that have been crawled.
 */
export async function getCrawledThreadUrls(siteKey: string, boardKey?: string): Promise<Set<string>> {
  try {
    const r = await getContentDb().query<{ url: string }>(
      `SELECT url FROM threads WHERE site_key = $1 ${boardKey ? 'AND board_key = $2' : ''}`,
      boardKey ? [siteKey, boardKey] : [siteKey],
    );
    return new Set(r.rows.map(row => row.url));
  } catch (e) {
    throw new DatabaseError('getCrawledThreadUrls failed', e);
  }
}

/**
 * Determine if we should skip fetching a thread that already exists.
 * Skip if:
 *   - Thread exists AND
 *   - (replyCount hasn't changed OR lastFetchedAt is within the freshness window)
 */
export async function shouldSkipFetch(
  siteKey: string,
  url: string,
  summaryReplyCount?: number,
  freshnessHours: number = 24,
): Promise<FetchSkippedResult> {
  const existing = await checkThreadExists(siteKey, url);
  if (!existing.exists || !existing.threadId) {
    return { skipped: false };
  }

  // If we have a summary reply count and it matches existing, skip
  if (summaryReplyCount !== undefined && existing.replyCount === summaryReplyCount) {
    return { skipped: true, threadId: existing.threadId };
  }

  // If last fetched within freshness window, skip
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

export interface UpsertThreadOptions {
  /**
   * Whether this thread is a pinned/sticky thread on the board.
   * Defaults to false. Once a row is marked pinned in the DB it is NOT
   * downgraded by a later upsert with `false` — the OR semantics keep
   * pinned status stable until an explicit re-init flips it.
   */
  isPinned?: boolean;
}

export async function upsertThread(
  siteKey: string,
  t: Thread,
  options: UpsertThreadOptions = {},
): Promise<UpsertThreadResult> {
  const isPinned = options.isPinned ?? false;
  try {
    // First check if the thread exists
    const existing = await checkThreadExists(siteKey, t.url);

    if (existing.exists && existing.threadId) {
      // Update existing thread
      await getContentDb().query(
        `UPDATE threads
         SET title          = $1,
             author         = COALESCE($2, author),
             board_key      = COALESCE($3, board_key),
             posted_at      = COALESCE($4, posted_at),
             last_reply_at  = COALESCE($5, last_reply_at),
             reply_count    = COALESCE($6, reply_count),
             view_count     = COALESCE($7, view_count),
             raw            = COALESCE($8, raw),
             is_pinned      = is_pinned OR $9,
             last_fetched_at = datetime('now')
         WHERE id = $10`,
        [
          t.title,
          threadAuthor(t),
          t.board ?? null,
          t.posts[0]?.postedAt ?? null,
          t.posts[t.posts.length - 1]?.postedAt ?? null,
          t.posts.length > 0 ? t.posts.length - 1 : null,
          null,
          t.raw ? JSON.stringify(t.raw) : null,
          isPinned ? 1 : 0,
          existing.threadId,
        ],
      );
      return { threadId: existing.threadId };
    } else {
      // Insert new thread
      await getContentDb().query(
        `INSERT INTO threads
          (site_key, url, title, author, board_key,
           posted_at, last_reply_at, reply_count, view_count, raw, is_pinned, last_fetched_at, first_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, datetime('now'), datetime('now'))`,
        [
          siteKey, t.url, t.title,
          threadAuthor(t),
          t.board ?? null,
          t.posts[0]?.postedAt ?? null,
          t.posts[t.posts.length - 1]?.postedAt ?? null,
          t.posts.length > 0 ? t.posts.length - 1 : null,
          null,
          t.raw ? JSON.stringify(t.raw) : null,
          isPinned ? 1 : 0,
        ],
      );
      // Get the last inserted id
      const r = await getContentDb().query<{ id: number }>(`SELECT last_insert_rowid() as id`);
      return { threadId: r.rows[0]!.id };
    }
  } catch (e) {
    throw new DatabaseError(`upsertThread failed for ${t.url}`, e);
  }
}

function threadAuthor(t: Thread): string | null {
  return t.posts[0]?.author ?? null;
}

/**
 * Lightweight upsert for thread-list rows (no post bodies). Used by
 * forum_list_threads which only knows summary metadata.
 *
 * Behavior:
 *   - is_pinned uses the same OR-merge as upsertThread (never downgrades a
 *     thread that init already marked pinned).
 *   - reply_count / last_reply_at / posted_at update only when the new value
 *     is provided; existing values are preserved otherwise.
 *   - last_fetched_at is bumped to now() to reflect this row was just seen.
 */
export async function upsertThreadSummary(
  siteKey: string,
  s: ThreadSummary,
  options: UpsertThreadOptions = {},
): Promise<UpsertThreadResult> {
  const isPinned = options.isPinned ?? false;
  try {
    // First check if the thread exists
    const existing = await checkThreadExists(siteKey, s.url);

    if (existing.exists && existing.threadId) {
      // Update existing thread
      await getContentDb().query(
        `UPDATE threads
         SET title          = $1,
             author         = COALESCE($2, author),
             board_key      = COALESCE($3, board_key),
             posted_at      = COALESCE($4, posted_at),
             last_reply_at  = COALESCE($5, last_reply_at),
             reply_count    = COALESCE($6, reply_count),
             view_count     = COALESCE($7, view_count),
             raw            = COALESCE($8, raw),
             is_pinned      = is_pinned OR $9,
             last_fetched_at = datetime('now')
         WHERE id = $10`,
        [
          s.title,
          s.author ?? null,
          s.board ?? null,
          s.postedAt ?? null,
          s.lastReplyAt ?? null,
          s.replyCount ?? null,
          s.viewCount ?? null,
          s.raw ? JSON.stringify(s.raw) : null,
          isPinned ? 1 : 0,
          existing.threadId,
        ],
      );
      return { threadId: existing.threadId };
    } else {
      // Insert new thread
      await getContentDb().query(
        `INSERT INTO threads
          (site_key, url, title, author, board_key,
           posted_at, last_reply_at, reply_count, view_count, raw, is_pinned, last_fetched_at, first_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, datetime('now'), datetime('now'))`,
        [
          siteKey, s.url, s.title,
          s.author ?? null,
          s.board ?? null,
          s.postedAt ?? null,
          s.lastReplyAt ?? null,
          s.replyCount ?? null,
          s.viewCount ?? null,
          s.raw ? JSON.stringify(s.raw) : null,
          isPinned ? 1 : 0,
        ],
      );
      // Get the last inserted id
      const r = await getContentDb().query<{ id: number }>(`SELECT last_insert_rowid() as id`);
      return { threadId: r.rows[0]!.id };
    }
  } catch (e) {
    throw new DatabaseError(`upsertThreadSummary failed for ${s.url}`, e);
  }
}
