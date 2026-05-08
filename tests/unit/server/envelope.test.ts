import { describe, it, expect } from 'vitest';
import { wrap } from '../../../src/server/envelope';
import { McpToolError } from '../../../src/server/error-codes';
import { SessionExpiredError, NavigationTimeoutError } from '../../../src/core/errors';

function body(res: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(res.content[0]!.text);
}

describe('envelope.wrap', () => {
  it('wraps success in {ok:true,data}', async () => {
    const res = await wrap(async () => ({ data: [1, 2, 3] }));
    expect(body(res)).toEqual({ ok: true, data: [1, 2, 3] });
  });

  it('includes nextCursor when provided', async () => {
    const res = await wrap(async () => ({ data: [], nextCursor: { startPage: 4 } }));
    expect(body(res)).toEqual({ ok: true, data: [], nextCursor: { startPage: 4 } });
  });

  it('includes nextCursor: null when explicitly null', async () => {
    const res = await wrap(async () => ({ data: [], nextCursor: null }));
    expect(body(res)).toEqual({ ok: true, data: [], nextCursor: null });
  });

  it('includes state when provided', async () => {
    const res = await wrap(async () => ({
      data: [],
      nextCursor: null,
      state: { deepestPageCrawled: 3, latestThreadPostedAt: '2026-05-08T03:14:00Z' },
    }));
    expect(body(res).state.deepestPageCrawled).toBe(3);
  });

  it('omits nextCursor and state fields when not provided', async () => {
    const res = await wrap(async () => ({ data: { x: 1 } }));
    const b = body(res);
    expect(b).toHaveProperty('ok', true);
    expect(b).toHaveProperty('data');
    expect(b).not.toHaveProperty('nextCursor');
    expect(b).not.toHaveProperty('state');
  });

  it('wraps McpToolError verbatim', async () => {
    const res = await wrap(async () => {
      throw new McpToolError('BOARD_NOT_FOUND', 'no such board: foo');
    });
    expect(body(res)).toEqual({
      ok: false,
      error: { code: 'BOARD_NOT_FOUND', message: 'no such board: foo' },
    });
  });

  it('maps SessionExpiredError -> SESSION_EXPIRED', async () => {
    const res = await wrap(async () => { throw new SessionExpiredError(); });
    expect(body(res).error.code).toBe('SESSION_EXPIRED');
  });

  it('maps NavigationTimeoutError -> FETCH_FAILED', async () => {
    const res = await wrap(async () => { throw new NavigationTimeoutError('https://x'); });
    expect(body(res).error.code).toBe('FETCH_FAILED');
  });

  it('coerces unknown errors to FETCH_FAILED', async () => {
    const res = await wrap(async () => { throw new Error('boom'); });
    expect(body(res)).toEqual({
      ok: false,
      error: { code: 'FETCH_FAILED', message: 'boom' },
    });
  });

  it('coerces non-Error throws to FETCH_FAILED', async () => {
    const res = await wrap(async () => { throw 'string thrown'; });
    expect(body(res).error).toEqual({ code: 'FETCH_FAILED', message: 'string thrown' });
  });
});
