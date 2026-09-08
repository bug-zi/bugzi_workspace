# 信息源 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/信息源/design.md`（260908 brainstorming 定稿并立项）生成，是开发的直接依据。设计全记录（七项决策与被否方案）见同目录 `archive/2026-09-08-信息源-design.md`。依赖：样式/designs-specs.md（ConfirmDialog / GoConfigDialog / Toast 与主题色系、Material Symbols 用法）、个人中心/designs-specs.md（LLM 配置与 GoConfigDialog kind='llm' 惯例）、**AI 生成全局取消机制（260908 落地）**——本模块 `articles:summarize` 为 AI 通道，按「jobId 首参 + beginJob → ac.signal → finally endJob」模式接入（electron/ai/jobs.ts）。260908 已实施（typecheck/build 通过，记录见 `docs/log/260908.md`）。

## 0. 命名与常量

- `ModuleId` 增 `'feed'`；App.tsx `MODULES` 注册 `{ id: 'feed', label: '信息源', icon: 'rss_feed' }`，位置在书架与回收站之间（wenbi → bookshelf → **feed** → recycle → profile）。
- **不新增 AiChannel**（总结走主进程后台 LLM，无边栏联动）；`CHANNEL_BY_MODULE` 不列 → 默认 'assistant'。
- 新依赖：`fast-xml-parser`（RSS 2.0/Atom 解析，与书架模块共用）、`@mozilla/readability` + `linkedom`（主进程抓网页正文）。
- **CSP**（src/index.html:8）：`img-src` 增 `https:`（文章远程图片）；`connect-src` 不动（一切网络请求在主进程，渲染层不发外部 fetch）。
- 「去原文」复用现有 `shell:openExternal` 通道（ipc.ts:1384，preload.ts:440 `window.api.openExternal(url)`——仅放行 http/https）。
- 预置三源常量（seed 用）：`https://weekly.tw93.fun/rss.xml`、`https://aiznb.com/weekly/atom.xml`、`https://ursb.me/blog/feed.xml`。
- 正文长度阈值：`FULL_TEXT_MIN = 500`（剥 HTML 标签后字符数）；单源网络超时 15s（`AbortSignal.timeout(15_000)`）。

## 1. 数据表（DB v19）

```sql
CREATE TABLE feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  feed_url TEXT NOT NULL UNIQUE,
  site_url TEXT NOT NULL DEFAULT '',
  last_fetched_at TEXT,
  fetch_error TEXT,                       -- 最近一次拉取错误（NULL=成功）
  created_at TEXT NOT NULL
);
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL,
  guid TEXT NOT NULL,                     -- 去重键（无 guid 用 link 的 SHA-256 前 16 位）
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  published_at TEXT,                      -- 解析失败退 fetched_at
  fetched_at TEXT NOT NULL,
  content_feed_html TEXT,                 -- RSS/Atom 自带全文或摘要
  content_fetched_html TEXT,              -- readability 抓取正文（懒抓缓存）
  read_at TEXT,                           -- NULL=未读
  summary_text TEXT,
  summary_at TEXT,
  UNIQUE(feed_id, guid)
);
CREATE INDEX idx_articles_feed ON articles(feed_id, published_at DESC);
```

- **版本号实况（260908 实施落定）**：设计写 v19，被并行会话海龟汤计时的 v18 顺延挤占，信息源迁移实际占 **v20**（书架占 v19）。
- **不依赖外键级联**（稳妥起见不依赖 PRAGMA）：`feeds:remove` 显式两步 `DELETE FROM articles WHERE feed_id = ?` → `DELETE FROM feeds WHERE id = ?`。
- `FeedRecord` / `ArticleRecord`（全量）/ `ArticleSummary`（列表轻量：无 content 两字段，摘要截 120 字）补 `src/shared/types.ts` + `src/renderer/api.d.ts`。

## 2. 主进程 FeedService（新建 `electron/services/feed.ts`）

### 2.1 拉取

