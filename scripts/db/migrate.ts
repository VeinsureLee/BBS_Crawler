/**
 * Custom SQL migration runner for the embedded PGlite database.
 *
 * Replaces node-pg-migrate (which only speaks to a real PG server).
 *
 * Behavior:
 *   - Reads migrations/*.sql in lexical order.
 *   - Each file may contain "-- Up Migration" and "-- Down Migration" markers.
 *     Anything before "-- Down Migration" is the up SQL; anything after is
 *     the down SQL (commented out by convention, executed only with `down`).
 *   - Tracks applied migrations in a `pgmigrations` table (name compatible
 *     with the previous tool, so existing rows survive).
 *
 * Usage:
 *   npx tsx scripts/migrate.ts up      # apply all pending
 *   npx tsx scripts/migrate.ts down    # roll back the most recent migration
 *   npx tsx scripts/migrate.ts status  # show applied / pending
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { initDb, closeDb } from '../../src/repository/db';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

interface MigrationFile {
  name: string;
  filePath: string;
  upSql: string;
  downSql: string;
}

function readMigrations(): MigrationFile[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const filePath = path.join(MIGRATIONS_DIR, f);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const downIdx = raw.indexOf('-- Down Migration');
      const upRaw = downIdx >= 0 ? raw.slice(0, downIdx) : raw;
      const downRaw = downIdx >= 0 ? raw.slice(downIdx) : '';
      return {
        name: f.replace(/\.sql$/, ''),
        filePath,
        upSql: stripUpHeader(upRaw),
        downSql: stripCommentMarkers(downRaw),
      };
    });
}

function stripUpHeader(s: string): string {
  return s.replace(/^\s*--\s*Up Migration\s*\n?/i, '').trim();
}

// Down sections are conventionally commented out (`-- DROP TABLE ...`).
// Strip the leading `-- ` from each line so they become executable.
function stripCommentMarkers(s: string): string {
  const body = s.replace(/^\s*--\s*Down Migration\s*\n?/i, '');
  return body
    .split('\n')
    .map((line) => line.replace(/^\s*--\s?/, ''))
    .join('\n')
    .trim();
}

async function ensureMigrationsTable(db: ReturnType<typeof initDb>) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pgmigrations (
      id     bigserial PRIMARY KEY,
      name   text NOT NULL UNIQUE,
      run_on timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getApplied(db: ReturnType<typeof initDb>): Promise<Set<string>> {
  const r = await db.query<{ name: string }>(
    `SELECT name FROM pgmigrations ORDER BY id`,
  );
  return new Set(r.rows.map((row) => row.name));
}

async function applyOne(db: ReturnType<typeof initDb>, m: MigrationFile) {
  if (!m.upSql) {
    console.log(`  ${m.name}: empty up section, skipping body`);
  } else {
    // exec() handles multi-statement SQL; query() only handles a single statement.
    await db.exec(m.upSql);
  }
  await db.query(`INSERT INTO pgmigrations (name) VALUES ($1)`, [m.name]);
  console.log(`  applied ${m.name}`);
}

async function rollbackOne(db: ReturnType<typeof initDb>, m: MigrationFile) {
  if (!m.downSql) {
    throw new Error(`Migration ${m.name} has no down section; refusing to roll back`);
  }
  await db.exec(m.downSql);
  await db.query(`DELETE FROM pgmigrations WHERE name = $1`, [m.name]);
  console.log(`  rolled back ${m.name}`);
}

async function up(db: ReturnType<typeof initDb>) {
  await ensureMigrationsTable(db);
  const applied = await getApplied(db);
  const all = readMigrations();
  const pending = all.filter((m) => !applied.has(m.name));
  if (pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }
  console.log(`Applying ${pending.length} migration(s):`);
  for (const m of pending) await applyOne(db, m);
}

async function down(db: ReturnType<typeof initDb>) {
  await ensureMigrationsTable(db);
  const applied = await getApplied(db);
  const all = readMigrations();
  const lastApplied = [...all].reverse().find((m) => applied.has(m.name));
  if (!lastApplied) {
    console.log('Nothing to roll back.');
    return;
  }
  console.log(`Rolling back ${lastApplied.name}`);
  await rollbackOne(db, lastApplied);
}

async function status(db: ReturnType<typeof initDb>) {
  await ensureMigrationsTable(db);
  const applied = await getApplied(db);
  const all = readMigrations();
  console.log('Migration status:');
  for (const m of all) {
    console.log(`  [${applied.has(m.name) ? 'x' : ' '}] ${m.name}`);
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'up';
  const dataDir = process.env.PGDATA_DIR ?? './.pgdata';
  console.log(`PGlite data dir: ${dataDir}`);

  const db = initDb(dataDir);
  try {
    if (cmd === 'up') await up(db);
    else if (cmd === 'down') await down(db);
    else if (cmd === 'status') await status(db);
    else {
      console.error(`Unknown command: ${cmd}. Use up | down | status.`);
      process.exit(1);
    }
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
