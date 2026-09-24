# 播客台 designs-specs.md

> 本文档由 AI 基于 `2026-09-24-播客台-design.md`（260924 brainstorm 定稿）生成，是开发的直接依据。
> 定位重申：**播客不是用来听的，是用来读的**——订阅节目、自动收新单集、拿文字稿读全文，配 AI 导读卡与「播客·追问」频道。零音频播放 UI / 零音频引擎。
> 依赖先例：信息源（feed.ts / FeedModule / ArticleView 三态骨架与网络层）、reasoningStock（内存队列 + `webContents.send` 渐进刷新）、文献库（追问频道 `literature` 先例与模块 props 形状）、个人档（LLM/MCP 配置卡片与提纲导航）、AI 全局取消机制（jobId 首参 + beginJob → ac.signal → finally endJob，electron/ai/jobs.ts）。
> 版本注记：design 写「DB v53」，实况 v53 已被 260925 面经 answer_path 修复迁移占用，本模块迁移实际占 **v54**。

## 0. 命名、常量与全局接线

- `ModuleId 'podcast'` 已就位（`src/shared/types.ts:22`、`src/renderer/api.d.ts:18`），左栏项已注册（`src/App.tsx:60`，seg learn）。本期改动：MODULES 该行**去 `pending: true`**，主栏 keep-alive 块（App.tsx:400-441）挂 `<PodcastModule onOpenAi={openAiWith} onNavigateToProfile={() => activateModule('profile')} />`（literature 同款 props）。占位「待建」提示逻辑对 podcast 自动不再命中。
- **AiChannel 增 `'podcast'`**（六处 union/映射同步，literature 增频道同一路径）：
  1. `src/shared/types.ts:36` union 追加；
  2. `src/renderer/api.d.ts:24` union 追加；
  3. `src/shared/types.ts` SettingsKeys 增 `AiActiveSessionPodcast: 'ai_active_session_podcast'`；
  4. `electron/ai/services.ts:19` ACTIVE_SESSION_KEYS 增 `podcast: SettingsKeys.AiActiveSessionPodcast`；`CHANNEL_PERSONAS`（同文件 :208）增 podcast 人设：「当前频道是「播客·追问」，你是播客学习伴读：基于用户正在读的单集内容，帮其吃透观点与论据，可辩证补充不同角度，不代写笔记。」；`MODULE_LABELS`（同文件 :196）增 `podcast: '播客台'`；
  5. `src/components/AiSidebar.tsx:45` CHANNELS 增 `{ id: 'podcast', label: '播客·追问', icon: 'podcasts' }`、:60 ACTIVE_SESSION_KEYS 同步；
  6. `src/App.tsx:81` CHANNEL_BY_MODULE 增 `podcast: 'podcast'`。
  - podcast 频道**不进** ChatDispositionBar 三选条（仅 learn/wiki/zhijiji）。
- 新增文件：`electron/services/podcast.ts`（主进程全部逻辑）、`src/modules/podcast/PodcastModule.tsx`、`src/modules/podcast/EpisodeReader.tsx`、`src/modules/podcast/AddFeedDialog.tsx`、`src/modules/podcast/podcast.css`。
- **零新依赖**：XML 解析复用 `fast-xml-parser`；音频分片为纯字节操作；multipart 上传用 Node/Electron 全局 `FormData` + `Blob`（`net.fetch` undici 兼容）。
- **CSP 不动**（一切网络在主进程）；封面 `artwork_url` 为 https 远程图，参照信息源做法在 index.html `img-src` 已放宽 `https:`（现状已满足，若缺则补）。
- 常量：拉源/抓文字稿超时 15s（`AbortSignal.timeout(15_000)`）；UA 与 feed.ts 同款常规浏览器 UA；`ASR_DIRECT_MAX = 45 * 1024 * 1024`（≤45MB 整传）；分片目标 `CHUNK_TARGET = 40 * 1024 * 1024`；单片 ASR 超时 10 分钟；首拉存量集数 `FIRST_PULL_LIMIT = 10`；追问上下文截断 2 万字；导读卡输入截断 6 万字（超长截头部保留）。
- settings 键：`AsrConfig: 'asr_config'`（JSON）、`AiActiveSessionPodcast`（见上）。

