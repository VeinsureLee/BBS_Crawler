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
import { logger } from '../../src/util/logger';

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
  visited: Set<string> = new Set(),
): Promise<{ boards: number; subSections: number }> {
  const indent = '  '.repeat(depth);
  if (visited.has(parentSectionKey)) {
    logger.warn({ parentSectionKey, depth }, `${indent}已访问过 ${parentSectionKey}，跳过避免环`);
    return { boards: 0, subSections: 0 };
  }
  visited.add(parentSectionKey);

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
    // school-bbs's section pages tend to list the current section among its
    // own subSections (sidebar nav). Skip that self-reference.
    if (sub.sectionKey === parentSectionKey) {
      logger.warn(
        { parentSectionKey, depth },
        `${indent}listSectionChildren 把 ${parentSectionKey} 列为自己的子节点，跳过`,
      );
      continue;
    }
    const { sectionId } = await upsertSection({
      siteKey,
      sectionKey: sub.sectionKey,
      name: sub.name,
      parentSectionId,
    });
    subCount++;
    logger.info(
      { depth, sectionId, sectionKey: sub.sectionKey, name: sub.name },
      `${indent}子讨论区 ${sub.sectionKey}  ${sub.name}`,
    );

    await sleep(requestIntervalMs);
    const childResult = await crawlSectionRecursive(
      page, adapter, siteKey, sectionId, sub.sectionKey, requestIntervalMs, depth + 1, visited,
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
    ...(cfg.browserExecutablePath ? { executablePath: cfg.browserExecutablePath } : {}),
  });
  const ctx = await browser.newContext({
    storageState: statePath,
    ...(cfg.browserUserAgent ? { userAgent: cfg.browserUserAgent } : {}),
  });
  const page = await ctx.newPage();

  let totalBoards = 0;
  let totalSubs = 0;
  const startedAt = Date.now();
  logger.info({ siteKey, sections: sections.length, script: 'init-boards' }, 'init-boards: 开始');
  try {
    for (const sec of sections) {
      logger.info(
        { sectionId: sec.id, sectionKey: sec.sectionKey, name: sec.name ?? '' },
        `处理顶级讨论区 ${sec.sectionKey}`,
      );
      const { boards, subSections } = await crawlSectionRecursive(
        page,
        adapter,
        siteKey,
        sec.id,
        sec.sectionKey,
        requestIntervalMs,
        1,
      );
      logger.info(
        { sectionKey: sec.sectionKey, boards, subSections },
        `分支汇总：${boards} 个版面、${subSections} 个子讨论区`,
      );
      totalBoards += boards;
      totalSubs += subSections;
      await sleep(requestIntervalMs);
    }
    logger.info(
      {
        siteKey,
        sections: sections.length,
        totalSubSections: totalSubs,
        totalBoards,
        elapsedMs: Date.now() - startedAt,
      },
      `init-boards: 完成（${sections.length} 顶级讨论区、${totalSubs} 子讨论区、${totalBoards} 版面入库）`,
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
