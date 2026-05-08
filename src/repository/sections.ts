import { getPool } from './db';
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

export async function hasSections(siteKey: string): Promise<boolean> {
  try {
    const r = await getPool().query<{ c: number }>(
      `SELECT count(*)::int AS c FROM sections WHERE site_key = $1`,
      [siteKey],
    );
    return (r.rows[0]?.c ?? 0) > 0;
  } catch (e) {
    throw new DatabaseError(`hasSections failed for ${siteKey}`, e);
  }
}

/**
 * Sections (any depth) that have zero boards under them. Used by the init
 * orchestrator to decide which sections need a re-crawl of their children.
 */
export async function sectionsMissingBoards(siteKey: string): Promise<SectionRow[]> {
  try {
    const r = await getPool().query<{ id: string; section_key: string; name: string | null }>(
      `SELECT s.id, s.section_key, s.name
         FROM sections s
         LEFT JOIN boards b ON b.section_id = s.id
        WHERE s.site_key = $1
        GROUP BY s.id, s.section_key, s.name
       HAVING count(b.id) = 0
        ORDER BY s.id`,
      [siteKey],
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      sectionKey: row.section_key,
      name: row.name,
    }));
  } catch (e) {
    throw new DatabaseError(`sectionsMissingBoards failed for ${siteKey}`, e);
  }
}

export async function listTopLevelSections(siteKey: string): Promise<SectionRow[]> {
  try {
    const r = await getPool().query<{ id: string; section_key: string; name: string | null }>(
      `SELECT id, section_key, name FROM sections
       WHERE site_key = $1 AND parent_section_id IS NULL
       ORDER BY id`,
      [siteKey],
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      sectionKey: row.section_key,
      name: row.name,
    }));
  } catch (e) {
    throw new DatabaseError(`listTopLevelSections failed for ${siteKey}`, e);
  }
}

export async function upsertSection(input: UpsertSectionInput): Promise<UpsertSectionResult> {
  try {
    const r = await getPool().query<{ id: string }>(
      `INSERT INTO sections (site_key, section_key, parent_section_id, name, last_crawled_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (site_key, section_key) DO UPDATE
         SET name              = EXCLUDED.name,
             parent_section_id = EXCLUDED.parent_section_id,
             last_crawled_at   = now()
       RETURNING id`,
      [input.siteKey, input.sectionKey, input.parentSectionId ?? null, input.name],
    );
    return { sectionId: Number(r.rows[0]!.id) };
  } catch (e) {
    throw new DatabaseError(`upsertSection failed for ${input.siteKey}/${input.sectionKey}`, e);
  }
}
