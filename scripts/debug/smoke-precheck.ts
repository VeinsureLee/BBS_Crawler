import 'dotenv/config';
import { initDb, closeDb } from '../../src/repository/db';

async function main(): Promise<void> {
  console.log('Env:');
  console.log('  SCHOOL_BBS_BASE_URL set?', !!process.env.SCHOOL_BBS_BASE_URL);
  console.log('  SCHOOL_BBS_USERNAME set?', !!process.env.SCHOOL_BBS_USERNAME);
  console.log('  SCHOOL_BBS_PASSWORD set?', !!process.env.SCHOOL_BBS_PASSWORD);

  const db = initDb('./.pgdata');
  const r = await db.query<{ name: string; board_key: string }>(
    `SELECT name, board_key FROM boards WHERE name IS NOT NULL ORDER BY id LIMIT 10`,
  );
  console.log('Sample boards:');
  for (const row of r.rows) console.log('  ', row);

  const cnt = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM threads WHERE is_pinned = false`,
  );
  console.log('Non-pinned threads in DB:', cnt.rows[0]!.c);

  await closeDb();
}

main().catch((err) => { console.error(err); process.exit(1); });
