import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initDb,
  closeAllDbs,
  getStructureDb,
  getBoardDb,
  _resetForTests,
} from '../../../src/repository/db';
import { upsertSite } from '../../../src/repository/sites';
import {
  upsertSection,
  hasSections,
  listTopLevelSections,
  sectionsMissingBoards,
} from '../../../src/repository/sections';
import {
  upsertBoard,
  resolveBoardRoute,
  findBoardDbPath,
  listBoards,
  boardsMissingPinned,
} from '../../../src/repository/boards';
import {
  upsertThread,
  upsertThreadSummary,
  checkThreadExists,
  shouldSkipFetch,
} from '../../../src/repository/threads';
import { upsertPosts } from '../../../src/repository/posts';
import {
  getBoardCrawlState,
  upsertBoardCrawlState,
} from '../../../src/repository/board-crawl-state';
import { findBoardByName } from '../../../src/repository/boards-lookup';
import { appendFetchLog } from '../../../src/repository/fetch-log';

let tmpDir: string;

beforeEach(() => {
  _resetForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-db-test-'));
  initDb({ dataDir: tmpDir });
});

afterEach(async () => {
  await closeAllDbs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BOARD_DB_PATH = 'forums/club/club-sh/BYRatSH.db';

describe('layered storage — end-to-end', () => {
  async function seedTree() {
    await upsertSite({ siteKey: 's', displayName: 'S', baseUrl: 'https://s.example' });
    const { sectionId: forumId } = await upsertSection({
      siteKey: 's', sectionKey: 'club', name: 'Club',
    });
    const { sectionId: subForumId } = await upsertSection({
      siteKey: 's', sectionKey: 'club-sh', name: 'Shanghai sub', parentSectionId: forumId,
    });
    const { boardId, dbPath } = await upsertBoard({
      siteKey: 's', boardKey: 'BYRatSH', name: '北邮人在上海',
      sectionId: subForumId,
      moderators: ['alice', 'bob'],
    });
    return { forumId, subForumId, boardId, dbPath };
  }

  it('nodes table holds the full tree, db_path only on board rows', async () => {
    const { forumId, subForumId, boardId } = await seedTree();

    const all = await getStructureDb().query<{
      id: number; type: string; level: number; node_key: string;
      db_path: string | null; full_path: string | null;
    }>(`SELECT id, type, level, node_key, db_path, full_path FROM nodes ORDER BY id`);
    expect(all.rows).toHaveLength(3);

    const forum = all.rows.find((r) => r.id === forumId)!;
    expect(forum.type).toBe('forum');
    expect(forum.level).toBe(0);
    expect(forum.db_path).toBeNull();
    expect(forum.full_path).toBe('club');

    const sub = all.rows.find((r) => r.id === subForumId)!;
    expect(sub.type).toBe('sub_forum');
    expect(sub.level).toBe(1);
    expect(sub.db_path).toBeNull();
    expect(sub.full_path).toBe('club/club-sh');

    const board = all.rows.find((r) => r.id === boardId)!;
    expect(board.type).toBe('board');
    expect(board.level).toBe(2);
    expect(board.db_path).toBe(BOARD_DB_PATH);
    expect(board.full_path).toBe('club/club-sh/BYRatSH');
  });

  it('moderators survive on board node as JSON; stats no longer stored on nodes', async () => {
    const { boardId } = await seedTree();
    const row = await getStructureDb().query<{ moderators: string }>(
      `SELECT moderators FROM nodes WHERE id = $1`,
      [boardId],
    );
    expect(JSON.parse(row.rows[0]!.moderators)).toEqual(['alice', 'bob']);

    const cols = await getStructureDb().query<{ name: string }>(
      `SELECT name FROM pragma_table_info('nodes')`,
    );
    expect(cols.rows.map((r) => r.name)).not.toContain('stats');
  });

  it('findBoardDbPath returns the board\'s own db_path', async () => {
    const { boardId } = await seedTree();
    const dbPath = await findBoardDbPath(boardId);
    expect(dbPath).toBe(BOARD_DB_PATH);
  });

  it('resolveBoardRoute returns boardNodeId + dbPath', async () => {
    const { boardId } = await seedTree();
    const route = await resolveBoardRoute('s', 'BYRatSH');
    expect(route.boardNodeId).toBe(boardId);
    expect(route.dbPath).toBe(BOARD_DB_PATH);
  });

  it('upsertThread routes into the board db; posts share the same handle', async () => {
    const { boardId } = await seedTree();

    const { threadId, boardDb } = await upsertThread('s', {
      url: 'https://s.example/article/BYRatSH/100',
      title: 'Hi',
      board: 'BYRatSH',
      posts: [
        { floor: 0, author: 'alice', contentHtml: '<p>a</p>', contentText: 'a' },
        { floor: 1, author: 'bob',   contentHtml: '<p>b</p>', contentText: 'b' },
      ],
      fetchedAt: new Date().toISOString(),
    }, { isPinned: false });
    await upsertPosts(boardDb, threadId, [
      { floor: 0, author: 'alice', contentHtml: '<p>a</p>', contentText: 'a' },
      { floor: 1, author: 'bob',   contentHtml: '<p>b</p>', contentText: 'b' },
    ]);

    const boardDb2 = getBoardDb(BOARD_DB_PATH);
    const t = await boardDb2.query<{ id: number; title: string; board_node_id: number; is_pinned: number }>(
      `SELECT id, title, board_node_id, is_pinned FROM threads`,
    );
    expect(t.rows).toEqual([{ id: threadId, title: 'Hi', board_node_id: boardId, is_pinned: 0 }]);

    const p = await boardDb2.query<{ floor: number; author: string }>(
      `SELECT floor, author FROM posts ORDER BY floor`,
    );
    expect(p.rows).toEqual([
      { floor: 0, author: 'alice' },
      { floor: 1, author: 'bob' },
    ]);
  });

  it('OR-merge: once a thread is pinned, re-upserting as plain keeps is_pinned=1', async () => {
    await seedTree();
    const url = 'https://s.example/article/BYRatSH/200';

    const pinned = await upsertThread('s', {
      url, title: 'Sticky', board: 'BYRatSH',
      posts: [{ floor: 0, author: 'alice', contentHtml: '<p>a</p>', contentText: 'a' }],
      fetchedAt: '2026-05-11T00:00:00Z',
    }, { isPinned: true });
    await upsertPosts(pinned.boardDb, pinned.threadId, [
      { floor: 0, author: 'alice', contentHtml: '<p>a</p>', contentText: 'a' },
    ]);

    await upsertThread('s', {
      url, title: 'Sticky 2', board: 'BYRatSH',
      posts: [{ floor: 0, author: 'alice', contentHtml: '<p>a2</p>', contentText: 'a2' }],
      fetchedAt: '2026-05-11T01:00:00Z',
    }, { isPinned: false });

    const boardDb = getBoardDb(BOARD_DB_PATH);
    const rows = await boardDb.query<{ title: string; is_pinned: number }>(
      `SELECT title, is_pinned FROM threads WHERE url = $1`,
      [url],
    );
    expect(rows.rows).toEqual([{ title: 'Sticky 2', is_pinned: 1 }]);
  });

  it('shouldSkipFetch returns skipped=true when reply count matches', async () => {
    await seedTree();
    await upsertThreadSummary('s', {
      url: 'https://s.example/article/BYRatSH/300',
      title: 'T', board: 'BYRatSH', replyCount: 5,
    }, { isPinned: false });

    const skip = await shouldSkipFetch('s', 'BYRatSH', 'https://s.example/article/BYRatSH/300', 5);
    expect(skip.skipped).toBe(true);

    // Pass freshnessHours=0 so the recent last_fetched_at doesn't shortcut to skip.
    const noSkip = await shouldSkipFetch('s', 'BYRatSH', 'https://s.example/article/BYRatSH/300', 6, 0);
    expect(noSkip.skipped).toBe(false);
  });

  it('board_crawl_state lives in the board db, keyed by board_node_id', async () => {
    const { boardId } = await seedTree();
    await upsertBoardCrawlState({
      boardId,
      deepestPageCrawled: 5,
      latestThreadPostedAt: '2026-05-11T10:00:00Z',
      lastCrawledAt: '2026-05-11T10:05:00Z',
    });

    const state = await getBoardCrawlState(boardId);
    expect(state).toEqual({
      boardId,
      deepestPageCrawled: 5,
      latestThreadPostedAt: '2026-05-11T10:00:00Z',
      lastCrawledAt: '2026-05-11T10:05:00Z',
      lastThreadKey: null,
    });
  });

  it('upsertBoardCrawlState keeps max of deepest_page and latest watermark', async () => {
    const { boardId } = await seedTree();
    await upsertBoardCrawlState({ boardId, deepestPageCrawled: 10, latestThreadPostedAt: '2026-05-10' });
    await upsertBoardCrawlState({ boardId, deepestPageCrawled: 5, latestThreadPostedAt: '2026-05-08' });
    const state = await getBoardCrawlState(boardId);
    expect(state!.deepestPageCrawled).toBe(10);
    expect(state!.latestThreadPostedAt).toBe('2026-05-10');
  });

  it('findBoardByName / listBoards / sectionsMissingBoards / listTopLevelSections', async () => {
    const { forumId, subForumId, boardId } = await seedTree();

    const byName = await findBoardByName('s', '北邮人在上海');
    expect(byName).toEqual({ id: boardId, siteKey: 's', boardKey: 'BYRatSH', name: '北邮人在上海' });

    const boards = await listBoards('s');
    expect(boards).toHaveLength(1);
    expect(boards[0]!.boardKey).toBe('BYRatSH');

    const tops = await listTopLevelSections('s');
    expect(tops).toEqual([{ id: forumId, sectionKey: 'club', name: 'Club' }]);

    await upsertSection({ siteKey: 's', sectionKey: 'club-bj', name: 'Beijing sub', parentSectionId: forumId });
    const missing = await sectionsMissingBoards('s');
    expect(missing.map((m) => m.sectionKey).sort()).toEqual(['club', 'club-bj']);
    expect(missing.find((m) => m.sectionKey === subForumId.toString())).toBeUndefined();
    expect(missing.find((m) => m.sectionKey === 'club-sh')).toBeUndefined();
  });

  it('hasSections is false until the first upsert', async () => {
    expect(await hasSections('s')).toBe(false);
    await upsertSite({ siteKey: 's', displayName: 'S', baseUrl: 'u' });
    await upsertSection({ siteKey: 's', sectionKey: 'ten', name: 'Ten' });
    expect(await hasSections('s')).toBe(true);
  });

  it('boardsMissingPinned: a board with no db file yet shows as missing', async () => {
    const { boardId, dbPath } = await seedTree();

    // Add another board with no threads/db file.
    const { sectionId: bjId } = await upsertSection({
      siteKey: 's', sectionKey: 'club-bj', name: 'BJ', parentSectionId: 1,
    });
    const { boardId: bjBoardId } = await upsertBoard({
      siteKey: 's', boardKey: 'BJ-board', name: 'BJ board', sectionId: bjId,
    });

    // First — both should appear (no .db file on disk yet).
    let missing = await boardsMissingPinned('s');
    expect(missing.map((m) => m.id).sort()).toEqual([boardId, bjBoardId].sort());

    // Pin a thread under BYRatSH → that creates its .db file.
    await upsertThread('s', {
      url: 'https://s.example/article/BYRatSH/500',
      title: 'pinned', board: 'BYRatSH', posts: [], fetchedAt: '2026-05-11T00:00:00Z',
    }, { isPinned: true });

    // Confirm the file actually got created.
    expect(fs.existsSync(path.join(tmpDir, dbPath))).toBe(true);

    missing = await boardsMissingPinned('s');
    const missingIds = missing.map((m) => m.id);
    expect(missingIds).not.toContain(boardId);
    expect(missingIds).toContain(bjBoardId);
  });

  it('fetch_log writes to structure.db (not a board db)', async () => {
    await appendFetchLog({
      siteKey: 's', tool: 'forum_get_thread', args: { url: 'u' },
      status: 'ok', durationMs: 42,
    });
    const r = await getStructureDb().query<{ tool: string; status: string; duration_ms: number }>(
      `SELECT tool, status, duration_ms FROM fetch_log`,
    );
    expect(r.rows).toEqual([{ tool: 'forum_get_thread', status: 'ok', duration_ms: 42 }]);
  });

  it('checkThreadExists returns false when board exists but URL is absent', async () => {
    await seedTree();
    const r = await checkThreadExists('s', 'BYRatSH', 'https://nope.example');
    expect(r.exists).toBe(false);
  });
});
