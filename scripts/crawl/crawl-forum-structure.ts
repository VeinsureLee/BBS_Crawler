import 'dotenv/config';
import { chromium, BrowserContext, Page, Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../src/util/logger';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXPLORATION_DIR = path.join(process.cwd(), 'exploration');
const FORUM_DIR = path.join(EXPLORATION_DIR, 'forum');
const BOARD_DIR = path.join(EXPLORATION_DIR, 'board');
const PINNED_DIR = path.join(EXPLORATION_DIR, 'pinned');

// 数据结构定义
interface Section {
  siteKey: string;
  sectionKey: string;  // 如 "/section/9"
  name?: string;
  displayOrder?: number;
  raw?: any;
}

interface Board {
  siteKey: string;
  sectionKey: string;
  boardKey: string;    // 如 "/board/Dota"
  parentBoardKey?: string;
  name?: string;
  displayOrder?: number;
  isSubBoard: boolean;
  raw?: any;
}

interface PinnedThread {
  siteKey: string;
  sectionKey: string;
  boardKey: string;
  threadUrl: string;
  title: string;
  author?: string;
  isTop: boolean;
  raw?: any;
}

// 确保目录存在
function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 保存 JSON 文件
function saveJson(filePath: string, data: any) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// 保存 HTML 文件
function saveHtml(filePath: string, content: string) {
  let html = content
    .replace(/charset=["']?GBK["']?/i, 'charset="UTF-8"')
    .replace(/charset=["']?gb2312["']?/i, 'charset="UTF-8"')
    .replace(/></g, '>\n<')
    .replace(/\n\s*\n/g, '\n');
  fs.writeFileSync(filePath, html, 'utf-8');
}

async function createContext(): Promise<{ browser: Browser, ctx: BrowserContext, page: Page }> {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
  });

  const ctx = await browser.newContext({
    storageState: path.join(process.cwd(), '.state', 'school-bbs.json'),
  });

  const page = await ctx.newPage();
  return { browser, ctx, page };
}

// 步骤1: 获取所有讨论区
async function crawlSections(page: Page, baseUrl: string): Promise<Section[]> {
  logger.info({}, '步骤 1：抓取讨论区清单');

  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  const sections: Section[] = [];

  // 获取所有讨论区链接
  const sectionItems = await page.$$('#xlist .slist .folder-close, #xlist .slist .folder-close-last');

  for (let i = 0; i < sectionItems.length; i++) {
    const item = sectionItems[i];
    const link = await item.$('a[href*="/section/"]');
    if (link) {
      const href = await link.getAttribute('href');
      const name = await link.textContent();

      if (href) {
        sections.push({
          siteKey: 'school-bbs',
          sectionKey: href,
          name: name?.trim(),
          displayOrder: i,
        });
      }
    }
  }

  // 保存讨论区列表
  ensureDir(FORUM_DIR);
  saveJson(path.join(FORUM_DIR, 'sections.json'), sections);
  saveHtml(path.join(FORUM_DIR, 'homepage-for-analysis.html'), await page.content());

  logger.info({ count: sections.length }, `发现 ${sections.length} 个讨论区`);
  return sections;
}

// 规范化 URL - 只保留路径部分
function normalizeBoardKey(href: string, baseUrl: string): string {
  if (href.startsWith('/')) {
    return href;
  }
  if (href.startsWith('http')) {
    try {
      const url = new URL(href);
      return url.pathname;
    } catch {
      return href;
    }
  }
  return href.startsWith('/') ? href : '/' + href;
}

// 步骤2: 爬取单个讨论区的版面
async function crawlSectionBoards(page: Page, baseUrl: string, section: Section): Promise<Board[]> {
  logger.info({ sectionKey: section.sectionKey }, `步骤 2：抓取讨论区 ${section.sectionKey} 的版面`);

  const sectionUrl = baseUrl + section.sectionKey;
  await page.goto(sectionUrl, { waitUntil: 'networkidle' });

  const boards: Board[] = [];

  // 获取版面链接
  const boardLinks = await page.$$('a[href*="/board/"]');

  for (let i = 0; i < boardLinks.length; i++) {
    const link = boardLinks[i];
    const href = await link.getAttribute('href');
    const name = await link.textContent();

    if (href) {
      const boardKey = normalizeBoardKey(href, baseUrl);
      if (!boards.some(b => b.boardKey === boardKey)) {
        boards.push({
          siteKey: 'school-bbs',
          sectionKey: section.sectionKey,
          boardKey: boardKey,
          name: name?.trim(),
          displayOrder: i,
          isSubBoard: false,
        });
      }
    }
  }

  // 保存讨论区页面
  const sectionFileName = section.sectionKey.replace(/\//g, '_');
  saveHtml(path.join(BOARD_DIR, `${sectionFileName}.html`), await page.content());

  logger.info({ sectionKey: section.sectionKey, count: boards.length }, `${section.sectionKey} 下发现 ${boards.length} 个版面`);
  return boards;
}

// 步骤3: 爬取单个版面的置顶帖子
async function crawlBoardPinned(page: Page, baseUrl: string, board: Board): Promise<PinnedThread[]> {
  logger.info({ boardKey: board.boardKey }, `步骤 3：抓取版面 ${board.boardKey} 的置顶帖`);

  const boardUrl = baseUrl + board.boardKey;
  await page.goto(boardUrl, { waitUntil: 'networkidle' });

  const pinnedThreads: PinnedThread[] = [];

  // 查找所有帖子行
  const allRows = await page.$$('tr');

  for (const row of allRows) {
    // 检查是否有置顶标记
    const hasTopMark = await row.evaluate(el => {
      const html = el.innerHTML;
      return html.includes('置顶') ||
             html.includes('top') ||
             el.classList.contains('top');
    });

    // 查找帖子链接
    const titleLink = await row.$('a[href*="/article/"]');
    if (titleLink) {
      const href = await titleLink.getAttribute('href');
      const title = await titleLink.textContent();

      if (href) {
        const threadUrl = normalizeBoardKey(href, baseUrl);
        // 获取作者
        let author: string | undefined;
        const authorEl = await row.$('td.author a');
        if (authorEl) {
          author = await authorEl.textContent();
        }

        pinnedThreads.push({
          siteKey: 'school-bbs',
          sectionKey: board.sectionKey,
          boardKey: board.boardKey,
          threadUrl: threadUrl,
          title: title?.trim() || '',
          author: author?.trim(),
          isTop: hasTopMark,
        });
      }
    }
  }

  // 保存版面页面
  const boardFileName = board.boardKey.replace(/\//g, '_');
  saveHtml(path.join(BOARD_DIR, `${boardFileName}.html`), await page.content());

  // 保存置顶帖信息
  if (pinnedThreads.length > 0) {
    saveJson(path.join(PINNED_DIR, `${boardFileName}.json`), pinnedThreads);
  }

  logger.info({ boardKey: board.boardKey, count: pinnedThreads.length }, `${board.boardKey} 下发现 ${pinnedThreads.length} 个帖子`);
  return pinnedThreads;
}

// 主函数
async function main() {
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) {
    console.error('SCHOOL_BBS_BASE_URL not set');
    process.exit(1);
  }

  ensureDir(FORUM_DIR);
  ensureDir(BOARD_DIR);
  ensureDir(PINNED_DIR);

  const { browser, ctx, page } = await createContext();

  try {
    // 步骤1: 获取所有讨论区
    const sections = await crawlSections(page, baseUrl);
    saveJson(path.join(FORUM_DIR, 'sections.json'), sections);

    // 步骤2: 逐个爬取讨论区的版面
    const allBoards: Board[] = [];
    for (const section of sections) {
      const boards = await crawlSectionBoards(page, baseUrl, section);
      allBoards.push(...boards);
    }
    saveJson(path.join(FORUM_DIR, 'boards.json'), allBoards);

    // 步骤3: 逐个爬取版面的帖子（包括置顶帖）
    const allThreads: PinnedThread[] = [];
    for (const board of allBoards) {
      const threads = await crawlBoardPinned(page, baseUrl, board);
      allThreads.push(...threads);
    }
    saveJson(path.join(FORUM_DIR, 'threads.json'), allThreads);

    logger.info(
      { sections: sections.length, boards: allBoards.length, threads: allThreads.length },
      `完成：${sections.length} 个讨论区, ${allBoards.length} 个版面, ${allThreads.length} 个帖子`,
    );

  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch(err => {
  console.error('Crawl failed:', err);
  process.exit(1);
});
