import 'dotenv/config';
import { initDb, getStructureDb, getBoardDb, closeAllDbs } from '../../src/repository/db';

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

  const allBoards = await getStructureDb().query<{ db_path: string }>(
    `SELECT db_path FROM nodes
      WHERE site_key = 'school-bbs' AND type = 'board' AND db_path IS NOT NULL`,
  );

  let plainTotal = 0;
  let pinnedTotal = 0;
  for (const b of allBoards.rows) {
    const boardDb = getBoardDb(b.db_path);
    const plain = await boardDb.query<{ c: number }>(`SELECT count(*) AS c FROM threads WHERE is_pinned = 0`);
    const pinned = await boardDb.query<{ c: number }>(`SELECT count(*) AS c FROM threads WHERE is_pinned = 1`);
    plainTotal += plain.rows[0]!.c;
    pinnedTotal += pinned.rows[0]!.c;
  }
  console.log('Pinned threads in DB:', pinnedTotal);
  console.log('Plain threads in DB:', plainTotal);

  await closeAllDbs();
}

main().catch((err) => { console.error(err); process.exit(1); });
