# 灵感泉 designs-specs.md

> 本文档由 AI 基于 `docs/project/需求（功能模块）/灵感泉/design.md` 与《总需求文档.md》第 1、5、6 条生成，是开发的直接依据。依赖：样式/designs-specs.md 的 MdDialog、MdView、回收站/designs-specs.md 的接入约定。§6 为 v2.0 增量（AI 辅助生成灵感，260903 设计定稿）。

## 1. 数据表

```sql
CREATE TABLE inspirations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'project' | 'develop' | 'archive'
  md_path TEXT NOT NULL,                 -- md/inspirations/<id>.md
  sort INTEGER NOT NULL DEFAULT 0,       -- 区内排序（拖拽顺序）
  origin TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'ai'（v2.0）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

- **DB v7 迁移**（v2.0）：`ALTER TABLE inspirations ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'`（磁盘上 v6 已被格言 gen_kind 占用，origin 顺延 v7）。存量条目自动视为手动；新装库顺序执行全部迁移，同样覆盖。
- `InspirationRecord`（`src/shared/types.ts` + `src/renderer/api.d.ts`）补 `origin: 'manual' | 'ai'`。回收站 payload 序列化整条 record，origin 自动携带，恢复后徽标保留。

## 2. 页面结构

- 四区展示（推荐四列看板，宽度不足时纵向堆叠；实现时定）：草稿区 / 立项区 / 开发区 / 归档区。
- 每区标题：区名 + 条数 + 「+」新建按钮。
- 每条灵感一行/一卡组件：标题 + 更新时间 + 右侧操作按钮；`origin='ai'` 的条目标题旁显示小「AI」徽标（v2.0，样式与格言库 AI 徽标同款，主题色系禁彩色）。
- 各区职责与语义：草稿区（记录想法）、立项区（决定要做）、开发区（正在开发）、**归档区（已完成开发的长期存档，不自动删除，可拖回开发区二次开发）**。
- v2.0：模块头部右侧「来5条灵感」按钮（样式同格言库「来10条格言」按钮），生成中转「生成中…」禁用态。

## 3. 操作

### 3.1 新建

- 区标题旁「+」→ 弹窗输入标题 → 建表记录 + 创建 md 文件（模板：`# {标题}\n`）→ 该区列表出现新条目。任何区都可直接新建（不强制从草稿区开始）。

### 3.2 查看/编辑

- 点击条目 → MdDialog（title=标题，filePath=md_path），默认渲染态、双击编辑，全局统一交互。
- 标题可在弹窗头部编辑（改后列表同步）。

### 3.3 跨区移动（两种方式）

- **拖拽**（主方式）：任意两区之间自由拖拽（HTML5 drag & drop 或 dnd-kit），放下即改 status、更新 sort；同区内拖拽调整顺序。
- **菜单移动**（补充）：条目悬浮菜单/右键「移动到 → 草稿区/立项区/开发区/归档区」（列出除当前区外的三区）。
- 移动即时生效，无确认弹窗（非破坏性操作）。

### 3.4 丢弃

- 条目右侧回收站 icon → 二次确认（「放入回收站，3 天后自动彻底删除」）→ 进回收站灵感泉板块；恢复回草稿区；彻底删除时 md 文件一并删除。

### 3.5 通用条目菜单（v2.0，原「移动到」菜单升级）

- 原「移动到」按钮（`drive_file_move`）改为通用菜单按钮（icon `more_horiz`），菜两组：
  - 「移动到」组：除当前区外三区（原逻辑不变）；
  - 分隔线后：「AI 完善」（icon `auto_awesome`，见 §6.3）、「问 AI」（icon `forum`，见 §6.4）。

## 4. 明确不做（v1）

- AI 生成灵感：v1 不做（design.md「具体怎么生成我还没想好，再说」）；**v2.0 已落定，见 §6**。

## 5. 验收清单（v1）

- [ ] 四区展示、计数正确；每区「+」新建（建表+建 md）正确
- [ ] MdDialog 打开/双击编辑/保存正确；标题编辑同步列表
- [ ] 拖拽：跨区移动改 status、区内排序；菜单移动与拖拽等效
- [ ] 丢弃：二次确认 → 回收站灵感泉板块；恢复回草稿区；彻底删除连 md 删
- [ ] 归档区条目不参与 3 天自动删除（仅回收站条目参与）

## 6. v2.0 AI 辅助生成灵感

### 6.1 IPC 通道（ipc.ts + preload.ts + api.d.ts 同步）

| 通道 | 签名 | 行为 |
|---|---|---|
| `inspirations:generate` | `() => Promise<{ inserted: number }>` | 画像 → LLM → 查重 → 批量入库草稿区；LLM 未配置抛 `LLM_NOT_CONFIGURED` |
| `inspirations:refine` | `(id: number) => Promise<string>` | 读该条 title + md → LLM 生成扩展 md（**不写库**），返回内容 |
| `inspirations:appendRefine` | `(id, content: string) => Promise<void>` | 主进程把 `## AI 补充 · {yyyy/M/d HH:mm}` 段追加到该条 md 末尾，bump updated_at |

- AI 逻辑（generate/refine 的 prompt 构造与解析）放 `electron/ai/services.ts`，导出 `generateInspirations()` / `refineInspiration(id)`，与 `generateMottos` 同区同构。
- `inspirations:*` CRUD handler 内联 ipc.ts（现状不变）；`appendRefine` 在主进程用 mdRead/mdWrite 完成追加（拼接收敛主进程，避免前端 read-modify-write 与打开中的 MdDialog 竞态）。

### 6.2 从零生成 generateInspirations（「来5条灵感」）

