# 藏书架 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/书架/design.md`（260908 brainstorming 定稿并立项）生成，是开发的直接依据。设计全记录（六项决策与被否方案）见同目录 `archive/2026-09-08-书架-design.md`。依赖：样式/designs-specs.md（ConfirmDialog / Toast 与主题色系约束、Material Symbols 用法）、个人中心/designs-specs.md（全局字体设置读取惯例）。**本模块零 AI**——不依赖 electron/ai/*（jobs/取消机制不涉及）、不新增 AiChannel、无画像注入。260908 已实施（typecheck/build 通过，记录见 `docs/log/260908.md`）。
> **260908 显示名更名（开发者指令）**：藏书架 → **藏书架**（ModuleId `bookshelf`、目录名、DB/文件路径均不变，仅 UI 文案）。

## 0. 命名与常量

- `ModuleId` 增 `'bookshelf'`；App.tsx `MODULES` 注册 `{ id: 'bookshelf', label: '藏书架', icon: 'auto_stories' }`，位置（260908 重排后）在万象库与信息源之间（mottos → wiki → **bookshelf** → **feed** → … → recycle → profile）。
- **不新增 AiChannel**；`CHANNEL_BY_MODULE` 不列藏书架 → 默认 'assistant'（模块内无任何边栏联动与 AI 按钮）。
- db.ts 目录数组（db.ts:35）增两项：`'books'`、`'covers'`——`<userData>/books/<id>.<epub|pdf>`、`<userData>/covers/<id>.<jpg|png|webp>`。
- 封面经 bzres:// 加载：`bzres://root/covers/<file>`——bzres.ts 的 `root` 命名空间本就映射 userData 任意子路径且支持 png/jpg/webp/gif/bmp mime，**零协议改动**。
- 书籍二进制不走路由协议：`books:readFile` IPC 返回 Uint8Array，直接喂 epub.js `ePub()` / pdfjs `getDocument({ data })`（两库均接受 ArrayBuffer/TypedArray，避开 file:// 与 webSecurity 问题）。
- 新依赖（.npmrc 已配国内镜像，裸装即可）：`pdfjs-dist`、`fflate`（主进程解 epub zip）、`fast-xml-parser`（主进程读 OPF，与信息源模块共用）。epub 渲染引擎落地为原版 **`epubjs` 0.3.93**（自带 TS 类型）——设计候选 `@flow/epubjs` 经查 npm 不存在，specs 预留的回退路径生效。
- pdfjs-dist 实装 v6：`page.render({ canvas, viewport })` 直接收 canvas（v5 前的 canvasContext 为兼容保留）；worker 经 vite `?url` 资产导入（新增 `src/assets.d.ts` 的 `declare module '*?url'`）。

## 1. 数据表（DB v18）

```sql
CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL,                   -- 'epub' | 'pdf'
  file_path TEXT NOT NULL,                -- 'books/<id>.<ext>'（相对 userData，可迁移）
  cover_path TEXT,                        -- 'covers/<id>.<ext>'（NULL=无封面，渲染层用书名占位卡）
  file_size INTEGER NOT NULL DEFAULT 0,
  progress_cfi TEXT,                      -- epub：epub.js CFI 定位字符串
  progress_page INTEGER,                  -- pdf：当前页码（1 基）
  progress_percent REAL NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  last_read_at TEXT                       -- NULL=从未读过（排序用）
);
```

- **版本号实况（260908 实施落定）**：设计写 v18，被并行会话海龟汤计时（优化建议区第26轮）占用 v18，藏书架迁移实际占 **v19**（信息源占 v20）。
- `BooksRecord` 补 `src/shared/types.ts` + `src/renderer/api.d.ts` 两处（全库惯例）；file_path/cover_path 一律存相对路径。

## 2. 主进程 BookService（新建 `electron/services/books.ts`）

照 electron/services/ 现有拆分惯例（bzres/recycle/scheduler 同级）；ipc.ts 只留薄 handler。