- `fetchFeed(feed)`：`fetch(feed_url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 常规浏览器 UA } })` → text → fast-xml-parser（`ignoreAttributes: false`）→ 归一化：
  - RSS 2.0：`rss.channel.item[]`；字段 title/link/guid/pubDate/`content:encoded`（缺退 description）。
  - Atom：`feed.entry[]`；title/link[@href]/id/updated/`content`（type 含 html 时取 #text）。
  - `published_at` 用 `new Date()` 解析，失败置 NULL（查询侧 `COALESCE(published_at, fetched_at)` 排序展示）。
- 新文章 `INSERT OR IGNORE`（UNIQUE(feed_id, guid) 去重）；回写 feed 的 `last_fetched_at` 与 `fetch_error`（成功清空）。
- `fetchAllFeeds()`：`Promise.allSettled` 并发全部源，返回 `FetchResult[]`（每源 ok/error + 错误串），单源失败不阻断。
- `seedFeeds()`：feeds 表空时插入预置三源；在 `feeds:list` handler 里幂等调用（首次进入模块自动生效）。

### 2.2 正文两级策略

- `extractArticle(articleId)`：取 content_feed_html 剥标签 ≥500 字符 → 直接够用不抓；否则 fetch 文章 url（15s 超时 + UA）→ linkedom `DOMParser` 解析 → `Readability` 提取 → `content_fetched_html` 回写；网络/解析失败置 NULL（不报错，渲染层兜底）。**结果同时服务 AI 总结与阅读视图，一处抓取两处复用。**
- 兜底链（渲染层）：`content_fetched_html ?? content_feed_html ?? 摘要 + 「去原文」外链提示卡`。

### 2.3 AI 总结（按需 + 缓存，signal 穿透）

- `summarizeArticle(articleId, signal?)`：已有缓存直接返回；否则取全文（feed 优先，不足且未抓过 → 先 `extractArticle`）→ 剥标签纯文本截 8000 字 → `chatCompletion`（electron/ai/llm.ts，temperature 0.3）：
  - system：中文总结助手——输出 150-300 字客观概括文章要点，不加评价与开场白。**不注入画像**（`profileDigest()` 前缀惯例在此刻意不用——外部文章与自我认知无关）。
  - user：文章标题 + 全文文本。
- 成功回写 `summary_text` / `summary_at`；LLM 未配置上抛 `LlmNotConfiguredError`（渲染层转 GoConfigDialog）。

## 3. 渲染层（`src/modules/feed/`）

### 3.1 FeedModule.tsx（三段式壳 + 源列表 + 文章列表）

- 布局：左窄栏源列表（约 200px）+ 右侧文章区；文章区再分列表态/阅读态（`selectedArticleId: number | null` 主栏内切换，写作台页面化同款语义）。
- 源列表：「全部文章」聚合项（总未读数）+ 各源行（源名 + 未读数徽标 + `fetch_error` 红点 title 显错）+ `more_horiz` 菜单（重命名 / 删除）+ 底部「添加订阅」按钮（icon `add`）。
- 文章列表：行 = 标题（未读 `font-weight` 加粗）+ 源名（全部视图时显示）+ 相对时间 + 摘要前 50 字；`ORDER BY COALESCE(published_at, fetched_at) DESC`；顶栏「刷新」（icon `refresh`，拉取中转圈）与「全部标已读」。
- `useModuleActivated('feed', …)`：切回模块触发 `feeds:fetchAll` + 双列表刷新（进模块自动拉取）。
- 添加订阅弹窗：URL input → 「验证」`feeds:probe` 显源名 → 「订阅」`feeds:add`（入库并立即拉一次）；probe 失败 toast 原因（网络/非 RSS）。
- 删除源：ConfirmDialog「删除源及其 N 篇文章，不可恢复」→ `feeds:remove` → 回「全部文章」。
- 重命名：弹窗改源显示名 → `feeds:rename`。

### 3.2 ArticleView.tsx（阅读视图）

- 顶部：返回 + 标题 + 源名/时间行 + 「去原文」按钮（icon `open_in_new`，`window.api.openExternal(url)`）。
- **AI 总结卡**（置顶，主题色边框卡片）：
  - 打开文章（`articles:open`）后若 `summary_text` 为空 → 自动发起 `articles:summarize`：`crypto.randomUUID()` 生成 jobId 首参（WikiModule 同款），卡片 loading 态；
  - jobId 全局取消接线：loading 持 jobId、catch `msg.includes('已取消')` 轻提示分支（排 LLM_NOT_CONFIGURED 前）、生成中可点停止；
  - 失败显示原因 + 「重试」；成功渲染总结文本 + 小字「AI 生成」。
  - `LlmNotConfiguredError`（message 为 `LLM_NOT_CONFIGURED`）→ GoConfigDialog（kind='llm'，模块持有，格言库 goConfig 同款）。
