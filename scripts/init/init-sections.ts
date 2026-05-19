/**
 * Init step 1: persist top-level sections.
 *
 * Source priority:
 *   1. config/sites/<siteKey>.entries.yml (preferred; no browser needed)
 *   2. crawl the homepage via adapter.listSections (legacy fallback)
 *
 * Usage:
 *   npx tsx scripts/init/init-sections.ts [siteKey]
 *
 * Logs are written to stdout (pino JSON) + .logs/app/app-<date>.log.
 */
import 'dotenv/config';
import '../../src/adapters/index';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import { parseConfig } from '../../src/core/config';
import { loadSiteEntries, validateConfigConsistency } from '../../src/core/site-config';
import { initDb, closeAllDbs } from '../../src/repository/db';
import { getAdapter } from '../../src/core/registry';
import { upsertSite } from '../../src/repository/sites';
import { upsertSection } from '../../src/repository/sections';
import { logger } from '../../src/util/logger';

async function main() {
  const siteKey = process.argv[2] ?? 'school-bbs';
  const startedAt = Date.now();
  logger.info({ siteKey, script: 'init-sections' }, 'init-sections: 开始');

  const cfg = parseConfig(process.env);
  initDb({ dataDir: cfg.dataDir });

  const adapter = getAdapter(siteKey);

  await upsertSite({
    siteKey: adapter.siteKey,
    displayName: adapter.displayName,
    baseUrl: adapter.baseUrl,
  });

  // Path 1: config-driven (preferred). No browser needed.
  validateConfigConsistency(siteKey);
  const entries = loadSiteEntries(siteKey);
  if (entries && entries.forums.length > 0) {
    logger.info(
      { siteKey, count: entries.forums.length, source: 'entries.yml' },
      `使用 entries.yml 配置（${entries.forums.length} 个讨论区）`,
    );
    for (const f of entries.forums) {
      const { sectionId } = await upsertSection({
        siteKey,
        sectionKey: f.sectionKey,
        name: f.name,
      });
      logger.info({ sectionId, sectionKey: f.sectionKey, name: f.name }, '讨论区落库');
    }
    logger.info(
      { siteKey, persisted: entries.forums.length, dataDir: cfg.dataDir, elapsedMs: Date.now() - startedAt },
      'init-sections: 完成（来源：entries.yml）',
    );
    await closeAllDbs();
    return;
  }

  // Path 2: legacy fallback — crawl the homepage.
  logger.warn(
    { siteKey, source: 'adapter.listSections' },
    'entries.yml 缺失或为空，回退到爬首页路径',
  );
  if (!adapter.listSections) {
    logger.error({ siteKey }, `adapter "${siteKey}" 未实现 listSections，且 entries.yml 缺失`);
    await closeAllDbs();
    throw new Error(`Adapter "${siteKey}" does not implement listSections`);
  }

  const statePath = path.join(cfg.storageStateDir, `${siteKey}.json`);
  if (!fs.existsSync(statePath)) {
    logger.error({ statePath }, '会话状态文件不存在，请先运行 `npm run login`');
    await closeAllDbs();
    throw new Error(`Storage state not found at ${statePath}. Run "npm run login" first.`);
  }

  logger.info({ headless: cfg.browserHeadless }, '启动浏览器，加载会话状态');
  const browser = await chromium.launch({
    headless: cfg.browserHeadless,
    ...(cfg.browserExecutablePath ? { executablePath: cfg.browserExecutablePath } : {}),
  });
  const ctx = await browser.newContext({
    storageState: statePath,
    ...(cfg.browserUserAgent ? { userAgent: cfg.browserUserAgent } : {}),
  });
  const page = await ctx.newPage();

  let persistedCount = 0;
  try {
    logger.info({ siteKey }, '抓取讨论区清单');
    const sections = await adapter.listSections(page);
    logger.info({ count: sections.length }, `发现 ${sections.length} 个讨论区`);
    for (const s of sections) {
      const { sectionId } = await upsertSection({
        siteKey,
        sectionKey: s.sectionKey,
        name: s.name,
      });
      logger.info({ sectionId, sectionKey: s.sectionKey, name: s.name }, '讨论区落库');
      persistedCount++;
    }
    logger.info(
      { siteKey, persisted: persistedCount, dataDir: cfg.dataDir, elapsedMs: Date.now() - startedAt },
      'init-sections: 完成（来源：adapter 爬首页）',
    );
  } catch (e) {
    logger.error({ err: String(e), siteKey }, 'init-sections 失败');
    throw e;
  } finally {
    await ctx.close();
    await browser.close();
    await closeAllDbs();
  }
}

main().catch((err) => {
  console.error('init-sections failed:', err);
  process.exit(1);
});
