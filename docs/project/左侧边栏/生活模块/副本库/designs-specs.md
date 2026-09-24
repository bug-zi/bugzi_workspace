# 副本库 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/生活模块/副本库/design.md`（260925 开发者会话内定稿：精简核心范围、三选一预览、两步式 DIY、热力图第四源 + 总导览直达块全联动、单表 state 池形态）生成，是开发的直接依据。参照项目：`D:\Code\自创项目\网站类\人生副本CC版`（每日副本 / DIY 两步式 / 三维标签体系 / 密度指标均源自此；印记/会员/签到/名人堂/星图/明信片/追问不引入）。依赖：样式/designs-specs.md（MdDialog / ConfirmDialog / Toast 与主题色系约束）、回收站/designs-specs.md（接入约定）、致知己/designs-specs.md（画像注入 profileDigest 惯例）。
>
> **v2 修订（260925 当日，开发者验收反馈「泵可视化 + 已读归档」，已实施）**：
> - **待读区制**：`state='pool'` 语义升级为**待读区库存**——独立页签（模块四页签「每日副本｜待读区｜DIY 定制｜收藏库」），用户可浏览库存（标题/副标题/三标签/字数）、**立即开读**（pool→in_progress 移出待读区，非选定读毕不打卡）、不喜欢直接删（软删入回收站，删后泵自动补货）；泵保留但参数改 `COPY_LOW=10 / COPY_TARGET=12`。每日三选一只从待读区抽（`copy:daily` 候选源去 unread official 分支）。
> - **读毕二选处置**：`copy:finish(id, keep)`——keep=true 存档入库（state=finished 留收藏库）；keep=false 丢弃（finished 后软删入回收站「副本库」块，3 天可反悔，恢复回收藏库已读区）。**丢弃同样完成当日打卡**（copy_daily.finished_at 先于软删写入）；DIY 副本读毕无丢弃项（自动存档）。
> - **收藏库页内两区**：上方「在途」（unread+in_progress，筛选 chips 作用于本区）+ 下方「已读人生 N 段」折叠区（finished，默认收起，展开可回看/删除）。
> - **DB v58**：`UPDATE copies SET state='pool' WHERE source='official' AND state='unread'`（官方 3 篇划入待读区；v57 已被娱乐城占用顺延）。`poolList()`（copy:poolList）与 `poolCount`（copyStock）导出供待读区 UI；`discardCopy` 去除 pool 拒绝（库存可删），删除/丢弃后触发泵。
>
> **v2.1 修订（260925 当日二次反馈，已实施）**：
> - **砍模块内「每日副本」页签**——三选一独占总导览「今日副本」块；模块三页签 **「待读区｜收藏库｜DIY 定制」**（默认待读区，DIY 与收藏库换位）。DailyPanel 组件删除；`copy:daily` IPC 保留（总导览专用）；深链仅 reader（payload.id 直达阅读）。
> - **「未读」只属于待读区**：DIY 生成物改落 `state='pool'`（composeCopyIntoDb diy 路径）；存量 unread 全部划入待读区（**DB v59**：`UPDATE copies SET state='pool' WHERE state='unread'`）。读毕处置不再区分来源——全部二选「存档 / 丢弃」。
> - **收藏库 = 我存档的人生**：两区改「进行中」（in_progress，读一半的）+「已读人生」折叠区（finished）；来源/标签筛选保留、状态筛选撤（两区自然区分）。
>
> **v2.2 修订（260925 当日三次反馈，已实施）**：
> - 新增 **「进行中」页签**（开发者定名，第一位 + 默认页签）：收录 in_progress（读到一半的）副本——进度 X/Y 章、继续阅读、删除；ReadingPanel 新组件。
> - 模块四页签 **「进行中｜待读区｜收藏库｜DIY 定制」**；收藏库收敛为纯已读存档（「已读人生 N 段」折叠区，默认展开，来源/标签筛选保留）。
> - 三态归位：pool=待读区 / in_progress=进行中 / finished=收藏库；总导览「今日副本」块续读深链不变（reader 直达）。

## 0. 命名与常量

