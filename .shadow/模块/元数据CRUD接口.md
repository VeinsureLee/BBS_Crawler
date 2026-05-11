# 模块：元数据 CRUD 接口

> 项目把数据爬下来存好之后，**外部怎么读、怎么改？** 这块就是答案——一组对外暴露的函数（不是 HTTP API，是 TypeScript 函数），覆盖增/查/改的常用场景。删除一般不做（数据是只增不删的）。

## 谁来调这些函数？

- 同进程内：本项目的脚本（`scripts/`）、`CrawlerService` 内部、未来的 ops/queue 任务。
- 同进程外：**主要是将来的 MCP 项目**——它会 `import { ... } from 'bbs-crawler'`，把本项目当库用。

所以"对外暴露"就是 [src/index.ts](../../src/index.ts) 里 `export` 出去的那一份。

## 接口分类

按数据 entity 分组。每组列：函数名、签名、用途、对应的 repository 文件。

### 站点（sites）

唯一一张本项目级元信息表（站点 displayName / baseUrl）。

| 函数 | 签名 | 用途 |
|---|---|---|
| `upsertSite` | `(row: SiteRow) => Promise<void>` | 注册/更新一个 site（一般 adapter 自己跑 init 时调） |

文件：[src/repository/sites.ts](../../src/repository/sites.ts)。

### 讨论区（sections / 目标：nodes）

| 函数 | 签名 | 用途 |
|---|---|---|
| `hasSections` | `(siteKey) => Promise<boolean>` | 这个 site 有没有讨论区数据（用于 init 检测） |
| `listTopLevelSections` | `(siteKey) => Promise<SectionRow[]>` | 列所有顶级讨论区 |
| `sectionsMissingBoards` | `(siteKey) => Promise<SectionRow[]>` | 找出"没爬到任何版面"的讨论区（用于续跑） |
| `upsertSection` | `(input: UpsertSectionInput) => Promise<{ sectionId }>` | 写入/更新一个讨论区 |

文件：[src/repository/sections.ts](../../src/repository/sections.ts)。

### 版面（boards / nodes 表 type='board'）

| 函数 | 签名 | 用途 |
|---|---|---|
| `listBoards` | `(siteKey) => Promise<BoardRow[]>` | 列所有版面节点 |
| `boardsMissingPinned` | `(siteKey) => Promise<BoardRow[]>` | 找出"还没有置顶帖"的版面（跨 forum db 扫描 is_pinned=1） |
| `upsertBoard` | `(input: UpsertBoardInput) => Promise<{ boardId }>` | 写/更新 board 节点；moderators/stats 直接落 nodes 行 |
| `findBoardByName` | `(siteKey, name) => Promise<BoardRow \| null>` | 按中文名找版面（精确匹配） |
| `getBoardById` | `(boardId) => Promise<BoardRow \| null>` | 按 nodes.id 拿版面 |
| `resolveBoardRoute` | `(siteKey, boardKey) => Promise<{ boardNodeId, forumDbFile }>` | 路由：boardKey → 节点 id + 所在 forum 文件 |
| `findForumDbFileForBoard` | `(boardNodeId) => Promise<string \| null>` | 通过 nodes.id 递归上行找 forum.db_file |

文件：[src/repository/boards.ts](../../src/repository/boards.ts) + [src/repository/boards-lookup.ts](../../src/repository/boards-lookup.ts)。

### 帖子（threads，存在 forum db 中）

| 函数 | 签名 | 用途 |
|---|---|---|
| `checkThreadExists` | `(siteKey, boardKey, url) => Promise<ThreadExistsResult>` | URL 在不在库里 + 上次抓的元信息 |
| `getCrawledThreadUrls` | `(siteKey, boardKey) => Promise<Set<string>>` | 单版面的已爬 URL（去重用） |
| `shouldSkipFetch` | `(siteKey, boardKey, url, summaryReplyCount?, freshnessHours?) => Promise<FetchSkippedResult>` | 判定是否跳过这次抓取 |
| `upsertThread` | `(siteKey, t: Thread, options?) => Promise<{ threadId, forumDb }>` | 写完整帖子。返回值含 forumDb，**调用方应紧接着喂给 upsertPosts** |
| `upsertThreadSummary` | `(siteKey, s: ThreadSummary, options?) => Promise<{ threadId, forumDb }>` | 仅列表层写入（不带 posts） |

文件：[src/repository/threads.ts](../../src/repository/threads.ts)。

**关键变化**：所有需要找到帖子位置的函数（check / skip / urls）**新增 `boardKey` 必填参数**——分层之后必须知道帖子在哪个 forum db。

**`is_pinned` 的 OR 合并语义**：版面列表里看到的帖子，如果 DB 里已经被 `init:pinned` 标记为 pinned，**不会被新一次 upsert 抹掉**——SQL 是 `is_pinned = is_pinned OR $9`。

### 楼层（posts，存在 forum db 中）

| 函数 | 签名 | 用途 |
|---|---|---|
| `upsertPosts` | `(forumDb, threadId, posts: Post[]) => Promise<void>` | 批量写入楼层（事务包裹）。**首个参数是 forumDb 句柄**，从 upsertThread 拿到 |

文件：[src/repository/posts.ts](../../src/repository/posts.ts)。

**用法示例**：

```typescript
const { threadId, forumDb } = await upsertThread(siteKey, thread, { isPinned: true });
await upsertPosts(forumDb, threadId, thread.posts);
```

