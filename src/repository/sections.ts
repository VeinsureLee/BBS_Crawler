/**
 * Section nodes — forum (top-level) + sub_forum (nested discussion areas).
 *
 * Backed by the unified `nodes` table in structure.db. This file owns inserts
 * and queries where `type IN ('forum', 'sub_forum')`. Boards (type='board')
 * live in boards.ts; both files share the same underlying table.
 *
 * Function names kept compatible with the pre-Phase-3 API so init-runners /
 * init-orchestrator dependency injection doesn't need re-wiring.
 */
import { getStructureDb } from './db';
import { DatabaseError } from '../core/errors';

export interface UpsertSectionInput {
  siteKey: string;
  sectionKey: string;
  name: string;
  parentSectionId?: number | null;
}

export interface UpsertSectionResult { sectionId: number; }

export interface SectionRow {
  id: number;
  sectionKey: string;
  name: string | null;
}

/** Replace any character that's awkward on Windows/macOS/Linux paths with '_'. */
function safeFileName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** dbFile path for the per-forum SQLite file, relative to dataDir. */
function forumDbFile(sectionKey: string): string {
  return `forums/${safeFileName(sectionKey)}.db`;
}

export async function hasSections(siteKey: string): Promise<boolean> {
  try {
    const r = await getStructureDb().query<{ c: number }>(
      `SELECT count(*) AS c FROM nodes
        WHERE site_key = $1 AND type IN ('forum','sub_forum')`,
      [siteKey],
    );
    return (r.rows[0]?.c ?? 0) > 0;
  } catch (e) {
    throw new DatabaseError(`hasSections failed for ${siteKey}`, e);
  }
}

/**
 * Section nodes (forum + sub_forum, any depth) that have no board children
 * directly underneath them. Used by the init orchestrator to figure out
 * which sections still need step 2 (init:boards).
 */
export async function sectionsMissingBoards(siteKey: string): Promise<SectionRow[]> {
  try {
    const r = await getStructureDb().query<{ id: number; node_key: string; name: string | null }>(
      `SELECT s.id, s.node_key, s.name
         FROM nodes s
         LEFT JOIN nodes b
                ON b.parent_id = s.id
               AND b.type = 'board'
        WHERE s.site_key = $1 AND s.type IN ('forum','sub_forum')
        GROUP BY s.id, s.node_key, s.name
       HAVING count(b.id) = 0
        ORDER BY s.id`,
      [siteKey],
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      sectionKey: row.node_key,
      name: row.name,
    }));
  } catch (e) {
    throw new DatabaseError(`sectionsMissingBoards failed for ${siteKey}`, e);
  }
}

/** Top-level forum nodes (level=0, type='forum'). */
export async function listTopLevelSections(siteKey: string): Promise<SectionRow[]> {
  try {
    const r = await getStructureDb().query<{ id: number; node_key: string; name: string | null }>(
      `SELECT id, node_key, name FROM nodes
        WHERE site_key = $1 AND type = 'forum'
        ORDER BY id`,
      [siteKey],
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      sectionKey: row.node_key,
      name: row.name,
    }));
  } catch (e) {
    throw new DatabaseError(`listTopLevelSections failed for ${siteKey}`, e);
  }
}

/**
 * Insert or update a section node. Derives `type` from whether parent is set:
 *   - parentSectionId is null   → type='forum'    (top-level; assigns db_file)
 *   - parentSectionId is given  → type='sub_forum'
 *
 * `level` is computed as parent.level + 1, or 0 for forums.
 */
export async function upsertSection(input: UpsertSectionInput): Promise<UpsertSectionResult> {
  try {
    const db = getStructureDb();
    const isForum = !input.parentSectionId;
    let level = 0;
    if (input.parentSectionId) {
      const parent = await db.query<{ level: number }>(
        `SELECT level FROM nodes WHERE id = $1`,
        [input.parentSectionId],
      );
      const parentLevel = parent.rows[0]?.level;
      if (parentLevel === undefined) {
        throw new DatabaseError(`Parent node ${input.parentSectionId} not found`);
      }
      level = parentLevel + 1;
    }
    const type = isForum ? 'forum' : 'sub_forum';
    const dbFile = isForum ? forumDbFile(input.sectionKey) : null;

    const exists = await db.query<{ id: number }>(
      `SELECT id FROM nodes WHERE site_key = $1 AND node_key = $2`,
      [input.siteKey, input.sectionKey],
    );

    if (exists.rows.length > 0) {
      const id = exists.rows[0]!.id;
      // Refuse to set parent_id to self — happens when the adapter's
      // listSectionChildren returns the current section among its children.
      const safeParentId = input.parentSectionId === id
        ? null
        : (input.parentSectionId ?? null);
      await db.query(
        `UPDATE nodes
            SET name = $1,
                parent_id = COALESCE($2, parent_id),
                type = COALESCE($3, type),
                level = $4,
                db_file = COALESCE($5, db_file),
                last_crawled_at = datetime('now')
          WHERE id = $6`,
        [input.name, safeParentId, type, level, dbFile, id],
      );
      return { sectionId: id };
    }
    await db.query(
      `INSERT INTO nodes
         (site_key, node_key, name, parent_id, type, level, db_file, last_crawled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, datetime('now'))`,
      [
        input.siteKey,
        input.sectionKey,
        input.name,
        input.parentSectionId ?? null,
        type,
        level,
        dbFile,
      ],
    );
    const r = await db.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    return { sectionId: r.rows[0]!.id };
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`upsertSection failed for ${input.siteKey}/${input.sectionKey}`, e);
  }
}
