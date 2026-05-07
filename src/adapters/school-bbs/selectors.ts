/**
 * CSS selectors for school-bbs pages.
 * Update these as we analyze the page structure.
 */
export const selectors = {
  // Login-related selectors have moved to ./ui-elements.ts (ui.login).
  userName: '.u-login-id a',

  // Section/board navigation
  sectionLinks: '#xlist a[href*="/section/"]',
  boardLinks: '#xlist a[href*="/board/"]',

  // Board/section listing
  threadRows: 'tr[class*="thread"]',

  // Thread list (board page)
  threadTitle: 'td.title a',
  threadAuthor: 'td.author',
  threadReplyCount: 'td.count',
  threadLastUpdate: 'td.time',

  // Thread detail page
  postContainer: '.post, .article, div[class*="post"]',
  postFloor: '.floor-num, .position',
  postAuthor: '.user-name, .author',
  postTime: '.post-time, .time',
  postContent: '.content, .article-content',
  postLikes: '.like, .upvote',

  // Pagination
  nextPageLink: 'a.next, a[rel="next"]',
  pageLinks: '.pagination a',

  // Widgets on homepage
  widgetList: '.w-list-line li a',
};
