# BBS_Crawler

基于 Playwright 的 MCP 服务，爬取论坛帖子并落库到本地 PostgreSQL。作为 **BBS Agent of BYR** 项目的数据摄取层。

> 状态：**稳定可用，生产就绪**——完整 `school-bbs` 生命周期实现，4 个 MCP tool 工作正常，所有 smoke test 已通过。English version: [`README.md`](README.md)。

## 它做什么

- 暴露 4 个高层 MCP tool（`forum_list_sites` / `forum_list_threads` / `forum_get_thread` / `forum_session_status`），供自定义 agent 按需爬取论坛内容。
- 通过 Playwright 驱动真实 Chromium 浏览器，拿到登录后才可见的页面。
- 用 Playwright 的 `storageState` 持久化登录会话——agent 不需要每次都重新提交账密。
- 可选的本地加密凭据缓存（AES-256-GCM）：cookie 失效时不强迫用户手动重登（前提是登录时选择了"记住密码"）。
- 爬到的内容**总是**写入嵌入式 PGlite。`threads` 单表通过 `is_pinned` 字段区分初始化时抓的置顶帖与按需爬的日常帖；`board_crawl_state` 记录每个版面的爬取进度，支持 agent 增量只拉新帖。
- 下游查询 / RAG / embedding 由独立的 [`BBS_Database`](https://github.com/VeinsureLee/BBS_Database) 项目负责——本 MCP 只爬取与持久化。
- 站点适配器可插拔：内置 `school-bbs` 适配器；新站点只需在 `src/adapters/<site>/` 下加一个文件。

## 在生态里的位置

| 仓库 | 职责 |
|---|---|
| [`BBS_Crawler`](https://github.com/VeinsureLee/BBS_Crawler)（本仓库） | 浏览器爬虫 + MCP 服务，写 PostgreSQL |
| [`BBS_Database`](https://github.com/VeinsureLee/BBS_Database) | 存储栈：PostgreSQL（原文）+ Chroma（向量）+ Neo4j（关系） |
| [`BBS_Agent`](https://github.com/VeinsureLee/BBS_Agent) | 多索引 RAG agent，消费本 MCP 并查询数据库 |

本爬虫**拥有**论坛内容的 PostgreSQL schema。`BBS_Database` 读同一个 PostgreSQL，下游做 embedding / 图索引。

## 技术栈

- TypeScript（Node 20+）
- [Playwright](https://playwright.dev/)（仅 chromium）
- [PGlite](https://pglite.dev/)（嵌入式 PostgreSQL，无需外部数据库）
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)（stdio 传输）
- `zod` 做 env / 入参校验，`pino` 做结构化日志

## 快速开始

```bash
# 1. 安装依赖
npm install
npx playwright install chromium

# 2. 配置环境
cp .env.example .env
# 填入 SCHOOL_BBS_USERNAME、SCHOOL_BBS_PASSWORD、SCHOOL_BBS_BASE_URL
# （PGDATA_DIR 可选，默认 ./.pgdata）

# 3. 首次登录（保存 storageState；询问是否记住密码）
npm run login school-bbs

# 4. 初始化论坛结构（一次性）
npm run init:sections school-bbs
npm run init:boards school-bbs
npm run init:pinned school-bbs

# 5. 启动 MCP 服务（stdio）
# 日常使用推荐 `npm run dev`（用 tsx）；`npm run start`（node dist）需要先 build
npm run dev

# 可选：运行完整 end-to-end smoke test 验证一切正常
npx tsx scripts/debug/smoke-mcp.ts
```

登录脚本会问 `Remember password? (y/N)`：
- 选 `y` → 凭据用 AES-256-GCM 加密写到 `./.state/<siteKey>.credentials.enc`（mode 0600）。之后 cookie 失效时，auth manager 会自动用缓存凭据重登，agent 完全感知不到 `SESSION_EXPIRED`。
- 选 `N` → 仅 cookie 模式，会话失效时手动再跑一次 `npm run login`。

接入 Claude Code / Claude Desktop / 自定义 agent 时，把它作为 stdio MCP 服务注册即可。`claude_desktop_config.json` 配置片段示例：

```json
{
  "mcpServers": {
    "bbs-crawler": {
      "command": "node",
      "args": ["d:/MyProject/Python_Project/BBS_Crawler/dist/index.js"],
      "env": {
        "SCHOOL_BBS_USERNAME": "...",
        "SCHOOL_BBS_PASSWORD": "...",
        "SCHOOL_BBS_BASE_URL": "..."
      }
    }
  }
}
```

## MCP tool 列表

| Tool | 用途 |
|---|---|
| `forum_list_sites` | 查询已注册的站点适配器 |
| `forum_list_threads` | 按版面**精确名称**爬取帖子（增量或翻页两种模式） |
| `forum_get_thread` | 取单帖完整内容（含全部楼层） |
| `forum_session_status` | 查看某站点的登录状态 |

`forum_search` / `forum_query_cache` / `forum_relogin` 已被移除——搜索/缓存查询由 [`BBS_Database`](https://github.com/VeinsureLee/BBS_Database) 项目负责；重登在凭据缓存可用时自动发生。

### 回包结构

4 个工具统一返回如下 JSON envelope（包成 MCP 单 `text` content）：

```jsonc
// 成功
{
  "ok": true,
  "data": <工具特定的数据>,
  "nextCursor": { "startPage": 4 } | null,   // 仅 forum_list_threads
  "state": {                                  // 仅 forum_list_threads
    "deepestPageCrawled": 12,
    "latestThreadPostedAt": "2026-05-08T03:14:00Z",
    "lastCrawledAt": "2026-05-08T10:23:00Z"
  }
}

// 失败
{
  "ok": false,
  "error": { "code": "SESSION_EXPIRED" | "LOGIN_FAILED" | "BOARD_NOT_FOUND" | "FETCH_FAILED",
             "message": "..." }
}
```

不产生 `nextCursor` / `state` 的工具不会带这两个字段。

### `forum_list_threads`

```ts
forum_list_threads({
  siteKey: string,
  boardName: string,                       // 严格等值匹配 boards.name
  mode?: 'incremental' | 'pages',          // 默认 'incremental'
  pages?: number,                          // 'pages' 模式生效；默认 3
  cursor?: { startPage: number }           // 'pages' 模式续翻
})
```

- **`incremental`**（默认）：从第 1 页开始抓，遇到 `posted_at <= 已存 watermark` 的帖子即停。**置顶帖不会触发停止**，也**不参与 watermark 推进**（它们的日期是任意旧值）。日常"看看有没有新帖"用这个。
- **`pages`**：从 `cursor.startPage`（默认 1）开始抓 `pages` 页。回包带 `nextCursor`，agent 可以继续往历史里翻。想找更早的老帖用这个。

每条结果的 `raw.threadId` 是形如 `"{boardKey}/{articleId}"` 的不透明字符串——直接传回给 `forum_get_thread`。

### `forum_get_thread`

```ts
forum_get_thread({ siteKey: string, threadId: string })   // threadId = "{boardKey}/{articleId}"
```

## 配置

所有敏感信息只走环境变量。常用项：

| 变量 | 说明 |
|---|---|
| `PGDATA_DIR` | PGlite 数据存储目录（默认 `./.pgdata`） |
| `{SITE_KEY_UPPER}_USERNAME` / `_PASSWORD` / `_BASE_URL` | 每个站点的凭据和地址，如 `SCHOOL_BBS_USERNAME` |
| `BROWSER_HEADLESS` | 调试时设 `false`（默认 `true`） |
| `RATE_MIN_INTERVAL_MS` / `RATE_JITTER_MS` / `RATE_MAX_CONCURRENCY` | 每站点的礼貌策略（默认 1500 / 1000 / 1） |
| `STORAGE_STATE_DIR` | `storageState.json` 与 `*.credentials.enc` 的目录（默认 `./.state`） |
| `CRED_KEY` | 可选。凭据加密的 AES key 派生种子。未设置时使用主机名派生的种子（单机使用足够）。 |
| `LOG_LEVEL` | `debug` 时启用失败截图，写到 `./.state/debug/` |

`.env` 和 `./.state/` 都在 `.gitignore` 中。仓库只提交 `.env.example`。

## 新增站点

1. 新建 `src/adapters/<site-key>/index.ts`，导出符合 `SiteAdapter` 接口的对象（见 [`src/core/site-adapter.ts`](src/core/site-adapter.ts)）。
2. 实现 `isLoggedIn`、`login`、`listThreads`、`getThread`、`search`。辅助文件放在同目录（`selectors.ts`、`login.ts` 等）。
3. 在 [`src/adapters/index.ts`](src/adapters/index.ts) 加一行 `import './<site-key>'`，触发 side-effect 注册。
4. 在 `tests/fixtures/<site-key>/` 加 HTML 快照和集成测试。
5. 把所需 env 变量（`<SITE_KEY_UPPER>_USERNAME` 等）补到 `.env.example`。

框架已经包办了浏览器池、会话持久化、限速、重试、写库——adapter 只负责把页面转换成结构化的 `Thread` / `ThreadSummary`。

## 目录结构

```
src/
  server/            MCP tool 注册 + JSON Schema
  core/              编排层：registry / crawler-service / auth / browser pool / rate limiter
  repository/        所有 SQL（不引 ORM）
  adapters/          每个站点一个文件夹
migrations/          node-pg-migrate 的 SQL 文件
tests/fixtures/      脱敏 HTML 快照，驱动 adapter 集成测试
scripts/             一次性 CLI 工具（login-once、inspect）
```

## 脚本说明

### 认证脚本

| 脚本 | 用途 | 使用方法 |
|---|---|---|
| `login` | 交互式登录并保存 storageState | `npm run login [siteKey]` |
| `login:once` | 非交互式登录（需要已设置环境变量） | `npm run login:once [siteKey]` |

### 初始化脚本（针对 school-bbs）

按顺序运行以探索并持久化论坛结构：

| 脚本 | 用途 | 使用方法 |
|---|---|---|
| `init:sections` | 从首页爬取顶层分区并持久化到数据库 | `npm run init:sections [siteKey]` |
| `init:boards` | 对每个分区，爬取其二级分区和版面并持久化 | `npm run init:boards [siteKey]` |
| `init:pinned` | 对每个版面，发现置顶帖并爬取完整内容（含回复） | `npm run init:pinned [siteKey] [--limit N] [--concurrency K] [--skip-done]` |

注意：`init:pinned` 有智能重试机制：在并发爬取时失败的版面会在主轮次结束后，以单线程（concurrency=1）顺序重试，最多重试 3 轮。

### 爬取脚本

| 脚本 | 用途 | 使用方法 |
|---|---|---|
| `crawl:board` | 爬取某个版面页面并保存原始 HTML 供分析 | `npx tsx scripts/crawl/crawl-board.ts <boardPath>` |
| `crawl:section` | 爬取某个分区页面并保存原始 HTML 供分析 | `npx tsx scripts/crawl/crawl-section.ts <sectionPath>` |
| `crawl:pinned` | 爬取某个版面的置顶帖并保存原始 HTML | `npx tsx scripts/crawl/crawl-pinned.ts <boardKey>` |
| `crawl:board-skip` | 带跳过逻辑的版面爬取（自定义行为） | `npx tsx scripts/crawl/crawl-board-with-skip.ts` |

### 调试脚本

| 脚本 | 用途 | 使用方法 |
|---|---|---|
| `debug:board` | 交互式调试某个版面页面 | `npx tsx scripts/debug/debug-board.ts` |
| `debug:failed-boards` | 探索爬取失败的版面 | `npx tsx scripts/debug/explore-failed-boards.ts` |
| `debug:find-thread` | 查找并检查特定帖子 | `npx tsx scripts/debug/find-thread.ts` |
| `debug:inspect` | 交互式检查论坛 | `npx tsx scripts/debug/inspect-forum.ts` |
| `explore` | 通用探索工具 | `npx tsx scripts/util/explore.ts` |

### 数据库脚本

| 脚本 | 用途 | 使用方法 |
|---|---|---|
| `db:check` | 验证数据库连接和 schema | `npm run db:check` |
| `db:migrate:up` | 运行待处理的数据库迁移 | `npm run db:migrate:up` |
| `db:migrate:down` | 回滚上一个迁移 | `npm run db:migrate:down` |
| `db:migrate:status` | 显示迁移状态 | `npm run db:migrate:status` |
| `db:delete-pinned` | 删除置顶帖记录（用于重新爬取） | `npm run db:delete-pinned` |

### 工具脚本

| 脚本 | 用途 | 使用方法 |
|---|---|---|
| `format:html` | 格式化原始 HTML 文件以提高可读性 | `npx tsx scripts/util/format-html.ts <file.html>` |

## Roadmap

已完成：

- 登录 + 会话持久化（`storageState.json`）
- 加密"记住密码"凭据缓存 + 自动重登
- 论坛结构爬取（分区 / 二级分区 / 版面 / 置顶帖）
- `forum_list_threads` 的 `incremental` / `pages` 双模式 + 每版面爬取进度跟踪（`board_crawl_state` 表）
- `forum_get_thread` 通过复合 `{boardKey}/{articleId}` 标识取帖
- 4 个稳定的错误码（`SESSION_EXPIRED` / `LOGIN_FAILED` / `BOARD_NOT_FOUND` / `FETCH_FAILED`）
- **首次 MCP 工具调用时自动触发初始化**（无需手动 `npm run init:*`）
- 扩展 `school-bbs` 日期解析器（支持 `MM-DD`、`HH:MM`、`今天/昨天/前天`、`N天前`）
- 修复：storageState 路径对齐、置顶帖识别、日期解析（smoke test 发现的 bug）

下一步：

- 修复 `tests/unit/repository/**` 单元测试套件（PGlite 迁移后被排除，需要重写）

v1 范围外（已显式延后）：验证码 / SSO / 2FA、低层 `browser_*` MCP tool、`school-bbs` 之外的更多站点、中文分词 FTS、定时调度器、分布式部署、MCP 内的搜索/缓存读取工具（由 `BBS_Database` 负责）。

## 隐私

- 源码、测试中绝不出现明文 URL / 账号 / 密码；`.env` 在 `.gitignore` 中。
- Logger 在写日志时自动脱敏已注册的凭据字符串。
- `storageState.json`（含 cookie）写盘后 chmod 0600（Windows 上尽力而为），不进 git。

## License

TBD。
