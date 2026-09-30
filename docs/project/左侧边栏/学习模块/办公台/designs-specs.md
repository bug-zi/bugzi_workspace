# 办公台 designs-specs（v1.0）

> 生成日期：2026-09-30 ｜ 依据：同目录 `2026-09-30-办公台-design.md`（设计定稿）｜ 状态：待实施
> 技术栈基线：Electron 44 + React 19 + TypeScript，electron-vite；DB 现 v65，本批迁 v66

## §0 范围总述

新增学习模式模块「办公台」（ModuleId `office`，下固定槽位与收藏夹互换），提供六格式办公文档（docx/xlsx/pptx/txt/csv/md）的导入查看、新建编辑、导出另存与 AI 智能体写入（文档内指令条，AI 直接改文档）。

**明确不做**：公式计算（显示文件内缓存值）、模块内容导出管道、右栏 debugzi 频道、网格虚拟滚动、分类文件夹、pptx 图片/复杂元素保真（大纲级）、AI 生成流式（全项目 `chatCompletion` 非流式，v1 同步）。

## §1 左栏与模块接线（src/App.tsx、src/shared/types.ts）

1. `ModuleId` 联合类型增加 `'office'`（src/shared/types.ts）。
2. App.tsx `MODULES` 数组类型增加可选 `mode?: 'learn' | 'life'`（仅 bottom 段消费）；数组追加：
   - `{ id: 'office', label: '办公台', icon: 'description', seg: 'bottom', mode: 'learn' }`（置于 favorites 槽位，即下固定首位）
   - `{ id: 'favorites', ... seg: 'bottom', mode: 'life' }`（原行补 `mode: 'life'`）
3. 下固定渲染过滤改为：`MODULES.filter((m) => m.seg === 'bottom' && (m.mode == null || m.mode === appMode))`；top/learn/life 段不变（不设 mode）。
4. 模式切换回落口径：当前激活模块不属新模式时回总导览的现有逻辑，需把「bottom+mode 不匹配」纳入同判定（office 在生活模式、favorites 在学习模式都视为不属当前模式）。
5. keep-alive 挂载分支：`{m.id === 'office' && <OfficeModule />}`（import 置顶与其他模块一致）。
6. `CHANNEL_BY_MODULE` 不新增（无右栏频道）。
7. 图标用 material symbols：模块 `description`；新建组 docx `article` / xlsx `grid_on` / pptx `slideshow` / txt `text_snippet` / md `code`；导入 `upload`；导出 `download`；历史版本 `history`。禁 emoji。

## §2 DB 迁移（electron/db/db.ts，v66）

```sql
-- v66：办公台
CREATE TABLE office_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('docx','xlsx','pptx','txt','csv','md')),
  source_name TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE office_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES office_documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- 'doc'（md 全文）| 'sheet'（全簿网格 JSON）
  snapshot TEXT NOT NULL,
  note TEXT,                     -- AI 需求摘要（截断 50 字）
  created_at TEXT NOT NULL
);
CREATE INDEX idx_office_versions_doc ON office_versions(doc_id);
```

写入时机与既有迁移一致（migrate() 末尾 v65 之后追加 `user_version = 66` 分支）。

## §3 文件存储与 bzres 扩展

1. 目录：`userData/office/<id>/`，按 kind（真相源口径，见 design §四）：
   - docx：`original.docx`（导入原件存档，永不改写）+ `content.md` + `images/`
   - pptx：`original.pptx` + `content.md`（大纲：`## 页标题` + 要点 `- ` 列表）
   - xlsx：`book.xlsx`（真相源本体）
   - csv：`content.csv`（真相源本体，SheetJS 读写）
   - txt / md：`content.txt` / `content.md`
2. 导入单文件上限 50MB，超限该文件失败（不入库，不中断其余）。
3. bzres:// 命名空间（electron/services/bzres.ts）：host 白名单新增 `office` → `userData/office/`，沿用既有路径穿越校验；图片 URL 形如 `bzres://office/<id>/images/img-1.png`。
4. 新建文档（office:create）即时建目录落空真相源（docx/pptx 无原件，仅真相源；kind=docx 的新建文档导出时直接从 content.md 生成，无 original）。

## §4 新增依赖（package.json，主进程专用）

| 包 | 用途 |
|---|---|
| mammoth | docx → HTML + 图片提取（`convertToHtml` 自定义 `convertImage` handler） |
| turndown + turndown-plugin-gfm | HTML → md（含表格） |
| docx | md → docx 生成（`Document`/`Packer.toBuffer`） |
| xlsx（SheetJS） | xlsx / csv 读写 |
| pptxgenjs | 大纲 md → pptx 导出 |
| jszip | pptx 读取解压（pptxgenjs 依赖树已有，显式声明） |

