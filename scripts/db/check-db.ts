/**
 * Quick health check for the layered SQLite layout.
 *
 *   structure.db        sites / nodes / fetch_log
 *   forums/<key>.db     one per top-level forum: threads / posts / board_crawl_state / daily_traffic
 *
 * Usage:
 *   npm run db:check                  # default site = school-bbs
 *   npm run db:check -- <siteKey>
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { parseConfig } from '../../src/core/config';
import { initDb, getStructureDb, getForumDb, closeAllDbs } from '../../src/repository/db';
import type { Db } from '../../src/repository/db';

const STRUCTURE_TABLES = ['sites', 'nodes', 'fetch_log', 'migrations'] as const;
const FORUM_TABLES = ['threads', 'posts', 'board_crawl_state', 'daily_traffic', 'migrations'] as const;

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

    const forums = await getStructureDb().query<{ node_key: string; name: string; db_file: string | null }>(
      `SELECT node_key, name, db_file FROM nodes
        WHERE site_key = $1 AND type = 'forum'
        ORDER BY id`,
      [siteKey],
    );

    if (forums.rows.length === 0) {
      console.log('\n(no top-level forums registered yet — run init:sections first)');
      return;
    }

    for (const f of forums.rows) {
      if (!f.db_file) {
        console.log(`\n=== forum "${f.name}" (${f.node_key}) ===\n  (db_file column is null — broken)`);
        continue;
      }
      const abs = path.join(cfg.dataDir, f.db_file);
      const exists = fs.existsSync(abs);
      console.log(`\n=== forum "${f.name}" (${f.node_key}) ===`);
      console.log(`  file: ${f.db_file}${exists ? '' : '  (file not yet created)'}`);
      if (!exists) continue;
      const forumDb = getForumDb(f.db_file);
      await dumpTables(`  tables in ${f.db_file}`, forumDb, FORUM_TABLES);
    }
  } finally {
    await closeAllDbs();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
