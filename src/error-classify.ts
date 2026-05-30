import { BaseAppError } from './errors.js';

export type ErrorKind =
  | 'auth'
  | 'invalid_params'
  | 'rate_limited'
  | 'transient'
  | 'config'
  | 'database'
  | 'internal';

export interface ErrorClassification {
  /** Original BaseAppError.code, or 'INTERNAL' for unknown throwables. */
  code: string;
  kind: ErrorKind;
  /** Whether a consumer may sensibly retry. NOTE: CrawlerService.run() already
   *  auto-retries SESSION_EXPIRED / RATE_LIMITED / NAVIGATION_TIMEOUT; this flag
   *  describes the error's nature, consumers should NOT stack extra retries. */
  retryable: boolean;
  message: string;
}

const CODE_MAP: Record<string, { kind: ErrorKind; retryable: boolean }> = {
  MISSING_CREDENTIALS: { kind: 'config',         retryable: false },
  LOGIN_FAILED:        { kind: 'auth',           retryable: false },
  SESSION_EXPIRED:     { kind: 'auth',           retryable: true  },
  NAVIGATION_TIMEOUT:  { kind: 'transient',      retryable: true  },
  RATE_LIMITED:        { kind: 'rate_limited',   retryable: true  },
  SELECTOR_MISSING:    { kind: 'internal',       retryable: false },
  UNKNOWN_SITE:        { kind: 'invalid_params', retryable: false },
  DATABASE:            { kind: 'database',        retryable: false },
  BOARD_NOT_FOUND:     { kind: 'invalid_params', retryable: false },
  FETCH_FAILED:        { kind: 'internal',       retryable: false },
};

export function classifyError(e: unknown): ErrorClassification {
  if (e instanceof BaseAppError) {
    const m = CODE_MAP[e.code] ?? { kind: 'internal' as ErrorKind, retryable: false };
    return { code: e.code, kind: m.kind, retryable: m.retryable, message: e.message };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { code: 'INTERNAL', kind: 'internal', retryable: false, message };
}
