# 信息源 designs-specs.md

>
> 260911 增量注记（第37轮）：主进程网络层换 **Electron net.fetch**（Chromium 网络栈自动跟随系统代理——修复墙外源〔feedburner 等〕直连超时报 Error，对齐 llm.ts 260909 既定约定；§2 拉取三处统一走 httpGet 内部件）；订阅入口支持**网站首页自动发现**（HTML `<link rel="alternate">` 探测 feed 直链，addFeed 存发现的直链而非用户输入）；订阅/拉取错误映射**可读中文**（连接类附「应用自动跟随系统代理」提示）。详见 `2026-09-11-信息源订阅网络层修复与自动发现-design.md`。
>
> 260911 增量注记：已读判定改**显式按钮**（打开文章不再自动标已读，第28轮「读完即消失」与「无标未读回退」口径作废）——行/阅读视图双入口「已读｜再看看」双态可逆；新增**文章收藏**（DB v34 `favorited_at`，「收藏」第三 tab，收藏时间倒序全量不筛源，永不被清理；取消按已读状态回流收件箱/已归档）；老数据清理改**30 天整行彻底删除**（已读+未收藏，第28轮 180 天清正文保轻行口径作废；归档页「加载更早」移除）。详见 §2.4/§2.5/§3/§4 与 `2026-09-11-信息源已读收藏与清理-design.md`。
>
> 260909 增量注记（第28轮）：主列表改**收件箱模式**（只显未读、读完即消失；「已归档」视图翻已读）+ **30 天时间窗口**加载（窗口外「加载更早 30 天 · 还剩 N 篇」触达，切视图/切源窗口重置）+ **180 天老文章清正文保轻行**（启动+零点定时置空正文/总结，保留标题轻行可跳原文，点开懒抓兜底；260911 起由 30 天整行删除取代）。详见 §2.4 与 `2026-09-09-信息源收件箱与时间窗口-design.md`（实施后随计划归档 archive/）。

> 本文档由 AI 基于 `docs/project/左侧边栏/信息源/design.md`（260908 brainstorming 定稿并立项）生成，是开发的直接依据。设计全记录（七项决策与被否方案）见同目录 `archive/2026-09-08-信息源-design.md`。依赖：样式/designs-specs.md（ConfirmDialog / GoConfigDialog / Toast 与主题色系、Material Symbols 用法）、个人中心/designs-specs.md（LLM 配置与 GoConfigDialog kind='llm' 惯例）、**AI 生成全局取消机制（260908 落地）**——本模块 `articles:summarize` 为 AI 通道，按「jobId 首参 + beginJob → ac.signal → finally endJob」模式接入（electron/ai/jobs.ts）。260908 已实施（typecheck/build 通过，记录见 `docs/log/260908.md`）。

## 0. 命名与常量

- `ModuleId` 增 `'feed'`；App.tsx `MODULES` 注册 `{ id: 'feed', label: '信息源', icon: 'rss_feed' }`，位置（260908 重排后）在藏书架与文笔坊之间（mottos → wiki → bookshelf → **feed** → wenbi → … → recycle → profile）。
- **不新增 AiChannel**（总结走主进程后台 LLM，无边栏联动）；`CHANNEL_BY_MODULE` 不列 → 默认 'assistant'。
- 新依赖：`fast-xml-parser`（RSS 2.0/Atom 解析，与藏书架模块共用）、`@mozilla/readability` + `linkedom`（主进程抓网页正文）。
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

- **版本号实况（260908 实施落定）**：设计写 v19，被并行会话海龟汤计时的 v18 顺延挤占，信息源迁移实际占 **v20**（藏书架占 v19）。
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

### 2.4 收件箱查询与老数据清理（第28轮；260911 三视图+收藏+30 天整行删）

- `listArticles(feedId, view, sinceDays)`（260911 三视图）：`view='unread'`（收件箱，`read_at IS NULL`）| `'archive'`（已归档，`read_at IS NOT NULL`）| `'favorite'`（收藏，`favorited_at IS NOT NULL` 按收藏时间倒序**全量**，不筛源不设窗口）；unread/archive 两分支均排除收藏（`favorited_at IS NULL`）且时间条件 `COALESCE(published_at, fetched_at) >= now - sinceDays 天`；返回 `FeedListView { articles, remaining }`，remaining 为同条件去时间窗口 COUNT（仅 unread 用）。`ArticleSummary` 增 `favorited`。
- `setArticleRead(id, read)` / `setArticleFavorite(id, fav)`（260911）：已读判定唯一入口——`openArticle` 不再写 `read_at`；`read=false` 清空回未读（行回收件箱）；收藏只出现在收藏页，取消按已读状态自然回流。
- `cleanupOldArticles()`（260911，取代第28轮 `cleanupOldArticleBodies`）：`DELETE` 已读 + 未收藏 + `COALESCE(published_at, fetched_at)` 超 30 天的**整行**；未读无论多老保留、收藏永不清除；挂 scheduler 启动 + 每日零点。
- 未读数（`feeds:list` 徽标子查询与 `feeds:add` 返回）排除收藏（260911）。