### 2.1 导入

- `browse()`: `dialog.showOpenDialog`（filters: `{ name: '电子书', extensions: ['epub', 'pdf'] }`，properties: `['openFile', 'multiSelections']`）；取消返回 `[]`。
- `importBooks(paths, force?)` 逐本处理，返回 `ImportResult[]`：
  ```ts
  type ImportResult =
    | { path: string; status: 'imported'; book: BooksRecord }
    | { path: string; status: 'duplicate'; title: string }   // 同名文件 + 同大小，未 force 时跳过
    | { path: string; status: 'failed'; error: string }      // 复制/解析失败，副本回滚清理
  ```
- 流程：查重（`WHERE title = 文件名基名 AND file_size = 大小`，force 跳过）→ 复制到 `books/` → 解析元数据 → INSERT。任一步失败：unlink 副本与封面、返回 failed，**不留半成品**。
- **epub 元数据**：fflate 解包 → `META-INF/container.xml` 取 OPF 路径（fast-xml-parser）→ OPF 的 `dc:title` / `dc:creator` / manifest cover 项 → 封面图字节写 `covers/<id>.<按实际扩展>`；缺项逐级降级（title 退文件名、无封面置 NULL）。
- **pdf 元数据**：title = 文件名去扩展名，author 空，cover NULL（占位卡）；不引入 pdf 主进程渲染。

### 2.2 删除与读取

- `deleteBook(id)`：删 DB 行 + unlink books/covers 两物理文件（不存在静默）。
- `readBookFile(id)`：readFileSync → Uint8Array 返回。
- `saveProgress(id, { cfi?, page?, percent })`：更新进度字段 + `last_read_at = now`。

## 3. 渲染层（`src/modules/bookshelf/`）

### 3.1 BookshelfModule.tsx（壳）

- 视图态 `selectedBookId: number | null`——null 显藏书架、非 null 显 `<ReaderView book={…} onBack={…}>`（主栏内切换，写作台页面化同款语义）。
- 藏书架网格：封面卡 = 封面图（`bzres://root/` + cover_path）或书名占位卡 + 书名/作者 + 进度角标（`{percent}%` 或「未读」）+ `more_horiz` 菜单（删除）。顶栏「导入书籍」按钮（icon `upload_file`）。
- 列表排序 SQL：`ORDER BY (last_read_at IS NULL), last_read_at DESC, added_at DESC`。
- 导入流程：`books:browse()` → `books:import(paths)` → 结果含 duplicate → ConfirmDialog「N 本疑似已导入（列书名），仍要导入？」→ `books:import(dupPaths, true)`；failed → toast 错误；成功 → 刷新列表。
- 删除：ConfirmDialog（「彻底删除，不可恢复」——不入回收站措辞）→ `books:delete` → 刷新。
- `useModuleActivated('bookshelf', …)`：切回模块刷新列表；keep-alive 下阅读态与滚动位置天然保留。

### 3.2 EpubReader.tsx

- `ePub(uint8array)` → `rendition.renderTo(container, { width: '100%', height: '100%', flow: 'scrolled' })`（连续滚动，与 pdf 一致）；`display(progress_cfi ?? undefined)` 恢复。
- **主题注入**：iframe 内用不了外层 CSS 变量——`getComputedStyle(document.documentElement)` 读主题色变量取具体色值，`rendition.themes.default({ body: { color, background } })` 注入（浅色樱花粉黑字/深色宝蓝白字）；字号跟个人档全局字体大小设置同源读取。
- **进度**：`book.locations.generate()`（大书异步，完成前 percent 显示旧值/「在读」）→ `rendition.on('relocated', …)` 取 CFI 与 percent，**节流 3 秒**调 `books:saveProgress`，组件卸载（返回藏书架）时再 flush 一次。
- 翻页导航：scrolled 流式下滚动即翻页；容器顶部/底部各留 `arrow_upward`/`arrow_downward` 浮动按钮做章节级跳转兜底（`book.spine` 上下章）。

