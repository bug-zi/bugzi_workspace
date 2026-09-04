# 致知己 designs-specs.md

> 本文档由 AI 基于 `docs/project/需求（功能模块）/致知己/design.md`（260905 开发者审核通过）与《总需求文档.md》生成，是开发的直接依据。覆盖三块：①致知己模块本体 ②个人中心「我的画像」 ③右侧 AI 边栏「频道制」改造。依赖：样式/designs-specs.md 的 AI 边栏与 MdDialog、回收站/designs-specs.md 的接入约定。

## 0. 命名与常量

- 模块 id：`zhijiji`；侧边栏名「致知己」；图标 Material Symbols `self_improvement`；位置：辩真阁与回收站之间。
- md 目录：`md/zhijiji/`，版本文件命名 `md/zhijiji/{questionId}-v{seq}.md`（文件名稳定；版本日期存 DB，覆盖时只更新 DB 日期不重命名文件）。
- 版本标识：`v{seq}-{YYMMDD}`，如 `v3-260905`。
- AI 频道 id：`assistant`（助手）｜`wiki`（万象·问答）｜`zhijiji`（致知己·追问）｜`verify`（辩真·核查）。
- 画像类别预设：专业背景 / 学习方向 / 职业规划 / 偏好习惯 / 价值观 / 其他（可自定义输入）。
- AI 提炼画像协议标记：助手回复末尾另起一行 `<<<PROFILE_SUGGEST:类别|内容>>>`（渲染层识别、剥离展示、卡片确认）。

## 1. 数据表（DB v9）

```sql
CREATE TABLE zhijiji_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',     -- JSON string[]（领域标签）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE zhijiji_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES zhijiji_questions(id),
  seq INTEGER NOT NULL,                -- 版本序号，区内 1..n 递增
  date TEXT NOT NULL,                  -- YYMMDD，该版本内容最后写入日（覆盖时更新为覆盖当日）
  md_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_zhijiji_versions_q ON zhijiji_versions(question_id);

CREATE TABLE profile_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual', -- manual=手填 | ai=对话中提炼入档
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE ai_sessions ADD COLUMN channel TEXT NOT NULL DEFAULT 'assistant';
-- 存量会话归「助手」频道（DEFAULT 兜底，零迁移）
```

- v9 迁移同时：①`initDb` 目录清单加 `md/zhijiji` ②种子问题（仅当 questions 表为空时）：标题「线性代数和 AI 有什么渊源？」，tags `["线性代数","AI"]`，建 v1 版本 md 预填四锚点材料（引用块注明「请用自己的话写出 v1，完成后可删除本段」）。
- 各频道激活会话 settings key：`assistant` 沿用现有 `ai_active_session_id`；其余 `ai_active_session_wiki` / `ai_active_session_zhijiji` / `ai_active_session_verify`；当前所在频道 `ai_active_channel`。

## 2. 致知己模块本体

**主列表：**

- 标题区（icon + 致知己 + 副标题「把属于自己的答案沉淀成版本」）+「+ 新问题」按钮。
- 列表按 `updated_at` 倒序，每行 = 问题标题（row-title）+ 副行（领域标签 chips + `N 个版本` + 更新时间）+ 操作（删除 icon-btn，二次确认 → 回收站致知己板块）。
- 点击行 → 打开 MdDialog。

**新问题：**

- 弹窗输入：问题标题（必填）+ 领域标签（可选，逗号/顿号分隔多个，复用格言库 parseTagInput 交互）。
- 创建即建空白 v1（seq=1、date=当日）→ 直接打开 MdDialog 并**自动进入编辑态**（MdDialog 新增 `autoEdit` prop）。

**详情弹窗（MdDialog 扩展 `versioned` prop）：**

- 版本切换条：弹窗头部下方常驻一行 chips，全部版本按 seq 倒序（`v3-260905` 式 label），当前高亮，点击切换（切换 = 换 filePath 重载，渲染态呈现；编辑态下切换视为放弃当前编辑，由 filePath 变化触发的重载兜底）。
- 保存即版本：编辑退出时走 `versioned.onSave(content, overwrite)` 而非默认 `md.write`：
  - 默认（不勾选）→ 存新版本：`seq = MAX(seq)+1`、`date = 当日`、写新 md 文件、问题 `updated_at` 刷新；同日多次保存靠 seq 区分（v3-260905 与 v4-260905 并存）。
  - 勾选「覆盖当前版本」→ 序号不变、`date` 更新为覆盖当日、mdWrite 原文件。
  - 勾选框仅编辑态显示（「完成」按钮旁），每次进入编辑态重置为不勾选。
