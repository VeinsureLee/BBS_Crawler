import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initDb, closeAllDbs, _resetForTests } from '../../../src/repository/db';
import { upsertSite } from '../../../src/repository/sites';
import { upsertSection } from '../../../src/repository/sections';
import { upsertBoard } from '../../../src/repository/boards';
import { upsertThreadSummary } from '../../../src/repository/threads';
import { getSectionDetail } from '../../../src/read/readers';

let dir: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-sd-'));
  _resetForTests();
  initDb({ dataDir: dir });
  await upsertSite({ siteKey: 's', displayName: 'S', baseUrl: 'https://x' });
  const { sectionId } = await upsertSection({ siteKey: 's', sectionKey: 'F', name: '讨论区F' });
  await upsertBoard({ siteKey: 's', boardKey: 'B1', name: '版面1', sectionId, moderators: ['张三'] });
  await upsertThreadSummary('s', { board: 'B1', url: 'https://x/article/B1/1', title: '置顶A', postedAt: '2026-05-01T00:00:00Z', raw: { isPinned: true } } as any, { isPinned: true });
  await upsertThreadSummary('s', { board: 'B1', url: 'https://x/article/B1/2', title: '普通B', postedAt: '2026-05-02T00:00:00Z' } as any, { isPinned: false });
});
afterEach(async () => { await closeAllDbs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('getSectionDetail', () => {
  it('returns section + boards with pinned titles and recent plain threads', async () => {
    const d = await getSectionDetail('s', 'F', { recentLimit: 5 });
    expect(d.section.sectionKey).toBe('F');
    expect(d.boards).toHaveLength(1);
    const b = d.boards[0]!;
    expect(b.boardKey).toBe('B1');
    expect(b.pinnedThreadTitles).toContain('置顶A');
    expect(b.recentThreads.map((t) => t.title)).toContain('普通B');
    expect(b.recentThreads.find((t) => t.title === '置顶A')).toBeUndefined();
  });

  it('exposes board moderators (folded in via listBoards)', async () => {
    const d = await getSectionDetail('s', 'F', { recentLimit: 5 });
    expect(d.boards[0]!.moderators).toContain('张三');
  });

  it('returns null stats when no daily_traffic recorded', async () => {
    const d = await getSectionDetail('s', 'F', { recentLimit: 5 });
    expect(d.boards[0]!.stats).toBeNull();
  });

  it('throws when the section does not exist', async () => {
    await expect(getSectionDetail('s', 'MISSING')).rejects.toThrow();
  });

  it('truncates recentThreads to recentLimit, newest first', async () => {
    await upsertThreadSummary('s', { board: 'B1', url: 'https://x/article/B1/3', title: '普通C', postedAt: '2026-05-03T00:00:00Z' } as any, { isPinned: false });
    const d = await getSectionDetail('s', 'F', { recentLimit: 1 });
    const b = d.boards[0]!;
    expect(b.recentThreads).toHaveLength(1);
    expect(b.recentThreads[0]!.title).toBe('普通C');
  });
});
