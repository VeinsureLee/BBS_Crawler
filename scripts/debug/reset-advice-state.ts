import { initDb, getDb, closeDb } from '../../src/repository/db';

async function main(): Promise<void> {
  initDb('./.pgdata');
  const r = await getDb().query(
    `DELETE FROM board_crawl_state
      WHERE board_id IN (SELECT id FROM boards WHERE site_key='school-bbs' AND name='意见与建议')`,
  );
  console.log('cleared rows:', r.affectedRows);
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
