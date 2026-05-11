import { getContentDb } from './db';
import { DatabaseError } from '../core/errors';

export type FetchLogStatus = 'ok' | 'error' | 'rate_limited';

export interface FetchLogRow {
  siteKey: string;
  tool: string;
  args: Record<string, unknown>;
  status: FetchLogStatus;
  errorCode?: string;
  durationMs?: number;
}

export async function appendFetchLog(row: FetchLogRow): Promise<void> {
  try {
    await getContentDb().query(
      `INSERT INTO fetch_log (site_key, tool, args, status, error_code, duration_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, datetime('now'))`,
      [
        row.siteKey, row.tool, JSON.stringify(row.args),
        row.status, row.errorCode ?? null, row.durationMs ?? null,
      ],
    );
  } catch (e) {
    throw new DatabaseError('appendFetchLog failed', e);
  }
}
