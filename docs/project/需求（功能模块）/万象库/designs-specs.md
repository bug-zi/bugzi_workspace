# 万象库 designs-specs.md

> 本文档由 AI 基于 `docs/project/需求（功能模块）/万象库/design.md` 与《总需求文档.md》第 1、5、6、8 条生成，是开发的直接依据。依赖：样式/designs-specs.md 的 MdDialog 与 AI 边栏、回收站/designs-specs.md 的接入约定。

## 1. 数据表

```sql
CREATE TABLE wiki_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL,        -- 板块排序
  created_at TEXT NOT NULL
);

CREATE TABLE wiki_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL REFERENCES wiki_sections(id),
  term TEXT NOT NULL,           -- 词条名
  summary TEXT NOT NULL,        -- 一句话定义（列表行显示）
  md_path TEXT NOT NULL,        -- 卡片正文 md 路径（md/wiki/<id>.md）
  origin TEXT NOT NULL DEFAULT 'ai',  -- 'ai' | 'manual'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE wiki_highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES wiki_entries(id),
  text TEXT NOT NULL,           -- 高光文本（笔记本记录用，无标记）
  created_at TEXT NOT NULL
);
```

- 初始板块（按 sort 顺序插入）：经济学、法学、心理学、博弈论、历史神话。

## 2. 页面结构

- 总览页：板块列表（可折叠）+ 总览操作区（「随机来一条」按钮 + 手动输入生成框）+ **笔记本页签**（与板块列表平级的一个页签入口）。
- 板块页：该板块词条列表，一行一条：词条名 + 一句话定义 + 右侧三操作（查看 / 编辑 / 回收站）。
- 板块管理：板块列表上下文（「+ 新增板块」按钮；板块项悬浮菜单：改名、删除——仅空板块可删，二次确认）。

## 3. 知识卡片

### 3.1 生成

- **随机来一条**：随机抽一个板块 → 主进程让 LLM 生成该板块中一个万象库尚不存在的词条（把现有词条名列表给 LLM 参考规避重复）→ 生成卡片。
- **手动输入**：用户输入词条名 → 查重：已存在则拦截，提示「该词条已存在，点击可查看原卡片」（点击打开原卡片弹窗），不重复生成；不存在则生成。
- **固定模板**：LLM 按固定结构生成 md：

```md
# {词条名}

## 一句话定义
{summary}

## 详细解释
{详细解释}

## 举例
{举例}

## 启示
{启示}
```

- summary 同步写入 wiki_entries.summary。
- 降级：LLM 未配置 → 「去配置」弹窗（总需求文档第 8 条）。

### 3.2 查看与编辑

- 「查看」打开 MdDialog（title=词条名，filePath=md_path）——默认渲染态、双击编辑，与全局统一。
- 「编辑」：弹窗表单编辑词条名 + 一句话定义（md 正文在 MdDialog 里改）。
- 卡片内划词交互（仅 MdDialog 打开的万象卡片内启用，MdDialog 需支持按模块开关此能力）：
  - 划选文本 → 浮动小气泡（selection 位置）：「高光」「问 AI」两按钮。
  - **高光**：选中片段在卡片 md 中包裹 `==高光==` 标记（渲染时高亮背景，主题色系）；同时插入 wiki_highlights 一条（纯文本，无标记）。已在笔记本删除的高光再点高光不重复插入（按 entry_id+text 判重）。
  - **问 AI**：把划选文本 + 词条名作为引用消息推送到右侧 AI 助手边栏（自动展开边栏并聚焦输入，用户可补充提问后发送）。

## 4. 笔记本页签

- 按时间倒序列出所有 wiki_highlights（跨板块）：每条显示高光文本、来源词条名、时间。
- 点击条目 → 打开来源词条的卡片 MdDialog。
- 每条可单独删除（小图标，二次确认不必——非破坏性，仅移除笔记本记录；卡片中的高亮标记不受影响）。

## 5. 回收站接入

- 词条「回收站」操作：二次确认 → 进回收站 wiki 板块；恢复回原板块；彻底删除时 md 文件与该词条高光记录一并删除。

## 6. 验收清单

- [ ] 初始五板块在，新增/改名/删空板块（含不可删非空板块）逻辑正确
- [ ] 随机生成：词条不与现有重复、卡片符合固定模板、summary 正确
- [ ] 手动输入已存在词条：拦截提示并可跳原卡片
- [ ] 卡片弹窗：渲染/双击编辑一致；划词气泡出现，高光写入卡片+笔记本，问 AI 推送到边栏
- [ ] 高光渲染 `==标记==` 高亮背景主题色；重开卡片高亮仍在
- [ ] 笔记本页签：倒序、显示来源与时间、点击跳回卡片、可单删且不影响卡片标记
- [ ] 词条回收/恢复/彻底删除（含 md 与高光清理）正确
