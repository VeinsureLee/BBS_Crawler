import { describe, it, expect, vi } from 'vitest';
import { AuthManager } from '../../../src/core/auth-manager';
import type { SiteAdapter } from '../../../src/core/site-adapter';
import { SessionExpiredError, MissingCredentialsError } from '../../../src/core/errors';

const fakePage = {} as never;

function fakeAdapter(overrides: Partial<SiteAdapter> = {}): SiteAdapter {
  return {
    siteKey: 'school-bbs',
    displayName: 'X',
    baseUrl: 'https://x',
    requiresAuth: true,
    isLoggedIn: vi.fn().mockResolvedValue(false),
    login: vi.fn().mockResolvedValue(undefined),
    listThreads: vi.fn(),
    getThread: vi.fn(),
    search: vi.fn(),
    ...overrides,
  } as SiteAdapter;
}

describe('AuthManager.ensureLoggedIn', () => {
  it('returns immediately if already logged in', async () => {
    const adapter = fakeAdapter({ isLoggedIn: vi.fn().mockResolvedValue(true) });
    const am = new AuthManager({
      env: { SCHOOL_BBS_USERNAME: 'u', SCHOOL_BBS_PASSWORD: 'p' },
      saveStorageState: vi.fn(),
      addRedactedSecret: () => {},
    });
    await am.ensureLoggedIn(fakePage, adapter);
    expect(adapter.login).not.toHaveBeenCalled();
  });

  it('runs login and persists storageState when not logged in', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const adapter = fakeAdapter();
    const am = new AuthManager({
      env: { SCHOOL_BBS_USERNAME: 'u', SCHOOL_BBS_PASSWORD: 'p' },
      saveStorageState: save,
      addRedactedSecret: () => {},
    });
    await am.ensureLoggedIn(fakePage, adapter);
    expect(adapter.login).toHaveBeenCalledWith(fakePage, { username: 'u', password: 'p' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('throws MissingCredentialsError when env keys missing AND no stored creds', async () => {
    const adapter = fakeAdapter();
    const am = new AuthManager({
      env: {}, saveStorageState: vi.fn(), addRedactedSecret: () => {},
      loadStoredCredentials: vi.fn().mockResolvedValue(null),
    });
    await expect(am.ensureLoggedIn(fakePage, adapter)).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it('falls back to stored credentials when env vars are missing', async () => {
    const adapter = fakeAdapter();
    const save = vi.fn().mockResolvedValue(undefined);
    const am = new AuthManager({
      env: {},
      saveStorageState: save,
      addRedactedSecret: () => {},
      loadStoredCredentials: vi.fn().mockResolvedValue({ username: 'stored-u', password: 'stored-p' }),
    });
    await am.ensureLoggedIn(fakePage, adapter);
    expect(adapter.login).toHaveBeenCalledWith(fakePage, { username: 'stored-u', password: 'stored-p' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('prefers env vars over stored credentials when both are present', async () => {
    const adapter = fakeAdapter();
    const loadStored = vi.fn().mockResolvedValue({ username: 'stored', password: 'stored-pw' });
    const am = new AuthManager({
      env: { SCHOOL_BBS_USERNAME: 'env-u', SCHOOL_BBS_PASSWORD: 'env-p' },
      saveStorageState: vi.fn(),
      addRedactedSecret: () => {},
      loadStoredCredentials: loadStored,
    });
    await am.ensureLoggedIn(fakePage, adapter);
    expect(adapter.login).toHaveBeenCalledWith(fakePage, { username: 'env-u', password: 'env-p' });
    expect(loadStored).not.toHaveBeenCalled();
  });

  it('detectSessionExpired returns SessionExpiredError when post-call check is false', async () => {
    const adapter = fakeAdapter({ isLoggedIn: vi.fn().mockResolvedValue(false) });
    const am = new AuthManager({
      env: { SCHOOL_BBS_USERNAME: 'u', SCHOOL_BBS_PASSWORD: 'p' },
      saveStorageState: vi.fn(),
      addRedactedSecret: () => {},
    });
    const e = await am.detectSessionExpired(fakePage, adapter);
    expect(e).toBeInstanceOf(SessionExpiredError);
  });
});
