export interface RateLimiterOptions {
  minIntervalMs: number;
  jitterMs: number;
  maxConcurrency: number;
  random?: () => number;
  now?: () => number;
}

export interface RateLimiter {
  acquire(siteKey: string): Promise<() => void>;
}

interface PerSiteState {
  inFlight: number;
  lastReleaseAt: number;
  queue: Array<() => void>;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => Date.now());
  const states = new Map<string, PerSiteState>();

  function stateFor(siteKey: string): PerSiteState {
    let s = states.get(siteKey);
    if (!s) { s = { inFlight: 0, lastReleaseAt: 0, queue: [] }; states.set(siteKey, s); }
    return s;
  }

  function tryStart(siteKey: string): void {
    const s = stateFor(siteKey);
    while (s.inFlight < opts.maxConcurrency && s.queue.length > 0) {
      const waitNeeded = Math.max(0, s.lastReleaseAt + opts.minIntervalMs - now());
      const jitter = opts.jitterMs > 0 ? Math.floor(random() * opts.jitterMs) : 0;
      const delay = waitNeeded + jitter;
      const next = s.queue.shift()!;
      s.inFlight++;
      if (delay > 0) setTimeout(next, delay);
      else next();
    }
  }

  return {
    async acquire(siteKey: string): Promise<() => void> {
      const s = stateFor(siteKey);
      return new Promise((resolve) => {
        s.queue.push(() => {
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            s.inFlight--;
            s.lastReleaseAt = now();
            tryStart(siteKey);
          });
        });
        tryStart(siteKey);
      });
    },
  };
}
