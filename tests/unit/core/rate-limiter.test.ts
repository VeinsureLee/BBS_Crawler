import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRateLimiter, type RateLimiter } from '../../../src/core/rate-limiter';

let limiter: RateLimiter;

beforeEach(() => {
  vi.useFakeTimers();
  // Force jitter to 0 by passing a deterministic random.
  limiter = createRateLimiter({
    minIntervalMs: 100,
    jitterMs: 0,
    maxConcurrency: 1,
    random: () => 0,
  });
});

afterEach(() => vi.useRealTimers());

describe('rate limiter', () => {
  it('first acquire on a fresh siteKey resolves immediately', async () => {
    const release = await limiter.acquire('site');
    release();
  });

  it('second acquire waits at least minIntervalMs after the first release', async () => {
    const release1 = await limiter.acquire('site');
    release1();
    const start = Date.now();
    const acquired = limiter.acquire('site').then(() => Date.now() - start);
    await vi.advanceTimersByTimeAsync(99);
    // Not yet resolved.
    let resolved = false;
    acquired.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await acquired).toBeGreaterThanOrEqual(100);
  });

  it('different siteKeys do not block each other', async () => {
    const r1 = await limiter.acquire('a');
    // Should resolve without advancing timers.
    const r2 = await limiter.acquire('b');
    r1();
    r2();
  });

  it('maxConcurrency=1 serializes overlapping acquires on the same site', async () => {
    const order: string[] = [];
    const r1Promise = limiter.acquire('site');
    const r2Promise = limiter.acquire('site');
    const r1 = await r1Promise;
    order.push('r1-acquired');
    let r2: (() => void) | undefined;
    r2Promise.then((rel) => { r2 = rel; order.push('r2-acquired'); });
    await Promise.resolve();
    expect(order).toEqual(['r1-acquired']);
    r1();
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(['r1-acquired', 'r2-acquired']);
    r2!();
  });
});
