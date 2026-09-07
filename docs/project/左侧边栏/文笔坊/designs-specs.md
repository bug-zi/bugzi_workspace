# 文笔坊 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/文笔坊/design.md`（260907 brainstorming 定稿并立项）与《总需求文档.md》生成，是开发的直接依据。设计全记录（八项决策与被否方案）见同目录 `archive/2026-09-07-文笔坊-design.md`。依赖：样式/designs-specs.md（MdDialog / MdView / ConfirmDialog / GoConfigDialog / Toast 与主题色系约束）、回收站/designs-specs.md（接入约定）、灵感泉/designs-specs.md（四区流转同构参照）、个人中心/designs-specs.md（profileDigest 注入惯例）。260908 已实施（记录见 `docs/log/260908.md`）。

## 0. 命名与常量

- `ModuleId` 增 `'wenbi'`；App.tsx `MODULES` 注册 `{ id: 'wenbi', label: '文笔坊', icon: 'history_edu' }`，位置在推理角与回收站之间。
- 双板块：`'journal'`（浮生记）/ `'writing'`（写作台），照 ReasoningModule 先例——`.recycle-tabs` 样式做板块切换 pill，两面板常驻挂载（`module-live` / `module-live module-hidden` 切换显隐），默认浮生记、选择不持久化。
- md 目录（db.ts `ensureDirs` 数组增两项）：`md/wenbi/journal/`（浮生记条目）、`md/wenbi/article/`（写作台文章）；路径形如 `md/wenbi/journal/<id>.md`。
- **不新增 AiChannel**（五频道不动）；AiSidebar 频道映射无需改动——App.tsx `CHANNEL_BY_MODULE` 对未列出模块默认 'assistant'，文笔坊即落默认。
- 文章分区常量：`zone: 'idea' | 'writing' | 'done' | 'published'`（构思区/写作区/完稿区/已发布区），顺序即流转顺序。

## 1. 数据表（DB v17）

