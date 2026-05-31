/**
 * Shared worker-pool primitive used by all `runInit*` functions. Opens N
 * pages on a single BrowserContext, ensures each is logged in, then drains
 * a shared queue: workers pull items atomically, run `worker(item, ctx)`,
 * and record per-item outcomes.
 *
 * Failure handling is the caller's job — exceptions in `worker` are
 * captured into PoolItemFailure entries; the pool itself never throws
 * (except for BrowserDeadError, which is fatal to the run).
 */
import type { BrowserContext, Page } from 'playwright';

export interface PoolDeps {
  context: BrowserContext;
  ensureLoggedIn: (page: Page) => Promise<void>;
}

export interface WorkerCtx {
  workerId: number;
  page: Page;
}

export interface PoolProgressEvent<I> {
  /** total items across the entire pool run. */
  total: number;
  /** items that have started OR finished (success+failure). */
  inProgressOrDone: number;
  /** items that finished successfully. */
  ok: number;
  /** items that finished with a captured (non-fatal) error. */
  failed: number;
  /** the item this event is about. */
  item: I;
  /** lifecycle phase. */
  phase: 'started' | 'ok' | 'failed';
  /** worker that handled this item. */
  workerId: number;
  /** captured error for phase='failed'; undefined otherwise. */
  error?: unknown;
}

export type PoolItemResult<I, R> =
  | { item: I; ok: true;  result: R; workerId: number }
  | { item: I; ok: false; error: unknown; workerId: number };

/**
 * Thrown when the underlying browser / context dies mid-run. Caller
 * (e.g. `runInitPinned`) catches this to abort retry passes — the pages
 * are gone and the surviving workers exit voluntarily.
 */
export class BrowserDeadError extends Error {
  public readonly deadCause: string;
  constructor(cause: string) {
    super(`Browser/context died mid-run: ${cause}`);
    this.name = 'BrowserDeadError';
    this.deadCause = cause;
  }
}

function isBrowserDeadMessage(msg: string | undefined): boolean {
  if (!msg) return false;
  return /(?:browser|context|target page).*(?:closed|crashed|disconnected)/i.test(msg)
      || /Target closed/i.test(msg);
}

/**
 * Drive `items` through `concurrency` workers. Each worker owns one page;
 * `worker(item, ctx)` runs synchronously per worker but pages run in parallel.
 *
 * @param onProgress optional, called once per `started` / `ok` / `failed`
 *   transition. Called from inside the worker before the next item is pulled,
 *   so the callback should NOT block.
 */
export async function runWithPagePool<I, R>(
  deps: PoolDeps,
  items: I[],
  concurrency: number,
  worker: (item: I, ctx: WorkerCtx) => Promise<R>,
  onProgress?: (event: PoolProgressEvent<I>) => void,
): Promise<PoolItemResult<I, R>[]> {
  const results: PoolItemResult<I, R>[] = new Array(items.length);
  let nextIdx = 0;
  let okCount = 0;
  let failedCount = 0;
  const total = items.length;
  let browserDeadCause: string | null = null;

  if (total === 0) return results;

  const runWorker = async (workerId: number, page: Page): Promise<void> => {
    while (true) {
      if (browserDeadCause) return;
      const idx = nextIdx++;
      if (idx >= total) return;
      const item = items[idx]!;
      onProgress?.({
        total, inProgressOrDone: okCount + failedCount + 1,
        ok: okCount, failed: failedCount,
        item, phase: 'started', workerId,
      });
      try {
        const result = await worker(item, { workerId, page });
        results[idx] = { item, ok: true, result, workerId };
        okCount++;
        onProgress?.({
          total, inProgressOrDone: okCount + failedCount,
          ok: okCount, failed: failedCount,
          item, phase: 'ok', workerId,
        });
      } catch (e) {
        const msg = (e as Error)?.message;
        if (isBrowserDeadMessage(msg)) {
          if (!browserDeadCause) browserDeadCause = msg ?? 'unknown';
          // Don't record as item failure — surfaced as run-level error.
          return;
        }
        results[idx] = { item, ok: false, error: e, workerId };
        failedCount++;
        onProgress?.({
          total, inProgressOrDone: okCount + failedCount,
          ok: okCount, failed: failedCount,
          item, phase: 'failed', workerId, error: e,
        });
      }
    }
  };

  const pages: Page[] = [];
  try {
    const N = Math.max(1, Math.min(concurrency, total));
    for (let k = 0; k < N; k++) {
      const page = await deps.context.newPage();
      await deps.ensureLoggedIn(page);
      pages.push(page);
    }
    await Promise.all(pages.map((p, i) => runWorker(i + 1, p)));
  } finally {
    for (const p of pages) await p.close().catch(() => {});
  }

  if (browserDeadCause) {
    throw new BrowserDeadError(browserDeadCause);
  }

  return results;
}
