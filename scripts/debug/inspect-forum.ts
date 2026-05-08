/**
 * Inspect what was crawled into PGlite. Read-only.
 *
 * Usage:
 *   npx tsx scripts/inspect-forum.ts                     # full summary
 *   npx tsx scripts/inspect-forum.ts <sectionKey>        # drill into one section
 *   npx tsx scripts/inspect-forum.ts board <boardKey>    # show one board
 */
import 'dotenv/config';
import { initDb, closeDb, getPool } from '../../src/repository/db';

const SITE = 'school-bbs';

async function summary() {
  const db = getPool();
  const counts = await db.query<{ name: string; n: string }>(`
    SELECT 'sites' AS name, COUNT(*)::text AS n FROM sites
    UNION ALL SELECT 'sections (top)', COUNT(*)::text FROM sections WHERE parent_section_id IS NULL
    UNION ALL SELECT 'sections (sub)', COUNT(*)::text FROM sections WHERE parent_section_id IS NOT NULL
    UNION ALL SELECT 'boards',         COUNT(*)::text FROM boards
    UNION ALL SELECT 'boards (orphan)', COUNT(*)::text FROM boards WHERE section_id IS NULL
    UNION ALL SELECT 'boards (no mods)', COUNT(*)::text FROM boards WHERE moderators IS NULL OR moderators = '[]'::jsonb
    UNION ALL SELECT 'boards (no stats)', COUNT(*)::text FROM boards WHERE stats IS NULL
  `);
  console.log('== Row counts ==');
  for (const r of counts.rows) console.log(`  ${r.name.padEnd(20)} ${r.n}`);

  console.log('\n== Top-level sections + child counts ==');
  const tops = await db.query<{
    section_key: string; name: string; subs: string; boards: string;
  }>(`
    SELECT s.section_key, s.name,
      (SELECT COUNT(*)::text FROM sections c WHERE c.parent_section_id = s.id) AS subs,
      (SELECT COUNT(*)::text FROM boards b
        WHERE b.section_id = s.id
           OR b.section_id IN (SELECT id FROM sections WHERE parent_section_id = s.id)) AS boards
    FROM sections s
    WHERE s.site_key=$1 AND s.parent_section_id IS NULL
    ORDER BY s.section_key`,
    [SITE],
  );
  console.table(tops.rows);

  const top5 = await db.query<{ board_key: string; name: string; today: number; threads: number; posts: number }>(`
    SELECT board_key, name,
      (stats->>'today')::int   AS today,
      (stats->>'threads')::int AS threads,
      (stats->>'posts')::int   AS posts
    FROM boards
    WHERE site_key=$1
    ORDER BY (stats->>'today')::int DESC NULLS LAST
    LIMIT 5`,
    [SITE],
  );
  console.log('\n== Top 5 boards by "today" post count ==');
  console.table(top5.rows);
}

async function drillSection(key: string) {
  const db = getPool();
  const sec = await db.query<{ id: string; name: string; parent_section_id: string | null }>(
    `SELECT id, name, parent_section_id::text FROM sections WHERE site_key=$1 AND section_key=$2`,
    [SITE, key],
  );
  if (sec.rows.length === 0) { console.log(`section "${key}" not found`); return; }
  const s = sec.rows[0]!;
  console.log(`Section "${key}" name="${s.name}" id=${s.id} parent=${s.parent_section_id ?? 'none'}`);

  const subs = await db.query(
    `SELECT section_key, name FROM sections WHERE parent_section_id=$1 ORDER BY section_key`,
    [s.id],
  );
  console.log(`\n  Sub-sections (${subs.rows.length}):`);
  console.table(subs.rows);

  const boards = await db.query(
    `SELECT board_key, name,
       (stats->>'online')::int  AS online,
       (stats->>'today')::int   AS today,
       (stats->>'threads')::int AS threads,
       (stats->>'posts')::int   AS posts,
       jsonb_array_length(COALESCE(moderators,'[]'::jsonb)) AS mods
     FROM boards WHERE section_id=$1 ORDER BY board_key`,
    [s.id],
  );
  console.log(`\n  Boards directly in this section (${boards.rows.length}):`);
  console.table(boards.rows);
}

async function showBoard(key: string) {
  const db = getPool();
  const r = await db.query(
    `SELECT b.board_key, b.name, b.moderators, b.stats, b.last_crawled_at,
            s.section_key AS section, p.section_key AS parent_section
     FROM boards b
     LEFT JOIN sections s ON s.id = b.section_id
     LEFT JOIN sections p ON p.id = s.parent_section_id
     WHERE b.site_key=$1 AND b.board_key=$2`,
    [SITE, key],
  );
  if (r.rows.length === 0) { console.log(`board "${key}" not found`); return; }
  console.log(JSON.stringify(r.rows[0], null, 2));
}

async function main() {
  initDb(process.env.PGDATA_DIR ?? './.pgdata');
  try {
    const [arg1, arg2] = process.argv.slice(2);
    if (!arg1) { await summary(); return; }
    if (arg1 === 'board' && arg2) { await showBoard(arg2); return; }
    await drillSection(arg1);
  } finally {
    await closeDb();
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