```sql
CREATE TABLE wenbi_journals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  md_path TEXT NOT NULL,                 -- md/wenbi/journal/<id>.md
  is_event INTEGER NOT NULL DEFAULT 0,   -- 大事件标记（0/1）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE wenbi_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  zone TEXT NOT NULL DEFAULT 'idea',     -- 'idea' | 'writing' | 'done' | 'published'
  md_path TEXT NOT NULL,                 -- md/wenbi/article/<id>.md
  sort INTEGER NOT NULL DEFAULT 0,       -- 区内排序（拖拽顺序）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

- **版本号实况（260908 实施落定）**：v16 已被格言墓碑（优化建议区第 24 轮，motto_tombstones）占用，文笔坊迁移实际占 **v17**；表名落地为复数 `wenbi_journals` / `wenbi_articles`（全库复数惯例，质量审查采纳），索引 `idx_wenbi_articles_zone`；RecycleSource slug（`wenbi_journal`/`wenbi_article`）与 md 目录名（`md/wenbi/journal/`、`md/wenbi/article/`，对齐 md/turtle、md/wall 先例）保持单数不变。
- `WenbiJournalRecord` / `WenbiArticleRecord` 补 `src/shared/types.ts` + `src/renderer/api.d.ts` 两处；回收站 payload 序列化整条 record。

## 2. 浮生记（journal 板块，零 AI）

### 2.1 视图

- 顶部「+ 记一条」按钮（模块头部右侧）；分节粒度 pill「按月 / 按周」，默认**按月**，周按**周一至周日**计，不持久化。
- 时间线列表按 `created_at` 倒序分节：按月节头「2026年9月」，按周节头「9/7–9/13」。
- **大事件置顶小节**：`is_event=1` 的条目额外聚合在列表顶部「大事件」小节（倒序），与时间线内正常出现并存。
- 行组件：**创建日期**（yyyy/M/d）+ 首行摘要（md 正文首个非空行，去 markdown 记号，截 50 字）+ 大事件 icon（`flag`，如有）+ 右侧回收站 icon。行内日期钉在创建日——事后编辑只 bump `updated_at`，不影响分节位置（分节一律按 `created_at`）。
- 空态：`empty-state`「随手记点什么」。

### 2.2 新建与编辑

- 「+ 记一条」→ IPC 建记录 + 空 md 文件 → 打开 MdDialog（title=`浮生记 · 2026/9/7`，filePath=md_path，**autoEdit** 直接进入编辑态，致知己新建 v1 同款）。
- MdDialog 新增可选扩展位 `eventToggle`（照 `versioned` 先例）：
  ```ts
  /** 浮生记大事件标记（仅浮生记传入）：编辑态工具行显示开关 */
  eventToggle?: { checked: boolean; onChange: (v: boolean) => void }
  ```
  开关切换即调 `wenbi:journalSetEvent`（不退出编辑态），行组件 icon 同步。
- 编辑保存走 MdDialog 默认 `md.write`；关闭弹窗后列表刷新（摘要可能变化）。

### 2.3 零 AI 边界（硬性）

- 浮生记 UI 无任何 AI 按钮、模块不接 `onOpenAi`、不注入画像；**`md/wenbi/journal/` 路径不得进入任何 AI prompt 构造路径**（§4 copilot 亦然）。

### 2.4 删除

- 行回收站 icon → ConfirmDialog（「放入回收站，3 天后自动彻底删除」）→ `wenbi:journalDiscard(id)`（软删 + `discardToRecycle('wenbi_journal', id)`）。

## 3. 写作台（writing 板块）

### 3.1 四区看板（灵感泉同构）

- 四区展示：构思区 → 写作区 → 完稿区 → 已发布区（推荐四列看板、窄屏纵向堆叠，实现时定）；区头 = 区名 + 条数 + 「+」。
- 行组件：标题 + 更新时间 + `more_horiz` 通用菜单 + 回收站 icon。
- 新建：区头「+」→ 弹窗输入标题 → 建记录 + md（模板 `# {标题}\n`）→ MdDialog 打开并 **autoEdit** 进入编辑态；任何区可直接新建。
- 跨区移动：拖拽（主方式，改 zone + sort，区内可排序）+ 菜单「移动到 → 其余三区」兜底；移动即时生效无确认。
- 「已发布」为手动状态记录；已发布区不自动删除（同灵感泉归档区），可拖回再开发。
- 标题：MdDialog `onTitleChange` 可编辑（改后列表同步），走 `wenbi:articleRename`（**不动 updated_at**，drafts 改名先例）。

### 3.2 通用菜单（more_horiz）

- 「移动到」组：除当前区外三区；
- 分隔线后：「复制 Markdown」（icon `content_copy`）、「导出 .md」（icon `download`）。

### 3.3 复制 / 导出

- **复制 Markdown**：渲染层 `window.api.md.read(md_path)` → `navigator.clipboard.writeText` → toast「已复制 Markdown」。
- **导出 .md**：`wenbi:articleExport(id)`——主进程读 md → `dialog.showSaveDialog`（默认文件名 `{title}.md`）→ 写入用户选择路径；取消返回 null 不 toast，成功 toast「已导出」。
- 发布动作本身在博客站手动完成，App 内不做任何对接（明确不做）。

### 3.4 删除与恢复

- 行回收站 icon → ConfirmDialog → `wenbi:articleDiscard(id)` → 回收站「文笔坊」板块；**恢复回构思区**（§5）。

## 4. Copilot 协笔（仅写作台，AI 永不直接改正文）

### 4.1 MdDialog 扩展位 `copilot`

```ts
/** 写作台协笔（仅写作台传入）：MdDialog 编辑态提供起稿/续写/润色/改写入口与建议预览卡 */
copilot?: {
  /** 发起请求；LLM 未配置时 reject LLM_NOT_CONFIGURED，由调用方弹 GoConfigDialog */
  request: (
    action: 'draft' | 'continue' | 'polish' | 'rewrite',
    ctx: { title: string; content: string; selection?: string }
  ) => Promise<string>
}
```