- 「让 AI 追问」按钮：非编辑态显示于头部；点击携带当前版本正文回调模块。
- 标题可编辑（复用 MdDialog `onTitleChange`，同灵感泉模式），改名刷新问题 `updated_at`。

**让 AI 追问联动（频道制）：**

- 模块内点击 → 检查 LLM 已配置（未配置弹 GoConfigDialog，按钮不置灰）→ `onOpenAi(prompt, { auto: true })` 由 App 层展开边栏、切到致知己·追问频道并**自动发送**。
- prompt 组装（渲染层，作为一条用户消息可见可追溯）：`请对我写给自己的这个答案发起追问（较真地检验它，不要替我重写）：\n\n【问题】{title}\n【当前版本】{v{seq}-{date}}\n【我的答案】\n{content}`。
- 追问是多轮对话：后续在频道内继续；AI 人设见 §4，绝不代笔。

**删除与回收站：**

- 删除问题 = 二次确认 → `item:discard('zhijiji_questions', id)` → 回收站「致知己」板块（第五块，页签顺序：格言库/万象库/灵感泉/辩真阁/致知己）；payload 摘要 = 问题标题。
- 恢复：清 `deleted_at` 回主列表（全部版本 md 原样保留——照格言笔记封存模式）；3 天自动彻底删除照旧。
- 彻底删除：删问题行 + 全部版本行 + 全部版本 md 文件。

**IPC（`zhijiji:*`）：**

- `list()` → `{id, title, tags, version_count, created_at, updated_at}[]`（version_count 子查询计数）
- `createQuestion(title, tags)` → `{questionId, versionId, mdPath}`（含 v1 创建）
- `versions(questionId)` → 版本列表（seq 倒序）
- `saveNewVersion(questionId, content)` → `{versionId, seq, date}`
- `overwriteVersion(versionId, content)` → boolean（date 更新为当日）
- `renameQuestion(id, title)` → boolean
- `discard(id)` → item:discard 路由

## 3. 个人中心「我的画像」

- 位置：个人信息与 App 设置之间的新 zone「我的画像」（header + 条数徽标 + 「+ 新增」）。
- 条目行：类别（badge）+ 内容 + 编辑/删除 icon-btn；空态提示文案。
- 新增/编辑弹窗：类别（input + datalist 预设六类）、内容（textarea）；删除二次确认。
- IPC：`profile:list / add(category, content, source?) / update(id, category, content) / delete(id)`。
- 「AI 提炼」来源入档走 `add(category, content, 'ai')`，行上 AI 徽标区分（badge「AI」）。

**画像注入（全部 AI 功能）：**

- 主进程 `profileBlock()`：`profile_facts` 全量 → `\n## 用户画像…\n- 类别：内容`；空表返回 ''。
- 注入点：AI 边栏对话 system prompt（各频道）、格言生成、万象卡片生成、测一测、灵感泉生成/AI 完善、辩真验证综合分析——prompt 前缀统一追加。
- 预留升级：一条一记录的表结构即向量库（sqlite-vec）检索式注入的升级路径，v1 不做。

## 4. AI 边栏「频道制」

**数据与会话：**

- `ai_sessions.channel` 新列；会话列表/新建/激活均按频道隔离：`aiSession.list(channel) / create(channel) / active(channel) / delete(id, channel)`。
- 每频道独立「激活会话」settings key（见 §1）；删除激活会话时在同频道内自动切换到剩余最近活跃，无剩余则清除该频道激活。
- 边栏 UI：头部下方新增频道切换条（4 个 chip 常驻：助手/万象·问答/致知己·追问/辩真·核查）；会话列表面板只显示当前频道的会话；切换频道 = 持久化 `ai_active_channel` + 载入该频道会话与激活会话消息。手动展开边栏停在上次所在频道。

