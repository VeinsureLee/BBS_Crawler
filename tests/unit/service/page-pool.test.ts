import { describe, it, expect, vi } from 'vitest';
import { runWithPagePool, BrowserDeadError, type PoolDeps } from '../../../src/service/page-pool';

function fakeDeps(): PoolDeps {
  const pages: any[] = [];
  return {
    context: {
      newPage: vi.fn(async () => {
        const page = { id: pages.length + 1, close: vi.fn(async () => {}) };
        pages.push(page);
        return page as any;
      }),
    } as any,
    ensureLoggedIn: vi.fn(async () => {}),
  };
}

describe('runWithPagePool', () => {
  it('runs all items through workers and returns per-item ok results', async () => {
    const deps = fakeDeps();
    const items = [1, 2, 3, 4, 5];
    const results = await runWithPagePool(deps, items, 2, async (item) => item * 10);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.result).toBe(r.item * 10);
    }
  });

  it('caps worker count at concurrency', async () => {
    const deps = fakeDeps();
    let inFlight = 0; let maxInFlight = 0;
    await runWithPagePool(deps, [1, 2, 3, 4, 5, 6], 3, async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    expect(maxInFlight).toBe(3);
  });

  it('caps worker count at items.length when items are fewer', async () => {
    const deps = fakeDeps();
    await runWithPagePool(deps, [1, 2], 10, async (x) => x);
    expect((deps.context.newPage as any).mock.calls.length).toBe(2);
  });

  it('captures per-item failures without throwing', async () => {
    const deps = fakeDeps();
    const results = await runWithPagePool(deps, [1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('boom');
      return item;
    });
    const failed = results.filter((r) => !r.ok);
    expect(failed).toHaveLength(1);
    if (!failed[0]!.ok) {
      expect((failed[0]!.error as Error).message).toBe('boom');
    }
  });

  it('emits onProgress with started/ok/failed phases', async () => {
    const deps = fakeDeps();
    const events: string[] = [];
    await runWithPagePool(
      deps,
      [1, 2, 3],
      2,
      async (x) => { if (x === 2) throw new Error('e'); return x; },
      (ev) => events.push(`${ev.phase}:${ev.item}`),
    );
    const starts = events.filter((e) => e.startsWith('started:'));
    const oks    = events.filter((e) => e.startsWith('ok:'));
    const fails  = events.filter((e) => e.startsWith('failed:'));
    expect(starts).toHaveLength(3);
    expect(oks).toEqual(expect.arrayContaining(['ok:1', 'ok:3']));
    expect(fails).toEqual(['failed:2']);
  });

  it('closes every page it opened (success path)', async () => {
    const deps = fakeDeps();
    const opened: any[] = [];
    (deps.context.newPage as any).mockImplementation(async () => {
      const p = { close: vi.fn(async () => {}) };
      opened.push(p);
      return p;
    });
    await runWithPagePool(deps, [1, 2, 3], 2, async (x) => x);
    for (const p of opened) expect(p.close).toHaveBeenCalled();
  });

  it('returns empty array when items list is empty', async () => {
    const deps = fakeDeps();
    const r = await runWithPagePool(deps, [], 4, async (x: number) => x);
    expect(r).toEqual([]);
    expect((deps.context.newPage as any).mock.calls.length).toBe(0);
  });

  it('throws BrowserDeadError when worker hits Target closed', async () => {
    const deps = fakeDeps();
    await expect(
      runWithPagePool(deps, [1, 2, 3], 2, async () => {
        throw new Error('Target closed: page abandoned');
      }),
    ).rejects.toBeInstanceOf(BrowserDeadError);
  });
});
