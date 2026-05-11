/**
 * Board nodes (type='board') — leaf containers that hold threads.
 *
 * After Phase 3, boards no longer have a dedicated table; they're stored as
 * rows in the unified `nodes` table in structure.db with `type = 'board'`.
 * Their detail data (moderators, stats) live as JSON columns on the same row.
 * Thread/post content lives in the forum-specific .db file referenced by the
 * board's ancestor forum node.
 */
import { getStructureDb, getForumDb } from './db';
import { DatabaseError } from '../core/errors';
import { logger } from '../util/logger';
import type { BoardStats } from '../core/site-adapter';

export interface UpsertBoardInput {
  siteKey: string;
  boardKey: string;
  name: string;
  /** Immediate parent node id (forum or sub_forum). */
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
 * Look up a board node's ancestor-forum db_file by walking up the parent chain.
 *
 * Cycle-safe: refuses to follow parent_id that equals current node (self-loop)
 * and caps depth at 20 — both guards exist because adapter-driven init can
 * corrupt `parent_id` if a section's page lists itself among its children.
 */
export async function findForumDbFileForBoard(boardNodeId: number): Promise<string | null> {
  try {
    logger.info({ boardNodeId }, '      findForumDbFileForBoard: recursive CTE 开始');
    const r = await getStructureDb().query<{ db_file: string | null }>(
      `WITH RECURSIVE up(node_id, depth) AS (
         SELECT $1, 0
         UNION ALL
         SELECT n.parent_id, u.depth + 1
           FROM up u JOIN nodes n ON n.id = u.node_id
          WHERE n.parent_id IS NOT NULL
            AND n.parent_id <> u.node_id
            AND u.depth < 20
       )
       SELECT n.db_file FROM up u JOIN nodes n ON n.id = u.node_id
        WHERE n.type = 'forum'
        LIMIT 1`,
      [boardNodeId],
    );
    logger.info({ boardNodeId, dbFile: r.rows[0]?.db_file }, '      findForumDbFileForBoard: CTE 返回');
    return r.rows[0]?.db_file ?? null;
  } catch (e) {
    throw new DatabaseError(`findForumDbFileForBoard failed for nodeId=${boardNodeId}`, e);
  }
}

/**
 * Find a board node by (siteKey, boardKey) and return its node id plus the
 * forum db_file it belongs to. Used by content repositories to figure out
 * "which forum db do I write to?". Throws if board or forum not found.
 */
export async function resolveBoardRoute(
  siteKey: string,
  boardKey: string,
): Promise<{ boardNodeId: number; forumDbFile: string }> {
  try {
    logger.info({ siteKey, boardKey }, '    resolveBoardRoute: SELECT board id');
    const r = await getStructureDb().query<{ id: number }>(
      `SELECT id FROM nodes WHERE site_key = $1 AND node_key = $2 AND type = 'board'`,
      [siteKey, boardKey],
    );
    logger.info({ rows: r.rows.length, firstId: r.rows[0]?.id }, '    resolveBoardRoute: SELECT 返回');
    const row = r.rows[0];
    if (!row) {
      throw new DatabaseError(`Board not found: ${siteKey}/${boardKey}`);
    }
    const dbFile = await findForumDbFileForBoard(Number(row.id));
    if (!dbFile) {
      throw new DatabaseError(`No ancestor forum (with db_file) for board ${siteKey}/${boardKey}`);
    }
    return { boardNodeId: Number(row.id), forumDbFile: dbFile };
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
 * Boards that have zero pinned threads. Used by the init orchestrator to
 * resume init:pinned for boards that were skipped or failed previously.
 *
 * Implementation: groups boards by their ancestor forum, opens each forum db
 * once, queries `SELECT DISTINCT board_node_id FROM threads WHERE is_pinned=1`,
 * then returns boards not in the union of those sets.
 */
export async function boardsMissingPinned(siteKey: string): Promise<BoardRow[]> {
  try {
    const r = await getStructureDb().query<{
      id: number;
      node_key: string;
      name: string;
      db_file: string;
    }>(
      `WITH RECURSIVE up(board_id, ancestor_id, depth) AS (
         SELECT b.id, b.parent_id, 0 FROM nodes b
          WHERE b.site_key = $1 AND b.type = 'board'
         UNION ALL
         SELECT u.board_id, n.parent_id, u.depth + 1
           FROM up u JOIN nodes n ON n.id = u.ancestor_id
          WHERE u.ancestor_id IS NOT NULL
            AND n.parent_id <> u.ancestor_id
            AND u.depth < 20
       )
       SELECT b.id, b.node_key, b.name, f.db_file
         FROM nodes b
         JOIN up u ON u.board_id = b.id
         JOIN nodes f ON f.id = u.ancestor_id AND f.type = 'forum'
        WHERE b.site_key = $1 AND b.type = 'board'
        ORDER BY b.id`,
      [siteKey],
    );

    const boards = r.rows.map((row) => ({
      id: Number(row.id),
      boardKey: row.node_key,
      name: row.name,
      dbFile: row.db_file,
    }));

    // Group by forum db, query each once for pinned thread board_node_ids.
    const byForum = new Map<string, typeof boards>();
    for (const b of boards) {
      const arr = byForum.get(b.dbFile) ?? [];
      arr.push(b);
      byForum.set(b.dbFile, arr);
    }

    const missing: BoardRow[] = [];
    for (const [dbFile, list] of byForum) {
      const forumDb = getForumDb(dbFile);
      const pinnedR = await forumDb.query<{ board_node_id: number }>(
        `SELECT DISTINCT board_node_id FROM threads WHERE is_pinned = 1`,
      );
      const pinnedSet = new Set(pinnedR.rows.map((row) => Number(row.board_node_id)));
      for (const b of list) {
        if (!pinnedSet.has(b.id)) {
          missing.push({ id: b.id, boardKey: b.boardKey, name: b.name });
        }
      }
    }
    return missing;
  } catch (e) {
    throw new DatabaseError(`boardsMissingPinned failed for ${siteKey}`, e);
  }
}

/**
 * Insert or update a board node. `sectionId` is the immediate parent node id
 * (forum or sub_forum). moderators/stats are stored as JSON on the node row.
 */
export async function upsertBoard(input: UpsertBoardInput): Promise<UpsertBoardResult> {
  try {
    const db = getStructureDb();
    if (input.sectionId == null) {
      throw new DatabaseError(`upsertBoard requires a parent sectionId (board ${input.boardKey})`);
    }
    // Compute level from parent.
    const parent = await db.query<{ level: number }>(
      `SELECT level FROM nodes WHERE id = $1`,
      [input.sectionId],
    );
    const parentLevel = parent.rows[0]?.level;
    if (parentLevel === undefined) {
      throw new DatabaseError(`Parent node ${input.sectionId} not found`);
    }
    const level = parentLevel + 1;

    const exists = await db.query<{ id: number }>(
      `SELECT id FROM nodes WHERE site_key = $1 AND node_key = $2`,
      [input.siteKey, input.boardKey],
    );

    if (exists.rows.length > 0) {
      const id = exists.rows[0]!.id;
      // Refuse self-loop.
      const safeParentId = input.sectionId === id ? null : input.sectionId;
      await db.query(
        `UPDATE nodes
            SET name      = $1,
                parent_id = COALESCE($2, parent_id),
                type      = 'board',
                level     = $3,
                moderators = COALESCE($4, moderators),
                stats     = COALESCE($5, stats),
                last_crawled_at = datetime('now')
          WHERE id = $6`,
        [
          input.name,
          safeParentId,
          level,
          input.moderators ? JSON.stringify(input.moderators) : null,
          input.stats ? JSON.stringify(input.stats) : null,
          id,
        ],
      );
      return { boardId: id };
    }
    await db.query(
      `INSERT INTO nodes
         (site_key, node_key, name, parent_id, type, level, moderators, stats, last_crawled_at)
       VALUES ($1, $2, $3, $4, 'board', $5, $6, $7, datetime('now'))`,
      [
        input.siteKey,
        input.boardKey,
        input.name,
        input.sectionId,
        level,
        input.moderators ? JSON.stringify(input.moderators) : null,
        input.stats ? JSON.stringify(input.stats) : null,
      ],
    );
    const r = await db.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    return { boardId: r.rows[0]!.id };
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`upsertBoard failed for ${input.siteKey}/${input.boardKey}`, e);
  }
}