### 3.3 PdfReader.tsx

- `getDocument({ data: uint8array })`；worker 用 vite `?url` 资产导入设 `GlobalWorkerOptions.workerSrc`（electron-vite 渲染层惯例，实施时按构建产物核对路径）。
- 连续滚动视图：全部页占位 div（按 page.getViewport 比例定高），IntersectionObserver 懒渲染可见页 ±1 页 canvas（devicePixelRatio 缩放）。
- 恢复：挂载后 `scrollIntoView` 到 `progress_page`；滚动中记录当前页（IO 回调），**节流 3 秒** `books:saveProgress({ page, percent: page/total })`，卸载 flush。
- 顶栏页码指示 `n / total`。

## 4. IPC 与 preload（ipc.ts + preload.ts + api.d.ts 三处同步）

| 通道 | 签名 | 行为 |
|---|---|---|
| `books:list` | `() => Promise<BooksRecord[]>` | 排序见 §3.1 |
| `books:browse` | `() => Promise<string[]>` | 系统对话框多选 epub/pdf，取消 `[]` |
| `books:import` | `(paths: string[], force?: boolean) => Promise<ImportResult[]>` | §2.1，逐步复制解析入库 |
| `books:readFile` | `(id) => Promise<Uint8Array>` | 书籍二进制，喂渲染引擎 |
| `books:saveProgress` | `(id, p: { cfi?: string; page?: number; percent: number }) => Promise<void>` | 进度 + last_read_at |
| `books:delete` | `(id) => Promise<void>` | 删记录 + 物理文件，彻底删除 |

- **无 LLM 通道**——不接 jobId/`ai:cancel` 取消机制（全局取消只覆盖 AI 生成任务，260908 机制不动）。

## 5. 接线

- App.tsx：`MODULES` 增 bookshelf；BookshelfModule 懒加载注册（推理角/文笔坊同款写法）；**不传 `onOpenAi`**（零 AI 模块）。
- `src/modules/bookshelf/`：`BookshelfModule.tsx` + `EpubReader.tsx` + `PdfReader.tsx` + `bookshelf.css`（或复用 App.css 区块样式，实现时随现有惯例）。

## 6. 明确不做（design.md 背书）

- 书签/高亮/笔记、阅读器内字号独立调节、书籍搜索/分类、mobi/txt 格式、目录抽屉（全部进 v2 备选）。
- 不入回收站（回收站八块与 RecycleSource 枚举零改动）。

## 7. 验收清单

- [ ]  DB v18 迁移：books 表建成、books/covers 两目录 ensure、新装库顺序迁移覆盖
- [ ]  导入：epub（title/author/封面提取）与 pdf（文件名/占位卡）；多选批量；重复导入确认流（跳过/强导入）；解析失败副本清理 + toast
- [ ]  藏书架：网格陈列、无封面占位卡、排序（最近阅读在前、未读过按导入时间）
- [ ]  epub 阅读：滚动翻页、章节跳转按钮、进度%显示、CFI 恢复直达；pdf 阅读：连续滚动、懒渲染、页码指示、页码恢复
- [ ]  进度节流 3 秒落库 + 退出 flush；中途强杀重开进度大体不丢
- [ ]  双主题：epub 注入配色正确切换；pdf 容器背景跟主题；字号跟全局设置
- [ ]  删除：二次确认 → 记录与物理文件清理 → 藏书架刷新
- [ ]  坏文件：打开解析失败 toast 不崩；`npm run typecheck` / `npm run build` 通过

## 8. 优化第 1 轮（260908 立项实施，260909 开发者验证通过；设计记录 `archive/2026-09-08-书架优化-design.md`，来源 `优化设计.md`）

