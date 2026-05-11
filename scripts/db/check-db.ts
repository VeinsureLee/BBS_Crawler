/**
 * Quick health-check for the SQLite databases.
 *
 * Usage:
 *   npx tsx scripts/db/check-db.ts
 *
 * Reports which migrations have been applied and the row count of every
 * known table. Creates the data dir on first run if missing.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { initDbs, closeDbs, getStructureDb, getContentDb } from '../../src/repository/db';
import type { Db } from '../../src/repository/db';

const STRUCTURE_TABLES = [
  'sites',
  'sections',
  'boards',
  'board_crawl_state',
  'migrations',
] as const;

const CONTENT_TABLES = [
  'threads',
  'posts',
  'fetch_log',
  'migrations',
] as const;

async function checkDb(label: string, db: Db, tables: readonly string[]): Promise<void> {
  console.log(`\n=== ${label} ===`);

  // Get existing tables from SQLite master
  const existing = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
     ORDER BY name`,
  );
  const present = new Set(existing.rows.map((r) => r.name));

  console.log('\nTables:');
  for (const name of tables) {
    if (!present.has(name)) {
      console.log(`  ${name.padEnd(20)} (missing)`);
      continue;
    }
    const r = await db.query<{ c: number }>(`SELECT count(*) as c FROM ${name}`);
    console.log(`  ${name.padEnd(20)} ${r.rows[0]!.c} rows`);
  }

  if (present.has('migrations')) {
    const r = await db.query<{ name: string; applied_at: string }>(
      `SELECT name, applied_at FROM migrations ORDER BY id`,
    );
    console.log('\nMigrations applied:');
    for (const row of r.rows) console.log(`  ${row.name}`);
  }
}

async function main(): Promise<void> {
  const dataDir = process.env.DATABASE_PATH ?? './data';
  console.log(`SQLite data dir: ${dataDir}`);

  // Ensure data dir exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  initDbs({ dataDir });

  try {
    await checkDb('structure.db', getStructureDb(), STRUCTURE_TABLES);
    await checkDb('content.db', getContentDb(), CONTENT_TABLES);
  } finally {
    await closeDbs();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
