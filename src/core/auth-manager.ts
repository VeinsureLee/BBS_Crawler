import type { Page } from 'playwright';
import { getCredentials } from './config';
import { SessionExpiredError } from './errors';
import type { SiteAdapter } from './site-adapter';

export interface AuthManagerDeps {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  saveStorageState: (siteKey: string) => Promise<void>;
  addRedactedSecret: (s: string) => void;
}

export class AuthManager {
  constructor(private readonly deps: AuthManagerDeps) {}

  async ensureLoggedIn(page: Page, adapter: SiteAdapter): Promise<void> {
    if (await adapter.isLoggedIn(page)) return;
    const creds = getCredentials(adapter.siteKey, this.deps.env);
    this.deps.addRedactedSecret(creds.password);
    await adapter.login(page, { username: creds.username, password: creds.password });
    await this.deps.saveStorageState(adapter.siteKey);
  }

  /** Returns a SessionExpiredError if the adapter reports not-logged-in mid-flow. */
  async detectSessionExpired(page: Page, adapter: SiteAdapter): Promise<SessionExpiredError | null> {
    if (await adapter.isLoggedIn(page)) return null;
    return new SessionExpiredError();
  }
}