- **画像**：`SELECT title, md_path FROM inspirations WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50`；每条读 md 正文（跳过首行 `# 标题`），非空截 100 字，格式 `- {title}：{正文截断}`（正文空则仅标题）。
- **避免清单**：`SELECT title FROM inspirations ORDER BY updated_at DESC LIMIT 500`（**不过滤 deleted_at**，含回收站，防 prompt 超长）。
- **prompt**（jsonMode；对象包裹返回，规避格言库踩过的 json_object 顶层数组问题）：

```
以下是我的灵感泉里已有的项目灵感（兴趣画像）：
{画像清单；空则：（暂无已有灵感，可自由发散各类项目创意）}

以下清单里的方向请勿重复或高度雷同：
{avoid 清单；空则：（暂无）}

请参考我的兴趣画像，生成恰好 5 条新的项目灵感。每条包含：
- title：灵感标题（10~25 字，具体、可执行，不要空泛口号）
- summary：一句话简介（≤50 字，说明这是什么、有什么价值）

返回 JSON：{"inspirations": [{"title": "...", "summary": "..."}]}
```

- **解析**：复用格言库 `parseJsonArray` 思路（兼容 ```json 包裹与对象包裹，取首个数组字段）；title/summary 任一缺失或空白则跳过该条；0 条有效抛「LLM 未返回有效灵感」。
- **入库**（解析成功后统一执行，任一环节失败整体不入库）：逐条 `SELECT 1 FROM inspirations WHERE title = ?`（不过滤 deleted_at）精确查重，命中跳过；插入 `status='draft'`、`origin='ai'`、`sort` 取草稿区 `MAX(sort)+1` 起递增（区末尾，与 moveTo 语义一致）；md 内容 `# {title}\n\n{summary}\n`（mdCreate）。
- **返回** `{ inserted }`；渲染层 toast「已生成 N 条灵感，已入草稿区」+ 列表刷新。

### 6.3 AI 完善（refine → 预览 → 追加）

- **入口**：条目菜单「AI 完善」（菜单关闭）→ 按钮 loading → `inspirations:refine` → 预览弹窗。
- **refine prompt**（非 jsonMode）：

```
以下是我的一个项目灵感：
标题：{title}
正文：
{md 全文去首行标题，超 4000 字截断}

请基于这个灵感生成扩展建议，用简体中文 Markdown 输出，只输出以下三个小节（### 三级标题），不要输出其他内容：
### 思路延伸
（2~4 个可深化的方向，每个一句话）
### 潜在难点
（2~3 条）
### 下一步行动
（2~3 条具体可执行的事）
```

- **预览弹窗**（新轻量弹窗，复用 dialog-overlay/dialog 全局样式）：
  - 标题「AI 完善 · {灵感标题}」；正文用 `renderMd`（`src/components/MdView`）渲染 `## AI 补充 · {当前时间}\n\n{content}`（即最终追加效果）；
  - 底部「放弃」/「追加到文档」（primary）；生成中加载态；refine 失败 toast 后关闭。
- **追加**：确认 → `inspirations:appendRefine(id, content)` → toast「已追加到文档」→ 列表刷新（updated_at 变化；若 MdDialog 恰好打开该条，重开即见）。可多次完善，每段独立时间戳；历史 AI 段留在 md 内，用户双击编辑随意删改。段落标题时间戳以**追加时刻**为准（预览中的时间为近似展示）。

### 6.4 问 AI

- 菜单「问 AI」→ `props.onOpenAi(prefill)`；`InspirationsModule` props 加 `onOpenAi: (prefill?: string) => void`，App.tsx 接线 `onOpenAi={openAiWith}`（与格言库/万象库同款；仅预填无需 bumpAi）。
- 预填：`请围绕我的项目灵感「{title}」帮我头脑风暴：` + 正文（去首行标题）前 300 字；正文空则只有第一句。AI 边栏模块感知（当前模块=灵感泉）由现有机制覆盖。

### 6.5 LLM 未配置降级（全局规则）

- 「来5条灵感」「AI 完善」点击捕获 `LLM_NOT_CONFIGURED` → 弹 GoConfigDialog「去配置」（复用格言库 goConfig 模式）。「问 AI」走 AI 边栏自身降级，不重复处理。

### 6.6 边界与错误处理

| 场景 | 处理 |
|---|---|
| 画像为空（首次使用） | prompt「（暂无已有灵感，可自由发散各类项目创意）」，照常生成 |
| 返回条数 ≠ 5 / 部分字段缺失 | 有效几条入几条（≥1）；0 条有效报错 toast |
| 生成失败（网络/JSON 解析/429 重试耗尽） | toast 错误信息，整体不入库（429 自动退避重试由 llm.ts 统一处理） |
| refine 时 md 超长 | 截 4000 字进 prompt |
| appendRefine 时记录不存在/文件缺失 | 抛 NOT_FOUND → toast |
| AI 条目流转 | 拖拽/移动/丢弃与手动条目一致，origin 仅标记；回收站恢复回草稿区徽标保留 |

### 6.7 验收清单（v2.0）

- [ ] DB v7 迁移：存量 origin='manual'，inspirations:list 返回 origin
- [ ] 「来5条灵感」：入草稿区区末尾 + AI 徽标 + md=标题+简介 + toast + 列表刷新
- [ ] 查重：不与已有标题重复（含回收站）；画像为空可自由发散
- [ ] 菜单升级：more_horiz 通用菜单，移动组原功能不回归
- [ ] AI 完善：预览渲染最终效果 → 确认追加 `## AI 补充 · 时间` 段；可多次；放弃不写库
- [ ] 问 AI：边栏展开 + 预填正确
- [ ] LLM 未配置：生成/完善弹「去配置」；边栏自身降级不变
- [ ] 失败 toast 且不入库；typecheck/build 通过
