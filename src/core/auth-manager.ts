import type { Page } from 'playwright';
import { getCredentials } from './config';
import { MissingCredentialsError, SessionExpiredError } from './errors';
import type { SiteAdapter } from './site-adapter';
import { loadCredentials as loadStoredCredentialsDefault } from './credential-store';

export interface AuthManagerDeps {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  saveStorageState: (siteKey: string) => Promise<void>;
  addRedactedSecret: (s: string) => void;
  /**
   * Optional override for reading encrypted credentials from disk. Defaults
   * to credential-store.loadCredentials. Tests inject a fake.
   */
  loadStoredCredentials?: (siteKey: string) => Promise<{ username: string; password: string } | null>;
}

export class AuthManager {
  private readonly loadStored: (siteKey: string) => Promise<{ username: string; password: string } | null>;

  constructor(private readonly deps: AuthManagerDeps) {
    this.loadStored = deps.loadStoredCredentials ?? loadStoredCredentialsDefault;
  }

  async ensureLoggedIn(page: Page, adapter: SiteAdapter): Promise<void> {
    if (await adapter.isLoggedIn(page)) return;
    const creds = await this.resolveCredentials(adapter.siteKey);
    this.deps.addRedactedSecret(creds.password);
    await adapter.login(page, { username: creds.username, password: creds.password });
    await this.deps.saveStorageState(adapter.siteKey);
  }

  /** Returns a SessionExpiredError if the adapter reports not-logged-in mid-flow. */
  async detectSessionExpired(page: Page, adapter: SiteAdapter): Promise<SessionExpiredError | null> {
    if (await adapter.isLoggedIn(page)) return null;
    return new SessionExpiredError();
  }

  /**
   * Layered credential lookup:
   *   1. Environment variables (existing behavior — first-time setup path).
   *   2. Encrypted credential store (saved by `npm run login` with "remember password").
   *   3. Throw MissingCredentialsError to surface SESSION_EXPIRED / LOGIN_FAILED to the agent.
   */
  private async resolveCredentials(siteKey: string): Promise<{ username: string; password: string }> {
    try {
      const fromEnv = getCredentials(siteKey, this.deps.env);
      return { username: fromEnv.username, password: fromEnv.password };
    } catch (e) {
      if (!(e instanceof MissingCredentialsError)) throw e;
      const fromDisk = await this.loadStored(siteKey);
      if (fromDisk) return fromDisk;
      throw e;
    }
  }
}
