/**
 * Quick health check for the layered SQLite layout.
 *
 *   structure.db                      sites / nodes / fetch_log
 *   forums/<.../>>/<board>.db         one per board: threads / posts / board_crawl_state / daily_traffic
 *
 * Usage:
 *   npm run db:check                  # default site = school-bbs
 *   npm run db:check -- <siteKey>
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { parseConfig } from '../../src/core/config';
import { initDb, getStructureDb, getBoardDb, closeAllDbs } from '../../src/repository/db';
import type { Db } from '../../src/repository/db';

const STRUCTURE_TABLES = ['sites', 'nodes', 'fetch_log', 'migrations'] as const;
const BOARD_TABLES = ['threads', 'posts', 'board_crawl_state', 'daily_traffic', 'migrations'] as const;

async function dumpTables(label: string, db: Db, tables: readonly string[]): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const existing = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  );
  const present = new Set(existing.rows.map((r) => r.name));
  for (const name of tables) {
    if (!present.has(name)) {
      console.log(`  ${name.padEnd(20)} (missing)`);
      continue;
    }
    const r = await db.query<{ c: number }>(`SELECT count(*) AS c FROM ${name}`);
    console.log(`  ${name.padEnd(20)} ${r.rows[0]!.c} rows`);
  }
}

async function main(): Promise<void> {
  const siteKey = process.argv[2] ?? 'school-bbs';
  const cfg = parseConfig(process.env);
  console.log(`SQLite data dir: ${cfg.dataDir}`);
  console.log(`Site:            ${siteKey}`);

  if (!fs.existsSync(cfg.dataDir)) {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
  }

  initDb({ dataDir: cfg.dataDir });

  try {
    await dumpTables('structure.db', getStructureDb(), STRUCTURE_TABLES);

    const boards = await getStructureDb().query<{
      node_key: string; name: string; db_path: string | null; full_path: string | null;
    }>(
      `SELECT node_key, name, db_path, full_path FROM nodes
        WHERE site_key = $1 AND type = 'board'
        ORDER BY id`,
      [siteKey],
    );

    if (boards.rows.length === 0) {
      console.log('\n(no boards registered yet — run init:sections + init:boards first)');
      return;
    }

    for (const b of boards.rows) {
      if (!b.db_path) {
        console.log(`\n=== board "${b.name}" (${b.node_key}) ===\n  (db_path column is null — broken)`);
        continue;
      }
      const abs = path.join(cfg.dataDir, b.db_path);
      const exists = fs.existsSync(abs);
      console.log(`\n=== board "${b.name}" (${b.full_path ?? b.node_key}) ===`);
      console.log(`  file: ${b.db_path}${exists ? '' : '  (file not yet created)'}`);
      if (!exists) continue;
      const boardDb = getBoardDb(b.db_path);
      await dumpTables(`  tables in ${b.db_path}`, boardDb, BOARD_TABLES);
    }
  } finally {
    await closeAllDbs();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
