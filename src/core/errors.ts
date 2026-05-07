export abstract class BaseAppError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MissingCredentialsError extends BaseAppError {
  readonly code = 'MISSING_CREDENTIALS';
  constructor(public readonly missingEnvKeys: string[]) {
    super(`Missing required env vars: ${missingEnvKeys.join(', ')}`);
  }
}

export class LoginFailedError extends BaseAppError {
  readonly code = 'LOGIN_FAILED';
  constructor(public readonly hint: string) {
    super(`Login failed: ${hint}`);
  }
}

export class SessionExpiredError extends BaseAppError {
  readonly code = 'SESSION_EXPIRED';
  constructor() { super('Session expired'); }
}

export class NavigationTimeoutError extends BaseAppError {
  readonly code = 'NAVIGATION_TIMEOUT';
  constructor(public readonly url: string) {
    super(`Navigation timed out: ${url}`);
  }
}

export class RateLimitedError extends BaseAppError {
  readonly code = 'RATE_LIMITED';
  constructor(message = 'Rate limited by upstream') { super(message); }
}

export class SelectorMissingError extends BaseAppError {
  readonly code = 'SELECTOR_MISSING';
  constructor(public readonly siteKey: string, public readonly hint: string) {
    super(`[${siteKey}] selector missing: ${hint}`);
  }
}

export class UnknownSiteError extends BaseAppError {
  readonly code = 'UNKNOWN_SITE';
  constructor(public readonly siteKey: string, public readonly available: string[]) {
    super(`Unknown siteKey: ${siteKey}. Available: ${available.join(', ') || '(none)'}`);
  }
}

export class DatabaseError extends BaseAppError {
  readonly code = 'DATABASE';
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) {
      (this as any).cause = cause;
    }
  }
}
