import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initDb, closeAllDbs, _resetForTests } from '../../../src/repository/db';
import { upsertSite } from '../../../src/repository/sites';
import { upsertSection } from '../../../src/repository/sections';
import { upsertBoard } from '../../../src/repository/boards';
import { upsertThreadSummary } from '../../../src/repository/threads';
import { searchThreadsByTitle } from '../../../src/read/readers';

let dir: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-stbt-'));
  _resetForTests();
  initDb({ dataDir: dir });
  await upsertSite({ siteKey: 's', displayName: 'S', baseUrl: 'https://x' });
  const { sectionId } = await upsertSection({ siteKey: 's', sectionKey: 'F', name: '讨论区F' });
  const { boardId: b1 } = await upsertBoard({ siteKey: 's', boardKey: 'B1', name: '版面1', sectionId });
  const { boardId: b2 } = await upsertBoard({ siteKey: 's', boardKey: 'B2', name: '版面2', sectionId });
  void b1; void b2;
  await upsertThreadSummary('s', { board: 'B1', url: 'https://x/article/B1/1', title: 'Hello World 早安', postedAt: '2026-05-01T00:00:00Z' } as any, { isPinned: false });
  await upsertThreadSummary('s', { board: 'B1', url: 'https://x/article/B1/2', title: '完全无关的标题', postedAt: '2026-05-03T00:00:00Z' } as any, { isPinned: false });
  await upsertThreadSummary('s', { board: 'B2', url: 'https://x/article/B2/1', title: 'Hello again 晚安', postedAt: '2026-05-02T00:00:00Z' } as any, { isPinned: false });
});
afterEach(async () => { await closeAllDbs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('searchThreadsByTitle', () => {
  it('matches title across all boards, ordered by posted_at DESC, limited', async () => {
    const rows = await searchThreadsByTitle('s', 'Hello', 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.title).toBe('Hello again 晚安');     // 2026-05-02 newer
    expect(rows[1]!.title).toBe('Hello World 早安');     // 2026-05-01
    expect(rows.every((r) => r.title.includes('Hello'))).toBe(true);
  });

  it('respects limit', async () => {
    const rows = await searchThreadsByTitle('s', 'Hello', 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Hello again 晚安');
  });

  it('returns empty when no match', async () => {
    expect(await searchThreadsByTitle('s', 'NOPE_NEVER', 10)).toEqual([]);
  });

  it('default limit 50 applies when not given', async () => {
    const rows = await searchThreadsByTitle('s', 'Hello');
    expect(rows.length).toBeLessThanOrEqual(50);
  });
});
