import { getStructureDb } from './db';
import { DatabaseError } from '../core/errors';
import type { BoardStats } from '../core/site-adapter';

export interface UpsertBoardInput {
  siteKey: string;
  boardKey: string;
  name: string;
  sectionId?: number | null;
  moderators?: string[];
  stats?: BoardStats;
}

export interface UpsertBoardResult { boardId: number; }

export interface BoardRow {
  id: number;
  boardKey: string;
  name: string | null;
}

/**
 * Boards that have zero pinned threads. Used by the init orchestrator to
 * resume init for boards that were skipped or failed previously.
 */
export async function boardsMissingPinned(siteKey: string): Promise<BoardRow[]> {
  try {
    const r = await getStructureDb().query<{ id: number; board_key: string; name: string | null }>(
      `SELECT b.id, b.board_key, b.name
         FROM boards b
         LEFT JOIN threads t
                ON t.site_key = b.site_key
               AND t.board_key = b.board_key
               AND t.is_pinned = 1
        WHERE b.site_key = $1
        GROUP BY b.id, b.board_key, b.name
       HAVING count(t.id) = 0
        ORDER BY b.id`,
      [siteKey],
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      boardKey: row.board_key,
      name: row.name,
    }));
  } catch (e) {
    throw new DatabaseError(`boardsMissingPinned failed for ${siteKey}`, e);
  }
}

export async function listBoards(siteKey: string): Promise<BoardRow[]> {
  try {
    const r = await getStructureDb().query<{ id: number; board_key: string; name: string | null }>(
      `SELECT id, board_key, name FROM boards WHERE site_key = $1 ORDER BY id`,
      [siteKey],
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      boardKey: row.board_key,
      name: row.name,
    }));
  } catch (e) {
    throw new DatabaseError(`listBoards failed for ${siteKey}`, e);
  }
}

export async function upsertBoard(input: UpsertBoardInput): Promise<UpsertBoardResult> {
  try {
    // Check if board exists
    const exists = await getStructureDb().query<{ id: number }>(
      `SELECT id FROM boards WHERE site_key = $1 AND board_key = $2`,
      [input.siteKey, input.boardKey]
    );

    if (exists.rows.length > 0) {
      // Update existing
      const id = exists.rows[0]!.id;
      await getStructureDb().query(
        `UPDATE boards
         SET name            = $1,
             section_id      = $2,
             moderators      = COALESCE($3, moderators),
             stats           = COALESCE($4, stats),
             last_crawled_at = datetime('now')
         WHERE id = $5`,
        [
          input.name,
          input.sectionId ?? null,
          input.moderators ? JSON.stringify(input.moderators) : null,
          input.stats ? JSON.stringify(input.stats) : null,
          id,
        ],
      );
      return { boardId: id };
    } else {
      // Insert new
      await getStructureDb().query(
        `INSERT INTO boards
          (site_key, board_key, name, section_id, moderators, stats, last_crawled_at)
         VALUES ($1, $2, $3, $4, $5, $6, datetime('now'))`,
        [
          input.siteKey,
          input.boardKey,
          input.name,
          input.sectionId ?? null,
          input.moderators ? JSON.stringify(input.moderators) : null,
          input.stats ? JSON.stringify(input.stats) : null,
        ],
      );
      const r = await getStructureDb().query<{ id: number }>(`SELECT last_insert_rowid() as id`);
      return { boardId: r.rows[0]!.id };
    }
  } catch (e) {
    throw new DatabaseError(`upsertBoard failed for ${input.siteKey}/${input.boardKey}`, e);
  }
}