md 解析复用项目已有 `marked`（`marked.lexer` 生成 tokens）。全部仅在主进程 import，不进渲染层 bundle。

## §5 主进程格式转换 `electron/services/officeConvert.ts`（新文件）

纯函数集合，不做 DB/IPC：

- `docxToMd(buf: Buffer, imagesDir: string, webRoot: string): Promise<string>`——mammoth convertToHtml，图片 handler 落 `images/img-N.<ext>`（N 递增）并把 HTML src 重写为 `bzres://office/<id>/images/img-N.ext`（webRoot 由调用方传 `office/<id>`）；turndown（use gfm 插件）转 md。解出失败抛 Error（调用方回滚）。
- `mdToDocx(md: string, imagesBase: string, outPath: string): Promise<void>`——`marked.lexer` 遍历 tokens 映射 docx 元素：heading→黑体（h1 22pt/h2 18pt/h3 16pt/h4 14pt，正文宋体 12pt），paragraph→正文段，list→编号/项目符号，table→`Table`，image→`ImageRun`（读 `userData/office/<id>/images/`，图片缺失跳过占空段），blockquote→缩进灰段，code→等宽段，hr→分隔段，粗斜体删除线→Text run 格式；A4 页边距 2.54cm；`Packer.toBuffer` 写 outPath。
- `pptxToOutline(buf: Buffer): Promise<string>`——jszip 读 `ppt/slides/slideN.xml`（自然排序），每 slide 正则提取 `<a:t>(.*?)</a:t>` 文本行；首个非空行作 `## 标题`，其余非空行作 `- 要点`；全部拼为大纲 md。空 slide 跳过。
- `outlineToPptx(md: string, outPath: string): Promise<void>`——按 `^## ` 切页；pptxgenjs 16:9，每页标题文本框 + 要点文本列表（简单版式，无母版美化）。
- `readWorkbook(buf: Buffer): { sheets: { name: string; rows: string[][] }[] }`——`XLSX.read(buf, { type: 'buffer' })`，逐 sheet `sheet_to_json(ws, { header: 1, raw: false, defval: '' })`（公式单元格取缓存值）。
- `writeWorkbook(sheets, outPath: string, kind: 'xlsx' | 'csv'): void`——`aoa_to_sheet` + `book_append_sheet`（csv 单 sheet 名 Sheet1）+ `XLSX.write(wb, { type: 'buffer', bookType: kind })` 落盘。

## §6 主进程服务与 IPC `electron/services/office.ts`（新文件）+ electron/ipc.ts 注册

**行类型**（src/shared/types.ts 同步）：

```ts
export type OfficeKind = 'docx' | 'xlsx' | 'pptx' | 'txt' | 'csv' | 'md'
export interface OfficeDocRow {
  id: number; name: string; kind: OfficeKind
  source_name: string | null; size: number
  created_at: string; updated_at: string
}
export interface OfficeVersionRow { id: number; note: string | null; created_at: string }
```

**IPC 通道**（ipc.ts 注册 `office:` 前缀，preload.ts `office` 命名空间，api.d.ts Api 接口同步）：

| 通道 | 签名 | 行为 |
|---|---|---|
| `office:list` | `(): Promise<OfficeDocRow[]>` | `deleted_at IS NULL` 按 updated_at DESC |
| `office:import` | `(): Promise<{ imported: OfficeDocRow[]; failed: { name: string; reason: string }[] }>` | showOpenDialog 多选（六扩展名 filter）；逐个：INSERT 行拿 id → mkdir `office/<id>` → 复制原件（docx/pptx）→ 转换真相源（docxToMd/pptxToOutline，xlsx/csv/txt/md 直接复制为真相源）→ 更新 size；任一步失败删行删目录记 failed，继续下一个 |
| `office:create` | `(name: string, kind: OfficeKind): Promise<OfficeDocRow>` | 新建空文档（见 §3.4；xlsx 空单 sheet `[[]]`） |
| `office:rename` | `(id: number, name: string): Promise<boolean>` | 仅改 name |
| `office:open` | `(id: number): Promise<{ row: OfficeDocRow; content: string; sheets: { name: string; rows: string[][] }[] \| null }>` | 文本类回真相源全文；xlsx/csv 回 sheets（readWorkbook） |
| `office:save` | `(id: number, payload: { content?: string; sheets?: { name: string; rows: string[][] }[] }): Promise<boolean>` | 文本类写真相源；xlsx/csv writeWorkbook 回 book.xlsx / content.csv；刷新 updated_at/size |
| `office:export` | `(id: number): Promise<{ ok: boolean }>` | showSaveDialog（默认文件名 `<name>.<ext>`）→ 从真相源生成：docx→mdToDocx、pptx→outlineToPptx、xlsx/csv→writeWorkbook、txt/md→直接复制真相源 |
| `office:discard` | `(id: number): Promise<boolean>` | `discardToRecycle('office', id)`（渲染层已二次确认） |
| `office:versions` | `(id: number): Promise<OfficeVersionRow[]>` | created_at DESC |
| `office:restoreVersion` | `(versionId: number): Promise<boolean>` | 取 snapshot 写回真相源（'sheet' 全簿覆盖；'doc' 全文覆盖）+ updated_at |
| `office:aiWrite` | `(id: number, input: { instruction: string; action: 'rewrite' \| 'append' \| 'selection'; current: string; selection?: string; sheets?: { name: string; rows: string[][] }[] }): Promise<{ text: string }>` | 无副作用生成（文档手术在渲染层，落盘走 office:save），见 §7 |