### 爬取进度（board_crawl_state）

| 函数 | 签名 | 用途 |
|---|---|---|
| `getBoardCrawlState` | `(boardId) => Promise<BoardCrawlState \| null>` | 读 watermark + 最深页 + 最近爬取时间 |
| `upsertBoardCrawlState` | `(input) => Promise<void>` | 写进度（数值字段 max 合并、时间字段保留最大） |

文件：[src/repository/board-crawl-state.ts](../../src/repository/board-crawl-state.ts)。

### 调用审计（fetch_log）

| 函数 | 签名 | 用途 |
|---|---|---|
| `appendFetchLog` | `(row: FetchLogRow) => Promise<void>` | 记一次外部调用 |

文件：[src/repository/fetch-log.ts](../../src/repository/fetch-log.ts)。注意这是审计日志，不是运行日志（见 [日志.md](日志.md)）。

### 业务层（CrawlerService）

上面那些是底层 repository。业务层在 [src/core/crawler-service.ts](../../src/core/crawler-service.ts) 把它们组合成"对外能用的工具"：

| 方法 | 干什么 |
|---|---|
| `fetchThread({ siteKey, url, maxReplies?, persist? })` | 抓单帖（含分页楼层），可选落库 |
| `listThreads({ siteKey, board?, page?, pageSize?, persist? })` | 版面翻一页（按 boardKey） |
| `listThreadsByName({ siteKey, boardName, mode?, pages?, cursor? })` | 按版面**中文名**爬取（增量/固定页数），自动维护 watermark |
| `fetchThreadById({ siteKey, threadId, maxReplies? })` | 按 `"{boardKey}/{articleId}"` 抓单帖 |
| `search({ siteKey, keyword, page? })` | 站内搜索（目前 stub） |

这些方法都经过 `run()` 包装——自动登录、限速、重试、记 fetch_log。

### 初始化（编排器）

| 方法 | 干什么 |
|---|---|
| `new InitOrchestrator(deps)` | 构造，注入依赖（hasSections 等查询函数 + runInitSections / runInitBoards / runInitPinned + runWithPage） |
| `.ensureInitialized(siteKey)` | 触发懒初始化（per-siteKey 互斥 + 缓存） |
| `.reset(siteKey?)` | 强制下次再 init |

文件：[src/core/init-orchestrator.ts](../../src/core/init-orchestrator.ts) + 三个 runner 在 [init-runners.ts](../../src/core/init-runners.ts)。

## 调用方约定

将来 MCP 项目作为消费方时，推荐 pattern：

```typescript
import {
  initDbs,
  CrawlerService,
  InitOrchestrator,
  BrowserPool,
  AuthManager,
  createRateLimiter,
  getAdapter,
  parseConfig,
} from 'bbs-crawler';
import 'bbs-crawler/dist/adapters';   // 触发 adapter 注册

const appConfig = parseConfig(process.env);
initDbs({ dataDir: appConfig.dataDir });

const browserPool = new BrowserPool({ /* ... */ });
const auth = new AuthManager({ /* ... */ });
const rateLimiter = createRateLimiter({ /* ... */ });

const crawler = new CrawlerService({
  browserPool, auth, rateLimiter,
  registry: { getAdapter },
  persistThread: async (siteKey, thread) => {
    const { threadId } = await upsertThread(siteKey, thread);
    await upsertPosts(threadId, thread.posts);
    return threadId;
  },
  appendFetchLog,
  initOrchestrator,
});

// 用：
const result = await crawler.listThreadsByName({
  siteKey: 'school-bbs',
  boardName: '北邮人在上海',
});
```

注意点：

- `initDbs` 必须在第一次 repository 调用之前完成，否则 `getStructureDb` / `getContentDb` 抛 `DatabaseError('initDbs has not been called')`。
- adapter 注册靠 side-effect import，**不要忘了**那一行。
- `BrowserPool` / `AuthManager` 都是异步释放型资源——进程退出前调 `browserPool.close()`、`closeDbs()`。

## 完整导出清单

参见 [src/index.ts](../../src/index.ts)。所有 `export` 都是稳定 API；标注 `@deprecated` 的不要用（`initDb` / `getDb` / `closeDb` 是迁移单库到双库时留下的兼容壳）。

## 相关代码

- [src/index.ts](../../src/index.ts) — 唯一的对外入口（所有 `export`）。
- [src/repository/sites.ts](../../src/repository/sites.ts) / [sections.ts](../../src/repository/sections.ts) / [boards.ts](../../src/repository/boards.ts) / [threads.ts](../../src/repository/threads.ts) / [posts.ts](../../src/repository/posts.ts) — 各 entity CRUD。
- [src/repository/boards-lookup.ts](../../src/repository/boards-lookup.ts) — 按 name/id 查 board。
- [src/repository/board-crawl-state.ts](../../src/repository/board-crawl-state.ts) — 爬取进度。
- [src/repository/fetch-log.ts](../../src/repository/fetch-log.ts) — 调用审计。
- [src/core/crawler-service.ts](../../src/core/crawler-service.ts) — 业务层组合。
- [src/core/init-orchestrator.ts](../../src/core/init-orchestrator.ts) + [src/core/init-runners.ts](../../src/core/init-runners.ts) — init 编排 + runner。
- [src/core/registry.ts](../../src/core/registry.ts) — `getAdapter(siteKey)`。
