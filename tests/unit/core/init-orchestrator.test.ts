import { describe, it, expect, vi } from 'vitest';
import { InitOrchestrator, type InitOrchestratorDeps } from '../../../src/core/init-orchestrator';

const fakePage = { close: async () => {} } as never;

function makeDeps(state: {
  hasSections: boolean;
  sectionsMissingBoards?: Array<{ id: number; sectionKey: string; name: string | null }>;
  boardsMissingPinned?: Array<{ id: number; boardKey: string; name: string | null }>;
  /** If provided, runInitBoards "creates" pinned-missing boards on subsequent reads. */
  boardsMissingPinnedAfterRunInitBoards?: Array<{ id: number; boardKey: string; name: string | null }>;
}) {
  let pinnedQueryCount = 0;
  return {
    hasSections: vi.fn(async () => state.hasSections),
    sectionsMissingBoards: vi.fn(async () => state.sectionsMissingBoards ?? []),
    boardsMissingPinned: vi.fn(async () => {
      pinnedQueryCount++;
      if (pinnedQueryCount === 1 || !state.boardsMissingPinnedAfterRunInitBoards) {
        return state.boardsMissingPinned ?? [];
      }
      return state.boardsMissingPinnedAfterRunInitBoards;
    }),
    runWithPage: vi.fn(async <T,>(_siteKey: string, fn: (p: typeof fakePage) => Promise<T>) => fn(fakePage)),
    runInitSections: vi.fn(async () => {}),
    runInitBoards: vi.fn(async () => {}),
    runInitPinned: vi.fn(async () => {}),
  };
}

