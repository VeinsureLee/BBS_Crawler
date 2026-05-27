/**
 * BBS Crawler Library
 *
 * A library for crawling BBS forums, providing:
 *  - Site adapter interface
 *  - Crawler service with retries and auth
 *  - SQLite persistence for structure and content
 *  - Forum structure export/import
 */

// Core types
export type {
  SiteAdapter,
  LoginCredentials,
  ListParams,
  GetThreadParams,
  ThreadSummary,
  Thread,
  Post,
  PostAttachment,
  SectionSummary,
  BoardSummary,
  BoardStats,
  SectionChildren,
} from './contract/site-adapter.js';

// Core services
export { CrawlerService } from './service/crawler-service.js';
export type {
  CrawlerServiceDeps,
  FetchThreadInput,
  FetchThreadOutput,
  ListThreadsByNameInput,
  ListThreadsByNameOutput,
  FetchThreadByIdInput,
} from './service/crawler-service.js';
export {
  runInitSections,
  runInitBoards,
  runInitPinned,
  runRefreshBoardStats,
} from './service/init-runners.js';
export type {
  RefreshBoardStatsOpts,
  RefreshBoardStatsResult,
} from './service/init-runners.js';
export { AuthManager } from './session/auth-manager.js';
export { BrowserPool } from './session/browser-pool.js';
export { createRateLimiter } from './session/rate-limiter.js';
export { listAdapters, getAdapter } from './registry.js';
export { parseConfig } from './config/app-config.js';

// Errors
export {
  BaseAppError,
  MissingCredentialsError,
  LoginFailedError,
  SessionExpiredError,
  NavigationTimeoutError,
  RateLimitedError,
  SelectorMissingError,
  UnknownSiteError,
  DatabaseError,
  BoardNotFoundError,
  FetchFailedError,
} from './errors.js';

// Database
export {
  initDb,
  getStructureDb,
  getBoardDb,
  getDataDir,
  closeAllDbs,
  STRUCTURE_SCHEMA,
  BOARD_SCHEMA,
} from './repository/db.js';
export type { Db, DbConfig } from './repository/db.js';

// Repositories
export { upsertSite } from './repository/sites.js';
export type { SiteRow } from './repository/sites.js';
export { hasSections, sectionsMissingBoards, listTopLevelSections, upsertSection, safeFileName } from './repository/sections.js';
export type { UpsertSectionInput, UpsertSectionResult, SectionRow } from './repository/sections.js';
export {
  boardsMissingPinned,
  listBoards,
  upsertBoard,
  resolveBoardRoute,
  findBoardDbPath,
} from './repository/boards.js';
export type { UpsertBoardInput, UpsertBoardResult, BoardRow } from './repository/boards.js';
export {
  upsertThread,
  upsertThreadSummary,
  checkThreadExists,
  getCrawledThreadUrls,
  shouldSkipFetch,
} from './repository/threads.js';
export type {
  UpsertThreadOpts,
  UpsertThreadResult,
  ThreadExistsResult,
  FetchSkippedResult,
} from './repository/threads.js';
export { upsertPosts } from './repository/posts.js';
export { getBoardCrawlState, upsertBoardCrawlState } from './repository/board-crawl-state.js';
export type { BoardCrawlState, UpsertBoardCrawlStateInput } from './repository/board-crawl-state.js';
export {
  upsertDailyTraffic,
  getDailyTrafficForDate,
  getLatestDailyTraffic,
  beijingDate,
} from './repository/daily-traffic.js';
export type { DailyTrafficRow } from './repository/daily-traffic.js';
export { appendFetchLog } from './repository/fetch-log.js';
export type { FetchLogRow, FetchLogStatus } from './repository/fetch-log.js';
export { findBoardByName, getBoardById } from './repository/boards-lookup.js';

// Export forum structure
export { exportForumStructure, loadForumStructure } from './export/exporter.js';
export type {
  ForumStructure,
  SiteInfo,
  SectionStructure,
  BoardStructure,
  PinnedThreadInfo,
} from './export/types.js';

// Utils
export { logger, addRedactedSecret, appLogPath } from './util/logger.js';
export { retry } from './util/retry.js';