`office:aiWrite` 流程：

1. scene：xlsx/csv → `office:sheet`；pptx → `office:ppt`；其余 → `office:doc`。
2. prompt 组装（electron/ai/services.ts 内新函数 `runOfficeWrite`，与既有模块 AI 函数同层）：
   - system：文档写作助手人设 + 我的画像注入（照全局画像注入惯例，读取方式同其他 run* 函数）+ 输出格式强约束——doc/ppt 场景「只输出 Markdown 正文，不要代码围栏、不要解释」；sheet 场景「只输出 JSON 二维数组（首行为表头），不要围栏不要解释」。
   - user：动作说明（rewrite=按需求改写全文/当前工作表；append=在文末续写，保持前文风格；selection=只改写给定选区文本，返回改写后的选区）+ 当前内容（doc/ppt 传 `current`，sheet 传当前工作表 aoa 的表格文本化）+ 需求原文。
3. `chatCompletion({ messages, scene, signal })`（signal 由渲染层 AbortController 经 IPC 透传，照既有取消口径）。
4. **成功后**写快照：doc/ppt 快照 `current`（kind 'doc'）、sheet 快照全簿 JSON（kind 'sheet'），note=instruction 截断 50 字；每文档保留最近 10 份（超出删最旧）。
5. 返回 `{ text }`（sheet 场景 JSON.parse 校验失败视为失败抛错，重试一次后仍失败抛「AI 返回格式异常」）。

LLM 未配置不在此拦截——渲染层在触发前查 `window.api.ai.configured()`，未配置走全局「去配置」提示弹窗（规则照旧，按钮不置灰）。

## §7 回收站接入（electron/services/recycle.ts、src/modules/recycle/RecycleModule.tsx）

1. `RecycleSource` 联合类型 + `'office'`；`TABLES.office = 'office_documents'`；`MD_FIELDS.office = null`。
2. `restoreFromRecycle` 加 case：`UPDATE office_documents SET deleted_at = NULL WHERE id = ?`。
3. hardDelete/3 天过期清理加 office 特判：删除 `userData/office/<id>/` 整目录（同 learn 派生 md 特判先例）。
4. RecycleModule.tsx：`SOURCES` 数组加 `{ key: 'office', label: '办公台' }`；`tabOf` 默认返回 source 本身即命中；`GROUP_MODE.office = 'learn'`；`backToOf` office → `'办公台列表'`。

## §8 渲染层 `src/modules/office/`（新目录）

**OfficeModule.tsx**——两态容器（列表态/文档态，useState 持当前 doc；keep-alive 下切走不丢状态，激活事件 `MODULE_ACTIVATED_EVENT` 时重拉列表）：

- 列表态：
  - 头部：新建按钮组（Word/Excel/PPT/文本/Markdown，点击即建、默认名「未命名文档」可重名，命名靠行内重命名）+「导入」按钮（loading 态，完成后 toast 成功 N 失败 M，失败明细 toast 列出）+ 搜索框（按 name 过滤，防抖 300ms）+ 类型筛选（ActionMenu：全部/六类型，当前打勾，各带计数）。
  - 行：`name` + 类型徽章（小 pill，文案 Word/Excel/PPT/TXT/CSV/MD）+ 大小（KB/MB 格式化）+ 更新时间（MM-DD HH:mm）；行尾 hover ActionMenu（重命名/导出到电脑/删除）；删除二次确认（ConfirmDialog 同款模式，文案含「移入回收站，3 天后自动清除」）。
  - 空态：引导卡（说明 + 导入/新建按钮）。
