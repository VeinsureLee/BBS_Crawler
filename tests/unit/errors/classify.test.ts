import { describe, it, expect } from 'vitest';
import { classifyError } from '../../../src/error-classify.js';
import {
  RateLimitedError, BoardNotFoundError, MissingCredentialsError,
  SessionExpiredError, NavigationTimeoutError, DatabaseError,
} from '../../../src/errors.js';

describe('classifyError', () => {
  it('maps RateLimited to retryable rate_limited', () => {
    const c = classifyError(new RateLimitedError());
    expect(c).toMatchObject({ code: 'RATE_LIMITED', kind: 'rate_limited', retryable: true });
  });

  it('maps BoardNotFound to non-retryable invalid_params', () => {
    const c = classifyError(new BoardNotFoundError('nope'));
    expect(c).toMatchObject({ code: 'BOARD_NOT_FOUND', kind: 'invalid_params', retryable: false });
  });

  it('maps MissingCredentials to config (non-retryable)', () => {
    const c = classifyError(new MissingCredentialsError(['SCHOOL_BBS_USERNAME']));
    expect(c).toMatchObject({ code: 'MISSING_CREDENTIALS', kind: 'config', retryable: false });
  });

  it('marks SessionExpired and NavigationTimeout retryable', () => {
    expect(classifyError(new SessionExpiredError()).retryable).toBe(true);
    expect(classifyError(new NavigationTimeoutError('http://x')).retryable).toBe(true);
  });

  it('maps DatabaseError to database kind', () => {
    expect(classifyError(new DatabaseError('boom')).kind).toBe('database');
  });

  it('falls back to INTERNAL for unknown errors', () => {
    const c = classifyError(new Error('weird'));
    expect(c).toMatchObject({ code: 'INTERNAL', kind: 'internal', retryable: false, message: 'weird' });
  });

  it('handles non-Error throwables', () => {
    const c = classifyError('just a string');
    expect(c).toMatchObject({ code: 'INTERNAL', kind: 'internal', message: 'just a string' });
  });
});
