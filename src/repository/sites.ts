import { getStructureDb } from './db';
import { DatabaseError } from '../core/errors';

export interface SiteRow {
  siteKey: string;
  displayName: string;
  baseUrl: string;
}

export async function upsertSite(row: SiteRow): Promise<void> {
  try {
    // Check if site exists
    const exists = await getStructureDb().query(
      `SELECT site_key FROM sites WHERE site_key = $1`,
      [row.siteKey]
    );

    if (exists.rows.length > 0) {
      // Update
      await getStructureDb().query(
        `UPDATE sites
         SET display_name = $1,
             base_url     = $2
         WHERE site_key = $3`,
        [row.displayName, row.baseUrl, row.siteKey],
      );
    } else {
      // Insert
      await getStructureDb().query(
        `INSERT INTO sites (site_key, display_name, base_url, created_at)
         VALUES ($1, $2, $3, datetime('now'))`,
        [row.siteKey, row.displayName, row.baseUrl],
      );
    }
  } catch (e) {
    throw new DatabaseError(`upsertSite failed for ${row.siteKey}`, e);
  }
}
