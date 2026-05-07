import { getPool } from './db';
import { DatabaseError } from '../core/errors';
import type { Thread } from '../core/site-adapter';

export interface UpsertThreadResult { threadId: number; }

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
        null, null, null, null,
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