> 设计决策记录（含被否方案）见 `archive/2026-09-08-书架优化-design.md`（落地后归档）。本节为实施直接依据。改动面：`src/modules/bookshelf/` 全量 + db.ts（v24）+ books.ts + ipc.ts/preload.ts/api.d.ts/shared/types.ts + SettingsKeys 一键；藏书架视图（封面网格/导入/删除）零改动。**实施中四处偏离初稿、经开发者反馈修错定稿**（详见 `docs/log/260908.md` 三节修错 + `260909.md` 两节）：模式切换改全量重挂、W/S 改按住流式滚动、标注同步竞态修复、容器 X 轴钳制——本节按最终实况书写。

### 8.1 宽度与防横向拖拽

- `bookshelf.css`：`.bk-reader-page.bk-reader-wide { max-width: 1200px }`——epub 阅读视图由 BookshelfModule 按书籍格式加 `bk-reader-wide` 类；**pdf 不加，维持 980px**。
- EpubReader 主题注入（applyTheme）追加护栏规则（epub.js themes 按原始选择器 insertRule，逗号键可用）：
  - `'img, svg, video, table': { max-width: '100%', height: 'auto' }`
  - `pre: { overflow-x: 'auto' }`（代码块横向溢出块内消化）
- `.bk-epub-host` 加左右内边距（`padding: 12px 36px 24px`），文字不贴边。
- **容器层钳制（260909 修错）**：epub.js scrolled 模式给内层 `.epub-container` 设行内 `overflow: auto` 含 X 轴——`bookshelf.css` 增 `.bk-epub-host .epub-container { overflow-x: hidden !important }`（行内样式需 important 覆盖；竖向滚动不受影响）。翻页模式另加 `.bk-epub-host.bk-page-mode { overflow: hidden }`（宿主禁滚，防分页视图数像素溢出被拖动）。
- **挂载后重排（260909 修错）**：EpubReader 挂 ResizeObserver 监听 host（防抖 80ms，覆盖侧栏开合/窗口缩放——epub.js 只听 window resize）调 `rendition.resize(w, h)`；且首帧 display 完成后立即按**内容盒净尺寸**（clientWidth/Height 减 padding；直传含 padding 值会令容器溢出）重排一次，消除挂载竞态下的旧宽残留（切模式后首视图横向可拖、跳章即消失的根因）。

### 8.2 键盘导航（双模式映射；260909 修订：W/S 按住流式滚动）

- `src/modules/bookshelf/readerKeys.ts`：`parseReaderKey(e)`——W/↑、S/↓、A/←、D/→（大小写不敏感）；焦点在 input/textarea/contentEditable 时返回 null（输入保护）；`dirOfKey(e)` 为无输入保护的键值归一（keyup 停滚动必须总能归一——防「按住时焦点移入输入框再松开」泄漏滚动）。
- `createHoldScroller()`（260909 修订）：keydown（忽略系统重发）登记方向并启动 rAF 循环，逐帧小步 `scrollTop`（约 550px/s）→ 长按连续流动、松开即停、轻点小幅位移；window blur 与组件卸载兜底全停。**epub 滚真实容器 `.epub-container`**（scrolled 流式的滚动容器是它而非宿主），pdf 滚宿主。
- EpubReader / PdfReader 各挂 window keydown/keyup（`preventDefault`），共用映射表：

| 按键 | 滚动模式 | 翻页模式 |
|---|---|---|
| W / ↑（按住） | 流式上滚（≈550px/s） | 上一节 |
| S / ↓（按住） | 流式下滚 | 下一节 |
| A / ← | 上一章 | 上一页（epub `rendition.prev()`；pdf 单页视图 -1） |
| D / → | 下一章 | 下一页（epub `rendition.next()`；pdf +1） |

### 8.3 双阅读模式（260909 修订：epub 模式切换全量重挂）

