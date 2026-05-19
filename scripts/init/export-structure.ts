/**
 * Export forum structure to JSON file.
 *
 * Usage:
 *   npx tsx scripts/init/export-structure.ts [siteKey] [outputPath]
 *
 * Defaults to siteKey="school-bbs" and outputPath="./data/forum-structure.json".
 */
import 'dotenv/config';
import '../../src/adapters/index';
import * as path from 'path';
import { parseConfig } from '../../src/core/config';
import { initDb, closeAllDbs } from '../../src/repository/db';
import { exportForumStructure } from '../../src/export/exporter';
import { logger } from '../../src/util/logger';

async function main() {
  const siteKey = process.argv[2] ?? 'school-bbs';
  const outputPath = process.argv[3] ?? path.join(process.cwd(), 'data', 'forum-structure.json');

  const cfg = parseConfig(process.env);
  initDb({ dataDir: cfg.dataDir });

  try {
    await exportForumStructure(siteKey, outputPath);
    logger.info({ siteKey, outputPath }, `论坛结构已导出至 ${outputPath}`);
  } finally {
    await closeAllDbs();
  }
}

main().catch((err) => {
  console.error('export-structure failed:', err);
  process.exit(1);
});
