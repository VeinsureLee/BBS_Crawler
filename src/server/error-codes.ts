/**
 * Tool-level error contract exposed to the agent.
 *
 * Internal errors (NavigationTimeoutError, RateLimitedError, ...) are mapped
 * down to one of these four codes so the agent only has to learn a small
 * vocabulary. Detailed messages are still surfaced via `error.message`.
 */
import {
  SessionExpiredError,
  LoginFailedError,
  NavigationTimeoutError,
  RateLimitedError,
  SelectorMissingError,
  UnknownSiteError,
  MissingCredentialsError,
  DatabaseError,
  BaseAppError,
} from '../core/errors';

export type ErrorCode =
  | 'SESSION_EXPIRED'
  | 'LOGIN_FAILED'
  | 'BOARD_NOT_FOUND'
  | 'FETCH_FAILED';

export class McpToolError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

/**
 * Normalize any thrown value into an McpToolError with a stable code.
 * Used by the envelope to produce uniform failure responses.
 */
export function toToolError(e: unknown): McpToolError {
  if (e instanceof McpToolError) return e;

  if (e instanceof SessionExpiredError) {
    return new McpToolError('SESSION_EXPIRED', e.message);
  }
  if (e instanceof LoginFailedError || e instanceof MissingCredentialsError) {
    return new McpToolError('LOGIN_FAILED', e.message);
  }
  if (e instanceof UnknownSiteError) {
    return new McpToolError('BOARD_NOT_FOUND', e.message);
  }
  if (
    e instanceof NavigationTimeoutError ||
    e instanceof RateLimitedError ||
    e instanceof SelectorMissingError ||
    e instanceof DatabaseError
  ) {
    return new McpToolError('FETCH_FAILED', e.message);
  }
  if (e instanceof BaseAppError) {
    return new McpToolError('FETCH_FAILED', e.message);
  }
  return new McpToolError('FETCH_FAILED', e instanceof Error ? e.message : String(e));
}
