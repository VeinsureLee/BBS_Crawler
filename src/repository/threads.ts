import { getPool } from './db';
import { DatabaseError } from '../core/errors';
import type { Thread } from '../core/site-adapter';

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
    const r = await getPool().query<{
      id: string;
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
    const r = await getPool().query<{ url: string }>(
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

export async function upsertThread(siteKey: string, t: Thread): Promise<UpsertThreadResult> {
  try {
    const r = await getPool().query<{ id: string }>(
      `INSERT INTO threads
        (site_key, url, title, author, board_key,
         posted_at, last_reply_at, reply_count, view_count, raw, last_fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (site_key, url) DO UPDATE
         SET title          = EXCLUDED.title,
             author         = COALESCE(EXCLUDED.author, threads.author),
             board_key      = COALESCE(EXCLUDED.board_key, threads.board_key),
             posted_at      = COALESCE(EXCLUDED.posted_at, threads.posted_at),
             last_reply_at  = COALESCE(EXCLUDED.last_reply_at, threads.last_reply_at),
             reply_count    = COALESCE(EXCLUDED.reply_count, threads.reply_count),
             view_count     = COALESCE(EXCLUDED.view_count, threads.view_count),
             raw            = COALESCE(EXCLUDED.raw, threads.raw),
             last_fetched_at = now()
       RETURNING id`,
      [
        siteKey, t.url, t.title,
        threadAuthor(t),
        t.board ?? null,
        t.posts[0]?.postedAt ?? null,
        t.posts[t.posts.length - 1]?.postedAt ?? null,
        t.posts.length > 0 ? t.posts.length - 1 : null,
        null,
        t.raw ? JSON.stringify(t.raw) : null,
      ],
    );
    return { threadId: Number(r.rows[0]!.id) };
  } catch (e) {
    throw new DatabaseError(`upsertThread failed for ${t.url}`, e);
  }
}

function threadAuthor(t: Thread): string | null {
  return t.posts[0]?.author ?? null;
}
