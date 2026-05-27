/**
 * Init step 1: persist top-level sections.
 *
 * Thin wrapper over `createCrawler().runInitSections()`.
 * All init logic lives in src/service/init-runners.ts.
 *
 * Usage:
 *   npx tsx scripts/init/init-sections.ts [siteKey]
 *
 * Defaults to siteKey="school-bbs".
 */
process.env.LOG_STDOUT_DISABLED = process.env.LOG_STDOUT_DISABLED ?? 'false';
async function main() {
  const { createCrawler } = await import('../../src/service/factory.js');
  const { logger } = await import('../../src/util/logger.js');
  const siteKey = process.argv[2] ?? 'school-bbs';
  const crawler = await createCrawler({ siteKey });
  try {
    await crawler.runInitSections();
    logger.info({ siteKey }, 'init-sections: 完成');
  } finally {
    await crawler.shutdown();
  }
}
main().catch((err) => { console.error('init-sections failed:', err); process.exit(1); });
