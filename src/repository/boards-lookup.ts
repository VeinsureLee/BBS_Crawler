/**
 * Lookups for board nodes (`nodes WHERE type='board'`) in structure.db.
 * Used by crawler-service to translate user-facing names → board node ids.
 */
import { getStructureDb } from './db.js';
import { DatabaseError } from '../core/errors.js';

export interface BoardRow {
  id: number;
  siteKey: string;
  boardKey: string;
  name: string;
}

/**
 * Strict-equality lookup of a board by its display name. Returns null when
 * not found — callers translate that into BOARD_NOT_FOUND for the agent.
 *
 * Names come from the agent (e.g. "北邮人在上海") and must match the value
 * stored in `nodes.name` exactly. Case-sensitive.
 */
export async function findBoardByName(
  siteKey: string,
  name: string,
): Promise<BoardRow | null> {
  try {
    const r = await getStructureDb().query<{
      id: number;
      site_key: string;
      node_key: string;
      name: string;
    }>(
      `SELECT id, site_key, node_key, name
         FROM nodes
        WHERE site_key = $1 AND name = $2 AND type = 'board'
        LIMIT 1`,
      [siteKey, name],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      siteKey: row.site_key,
      boardKey: row.node_key,
      name: row.name,
    };
  } catch (e) {
    throw new DatabaseError(`findBoardByName failed for ${siteKey}/${name}`, e);
  }
}

/**
 * Fast presence check by node id. Used by the init orchestrator to verify a
 * board exists before scheduling a crawl.
 */
export async function getBoardById(boardId: number): Promise<BoardRow | null> {
  try {
    const r = await getStructureDb().query<{
      id: number;
      site_key: string;
      node_key: string;
      name: string;
    }>(
      `SELECT id, site_key, node_key, name FROM nodes
        WHERE id = $1 AND type = 'board'
        LIMIT 1`,
      [boardId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      siteKey: row.site_key,
      boardKey: row.node_key,
      name: row.name,
    };
  } catch (e) {
    throw new DatabaseError(`getBoardById failed for ${boardId}`, e);
  }
}
