# 收藏夹 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/收藏夹/2026-09-10-收藏夹-design.md`（260910 brainstorming 定稿）生成，是开发的直接依据。依赖：样式/designs-specs.md（ConfirmDialog / Toast 与主题色系、Material Symbols 用法）；「去原文」复用现有 `shell:openExternal` 通道（preload `window.api.openExternal(url)`，主进程仅放行 http/https）；**无新 npm 依赖、无 AI/LLM 调用、CSP 不动**（渲染层不发外部请求，抓取全在主进程）。

## 0. 命名与常量

- `ModuleId` 增 `'favorites'`；App.tsx `MODULES` 注册 `{ id: 'favorites', label: '收藏夹', icon: 'bookmark' }`，位置在藏书架与信息源之间（mottos → wiki → bookshelf → **favorites** → feed → …）。
- **不新增 AiChannel**（无任何 LLM 调用与边栏联动）；`CHANNEL_BY_MODULE` 不列 → 默认 'assistant'。
- **不入回收站**：RecycleSource 与回收站模块零改动。
- 「未分类」常驻大类：`is_system = 1` 锁定（禁删/改名/排序），`sort = 1000000000` 固定同级末位；`favorites:list` handler 里幂等 seed（categories 表空时插入，信息源 seedFeeds 同款）。
- **不预置内容大类**（网站/文章等由开发者自建，空态引导文案承担上手）。
- `fetchMeta` 超时 8s（`AbortSignal.timeout(8_000)`）、读取上限 64KB、常规浏览器 UA（信息源 fetchFeed 同款）。
- 拖拽：灵感泉同款 HTML5 拖拽（draggable + onDragStart 天然不与单击冲突，无自定义阈值逻辑）。

## 1. 数据表（DB v28）

> v27 已被 llm_usage（260910 第 31 轮）占用；db.ts migrate 末尾追加 `if (version < 28)` 块。

```sql
CREATE TABLE IF NOT EXISTS fav_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER,                       -- NULL = 大类；两级约束由服务层保证（建子类时父必须是大类）
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,         -- 同级排序（moveCategory 交换相邻两行值）
  is_system INTEGER NOT NULL DEFAULT 0,    -- 1 = 「未分类」，锁定不可删/改名/排序
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fav_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL,            -- 挂大类或子类均可
  name TEXT NOT NULL,
  url TEXT NOT NULL,                       -- 服务层校验 ^https?://，无唯一约束（允许重复收藏）
  desc_md TEXT NOT NULL DEFAULT '',        -- md 文本简介（存 DB，非 md 文件——见 §3.2）
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fav_items_cat ON fav_items(category_id, created_at DESC);
```

- **不依赖外键级联**（不依赖 PRAGMA）：`deleteCategory` 显式三步事务（§2.3）。
- `FavoriteCategory`（id/parent_id/name/sort/is_system/created_at）与 `FavoriteItem`（id/category_id/name/url/desc_md/pinned/created_at/updated_at）补 `src/shared/types.ts` + `src/renderer/api.d.ts`（双轨同款；snake_case 原始行直传，IPC 不做字段转换——信息源实况同款）。

## 2. 主进程 FavoritesService（新建 `electron/services/favorites.ts`）

### 2.1 列表与 seed

- `listFavorites()`：一次返回 `{ categories, items }`——categories 按 `ORDER BY sort, id`（未分类 sort=1e9 自然末位），items 按 `ORDER BY pinned DESC, created_at DESC, id DESC`。个人收藏百级量级，全量返回不分页。
- `seedUncategorized()`：categories 表空时 `INSERT INTO fav_categories (parent_id, name, sort, is_system, created_at) VALUES (NULL, '未分类', 1000000000, 1, now)`；在 `favorites:list` handler 幂等调用。

### 2.2 条目增改删 + URL 规范

- `addItem(name, url, descMd, categoryId)`：校验 url 匹配 `/^https?:\/\//i`（不匹配抛带 message Error；「自动补 https://」在渲染层输入侧做，服务层只做最终校验）、categoryId 存在；INSERT 返回整行。
- `updateItem(id, patch)`：patch 含 name/url/descMd/pinned/categoryId 任一，**每次更新回写 updated_at**；url 变更同校验。
- `deleteItem(id)`：直接删（渲染层二次确认后调用）。
- 同 URL 重复**不拦截**：渲染层保存前用已缓存的 items 自查，toast「已收藏于 ××」提示后仍继续保存。

### 2.3 分类增改删（含级联事务）

