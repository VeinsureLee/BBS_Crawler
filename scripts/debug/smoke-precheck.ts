import 'dotenv/config';
import { initDbs, closeDbs, getStructureDb, getContentDb } from '../../src/repository/db';

async function main(): Promise<void> {
  console.log('Env:');
  console.log('  SCHOOL_BBS_BASE_URL set?', !!process.env.SCHOOL_BBS_BASE_URL);
  console.log('  SCHOOL_BBS_USERNAME set?', !!process.env.SCHOOL_BBS_USERNAME);
  console.log('  SCHOOL_BBS_PASSWORD set?', !!process.env.SCHOOL_BBS_PASSWORD);

  initDbs({ dataDir: './data' });
  const r = await getStructureDb().query<{ name: string; board_key: string }>(
    `SELECT name, board_key FROM boards WHERE name IS NOT NULL ORDER BY id LIMIT 10`,
  );
  console.log('Sample boards:');
  for (const row of r.rows) console.log('  ', row);

  const cnt = await getContentDb().query<{ c: number }>(
    `SELECT count(*) AS c FROM threads WHERE is_pinned = false`,
  );
  console.log('Non-pinned threads in DB:', cnt.rows[0]!.c);

  await closeDbs();
}

main().catch((err) => { console.error(err); process.exit(1); });
