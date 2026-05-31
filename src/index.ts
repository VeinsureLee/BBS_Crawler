/**
 * BBS Crawler Library — public surface.
 *  ① 装配  ② 抓取用例  ③ 读/查询  ④ 持久化  ⑤ 基础设施  ⑥ 导出/错误/类型
 */

// ① 装配
export { createCrawler } from './service/factory.js';
export type { Crawler, CrawlerConfig } from './service/factory.js';
export { CrawlerRuntime } from './service/runtime.js';
export type { CrawlerRuntimeOptions } from './service/runtime.js';
export type { AuthStatus, WarmUpResult } from './service/session-ops.js';

// ② 抓取用例
export { CrawlerService } from './service/crawler-service.js';
export type {
  CrawlerServiceDeps,
  FetchThreadInput, FetchThreadOutput,
  ListThreadsByNameInput, ListThreadsByNameOutput,
  FetchThreadByIdInput,
} from './service/crawler-service.js';
export {
  runInitSections, runInitBoards, runInitPinned, runRefreshBoardStats,
} from './service/init-runners.js';
export type {
  InitOpts, InitProgressEvent, InitStage,
  RunInitSectionsResult, RunInitBoardsResult, RunInitPinnedResult,
  RefreshBoardStatsOpts, RefreshBoardStatsResult,
} from './service/init-runners.js';
export { BrowserDeadError } from './service/page-pool.js';
export type { PoolDeps, PoolProgressEvent, PoolItemResult, WorkerCtx } from './service/page-pool.js';

// ③ 读 / 查询 API
export {
  listSites, listSections, listBoards, getSectionDetail,
  listThreadsByBoard, getThreadByUrl, searchThreadsByTitle,
  findBoardByName, getBoardById,
} from './read/readers.js';
export type {
  SiteInfo, SectionInfo, BoardInfo, ThreadRow, PostRow,
  ThreadsByBoardOpts, SectionDetail, SectionDetailBoard,
} from './read/readers.js';

// ④ 持久化（进阶）
// Repository input/result types (e.g. UpsertBoardInput, BoardCrawlState) are intentionally NOT public — consumers use the functions, not these internal bags.
export {
  initDb, getStructureDb, getBoardDb, getDataDir, closeAllDbs,
  STRUCTURE_SCHEMA, BOARD_SCHEMA,
} from './repository/db.js';
export type { Db, DbConfig } from './repository/db.js';
export { upsertSite } from './repository/sites.js';
export type { SiteRow } from './repository/sites.js';
export { hasSections, sectionsMissingBoards, listTopLevelSections, upsertSection, safeFileName } from './repository/sections.js';
export type { SectionRow } from './repository/sections.js';
export { boardsMissingPinned, upsertBoard, resolveBoardRoute, findBoardDbPath } from './repository/boards.js';
export type { BoardRow } from './repository/boards.js';
export { upsertThread, upsertThreadSummary, checkThreadExists, getCrawledThreadUrls, shouldSkipFetch } from './repository/threads.js';
export { upsertPosts } from './repository/posts.js';
export { getBoardCrawlState, upsertBoardCrawlState } from './repository/board-crawl-state.js';
export { upsertDailyTraffic, getDailyTrafficForDate, getLatestDailyTraffic, beijingDate } from './repository/daily-traffic.js';
export type { DailyTrafficRow } from './repository/daily-traffic.js';
export { appendFetchLog } from './repository/fetch-log.js';
export type { FetchLogRow, FetchLogStatus } from './repository/fetch-log.js';

// ⑤ 基础设施
export { BrowserPool } from './session/browser-pool.js';
export { AuthManager } from './session/auth-manager.js';
export { createRateLimiter } from './session/rate-limiter.js';
export { getAdapter, listAdapters } from './registry.js';
export { parseConfig } from './config/app-config.js';
export { loadAndResolvePaths, bundledSiteConfigDir } from './config/paths.js';
export type { PathOptions, ResolvedPaths } from './config/paths.js';

// ⑥ 导出/导入 + 错误 + 类型
export { exportForumStructure, loadForumStructure } from './export/exporter.js';
export type { ForumStructure, SiteInfo as ExportSiteInfo, SectionStructure, BoardStructure, PinnedThreadInfo } from './export/types.js';
export {
  BaseAppError, MissingCredentialsError, LoginFailedError, SessionExpiredError,
  NavigationTimeoutError, RateLimitedError, SelectorMissingError, UnknownSiteError,
  DatabaseError, BoardNotFoundError, FetchFailedError,
} from './errors.js';
export { logger, addRedactedSecret, appLogPath } from './util/logger.js';
export { retry } from './util/retry.js';
export { classifyError } from './error-classify.js';
export type { ErrorKind, ErrorClassification } from './error-classify.js';
export type {
  SiteAdapter, LoginCredentials, ListParams, GetThreadParams,
  ThreadSummary, Thread, Post, PostAttachment,
  SectionSummary, BoardSummary, BoardStats, SectionChildren,
} from './contract/site-adapter.js';
