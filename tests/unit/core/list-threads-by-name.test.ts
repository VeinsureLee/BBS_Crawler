import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SiteAdapter, ThreadSummary } from '../../../src/core/site-adapter';

// Mock the three repository modules listThreadsByName touches. vitest hoists
// these so the imports inside crawler-service.ts pick up the mocked versions.
vi.mock('../../../src/repository/boards-lookup', () => ({
  findBoardByName: vi.fn(),
}));
vi.mock('../../../src/repository/board-crawl-state', () => ({
  getBoardCrawlState: vi.fn(),
  upsertBoardCrawlState: vi.fn(async () => {}),
}));
vi.mock('../../../src/repository/threads', () => ({
  upsertThreadSummary: vi.fn(async () => ({ threadId: 1 })),
  shouldSkipFetch: vi.fn(async () => ({ skipped: false })),
}));

import { CrawlerService } from '../../../src/core/crawler-service';
import { findBoardByName } from '../../../src/repository/boards-lookup';
import {
  getBoardCrawlState,
  upsertBoardCrawlState,
} from '../../../src/repository/board-crawl-state';
import { upsertThreadSummary } from '../../../src/repository/threads';
import { McpToolError } from '../../../src/server/error-codes';

const fakePage = { close: async () => {} } as never;
const fakeContext = { newPage: async () => fakePage } as never;

function makeAdapter(): SiteAdapter {
  return {
    siteKey: 'school-bbs',
    displayName: 'X',
    baseUrl: 'https://x',
    requiresAuth: true,
    isLoggedIn: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    listThreads: vi.fn(),
    getThread: vi.fn(),
    search: vi.fn(),
  } as unknown as SiteAdapter;
}