## 1. 数据模型（DB v54，两表 + 索引）

SQL 照 design §三原样（podcast_feeds / podcast_episodes + idx_pe_feed / idx_pe_guid UNIQUE），迁移用 `BEGIN`/`PRAGMA user_version = 54`/`COMMIT`/`ROLLBACK` 惯例（db.ts v52 段同款）。要点：

- **不依赖外键级联**：退订显式两步 `DELETE FROM podcast_episodes WHERE feed_id = ?` → `DELETE FROM podcast_feeds WHERE id = ?`。
- 文字稿全文落 `transcript_text`（SQLite TEXT，单集 1-3 万字，可接受）。**落库前归一化为 md 段落**（连续非空行合成一段、段间空行），保证阅读视图 MdView 段落渲染正确（srt/vtt 去时间轴后的散文行不丢换行结构）。
- 类型定义（shared/types.ts + api.d.ts 双处同步）：
  - `PodcastFeed`：表列全量 + `unread: number` + `untranscribed: number`（feedsList 联表计数）。
  - `PodcastEpisodeSummary`（列表轻量行，**不含** shownotes/transcript_text/summary_md 大字段）：`id, feed_id, feed_title, guid, title, published_at, duration_sec, transcript_state, transcript_source, transcript_error, read_at, has_transcript_rss(0/1，transcript_url 非空)`。
  - `PodcastEpisodeDetail`（阅读视图全量）：Summary 字段 + `shownotes, transcript_text, summary_md, summary_at, artwork_url`（联 feed 封面）。
  - `ItunesPodcast`（搜索结果归一化行）：`{ trackId, name, artist, artworkUrl, trackCount, feedUrl: string | null }`。
- `parseAsrConfig` / `AsrConfig` / `ASR_DEFAULTS` 放 `src/shared/types.ts`（parseTerminalSettings 同款手法同位置）：
  ```ts
  export interface AsrConfig { apiUrl: string; apiKey: string; model: string }
  export const ASR_DEFAULTS = { apiUrl: 'https://api.siliconflow.cn/v1', model: 'openai/whisper-large-v3' }
  export function parseAsrConfig(raw: string | null | undefined): AsrConfig {
    // 坏数据/缺字段逐项回落【空串】（非默认值——「默认预填仅首次展示，保存后即用户数据」，
    // 回落默认值会让用户清空变回预填）；完整性校验（三项齐）由触发转写时做
  }
  ```

## 2. 主进程服务（新建 `electron/services/podcast.ts`）

### 2.1 RSS 解析（parsePodcastFeed，RSS 2.0 + itunes/podcast 命名空间）

- 手段同源借鉴 feed.ts：`xml.parse`（ignoreAttributes: false）+ 私有 `textOf` / `toArray` / `toIso` / `friendlyError`（不强行抽公共，各自维护）。**只支持 RSS 2.0**（播客生态一统，iTunes 订阅源全部 RSS 2.0；非 RSS 抛「无法识别的播客订阅格式」）。
- channel 级：`title`、作者 `itunes:author ?? author`、封面 `itunes:image.@_href ?? image.url`。
- item 级：`guid`（无 guid 用 enclosure_url 的 sha16 兜底，sha16 手法同 feed.ts）、`title`、`pubDate`→ISO（失败 null）、`enclosure.@_url`、`itunes:duration`（「HH:MM:SS」/「MM:SS」/纯秒三种归一为秒，解析失败 null）、正文 `content:encoded ?? description`、文字稿 `podcast:transcript`（可多条，按 `@_type` 优先级 `text/html > text/plain > application/srt > application/vtt > application/json` 取最优，保留 `{ url, type }`）。

### 2.2 网络与拉源管线