- 模块 id：`fuben`（ModuleId 已存在，本次去 pending 转正）；侧边栏名「副本库」；图标 Material Symbols `sports_esports`（沿用占位图标）；位置：生活区图书馆下方（现有占位位置不变）。
- 模块内三页签切换（照 WikiModule 板块切换 chips 惯例）：**每日副本**（默认）/ **DIY 定制** / **收藏库**，板块选择不持久化。
- md 目录：`md/copies/`（正文 `{id}.md`，照 files.ts 统一管理；initDb 目录清单追加）。
- 三维标签枚举（`src/shared/types.ts` 导出常量，prompt 与筛选 chips 共用）：
  - `COPY_CATEGORIES`：科技 / 艺术 / 体育 / 商业 / 冒险 / 犯罪 / 日常
  - `COPY_MOODS`：热血 / 治愈 / 暗黑 / 荒诞 / 震撼 / 温馨 / 讽刺
  - `COPY_ERAS`：古代 / 近代 / 当代 / 未来
- 副本来源：`official`（内置）/ `daily`（AI 预生成池）/ `diy`（定制生成）。
- 副本状态 `state`：`pool`（待选池，不可见）/ `unread` / `in_progress` / `finished`。
- 池常量（`electron/services/copyStock.ts`）：`COPY_TARGET=10 / COPY_LOW=5`（待选池目标/低水位）。新事件 `copies:stockChanged`（泵每补完一条推送，照 `wiki:stockChanged` 模式）。
- LLM scene：`copy`（`SCENE_ZH` 加 `'copy': '副本库'`，用量统计与活动指示共用）。
- 回收站来源值：`fuben`（回收站「副本库」页签）。
- 不新增 AI 频道（v1 无追问）：`CHANNEL_BY_MODULE` 不加 fuben 映射（默认助手频道）；不新增 settings key；不新增定时任务（补库泵为事件触发的一次性后台任务）。
- progress JSON：`{"stage": <当前阶段索引 0 起>, "ratio": <该阶段滚动比例 0-1>}`。

## 1. 数据表（DB v55）

```sql
CREATE TABLE copies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',   -- 一句话钩子
  category TEXT NOT NULL,              -- COPY_CATEGORIES 之一
  mood TEXT NOT NULL,                  -- COPY_MOODS 之一
  era TEXT NOT NULL,                   -- COPY_ERAS 之一
  source TEXT NOT NULL,                -- official|daily|diy
  word_count INTEGER NOT NULL DEFAULT 0,   -- 中文字符数（生成后统计）
  stage_count INTEGER NOT NULL DEFAULT 0,  -- 阶段数（## 小标题数）
  state TEXT NOT NULL DEFAULT 'pool',  -- pool|unread|in_progress|finished
  progress TEXT NOT NULL DEFAULT '',   -- JSON {stage, ratio}
  md_path TEXT NOT NULL,               -- md/copies/{id}.md
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE copy_daily (
  date TEXT PRIMARY KEY,               -- YYYY-MM-DD（本地时区）
  candidate_ids TEXT NOT NULL,         -- JSON number[]（当日候选，通常 3 个）
  chosen_id INTEGER,                   -- 当日选定（NULL=未选）
  finished_at TEXT                     -- 当日读毕时间（打卡判定 = chosen_id 非空且本字段非空）
);
```

- v55 迁移同时：① initDb 目录清单追加 `md/copies`；② 插入内置 3 篇官方副本（`electron/db/copySeeds.ts` 导出 `COPY_OFFICIAL_SEEDS`，source=official、state='unread'、md 文件迁移时写入 `md/copies/`）。正文从参照项目提取：`副本1：顶级黑客.docx`、`副本2：电竞冠军.docx`（docx 转纯文本）、`副本3：DJ的一生.md`（直接用）；按「`# 标题` + 副标题行 + `## 阶段小标题` × N」结构人工规整，word_count/stage_count 迁移时统计；三标签人工定档（黑客：科技/暗黑/当代；电竞冠军：体育/热血/当代；DJ：艺术/热血/当代——实施时可在 seed 文件调整）。
- 每日打卡口径：`copy_daily` 某日 `chosen_id NOT NULL AND finished_at NOT NULL` = 该日副本源完成；未选 / 选而未读毕 / 选定后被删 均不计。
- copy_daily 记录不删除、不进回收站（打卡历史）；副本删除不删 copy_daily 行（删当日未读毕的选定副本时仅清 chosen_id，见 §4）。

## 2. 模块本体（src/modules/fuben/）