- 文档态顶栏：返回（切回列表态，flush 保存）+ 文档名（点击行内改名）+ 类型徽章 + 「历史版本」+「导出」。

**DocTextView.tsx**（docx/md/txt 共用）——渲染态 `<MdView md>` ⇄ 编辑态 `<textarea>`（顶栏切换按钮，默认渲染态；txt 恒编辑态无切换钮）；编辑 800ms 防抖 `office:save`；卸载/切列表 flush。

**DocGrid.tsx**（xlsx/csv）——sheet 页签行（下划线式）；网格用 CSS table：列头 A/B/C…、行号、单元格 `<input>`（聚焦选中编辑，Enter 下移/Tab 右移/方向键导航）；工具行「＋行 ＋列 －行 －列」（对末尾操作，删除行列二次确认）；当前 sheet 数据本地 state，改动 800ms 防抖 `office:save`（全簿提交）；行数 >2000 首次打开 toast 提示「大表建议用本机 Excel 编辑」。

**SlidePreview.tsx**（pptx 预览态）——按 `^## ` 切页，每页一张 16:9 卡片（标题 + `- ` 要点列表），纯 div 渲染主题色系。

**InstructionBar.tsx**（三类文档共用，固定文档视图底部）：

- 输入框（placeholder「输入需求，AI 直接改这篇文档…」）+ 动作下拉（仅 docx/md/txt/pptx：改写整篇/续写在末尾；textarea 有选区时锁定显示「改写选区」；xlsx/csv 无下拉，固定「重写当前工作表」）+ 生成/取消钮。
- 生成中：输入框禁用 + loading 文案 + 取消按钮（AbortController）。
- 提交前查 `ai.configured()`，未配置弹「去配置」直达个人档（`onNavigateToProfile` 回调，照其他模块先例）。
- 返回后应用：doc rewrite=全文替换 / append=末尾追加 / selection=替换 textarea 选区；sheet=当前 sheet 全表替换（提交前提示条「将重写当前工作表」常显于指令条上方小字）；应用即触发防抖 save。
- 失败 toast 原因，文档不动；成功轻 toast「已写入（可从历史版本回退）」。

**HistoryDialog**——`office:versions` 列表（时间 + note）+ 行「恢复」（二次确认「当前内容将被覆盖，恢复后自动保存」）→ `office:restoreVersion` → 重载文档内容。

**样式**：全部走主题 CSS 变量（`--color-primary` 系），禁彩亮禁 emoji；列表/卡片/徽章复用 `card`/`zl-row`/`badge` 等既有 class 优先。

## §9 preload 与类型

- electron/preload.ts：`office: { list(); import(); create(name, kind); rename(id, name); open(id); save(id, payload); export(id); discard(id); versions(id); restoreVersion(versionId); aiWrite(id, input) }`（全部 `ipcRenderer.invoke` 一对一映射）。
- src/renderer/api.d.ts：Api 接口同步 + §6 行类型渲染层副本。
- src/shared/types.ts：ModuleId + `'office'`、OfficeKind、OfficeDocRow、OfficeVersionRow、OfficeVersionKind。

## §10 验收清单

1. typecheck 双 tsconfig 通过；`npm run build` 通过。
2. 转换冒烟：样例 docx（含图/表格/列表）导入 → content.md 正确、图片 bzres 可显 → 导出 docx 可被 Word 打开；样例 pptx 导入大纲正确 → 导出 pptx 可打开；样例 xlsx 多 sheet 读改写回、公式单元格显示缓存值。
3. 左栏：学习模式显示办公台（下固定首位）、不显示收藏夹；生活模式反之；音乐吧/回收站/个人档两模式都在。
4. AI 指令条：三场景各跑通（改写整篇/续写/改选区；Excel 重写工作表）；取消不写入；失败文档不变；历史版本恢复正确；llm_usage 出现 `office:doc`/`office:sheet`/`office:ppt` 三场景。
5. 回收站：删除入「办公台」组、恢复回列表、彻底删连目录、3 天过期自动清。
6. 运行时冒烟（导入六格式/新建编辑导出/搜索筛选/重命名/50MB 超限）由开发者验证。

## §11 连带文档

- 项目根 CLAUDE.md：左栏三段式描述、模块清单增「办公台」条目、收藏夹归属改生活专属、specs 数量计数更新。
- `README.md` 同步。
- `docs/project/新功能开发区.md`：本条目移入归档区并按惯例附实施记录。
- 本模块目录补 plan 文档（实施前由 AI 按本 specs 生成）。
