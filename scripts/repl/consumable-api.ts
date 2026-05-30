/**
 * 真机验收 REPL：构造一个 CrawlerRuntime 实例并注入交互环境，
 * 由你在同一进程内手动调用方法验收（单实例、多次调用，等同 MCP 常驻模式）。
 *
 * 用法：
 *   npm run repl            # 进入交互式 REPL，作用域内有 rt / classifyError / siteKey
 *   npm run repl -- --auto  # 非交互：自动跑一遍全链路后退出
 *   npm run repl -- --auto --url <帖子URL>    # 自动模式额外爬一帖
 *   npm run repl -- --auto --id <boardKey>/<articleId>
 *
 * 浏览器可见性由 .env 的 BROWSER_HEADLESS 决定（false=可见，true=无头）。
 * 前置：.env 内 SCHOOL_BBS_USERNAME / SCHOOL_BBS_PASSWORD / SCHOOL_BBS_BASE_URL。
 *
 * REPL 内可直接 await（Node REPL 默认支持顶层 await），示例：
 *   await rt.authStatus()
 *   await rt.warmUp()
 *   await rt.authStatus()
 *   await rt.readers.listSections(siteKey)
 *   await rt.service.fetchThread({ siteKey, url: '…' })
 *   await rt.shutdown()
 *   .exit
 */
import 'dotenv/config';
import repl from 'node:repl';

// 脚本用 console 汇报；不动 BROWSER_HEADLESS（交给 .env，用户验收时自己定可见/无头）。
process.env.LOG_STDOUT_DISABLED = process.env.LOG_STDOUT_DISABLED ?? 'true';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function runAuto(rt: any, classifyError: any, siteKey: string): Promise<void> {
  const url = getFlag('url');
  const id = getFlag('id');

  console.log('[1] init…');
  await rt.init();
  console.log('    ready =', rt.isReady());

  console.log('[2] authStatus (预热前；只查不登)…');
  console.log('    ', await rt.authStatus());

  console.log('[3] warmUp (建立会话、不抓数据)…');
  console.log('    ', await rt.warmUp());

  console.log('[4] authStatus (预热后，应 loggedIn=true)…');
  console.log('    ', await rt.authStatus());

  console.log('[5] readers 读查 (纯本地、不联网)…');
  const sites = await rt.readers.listSites();
  console.log('    listSites =', sites.length, '个站点');
  if (sites.length > 0) {
    const sections = await rt.readers.listSections(siteKey);
    console.log('    listSections =', sections.length, '个讨论区');
  } else {
    console.log('    (DB 为空——请先 npm run init 初始化结构)');
  }

  if (url || id) {
    console.log('[6] service 真机爬取一帖…');
    try {
      const thread = url
        ? (await rt.service.fetchThread({ siteKey, url, persist: true })).thread
        : await rt.service.fetchThreadById({ siteKey, threadId: id });
      console.log('    ok:', thread.title, '|', thread.posts.length, '楼');
    } catch (e) {
      console.log('    fetch 失败，classifyError =', classifyError(e));
    }
  } else {
    console.log('[6] (跳过爬取——传 --url 或 --id 可验证真机抓帖)');
  }

  console.log('[7] shutdown…');
  await rt.shutdown();
  console.log('    ready =', rt.isReady());
  console.log('✅ 自动验收完成');
}

async function main() {
  const { CrawlerRuntime, classifyError } = await import('../../src/index.js');
  const siteKey = 'school-bbs';
  const rt = new CrawlerRuntime({ config: { siteKey, idleTimeoutMs: 0 } });

  if (hasFlag('auto')) {
    await runAuto(rt, classifyError, siteKey);
    process.exit(0);
  }

  // 交互模式：先 init 好实例，再把 rt 丢进 REPL 作用域。
  console.log('init… (构造单个 CrawlerRuntime 实例)');
  await rt.init();
  console.log(`ready = ${rt.isReady()}；作用域内有: rt, classifyError, siteKey`);
  console.log('示例: await rt.warmUp()  /  await rt.authStatus()  /  await rt.readers.listSections(siteKey)');
  console.log('退出前请 await rt.shutdown()，然后 .exit');

  const r = repl.start({ prompt: 'crawler> ' });
  r.context.rt = rt;
  r.context.classifyError = classifyError;
  r.context.siteKey = siteKey;

  // 退出时兜底关闭，避免残留浏览器/DB 句柄。
  r.on('exit', () => {
    void rt.shutdown().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('❌ REPL 启动失败:', err);
  process.exit(1);
});