**FubenModule.tsx：**

- 标题区（icon `sports_esports` + 副本库 + 副标题「每天抽一段别样人生，或定制一段属于自己的」）+ 三板块 chips；子组件 DailyPanel / DiyPanel / LibraryPanel / CopyReader。
- 视图二态（照图书馆进书模式）：**列表态**（标题区 + chips + 当前面板）/ **阅读态**（隐藏标题区与 chips，满栏渲染 CopyReader，模块内返回）。切换用模块内 state（`readingId`），不持久化。
- 照 keep-alive 惯例接 App.tsx；监听 `MODULE_ACTIVATED_EVENT` 刷新列表与每日状态；模块激活时调 `copy:stockCheck` 触发补库泵。
- 深链：`useModuleNavigate('fuben', ...)`——`target:'reader'` + `payload.id` → 切阅读态开指定副本；`target:'daily'` → 切每日页签（总导览块跳转用）。
- 监听 `copies:stockChanged`：每日候选渐进补位（池抽不足 3 时先呈现有的，后台补齐后自然增多）、收藏库无感（池不可见）。

**DailyPanel · 每日副本：**

- 加载 `copy:daily()`，三态渲染：
  - **未选**：三张候选卡横排（标题 + 副标题 + 类别/情绪/时代三枚 chip + 字数），卡底「开始这段人生」；工具行「换一批」按钮（loading 防连发）。
  - **进行中**：续读卡（标题 + 副标题 + 「读到第 X/Y 章」进度 + 「继续阅读」）。
  - **已读毕**：完成卡（「今日已读毕《title》」+ 「回看」入口 + 「明天再来一段」文案）。
- 选定：ConfirmDialog 二次确认（「选定后今日不可更换」）→ `copy:chooseDaily(id)` → 切阅读态。
- 换一批：`copy:reshuffleDaily()`（本地重抽，不限次数，不耗任何资源）；候选不足 3 时有多少呈多少。
- LLM 未配置：候选只从现有库存抽（含内置 3 篇），无任何 AI 报错弹窗（泵静默）；「换一批」与选定不依赖 LLM。

**DiyPanel · DIY 定制（两步式）：**

- 步骤流单面板内完成：
  1. **方向输入**：textarea（placeholder 示例「我想体验 90 年代县城开音像店的人生」）+「生成定制问题」按钮。
  2. **四道问答**：AI 返回 4 道开放式个性化问题，逐题 textarea 作答（全部作答后「生成我的副本」才可点）；「重新生成问题」回到步骤 1（保留方向，已答清空）。
  3. **生成中**：整面板锁定 + 分段进度文案（「构思大纲…」→「撰写第 X/Y 段…」）+「取消」按钮（AbortSignal 贯穿，取消即中止不落库）；完成 toast「专属副本已生成」并直接切阅读态。
- 生成过程中切页签不中断（keep-alive，面板 state 保留，回来仍是进度态）。
- 主进程单飞标志：DIY 进行中再触发抛 `COPY_DIY_BUSY` → toast「已有定制任务进行中」。
- LLM 未配置：两个生成按钮均弹 GoConfigDialog（全局规则 8，不置灰）。

**LibraryPanel · 收藏库：**

- 工具行三排筛选 chips（照设计）：来源（全部/官方/每日/DIY）、状态（全部/未读/进行中/已读）、标签（全部 + 库内出现过的标签值动态生成，三标签合并枚举）。
- 列表行：状态图标（`radio_button_unchecked` 未读 / `schedule` 进行中 / `task_alt` 已读，照推理角题库图标惯例）+ 标题 + 副标题 + 三枚标签 chip + 来源角标（官方/每日/DIY）+ 字数 + 进度%（进行中）或读毕日期（已读）。
- 排序 updated_at 倒序；点击行切阅读态；行尾删除按钮 → ConfirmDialog 二次确认 → `copy:discard` → toast「已放入回收站」。
- 空态：「库存空空——等每日池刷新，或在 DIY 定制一段属于你的人生」。

**CopyReader · 阅读视图（三入口共用：每日选定 / 收藏库点行 / DIY 完成）：**

