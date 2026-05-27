/**
 * Init step 2: crawl boards and sub-sections (any depth) for all top-level sections.
 *
 * Thin wrapper over `createCrawler().runInitBoards()`.
 * All recursive init logic lives in src/service/init-runners.ts.
 *
 * Usage:
 *   npx tsx scripts/init/init-boards.ts [siteKey]
 *
 * Defaults to siteKey="school-bbs". Requires:
 *   - Top-level sections already populated by scripts/init-sections.ts
 *   - .state/<siteKey>.json from scripts/do-login.ts
 */
process.env.LOG_STDOUT_DISABLED = process.env.LOG_STDOUT_DISABLED ?? 'false';
async function main() {
  const { createCrawler } = await import('../../src/service/factory.js');
  const { logger } = await import('../../src/util/logger.js');
  const siteKey = process.argv[2] ?? 'school-bbs';
  const crawler = await createCrawler({ siteKey });
  try {
    await crawler.runInitBoards();
    logger.info({ siteKey }, 'init-boards: 完成');
  } finally {
    await crawler.shutdown();
  }
}
main().catch((err) => { console.error('init-boards failed:', err); process.exit(1); });
