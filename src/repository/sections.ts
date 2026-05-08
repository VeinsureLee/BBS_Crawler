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
