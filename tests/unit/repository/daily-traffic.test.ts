import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initDb,
  closeAllDbs,
  getBoardDb,
  _resetForTests,
} from '../../../src/repository/db';
import { upsertSite } from '../../../src/repository/sites';
import { upsertSection } from '../../../src/repository/sections';
import { upsertBoard } from '../../../src/repository/boards';
import {
  upsertDailyTraffic,
  getDailyTrafficForDate,
  getLatestDailyTraffic,
  beijingDate,
} from '../../../src/repository/daily-traffic';

let tmpDir: string;

beforeEach(() => {
  _resetForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-daily-traffic-'));
  initDb({ dataDir: tmpDir });
});

afterEach(async () => {
  await closeAllDbs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BOARD_DB_PATH = 'forums/club/B.db';

async function seedBoard(): Promise<number> {
  await upsertSite({ siteKey: 's', displayName: 'S', baseUrl: 'https://s.example' });
  const { sectionId } = await upsertSection({ siteKey: 's', sectionKey: 'club', name: 'Club' });
  const { boardId } = await upsertBoard({
    siteKey: 's', boardKey: 'B', name: 'Board',
    sectionId,
  });
  return boardId;
}

describe('beijingDate', () => {
  it('groups by Asia/Shanghai (UTC+8) calendar date', () => {
    expect(beijingDate('2026-05-12T15:30:00.000Z')).toBe('2026-05-12'); // 23:30 BJT
    expect(beijingDate('2026-05-12T16:30:00.000Z')).toBe('2026-05-13'); // 00:30 next-day BJT
    expect(beijingDate('2026-05-12T00:00:00.000Z')).toBe('2026-05-12'); // 08:00 BJT
    expect(beijingDate('2026-05-11T15:59:59.999Z')).toBe('2026-05-11'); // 23:59:59 BJT
    expect(beijingDate('2026-05-11T16:00:00.000Z')).toBe('2026-05-12'); // 00:00 next-day BJT
  });

  it('throws on invalid input', () => {
    expect(() => beijingDate('not-a-date')).toThrow();
  });
});

describe('upsertDailyTraffic', () => {
  it('inserts one row keyed by Beijing date', async () => {
    const boardId = await seedBoard();
    await upsertDailyTraffic(boardId, {
      online: 7, today: 3, threads: 100, posts: 250,
      snapshotAt: '2026-05-12T03:04:00.000Z', // BJT 2026-05-12 11:04
    });

    const row = await getDailyTrafficForDate(boardId, '2026-05-12');
    expect(row).toEqual({
      boardNodeId: boardId,
      date: '2026-05-12',
      online: 7,
      todayPosts: 3,
      threads: 100,
      posts: 250,
      snapshotAt: '2026-05-12T03:04:00.000Z',
    });
  });

  it('same-day second write overwrites all stat columns', async () => {
    const boardId = await seedBoard();
    await upsertDailyTraffic(boardId, {
      online: 1, today: 1, threads: 10, posts: 10,
      snapshotAt: '2026-05-12T03:04:00.000Z',
    });
    await upsertDailyTraffic(boardId, {
      online: 9, today: 5, threads: 11, posts: 13,
      snapshotAt: '2026-05-12T07:00:00.000Z',
    });

    const row = await getDailyTrafficForDate(boardId, '2026-05-12');
    expect(row?.online).toBe(9);
    expect(row?.todayPosts).toBe(5);
    expect(row?.threads).toBe(11);
    expect(row?.posts).toBe(13);
    expect(row?.snapshotAt).toBe('2026-05-12T07:00:00.000Z');

    const boardDb = getBoardDb(BOARD_DB_PATH);
    const all = await boardDb.query<{ c: number }>(
      `SELECT count(*) AS c FROM daily_traffic WHERE board_node_id = $1`,
      [boardId],
    );
    expect(all.rows[0]!.c).toBe(1);
  });

  it('different Beijing dates produce separate rows', async () => {
    const boardId = await seedBoard();
    await upsertDailyTraffic(boardId, {
      online: 1, today: 1, threads: 10, posts: 10,
      snapshotAt: '2026-05-11T15:59:00.000Z', // BJT 2026-05-11 23:59
    });
    await upsertDailyTraffic(boardId, {
      online: 2, today: 2, threads: 11, posts: 11,
      snapshotAt: '2026-05-11T16:01:00.000Z', // BJT 2026-05-12 00:01
    });

    const d1 = await getDailyTrafficForDate(boardId, '2026-05-11');
    const d2 = await getDailyTrafficForDate(boardId, '2026-05-12');
    expect(d1?.online).toBe(1);
    expect(d2?.online).toBe(2);
  });

  it('getLatestDailyTraffic returns the most recent date', async () => {
    const boardId = await seedBoard();
    await upsertDailyTraffic(boardId, {
      online: 1, today: 1, threads: 10, posts: 10,
      snapshotAt: '2026-05-10T03:04:00.000Z',
    });
    await upsertDailyTraffic(boardId, {
      online: 2, today: 2, threads: 11, posts: 11,
      snapshotAt: '2026-05-12T03:04:00.000Z',
    });
    await upsertDailyTraffic(boardId, {
      online: 3, today: 3, threads: 12, posts: 12,
      snapshotAt: '2026-05-11T03:04:00.000Z',
    });

    const latest = await getLatestDailyTraffic(boardId);
    expect(latest?.date).toBe('2026-05-12');
    expect(latest?.online).toBe(2);
  });

  it('getDailyTrafficForDate returns null for unknown date', async () => {
    const boardId = await seedBoard();
    const row = await getDailyTrafficForDate(boardId, '2099-01-01');
    expect(row).toBeNull();
  });
});
