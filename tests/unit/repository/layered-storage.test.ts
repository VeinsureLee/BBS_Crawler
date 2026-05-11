import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initDb,
  closeAllDbs,
  getStructureDb,
  getForumDb,
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
  findForumDbFileForBoard,
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

describe('layered storage — end-to-end', () => {
  async function seedTree() {
    await upsertSite({ siteKey: 's', displayName: 'S', baseUrl: 'https://s.example' });
    const { sectionId: forumId } = await upsertSection({
      siteKey: 's', sectionKey: 'club', name: 'Club',
    });
    const { sectionId: subForumId } = await upsertSection({
      siteKey: 's', sectionKey: 'club-sh', name: 'Shanghai sub', parentSectionId: forumId,
    });
    const { boardId } = await upsertBoard({
      siteKey: 's', boardKey: 'BYRatSH', name: '北邮人在上海',
      sectionId: subForumId,
      moderators: ['alice', 'bob'],
      stats: { online: 1, today: 2, threads: 3, posts: 4, snapshotAt: '2026-05-11T00:00:00Z' },
    });
    return { forumId, subForumId, boardId };
  }

  it('nodes table holds the full tree, db_file only on forum rows', async () => {
    const { forumId, subForumId, boardId } = await seedTree();

    const all = await getStructureDb().query<{
      id: number; type: string; level: number; node_key: string; db_file: string | null;
    }>(`SELECT id, type, level, node_key, db_file FROM nodes ORDER BY id`);
    expect(all.rows).toHaveLength(3);

    const forum = all.rows.find((r) => r.id === forumId)!;
    expect(forum.type).toBe('forum');
    expect(forum.level).toBe(0);
    expect(forum.db_file).toBe('forums/club.db');

    const sub = all.rows.find((r) => r.id === subForumId)!;
    expect(sub.type).toBe('sub_forum');
    expect(sub.level).toBe(1);
    expect(sub.db_file).toBeNull();

    const board = all.rows.find((r) => r.id === boardId)!;
    expect(board.type).toBe('board');
    expect(board.level).toBe(2);
    expect(board.db_file).toBeNull();
  });

  it('moderators + stats survive on board node as JSON', async () => {
    const { boardId } = await seedTree();
    const row = await getStructureDb().query<{ moderators: string; stats: string }>(
      `SELECT moderators, stats FROM nodes WHERE id = $1`,
      [boardId],
    );
    expect(JSON.parse(row.rows[0]!.moderators)).toEqual(['alice', 'bob']);
    expect(JSON.parse(row.rows[0]!.stats).threads).toBe(3);
  });

  it('findForumDbFileForBoard walks up sub_forum to forum', async () => {
    const { boardId } = await seedTree();
    const dbFile = await findForumDbFileForBoard(boardId);
    expect(dbFile).toBe('forums/club.db');
  });

  it('resolveBoardRoute returns boardNodeId + forum file', async () => {
    const { boardId } = await seedTree();
    const route = await resolveBoardRoute('s', 'BYRatSH');
    expect(route.boardNodeId).toBe(boardId);
    expect(route.forumDbFile).toBe('forums/club.db');
  });

  it('upsertThread routes into the forum db; posts go to same handle', async () => {
    const { boardId } = await seedTree();

    const { threadId, forumDb } = await upsertThread('s', {
      url: 'https://s.example/article/BYRatSH/100',
      title: 'Hi',
      board: 'BYRatSH',
      posts: [
        { floor: 0, author: 'alice', contentHtml: '<p>a</p>', contentText: 'a' },
        { floor: 1, author: 'bob',   contentHtml: '<p>b</p>', contentText: 'b' },
      ],
      fetchedAt: new Date().toISOString(),
    });
    await upsertPosts(forumDb, threadId, [
      { floor: 0, author: 'alice', contentHtml: '<p>a</p>', contentText: 'a' },
      { floor: 1, author: 'bob',   contentHtml: '<p>b</p>', contentText: 'b' },
    ]);

    const forumDb2 = getForumDb('forums/club.db');
    const t = await forumDb2.query<{ id: number; title: string; board_node_id: number }>(
      `SELECT id, title, board_node_id FROM threads`,
    );
    expect(t.rows).toEqual([{ id: threadId, title: 'Hi', board_node_id: boardId }]);

    const p = await forumDb2.query<{ floor: number; author: string }>(
      `SELECT floor, author FROM posts ORDER BY floor`,
    );
    expect(p.rows).toEqual([
      { floor: 0, author: 'alice' },
      { floor: 1, author: 'bob' },
    ]);
  });

  it('is_pinned OR-merges across upserts (pin stays sticky)', async () => {
    await seedTree();
    // First upsert as pinned
    await upsertThread('s', {
      url: 'https://s.example/article/BYRatSH/200', title: 'Sticky',
      board: 'BYRatSH', posts: [], fetchedAt: '2026-05-11T00:00:00Z',
    }, { isPinned: true });

    // Second upsert as not pinned — pin status must NOT clear
    await upsertThread('s', {
      url: 'https://s.example/article/BYRatSH/200', title: 'Sticky 2',
      board: 'BYRatSH', posts: [], fetchedAt: '2026-05-11T01:00:00Z',
    });

    const forumDb = getForumDb('forums/club.db');
    const r = await forumDb.query<{ is_pinned: number }>(`SELECT is_pinned FROM threads WHERE url = $1`,
      ['https://s.example/article/BYRatSH/200']);
    expect(r.rows[0]!.is_pinned).toBe(1);
  });

  it('shouldSkipFetch returns skipped=true when reply count matches', async () => {
    await seedTree();
    await upsertThreadSummary('s', {
      url: 'https://s.example/article/BYRatSH/300',
      title: 'T', board: 'BYRatSH', replyCount: 5,
    });

    const skip = await shouldSkipFetch('s', 'BYRatSH', 'https://s.example/article/BYRatSH/300', 5);
    expect(skip.skipped).toBe(true);

    // Pass freshnessHours=0 so the recent last_fetched_at doesn't shortcut to skip.
    const noSkip = await shouldSkipFetch('s', 'BYRatSH', 'https://s.example/article/BYRatSH/300', 6, 0);
    expect(noSkip.skipped).toBe(false);
  });

  it('board_crawl_state lives in the forum db, keyed by board_node_id', async () => {
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

    // sub_forum 'club-sh' has board, so should NOT appear as missing.
    // Add a second sub_forum with no boards — should appear.
    await upsertSection({ siteKey: 's', sectionKey: 'club-bj', name: 'Beijing sub', parentSectionId: forumId });
    const missing = await sectionsMissingBoards('s');
    expect(missing.map((m) => m.sectionKey).sort()).toEqual(['club', 'club-bj']);
    // Note: 'club' itself has no DIRECT board children — its sub_forum has the board.
    // So `club` appears in missing too, matching the strict "direct children" semantics.
    expect(missing.find((m) => m.sectionKey === subForumId.toString())).toBeUndefined();
    // 'club-sh' (sub_forum with a board child) should NOT appear.
    expect(missing.find((m) => m.sectionKey === 'club-sh')).toBeUndefined();
  });

  it('hasSections is false until the first upsert', async () => {
    expect(await hasSections('s')).toBe(false);
    await upsertSite({ siteKey: 's', displayName: 'S', baseUrl: 'u' });
    await upsertSection({ siteKey: 's', sectionKey: 'ten', name: 'Ten' });
    expect(await hasSections('s')).toBe(true);
  });

  it('boardsMissingPinned excludes boards that have a pinned thread', async () => {
    const { boardId } = await seedTree();

    // Add another board under same forum without any threads
    const { sectionId: bjId } = await upsertSection({
      siteKey: 's', sectionKey: 'club-bj', name: 'BJ', parentSectionId: 1, // forumId is 1
    });
    const { boardId: bjBoardId } = await upsertBoard({
      siteKey: 's', boardKey: 'BJ-board', name: 'BJ board', sectionId: bjId,
    });

    // Pin a thread under boardId only
    await upsertThread('s', {
      url: 'https://s.example/article/BYRatSH/500',
      title: 'pinned', board: 'BYRatSH', posts: [], fetchedAt: '2026-05-11T00:00:00Z',
    }, { isPinned: true });

    const missing = await boardsMissingPinned('s');
    const missingIds = missing.map((m) => m.id);
    expect(missingIds).not.toContain(boardId);
    expect(missingIds).toContain(bjBoardId);
  });

  it('fetch_log writes to structure.db (not a forum db)', async () => {
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