- BookshelfModule 阅读条加模式切换按钮（显示「滚动」/「翻页」）；settings 新键 `SettingsKeys.BooksReadingMode = 'books_reading_mode'`（值 `scroll`|`page`，默认 scroll），全局记忆，打开书时读取。
- **EpubReader 模式切换 = 换 key 全量重挂**（`key={`${id}-${mode}`}`）：`rendition.flow()` 运行时切换与「同 Book 销毁重建 rendition」两版实测均有排版/空白 wart（scroll→page 方向），彻底重开最稳；toggleMode 先 `books:list` 取最新进度行更新 `reading`（防节流 3 秒窗口内进度丢失回跳到开书位置）。renderTo 初始 flow = `scrolled|paginated` + `spread: 'none'`（单栏）；代价为重读文件 + locations 后台重建（期间 percent 用内置近似，CFI 恢复不受影响）。
- PdfReader 接收 `mode` prop（key 不含 mode，内部重建）：scroll = 现有连续滚动实现不动；page = 单页居中视图——当前页 canvas 按容器宽渲染（`width/height auto` + `max-width/height 100%` 防长页裁剪），离屏 canvas 渲染后 blit（缓存当前 ±1 页防闪白），A/D 翻页（边界 clamp），进度照常页码节流落库、恢复直达。

### 8.4 目录侧栏（双页签：目录 | 笔记）

- 新建 `src/modules/bookshelf/ReaderSidebar.tsx`（展示组件）：约 240px，左侧滑入，页签切换；`ReaderTocItem { label, href?, page?, depth, children? }` 渲染递归缩进列表。
- BookshelfModule 持侧栏状态 `{ open, tab }`；阅读条「目录」按钮（icon `toc`）开合；展开态仅会话内。
- 数据上行：readers 加载完成后 `props.onToc(items)` 上报——epub `book.loaded.navigation`（NavItem.subitems 递归）；pdf `pdf.getOutline()` + `dest → getPageIndex → 页码`。
- 跳转下行：readers 经 `useImperativeHandle` 暴露 `jumpToCfi / jumpToToc(href)`（epub）、`jumpToPage(n)`（pdf），侧栏点击调 ref。
- 当前章节高亮：epub relocated 记录当前 href → 侧栏项 active；pdf 按当前页落在的 outline 区间 active。
- 无目录显示「本书无目录」占位；pdf 翻页模式 W/S = outline 顶层序列前后跳（无 outline 不响应）。

### 8.5 笔记本（仅 epub；DB v24）

- v24 迁移：`book_notes` 表（id / book_id / cfi_range / quote / note DEFAULT '' / created_at）；`books:delete` 级联 `DELETE FROM book_notes WHERE book_id = ?`。
- `BooksNote` 接口（shared/types.ts + api.d.ts）；BookService 四方法 + IPC 四通道：

| 通道 | 签名 | 行为 |
|---|---|---|
| `books:notesList` | `(bookId) => Promise<BooksNote[]>` | created_at 倒序 |
| `books:noteAdd` | `(bookId, { cfiRange, quote, note? }) => Promise<BooksNote>` | 新增（note 缺省 ''） |
| `books:noteUpdate` | `(noteId, note) => Promise<boolean>` | 编辑批注 |
| `books:noteRemove` | `(noteId) => Promise<boolean>` | 彻底删除（渲染层二次确认） |

- 状态归属：BookshelfModule 持 `notes` state（进阅读视图时 notesList，pdf 为空数组），传 EpubReader 渲染标注；增删改经回调（`onAddNote/onUpdateNote/onRemoveNote`）由模块走 IPC + setState，删除先 ConfirmDialog。
- 划词浮窗：`rendition.on('selected', (cfiRange, contents))` → `contents.range(cfiRange)` 取矩形，叠加 iframe 与 host 偏移（含 scrollTop）定位 `bk-sel-bubble`（absolute 挂 host 内，随滚动）。「高光」= noteAdd(note='')；「批注」= 浮窗展开 textarea 保存。同 cfiRange 已存在 → toast「已有高光」不入库。
- 标注渲染：EpubReader 的 `syncAnnotations()`（**260908 修错：抽为统一入口并在 createRendition 首帧 display 后补调——书文件读取与 notes 加载竞态曾致标注整轮不渲染**）读 notesRef diff 增删——`annotations.highlight(cfi, {id}, cb, 'bz-hl', { fill: 主题色, 'fill-opacity': '0.4', 'mix-blend-mode': 'multiply' })`；有批注的再加 `underline(cfi, {id}, cb, 'bz-hl-ul', { stroke: 主题深色, 'stroke-opacity': '0.9', 'mix-blend-mode': 'multiply' })`。cb 点击高亮 → 气泡（原文 + 批注 + 编辑/删除；marks-pane 从 iframe 代理的 click 坐标为 iframe 系，`proxiedPointInHost` 换算定位）。主题切换按色值代全量重涂。
- 笔记页签：原文两行截断 + 批注 + 相对时间 + 删除按钮；点击 `rendition.display(cfiRange)` 跳回。pdf 显示「PDF 暂不支持划词笔记」。

