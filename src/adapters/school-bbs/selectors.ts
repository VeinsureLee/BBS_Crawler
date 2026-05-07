/**
 * CSS selectors for school-bbs pages.
 * Update these as we analyze the page structure.
 */
export const selectors = {
  // Login page
  loginForm: 'form',
  usernameInput: 'input[name="id"]',
  passwordInput: 'input[name="passwd"]',
  submitButton: 'input[type="submit"]',

  // Logged-in indicator
  userInfo: '.nav-item.user-info, .user-panel',

  // Board/section listing
  boardLinks: 'a[href*="board"]',
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
};
