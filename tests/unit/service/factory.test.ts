import { describe, it, expect } from 'vitest';
import type { Crawler } from '../../../src/service/factory';

describe('createCrawler shape', () => {
  it('exposes service, readers, init runners and shutdown', () => {
    const keys: (keyof Crawler)[] = [
      'service', 'readers', 'runInitSections', 'runInitBoards',
      'runInitPinned', 'runRefreshBoardStats', 'withLoggedInPage', 'shutdown',
    ];
    expect(keys.length).toBe(8);
  });

  it('Crawler shape is exhaustive at compile time', () => {
    type _Check = Exclude<keyof Crawler, 'service'|'readers'|'runInitSections'|'runInitBoards'|'runInitPinned'|'runRefreshBoardStats'|'withLoggedInPage'|'shutdown'> extends never ? true : never;
    const ok: _Check = true;
    expect(ok).toBe(true);
  });
});