- 顶栏：返回（回列表态，保留原页签）+ 标题/副标题 + 「弹窗打开」图标按钮（MdDialog 打开 md_path，渲染态/双击编辑照全局弹窗默认）+ 章节进度「第 X/Y 章」。
- 左侧阶段导航（窄窗 <768px 隐藏）：`## 阶段小标题` 列表，当前章高亮，点击平滑滚动到对应章。
- 正文：MdView 渲染 md 全文；滚动监听更新当前章高亮 + `{stage, ratio}` **节流 3 秒** `copy:saveProgress`（照图书馆节流惯例）；重开时 `copy:read` 返回 progress，恢复到对应章位置。
- 读毕：滚动到末尾（最后章 ratio > 0.95）右下浮出「读毕」按钮 → ConfirmDialog「读完《title》了？」→ `copy:finish` → toast（当日选定副本：「已读毕，今日打卡完成」；其余：「已读毕」）→ 自动退回列表态。
- 已读副本可重读：重读不改 finished_at、不重复打卡。
- 字号跟随全局字体设置（个人档 App 设置），无独立缩放；配色走双主题 CSS 变量（主题相近色系，禁彩亮色）。

## 3. AI 服务（electron/ai/services.ts 新增三函数）

统一 scene `copy`；`generateDiyQuestions` / `generateCopyOutline` 注入 `profileDigest()` 画像摘要（取向贴身）；`generateCopySection` 不注入（大纲已定取向，省上下文）。

**generateDiyQuestions(direction)**（jsonMode，temperature 0.8）：

- 人设：人生定制师。任务：围绕用户想体验的人生方向，出 4 道开放式个性化问题，问题要挖该方向的分叉点、代价、渴望与恐惧（如「你更怕稳定还是怕悔恨？」），帮用户把模糊方向变成具体人生；每题一句话，不设选项。输出 `{questions: string[4]}`。

**generateCopyOutline(opts: { direction?, answers?, tags?, avoidTitles })**（jsonMode，temperature 0.9）：

- 入参三模式：DIY 传 `direction + answers`（方向与四问答原文）；泵传 `tags`（随机三维标签组合）；`avoidTitles` = 近 30 条库内标题 + 池内全部标题。
- 人设：人生副本编剧。产出 `{title(15字内), subtitle(一句话钩子), category, mood, era, stages: string[8-12]}`——stages 为人生阶段小标题（参照「卧室DJ：在失去一切之后开始」式命名），阶段弧线须有起伏：起步→代价与挫折→转机→高光→回归式收束；DIY 模式须把四问答的回答倾向织入人生走向。
- 撞题处理（代码层）：`title.replace(/\s+/g,'')` 与 avoidTitles norm 比对，撞了带提示重调一次；再撞则换 tags/微调 direction 重来；两次仍撞抛错。
- 实施注意：`category/mood/era` 须在对应枚举内，出界时代码回落到入参 tags 或随机枚举值。

**generateCopySection(outline, range, worldMemo)**（非 jsonMode，temperature 0.85）：

- 按阶段区间分批生成正文（每批 3-4 个阶段，整副本 2-4 次调用，规避单次 max_tokens 限制）；`worldMemo` = 已生成各阶段的「阶段名 + 一句话摘要」串（保跨批连贯）。
- prompt 硬性要求（照参照项目密度）：第二人称「你」沉浸叙事；每阶段 500-900 字；**密度指标：每 500 字至少 3 个具体数字、2 个命名地点、1 段对话**；全文一条贯穿性母题（参照项目「两美元 U 盘」式物件/动机）；禁 Gods-eye 总结腔，细节落地；最后一批追加「回归式收束」要求（高潮后落回平静与自洽，参照 DJ 副本「400 席」结尾）。
- 输出 md 片段：每阶段以 `## 阶段小标题` 开头（小标题与 outline.stages 一致，逐字照抄）。

## 4. IPC（`copy:*`）与补充泵

