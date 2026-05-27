import { describe, it, expect } from 'vitest';
import {
  BaseAppError,
  MissingCredentialsError,
  LoginFailedError,
  SessionExpiredError,
  NavigationTimeoutError,
  RateLimitedError,
  SelectorMissingError,
  UnknownSiteError,
  DatabaseError,
} from '../../../src/errors';

describe('error classes', () => {
  it('MissingCredentialsError carries code and missingEnvKeys', () => {
    const e = new MissingCredentialsError(['SCHOOL_BBS_USERNAME']);
    expect(e).toBeInstanceOf(BaseAppError);
    expect(e.code).toBe('MISSING_CREDENTIALS');
    expect(e.missingEnvKeys).toEqual(['SCHOOL_BBS_USERNAME']);
  });

  it('LoginFailedError carries code and hint', () => {
    const e = new LoginFailedError('bad password');
    expect(e.code).toBe('LOGIN_FAILED');
    expect(e.hint).toBe('bad password');
  });

  it('SessionExpiredError code', () => {
    expect(new SessionExpiredError().code).toBe('SESSION_EXPIRED');
  });

  it('NavigationTimeoutError carries url', () => {
    const e = new NavigationTimeoutError('https://x/y');
    expect(e.code).toBe('NAVIGATION_TIMEOUT');
    expect(e.url).toBe('https://x/y');
  });

  it('RateLimitedError code', () => {
    expect(new RateLimitedError().code).toBe('RATE_LIMITED');
  });

  it('SelectorMissingError carries siteKey and hint', () => {
    const e = new SelectorMissingError('school-bbs', 'thread title not found');
    expect(e.code).toBe('SELECTOR_MISSING');
    expect(e.siteKey).toBe('school-bbs');
    expect(e.hint).toBe('thread title not found');
  });

  it('UnknownSiteError carries available list', () => {
    const e = new UnknownSiteError('x', ['a', 'b']);
    expect(e.code).toBe('UNKNOWN_SITE');
    expect(e.available).toEqual(['a', 'b']);
  });

  it('DatabaseError wraps cause', () => {
    const cause = new Error('connection refused');
    const e = new DatabaseError('upsert failed', cause);
    expect(e.code).toBe('DATABASE');
    expect(e.cause).toBe(cause);
  });
});