describe('InitOrchestrator.ensureInitialized', () => {
  it('runs full init when sections table is empty', async () => {
    const deps = makeDeps({
      hasSections: false,
      boardsMissingPinned: [{ id: 1, boardKey: 'B', name: 'B' }],
    });
    const orch = new InitOrchestrator(deps as unknown as InitOrchestratorDeps);
    await orch.ensureInitialized('school-bbs');
    expect(deps.runInitSections).toHaveBeenCalledTimes(1);
    expect(deps.runInitBoards).toHaveBeenCalledTimes(1);
    expect(deps.runInitBoards).toHaveBeenCalledWith(fakePage, 'school-bbs');
    expect(deps.runInitPinned).toHaveBeenCalledTimes(1);
  });

  it('does nothing when sections, boards, and pinned are all present', async () => {
    const deps = makeDeps({ hasSections: true });
    const orch = new InitOrchestrator(deps as unknown as InitOrchestratorDeps);
    await orch.ensureInitialized('school-bbs');
    expect(deps.runInitSections).not.toHaveBeenCalled();
    expect(deps.runInitBoards).not.toHaveBeenCalled();
    expect(deps.runInitPinned).not.toHaveBeenCalled();
    expect(deps.runWithPage).not.toHaveBeenCalled();
  });

  it('only runs board init when sections are missing boards but pinned are complete', async () => {
    const deps = makeDeps({
      hasSections: true,
      sectionsMissingBoards: [{ id: 5, sectionKey: 'S5', name: 'S5' }],
    });
    // After runInitBoards creates boards, we need to re-check pinned. Have it
    // come back empty so no pinned init runs.
    const orch = new InitOrchestrator(deps as unknown as InitOrchestratorDeps);
    await orch.ensureInitialized('school-bbs');
    expect(deps.runInitSections).not.toHaveBeenCalled();
    expect(deps.runInitBoards).toHaveBeenCalledWith(
      fakePage, 'school-bbs',
      { sections: [{ id: 5, sectionKey: 'S5', name: 'S5' }] },
    );
    expect(deps.runInitPinned).not.toHaveBeenCalled();
  });

  it('only runs pinned init when boards complete but pinned missing for some', async () => {
    const deps = makeDeps({
      hasSections: true,
      boardsMissingPinned: [{ id: 9, boardKey: 'BP', name: 'BP' }],
    });
    const orch = new InitOrchestrator(deps as unknown as InitOrchestratorDeps);
    await orch.ensureInitialized('school-bbs');
    expect(deps.runInitSections).not.toHaveBeenCalled();
    expect(deps.runInitBoards).not.toHaveBeenCalled();
    expect(deps.runInitPinned).toHaveBeenCalledWith(
      fakePage, 'school-bbs', [{ id: 9, boardKey: 'BP', name: 'BP' }],
    );
  });

  it('after running boards, re-queries pinned-missing for newly created boards', async () => {
    const deps = makeDeps({
      hasSections: true,
      sectionsMissingBoards: [{ id: 5, sectionKey: 'S5', name: 'S5' }],
      boardsMissingPinned: [],
      boardsMissingPinnedAfterRunInitBoards: [
        { id: 100, boardKey: 'NEW', name: 'NEW' },
      ],
    });
    const orch = new InitOrchestrator(deps as unknown as InitOrchestratorDeps);
    await orch.ensureInitialized('school-bbs');
    expect(deps.runInitBoards).toHaveBeenCalledTimes(1);
    expect(deps.runInitPinned).toHaveBeenCalledWith(
      fakePage, 'school-bbs', [{ id: 100, boardKey: 'NEW', name: 'NEW' }],
    );
  });

  it('caches success: subsequent calls do nothing', async () => {
    const deps = makeDeps({ hasSections: false, boardsMissingPinned: [] });
    const orch = new InitOrchestrator(deps as unknown as InitOrchestratorDeps);
    await orch.ensureInitialized('school-bbs');
    await orch.ensureInitialized('school-bbs');
    await orch.ensureInitialized('school-bbs');
    expect(deps.runInitSections).toHaveBeenCalledTimes(1);
    expect(deps.hasSections).toHaveBeenCalledTimes(1);
  });

  it('reset(siteKey) makes the next call detect again', async () => {
    const deps = makeDeps({ hasSections: true });
    const orch = new InitOrchestrator(deps as unknown as InitOrchestratorDeps);
    await orch.ensureInitialized('school-bbs');
    orch.reset('school-bbs');
    await orch.ensureInitialized('school-bbs');
    expect(deps.hasSections).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent calls — only one init runs at a time', async () => {
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => { resolveGate = r; });

    const deps = makeDeps({ hasSections: false, boardsMissingPinned: [] });
    deps.runInitSections.mockImplementationOnce(async () => { await gate; });

    const orch = new InitOrchestrator(deps as unknown as InitOrchestratorDeps);
    const a = orch.ensureInitialized('school-bbs');
    const b = orch.ensureInitialized('school-bbs');
    const c = orch.ensureInitialized('school-bbs');

    resolveGate();
    await Promise.all([a, b, c]);

    expect(deps.runInitSections).toHaveBeenCalledTimes(1);
    expect(deps.runInitBoards).toHaveBeenCalledTimes(1);
  });

  it('failed init is not cached: next call retries', async () => {
    const deps = makeDeps({ hasSections: false, boardsMissingPinned: [] });
    deps.runInitSections.mockRejectedValueOnce(new Error('boom'));

    const orch = new InitOrchestrator(deps as unknown as InitOrchestratorDeps);
    await expect(orch.ensureInitialized('school-bbs')).rejects.toThrow('boom');
    // Recover on second attempt.
    await orch.ensureInitialized('school-bbs');
    expect(deps.runInitSections).toHaveBeenCalledTimes(2);
  });

  it('per-siteKey isolation — siteA running does not block siteB', async () => {
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((r) => { releaseA = r; });

    const deps = makeDeps({ hasSections: false, boardsMissingPinned: [] });
    (deps.runInitSections as unknown as { mockImplementation: (fn: (...args: unknown[]) => Promise<void>) => void })
      .mockImplementation(async (_p: unknown, siteKey: unknown) => {
        if (siteKey === 'a') await aGate;
      });

    const orch = new InitOrchestrator(deps as unknown as InitOrchestratorDeps);
    const a = orch.ensureInitialized('a');
    const b = orch.ensureInitialized('b');
    await b;     // b finishes without waiting for a
    expect(deps.runInitSections).toHaveBeenCalledWith(fakePage, 'b');
    releaseA();
    await a;
  });
});
