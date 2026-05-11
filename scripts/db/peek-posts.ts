/**
 * Peek crawled threads and their posts (content) for verification.
 *
 * Usage:
 *   npm run db:peek                          # latest 5 threads, 5 posts each
 *   npm run db:peek -- --limit 10            # latest 10 threads
 *   npm run db:peek -- --posts 20            # up to 20 posts per thread
 *   npm run db:peek -- --thread 123          # show one specific thread by id
 *   npm run db:peek -- --board <board_key>   # filter by board
 *   npm run db:peek -- --title 关键字        # filter by title substring
 *   npm run db:peek -- --html                # print content_html instead of content_text
 *   npm run db:peek -- --full                # do not truncate post body
 */
import 'dotenv/config';
import { parseConfig } from '../../src/core/config';
import { initDb, closeDb, getDb } from '../../src/repository/db';

interface Args {
  limit: number;
  posts: number;
  threadId?: number;
  board?: string;
  title?: string;
  html: boolean;
  full: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { limit: 5, posts: 5, html: false, full: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--limit':  a.limit = Number(v); i++; break;
      case '--posts':  a.posts = Number(v); i++; break;
      case '--thread': a.threadId = Number(v); i++; break;
      case '--board':  a.board = v; i++; break;
      case '--title':  a.title = v; i++; break;
      case '--html':   a.html = true; break;
      case '--full':   a.full = true; break;
    }
  }
  return a;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + ` …(+${s.length - n} chars)`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = parseConfig(process.env);
  initDb(cfg.dataDir);

  try {
    const db = getDb();

    const where: string[] = [];
    const params: unknown[] = [];
    if (args.threadId !== undefined) {
      params.push(args.threadId);
      where.push(`id = $${params.length}`);
    }
    if (args.board) {
      params.push(args.board);
      where.push(`board_key = $${params.length}`);
    }
    if (args.title) {
      params.push(`%${args.title}%`);
      where.push(`title LIKE $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(args.limit);
    const limitParam = `$${params.length}`;

    const threads = await db.query<{
      id: number;
      title: string;
      author: string | null;
      board_key: string | null;
      posted_at: string | null;
      last_reply_at: string | null;
      reply_count: number | null;
      url: string;
    }>(
      `SELECT id, title, author, board_key, posted_at, last_reply_at, reply_count, url
       FROM threads
       ${whereSql}
       ORDER BY last_fetched_at DESC
       LIMIT ${limitParam}`,
      params,
    );

    if (threads.rows.length === 0) {
      console.log('没有匹配的 thread。先确认是否已经跑过 crawl:board / crawl:section / crawl:pinned。');
      return;
    }

    const bodyMax = args.full ? Number.POSITIVE_INFINITY : 400;
    const column = args.html ? 'content_html' : 'content_text';

    for (const t of threads.rows) {
      console.log('\n' + '='.repeat(80));
      console.log(`[thread #${t.id}]  ${t.title}`);
      console.log(
        `  board=${t.board_key ?? '-'}  author=${t.author ?? '-'}  ` +
        `posted=${t.posted_at ?? '-'}  last_reply=${t.last_reply_at ?? '-'}  ` +
        `replies=${t.reply_count ?? '-'}`,
      );
      console.log(`  url=${t.url}`);

      const posts = await db.query<{
        floor: number;
        author: string;
        posted_at: string | null;
        body: string;
        attachments: unknown;
      }>(
        `SELECT floor, author, posted_at,
                ${column} AS body,
                attachments
         FROM posts
         WHERE thread_id = $1
         ORDER BY floor
         LIMIT $2`,
        [t.id, args.posts],
      );

      if (posts.rows.length === 0) {
        console.log('  (该 thread 在 posts 表中无楼层 — 可能正文未抓取成功)');
        continue;
      }

      for (const p of posts.rows) {
        console.log(`\n  -- ${p.floor}F  @${p.author}  ${p.posted_at ?? ''} --`);
        console.log(truncate(p.body ?? '', bodyMax).replace(/^/gm, '    '));
        if (Array.isArray(p.attachments) && p.attachments.length > 0) {
          console.log(`    [attachments: ${p.attachments.length}]`);
        }
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log(`显示了 ${threads.rows.length} 个 thread。提示: 加 --full 查看完整正文，--html 查看 HTML 原文。`);
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
