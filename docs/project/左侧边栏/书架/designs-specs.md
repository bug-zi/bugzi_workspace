# 书架 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/书架/design.md`（260908 brainstorming 定稿并立项）生成，是开发的直接依据。设计全记录（六项决策与被否方案）见同目录 `2026-09-08-书架-design.md`。依赖：样式/designs-specs.md（ConfirmDialog / Toast 与主题色系约束、Material Symbols 用法）、个人中心/designs-specs.md（全局字体设置读取惯例）。**本模块零 AI**——不依赖 electron/ai/*（jobs/取消机制不涉及）、不新增 AiChannel、无画像注入。

## 0. 命名与常量

- `ModuleId` 增 `'bookshelf'`；App.tsx `MODULES` 注册 `{ id: 'bookshelf', label: '书架', icon: 'auto_stories' }`，位置在文笔坊与回收站之间（与信息源同期立项，最终顺序 wenbi → **bookshelf** → **feed** → recycle → profile）。
- **不新增 AiChannel**；`CHANNEL_BY_MODULE` 不列书架 → 默认 'assistant'（模块内无任何边栏联动与 AI 按钮）。
- db.ts 目录数组（db.ts:35）增两项：`'books'`、`'covers'`——`<userData>/books/<id>.<epub|pdf>`、`<userData>/covers/<id>.<jpg|png|webp>`。
- 封面经 bzres:// 加载：`bzres://root/covers/<file>`——bzres.ts 的 `root` 命名空间本就映射 userData 任意子路径且支持 png/jpg/webp/gif/bmp mime，**零协议改动**。
- 书籍二进制不走路由协议：`books:readFile` IPC 返回 Uint8Array，直接喂 epub.js `ePub()` / pdfjs `getDocument({ data })`（两库均接受 ArrayBuffer/TypedArray，避开 file:// 与 webSecurity 问题）。
- 新依赖（.npmrc 已配国内镜像，裸装即可）：`@flow/epubjs`（epub.js 维护中 fork；若与 React 19/TS 配合有坑，回退原版 `epubjs` 同用法，实施时定）、`pdfjs-dist`、`fflate`（主进程解 epub zip）、`fast-xml-parser`（主进程读 OPF，与信息源模块共用）。
- epub.js 无官方 TS 类型：类型缺失时补 `src/epubjs.d.ts` 的 `declare module` 最小声明（只声明用到的 ePub/Rendition/Book 接口），不引 @types/epubjs 全量。

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

- **版本号实况**：书架占 **v18**（当前库 v17）；与信息源（v19）互不依赖，若实施顺序对调则版本号对调，实施时以 db.ts 迁移链实际落点为准（文笔坊 v17 先例）。
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

- 视图态 `selectedBookId: number | null`——null 显书架、非 null 显 `<ReaderView book={…} onBack={…}>`（主栏内切换，写作台页面化同款语义）。
- 书架网格：封面卡 = 封面图（`bzres://root/` + cover_path）或书名占位卡 + 书名/作者 + 进度角标（`{percent}%` 或「未读」）+ `more_horiz` 菜单（删除）。顶栏「导入书籍」按钮（icon `upload_file`）。
- 列表排序 SQL：`ORDER BY (last_read_at IS NULL), last_read_at DESC, added_at DESC`。
- 导入流程：`books:browse()` → `books:import(paths)` → 结果含 duplicate → ConfirmDialog「N 本疑似已导入（列书名），仍要导入？」→ `books:import(dupPaths, true)`；failed → toast 错误；成功 → 刷新列表。
- 删除：ConfirmDialog（「彻底删除，不可恢复」——不入回收站措辞）→ `books:delete` → 刷新。
- `useModuleActivated('bookshelf', …)`：切回模块刷新列表；keep-alive 下阅读态与滚动位置天然保留。

### 3.2 EpubReader.tsx

- `ePub(uint8array)` → `rendition.renderTo(container, { width: '100%', height: '100%', flow: 'scrolled' })`（连续滚动，与 pdf 一致）；`display(progress_cfi ?? undefined)` 恢复。
- **主题注入**：iframe 内用不了外层 CSS 变量——`getComputedStyle(document.documentElement)` 读主题色变量取具体色值，`rendition.themes.default({ body: { color, background } })` 注入（浅色樱花粉黑字/深色宝蓝白字）；字号跟个人中心全局字体大小设置同源读取。
- **进度**：`book.locations.generate()`（大书异步，完成前 percent 显示旧值/「在读」）→ `rendition.on('relocated', …)` 取 CFI 与 percent，**节流 3 秒**调 `books:saveProgress`，组件卸载（返回书架）时再 flush 一次。
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
- [ ]  书架：网格陈列、无封面占位卡、排序（最近阅读在前、未读过按导入时间）
- [ ]  epub 阅读：滚动翻页、章节跳转按钮、进度%显示、CFI 恢复直达；pdf 阅读：连续滚动、懒渲染、页码指示、页码恢复
- [ ]  进度节流 3 秒落库 + 退出 flush；中途强杀重开进度大体不丢
- [ ]  双主题：epub 注入配色正确切换；pdf 容器背景跟主题；字号跟全局设置
- [ ]  删除：二次确认 → 记录与物理文件清理 → 书架刷新
- [ ]  坏文件：打开解析失败 toast 不崩；`npm run typecheck` / `npm run build` 通过
