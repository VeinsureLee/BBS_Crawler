import { getPool } from './db';
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

export async function listBoards(siteKey: string): Promise<BoardRow[]> {
  try {
    const r = await getPool().query<{ id: string; board_key: string; name: string | null }>(
      `SELECT id, board_key, name FROM boards WHERE site_key=$1 ORDER BY id`,
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
    const r = await getPool().query<{ id: string }>(
      `INSERT INTO boards
        (site_key, board_key, name, section_id, moderators, stats, last_crawled_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (site_key, board_key) DO UPDATE
         SET name            = EXCLUDED.name,
             section_id      = EXCLUDED.section_id,
             moderators      = COALESCE(EXCLUDED.moderators, boards.moderators),
             stats           = COALESCE(EXCLUDED.stats, boards.stats),
             last_crawled_at = now()
       RETURNING id`,
      [
        input.siteKey,
        input.boardKey,
        input.name,
        input.sectionId ?? null,
        input.moderators ? JSON.stringify(input.moderators) : null,
        input.stats ? JSON.stringify(input.stats) : null,
      ],
    );
    return { boardId: Number(r.rows[0]!.id) };
  } catch (e) {
    throw new DatabaseError(`upsertBoard failed for ${input.siteKey}/${input.boardKey}`, e);
  }
}