- **入口**（仅编辑态）：工具行四按钮常驻——「AI 起稿」（icon `auto_awesome`）、「续写」（icon `arrow_forward`）常亮；「润色」（icon `brush`）、「改写」（icon `refresh`）仅在 textarea 有选区时可用（未选中 disabled + title 提示）。落地简化自原「选区浮出条」设计（textarea 无原生选区坐标 API，镜像 div 计算脆弱），交互语义等价。
- **建议预览卡**：任一操作点击 → 按钮 loading → 返回后弹窗内浮层卡：标题（起稿/续写/润色/改写）+ 上下对照（润色/改写：原文选区 vs AI 版；起稿/续写：仅 AI 版）+ 按钮「重新生成」「放弃」「采纳」。
- **采纳语义**：润色/改写 = 替换当前选中文本；起稿/续写 = 插入光标处（无焦点/光标则文末追加）。采纳只改 textarea 内容（setContent/draft），**不落盘**——落盘仍走编辑退出保存，防半成品写库。
- 生成中不可再发起；失败（含 LLM_NOT_CONFIGURED）toast/弹窗后恢复可用。
- **采纳后的文本不做任何 AI 标记**（与灵感泉「AI 补充」时间戳刻意不同）。

### 4.2 IPC 与服务

| 通道 | 签名 | 行为 |
|---|---|---|
| `wenbi:copilot` | `(id: number, action, selection?: string) => Promise<string>` | 主进程读文章 title+md → `copilotWriting()` 三分支 → 返回建议文本；LLM 未配置抛 `LLM_NOT_CONFIGURED` |

- `electron/ai/services.ts` 新增 `copilotWriting(articleId, action, selection?)`，与 `generateMottos` / `refineInspiration` 同区同构，复用 `chatCompletion`（llm.ts 统一 429 退避）。
- prompt 构造（`${profileDigest()}${profileDigest() ? '\n\n' : ''}` 前缀惯例）：
  - 注入：我的画像 + 文章标题 + 正文（超 4000 字截断；polish/rewrite 额外标明「待处理选段」原文）。
  - 人设：懂我的写作搭档；输出**纯 Markdown 文本、不带任何解释或代码围栏**。
  - 四分支：draft（基于标题出大纲+开头，≤500 字）、continue（顺着正文往下写 200~400 字）、polish（保持原意优化表达）、rewrite（换一种写法重写该段）。
  - temperature：draft/continue 0.7，polish/rewrite 0.4。
- **LLM 未配置**：按钮不置灰，调用方捕获 `LLM_NOT_CONFIGURED` → GoConfigDialog（kind='llm'，复用格言库 goConfig 模式）。

### 4.3 明确不做

- 不做全篇润色（只作用于选段）；不做边栏对话频道；浮生记内容永不出现在任何 copilot prompt。

## 5. 回收站接入（第八块）

- `RecycleSource` 增 `'wenbi_journal' | 'wenbi_article'`；`TABLES` 增两映射（`wenbi_journal` / `wenbi_article`）；`MD_FIELDS` 增 `wenbi_journal: 'md_path'`、`wenbi_article: 'md_path'`。`src/renderer/api.d.ts` 的 `RecycleRow.source` 联合同步。
- `RecycleModule` `TABS` 增 `{ key: 'wenbi', label: '文笔坊' }`（草稿本之后）；`tabOf`：两来源 → `'wenbi'`（组页签，照推理角先例）。
- `backToOf`：`wenbi_journal` → 「浮生记时间线」；`wenbi_article` → 「写作台构思区」。
- `summaryOf`：journal → `2026/9/7 的记录`（payload `created_at` 拼）；article → `String(p.title ?? '')`；行内再以「（浮生记）/（文章）」小字区分来源板块（payload 含 md_path 可判：含 `/journal/` 为浮生记）。
- `restoreFromRecycle` 增分支：journal → `UPDATE wenbi_journal SET deleted_at = NULL`；article → `UPDATE wenbi_article SET deleted_at = NULL, zone = 'idea', sort = (SELECT IFNULL(MAX(sort),0)+1 FROM wenbi_article WHERE zone='idea' AND deleted_at IS NULL)`（恢复回构思区区末）。
- `hardDelete`：两表删行 + `mdDelete(md_path)`（MD_FIELDS 通用路径自动覆盖）；3 天 `cleanupExpired` 同样自动覆盖。
- 回收站/designs-specs.md 来源枚举同步补两值（注明接入细节见本文档）。

