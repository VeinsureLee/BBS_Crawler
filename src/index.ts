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
  SearchParams,
  ThreadSummary,
  Thread,
  Post,
  PostAttachment,
  SectionSummary,
  BoardSummary,
  BoardStats,
  SectionChildren,
} from './core/site-adapter';

// Core services
export { CrawlerService } from './core/crawler-service';
export type {
  CrawlerServiceDeps,
  FetchThreadInput,
  FetchThreadOutput,
  ListThreadsInput,
  ListThreadsOutput,
  SearchInput,
  SearchOutput,
  ListThreadsByNameInput,
  ListThreadsByNameOutput,
  FetchThreadByIdInput,
} from './core/crawler-service';
export { InitOrchestrator } from './core/init-orchestrator';
export type { InitOrchestratorDeps } from './core/init-orchestrator';
export {
  runInitSections,
  runInitBoards,
  runInitPinned,
  runRefreshBoardStats,
} from './core/init-runners';
export type {
  RefreshBoardStatsOpts,
  RefreshBoardStatsResult,
} from './core/init-runners';
export { AuthManager } from './core/auth-manager';
export { BrowserPool } from './core/browser-pool';
export { createRateLimiter } from './core/rate-limiter';
export { listAdapters, getAdapter } from './core/registry';
export { parseConfig } from './core/config';

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
} from './core/errors';

// Database
export {
  initDb,
  getStructureDb,
  getBoardDb,
  getDataDir,
  closeAllDbs,
  STRUCTURE_SCHEMA,
  BOARD_SCHEMA,
} from './repository/db';
export type { Db, DbConfig } from './repository/db';

// Repositories
export { upsertSite } from './repository/sites';
export type { SiteRow } from './repository/sites';
export { hasSections, sectionsMissingBoards, listTopLevelSections, upsertSection, safeFileName } from './repository/sections';
export type { UpsertSectionInput, UpsertSectionResult, SectionRow } from './repository/sections';
export {
  boardsMissingPinned,
  listBoards,
  upsertBoard,
  resolveBoardRoute,
  findBoardDbPath,
} from './repository/boards';
export type { UpsertBoardInput, UpsertBoardResult, BoardRow } from './repository/boards';
export {
  upsertThread,
  upsertThreadSummary,
  checkThreadExists,
  getCrawledThreadUrls,
  shouldSkipFetch,
} from './repository/threads';
export type {
  UpsertThreadOpts,
  UpsertThreadResult,
  ThreadExistsResult,
  FetchSkippedResult,
} from './repository/threads';
export { upsertPosts } from './repository/posts';
export { getBoardCrawlState, upsertBoardCrawlState } from './repository/board-crawl-state';
export type { BoardCrawlState, UpsertBoardCrawlStateInput } from './repository/board-crawl-state';
export {
  upsertDailyTraffic,
  getDailyTrafficForDate,
  getLatestDailyTraffic,
  beijingDate,
} from './repository/daily-traffic';
export type { DailyTrafficRow } from './repository/daily-traffic';
export { appendFetchLog } from './repository/fetch-log';
export type { FetchLogRow, FetchLogStatus } from './repository/fetch-log';
export { findBoardByName, getBoardById } from './repository/boards-lookup';

// Export forum structure
export { exportForumStructure, loadForumStructure } from './export/exporter';
export type {
  ForumStructure,
  SiteInfo,
  SectionStructure,
  BoardStructure,
  PinnedThreadInfo,
} from './export/types';

// Utils
export { logger, addRedactedSecret, appLogPath } from './util/logger';
export { retry } from './util/retry';