function deps(adapter: SiteAdapter) {
  return {
    rateLimiter: { acquire: async () => () => {} },
    browserPool: {
      acquire: async () => ({
        context: fakeContext,
        saveStorageState: async () => {},
        release: () => {},
      }),
      wipeStorageState: vi.fn(),
    },
    auth: {
      ensureLoggedIn: vi.fn(async () => {}),
      detectSessionExpired: vi.fn(async () => null),
    },
    registry: { getAdapter: () => adapter },
    persistThread: vi.fn(async () => 7),
    appendFetchLog: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
}

function row(
  articleId: string,
  postedAt: string,
  opts: { isPinned?: boolean; title?: string } = {},
): ThreadSummary {
  return {
    url: `https://x/article/B/${articleId}`,
    title: opts.title ?? `T${articleId}`,
    board: 'B',
    postedAt,
    raw: { threadId: `B/${articleId}`, articleId, isPinned: opts.isPinned ?? false },
  };
}

beforeEach(() => {
  vi.mocked(findBoardByName).mockReset();
  vi.mocked(getBoardCrawlState).mockReset();
  vi.mocked(upsertBoardCrawlState).mockReset().mockResolvedValue(undefined);
  vi.mocked(upsertThreadSummary).mockReset().mockResolvedValue({ threadId: 1 });
});

describe('CrawlerService.listThreadsByName', () => {
  it('throws BOARD_NOT_FOUND when name does not match any board', async () => {
    vi.mocked(findBoardByName).mockResolvedValue(null);
    const svc = new CrawlerService(deps(makeAdapter()));
    await expect(
      svc.listThreadsByName({ siteKey: 'school-bbs', boardName: 'nope' }),
    ).rejects.toBeInstanceOf(McpToolError);
    await expect(
      svc.listThreadsByName({ siteKey: 'school-bbs', boardName: 'nope' }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_FOUND' });
  });

  it('pages mode honors cursor.startPage and pages count', async () => {
    vi.mocked(findBoardByName).mockResolvedValue({
      id: 1, siteKey: 'school-bbs', boardKey: 'B', name: '版面',
    });
    vi.mocked(getBoardCrawlState).mockResolvedValue(null);
    const adapter = makeAdapter();
    const list = adapter.listThreads as ReturnType<typeof vi.fn>;
    list
      .mockResolvedValueOnce([row('100', '2026-04-01T00:00:00Z')])
      .mockResolvedValueOnce([row('101', '2026-03-15T00:00:00Z')])
      .mockResolvedValueOnce([row('102', '2026-03-01T00:00:00Z')]);

    const svc = new CrawlerService(deps(adapter));
    const out = await svc.listThreadsByName({
      siteKey: 'school-bbs', boardName: '版面',
      mode: 'pages', pages: 3, cursor: { startPage: 5 },
    });

    expect(list).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenNthCalledWith(1, fakePage, { board: 'B', page: 5 });
    expect(list).toHaveBeenNthCalledWith(2, fakePage, { board: 'B', page: 6 });
    expect(list).toHaveBeenNthCalledWith(3, fakePage, { board: 'B', page: 7 });
    expect(out.threads).toHaveLength(3);
    expect(out.nextCursor).toEqual({ startPage: 8 });
  });

  it('pages mode short-circuits and returns nextCursor=null on empty page', async () => {
    vi.mocked(findBoardByName).mockResolvedValue({
      id: 1, siteKey: 'school-bbs', boardKey: 'B', name: '版面',
    });
    vi.mocked(getBoardCrawlState).mockResolvedValue(null);
    const adapter = makeAdapter();
    (adapter.listThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const svc = new CrawlerService(deps(adapter));
    const out = await svc.listThreadsByName({
      siteKey: 'school-bbs', boardName: '版面', mode: 'pages',
    });
    expect(out.threads).toHaveLength(0);
    expect(out.nextCursor).toBeNull();
  });

  it('incremental mode stops when posted_at <= watermark', async () => {
    vi.mocked(findBoardByName).mockResolvedValue({
      id: 1, siteKey: 'school-bbs', boardKey: 'B', name: '版面',
    });
    vi.mocked(getBoardCrawlState).mockResolvedValue({
      boardId: 1,
      deepestPageCrawled: 2,
      latestThreadPostedAt: '2026-04-01T00:00:00Z',
      lastCrawledAt: '2026-04-02T00:00:00Z',
      lastThreadKey: null,
    });
    const adapter = makeAdapter();
    const list = adapter.listThreads as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce([
      row('200', '2026-05-08T00:00:00Z'),                  // newer — keep
      row('201', '2026-05-01T00:00:00Z'),                  // newer — keep
      row('202', '2026-04-01T00:00:00Z'),                  // == watermark — STOP
      row('203', '2026-03-01T00:00:00Z'),                  // older — would-be skipped
    ]);

    const svc = new CrawlerService(deps(adapter));
    const out = await svc.listThreadsByName({
      siteKey: 'school-bbs', boardName: '版面',
    });

    expect(out.threads.map((t) => t.title)).toEqual(['T200', 'T201']);
    expect(out.nextCursor).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    expect(out.state.latestThreadPostedAt).toBe('2026-05-08T00:00:00Z');
  });

  it('incremental mode does NOT stop on pinned threads at the top of the list', async () => {
    vi.mocked(findBoardByName).mockResolvedValue({
      id: 1, siteKey: 'school-bbs', boardKey: 'B', name: '版面',
    });
    vi.mocked(getBoardCrawlState).mockResolvedValue({
      boardId: 1,
      deepestPageCrawled: 0,
      latestThreadPostedAt: '2024-01-01T00:00:00Z',
      lastCrawledAt: null,
      lastThreadKey: null,
    });
    const adapter = makeAdapter();
    const list = adapter.listThreads as ReturnType<typeof vi.fn>;
    list
      .mockResolvedValueOnce([
        row('1', '2013-01-01T00:00:00Z', { isPinned: true }),  // ancient pinned — keep
        row('2', '2026-05-08T00:00:00Z'),                       // new normal — keep
      ])
      .mockResolvedValueOnce([]);  // page 2 empty -> stop

    const svc = new CrawlerService(deps(adapter));
    const out = await svc.listThreadsByName({
      siteKey: 'school-bbs', boardName: '版面',
    });

    expect(out.threads.map((t) => t.title)).toEqual(['T1', 'T2']);
  });

  it('incremental mode advances watermark only based on non-pinned posts', async () => {
    vi.mocked(findBoardByName).mockResolvedValue({
      id: 1, siteKey: 'school-bbs', boardKey: 'B', name: '版面',
    });
    vi.mocked(getBoardCrawlState).mockResolvedValue(null);
    const adapter = makeAdapter();
    const list = adapter.listThreads as ReturnType<typeof vi.fn>;
    list
      .mockResolvedValueOnce([
        row('1', '2099-01-01T00:00:00Z', { isPinned: true }), // pinned far-future - ignored for watermark
        row('2', '2026-05-08T00:00:00Z'),                      // normal - watermark candidate
      ])
      .mockResolvedValueOnce([]);

    const svc = new CrawlerService(deps(adapter));
    const out = await svc.listThreadsByName({
      siteKey: 'school-bbs', boardName: '版面',
    });

    expect(out.state.latestThreadPostedAt).toBe('2026-05-08T00:00:00Z');
  });

  it('persists every collected summary with isPinned propagated', async () => {
    vi.mocked(findBoardByName).mockResolvedValue({
      id: 1, siteKey: 'school-bbs', boardKey: 'B', name: '版面',
    });
    vi.mocked(getBoardCrawlState).mockResolvedValue(null);
    const adapter = makeAdapter();
    const list = adapter.listThreads as ReturnType<typeof vi.fn>;
    list
      .mockResolvedValueOnce([
        row('1', '2026-05-01T00:00:00Z', { isPinned: true }),
        row('2', '2026-05-08T00:00:00Z'),
      ])
      .mockResolvedValueOnce([]);

    const svc = new CrawlerService(deps(adapter));
    await svc.listThreadsByName({ siteKey: 'school-bbs', boardName: '版面' });

    expect(upsertThreadSummary).toHaveBeenCalledTimes(2);
    expect(upsertThreadSummary).toHaveBeenNthCalledWith(
      1, 'school-bbs', expect.objectContaining({ title: 'T1' }), { isPinned: true },
    );
    expect(upsertThreadSummary).toHaveBeenNthCalledWith(
      2, 'school-bbs', expect.objectContaining({ title: 'T2' }), { isPinned: false },
    );
  });

  it('upserts board_crawl_state with new deepest page and watermark', async () => {
    vi.mocked(findBoardByName).mockResolvedValue({
      id: 42, siteKey: 'school-bbs', boardKey: 'B', name: '版面',
    });
    vi.mocked(getBoardCrawlState).mockResolvedValue({
      boardId: 42, deepestPageCrawled: 1,
      latestThreadPostedAt: '2025-01-01T00:00:00Z',
      lastCrawledAt: null, lastThreadKey: null,
    });
    const adapter = makeAdapter();
    const list = adapter.listThreads as ReturnType<typeof vi.fn>;
    list
      .mockResolvedValueOnce([row('1', '2026-05-08T00:00:00Z')])
      .mockResolvedValueOnce([row('2', '2026-05-07T00:00:00Z')])
      .mockResolvedValueOnce([]);

    const svc = new CrawlerService(deps(adapter));
    const out = await svc.listThreadsByName({
      siteKey: 'school-bbs', boardName: '版面',
    });

    expect(upsertBoardCrawlState).toHaveBeenCalledWith(expect.objectContaining({
      boardId: 42,
      deepestPageCrawled: 2,
      latestThreadPostedAt: '2026-05-08T00:00:00Z',
    }));
    expect(out.state.deepestPageCrawled).toBe(2);
  });
});

describe('CrawlerService.fetchThreadById', () => {
  beforeEach(() => {
    process.env.SCHOOL_BBS_BASE_URL = 'https://x';
  });

  it('rejects malformed threadId with BOARD_NOT_FOUND', async () => {
    const svc = new CrawlerService(deps(makeAdapter()));
    await expect(
      svc.fetchThreadById({ siteKey: 'school-bbs', threadId: 'no-slash' }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_FOUND' });
  });

  it('parses threadId, builds article URL, and routes through fetchThread', async () => {
    const adapter = makeAdapter();
    const sample = {
      url: 'https://x/article/B/100', title: 'T', posts: [],
      fetchedAt: '2026-05-08T00:00:00Z',
    };
    (adapter.getThread as ReturnType<typeof vi.fn>).mockResolvedValue(sample);
    const svc = new CrawlerService(deps(adapter));
    const out = await svc.fetchThreadById({ siteKey: 'school-bbs', threadId: 'B/100' });
    expect(adapter.getThread).toHaveBeenCalledWith(
      fakePage,
      expect.objectContaining({ url: 'https://x/article/B/100' }),
    );
    expect(out).toEqual(sample);
  });
});
