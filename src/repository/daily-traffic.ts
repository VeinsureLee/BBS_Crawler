/**
 * Per-board daily stats snapshots. Lives in the board db the row belongs to,
 * keyed by (board_node_id, date). Date is bucketed in Asia/Shanghai (UTC+8)
 * because the forum's "today" counter is reset at Beijing midnight.
 *
 * Same-day refreshes overwrite the row — the table stores the **last** snapshot
 * of each day, not a per-call history. This is also the **only** place stats
 * are persisted; `nodes` no longer carries a `stats` column.
 */
import { getBoardDb, type Db } from './db.js';
import { DatabaseError } from '../errors.js';
import { findBoardDbPath } from './boards.js';
import type { BoardStats } from '../contract/site-adapter.js';

export interface DailyTrafficRow {
  boardNodeId: number;
  date: string;          // YYYY-MM-DD in Beijing time
  online: number | null;
  todayPosts: number | null;
  threads: number | null;
  posts: number | null;
  snapshotAt: string | null;
}

async function boardDbFor(boardNodeId: number): Promise<Db> {
  const dbPath = await findBoardDbPath(boardNodeId);
  if (!dbPath) {
    throw new DatabaseError(`No db_path for board node ${boardNodeId}`);
  }
  return getBoardDb(dbPath);
}

/**
 * Bucket an ISO timestamp into a YYYY-MM-DD string in Asia/Shanghai (UTC+8).
 * The forum's "今日" counter resets at Beijing midnight, so we group by that.
 */
export function beijingDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    throw new DatabaseError(`beijingDate: invalid ISO timestamp "${iso}"`);
  }
  const shifted = new Date(t + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Insert or update the row for (boardNodeId, beijingDate(stats.snapshotAt)).
 * If a row for the same day already exists, all stat columns are overwritten
 * with the latest values — last write of the day wins.
 */
export async function upsertDailyTraffic(
  boardNodeId: number,
  stats: BoardStats,
): Promise<void> {
  try {
    const boardDb = await boardDbFor(boardNodeId);
    const date = beijingDate(stats.snapshotAt);
    await boardDb.query(
      `INSERT INTO daily_traffic
         (board_node_id, date, online, today_posts, threads, posts, snapshot_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(board_node_id, date) DO UPDATE SET
         online      = excluded.online,
         today_posts = excluded.today_posts,
         threads     = excluded.threads,
         posts       = excluded.posts,
         snapshot_at = excluded.snapshot_at`,
      [
        boardNodeId,
        date,
        stats.online,
        stats.today,
        stats.threads,
        stats.posts,
        stats.snapshotAt,
      ],
    );
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`upsertDailyTraffic failed for board ${boardNodeId}`, e);
  }
}

interface RawDailyRow {
  board_node_id: number;
  date: string;
  online: number | null;
  today_posts: number | null;
  threads: number | null;
  posts: number | null;
  snapshot_at: string | null;
}

function toRow(r: RawDailyRow): DailyTrafficRow {
  return {
    boardNodeId: Number(r.board_node_id),
    date: r.date,
    online: r.online,
    todayPosts: r.today_posts,
    threads: r.threads,
    posts: r.posts,
    snapshotAt: r.snapshot_at,
  };
}

/** Return the snapshot saved for that Beijing date, or null. */
export async function getDailyTrafficForDate(
  boardNodeId: number,
  date: string,
): Promise<DailyTrafficRow | null> {
  try {
    const boardDb = await boardDbFor(boardNodeId);
    const r = await boardDb.query<RawDailyRow>(
      `SELECT board_node_id, date, online, today_posts, threads, posts, snapshot_at
         FROM daily_traffic
        WHERE board_node_id = $1 AND date = $2`,
      [boardNodeId, date],
    );
    return r.rows[0] ? toRow(r.rows[0]) : null;
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(
      `getDailyTrafficForDate failed for board ${boardNodeId}, date ${date}`, e,
    );
  }
}

/** Most recent snapshot (by date) for this board. */
export async function getLatestDailyTraffic(
  boardNodeId: number,
): Promise<DailyTrafficRow | null> {
  try {
    const boardDb = await boardDbFor(boardNodeId);
    const r = await boardDb.query<RawDailyRow>(
      `SELECT board_node_id, date, online, today_posts, threads, posts, snapshot_at
         FROM daily_traffic
        WHERE board_node_id = $1
        ORDER BY date DESC LIMIT 1`,
      [boardNodeId],
    );
    return r.rows[0] ? toRow(r.rows[0]) : null;
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`getLatestDailyTraffic failed for board ${boardNodeId}`, e);
  }
}
