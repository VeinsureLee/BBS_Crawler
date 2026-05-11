/**
 * Quick health-check for the SQLite database.
 *
 * Usage:
 *   npx tsx scripts/check-db.ts
 *
 * Reports which migrations have been applied and the row count of every
 * known table. Creates the data dir on first run if missing.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { initDb, closeDb } from '../../src/repository/db';

const TABLES = [
  'sites',
  'sections',
  'boards',
  'threads',
  'posts',
  'fetch_log',
  'board_crawl_state',
  'migrations',
] as const;

async function main(): Promise<void> {
  const dataDir = process.env.DATABASE_PATH ?? './.data';
  console.log(`SQLite data dir: ${dataDir}`);

  // Ensure data dir exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = initDb(dataDir);

  // Get existing tables from SQLite master
  const existing = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
     ORDER BY name`,
  );
  const present = new Set(existing.rows.map((r) => r.name));

  console.log('\nTables:');
  for (const name of TABLES) {
    if (!present.has(name)) {
      console.log(`  ${name.padEnd(20)} (missing)`);
      continue;
    }
    const r = await db.query<{ c: number }>(`SELECT count(*) as c FROM ${name}`);
    console.log(`  ${name.padEnd(20)} ${r.rows[0]!.c} rows`);
  }

  if (present.has('migrations')) {
    const r = await db.query<{ name: string; run_on: string }>(
      `SELECT name, run_on FROM migrations ORDER BY id`,
    );
    console.log('\nMigrations applied:');
    for (const row of r.rows) console.log(`  ${row.name}`);
  }

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
