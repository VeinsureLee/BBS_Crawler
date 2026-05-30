import { describe, it, expect, vi } from 'vitest';
import { checkAuthStatus, type SessionOpsDeps } from '../../../src/service/session-ops.js';
import type { SiteAdapter } from '../../../src/contract/site-adapter.js';

function makeFakeAdapter(loggedIn: boolean): SiteAdapter {
  return {
    siteKey: 'school-bbs', displayName: 'X', baseUrl: 'http://bbs', requiresAuth: true,
    isLoggedIn: vi.fn().mockResolvedValue(loggedIn),
    login: vi.fn(), listThreads: vi.fn(), getThread: vi.fn(),
  } as unknown as SiteAdapter;
}

function makeDeps(adapter: SiteAdapter, opts: { ensureLoggedIn?: any } = {}) {
  const page = { goto: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  const context = { newPage: vi.fn().mockResolvedValue(page) };
  const release = vi.fn();
  const acquire = vi.fn().mockResolvedValue({ context, saveStorageState: vi.fn(), release });
  const deps: SessionOpsDeps = {
    browserPool: { acquire },
    getAdapter: () => adapter,
    ensureLoggedIn: opts.ensureLoggedIn ?? vi.fn(),
    baseUrl: 'http://bbs',
    now: () => '2026-05-30T00:00:00.000Z',
  };
  return { deps, page, context, release, acquire };
}

describe('checkAuthStatus', () => {
  it('navigates to baseUrl then reports loggedIn=true without logging in', async () => {
    const adapter = makeFakeAdapter(true);
    const { deps, page, release } = makeDeps(adapter);
    const r = await checkAuthStatus(deps, 'school-bbs');
    expect(r).toEqual({ siteKey: 'school-bbs', loggedIn: true, checkedAt: '2026-05-30T00:00:00.000Z' });
    expect(page.goto).toHaveBeenCalledWith('http://bbs', expect.any(Object));
    expect(deps.ensureLoggedIn).not.toHaveBeenCalled(); // read-only: never logs in
    expect(page.close).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it('reports loggedIn=false when adapter says not logged in', async () => {
    const adapter = makeFakeAdapter(false);
    const { deps } = makeDeps(adapter);
    const r = await checkAuthStatus(deps, 'school-bbs');
    expect(r.loggedIn).toBe(false);
  });

  it('still closes page and releases context when isLoggedIn throws', async () => {
    const adapter = makeFakeAdapter(true);
    (adapter.isLoggedIn as any).mockRejectedValueOnce(new Error('boom'));
    const { deps, page, release } = makeDeps(adapter);
    await expect(checkAuthStatus(deps, 'school-bbs')).rejects.toThrow('boom');
    expect(page.close).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });
});
