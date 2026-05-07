/**
 * Quick health-check for the embedded PGlite database.
 *
 * Usage:
 *   npx tsx scripts/check-db.ts
 *
 * Reports which migrations have been applied and the row count of every
 * known table. Creates the data dir on first run if missing.
 */
import 'dotenv/config';
import { initDb, closeDb } from '../src/repository/db';

const TABLES = [
  'sites',
  'sections',
  'boards',
  'threads',
  'posts',
  'fetch_log',
  'pgmigrations',
] as const;

async function main() {
  const dataDir = process.env.PGDATA_DIR ?? './.pgdata';
  console.log(`PGlite data dir: ${dataDir}`);

  const db = initDb(dataDir);

  const existing = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
     ORDER BY table_name`,
  );
  const present = new Set(existing.rows.map((r) => r.table_name));

  console.log('\nTables:');
  for (const name of TABLES) {
    if (!present.has(name)) {
      console.log(`  ${name.padEnd(15)} (missing)`);
      continue;
    }
    const r = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM ${name}`);
    console.log(`  ${name.padEnd(15)} ${r.rows[0]!.c} rows`);
  }

  if (present.has('pgmigrations')) {
    const r = await db.query<{ name: string; run_on: string }>(
      `SELECT name, run_on FROM pgmigrations ORDER BY id`,
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
