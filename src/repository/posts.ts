/**
 * Post (thread floor) writes — operate on a board db handle resolved by the
 * caller. Get the handle from `upsertThread` / `upsertThreadSummary`, then
 * pass it to `upsertPosts` here. This avoids repeating the (siteKey, boardKey)
 * → board-db lookup.
 */
import type { Db } from './db.js';
import { DatabaseError } from '../errors.js';
import type { Post } from '../contract/site-adapter.js';

/**
 * Insert/update floors for a thread row. Idempotent — re-running with the
 * same payload is a no-op (rows match by (thread_id, floor) unique key).
 */
export async function upsertPosts(
  boardDb: Db,
  threadId: number,
  posts: Post[],
): Promise<void> {
  if (posts.length === 0) return;
  try {
    await boardDb.transaction(async (tx) => {
      for (const p of posts) {
        const exists = await tx.query<{ id: number }>(
          `SELECT id FROM posts WHERE thread_id = $1 AND floor = $2`,
          [threadId, p.floor],
        );

        if (exists.rows.length > 0) {
          await tx.query(
            `UPDATE posts
                SET author        = $1,
                    posted_at     = COALESCE($2, posted_at),
                    content_html  = $3,
                    content_text  = $4,
                    attachments   = COALESCE($5, attachments),
                    raw           = COALESCE($6, raw)
              WHERE thread_id = $7 AND floor = $8`,
            [
              p.author, p.postedAt ?? null,
              p.contentHtml, p.contentText,
              p.attachments ? JSON.stringify(p.attachments) : null,
              p.raw ? JSON.stringify(p.raw) : null,
              threadId, p.floor,
            ],
          );
        } else {
          await tx.query(
            `INSERT INTO posts
               (thread_id, floor, author, posted_at, content_html, content_text, attachments, raw)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              threadId, p.floor, p.author, p.postedAt ?? null,
              p.contentHtml, p.contentText,
              p.attachments ? JSON.stringify(p.attachments) : null,
              p.raw ? JSON.stringify(p.raw) : null,
            ],
          );
        }
      }
    });
  } catch (e) {
    throw new DatabaseError(`upsertPosts failed for thread ${threadId}`, e);
  }
}
