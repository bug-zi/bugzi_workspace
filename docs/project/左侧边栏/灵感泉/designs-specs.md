# 灵感泉 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/灵感泉/design.md` 与《总需求文档.md》第 1、5、6 条生成，是开发的直接依据。依赖：样式/designs-specs.md 的 MdDialog、MdView、回收站/designs-specs.md 的接入约定。§6 为 v2.0 增量（AI 辅助生成灵感，260903 设计定稿）。

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

- [ ]  四区展示、计数正确；每区「+」新建（建表+建 md）正确
- [ ]  MdDialog 打开/双击编辑/保存正确；标题编辑同步列表
- [ ]  拖拽：跨区移动改 status、区内排序；菜单移动与拖拽等效
- [ ]  丢弃：二次确认 → 回收站灵感泉板块；恢复回草稿区；彻底删除连 md 删
- [ ]  归档区条目不参与 3 天自动删除（仅回收站条目参与）

## 6. v2.0 AI 辅助生成灵感

### 6.1 IPC 通道（ipc.ts + preload.ts + api.d.ts 同步）


| 通道                        | 签名                                     | 行为                                                                           |
| ----------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| `inspirations:generate`     | `() => Promise<{ generated: number; inserted: number; winds: string[] }>` | 两阶段生成（发散12→配额自评5）→ 查重 → 批量入库草稿区，返回含本批风向 winds；LLM 未配置抛`LLM_NOT_CONFIGURED` |
| `inspirations:refine`       | `(id: number) => Promise<string>`        | 读该条 title + md → LLM 生成扩展 md（**不写库**），返回内容                   |
| `inspirations:appendRefine` | `(id, content: string) => Promise<void>` | 主进程把`## AI 补充 · {yyyy/M/d HH:mm}` 段追加到该条 md 末尾，bump updated_at |

- AI 逻辑（generate/refine 的 prompt 构造与解析）放 `electron/ai/services.ts`，导出 `generateInspirations()` / `refineInspiration(id)`，与 `generateMottos` 同区同构。
- `inspirations:*` CRUD handler 内联 ipc.ts（现状不变）；`appendRefine` 在主进程用 mdRead/mdWrite 完成追加（拼接收敛主进程，避免前端 read-modify-write 与打开中的 MdDialog 竞态）。

### 6.2 从零生成 generateInspirations（「来5条灵感」；优化建议区第18轮两阶段 + 任务2规范 v2）

- **口味注入**：手动「方向指引」（settings.inspiration_guide，置顶最高优先级，留空不注入）+ `inspirationTasteProfile()` 跨模块画像（个人画像摘要 / 格言正式区≤30条 / 万象词条按板块 / 手写灵感标题；AI 生成条不进画像只进避免清单）。
- **避免清单**：`SELECT title FROM inspirations ORDER BY updated_at DESC LIMIT 500`（**不过滤 deleted_at**，含回收站，防 prompt 超长）。
- **风向标（任务2）**：代码内置 14 个基调词池（实用主义/纸上原型/数据控/声音实验/时间胶囊/荒诞幽默/城市观察/怀旧电子/桌面游戏/手作实感/极简主义/社群之夜/慢生活/解谜推理），每批随机抽 1~2 个注入发散 prompt；12 条中 3~5 条靠拢即可；与方向指引冲突时指引优先。
- **两阶段管线**（jsonMode，对象包裹返回）：
  - 阶段一发散（temperature 0.95）：「挑剔的创意策展人」人设，恰好 12 条，每条 `{"title","summary","form"}`；form 从 7 种形态枚举选（实用工具/游戏与玩具/内容创作/数据可视化/实验探索/艺术表达/社群活动），至少覆盖 4 种；title 10~25 字「画面+实体锚点」结构（prompt 内置正反例，禁纯隐喻）；summary ≤100 字两句结构（第一句大白话「是什么+值得在哪」，第二句「第一步：」最小动作；禁「先…」开头、禁文艺化压缩）。
  - 阶段二自评（temperature 0.4）：五维打分（新颖度/契合口味/具体度/兴奋度/**标题可读性**），批内硬配额「5 条 ≥3 种 form、同 form ≤2 条」，恰好选 5 并按两句模板打磨 summary；title 与 form 沿用候选原文。
- **解析**：`parseInspirationArray`（兼容 ```json 与对象包裹）；title/summary 任一缺失或空白跳过；**form 非必填，非法/缺失落「未分类」**；0 条有效抛「LLM 未返回有效灵感」。两阶段解析失败各自动重试一次。
- **降级**：自评两趟均失败 → `pickDiverseFive()` 代码侧按 form 配额贪心取 5 条（同 form ≤2、优先补出现最少形态；配额不可满足按原顺序前 5 兜底），不空手而归。
- **入库**（解析成功后统一执行，任一环节失败整体不入库）：逐条精确查重（不过滤 deleted_at）命中跳过；`status='draft'`、`origin='ai'`、sort 取草稿区 `MAX(sort)+1` 递增；md 正文只存 summary（两句间单换行，第19轮起不写标题行）。
- **返回** `{ generated, inserted, winds }`；渲染层 toast「已生成 N 条灵感，已入草稿区；本期风向：X · Y」+ 列表刷新；卡片正文预览取前 120 字。

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


| 场景                                    | 处理                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| 画像为空（首次使用）                    | prompt「（暂无已有灵感，可自由发散各类项目创意）」，照常生成            |
| 返回条数 ≠ 5 / 部分字段缺失            | 有效几条入几条（≥1）；0 条有效报错 toast                               |
| 生成失败（网络/JSON 解析/429 重试耗尽） | toast 错误信息，整体不入库（429 自动退避重试由 llm.ts 统一处理）        |
| refine 时 md 超长                       | 截 4000 字进 prompt                                                     |
| appendRefine 时记录不存在/文件缺失      | 抛 NOT_FOUND → toast                                                   |
| AI 条目流转                             | 拖拽/移动/丢弃与手动条目一致，origin 仅标记；回收站恢复回草稿区徽标保留 |

### 6.7 验收清单（v2.0）

- [ ]  DB v7 迁移：存量 origin='manual'，inspirations:list 返回 origin
- [ ]  「来5条灵感」：入草稿区区末尾 + AI 徽标 + md=标题+简介 + toast + 列表刷新
- [ ]  查重：不与已有标题重复（含回收站）；画像为空可自由发散
- [ ]  菜单升级：more_horiz 通用菜单，移动组原功能不回归
- [ ]  AI 完善：预览渲染最终效果 → 确认追加 `## AI 补充 · 时间` 段；可多次；放弃不写库
- [ ]  问 AI：边栏展开 + 预填正确
- [ ]  LLM 未配置：生成/完善弹「去配置」；边栏自身降级不变
- [ ]  失败 toast 且不入库；typecheck/build 通过