## 3. 渲染层（`src/modules/feed/`）

### 3.1 FeedModule.tsx（三段式壳 + 源列表 + 文章列表）

- 布局：左窄栏源列表（约 200px）+ 右侧文章区；文章区再分列表态/阅读态（`selectedArticleId: number | null` 主栏内切换，写作台页面化同款语义）。
- 源列表：「全部文章」聚合项（总未读数）+ 各源行（源名 + 未读数徽标 + `fetch_error` 红点 title 显错）+ `more_horiz` 菜单（重命名 / 删除）+ 底部「添加订阅」按钮（icon `add`）。
- 文章列表：行 = 主体列（标题未读 `font-weight` 加粗 + 源名 + 相对时间 + 摘要前 120 字）+ 右侧常显操作区（260911：星标 `star` 收藏/取消〔实心=已收藏，FILL 轴〕+ 「已读｜再看看」双态小按钮〔`mark_email_read`/`move_to_inbox`，点击即流转：已读→归档、再看看→收件箱，可逆无确认〕）；`ORDER BY COALESCE(published_at, fetched_at) DESC`（favorite 按 `favorited_at DESC`）；顶部「收件箱 | 已归档 | 收藏」三 tab（recycle-tab 同款，260911 扩）——收藏页跨源 meta 恒显源名、不受左栏选源影响；收件箱默认 30 天窗口，底部「加载更早 30 天 · 还剩 N 篇」仅收件箱显示（260911：归档天然 ≤30 天、收藏无窗口），切视图/切源重置；顶栏「刷新」（icon `refresh`，拉取中转圈）与「全部标已读」（不带时间过滤，260911 起不波及收藏未读）。
- `useModuleActivated('feed', …)`：切回模块触发 `feeds:fetchAll` + 双列表刷新（进模块自动拉取）。
- 添加订阅弹窗：URL input → 「验证」`feeds:probe` 显源名 → 「订阅」`feeds:add`（入库并立即拉一次）；probe 失败 toast 原因（网络/非 RSS）。
- 删除源：ConfirmDialog「删除源及其 N 篇文章，不可恢复」→ `feeds:remove` → 回「全部文章」。
- 重命名：弹窗改源显示名 → `feeds:rename`。

### 3.2 ArticleView.tsx（阅读视图）

- 顶部：返回 + 标题 + 星标（收藏/取消）+ 「已读｜再看看」双态按钮 + 「去原文」按钮（icon `open_in_new`，`window.api.openExternal(url)`）——260911 与列表行双入口，按钮态本地即时翻转并 `onChanged` 刷新列表。
- **AI 总结卡**（置顶，主题色边框卡片）：
  - 打开文章（`articles:open`）后若 `summary_text` 为空 → 自动发起 `articles:summarize`：`crypto.randomUUID()` 生成 jobId 首参（WikiModule 同款），卡片 loading 态；
  - jobId 全局取消接线：loading 持 jobId、catch `msg.includes('已取消')` 轻提示分支（排 LLM_NOT_CONFIGURED 前）、生成中可点停止；
  - 失败显示原因 + 「重试」；成功渲染总结文本 + 小字「AI 生成」。
  - `LlmNotConfiguredError`（message 为 `LLM_NOT_CONFIGURED`）→ GoConfigDialog（kind='llm'，模块持有，格言库 goConfig 同款）。
- **正文**：`DOMPurify.sanitize(html)` 后 `dangerouslySetInnerHTML`，scoped `.feed-article` 排版（复用 md-view 风格：行高/标题层级/链接色 `--color-primary-deep`）；远程 `<img>` 直接加载（CSP 已放宽）。
- 打开不标已读（260911：`articles:open` 只懒抓正文与全量返回；已读判定唯一入口是显式按钮）。

## 4. IPC 与 preload（ipc.ts + preload.ts + api.d.ts 三处同步）

