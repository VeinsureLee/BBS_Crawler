/**
 * Lazy, idempotent, mutex-protected init for an MCP siteKey.
 *
 * Called by CrawlerService at the top of every tool invocation. Detects the
 * DB state in three tiers:
 *   - sections empty           → full init (sections + boards + pinned)
 *   - some sections missing boards or some boards missing pinned → only fix gaps
 *   - everything present       → no-op (cached)
 *
 * Concurrency: a per-siteKey inflight Promise dedupes overlapping callers.
 * Once an init succeeds, future calls hit the `done` set and return immediately.
 */
import type { SectionRow } from '../repository/sections';
import type { BoardRow } from '../repository/boards';

export interface InitOrchestratorDeps {
  hasSections: (siteKey: string) => Promise<boolean>;
  sectionsMissingBoards: (siteKey: string) => Promise<SectionRow[]>;
  boardsMissingPinned: (siteKey: string) => Promise<BoardRow[]>;
  /** Acquires a logged-in page, runs `fn`, releases everything on the way out. */
  runWithPage: <T>(siteKey: string, fn: (page: import('playwright').Page) => Promise<T>) => Promise<T>;
  runInitSections: (page: import('playwright').Page, siteKey: string) => Promise<void>;
  runInitBoards: (
    page: import('playwright').Page,
    siteKey: string,
    opts?: { sections?: SectionRow[] },
  ) => Promise<void>;
  runInitPinned: (
    page: import('playwright').Page,
    siteKey: string,
    boards: BoardRow[],
  ) => Promise<void>;
}

export class InitOrchestrator {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly done = new Set<string>();

  constructor(private readonly deps: InitOrchestratorDeps) {}

  async ensureInitialized(siteKey: string): Promise<void> {
    if (this.done.has(siteKey)) return;
    const existing = this.inflight.get(siteKey);
    if (existing) return existing;

    const p = this.runOnce(siteKey)
      .then(() => { this.done.add(siteKey); })
      .finally(() => { this.inflight.delete(siteKey); });
    this.inflight.set(siteKey, p);
    return p;
  }

  /** Test/admin hook to force a re-run on next call. */
  reset(siteKey?: string): void {
    if (siteKey) this.done.delete(siteKey);
    else this.done.clear();
  }

  private async runOnce(siteKey: string): Promise<void> {
    const sectionsExist = await this.deps.hasSections(siteKey);
    if (!sectionsExist) {
      await this.deps.runWithPage(siteKey, async (page) => {
        await this.deps.runInitSections(page, siteKey);
        await this.deps.runInitBoards(page, siteKey);
        const boards = await this.deps.boardsMissingPinned(siteKey);
        if (boards.length > 0) await this.deps.runInitPinned(page, siteKey, boards);
      });
      return;
    }

    const missingBoards = await this.deps.sectionsMissingBoards(siteKey);
    const initialMissingPinned = await this.deps.boardsMissingPinned(siteKey);
    if (missingBoards.length === 0 && initialMissingPinned.length === 0) return;

    await this.deps.runWithPage(siteKey, async (page) => {
      if (missingBoards.length > 0) {
        await this.deps.runInitBoards(page, siteKey, { sections: missingBoards });
      }
      // If runInitBoards just ran, re-query — new boards may have appeared.
      // Otherwise reuse the value we already fetched.
      const pinnedToRun = missingBoards.length > 0
        ? await this.deps.boardsMissingPinned(siteKey)
        : initialMissingPinned;
      if (pinnedToRun.length > 0) {
        await this.deps.runInitPinned(page, siteKey, pinnedToRun);
      }
    });
  }
}
