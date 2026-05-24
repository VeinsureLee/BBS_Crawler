/**
 * Board nodes (type='board') — leaf containers that hold threads.
 *
 * Each board row owns its own `.db` file at the path stored in `nodes.db_path`,
 * composed from the parent's `full_path` + `safeFileName(node_key) + '.db'`.
 * Forum / sub_forum rows above don't own a file; they only contribute their
 * `node_key` to the directory chain.
 *
 * Stats are no longer stored on the node row — daily_traffic (inside the
 * board db) is the single source of truth for online / today / threads / posts.
 */
import { getStructureDb } from './db.js';
import { DatabaseError } from '../core/errors.js';
import { logger } from '../util/logger.js';
import { safeFileName } from './sections.js';

export interface UpsertBoardInput {
  siteKey: string;
  boardKey: string;
  name: string;
  /** Immediate parent node id (forum or sub_forum). */
  sectionId?: number | null;
  moderators?: string[];
}

export interface UpsertBoardResult { boardId: number; dbPath: string; }

export interface BoardRow {
  id: number;
  boardKey: string;
  name: string | null;
}

/**
 * Find the relative `db_path` stored for a board node. Returns null when the
 * node is missing or isn't a board.
 */
export async function findBoardDbPath(boardNodeId: number): Promise<string | null> {
  try {
    const r = await getStructureDb().query<{ db_path: string | null; type: string }>(
      `SELECT db_path, type FROM nodes WHERE id = $1`,
      [boardNodeId],
    );
    const row = r.rows[0];
    if (!row || row.type !== 'board') return null;
    return row.db_path ?? null;
  } catch (e) {
    throw new DatabaseError(`findBoardDbPath failed for nodeId=${boardNodeId}`, e);
  }
}

/**
 * Find a board node by (siteKey, boardKey) and return its node id plus the
 * `.db` file path it owns. Used by content repositories to figure out where
 * to write. Throws if board or its db_path is missing.
 */
export async function resolveBoardRoute(
  siteKey: string,
  boardKey: string,
): Promise<{ boardNodeId: number; dbPath: string }> {
  try {
    logger.debug({ siteKey, boardKey }, '    resolveBoardRoute: SELECT board');
    const r = await getStructureDb().query<{ id: number; db_path: string | null }>(
      `SELECT id, db_path FROM nodes
        WHERE site_key = $1 AND node_key = $2 AND type = 'board'`,
      [siteKey, boardKey],
    );
    const row = r.rows[0];
    if (!row) {
      throw new DatabaseError(`Board not found: ${siteKey}/${boardKey}`);
    }
    if (!row.db_path) {
      throw new DatabaseError(`Board ${siteKey}/${boardKey} has no db_path (was it inserted before Layout-A migration?)`);
    }
    return { boardNodeId: Number(row.id), dbPath: row.db_path };
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`resolveBoardRoute failed for ${siteKey}/${boardKey}`, e);
  }
}

/**
 * List all board nodes for a site.
 */
export async function listBoards(siteKey: string): Promise<BoardRow[]> {
  try {
    const r = await getStructureDb().query<{ id: number; node_key: string; name: string }>(
      `SELECT id, node_key, name FROM nodes
        WHERE site_key = $1 AND type = 'board'
        ORDER BY id`,
      [siteKey],
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      boardKey: row.node_key,
      name: row.name,
    }));
  } catch (e) {
    throw new DatabaseError(`listBoards failed for ${siteKey}`, e);
  }
}

/**
 * Boards whose `.db` file does not yet exist on disk — proxy for "we haven't
 * crawled threads here yet". Used by the init orchestrator to resume.
 *
 * Cheap because boards know their own db_path; no recursive CTE, no opening
 * forum dbs.
 */
export async function boardsMissingPinned(siteKey: string): Promise<BoardRow[]> {
  try {
    const { getDataDir } = await import('./db');
    const fs = await import('node:fs');
    const path = await import('node:path');

    const r = await getStructureDb().query<{
      id: number; node_key: string; name: string; db_path: string | null;
    }>(
      `SELECT id, node_key, name, db_path FROM nodes
        WHERE site_key = $1 AND type = 'board'
        ORDER BY id`,
      [siteKey],
    );

    const dataDir = getDataDir();
    const missing: BoardRow[] = [];
    for (const row of r.rows) {
      if (!row.db_path) {
        missing.push({ id: Number(row.id), boardKey: row.node_key, name: row.name });
        continue;
      }
      const abs = path.isAbsolute(row.db_path)
        ? row.db_path
        : path.join(dataDir, row.db_path);
      if (!fs.existsSync(abs)) {
        missing.push({ id: Number(row.id), boardKey: row.node_key, name: row.name });
      }
    }
    return missing;
  } catch (e) {
    throw new DatabaseError(`boardsMissingPinned failed for ${siteKey}`, e);
  }
}

/**
 * Insert or update a board node. `sectionId` is the immediate parent node id
 * (forum or sub_forum). Computes `db_path` and `full_path` from the parent's
 * full_path + safeFileName(boardKey). moderators is stored as JSON on the row.
 */
export async function upsertBoard(input: UpsertBoardInput): Promise<UpsertBoardResult> {
  try {
    const db = getStructureDb();
    if (input.sectionId == null) {
      throw new DatabaseError(`upsertBoard requires a parent sectionId (board ${input.boardKey})`);
    }
    const parent = await db.query<{ level: number; full_path: string | null }>(
      `SELECT level, full_path FROM nodes WHERE id = $1`,
      [input.sectionId],
    );
    const parentRow = parent.rows[0];
    if (!parentRow) {
      throw new DatabaseError(`Parent node ${input.sectionId} not found`);
    }
    const level = parentRow.level + 1;
    const safeBoard = safeFileName(input.boardKey);
    const parentPath = parentRow.full_path ?? '';
    const fullPath = parentPath ? `${parentPath}/${safeBoard}` : safeBoard;
    const dbPath = `forums/${fullPath}.db`;

    const exists = await db.query<{ id: number }>(
      `SELECT id FROM nodes WHERE site_key = $1 AND node_key = $2`,
      [input.siteKey, input.boardKey],
    );

    if (exists.rows.length > 0) {
      const id = exists.rows[0]!.id;
      const safeParentId = input.sectionId === id ? null : input.sectionId;
      await db.query(
        `UPDATE nodes
            SET name      = $1,
                parent_id = COALESCE($2, parent_id),
                type      = 'board',
                level     = $3,
                full_path = $4,
                db_path   = $5,
                moderators = COALESCE($6, moderators),
                last_crawled_at = datetime('now')
          WHERE id = $7`,
        [
          input.name,
          safeParentId,
          level,
          fullPath,
          dbPath,
          input.moderators ? JSON.stringify(input.moderators) : null,
          id,
        ],
      );
      return { boardId: id, dbPath };
    }
    await db.query(
      `INSERT INTO nodes
         (site_key, node_key, name, parent_id, type, level, full_path, db_path, moderators, last_crawled_at)
       VALUES ($1, $2, $3, $4, 'board', $5, $6, $7, $8, datetime('now'))`,
      [
        input.siteKey,
        input.boardKey,
        input.name,
        input.sectionId,
        level,
        fullPath,
        dbPath,
        input.moderators ? JSON.stringify(input.moderators) : null,
      ],
    );
    const r = await db.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    return { boardId: r.rows[0]!.id, dbPath };
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`upsertBoard failed for ${input.siteKey}/${input.boardKey}`, e);
  }
}