### 8.6 划词/高光主题色

- applyTheme 注入 `'::selection': { background: <'--color-selection' 具体值> }`（浅色樱花粉半透明 / 深色宝蓝半透明，与全局划词色同源）。
- 高亮 fill 取 `--color-selection`、批注下划线 stroke 取 `--color-primary-deep` 具体值；主题切换随 applyTheme 重注入 + 标注重涂（remove 全部再 add）。

### 8.7 验收（260909 开发者验证通过）

- [x] epub 任意书无横向拖拽（宽容器 1200px + 护栏）；pdf 维持 980px
- [x] 双模式按键映射全表生效；批注输入时打字不触发导航
- [x] 模式切换保位置、全局记忆、重启恢复；pdf 单页翻页不闪白
- [x] 目录侧栏双引擎跳转准确、当前章节高亮、无目录占位
- [x] epub 划词→高光/批注→重开书仍在；笔记页签跳回定位准；编辑/删除闭环（删除二次确认）
- [x] 划词色/高亮色随双主题切换；删书清笔记；typecheck/build 通过

## 9. 书架 v2.0（260910 立项实施；设计记录同目录 `2026-09-10-书架v2-design.md`，实施计划 `2026-09-10-书架v2-plan.md`）

> 五功能一轮落地：手动书签 / 笔记总览 md（只读弹窗 + 导出）/ epub 字号每书独立 / 阅读统计 / 每书模式记忆。pdf 划词与第 1 轮旧否决项维持不做。
> **版本号实况**：设计写 DB v28，被并行会话收藏夹占用，实际落 **v29**（v18/v19 先例同款条款）。
> 改动面：`src/modules/bookshelf/`（含新建 useReadingTimer.ts）+ MdDialog.tsx 三可选 prop + db.ts（v29）+ books.ts + ipc/preload/api + shared/types；书架网格/导入/删除主流程不动。

### 9.1 数据（DB v29）

- `books` 加 `reading_mode TEXT`（'scroll'|'page'，NULL=回落全局 settings 键，存量书零迁移）、`font_scale REAL`（0.75~1.5，NULL=回落个人档全局字体）。
- 新表 `book_marks`（id/book_id/cfi/page/label/created_at；epub 行 cfi 非空、pdf 行 page 非空）与 `book_read_log`（book_id+day UNIQUE，seconds 累加）。
- `deleteBook` 级联清 book_notes / book_marks / book_read_log；偏好两列随 books 行删除。类型同步 shared/types.ts + api.d.ts 两处（BooksRecord 两字段 + BookMark/ReadStatsRow/ReadStats）。

### 9.2 手动书签（设计 §二）

- 加：阅读条 `bookmark_add` 按钮（epub/pdf 都显）→ EpubReader `getCurrent()` 句柄取当前 CFI+百分比（pdf 用模块 locate.page 兜底 progress_page）→ label 取章节名（epub 按 locate.href 查 flattenToc / pdf 按 tocAnchorAt），兜底「约 X%」「第 N 页」；同 CFI/同页渲染层查重 toast「已有书签」。
- 侧栏三页签（目录|笔记|书签）：倒序列表 label+相对时间+删除；点击跳回（epub display(cfi) / pdf jumpToPage）；删除 ConfirmDialog 二次确认彻底删。

