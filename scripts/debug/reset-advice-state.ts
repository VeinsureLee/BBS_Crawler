import { initDb, getStructureDb, getBoardDb, closeAllDbs } from '../../src/repository/db';

async function main(): Promise<void> {
  initDb({ dataDir: './data' });
  const r = await getStructureDb().query<{ id: number; db_path: string | null }>(
    `SELECT id, db_path FROM nodes
      WHERE site_key='school-bbs' AND type='board' AND name='意见与建议'`,
  );
  let cleared = 0;
  for (const row of r.rows) {
    if (!row.db_path) continue;
    const boardDb = getBoardDb(row.db_path);
    const del = await boardDb.query(
      `DELETE FROM board_crawl_state WHERE board_node_id = $1`,
      [row.id],
    );
    cleared += del.affectedRows ?? 0;
  }
  console.log('cleared rows:', cleared);
  await closeAllDbs();
}

main().catch((e) => { console.error(e); process.exit(1); });