## 6. IPC 与 preload（ipc.ts + preload.ts + api.d.ts 三处同步）

| 通道 | 签名 | 行为 |
|---|---|---|
| `wenbi:journalList` | `() => Promise<WenbiJournalRecord[]>` | 过滤 deleted_at，created_at 倒序 |
| `wenbi:journalCreate` | `() => Promise<WenbiJournalRecord>` | 建记录 + 空 md，返回新行 |
| `wenbi:journalSetEvent` | `(id, isEvent: boolean) => Promise<void>` | 大事件标记切换（不动 updated_at） |
| `wenbi:journalDiscard` | `(id) => Promise<void>` | 软删 + 入回收站 |
| `wenbi:articleList` | `() => Promise<WenbiArticleRecord[]>` | 过滤 deleted_at，区内按 sort |
| `wenbi:articleCreate` | `(zone, title: string) => Promise<WenbiArticleRecord>` | 建记录 + md（`# {标题}\n`），sort 取该区 MAX+1 |
| `wenbi:articleRename` | `(id, title: string) => Promise<void>` | 改标题（不动 updated_at） |
| `wenbi:articleMove` | `(id, zone, sort: number) => Promise<void>` | 拖拽/菜单移动（bump updated_at） |
| `wenbi:articleReorder` | `(moves: { id, zone, sort }[]) => Promise<void>` | 拖拽重排后区内 sort 归一化（灵感泉 reorder 同构） |
| `wenbi:articleTouch` | `(id) => Promise<void>` | MdDialog 编辑保存后 bump updated_at（drafts touch 先例；App 在 onChanged 接线） |
| `wenbi:articleDiscard` | `(id) => Promise<void>` | 软删 + 入回收站 |
| `wenbi:articleExport` | `(id) => Promise<string \| null>` | 导出 .md（§3.3），取消返回 null |
| `wenbi:copilot` | 见 §4.2 | 建议文本 |

## 7. 接线

- App.tsx：`MODULES` 增 wenbi；WenbiModule 懒加载注册；**不传 `onOpenAi`**（浮生记零 AI；写作台 copilot 走后台不经边栏）。
- `src/modules/wenbi/WenbiModule.tsx`：双板块壳（§0）；子组件 `JournalPanel.tsx` / `WritingPanel.tsx`（可拆同目录）+ `wenbi.css` 或复用 App.css 区块样式（实现时随现有惯例）。
- `useModuleActivated('wenbi', …)`：切回模块时刷新两板块列表。
- MdDialog 编辑态 textarea（现有 `<textarea>`）为协笔选区/光标操作基础，无需替换组件。

## 8. 验收清单

- [ ]  DB v17 迁移：两表建成、md 两目录 ensure、新装库顺序迁移覆盖
- [ ]  浮生记：新建即编辑（autoEdit）；按月/按周分节正确（周=周一始）、默认按月；大事件标记开关（编辑态）+ 置顶小节 + 行 flag icon；事后编辑不动时间线位置；摘要取首行
- [ ]  浮生记零 AI：模块内无任何 AI 入口；无画像注入
- [ ]  写作台：四区新建/计数；拖拽跨区与区内排序、菜单移动等效；标题编辑同步列表；已发布区不自动删除
- [ ]  Copilot：起稿/续写（插入光标处）、润色/改写（替换选区）；建议卡采纳/放弃/重新生成；采纳不落盘不标 AI；生成中防重入；LLM 未配置弹「去配置」
- [ ]  复制 Markdown / 导出 .md（保存对话框、取消无害）
- [ ]  回收站：第八块两来源混放+来源标注；恢复分线（浮生记回时间线、文章回构思区区末）；彻底删除连 md；3 天自动清理覆盖两来源
- [ ]  `npm run typecheck` / `npm run build` 通过