- `httpGet`：`net.fetch` + UA + 15s 超时（feed.ts 同款，走系统代理）。
- `fetchPodcastFeed(feedId, feedUrl, isFirst)`：
  - 首拉（订阅时）：全量解析但只入库**最近 10 集**（有 `published_at` 按时间倒序、无日期排最后保 RSS 文档序，合计取前 10），全部停 `none` 态**不自动转写**；
  - 增量（fetchAll 触发）：按 (feed_id, guid) 去重全收；`auto_transcribe=1` 的节目新集入库后**自动入转写队列**（见 2.4）；
  - 成功清 `fetch_error`、回写 `last_fetched_at`；失败记可读中文 `fetch_error`（friendlyError）不抛。
- `fetchAllFeeds()`：并发拉全部源（Promise.all，单源失败不阻断），返回 `{ added: number }` 汇总；拉回的新集按各节目开关决定是否入队。

### 2.3 iTunes 搜索与订阅

- `itunesSearch(term)`：主进程代理 `https://itunes.apple.com/search?term=<词>&media=podcast&country=CN&limit=20`（渲染层直连有 CORS 与代理问题）；归一化为 `ItunesPodcast[]`（artworkUrl100 改 600 尺寸）；**feedUrl 缺失的项就地 lookup 补全**（`https://itunes.apple.com/lookup?id=<trackId>&entity=podcast`，仍缺失保持 null → 前端置灰）。
- `addPodcastFeed(input, autoTranscribe)`：
  - `input.kind='itunes'`：直接用搜索行已补全的字段（feedUrl 必须非空，空则抛「该节目未提供 RSS 地址」）；
  - `input.kind='rss'`：先 `probePodcastFeed(url)`——httpGet → parsePodcastFeed，能解析出频道名即通过，返回实际 feedUrl/title/artist/artwork（信息源 probe 同款交互；不做 rsshub 展开）；
  - `feed_url` UNIQUE 查重，重复抛「该节目已订阅」；入库 + 首拉 10 集（2.2）。

### 2.4 文字稿转写队列（主进程纯后台，内存串行）

- 队列：内存数组 + 单飞标志，一次处理一集（防并发打爆 ASR 与重复计费）；状态机 `none → queued → downloading → transcribing → done | failed`，**每次状态变更** `BrowserWindow.getAllWindows()[0]?.webContents.send('podcast:taskChanged')`（reasoningStock 同款渐进刷新）。
- `enqueueTranscribe(episodeId)`：仅 `none | failed` 态可入队（queued/doing 幂等跳过）；置 queued → notify → pump。
- `processOne(episodeId)` 步骤：
  1. `transcript_url` 存在 → **RSS 文字稿直抓**（置 downloading→notify）：httpGet 抓文件，按 parse 时保留的 type（缺失按 URL 扩展名）解析为纯文本——text/plain 直接用；text/html `stripTags`；srt/vtt 去序号行（`/^\d+$/`）与时间轴行（`/-->/`）；json 递归收集字符串字段拼接。成功落 `transcript_text` + `source='rss'` + done；失败置 failed 记错误（**不回退 ASR**，重试即可）。
  2. 无 transcript_url → **ASR 路径**（置 downloading）：`parseAsrConfig` 校验三项（apiUrl/apiKey/model）齐备，缺 → 置 failed、错误文案「ASR 未配置，去个人档配置后重试」（队列继续下一集）。下载音频到临时文件（`app.getPath('temp')/podcast-<id>-<ts>.mp3`）——Content-Length 预检存 `audio_bytes`；**≤45MB 整文件直传**；**超限按 mp3 帧同步字节（0xFF + 低三位非 000）向后找最近帧边界切 ~40MB 分片**，逐片调 ASR、文本按序拼接（接缝允许轻微瑕疵）。
  3. ASR 调用（置 transcribing→notify）：`POST {apiUrl}/audio/transcriptions`（multipart：`file` + `model`，Authorization Bearer），OpenAI 兼容取 `text`；单片超时 10 分钟；转写打标本身零 LLM。
  4. 成功落 `transcript_text` + `source='asr'` + **polishing**（260925 增排版阶段，原始转写先入库防丢）；任何失败置 failed + 可读中文错误（网络/超时/服务报错 N/未配置 ASR）。`finally` 兜底删临时文件。
  5. **AI 排版（260925 开发者需求，design「零 LLM」据此修订）**：polishing 态下调 `polishTranscript`——仅排版不改内容：按语义分段 + 剥离非语音标记（🎼😊 等情绪/音乐标记），语音文字一字不改不增不减（不纠错不改写不总结）。原文按句末标点切 ≤3500 字块逐块串行调 LLM（scene `podcast:polish` = 面板「播客台·排版」，temperature 0.1，防单次输出截断），单块失败/返回空回退原块（排版永不让文字变少）；**失败/取消/LLM 未配置均保留原始转写直接置 done**（排版是尽力而为的增强，cancel 时 ASR 已计费不回退 none）；完成回写 `transcript_text` + done。启动恢复：polishing 态（原始转写已在库）直接置 done 不重跑 ASR。
