/**
 * Init step 1: crawl top-level sections from a site's homepage and persist
 * them into the `sections` table.
 *
 * Usage:
 *   npx tsx scripts/init-sections.ts [siteKey]
 *
 * Defaults to siteKey="school-bbs". Requires .state/<siteKey>.json produced
 * by scripts/do-login.ts.
 */
import 'dotenv/config';
import '../../src/adapters/index';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import { parseConfig } from '../../src/core/config';
import { initDb, closeDb } from '../../src/repository/db';
import { getAdapter } from '../../src/core/registry';
import { upsertSite } from '../../src/repository/sites';
import { upsertSection } from '../../src/repository/sections';

async function main() {
  const siteKey = process.argv[2] ?? 'school-bbs';
  const cfg = parseConfig(process.env);
  initDb(cfg.dataDir);

  const adapter = getAdapter(siteKey);
  if (!adapter.listSections) {
    throw new Error(`Adapter "${siteKey}" does not implement listSections`);
  }

  await upsertSite({
    siteKey: adapter.siteKey,
    displayName: adapter.displayName,
    baseUrl: adapter.baseUrl,
  });

  const statePath = path.join(cfg.storageStateDir, `${siteKey}.json`);
  if (!fs.existsSync(statePath)) {
    throw new Error(
      `Storage state not found at ${statePath}. Run "tsx scripts/do-login.ts" first.`,
    );
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

  try {
    const sections = await adapter.listSections(page);
    console.log(`Found ${sections.length} sections:`);
    for (const s of sections) {
      const { sectionId } = await upsertSection({
        siteKey,
        sectionKey: s.sectionKey,
        name: s.name,
      });
      console.log(`  [${sectionId}] ${s.sectionKey}  ${s.name}  ${s.url}`);
    }
    console.log(`Persisted ${sections.length} sections to SQLite at ${cfg.dataDir}`);
  } finally {
    await ctx.close();
    await browser.close();
    await closeDb();
  }
}

main().catch((err) => {
  console.error('init-sections failed:', err);
  process.exit(1);
});
