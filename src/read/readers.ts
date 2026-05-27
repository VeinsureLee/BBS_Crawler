import { getStructureDb, getBoardDb } from '../repository/db.js';
import { findBoardDbPath } from '../repository/boards.js';
import { DatabaseError } from '../errors.js';

export interface SiteInfo { siteKey: string; displayName: string; baseUrl: string; }
export interface SectionInfo { id: number; sectionKey: string; name: string; type: 'forum' | 'sub_forum'; level: number; fullPath: string | null; parentId: number | null; }
export interface BoardInfo { id: number; boardKey: string; name: string; parentId: number | null; dbPath: string | null; }
export interface ThreadRow {
  id: number; url: string; title: string; author: string | null;
  postedAt: string | null; lastReplyAt: string | null;
  replyCount: number | null; viewCount: number | null; isPinned: boolean;
}
export interface PostRow {
  floor: number; author: string; postedAt: string | null;
  contentHtml: string; contentText: string; attachments: unknown;
}

export async function listSites(): Promise<SiteInfo[]> {
  const r = await getStructureDb().query<{ site_key: string; display_name: string; base_url: string }>(
    `SELECT site_key, display_name, base_url FROM sites ORDER BY site_key`,
  );
  return r.rows.map((x) => ({ siteKey: x.site_key, displayName: x.display_name, baseUrl: x.base_url }));
}

/** All forum/sub_forum nodes for a site (the discussion-area tree, flat). */
export async function listSections(siteKey: string): Promise<SectionInfo[]> {
  const r = await getStructureDb().query<{
    id: number; node_key: string; name: string; type: 'forum' | 'sub_forum';
    level: number; full_path: string | null; parent_id: number | null;
  }>(
    `SELECT id, node_key, name, type, level, full_path, parent_id FROM nodes
      WHERE site_key = $1 AND type IN ('forum','sub_forum') ORDER BY id`,
    [siteKey],
  );
  return r.rows.map((x) => ({
    id: Number(x.id), sectionKey: x.node_key, name: x.name, type: x.type,
    level: Number(x.level), fullPath: x.full_path, parentId: x.parent_id === null ? null : Number(x.parent_id),
  }));
}

/** Board nodes, optionally only those directly under `parentId`. */
export async function listBoards(siteKey: string, parentId?: number): Promise<BoardInfo[]> {
  const sql = parentId === undefined
    ? `SELECT id, node_key, name, parent_id, db_path FROM nodes WHERE site_key = $1 AND type = 'board' ORDER BY id`
    : `SELECT id, node_key, name, parent_id, db_path FROM nodes WHERE site_key = $1 AND type = 'board' AND parent_id = $2 ORDER BY id`;
  const params = parentId === undefined ? [siteKey] : [siteKey, parentId];
  const r = await getStructureDb().query<{ id: number; node_key: string; name: string; parent_id: number | null; db_path: string | null }>(sql, params);
  return r.rows.map((x) => ({
    id: Number(x.id), boardKey: x.node_key, name: x.name,
    parentId: x.parent_id === null ? null : Number(x.parent_id), dbPath: x.db_path,
  }));
}

function toThreadRow(x: {
  id: number; url: string; title: string; author: string | null;
  posted_at: string | null; last_reply_at: string | null;
  reply_count: number | null; view_count: number | null; is_pinned: number;
}): ThreadRow {
  return {
    id: Number(x.id), url: x.url, title: x.title, author: x.author,
    postedAt: x.posted_at, lastReplyAt: x.last_reply_at,
    replyCount: x.reply_count, viewCount: x.view_count, isPinned: x.is_pinned === 1,
  };
}

export interface ThreadsByBoardOpts { kind?: 'all' | 'pinned' | 'plain'; limit?: number; offset?: number; }

export async function listThreadsByBoard(boardNodeId: number, opts: ThreadsByBoardOpts = {}): Promise<ThreadRow[]> {
  const dbPath = await findBoardDbPath(boardNodeId);
  if (!dbPath) return [];
  const db = getBoardDb(dbPath);
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const where =
    opts.kind === 'pinned' ? 'AND is_pinned = 1' :
    opts.kind === 'plain' ? 'AND is_pinned = 0' : '';
  const r = await db.query<{
    id: number; url: string; title: string; author: string | null;
    posted_at: string | null; last_reply_at: string | null;
    reply_count: number | null; view_count: number | null; is_pinned: number;
  }>(
    `SELECT id, url, title, author, posted_at, last_reply_at, reply_count, view_count, is_pinned
       FROM threads WHERE board_node_id = $1 ${where}
      ORDER BY is_pinned DESC, posted_at DESC LIMIT $2 OFFSET $3`,
    [boardNodeId, limit, offset],
  );
  return r.rows.map(toThreadRow);
}