- `resumePodcastTranscribes()`：启动扫描 `queued/downloading/transcribing` 全部重置 queued 重入队；`electron/main.ts` 启动钩子区（:99-133 惯例位置）`setTimeout(..., 10_000).unref()` 触发。
- 手动重试（行上「重试」）与手动触发走同一 `enqueueTranscribe`。

### 2.5 AI 导读卡（jobId 取消接线）

- `generateEpisodeSummary(episodeId, jobId)`：`summary_md` 有缓存直接返回；无 → beginJob 取 signal → `chatCompletion`（temperature 0.3）——输入 = 节目名 + shownotes + 文字稿全文（>6 万字截头部保留），输出固定四节 md（`## 单集速览 / ## 核心要点 / ## 金句与值得记住的片段 / ## 延伸思考`）；成功回写 `summary_md + summary_at`；`LLM_NOT_CONFIGURED` 上抛（渲染层转 GoConfigDialog kind llm，不阻塞正文阅读）。

## 3. IPC 面（ipc.ts + preload.ts + api.d.ts 三处同步）

| 通道（preload 挂 `window.api.podcast.*`） | 签名 | 行为 |
|---|---|---|
| `podcast:feedsList` | `() => Promise<PodcastFeed[]>` | 订阅列表 + 各节目 unread/untranscribed 计数 |
| `podcast:itunesSearch` | `(term: string) => Promise<ItunesPodcast[]>` | 主进程代理搜索 + lookup 补全 |
| `podcast:feedsAdd` | `(input: { kind: 'itunes'; name; artist; artworkUrl; feedUrl } \| { kind: 'rss'; url }, autoTranscribe: boolean) => Promise<PodcastFeed>` | 订阅 + 首拉 10 集（不自动转写） |
| `podcast:feedsUpdate` | `(id, patch: { auto_transcribe?: boolean; title?: string }) => Promise<boolean>` | 开关即改即生效；改显示名不回写覆盖 |
| `podcast:feedsDelete` | `(id) => Promise<boolean>` | 退订连删该节目全部单集（二次确认在渲染层） |
| `podcast:episodes` | `(feedId: number \| null) => Promise<PodcastEpisodeSummary[]>` | 单集流（null=全部订阅，published_at 倒序 NULL 兜底 fetched_at） |
| `podcast:episodeRead` | `(id, read: boolean) => Promise<boolean>` | 标已读/未读切换 |
| `podcast:episodeDelete` | `(id) => Promise<boolean>` | 删单集（二次确认在渲染层） |
| `podcast:fetchAll` | `() => Promise<{ added: number }>` | 拉全部源新集（进模块/手动）；auto_transcribe=1 的新集自动入队 |
| `podcast:transcribe` | `(id) => Promise<boolean>` | 手动转写触发（入队；未配 ASR 不在此抛——失败态经 taskChanged 流转呈现） |
| `podcast:taskChanged` | `onTaskChanged(cb): () => void` | 主进程 → 渲染层状态推送（ipcRenderer.on） |
| `podcast:episodeDetail` | `(id) => Promise<PodcastEpisodeDetail>` | 阅读视图全量（文字稿 + shownotes + summary_md + 封面） |
| `podcast:generateSummary` | `(jobId: string, id: number) => Promise<string>` | 导读卡生成（返回 summary_md） |

## 4. 渲染层（`src/modules/podcast/`）

