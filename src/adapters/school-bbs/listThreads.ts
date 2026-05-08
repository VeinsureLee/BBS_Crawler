/**
 * school-bbs board page parser.
 *
 * Page layout (see exploration/board/board_BYRatSH.html):
 *   <table>
 *     <thead>...columns: 状态 / 主题 / 发帖时间 / 作者 / 回复 / 最新回复 / 作者...</thead>
 *     <tbody>
 *       <tr class="top">  -- pinned thread, mixed in with normal rows
 *         <td class="title_8"> ...icon... </td>
 *         <td class="title_9"><a href="/article/{boardKey}/{id}">title</a> [page links]</td>
 *         <td class="title_10">2026-05-07</td>           -- posted date (YYYY-MM-DD)
 *         <td class="title_12">| <a href="/user/query/{user}">{user}</a></td>
 *         <td class="title_11 middle">9</td>             -- reply count
 *         <td class="title_10"><a href="...?p=N#aK">2026-05-07</a></td>  -- last reply date
 *         <td class="title_12">| <a href="/user/query/{user}">{user}</a></td>
 *       </tr>
 *       <tr> ... non-pinned rows ...
 *     </tbody>
 *   </table>
 *
 * Pagination: `<ol class="page-main">` whose <li>s contain page numbers.
 * Posted dates are date-only (no time), in CST (UTC+8). We coerce them to
 * ISO 8601 by treating 00:00 local time as the timestamp.
 */
import type { Page } from 'playwright';
import type { ListParams, ThreadSummary } from '../../core/site-adapter';
import { buildRouteUrl } from '../../core/site-config';

/** Date appearing on the board page is YYYY-MM-DD in CST. */
function dateToIso(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
  if (!m) return undefined;
  // Treat as 00:00 China time → UTC. (Site is CST = UTC+8.)
  const iso = `${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

export interface ParsedThreadRow {
  /** Site-internal article id, e.g. "10687". */
  articleId: string;
  /** Board key (e.g. "BYRatSH") — needed to construct article URLs. */
  boardKey: string;
  /** Stable opaque id of the form "{boardKey}/{articleId}". */
  threadId: string;
  url: string;
  title: string;
  author?: string;
  postedAt?: string;
  lastReplyAt?: string;
  replyCount?: number;
  isPinned: boolean;
}

export interface ListBoardPageResult {
  rows: ParsedThreadRow[];
  /** Total page count visible in the pagination control on this page. */
  totalPages: number;
}

/**
 * Drive Playwright to load `/{board}?p={page}` and parse one page of threads.
 * Page 1 omits the `?p=` param so cache behavior matches the site.
 */
export async function fetchBoardPage(
  page: Page,
  boardKey: string,
  pageNum: number,
): Promise<ListBoardPageResult> {
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');

  const boardRoute = buildRouteUrl(baseUrl, '/#!board/{key}', { key: boardKey });
  const target = pageNum > 1 ? `${boardRoute}?p=${pageNum}` : boardRoute;

  await page.goto('about:blank');
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    `/^#!board\\//.test(window.location.hash) && !!document.querySelector('a[href^="/article/"]')`,
    undefined,
    { timeout: 15000 },
  );
  await page.waitForTimeout(200);

  const data = await page.$eval('html', (root, args: { boardKey: string }) => {
    const trs = root.querySelectorAll('tbody tr');
    const out: Array<{
      articleId: string;
      titleHref: string;
      title: string;
      postedRaw: string;
      author: string;
      replyCountRaw: string;
      lastReplyRaw: string;
      isPinned: boolean;
    }> = [];

    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i]!;
      const cls = tr.getAttribute('class') ?? '';
      const isPinned = / (?:^|\s)top(?:\s|$)/.test(' ' + cls);

      const titleCell = tr.querySelector('td.title_9');
      if (!titleCell) continue;
      const titleAnchor = titleCell.querySelector('a[href^="/article/"]');
      if (!titleAnchor) continue;
      const titleHref = titleAnchor.getAttribute('href') ?? '';
      const articleMatch = /^\/article\/([^/?#]+)\/(\d+)/.exec(titleHref);
      if (!articleMatch) continue;
      const board = articleMatch[1] ?? '';
      const articleId = articleMatch[2] ?? '';
      if (board !== args.boardKey || !articleId) continue;

      const title = (titleAnchor.textContent ?? '').trim();

      const dateCells = tr.querySelectorAll('td.title_10');
      const postedRaw = dateCells[0]?.textContent?.trim() ?? '';
      // last-reply cell wraps the date inside an <a>; textContent still works
      const lastReplyRaw = dateCells[1]?.textContent?.trim() ?? '';

      const authorCells = tr.querySelectorAll('td.title_12');
      const authorAnchor = authorCells[0]?.querySelector('a[href^="/user/query/"]');
      const author = (authorAnchor?.textContent ?? '').trim();

      const replyCountCell = tr.querySelector('td.title_11');
      const replyCountRaw = replyCountCell?.textContent?.trim() ?? '';

      out.push({
        articleId,
        titleHref,
        title,
        postedRaw,
        author,
        replyCountRaw,
        lastReplyRaw,
        isPinned,
      });
    }

    // Pagination: highest numeric value visible in `.page-main`.
    let totalPages = 1;
    const pageNodes = root.querySelectorAll('.page-main li');
    for (let i = 0; i < pageNodes.length; i++) {
      const n = parseInt((pageNodes[i]!.textContent ?? '').trim(), 10);
      if (Number.isFinite(n) && n > totalPages) totalPages = n;
    }

    return { rows: out, totalPages };
  }, { boardKey });

  const rows: ParsedThreadRow[] = [];
  for (const r of data.rows) {
    const url = `${baseUrl.replace(/\/+$/, '')}/article/${boardKey}/${r.articleId}`;
    const replyCount = (() => {
      const n = parseInt(r.replyCountRaw, 10);
      return Number.isFinite(n) ? n : undefined;
    })();
    const row: ParsedThreadRow = {
      articleId: r.articleId,
      boardKey,
      threadId: `${boardKey}/${r.articleId}`,
      url,
      title: r.title,
      isPinned: r.isPinned,
    };
    if (r.author) row.author = r.author;
    const postedAt = dateToIso(r.postedRaw);
    if (postedAt) row.postedAt = postedAt;
    const lastReplyAt = dateToIso(r.lastReplyRaw);
    if (lastReplyAt) row.lastReplyAt = lastReplyAt;
    if (replyCount !== undefined) row.replyCount = replyCount;
    rows.push(row);
  }

  return { rows, totalPages: data.totalPages };
}

/**
 * Adapter-level entry: convert ParsedThreadRow → ThreadSummary for the
 * SiteAdapter contract. The crawler-service uses the richer ParsedThreadRow
 * shape directly via fetchBoardPage; this is the legacy SiteAdapter path.
 */
export async function listThreads(page: Page, params: ListParams): Promise<ThreadSummary[]> {
  const boardKey = params.board;
  if (!boardKey) return [];
  const pageNum = params.page ?? 1;
  const { rows } = await fetchBoardPage(page, boardKey, pageNum);
  return rows.map((r) => {
    const s: ThreadSummary = {
      url: r.url,
      title: r.title,
      board: r.boardKey,
      raw: { threadId: r.threadId, articleId: r.articleId, isPinned: r.isPinned },
    };
    if (r.author) s.author = r.author;
    if (r.postedAt) s.postedAt = r.postedAt;
    if (r.lastReplyAt) s.lastReplyAt = r.lastReplyAt;
    if (r.replyCount !== undefined) s.replyCount = r.replyCount;
    return s;
  });
}
