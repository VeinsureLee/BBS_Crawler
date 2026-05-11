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
import { initDbs, closeDbs } from '../../src/repository/db';
import { exportForumStructure } from '../../src/export/exporter';

async function main() {
  const siteKey = process.argv[2] ?? 'school-bbs';
  const outputPath = process.argv[3] ?? path.join(process.cwd(), 'data', 'forum-structure.json');

  const cfg = parseConfig(process.env);
  initDbs({ dataDir: cfg.dataDir });

  try {
    await exportForumStructure(siteKey, outputPath);
    console.log(`Forum structure exported to ${outputPath}`);
  } finally {
    await closeDbs();
  }
}

main().catch((err) => {
  console.error('export-structure failed:', err);
  process.exit(1);
});
