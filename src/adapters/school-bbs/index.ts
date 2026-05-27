import type { Page } from 'playwright';
import type {
  SiteAdapter,
  LoginCredentials,
  ListParams,
  GetThreadParams,
  SectionSummary,
  ThreadSummary,
  Thread,
} from '../../core/site-adapter.js';
import { register } from '../../core/registry.js';
import { loadSiteConfig, buildRouteUrl } from '../../core/site-config.js';
import type { SectionChildren, Post } from '../../core/site-adapter.js';
import { listThreads as listThreadsImpl, fetchBoardPage } from './listThreads.js';

export { fetchBoardPage };

const cfg = loadSiteConfig('school-bbs');
const ui = cfg.selectors;

const siteKey = 'school-bbs';
const displayName = 'School BBS';

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.waitForSelector(ui.login.loggedInIndicator, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function login(page: Page, credentials: LoginCredentials): Promise<void> {
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');

  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  // Check if already on login page with form
  const hasLoginForm = await page.locator(ui.login.form).count() > 0;
  if (hasLoginForm) {
    await page.fill(ui.login.usernameInput, credentials.username);
    await page.fill(ui.login.passwordInput, credentials.password);
    await page.click(ui.login.submitButton);
    await page.waitForLoadState('networkidle');
  }

  // Verify login success
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    throw new Error('Login failed - could not verify logged-in state');
  }
}