| 通道 | 签名 | 行为 |
|---|---|---|
| `feeds:list` | `() => Promise<(FeedRecord & { unread: number })[]>` | 幂等 seedFeeds → 列表 + 未读数（LEFT JOIN COUNT） |
| `feeds:fetchAll` | `() => Promise<FetchResult[]>` | 并发拉全部源，逐源返回成败 |
| `feeds:probe` | `(url: string) => Promise<{ title: string; siteUrl: string }>` | 拉一次验证并取源名，失败抛带 message Error |
| `feeds:add` | `(url: string) => Promise<FeedRecord>` | probe 结果入库 + 立即 fetchFeed 一次 |
| `feeds:rename` | `(id, title: string) => Promise<void>` | 改源显示名 |
| `feeds:remove` | `(id) => Promise<void>` | 两步删文章与源（§1），彻底删除 |
| `articles:list` | `(feedId: number \| null, view: 'unread' \| 'archive' \| 'favorite', sinceDays: number) => Promise<FeedListView>` | null=全部（favorite 忽略）；三视图 §2.4；30 天窗口起 + remaining 窗口外计数 |
| `articles:open` | `(id) => Promise<ArticleRecord>` | 全量（含正文与总结缓存）+ 懒抓正文（feed 全文不足且未抓过时顺手 extract，§2.2）；260911 起不标已读 |
| `articles:setRead` | `(id, read: boolean) => Promise<boolean>` | 260911：显式已读/再看看（read=false 清空 read_at 回收件箱） |
| `articles:setFavorite` | `(id, fav: boolean) => Promise<boolean>` | 260911：收藏/取消（取消按已读状态回流收件箱/已归档） |
| `articles:markAllRead` | `(feedId: number \| null) => Promise<boolean>` | 全部标已读（260911 起排除收藏未读） |
| `articles:summarize` | `(jobId: string, id) => Promise<string>` | **AI 通道**：beginJob → summarizeArticle(ac.signal) → finally endJob；未配置抛 `LLM_NOT_CONFIGURED` |

- 无 signal 兼容：`summarizeArticle` 形参可选（与 services 层惯例一致）；`feeds:rename` 仅改显示名不动拉取配置。

## 5. 接线

- App.tsx：`MODULES` 增 feed；FeedModule 懒加载注册；**不传 `onOpenAi`**（无边栏联动）。
- `src/modules/feed/`：`FeedModule.tsx` + `ArticleView.tsx` + `feed.css`（或复用 App.css 区块样式，实现时随现有惯例）。

## 6. 明确不做（design.md 背书）

- 定时自动拉取、单篇文章手动删除、全文搜索、OPML、列表虚拟滚动（v2 备选）。
- 不入回收站（八块与 RecycleSource 零改动）；不新增 AI 边栏频道（五频道不动）。
- 已读不进回收站（第28轮维持现口径）；~~无「标未读」回退操作（第28轮明确不做）~~（260911「再看看」落地回退）；~~收藏/稍后读~~（260911 文章收藏落地）。

## 7. 验收清单

- [ ]  DB v19 迁移：两表 + 索引建成；新装库顺序迁移覆盖
- [ ]  预置三源：首次进入自动 seed + 自动拉取出文章
- [ ]  拉取：进模块自动拉 + 手动刷新；单源断网/超时只标红不阻断其他源；guid 去重不重插
- [ ]  订阅管理：添加（probe 验证 → 确认入库 → 立即拉取）；重命名；删除连文章彻底清
- [ ]  已读（260911）：打开不消失、点「已读」进归档、「再看看」回收件箱（列表行 + 阅读视图双入口）、全部标已读不波及收藏；未读数徽标准确（不含收藏）
- [ ]  收藏（260911）：星标收藏进收藏页（阅读视图照常、缓存随行）、取消回流正确、收藏页不筛源恒显源名、永不被 30 天清理
- [ ]  老数据清理（260911）：已读+未收藏+超 30 天整行删除；未读与收藏对照保留
- [ ]  收件箱模式（第28轮）：已归档可翻、加载更早仅收件箱触达窗口外、全部标已读清空收件箱（含窗口外未读）
- [ ]  正文两级：全文源直接渲染；摘要源自动抓正文（一次抓两用）；双失败摘要 + 去原文外链
- [ ]  AI 总结：首次打开生成（jobId 取消接线：停止即中断、toast「已取消」、可重试）+ 缓存秒开；失败重试；LLM 未配置弹「去配置」
- [ ]  安全：正文过 DOMPurify；远程图片显示（CSP 放行 https:）；「去原文」跳系统浏览器
- [ ]  双主题下列表/阅读视图/总结卡配色；`npm run typecheck` / `npm run build` 通过