- **正文**：`DOMPurify.sanitize(html)` 后 `dangerouslySetInnerHTML`，scoped `.feed-article` 排版（复用 md-view 风格：行高/标题层级/链接色 `--color-primary-deep`）；远程 `<img>` 直接加载（CSP 已放宽）。
- 打开即标已读（`articles:open` 内置 `read_at = now`），列表未读态随之消失。

## 4. IPC 与 preload（ipc.ts + preload.ts + api.d.ts 三处同步）

| 通道 | 签名 | 行为 |
|---|---|---|
| `feeds:list` | `() => Promise<(FeedRecord & { unread: number })[]>` | 幂等 seedFeeds → 列表 + 未读数（LEFT JOIN COUNT） |
| `feeds:fetchAll` | `() => Promise<FetchResult[]>` | 并发拉全部源，逐源返回成败 |
| `feeds:probe` | `(url: string) => Promise<{ title: string; siteUrl: string }>` | 拉一次验证并取源名，失败抛带 message Error |
| `feeds:add` | `(url: string) => Promise<FeedRecord>` | probe 结果入库 + 立即 fetchFeed 一次 |
| `feeds:rename` | `(id, title: string) => Promise<void>` | 改源显示名 |
| `feeds:remove` | `(id) => Promise<void>` | 两步删文章与源（§1），彻底删除 |
| `articles:list` | `(feedId: number \| null) => Promise<ArticleSummary[]>` | null=全部；倒序，轻量字段 |
| `articles:open` | `(id) => Promise<ArticleRecord>` | 全量（含正文与总结缓存）+ 标已读 + 懒抓正文（feed 全文不足且未抓过时顺手 extract，§2.2） |
| `articles:summarize` | `(jobId: string, id) => Promise<string>` | **AI 通道**：beginJob → summarizeArticle(ac.signal) → finally endJob；未配置抛 `LLM_NOT_CONFIGURED` |

- 无 signal 兼容：`summarizeArticle` 形参可选（与 services 层惯例一致）；`feeds:rename` 仅改显示名不动拉取配置。

## 5. 接线

- App.tsx：`MODULES` 增 feed；FeedModule 懒加载注册；**不传 `onOpenAi`**（无边栏联动）。
- `src/modules/feed/`：`FeedModule.tsx` + `ArticleView.tsx` + `feed.css`（或复用 App.css 区块样式，实现时随现有惯例）。

## 6. 明确不做（design.md 背书）

- 收藏/稍后读、定时自动拉取、单篇文章手动删除、全文搜索、OPML、列表虚拟滚动（v2 备选）。
- 不入回收站（八块与 RecycleSource 零改动）；不新增 AI 边栏频道（五频道不动）。

## 7. 验收清单

- [ ]  DB v19 迁移：两表 + 索引建成；新装库顺序迁移覆盖
- [ ]  预置三源：首次进入自动 seed + 自动拉取出文章
- [ ]  拉取：进模块自动拉 + 手动刷新；单源断网/超时只标红不阻断其他源；guid 去重不重插
- [ ]  订阅管理：添加（probe 验证 → 确认入库 → 立即拉取）；重命名；删除连文章彻底清
- [ ]  已读：点开标已读、未读加粗、全部标已读；未读数徽标准确
- [ ]  正文两级：全文源直接渲染；摘要源自动抓正文（一次抓两用）；双失败摘要 + 去原文外链
- [ ]  AI 总结：首次打开生成（jobId 取消接线：停止即中断、toast「已取消」、可重试）+ 缓存秒开；失败重试；LLM 未配置弹「去配置」
- [ ]  安全：正文过 DOMPurify；远程图片显示（CSP 放行 https:）；「去原文」跳系统浏览器
- [ ]  双主题下列表/阅读视图/总结卡配色；`npm run typecheck` / `npm run build` 通过
