import { getPool } from './db';
import { DatabaseError } from '../core/errors';

export interface SearchCacheParams {
  keyword: string;
  siteKey?: string | undefined;
  limit?: number | undefined;
}

export interface SearchCacheRow {
  id: number;
  url: string;
  title: string;
  floor: number | null;
  author: string | null;
  content_text: string | null;
}

const SEARCH_SQL = `
  SELECT t.id, t.url, t.title, p.floor, p.author, p.content_text
  FROM threads t
  LEFT JOIN posts p ON p.thread_id = t.id
  WHERE ($1::text IS NULL OR t.site_key = $1)
    AND (
      to_tsvector('simple', coalesce(t.title, '')) @@ plainto_tsquery('simple', $2)
      OR to_tsvector('simple', coalesce(p.content_text, '')) @@ plainto_tsquery('simple', $2)
    )
  LIMIT $3
`;

export async function searchCache(params: SearchCacheParams): Promise<SearchCacheRow[]> {
  const limit = params.limit ?? 50;
  try {
    const r = await getPool().query<SearchCacheRow>(
      SEARCH_SQL,
      [params.siteKey ?? null, params.keyword, limit],
    );
    return r.rows;
  } catch (e) {
    throw new DatabaseError('searchCache failed', e);
  }
}
