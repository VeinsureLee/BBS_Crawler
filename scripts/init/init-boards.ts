/**
 * Init step 2: for every top-level section already in DB, crawl its page to
 * discover sub-sections (any depth) and boards recursively.
 *
 * Usage:
 *   npx tsx scripts/init/init-boards.ts [siteKey]
 *
 * Defaults to siteKey="school-bbs". Requires:
 *   - Top-level sections already populated by scripts/init-sections.ts
 *   - .state/<siteKey>.json from scripts/do-login.ts
 */
import 'dotenv/config';
import '../../src/adapters/index';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Page } from 'playwright';
import { parseConfig } from '../../src/core/config';
import { loadSiteConfig } from '../../src/core/site-config';
import { initDbs, closeDbs } from '../../src/repository/db';
import { getAdapter } from '../../src/core/registry';
import { listTopLevelSections, upsertSection } from '../../src/repository/sections';
import { upsertBoard } from '../../src/repository/boards';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function crawlSectionRecursive(
  page: Page,
  adapter: ReturnType<typeof getAdapter>,
  siteKey: string,
  parentSectionId: number,
  parentSectionKey: string,
  requestIntervalMs: number,
  depth: number = 0,
): Promise<{ boards: number; subSections: number }> {
  const indent = '  '.repeat(depth);
  const children = await adapter.listSectionChildren!(page, parentSectionKey);
  let boardCount = 0;
  let subCount = 0;

  for (const b of children.boards) {
    await upsertBoard({
      siteKey,
      boardKey: b.boardKey,
      name: b.name,
      sectionId: parentSectionId,
      moderators: b.moderators,
      stats: b.stats,
    });
    boardCount++;
  }

  for (const sub of children.subSections) {
    const { sectionId } = await upsertSection({
      siteKey,
      sectionKey: sub.sectionKey,
      name: sub.name,
      parentSectionId,
    });
    subCount++;
    console.log(`${indent}[sub] ${sub.sectionKey}  ${sub.name}  -> id=${sectionId}`);

    await sleep(requestIntervalMs);
    const childResult = await crawlSectionRecursive(
      page, adapter, siteKey, sectionId, sub.sectionKey, requestIntervalMs, depth + 1
    );
    boardCount += childResult.boards;
    subCount += childResult.subSections;
  }

  return { boards: boardCount, subSections: subCount };
}

async function main() {
  const siteKey = process.argv[2] ?? 'school-bbs';
  const cfg = parseConfig(process.env);
  const siteConfig = loadSiteConfig(siteKey);
  initDbs({ dataDir: cfg.dataDir });

  const requestIntervalMs = siteConfig.crawl.structureRequestIntervalMs;

  const adapter = getAdapter(siteKey);
  if (!adapter.listSectionChildren) {
    throw new Error(`Adapter "${siteKey}" does not implement listSectionChildren`);
  }

  const sections = await listTopLevelSections(siteKey);
  if (sections.length === 0) {
    throw new Error(
      `No top-level sections in DB for ${siteKey}. Run "npm run init:sections" first.`,
    );
  }

  const statePath = path.join(cfg.storageStateDir, `${siteKey}.json`);
  if (!fs.existsSync(statePath)) {
    throw new Error(`Storage state not found at ${statePath}.`);
  }

  const browser = await chromium.launch({
    headless: cfg.browserHeadless,
    executablePath: cfg.browserExecutablePath,
  });
  const ctx = await browser.newContext({
    storageState: statePath,
    userAgent: cfg.browserUserAgent,
  });
  const page = await ctx.newPage();

  let totalBoards = 0;
  let totalSubs = 0;
  try {
    for (const sec of sections) {
      console.log(`Section [${sec.id}] ${sec.sectionKey}  ${sec.name ?? ''}`);
      const { boards, subSections } = await crawlSectionRecursive(
        page,
        adapter,
        siteKey,
        sec.id,
        sec.sectionKey,
        requestIntervalMs,
        1,
      );
      console.log(`  -> ${boards} boards, ${subSections} sub-sections in this branch`);
      totalBoards += boards;
      totalSubs += subSections;
      await sleep(requestIntervalMs);
    }
    console.log(
      `Done. ${sections.length} top-level sections, ${totalSubs} total sub-sections, ${totalBoards} boards persisted.`,
    );
  } finally {
    await ctx.close();
    await browser.close();
    await closeDbs();
  }
}

main().catch((err) => {
  console.error('init-boards failed:', err);
  process.exit(1);
});
