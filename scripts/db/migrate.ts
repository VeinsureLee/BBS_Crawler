/**
 * Custom SQL migration runner for SQLite.
 *
 * Applies migrations to both structure.db and content.db.
 *
 * Usage:
 *   npx tsx scripts/db/migrate.ts up      # apply all pending
 *   npx tsx scripts/db/migrate.ts down    # roll back the most recent migration
 *   npx tsx scripts/db/migrate.ts status  # show applied / pending
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { initDbs, closeDbs, getStructureDb, getContentDb } from '../../src/repository/db';
import type { Db } from '../../src/repository/db';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

interface MigrationFile {
  name: string;
  filePath: string;
  upSql: string;
  downSql: string;
}

function readMigrations(pattern?: RegExp): MigrationFile[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => pattern === undefined || pattern.test(f))
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

async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id     TEXT PRIMARY KEY,
      name   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

async function getApplied(db: Db): Promise<Set<string>> {
  const r = await db.query<{ name: string }>(
    `SELECT name FROM migrations ORDER BY id`,
  );
  return new Set(r.rows.map((row) => row.name));
}

async function applyOne(db: Db, m: MigrationFile): Promise<void> {
  if (!m.upSql) {
    console.log(`  ${m.name}: empty up section, skipping body`);
  } else {
    // exec() handles multi-statement SQL; query() only handles a single statement.
    await db.exec(m.upSql);
  }
  await db.query(`INSERT INTO migrations (id, name) VALUES ($1, $2)`, [m.name, m.name]);
  console.log(`  applied ${m.name}`);
}

async function rollbackOne(db: Db, m: MigrationFile): Promise<void> {
  if (!m.downSql) {
    throw new Error(`Migration ${m.name} has no down section; refusing to roll back`);
  }
  await db.exec(m.downSql);
  await db.query(`DELETE FROM migrations WHERE id = $1`, [m.name]);
  console.log(`  rolled back ${m.name}`);
}

async function up(db: Db, label: string, pattern?: RegExp): Promise<void> {
  console.log(`\n=== ${label} ===`);
  await ensureMigrationsTable(db);
  const applied = await getApplied(db);
  const all = readMigrations(pattern);
  const pending = all.filter((m) => !applied.has(m.name));
  if (pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }
  console.log(`Applying ${pending.length} migration(s):`);
  for (const m of pending) await applyOne(db, m);
}

async function down(db: Db, label: string, pattern?: RegExp): Promise<void> {
  console.log(`\n=== ${label} ===`);
  await ensureMigrationsTable(db);
  const applied = await getApplied(db);
  const all = readMigrations(pattern);
  const lastApplied = [...all].reverse().find((m) => applied.has(m.name));
  if (!lastApplied) {
    console.log('Nothing to roll back.');
    return;
  }
  console.log(`Rolling back ${lastApplied.name}`);
  await rollbackOne(db, lastApplied);
}

async function status(db: Db, label: string, pattern?: RegExp): Promise<void> {
  console.log(`\n=== ${label} ===`);
  await ensureMigrationsTable(db);
  const applied = await getApplied(db);
  const all = readMigrations(pattern);
  console.log('Migration status:');
  for (const m of all) {
    console.log(`  [${applied.has(m.name) ? 'x' : ' '}] ${m.name}`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';
  const dataDir = process.env.DATABASE_PATH ?? './data';
  console.log(`SQLite data dir: ${dataDir}`);

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  initDbs({ dataDir });
  const structureDb = getStructureDb();
  const contentDb = getContentDb();

  try {
    if (cmd === 'up') {
      await up(structureDb, 'structure.db', /structure/);
      await up(contentDb, 'content.db', /content/);
    } else if (cmd === 'down') {
      await down(structureDb, 'structure.db', /structure/);
      await down(contentDb, 'content.db', /content/);
    } else if (cmd === 'status') {
      await status(structureDb, 'structure.db', /structure/);
      await status(contentDb, 'content.db', /content/);
    } else {
      console.error(`Unknown command: ${cmd}. Use up | down | status.`);
      process.exit(1);
    }
  } finally {
    await closeDbs();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
