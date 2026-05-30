import { describe, it, expect } from 'vitest';
import type { Crawler } from '../../../src/service/factory';

describe('createCrawler shape', () => {
  it('exposes service, readers, init runners and shutdown', () => {
    const keys: (keyof Crawler)[] = [
      'service', 'readers', 'runInitSections', 'runInitBoards',
      'runInitPinned', 'runRefreshBoardStats', 'withLoggedInPage',
      'authStatus', 'warmUp', 'shutdown',
    ];
    expect(keys.length).toBe(10);
  });

  it('Crawler shape is exhaustive at compile time', () => {
    type _Check = Exclude<keyof Crawler, 'service'|'readers'|'runInitSections'|'runInitBoards'|'runInitPinned'|'runRefreshBoardStats'|'withLoggedInPage'|'authStatus'|'warmUp'|'shutdown'> extends never ? true : never;
    const ok: _Check = true;
    expect(ok).toBe(true);
  });
});