- `addCategory(name, parentId)`：parentId=null 建大类；非 null 时校验父存在且 `parent_id IS NULL`（父是子类则抛错——两级硬限制），新行 sort = 同级 max+1。
- `renameCategory(id, name)`：`is_system = 1` 抛错。
- `moveCategory(id, dir: 'up' | 'down')`：`is_system = 1` 抛错；同级集合（同 parent_id、排除 is_system）按 `sort, id` 排序找相邻行交换 sort。
- `deleteCategory(id)`：`is_system = 1` 抛错；**单事务三步**——① `UPDATE fav_categories SET parent_id = (被删行的 parent_id) WHERE parent_id = id`（子类上移一级，删大类时其子类升为大类）；② `UPDATE fav_items SET category_id = (未分类 id) WHERE category_id = id`（直属条目入未分类）；③ `DELETE FROM fav_categories WHERE id = id`。中途失败整体回滚。
- 「未分类 id」查询：`SELECT id FROM fav_categories WHERE is_system = 1`。

### 2.4 fetchMeta（抓取页面元信息）

- `fetchMeta(url)`：先做 §2.2 同款 URL 校验 → `fetch(url, { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 浏览器 UA } })` → **`res.body` 流式读取累计至 64KB 即 `reader.cancel()`**（防大页面整页下载；无 body 退 `res.text()`）→ 解码（charset 优先取 Content-Type header，其次正文 `<meta charset>`，`TextDecoder` 支持即可，失败退 utf-8）→ 截断到 `</head>` 为止，正则提取：`<title>` / `<meta property="og:title">` / `<meta name="description">` / `<meta property="og:description">`，优先级 og > 常规，HTML 实体基本解码。
- **任何失败（超时/非 2xx/编码异常/无结果）返回 `{ title: '', desc: '' }`，不抛错**——渲染层 toast「抓取失败，请手动填写」并允许手填保存，不阻塞。

## 3. 渲染层（`src/modules/favorites/`）

### 3.1 FavoritesModule.tsx（主视图）

- **顶栏**：大类 tab 行（万象库「百科 | 辩真」同款样式，横向滚动；未分类 tab 常驻末位）+ 搜索框 + 「分类管理」按钮（icon `category`）+「新增收藏」按钮（icon `add`）。
- **大类视图**：直属条目区（分组头「未分组直挂」样式与子类分组头区分）→ 其下各子类分组（子类标题行 + 条目列表）；条目排序 pinned 优先 + 时间倒序（列表态按 §2.1 序本地分组渲染）。
- **条目行**：名称（主题色链接文本）+ 一行摘要（`new URL(url).hostname` + desc_md 剥 md 截断）+ 置顶条目行首 `push_pin` 小图标；hover 行尾浮出「编辑（edit）/ 置顶切换（push_pin）/ 删除（delete）」图标按钮。
- **单击** → 打开详情弹窗（§3.2）；**Ctrl/⌘+单击** → `window.api.openExternal(url)`（onClick 判 `e.ctrlKey || e.metaKey`）。
- **拖拽**（灵感泉 HTML5 同款）：行 `draggable`，`dragIdRef` 记条目；drop 目标 = 当前大类内的直属区容器与各子类分组容器（dragover 高亮）；drop → `updateItem(id, { categoryId: 目标 })` + 刷新；**搜索视图下禁用拖拽**（跨大类移动走编辑弹窗改分类——首版明确不拖 tab）。
- **搜索**：输入非空切「搜索结果视图」——本地 filter name/url/desc（不区分大小写），结果行带分类路径标签（`大类 / 子类`），清空恢复当前大类视图。
- **空状态**：无任何收藏时居中引导文案 + 「新增收藏」按钮。
- `useModuleActivated('favorites', …)`：切回模块刷新列表。

### 3.2 详情弹窗（FavoriteDetailDialog，模块内自建）

> 设计定稿交互 = MdDialog「渲染态 + 双击进编辑」，但 **MdDialog 是文件态组件**（filePath 必填、md.read 加载），收藏简介按定稿存 DB——故自建轻量弹窗，视觉与交互对齐 MdDialog（复用 `MdView` 的 `renderMd` 渲染简介 + MdDialog.css 同款遮罩/布局风格）。

- **渲染态**：名称（标题）+ 分类路径副标题行（`大类 / 子类`）+ URL 行（可复制 icon `content_copy` + `open_in_new` 跳浏览器）+ 简介区（`renderMd(descMd)`，`==text==` 高光等 MdView 既有行为不涉及）。**双击正文区** → 编辑态。
- **编辑态**：表单——名称 / URL / 大类下拉 + 子类下拉（子类可不选 = 挂大类直属） / 置复开关 / 简介 textarea（md）。「保存」→ `updateItem` + toast + 刷新；Esc/遮罩关闭（编辑态有改动时先行 ConfirmDialog 防误关——MdDialog 编辑态防丢稿惯例）。
- 行尾 hover「编辑」按钮同样打开本弹窗并直接进编辑态。

### 3.3 新增收藏弹窗（FavoriteAddDialog，模块内自建）

