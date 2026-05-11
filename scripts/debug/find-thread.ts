/**
 * Find a thread by title substring
 */
import 'dotenv/config';
import { parseConfig } from '../../src/core/config';
import { initDbs, closeDbs, getContentDb } from '../../src/repository/db';

async function main() {
  const searchTitle = process.argv[2];
  if (!searchTitle) {
    console.error('Usage: npx tsx scripts/find-thread.ts "帖子标题关键词"');
    process.exit(1);
  }

  const cfg = parseConfig(process.env);
  initDbs({ dataDir: cfg.dataDir });

  try {
    const result = await getContentDb().query<{
      id: number;
      title: string;
      board_key: string;
      url: string;
    }>(
      `SELECT id, title, board_key, url FROM threads WHERE title LIKE $1`,
      [`%${searchTitle}%`]
    );

    if (result.rows.length === 0) {
      console.log('未找到匹配的帖子');
      return;
    }

    console.log(`找到 ${result.rows.length} 个匹配的帖子:\n`);
    for (const row of result.rows) {
      console.log(`标题: ${row.title}`);
      console.log(`板块: ${row.board_key}`);
      console.log(`URL: ${row.url}`);
      console.log(`---`);
    }
  } finally {
    await closeDbs();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
