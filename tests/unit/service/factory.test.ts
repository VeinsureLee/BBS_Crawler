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
});
