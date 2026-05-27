/**
 * Crawl a single thread's full posts and persist them.
 *
 * Usage:
 *   npm run crawl:thread -- --id <boardKey>/<articleId>
 *   npm run crawl:thread -- --url <thread-url>
 *   [--site <siteKey>]   (default school-bbs)
 */
process.env.LOG_STDOUT_DISABLED = process.env.LOG_STDOUT_DISABLED ?? 'false';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const siteKey = getFlag('site') ?? 'school-bbs';
  const id = getFlag('id');
  const url = getFlag('url');
  if (!id && !url) {
    console.error('Usage: npm run crawl:thread -- (--id <boardKey>/<articleId> | --url <thread-url>) [--site <siteKey>]');
    process.exit(1);
  }
  const { createCrawler } = await import('../../src/service/factory.js');
  const { logger } = await import('../../src/util/logger.js');
  const crawler = await createCrawler({ siteKey });
  try {
    if (url) {
      const out = await crawler.service.fetchThread({ siteKey, url, persist: true });
      logger.info(
        { threadId: out.threadId, title: out.thread.title, posts: out.thread.posts.length },
        `已抓取并入库：${out.thread.title}（id=${out.threadId}, ${out.thread.posts.length} 楼）`,
      );
    } else {
      const thread = await crawler.service.fetchThreadById({ siteKey, threadId: id! });
      logger.info(
        { title: thread.title, posts: thread.posts.length },
        `已抓取并入库：${thread.title}（${thread.posts.length} 楼）`,
      );
    }
  } finally {
    await crawler.shutdown();
  }
}
main().catch((err) => { console.error('crawl-thread failed:', err); process.exit(1); });
