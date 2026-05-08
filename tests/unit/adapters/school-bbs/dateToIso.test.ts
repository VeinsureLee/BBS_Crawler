import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dateToIso } from '../../../../src/adapters/school-bbs/listThreads';

// Pin "now" so relative-date tests are deterministic.
// 2026-05-08 14:00:00 Beijing = 2026-05-08 06:00:00 UTC.
const NOW_ISO = '2026-05-08T06:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dateToIso', () => {
  it('returns undefined for empty / nullish input', () => {
    expect(dateToIso(undefined)).toBeUndefined();
    expect(dateToIso('')).toBeUndefined();
    expect(dateToIso('   ')).toBeUndefined();
  });

  it('parses YYYY-MM-DD as 00:00 CST', () => {
    // 2026-04-16 00:00 CST = 2026-04-15 16:00 UTC
    expect(dateToIso('2026-04-16')).toBe('2026-04-15T16:00:00.000Z');
  });

  it('parses MM-DD as current CST year', () => {
    // 04-16 in 2026 → 2026-04-15T16:00:00Z
    expect(dateToIso('04-16')).toBe('2026-04-15T16:00:00.000Z');
  });

  it('parses HH:MM as today in CST', () => {
    // 14:30 today (2026-05-08 CST) → 2026-05-08 14:30 CST = 06:30 UTC
    expect(dateToIso('14:30')).toBe('2026-05-08T06:30:00.000Z');
  });

  it('parses 今天 as 00:00 CST today', () => {
    // 2026-05-08 00:00 CST = 2026-05-07 16:00 UTC
    expect(dateToIso('今天')).toBe('2026-05-07T16:00:00.000Z');
  });

  it('parses 昨天 as 00:00 CST yesterday', () => {
    expect(dateToIso('昨天')).toBe('2026-05-06T16:00:00.000Z');
  });

  it('parses 前天 as 00:00 CST two days ago', () => {
    expect(dateToIso('前天')).toBe('2026-05-05T16:00:00.000Z');
  });

  it('parses N天前 as 00:00 CST N days ago', () => {
    expect(dateToIso('3天前')).toBe('2026-05-04T16:00:00.000Z');
    expect(dateToIso('30天前')).toBe('2026-04-07T16:00:00.000Z');
  });

  it('returns undefined for unrecognized formats', () => {
    expect(dateToIso('不久之前')).toBeUndefined();
    expect(dateToIso('2026/04/16')).toBeUndefined();
    expect(dateToIso('Apr 16')).toBeUndefined();
  });

  it('relative dates are chronologically ordered', () => {
    const today = dateToIso('今天')!;
    const yesterday = dateToIso('昨天')!;
    const dayBefore = dateToIso('前天')!;
    expect(today > yesterday).toBe(true);
    expect(yesterday > dayBefore).toBe(true);
    expect(dateToIso('1天前')).toBe(yesterday);
  });
});
