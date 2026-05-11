import 'dotenv/config';
import { initDb, getStructureDb, getForumDb, closeAllDbs } from '../../src/repository/db';

async function main(): Promise<void> {
  console.log('Env:');
  console.log('  SCHOOL_BBS_BASE_URL set?', !!process.env.SCHOOL_BBS_BASE_URL);
  console.log('  SCHOOL_BBS_USERNAME set?', !!process.env.SCHOOL_BBS_USERNAME);
  console.log('  SCHOOL_BBS_PASSWORD set?', !!process.env.SCHOOL_BBS_PASSWORD);

  initDb({ dataDir: process.env.DATABASE_PATH ?? './.data' });

  const boards = await getStructureDb().query<{ name: string; node_key: string }>(
    `SELECT name, node_key FROM nodes
      WHERE site_key = 'school-bbs' AND type = 'board' AND name IS NOT NULL
      ORDER BY id LIMIT 10`,
  );
  console.log('Sample boards:');
  for (const row of boards.rows) console.log('  ', row);

  const forums = await getStructureDb().query<{ db_file: string }>(
    `SELECT db_file FROM nodes
      WHERE site_key = 'school-bbs' AND type = 'forum' AND db_file IS NOT NULL`,
  );

  let nonPinnedTotal = 0;
  for (const f of forums.rows) {
    const forumDb = getForumDb(f.db_file);
    const r = await forumDb.query<{ c: number }>(
      `SELECT count(*) AS c FROM threads WHERE is_pinned = 0`,
    );
    nonPinnedTotal += r.rows[0]!.c;
  }
  console.log('Non-pinned threads in DB:', nonPinnedTotal);

  await closeAllDbs();
}

main().catch((err) => { console.error(err); process.exit(1); });