/** Read a stored thread + its posts by URL. Scans board dbs. */
export async function getThreadByUrl(siteKey: string, url: string): Promise<{ thread: ThreadRow; posts: PostRow[] } | null> {
  const boards = await listBoards(siteKey);
  for (const b of boards) {
    if (!b.dbPath) continue;
    const db = getBoardDb(b.dbPath);
    const r = await db.query<{
      id: number; url: string; title: string; author: string | null;
      posted_at: string | null; last_reply_at: string | null;
      reply_count: number | null; view_count: number | null; is_pinned: number;
    }>(
      `SELECT id, url, title, author, posted_at, last_reply_at, reply_count, view_count, is_pinned
         FROM threads WHERE url = $1`,
      [url],
    );
    if (r.rows.length === 0) continue;
    const thread = toThreadRow(r.rows[0]!);
    const pr = await db.query<{
      floor: number; author: string; posted_at: string | null;
      content_html: string; content_text: string; attachments: string | null;
    }>(
      `SELECT floor, author, posted_at, content_html, content_text, attachments
         FROM posts WHERE thread_id = $1 ORDER BY floor ASC`,
      [thread.id],
    );
    const posts: PostRow[] = pr.rows.map((p) => ({
      floor: Number(p.floor), author: p.author, postedAt: p.posted_at,
      contentHtml: p.content_html, contentText: p.content_text,
      attachments: p.attachments ? JSON.parse(p.attachments) : null,
    }));
    return { thread, posts };
  }
  return null;
}

export { findBoardByName, getBoardById } from '../repository/boards-lookup.js';

import { getLatestDailyTraffic, type DailyTrafficRow } from '../repository/daily-traffic.js';

export interface SectionDetailBoard {
  id: number; boardKey: string; name: string; moderators: string[];
  stats: DailyTrafficRow | null; pinnedThreadTitles: string[]; recentThreads: ThreadRow[];
}
export interface SectionDetail {
  section: { id: number; sectionKey: string; name: string; level: number; fullPath: string | null };
  subSections: SectionInfo[];
  boards: SectionDetailBoard[];
}

export async function getSectionDetail(
  siteKey: string, sectionKey: string, opts: { recentLimit?: number } = {},
): Promise<SectionDetail> {
  const recentLimit = opts.recentLimit ?? 10;
  const sr = await getStructureDb().query<{
    id: number; node_key: string; name: string; level: number; full_path: string | null;
  }>(
    `SELECT id, node_key, name, level, full_path FROM nodes
      WHERE site_key = $1 AND node_key = $2 AND type IN ('forum','sub_forum') LIMIT 1`,
    [siteKey, sectionKey],
  );
  const s = sr.rows[0];
  if (!s) throw new DatabaseError(`section "${sectionKey}" not found in ${siteKey}`);
  const sectionId = Number(s.id);

  const subSections = (await listSections(siteKey)).filter((x) => x.parentId === sectionId);
  const boardsRaw = await listBoards(siteKey, sectionId);

  const boards: SectionDetailBoard[] = [];
  for (const b of boardsRaw) {
    const modRow = await getStructureDb().query<{ moderators: string | null }>(
      `SELECT moderators FROM nodes WHERE id = $1`, [b.id],
    );
    const moderators = modRow.rows[0]?.moderators ? JSON.parse(modRow.rows[0]!.moderators!) : [];
    const stats = await getLatestDailyTraffic(b.id).catch(() => null);
    const pinned = await listThreadsByBoard(b.id, { kind: 'pinned', limit: 100 });
    const recentThreads = await listThreadsByBoard(b.id, { kind: 'plain', limit: recentLimit });
    boards.push({
      id: b.id, boardKey: b.boardKey, name: b.name, moderators,
      stats, pinnedThreadTitles: pinned.map((t) => t.title), recentThreads,
    });
  }

  return {
    section: { id: sectionId, sectionKey: s.node_key, name: s.name, level: Number(s.level), fullPath: s.full_path },
    subSections, boards,
  };
}