### 4.1 PodcastModule.tsx（双页签骨架：单集流｜节目）

- 页签选择不持久化（wiki 双页签同款）；`useModuleActivated('podcast', refresh)`——进模块自动 `fetchAll` + 双列表刷新（信息源同款），fetchAll toast「新收 N 集」。
- **单集流**（默认页签）：顶部「刷新」+「＋添加订阅」+ 节目筛选（`全部 | 各节目`，来自 feedsList；节目页签点卡也落到本视图带过滤）。行 = 节目名 · 标题（未读加粗 + 未读点）· 发布日期（relTime 同 feed）· 时长（`1:01:01` / `12:34`）· 转写状态徽章 + 行尾次要操作。
  - 徽章：未转写（灰 `none`）/ 排队（queued）/ 下载中 / 转写中（转圈 `spin`）/ 失败（红 `error` 色 + 行上「重试」）；**done 无徽章**（无徽章 = 就绪可读）。
  - 行点击：done → 开阅读视图；`none/failed` → 触发转写（`podcast:transcribe`），行徽章即时转排队、列表经 taskChanged 渐进刷新；queued/downloading/transcribing 态点击无操作。
  - 行尾操作：已读/未读切换（`mark_email_read`/`mark_email_read` 反向 icon）、删除（ConfirmDialog 二次确认）、失败重试。
- **节目**页签：订阅卡列表 = 封面 / 节目名 / 作者 / 未读数 /「自动转写新集」开关（即开即生效；**开启时不回溯存量**，只对新集生效）/ 退订（ConfirmDialog「退订将删除该节目全部 N 集与文字稿，不可恢复」）。卡主体点击 → 切单集流筛选到该节目。
- 订阅 `podcast.onTaskChanged` → 轻量刷 episodes（保留当前视图与筛选）；组件卸载退订。
- 深链：本期仅基础切模块（`go('podcast')`，target 不需要），不接 `useModuleNavigate`。

### 4.2 AddFeedDialog.tsx（添加订阅弹窗，双入口 tab）

- 「搜节目」（默认）：输入名字回车/按钮 → `itunesSearch` → 结果列表（封面 / 节目名 / 作者 / 单集数 / 订阅按钮）；`feedUrl` 缺失项置灰不可订（title 提示「未提供 RSS 地址」）；空态与加载态齐备。
- 「RSS 直链」：粘贴地址 → 「验证」（可选，probe 反显频道名与封面）→ 「订阅」。
- 弹窗底部「自动转写新集」勾选（默认开），两入口共用。
- 错误 toast 原文（重复订阅/网络/格式）。

### 4.3 EpisodeReader.tsx（阅读视图，主栏整体切换）

- 头部：返回 · 节目名/单集标题 · 发布日期 · 时长 · 已读/再看看双态按钮；**打开即标已读**（`episodeRead(id, true)` 一次，可手动切回）。
- **AI 导读卡**置顶（feed-summary-card 同款卡片语汇）：`summary_md` 空 → 打开时自动 `generateSummary`（jobId 全局取消接线，生成中转圈可停止；失败显原因 + 重试；LLM 未配置弹 GoConfigDialog kind llm，**不阻塞正文**）；有缓存直接渲染（MdView）+ 小字「AI 生成」。
- 正文：`transcript_text` 有 → MdView 全文渲染；无 → shownotes 兜底（MdView）+ 提示行「本集尚未转写，当前显示节目原始 shownotes」+「转写本集」按钮（触发后可返回列表看徽章流转）。
- **划词问 AI**：正文容器 mouseup 气泡（MdDialog sel-bubble 同款手法、复用 `.sel-bubble` 样式）：选区非空出「问 AI」按钮 → `onOpenAi(\`关于「${单集标题}」：「${选中文本}」\n\n请结合本集内容帮我解释。\`, { channel: 'podcast' })`（**不 auto**，填入不发送）。
- **「追问本集」按钮**（头部）：`onOpenAi(构造首条消息, { channel: 'podcast', auto: true })`——首条消息 = `我正在读播客单集「${标题}」（节目：${feedTitle}，发布于 ${日期}）。以下是本集文字稿（节选）：\n\n${transcript_text ≤2万字}\n\n请基于本集内容陪我追问讨论，帮我吃透其中的观点与论据。`；文字稿缺失时用 shownotes 兜底并注明。自动开右栏由 AiSidebar pending 机制保证（App openAiWith 现成）。

