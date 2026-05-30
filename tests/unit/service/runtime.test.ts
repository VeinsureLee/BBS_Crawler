import { describe, it, expect, vi } from 'vitest';
import { CrawlerRuntime } from '../../../src/service/runtime.js';
import type { Crawler } from '../../../src/service/factory.js';

function makeStubCrawler(): Crawler {
  return {
    service: { tag: 'service' } as any,
    readers: { tag: 'readers' } as any,
    runInitSections: vi.fn(),
    runInitBoards: vi.fn(),
    runInitPinned: vi.fn(),
    runRefreshBoardStats: vi.fn(),
    withLoggedInPage: vi.fn(),
    authStatus: vi.fn().mockResolvedValue({ siteKey: 'school-bbs', loggedIn: true, checkedAt: 't' }),
    warmUp: vi.fn().mockResolvedValue({ siteKey: 'school-bbs', loggedIn: true, warmedAt: 't' }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as Crawler;
}

describe('CrawlerRuntime', () => {
  it('throws when accessing service before init', () => {
    const rt = new CrawlerRuntime();
    expect(() => rt.service).toThrow(/not initialized/i);
    expect(rt.isReady()).toBe(false);
  });

  it('init() builds the crawler once and is idempotent', async () => {
    const stub = makeStubCrawler();
    const createCrawlerFn = vi.fn().mockResolvedValue(stub);
    const rt = new CrawlerRuntime({ createCrawlerFn });
    await rt.init();
    await rt.init(); // second call is a no-op
    expect(createCrawlerFn).toHaveBeenCalledTimes(1);
    expect(rt.isReady()).toBe(true);
    expect(rt.service).toBe(stub.service);
    expect(rt.readers).toBe(stub.readers);
  });

  it('delegates authStatus and warmUp to the crawler', async () => {
    const stub = makeStubCrawler();
    const rt = new CrawlerRuntime({ createCrawlerFn: vi.fn().mockResolvedValue(stub) });
    await rt.init();
    await rt.authStatus();
    await rt.warmUp();
    expect(stub.authStatus).toHaveBeenCalledTimes(1);
    expect(stub.warmUp).toHaveBeenCalledTimes(1);
  });

  it('passes config through to the factory', async () => {
    const stub = makeStubCrawler();
    const createCrawlerFn = vi.fn().mockResolvedValue(stub);
    const rt = new CrawlerRuntime({ config: { siteKey: 'school-bbs', idleTimeoutMs: 0 }, createCrawlerFn });
    await rt.init();
    expect(createCrawlerFn).toHaveBeenCalledWith({ siteKey: 'school-bbs', idleTimeoutMs: 0 });
  });

  it('shutdown() closes the crawler and resets ready state; second shutdown is a no-op', async () => {
    const stub = makeStubCrawler();
    const rt = new CrawlerRuntime({ createCrawlerFn: vi.fn().mockResolvedValue(stub) });
    await rt.init();
    await rt.shutdown();
    await rt.shutdown();
    expect(stub.shutdown).toHaveBeenCalledTimes(1);
    expect(rt.isReady()).toBe(false);
  });
});