```
copy:daily()                → { phase:'unpicked'|'reading'|'finished',
                                candidates?: CopyCard[],        // unpicked 时
                                chosen?: CopyDetail & progress, // reading 时
                                finishedCopy?: CopyCard }       // finished 时
                              // 当日无 copy_daily 行则先建：从候选池随机抽 3 写 candidate_ids
copy:reshuffleDaily()       → { candidates: CopyCard[] }（仅未选定时可用，重抽排除当前 3 个，
                              候选池剩余不足 3 放宽为全池随机；chosen_id 非空抛 ALREADY_CHOSEN）
copy:chooseDaily(id)        → { copy: CopyDetail }（校验 id ∈ candidate_ids；事务：
                              copies.state pool→in_progress / unread→in_progress + copy_daily.chosen_id=id；
                              完成后触发补库泵）
copy:read(id)               → { detail: CopyDetail, md: string }（unread→in_progress 转正；
                              返回正文全文与解析后的 progress）
copy:saveProgress(id, progress) → void（{stage, ratio} JSON 落 progress 列 + updated_at）
copy:finish(id)             → { finishedAt }（state→finished + finished_at；
                              若 copy_daily.chosen_id=id 且其 finished_at 为空 → 写入（打卡）；
                              幂等：已有 finished_at 不覆盖）
copy:list(filter?)          → CopyCard[]（state != 'pool' AND deleted_at IS NULL，updated_at 倒序；
                              filter: { source?, state?, tag? } 任一可选）
copy:discard(id)            → void（软删 deleted_at；pool 行不可删抛 IN_POOL；
                              若为当日 chosen 且 copy_daily 未读毕 → chosen_id=NULL 当日可重选）
copy:diyQuestions(direction, jobId) → { questions: string[4], jobId }
                              （jobId 防连发取消模式照 wall:ensureToday）
copy:diyGenerate(jobId, direction, answers) → { copy: CopyDetail }
                              （编排：outline → 写 md 头 → 分批 section 循环（进度经
                              copy:diyProgress 事件推渲染层）→ 拼 md → INSERT(source=diy,
                              state='unread', 统计 word_count/stage_count)；signal 取消即中止
                              不落库不删文件；进行中再入抛 COPY_DIY_BUSY）
copy:diyProgress 事件        → { step: 'outline'|'section', current, total }（DIY 进度推送）
copy:stockCheck()           → void（触发补库泵，fire-and-forget，不返回存量）
```

**补库泵（`electron/services/copyStock.ts`，照 wikiStock 简洁风格）：**

- 入口 `ensureCopyStock()`，调用点全部 fire-and-forget（`void ensureCopyStock()`），**永不抛错、永不弹窗**；单飞 `pumping` 标志防重入。
- `poolCount()` = `COUNT(*) FROM copies WHERE state='pool' AND deleted_at IS NULL`；< `COPY_LOW`(5) 循环补到 `COPY_TARGET`(10)，逐条串行。
- 单条生成编排：随机三维 tags（排除库内近 20 条完全相同组合；不足多样时任意）→ `generateCopyOutline({ tags, avoidTitles: 近 30 标题 + 池内全部标题 })` → 分批 `generateCopySection` → 拼 md 写 `md/copies/{id}.md` → INSERT（source='daily'、state='pool'、统计字数/阶段）→ `notifyStockChanged()`（`copies:stockChanged`）。
- 单条失败（含 LLM 未配置）catch 记 console.warn 跳出本轮，下次触发再补。
- **三个触发点**：① `main.ts` 启动后延迟 10s（照 reasoningStock，unref）；② `copy:chooseDaily` 消耗后；③ 进入副本库模块（`copy:stockCheck`）。

## 5. 回收站接入（新增「副本库」页签）

- `RecycleSource` 追加 `'fuben'`；`TABLES.fuben = 'copies'`；`MD_FIELDS.fuben = 'md_path'`（恢复=清 deleted_at；hardDelete=删行 + 连删 md 文件，通用机制无特判）。
- `item:discard` 的 RECYCLE_MAP 追加 `copies → fuben`。
- RecycleModule 页签追加「副本库」（顺序：推理角之后、草稿本之前，照模块序），恢复提示「恢复到副本库」，恢复回收藏库列表（state 原样保留）。
- pool 行不进回收站（不可见储备无删除入口）。

## 6. 渲染层接线（含热力图第四源与总导览块）