### 4.4 样式

`podcast.css` 仿 feed.css：主题色变量、禁 emoji、Material Symbols 图标（`podcasts` / `rss_feed` / `refresh` / `add` / `delete` / `done` / `progress_activity` 等），组件色系随主题禁彩亮。

## 5. 个人档「ASR 配置」区（ProfileModule.tsx）

- `PROFILE_NAV`（:33）`'mcp'` 后插 `{ id: 'asr', label: 'ASR 配置' }`；zone 渲染顺序与之一致，插在 MCP 配置区块之后。
- 区块卡片（LLM/MCP 配置同款卡片风格）：base URL / API Key / model 三项 + 「保存」+「测试连接」。读 `settings[SettingsKeys.AsrConfig]` 经 `parseAsrConfig`；**parse 结果三项全空时预填 `ASR_DEFAULTS`（仅首次展示）**，保存后即用户数据（`setSetting(SettingsKeys.AsrConfig, JSON.stringify({apiUrl, apiKey, model}))`）。
- **260925 实测修订（默认模型名）**：硅基流动**不托管 whisper**——`openai/whisper-large-v3` 实测返回 400 `Model does not exist`（design 原定默认值有误）。`ASR_DEFAULTS.model` 改为 **`FunAudioLLM/SenseVoiceSmall`**（硅基流动免费档，中文强、速度远快于 large-v3）；已按旧默认保存过的用户需在个人档手动改模型名。
- **260925 增补「测试连接」**（design 原「不做」应开发者要求推翻）：`podcast:testAsr` 通道 + `testAsrConfig`（electron/services/podcast.ts）——主进程内存生成 0.5s 16kHz 单声道静音 WAV，真实 POST `{apiUrl}/audio/transcriptions`（60s 超时），把服务商错误翻译为可行动提示（模型不存在 / Key 无效 401 / 服务返回 N / 网络失败）；成功显示模型返回文本（静音返回空属正常）。不落库不入队不经转写队列（testLlmConnection「手动诊断动作」同款定位）。

## 6. GoConfigDialog 扩 kind

`src/components/GoConfigDialog.tsx` kind union 增 `'asr'`：标题「ASR 未配置」、文案「请先在个人档配置 ASR（语音转写），以启用文字稿转写。」；既有 llm/mcp 调用点零改动。播客模块转写触发 catch `ASR_NOT_CONFIGURED`（§2.4 错误文案含「ASR 未配置」时判定）弹本弹窗，「去配置」`onNavigateToProfile`。

## 7. 总导览联动（OverviewModule.tsx）

- `loadNumbers`（:128）加一段 try/catch + 状态位 `podcastUnread`：`window.api.podcast.episodes(null)` 计数 `read_at == null`（纯渲染层，零新聚合服务）；失败 null。
- 轻数字条：学习模式在「信息源未读」旁并排加「播客待读 N」（`podcasts` icon，点击 `go('podcast')`；0 置灰不可点，zl-muted 同款）。生活模式不显示。

## 8. main.ts 启动钩子

`electron/main.ts` 启动钩子区增 `setTimeout(() => void resumePodcastTranscribes(), 10_000).unref()`（重启续跑；initDb 之后，reasoningStock 同款节奏）。

## 9. 验收

- `npm run typecheck` 双 tsconfig 全绿 + `npm run build` 通过。
- 冒烟清单（运行时由开发者验证）：搜索订阅 → 首拉 10 集（不自动转写）→ 手点转写一篇（或 RSS 自带文字稿直接抓）→ 状态徽章流转 → 阅读视图导读卡生成 → 划词问 AI / 追问本集进「播客·追问」频道 → 新集入库自动转写（开关开）→ 退订二次确认连删 → 总导览「播客待读」数与深链 → 重启后队列恢复。
- AI 侧 typecheck/build 为验收线。
