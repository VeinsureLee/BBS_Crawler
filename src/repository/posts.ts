import { getDb } from './db';
import { DatabaseError } from '../core/errors';
import type { Post } from '../core/site-adapter';

export async function upsertPosts(threadId: number, posts: Post[]): Promise<void> {
  if (posts.length === 0) return;
  try {
    await getDb().transaction(async (tx) => {
      for (const p of posts) {
        await tx.query(
          `INSERT INTO posts
             (thread_id, floor, author, posted_at, content_html, content_text, attachments, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (thread_id, floor) DO UPDATE
             SET author        = EXCLUDED.author,
                 posted_at     = COALESCE(EXCLUDED.posted_at, posts.posted_at),
                 content_html  = EXCLUDED.content_html,
                 content_text  = EXCLUDED.content_text,
                 attachments   = COALESCE(EXCLUDED.attachments, posts.attachments),
                 raw           = COALESCE(EXCLUDED.raw, posts.raw)`,
          [
            threadId, p.floor, p.author, p.postedAt ?? null,
            p.contentHtml, p.contentText,
            p.attachments ? JSON.stringify(p.attachments) : null,
            p.raw ? JSON.stringify(p.raw) : null,
          ],
        );
      }
    });
  } catch (e) {
    throw new DatabaseError(`upsertPosts failed for thread ${threadId}`, e);
  }
}
