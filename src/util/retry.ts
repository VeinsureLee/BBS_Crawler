export interface RetryOptions {
  attempts: number;       // total attempts (>=1)
  baseMs: number;         // initial backoff
  factor?: number;        // multiplier per retry, default 3
  shouldRetry?: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const factor = opts.factor ?? 3;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  let delay = opts.baseMs;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const isLast = i === opts.attempts - 1;
      if (isLast || (opts.shouldRetry && !opts.shouldRetry(e))) throw e;
      await sleep(delay);
      delay *= factor;
    }
  }
  throw lastErr;
}
