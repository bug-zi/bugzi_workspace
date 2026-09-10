# 万象库 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/万象库/design.md` 与《总需求文档.md》第 1、5、6、8 条生成，是开发的直接依据。依赖：样式/designs-specs.md 的 MdDialog 与 AI 边栏、回收站/designs-specs.md 的接入约定。
> **260908 辩真阁并入（开发者指令）**：万象库改双板块——顶部「百科 | 辩真」tab（recycle-tabs 样式，推理角同款 keep-alive 隐藏切换），百科 = 本 specs 原有全部内容，辩真 = 原辩真阁面板整体迁入（`src/modules/wiki/VerifyPanel.tsx`，数据层 verify_records 表/IPC/md/回收站 source 零改动）。`WikiModuleProps.onOpenAi` 签名放宽为 `(prefill?, opts?: { auto?; channel? })`，辩真板块经 App 层 `openAiWith` 的 channel 覆盖直连「辩真·核查」频道；`ModuleId` 移除 `'verify'`。
> **260910 待学习区与预生成（新功能开发区，`2026-09-10-待学习区与预生成-design.md`）**：wiki_entries 加 `state` 三态列（DB v31）——`pool`=后库储备（用户不可见）/ `learn`=待学习区 / `learned`=已学会正式词条（存量行默认，行为不变）。生成卡片一律先入待学习区，读卡点「学会了」才进板块（可逆切换）；随机抽卡后库池优先秒开（每板块维持 3 张，`electron/services/wikiStock.ts` 泵三触发补充）；每日批次 5-10 张板块均摊自动入待学习区（启动延迟 10s + 午夜排程，settings `wiki_daily_learn_date` 幂等）。详见该设计记录。

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
  state TEXT NOT NULL DEFAULT 'learned',  -- DB v31（260910 待学习区）：pool=后库储备|learn=待学习区|learned=已学会
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

- 总览页：**待学习页签（260910，置顶于板块列表上方、经济学上方）** + 板块列表（可折叠）+ 总览操作区（「随机来一条」按钮 + 手动输入生成框）+ **笔记本页签**（与板块列表平级、仍在最下）。
- 板块页：该板块**已学会**词条列表（state='learned'；learn 态在待学习区、pool 态用户不可见），一行一条：词条名 + 一句话定义 + 右侧三操作（查看 / 编辑 / 回收站）。
- 板块管理：板块列表上下文（「+ 新增板块」按钮；板块项悬浮菜单：改名、删除——仅空板块可删，二次确认；后库池卡随板块物理清理不算阻塞项）。
- 待学习页（260910）：state='learn' 卡片列表（新卡在前，行=词条名 + 板块名 + 一句话定义；行操作 查看/回收站），读卡弹窗底部「学会了」才入板块。

## 3. 知识卡片

### 3.1 生成

- **随机来一条**（260910 后库池优先）：先抽后库池卡（指定板块抽该板块最旧池卡、未指定全体池卡均匀随机），抽中原地转 learn 态**秒回不调 LLM**、随后消耗后触发补泵；池空才兜底现场生成（随机抽一个板块 → 主进程让 LLM 生成该板块中一个万象库尚不存在的词条，把现有词条名列表给 LLM 参考规避重复 → 生成卡片）。两条路径结果一律 state='learn' 入待学习区。
- **手动输入**：用户输入词条名 → 查重：已存在则拦截，提示「该词条已存在，点击可查看原卡片」（conflictId 主进程带回直达，原卡可能在待学习区），不重复生成；不存在则生成（state='learn' 入待学习区）。
- **后库泵**（`electron/services/wikiStock.ts`，仿推理角 reasoningStock）：每板块预生成 3 张池卡（state='pool'，用户不可见）等待；任一板块存量 < 3 即补到 3。三触发：App 启动延迟 10s / 抽卡消耗后 / 进入万象库模块（wiki:stockCheck）。板块间并行、板块内串行；LLM 未配置静默跳过；单张失败 warn 跳过待下次触发。每张入库推 `wiki:stockChanged`（渲染层待学习列表/计数渐进刷新）。
- **每日批次**（同文件）：每天自动随机生成 5-10 条（数量每日随机）尽可能平均摊到各板块（洗牌轮转均摊），直入待学习区。触发：App 启动延迟 10s + 午夜零点排程（跨天常驻不断供）；settings `wiki_daily_learn_date` 幂等（当天已生成跳过）；LLM 未配置跳过且**不记日期**（当天配置好下次触发仍可生成）；≥1 张成功即记日期、零成功不记（下次重试整批）。
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
- **学会了组件**（260910 待学习区，MdDialog learnBar prop）：卡片弹窗底部操作条——learn 态三钮「直接删除 / 丢弃 / 学会了」（primary），点「学会了」state→learned 入板块（toast 已加入板块 XX）、按钮翻「已学会」；learned 态单钮「已学会」，点击 state→learn 移回待学习区（可逆）。关闭/遮罩/Esc = 留在待学习区（不强制三选一，头部关闭钮保留）。旧「生成审核三选」流由本语义取代。
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

- 词条「回收站」操作：二次确认 → 进回收站 wiki 板块；恢复回原板块（state 原样保留：待学习卡恢复后自然回待学习区）；彻底删除时 md 文件与该词条高光记录一并删除。
- 待学习卡同样可经行操作/弹窗「丢弃」入回收站；池卡（pool）永不进回收站、无 UI 入口，板块删除时随板块物理清理（含 md）。
- 测一测取题口径（260910）：只考已学会词条（state='learned'）。

## 6. 验收清单

- [ ] 初始五板块在，新增/改名/删空板块（含不可删非空板块）逻辑正确
- [ ] 随机生成：词条不与现有重复、卡片符合固定模板、summary 正确
- [ ] 手动输入已存在词条：拦截提示并可跳原卡片
- [ ] 卡片弹窗：渲染/双击编辑一致；划词气泡出现，高光写入卡片+笔记本，问 AI 推送到边栏
- [ ] 高光渲染 `==标记==` 高亮背景主题色；重开卡片高亮仍在
- [ ] 笔记本页签：倒序、显示来源与时间、点击跳回卡片、可单删且不影响卡片标记
- [ ] 词条回收/恢复/彻底删除（含 md 与高光清理）正确
- [ ] 待学习区置顶板块列表；随机/手动/每日批次生成的卡片一律先进待学习区，关闭弹窗留在待学习区
- [ ] 学会了→入板块、已学会→移回待学习区（可逆切换）；板块页与计数只含已学会词条
- [ ] 随机抽卡池优先秒开；后库每板块维持 3 张、消耗后自动补充（wiki:stockChanged 渐进刷新）
- [ ] 每日批次 5-10 张板块均摊、当天不重复（settings 幂等）、LLM 未配置跳过不记日期
- [ ] 撞词原卡在待学习区时「查看原卡片」仍可达（conflictId 直达）