- `src/shared/types.ts`：`CopyCard / CopyDetail / CopyDailyView / CopyListFilter / DiyProgress` 类型；`HeatmapDay` 加 `copies: boolean`（level 注释改「完成件数 0-4（五档颜色）」）；`SCENE_ZH` 加 `copy: '副本库'`；导出三枚举常量。
- `src/renderer/api.d.ts` + `electron/preload.ts`：`Api` 加 `copy` 命名空间（形状照 §4）；桥接 `copy:diyProgress`、`copies:stockChanged` 两事件（照 `wiki:stockChanged` 模式）。
- `App.tsx`：MODULES 中 fuben 去 `pending: true`；keep-alive 渲染 `<FubenModule />`；`CHANNEL_BY_MODULE` 不加映射。
- **热力图第四源**：`electron/services/overview.ts` `heatmapOverview()` 加第四源——按日查 `copy_daily`（`chosen_id NOT NULL AND finished_at NOT NULL`）写入 `copies`；`level = learn+wall+challenge+copies` 四源和（0-4）。`HeatmapCard`：`cellClass` 扩五档色阶（在主题色系内逐档加深，照现有四档递进逻辑延一档）；`detailText` 追加「副本」。
- **总导览「今日副本」块**（`OverviewModule` life 模式，插在每日一题块之后）：
  - 未选：三张迷你候选卡横排（标题 + 一枚情绪 chip）+「换一批」小按钮——直接复用 `copy:daily()` / `copy:reshuffleDaily()`；点卡 `MODULE_NAVIGATE_EVENT { module:'fuben', target:'reader', payload:{id} }` 前先 `copy:chooseDaily`（二次确认照模块内）。
  - 进行中：续读条（标题 + 「第 X/Y 章」+ 前往图标）→ 深链 reader。
  - 已读毕：完成行（「今日副本已读毕」+ 标题回看入口）。
  - 数据随 OverviewModule 现有加载流拉取（独立 catch，失败静默占位）；读毕打卡的即时联动 = 切回总导览时 `MODULE_ACTIVATED_EVENT` 触发重拉（副本读毕发生在副本模块，无需新全局事件）。
- 样式入 App.css（`.fuben-*` 前缀），遵循双主题 CSS 变量与「框/按键/弹窗用主题相近色系」约束，图标一律 Material Symbols，禁 emoji。

## 7. 验收清单

- [ ] 左栏生活区「副本库」转正（不再置灰、点击进入）；三页签切换正常，默认每日副本
- [ ] DB v55 迁移：两表建立、内置 3 篇官方副本入库（标题/副标题/三标签/字数/阶段数正确、md 文件落 `md/copies/`、阅读可开）
- [ ] 每日三选一：候选卡齐全（标题+副标题+三标签+字数）；换一批重抽且排除上一批；选定二次确认后锁定、当日不可换
- [ ] 选定转正：pool/unread → in_progress，收藏库列表即现该副本；续读卡进度正确
- [ ] 阅读视图：满栏阅读、头部隐藏；阶段导航当前章高亮、点击跳章；滚动进度 3 秒节流落库；重开恢复到上次位置
- [ ] 读毕：滚到底浮出按钮 → 二次确认 → 当日选定副本 toast「今日打卡完成」且 copy_daily.finished_at 落值；重读不重复打卡
- [ ] DIY：方向 → 4 道个性化问题 → 全部作答后可生成；生成中分段进度文案、可取消、取消不落库；完成自动入收藏库并进阅读
- [ ] DIY 边界：生成中再触发 toast「已有定制任务进行中」；切页签不中断生成；LLM 未配置两按钮弹 GoConfigDialog
- [ ] 收藏库：三排筛选（来源/状态/标签）生效；状态图标与进度/读毕日期正确；updated_at 倒序；删除二次确认入回收站
- [ ] 补库泵：池 < 5 补到 10；三触发点（启动延迟 10s / 选定消耗后 / 进模块）各自生效；LLM 未配置静默跳过（console.warn）；`copies:stockChanged` 渐进刷新每日候选；池行不出现在收藏库
- [ ] 回收站「副本库」页签：删除、恢复、3 天彻底删（连带 md 文件）；pool 行不可删
- [ ] 热力图：第四源生效（选定且读毕记 done）；格子五档色正常；图例/悬浮文案含副本
- [ ] 总导览生活模式「今日副本」块：三态（候选/续读/读毕）正确、换一批可用、深链直达阅读；学习模式不显示
- [ ] 深链：总导览候选卡选定后直达阅读视图；「回看」入口正常
- [ ] 画像注入：DIY 问题与大纲生成注入 profileDigest；正文分段生成不注入；scene 统计「副本库」页签可见
- [ ] typecheck 双配置通过；双主题下无彩亮色、无 emoji 图标