- 字段：URL 输入 + 「抓取」按钮（抓取中「抓取中…」禁点）→ 成功自动填名称与简介（均可改），失败 toast 不阻塞；名称（必填，抓取成功预填后仍可空则校验拦）；简介 textarea（md）；分类选择（大类下拉必选、子类下拉可不选，默认当前大类）。
- 「保存」：URL 无协议自动补 `https://` → 前端格式校验不过则置灰 + 提示；同 URL 已存在 → toast「已收藏于 ××分类」后**仍继续保存**；成功关弹窗 + 刷新。

### 3.4 分类管理弹窗（CategoryManagerDialog，模块内自建）

- 两级树列表：大类行 + 缩进子类行；行内操作 icon 按钮——上移/下移（`arrow_upward`/`arrow_downward`）、改名（`edit`，行内切输入框回车保存）、删除（`delete`）；大类行额外「+ 子类」（`add`）；底部「新增大类」。
- 「未分类」行置灰只读（无任何操作按钮，固定末位）。
- 删除：ConfirmDialog 文案写明去向——「将删除分类「××」：其子分类上移一级，直属收藏移入未分类」；子类则「其直属收藏移入未分类」。

### 3.5 样式

- `src/modules/favorites/favorites.css`：全部用双主题既有变量（主题色链接、surface 分组卡、tab 样式对齐万象库），无彩亮色、无 emoji，图标全走 Material Symbols。

## 4. IPC 与 preload（ipc.ts + preload.ts + api.d.ts 三处同步）

| 通道 | 签名 | 行为 |
|---|---|---|
| `favorites:list` | `() => Promise<FavoriteList>` | 幂等 seed 未分类 → `{ categories, items }` 全量（§2.1 排序） |
| `favorites:addItem` | `(name, url, descMd, categoryId) => Promise<FavoriteItem>` | 校验入库，返回整行 |
| `favorites:updateItem` | `(id, patch) => Promise<FavoriteItem>` | 部分更新 + 回写 updated_at |
| `favorites:deleteItem` | `(id) => Promise<boolean>` | 直接删（前端二次确认后调用） |
| `favorites:addCategory` | `(name, parentId: number \| null) => Promise<FavoriteCategory>` | 两级校验（父必须是大类） |
| `favorites:renameCategory` | `(id, name) => Promise<boolean>` | is_system 抛错 |
| `favorites:moveCategory` | `(id, dir: 'up' \| 'down') => Promise<boolean>` | 同级相邻交换 sort |
| `favorites:deleteCategory` | `(id) => Promise<boolean>` | 三步事务级联（§2.3），is_system 抛错 |
| `favorites:fetchMeta` | `(url) => Promise<{ title: string; desc: string }>` | 失败返回空对象不抛错（§2.4） |

## 5. 接线

- App.tsx：`MODULES` 增 favorites（bookshelf 与 feed 之间）；FavoritesModule 懒加载注册；**不传 `onOpenAi`**。
- `src/modules/favorites/`：`FavoritesModule.tsx` + 三个弹窗（详情/新增/分类管理，可合 `FavoriteDialogs.tsx`）+ `favorites.css`。

## 6. 明确不做（design.md 背书）

- 点击计数自动排序、「最近添加」专区、favicon、死链检测、跨大类拖拽（拖 tab）——首版不做，记档留后续。
- 不入回收站（回收站八块与 RecycleSource 零改动）；无 LLM/MCP 调用（无置灰/去配置逻辑）；不分页/虚拟滚动；两级以上分类层级（服务层硬校验）；不对 url 做唯一约束。

## 7. 验收清单

- [ ]  DB v28 迁移：两表 + 索引建成，未分类自动 seed（is_system 锁定生效）；新装库顺序迁移覆盖
- [ ]  新增收藏：粘贴 URL 抓取成功自动填名称/简介；断网/404/超时失败 toast 后可手填保存；无协议自动补 https；非法 URL 保存置灰
- [ ]  同 URL 重复收藏：toast「已收藏于 ××」且仍可保存成功
- [ ]  条目交互：单击详情（渲染态/双击编辑/编辑防误关）、Ctrl+单击系统浏览器打开、hover 编辑/置顶/删除、置顶排序生效
- [ ]  拖拽：当前大类内拖到直属区/子类分组即时改所属；搜索视图禁拖；单击双击不受影响
- [ ]  分类管理：增大类/子类、改名、上下移排序、两级校验（子类下不可再建）；删空分类直接删；删非空大类 → 子类升大类 + 直属条目入未分类（刷新验证）；未分类全程锁定
- [ ]  搜索：跨全分类匹配名称/URL/简介、结果带分类路径标签、清空恢复
- [ ]  删除确认：条目与分类删除均有 ConfirmDialog（分类文案含去向说明）
- [ ]  左栏位置（藏书架与信息源之间）与 bookmark 图标；空态引导；双主题下 tab/链接/分组卡配色
- [ ]  `npm run typecheck` / `npm run build` 通过