**system prompt 组装（每频道）：**

- 结构 = 频道人设 + 我的画像（profileBlock）+ 模块上下文提示 + 回答语言约定。
- 人设：助手 = 通用助手；万象·问答 = 知识讲解员（通俗准确、善用例子）；致知己·追问 = 「较真的朋友」（找逻辑漏洞、要具体例子、问适用边界；一次提 1~3 个追问；**绝不代用户写答案、绝不输出答案文本**）；辩真·核查 = 核查员（围绕观点真实性，引用来源给链接）。
- 画像提炼指令（各频道通用附加）：识别到关于用户本人的稳定新信息（专业/方向/规划/偏好/价值观等，画像未覆盖）时，回复最末尾另起一行输出 `<<<PROFILE_SUGGEST:类别|内容>>>`，否则不输出。

**触发联动（App 层）：**

- 模块内动作 → 边栏自动展开 + 切对应频道：万象「问 AI」→ wiki；致知己「让 AI 追问」→ zhijiji（auto 发送）；辩真「开始验证」→ verify；其余（灵感泉等）→ assistant。频道由 App 依据当前模块映射（`wiki→wiki、verify→verify、zhijiji→zhijiji、其余→assistant`），模块组件只调 `onOpenAi(prefill?, { auto? })`，无需感知频道。
- `pending` prop 形状：`{ text: string; channel: 频道; auto: boolean }`；auto 时切频道后自动发送，非 auto 仅预填。

**系统消息路由：**

- 辩真阁验证过程消息改推「辩真·核查」频道的激活会话（无则在该频道自动新建会话接收），不再混入助手频道。

**画像建议卡片（渲染层）：**

- 助手消息含 `<<<PROFILE_SUGGEST:类别|内容>>>` 时：正文剥离该行渲染，其下显示确认卡片「AI 建议把这条加入你的画像：{类别}：{内容}」+〔加入画像〕〔忽略〕。
- 加入 → `profile.add(类别, 内容, 'ai')` + `ai:editMessage` 剥除消息中的标记行；忽略 → 仅剥除标记行。未处理时卡片持续显示（随消息持久化）。

## 5. 回收站第五块

- 页签追加「致知己」（source `zhijiji`），恢复提示「恢复到致知己主列表」；其余交互（剩余存活时间、彻底删除二次确认）照旧。

## 6. 总需求文档同步（开发者已随 design.md 审核通过）

- 条目 3：结构化数据清单 + 致知己问题/版本、画像条目；md 文档清单 + 致知己答案版本。
- 条目 5：回收站四板块 → 五板块（+ 致知己，恢复回主列表）。
- 条目 6：md 弹窗适用清单 + 致知己答案版本。
- 条目 9：AI 边栏改频道制描述（四频道、独立会话历史与人设、模块动作自动切频道、画像注入）。
- 条目 12：侧边栏顺序插入致知己（辩真阁之后、回收站之前）。

## 7. 验收清单

- [ ] 侧边栏第七模块「致知己」，顺序正确；首启种子问题可见（含四锚点材料）
- [ ] 新问题：标题必填、标签解析、创建即开弹窗自动编辑态
- [ ] 弹窗：版本条倒序+当前高亮+点击切换；双击编辑/退出渲染；保存默认新版本（同日多版本 seq 区分）；勾选覆盖（序号不变日期更新）
- [ ] 让 AI 追问：LLM 未配置弹引导；已配置自动展开边栏、切致知己频道、自动发送；AI 只追问不代笔
- [ ] 删除→回收站第五块；恢复回主列表（版本齐全）；彻底删除含全部版本 md；3 天自动清理
- [ ] 画像：增删改查、类别 datalist、AI 来源徽标；全部 AI 功能 prompt 含画像块（配画像后生成内容可感知）
- [ ] 频道：四频道切换、各频道独立会话历史与激活；存量会话归助手频道；万象问AI/辩真验证/致知己追问自动切对应频道；辩真过程消息进核查频道
- [ ] 画像建议卡片：助手消息识别标记→卡片→加入/忽略均剥除标记；加入后个人中心可见（AI 徽标）
- [ ] typecheck 双配置通过
