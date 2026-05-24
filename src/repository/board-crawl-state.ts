/**
 * Per-board crawl progress (watermark + deepest page). Stored in the board db
 * the row belongs to, keyed by `board_node_id` (structure.db.nodes.id).
 *
 * Used by listThreadsByName to:
 *   - resume incremental crawls (stop when posted_at <= latest_thread_posted_at)
 *   - report deepest page ever reached
 */
import { getBoardDb, type Db } from './db.js';
import { DatabaseError } from '../core/errors.js';
import { findBoardDbPath } from './boards.js';

export interface BoardCrawlState {
  boardId: number;
  deepestPageCrawled: number;
  latestThreadPostedAt: string | null;
  lastCrawledAt: string | null;
  lastThreadKey: string | null;
}

export interface UpsertBoardCrawlStateInput {
  boardId: number;
  deepestPageCrawled?: number;
  latestThreadPostedAt?: string;
  lastCrawledAt?: string;
  lastThreadKey?: string;
}

async function boardDbFor(boardNodeId: number): Promise<Db> {
  const dbPath = await findBoardDbPath(boardNodeId);
  if (!dbPath) {
    throw new DatabaseError(`No db_path for board node ${boardNodeId}`);
  }
  return getBoardDb(dbPath);
}

export async function getBoardCrawlState(boardId: number): Promise<BoardCrawlState | null> {
  try {
    const boardDb = await boardDbFor(boardId);
    const r = await boardDb.query<{
      board_node_id: number;
      deepest_page_crawled: number;
      latest_thread_posted_at: string | null;
      last_crawled_at: string | null;
      last_thread_key: string | null;
    }>(
      `SELECT board_node_id, deepest_page_crawled, latest_thread_posted_at, last_crawled_at, last_thread_key
         FROM board_crawl_state
        WHERE board_node_id = $1`,
      [boardId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      boardId: Number(row.board_node_id),
      deepestPageCrawled: row.deepest_page_crawled,
      latestThreadPostedAt: row.latest_thread_posted_at,
      lastCrawledAt: row.last_crawled_at,
      lastThreadKey: row.last_thread_key,
    };
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`getBoardCrawlState failed for board ${boardId}`, e);
  }
}

export async function upsertBoardCrawlState(input: UpsertBoardCrawlStateInput): Promise<void> {
  try {
    const boardDb = await boardDbFor(input.boardId);
    const exists = await boardDb.query<{
      deepest_page_crawled: number;
      latest_thread_posted_at: string | null;
    }>(
      `SELECT deepest_page_crawled, latest_thread_posted_at
         FROM board_crawl_state WHERE board_node_id = $1`,
      [input.boardId],
    );

    if (exists.rows.length > 0) {
      const existingRow = exists.rows[0]!;
      const newDeepest = input.deepestPageCrawled !== undefined
        ? Math.max(existingRow.deepest_page_crawled, input.deepestPageCrawled)
        : existingRow.deepest_page_crawled;

      let newLatestPosted = existingRow.latest_thread_posted_at;
      if (input.latestThreadPostedAt) {
        if (!existingRow.latest_thread_posted_at ||
            input.latestThreadPostedAt > existingRow.latest_thread_posted_at) {
          newLatestPosted = input.latestThreadPostedAt;
        }
      }

      await boardDb.query(
        `UPDATE board_crawl_state
            SET deepest_page_crawled    = $1,
                latest_thread_posted_at = $2,
                last_crawled_at         = COALESCE($3, last_crawled_at),
                last_thread_key         = COALESCE($4, last_thread_key)
          WHERE board_node_id = $5`,
        [
          newDeepest,
          newLatestPosted,
          input.lastCrawledAt ?? null,
          input.lastThreadKey ?? null,
          input.boardId,
        ],
      );
    } else {
      await boardDb.query(
        `INSERT INTO board_crawl_state
            (board_node_id, deepest_page_crawled, latest_thread_posted_at, last_crawled_at, last_thread_key)
         VALUES ($1, COALESCE($2, 0), $3, $4, $5)`,
        [
          input.boardId,
          input.deepestPageCrawled ?? null,
          input.latestThreadPostedAt ?? null,
          input.lastCrawledAt ?? null,
          input.lastThreadKey ?? null,
        ],
      );
    }
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`upsertBoardCrawlState failed for board ${input.boardId}`, e);
  }
}
