import { describe, it, expect, vi } from 'vitest';
import { CrawlerService } from '../../../../src/core/crawler-service';
import type { SiteAdapter, Thread } from '../../../../src/core/site-adapter';
import {
  SessionExpiredError,
  NavigationTimeoutError,
  RateLimitedError,
} from '../../../../src/core/errors';

function makeAdapter(thread: Thread): SiteAdapter {
  return {
    siteKey: 'school-bbs',
    displayName: 'X',
    baseUrl: 'https://x',
    requiresAuth: true,
    isLoggedIn: vi.fn().mockResolvedValue(true),
    login: vi.fn().mockResolvedValue(undefined),
    listThreads: vi.fn(),
    search: vi.fn(),
    getThread: vi.fn().mockResolvedValue(thread),
  } as unknown as SiteAdapter;
}

const fakePage = {} as never;
const fakeContext = { newPage: async () => fakePage } as never;

function deps(adapter: SiteAdapter, opts: {
  persist?: () => Promise<number>;
  appendFetchLog?: () => Promise<void>;
} = {}) {
  const wipeStorageState = vi.fn(async () => {});
  return {
    rateLimiter: { acquire: async () => () => {} },
    browserPool: {
      acquire: async () => ({
        context: fakeContext,
        saveStorageState: async () => {},
        release: () => {},
      }),
      wipeStorageState,
    },
    auth: {
      ensureLoggedIn: vi.fn(async () => {}),
      detectSessionExpired: vi.fn(async () => null),
    },
    registry: { getAdapter: () => adapter },
    persistThread: opts.persist ?? vi.fn(async () => 7),
    appendFetchLog: opts.appendFetchLog
      ? vi.fn(opts.appendFetchLog)
      : vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    _wipeStorageStateSpy: wipeStorageState,
  };
}

const sampleThread: Thread = {
  url: 'https://x/t/1',
  title: 'Hi',
  posts: [],
  fetchedAt: '2026-05-07T00:00:00Z',
};

describe('CrawlerService.fetchThread', () => {
  it('returns thread without persisting when persist=false', async () => {
    const adapter = makeAdapter(sampleThread);
    const persist = vi.fn(async () => 7);
    const svc = new CrawlerService(deps(adapter, { persist }));
    const out = await svc.fetchThread({ siteKey: 'school-bbs', url: sampleThread.url, persist: false });
    expect(out.thread).toEqual(sampleThread);
    expect(out.persisted).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it('persists when persist=true and returns threadId', async () => {
    const adapter = makeAdapter(sampleThread);
    const persist = vi.fn(async () => 42);
    const svc = new CrawlerService(deps(adapter, { persist }));
    const out = await svc.fetchThread({ siteKey: 'school-bbs', url: sampleThread.url, persist: true });
    expect(out.persisted).toBe(true);
    expect(out.threadId).toBe(42);
  });

  it('retries once after SessionExpired and wipes storageState', async () => {
    const adapter = makeAdapter(sampleThread);
    let calls = 0;
    (adapter.getThread as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new SessionExpiredError();
      return sampleThread;
    });
    const d = deps(adapter);
    const svc = new CrawlerService(d);
    const out = await svc.fetchThread({ siteKey: 'school-bbs', url: sampleThread.url, persist: false });
    expect(calls).toBe(2);
    expect(d._wipeStorageStateSpy).toHaveBeenCalledWith('school-bbs');
    expect(out.thread).toEqual(sampleThread);
  });

  it('retries NavigationTimeout twice with backoff before failing', async () => {
    const adapter = makeAdapter(sampleThread);
    (adapter.getThread as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new NavigationTimeoutError('https://x/t/1');
    });
    const d = deps(adapter);
    const svc = new CrawlerService(d);
    await expect(svc.fetchThread({ siteKey: 'school-bbs', url: sampleThread.url }))
      .rejects.toBeInstanceOf(NavigationTimeoutError);
    // Initial call + 2 retries = 3 total.
    expect(adapter.getThread).toHaveBeenCalledTimes(3);
    // 2 sleeps between the 3 attempts: 500ms then 1500ms.
    expect(d.sleep).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenNthCalledWith(1, 500);
    expect(d.sleep).toHaveBeenNthCalledWith(2, 1500);
  });

  it('retries RateLimited once with 30s backoff before failing', async () => {
    const adapter = makeAdapter(sampleThread);
    (adapter.getThread as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new RateLimitedError();
    });
    const d = deps(adapter);
    const svc = new CrawlerService(d);
    await expect(svc.fetchThread({ siteKey: 'school-bbs', url: sampleThread.url }))
      .rejects.toBeInstanceOf(RateLimitedError);
    expect(adapter.getThread).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledWith(30_000);
  });

  it('still returns thread when audit log write fails (path A degrade)', async () => {
    const adapter = makeAdapter(sampleThread);
    const d = deps(adapter, { appendFetchLog: async () => { throw new Error('db down'); } });
    const svc = new CrawlerService(d);
    const out = await svc.fetchThread({ siteKey: 'school-bbs', url: sampleThread.url });
    expect(out.thread).toEqual(sampleThread);
  });
});