### 9.3 笔记总览 md 与导出（设计 §三）

- MdDialog 渐进扩三可选 prop：`content`（直传内容不读文件，filePath 转可选）、`readOnly`（隐藏编辑提示+双击不进编辑态）、`headerAction`（头部动作按钮）——既有调用方零改动；实施修正：prop 解构为 `content: directContent` 防与组件 content state 重名，md.write 分支加 filePath 守卫。
- 入口：侧栏笔记页签头部「总览」icon 按钮（仅 epub、空笔记禁用）→ `books:notesOverviewMd` 取主进程按需生成 md（created_at 正序、quote 折叠换行、`<sub>` 时间戳、`---` 分隔、头含 H1+作者·N 条·生成于）→ MdDialog readOnly 打开（内容即快照）。
- 导出：弹窗 headerAction「导出」→ `books:exportNotes`（主进程 showSaveDialog 默认名《书名》读书笔记.md、书名清洗非法字符、写盘返回路径；取消 null 静默）→ toast 已导出到路径。

### 9.4 每书独立偏好（设计 §四）

- 统一通道 `books:setReadingPref(bookId, {mode?, fontScale?})` 部分更新；fontScale null 清除。
- 模式记忆：openBook 取 `book.reading_mode ?? settings(BooksReadingMode) ?? scroll`；toggleMode 双写（书级列 + 全局键「最近使用」，NULL 书跟随最近习惯）；epub 全量重挂流程不变。
- 字号（仅 epub）：阅读条 [A-][100%][A+]（NULL 显 100%），0.75~1.5 步 0.05 钳制；非 NULL 时出现「默认」按钮清除回落全局。EpubReader applyTheme 收 fontScale 参数（body font-size = 全局计算值 × scale），scale 变化即时重注入不重挂（[fontScale] effect）。

### 9.5 阅读统计（设计 §五）

- `useReadingTimer.ts`（新建）：挂阅读视图层（active=reading 非空，锚 readerPageRef），每秒 tick 检查三条件——document 可见 + 窗口聚焦 + 宿主 rect 高度>0（防 keep-alive 切走模块 display:none 虚计）；满 30 秒 flush `books:addReadTime`（UPSERT 按书按日递增），退出 flush 余量，强杀丢 ≤30 秒。
- 书架 header 下统计条（icon schedule）：今日 X 分钟 · 连续 N 天 · 在读 M 本；三项全零整行隐藏；点击展开主栏面板（每书「累计时长·进度%·最近阅读」最近在前 + 合计行）。
- 口径：今日=当日秒和（分钟向下取整，>0 不足 1 分显「<1 分钟」）；连续天数=从今天（无记录从昨天）往前连续有记录天数；在读=读过且未读完（last_read_at 非空且 percent<100）；`books:readStats` 主进程一次聚合。

### 9.6 IPC 汇总（8 通道，三处同步）

`books:marksList / markAdd / markRemove / setReadingPref / addReadTime / readStats / notesOverviewMd / exportNotes`——签名与行为见设计 §六表。

### 9.7 验收（待开发者手测）

- [ ] DB v29 两列两表、删书级联清三表（notes/marks/read_log）
- [ ] 书签：epub/pdf 加/跳/删闭环、同位置去重、label 章节名/兜底正确、删除二次确认
- [ ] 总览：正序格式、readOnly 双击不编辑、导出默认名/成功 toast/取消静默；MdDialog 既有模块零回归
- [ ] 模式记忆：切过的书固定、NULL 书跟随最近使用、存量书零迁移、双写生效
- [ ] 字号：A±即时生效不丢进度、边界钳制、「默认」回落全局、每书互不影响、pdf 无控件
- [ ] 统计：失焦/最小化/切模块暂停、30 秒 flush、今日/连续/在读口径、面板每书累计
- [ ] 双主题新 UI 合规、无 emoji、typecheck/build 通过