async function listSections(page: Page): Promise<SectionSummary[]> {
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');

  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  const rows = await page.$$eval(ui.section.sectionLinks, (anchors) =>
    anchors.map((a) => ({
      href: a.getAttribute('href') ?? '',
      name: (a.textContent ?? '').trim(),
    })),
  );

  const seen = new Set<string>();
  const sections: SectionSummary[] = [];
  for (const r of rows) {
    const m = /\/section\/([^/?#]+)/.exec(r.href);
    if (!m || !r.name) continue;
    const sectionKey = m[1]!;
    if (seen.has(sectionKey)) continue;
    seen.add(sectionKey);
    sections.push({
      sectionKey,
      name: r.name,
      url: new URL(r.href, baseUrl).toString(),
    });
  }
  return sections;
}

async function listSectionChildren(page: Page, sectionKey: string): Promise<SectionChildren> {
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');

  const target = buildRouteUrl(baseUrl, cfg.routes.section, { key: sectionKey });
  // SPA hashbang route: navigating from /#!section/A to /#!section/B is only a
  // hash change, page.goto does not actually reload, and waitForSelector then
  // sees the previous section's stale rows and returns instantly. Forcing
  // about:blank first guarantees a real navigation. Same pattern as
  // listPinnedThreadIds / fetchThreadPage below.
  await page.goto('about:blank');
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector(ui.section.boardRowReady, { timeout: 15000 });
  // Extra guard: ensure the hash actually points at the requested section so
  // we never read a half-loaded previous frame.
  await page.waitForFunction(
    `location.hash === '#!section/${sectionKey}'`,
    undefined,
    { timeout: 5000 },
  );

  const rows = await page.$$eval('table.board-list tbody tr', (trs) => {
    const out = [];
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i];
      const link = tr.querySelector('td.title_1 a');
      const href = link ? link.getAttribute('href') || '' : '';
      const name = link && link.textContent ? link.textContent.trim() : '';
      const title2 = tr.querySelector('td.title_2');
      const title2Text = title2 && title2.textContent ? title2.textContent.trim() : '';
      const isSubSection = title2Text.indexOf('[二级目录]') >= 0;
      const modNodes = tr.querySelectorAll('td.title_2 a[href^="/user/query/"]');
      const moderators: string[] = [];
      for (let j = 0; j < modNodes.length; j++) {
        const h = modNodes[j].getAttribute('href') || '';
        const u = h.replace(/^\/user\/query\//, '');
        if (u) moderators.push(u);
      }
      const c4 = tr.querySelector('td.title_4');
      const c5 = tr.querySelector('td.title_5');
      const c6 = tr.querySelector('td.title_6');
      const c7 = tr.querySelector('td.title_7');
      out.push({
        href,
        name,
        isSubSection,
        moderators,
        online: c4 && c4.textContent ? c4.textContent.trim() : '',
        today: c5 && c5.textContent ? c5.textContent.trim() : '',
        threads: c6 && c6.textContent ? c6.textContent.trim() : '',
        posts: c7 && c7.textContent ? c7.textContent.trim() : '',
      });
    }
    return out;
  });

  const snapshotAt = new Date().toISOString();
  const subSections: SectionChildren['subSections'] = [];
  const boards: SectionChildren['boards'] = [];
  const seenSec = new Set<string>();
  const seenBoard = new Set<string>();

  for (const r of rows) {
    if (!r.href || !r.name) continue;
    const subMatch = /^\/section\/([^/?#]+)/.exec(r.href);
    const boardMatch = /^\/board\/([^/?#]+)/.exec(r.href);
    if (r.isSubSection && subMatch) {
      const key = subMatch[1]!;
      if (seenSec.has(key)) continue;
      seenSec.add(key);
      subSections.push({
        sectionKey: key,
        name: r.name,
        url: new URL(r.href, baseUrl).toString(),
      });
    } else if (boardMatch) {
      const key = boardMatch[1]!;
      if (seenBoard.has(key)) continue;
      seenBoard.add(key);
      const toInt = (s: string) => {
        const n = parseInt(s.replace(/[^\d-]/g, ''), 10);
        return Number.isFinite(n) ? n : 0;
      };
      boards.push({
        boardKey: key,
        name: r.name,
        url: new URL(r.href, baseUrl).toString(),
        moderators: r.moderators,
        stats: {
          online: toInt(r.online),
          today: toInt(r.today),
          threads: toInt(r.threads),
          posts: toInt(r.posts),
          snapshotAt,
        },
      });
    }
  }

  return { subSections, boards };
}

async function listThreads(page: Page, params: ListParams): Promise<ThreadSummary[]> {
  return listThreadsImpl(page, params);
}

/**
 * Visit a board's first page and return the article IDs of its pinned threads
 * (rows with class="top"). Returns [] if the board has none.
 */
async function listPinnedThreadIds(page: Page, boardKey: string): Promise<string[]> {
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');
  const target = buildRouteUrl(baseUrl, cfg.routes.board, { key: boardKey });
  await page.goto('about:blank');
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector(cfg.selectors.board.threadRowReady, { timeout: 15000 });
  await page.waitForTimeout(300);

  const ids = await page.$$eval('tr.top', (trs) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < trs.length; i++) {
      const links = trs[i].querySelectorAll('a[href*="/article/"]');
      for (let j = 0; j < links.length; j++) {
        const href = links[j].getAttribute('href') || '';
        const m = /\/article\/[^/]+\/(\d+)(?:[/?#]|$)/.exec(href);
        if (!m) continue;
        const id = m[1]!;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  });
  return ids;
}

interface RawFloor {
  postId: string;
  author: string;
  floorLabel: string;
  votesUp: number;
  votesDown: number;
  rawContent: string;
}

function parseFloorNumber(label: string): number {
  if (!label) return 0;
  if (label === '楼主') return 0;
  if (label === '沙发') return 1;
  if (label === '板凳') return 2;
  const m = /(\d+)/.exec(label);
  return m ? parseInt(m[1]!, 10) : 0;
}

function parsePostedAt(rawText: string): string | undefined {
  // 发信站: 北邮人论坛 (Mon Jul 16 23:55:19 2012), 站内
  const m = /发信站:[^(\n]*\(([^)\n]+)\)/.exec(rawText);
  if (!m) return undefined;
  // Site is in CST (UTC+8). Force timezone interpretation regardless of host.
  const d = new Date(m[1]! + ' GMT+0800');
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function cleanContentText(rawText: string): string {
  let text = rawText.replace(/ /g, ' ');

  // Strip up to three template header lines if present, in order:
  //   发信人: ...   /   标  题: ...   /   发信站: ... (date), 站内
  text = text.replace(/^[ \t]*\n+/, '');
  text = text.replace(/^发信人:[^\n]*\n?/, '');
  text = text.replace(/^[ \t]*\n+/, '');
  text = text.replace(/^标[ \t]*题:[^\n]*\n?/, '');
  text = text.replace(/^[ \t]*\n+/, '');
  text = text.replace(/^发信站:[^\n]*\n?/, '');
  text = text.replace(/^[ \t]*\n+/, '');

  // Strip signature: from first standalone "--" line to end.
  const sigIdx = text.search(/(?:^|\n)--\s*(?:\n|$)/);
  if (sigIdx >= 0) text = text.slice(0, sigIdx);

  // Strip lingering 来源/修改/转载 footer lines (start with "※ ").
  text = text
    .split('\n')
    .filter((line) => !/^[ \t]*※\s/.test(line))
    .join('\n');

  // Collapse trailing whitespace and blank-line runs.
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

async function fetchThreadPage(
  page: Page,
  boardKey: string,
  articleId: string,
  pageNum: number,
): Promise<{ title: string; floors: RawFloor[]; totalPages: number }> {
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL!;
  const url = `${baseUrl.replace(/\/+$/, '')}/#!article/${boardKey}/${articleId}${pageNum > 1 ? `?p=${pageNum}` : ''}`;
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    `/^#!article\\//.test(window.location.hash) && !!window.document.querySelector('table.article')`,
    undefined,
    { timeout: 15000 },
  );
  await page.waitForTimeout(cfg.crawl.pageTurnIntervalMs);

  const data = await page.$eval('html', (root) => {
    const doc = root.ownerDocument!;
    const titleEl = root.querySelector('.b-head .n-left');
    let title = titleEl && titleEl.textContent ? titleEl.textContent.trim() : '';
    title = title.replace(/^文章主题:\s*/, '');

    // Pagination: gather page numbers from page-main list.
    const pageNodes = root.querySelectorAll('.page-main li a, .page-main li');
    let totalPages = 1;
    for (let i = 0; i < pageNodes.length; i++) {
      const t = (pageNodes[i]!.textContent || '').trim();
      const n = parseInt(t, 10);
      if (Number.isFinite(n) && n > totalPages) totalPages = n;
    }

    const tables = root.querySelectorAll('table.article');
    const floors: Array<{
      postId: string;
      author: string;
      floorLabel: string;
      votesUp: number;
      votesDown: number;
      rawContent: string;
    }> = [];
    for (let i = 0; i < tables.length; i++) {
      const tb = tables[i]!;

      // postId from id="list<num>" or class="body<num>"
      let postId = '';
      const idEl = tb.querySelector('[id^="list"]:not([id^="list_"]):not([id^="listCai"])');
      if (idEl) {
        const m = /^list(\d+)$/.exec(idEl.id || '');
        if (m && m[1]) postId = m[1];
      }
      if (!postId) {
        const bodyEl = tb.querySelector('[class*="body"]');
        if (bodyEl) {
          const cls = bodyEl.getAttribute('class') || '';
          const m = /body(\d+)/.exec(cls);
          if (m && m[1]) postId = m[1];
        }
      }

      // Author
      let author = '';
      const aName = tb.querySelector('.a-u-name a');
      if (aName) author = (aName.textContent || '').trim();
      else {
        const aSpan = tb.querySelector('.a-u-name');
        if (aSpan) author = (aSpan.textContent || '').trim();
      }

      // Floor label
      const aPos = tb.querySelector('.a-pos');
      const floorLabel = aPos && aPos.textContent ? aPos.textContent.trim() : '';

      // Votes — match number in parens, supporting + or -.
      let votesUp = 0;
      const upEl = tb.querySelector('.a-func-support, .a-func-like');
      if (upEl) {
        const m = /\(([+-]?\d+)\)/.exec(upEl.textContent || '');
        if (m && m[1]) votesUp = parseInt(m[1], 10);
      }
      let votesDown = 0;
      const downEl = tb.querySelector('.a-func-oppose, .a-func-cai');
      if (downEl) {
        const m = /\(([+-]?\d+)\)/.exec(downEl.textContent || '');
        if (m && m[1]) votesDown = parseInt(m[1], 10);
      }

      // Content: clone .a-content-wrap, strip imgs, replace <a> with markdown,
      // replace <br> with newlines, then read textContent.
      const wrap = tb.querySelector('.a-content-wrap');
      let rawContent = '';
      if (wrap) {
        const clone = wrap.cloneNode(true) as typeof wrap;
        const imgs = clone.querySelectorAll('img');
        for (let k = imgs.length - 1; k >= 0; k--) imgs[k]!.remove();
        const anchors = clone.querySelectorAll('a');
        for (let k = anchors.length - 1; k >= 0; k--) {
          const a = anchors[k]!;
          const txt = (a.textContent || '').trim();
          const href = a.getAttribute('href') || '';
          const md = href ? '[' + txt + '](' + href + ')' : txt;
          a.replaceWith(doc.createTextNode(md));
        }
        const brs = clone.querySelectorAll('br');
        for (let k = brs.length - 1; k >= 0; k--) brs[k]!.replaceWith(doc.createTextNode('\n'));
        rawContent = clone.textContent || '';
      }

      floors.push({ postId, author, floorLabel, votesUp, votesDown, rawContent });
    }

    return { title, totalPages, floors };
  });

  return data;
}

async function getThread(page: Page, params: GetThreadParams): Promise<Thread> {
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');

  // params.url is the absolute article URL. Extract board + articleId.
  const m = /\/article\/([^/?#]+)\/(\d+)/.exec(params.url);
  if (!m) throw new Error(`Cannot parse article URL: ${params.url}`);
  const boardKey = m[1]!;
  const articleId = m[2]!;

  const seen = new Set<string>();
  const allPosts: Post[] = [];
  let title = '';
  let totalPages = 1;
  let actualTotalPages = 1;
  const maxPages = params.maxPages ?? Infinity;

  for (let p = 1; p <= totalPages && p <= maxPages; p++) {
    const { title: pageTitle, floors, totalPages: tp } = await fetchThreadPage(
      page, boardKey, articleId, p,
    );
    if (p === 1) {
      title = pageTitle;
      actualTotalPages = tp;
      totalPages = Math.min(tp, maxPages);
    }
    for (const f of floors) {
      const dedupKey = f.postId || `${f.author}|${f.floorLabel}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const postedAt = parsePostedAt(f.rawContent);
      const contentText = cleanContentText(f.rawContent);
      allPosts.push({
        floor: parseFloorNumber(f.floorLabel),
        author: f.author,
        ...(postedAt ? { postedAt } : {}),
        contentHtml: '',
        contentText,
        raw: { postId: f.postId, votesUp: f.votesUp, votesDown: f.votesDown },
      });
    }
  }

  // Sort by floor for stable storage order.
  allPosts.sort((a, b) => a.floor - b.floor);

  const url = `${baseUrl.replace(/\/+$/, '')}/article/${boardKey}/${articleId}`;
  return {
    url,
    title,
    board: boardKey,
    posts: params.maxReplies ? allPosts.slice(0, params.maxReplies + 1) : allPosts,
    fetchedAt: new Date().toISOString(),
    raw: {
      articleId,
      pageCount: actualTotalPages,
      crawledPages: totalPages,
      truncated: actualTotalPages > maxPages,
    },
  };
}

const adapter: SiteAdapter = {
  siteKey,
  displayName,
  baseUrl: process.env.SCHOOL_BBS_BASE_URL || '',
  requiresAuth: true,
  isLoggedIn,
  login,
  listSections,
  listSectionChildren,
  listPinnedThreadIds,
  listThreads,
  getThread,
};

register(adapter);
