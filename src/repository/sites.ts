import { getPool } from './db';
import { DatabaseError } from '../core/errors';

export interface SiteRow {
  siteKey: string;
  displayName: string;
  baseUrl: string;
}

export async function upsertSite(row: SiteRow): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO sites (site_key, display_name, base_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (site_key) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             base_url     = EXCLUDED.base_url`,
      [row.siteKey, row.displayName, row.baseUrl],
    );
  } catch (e) {
    throw new DatabaseError(`upsertSite failed for ${row.siteKey}`, e);
  }
}
