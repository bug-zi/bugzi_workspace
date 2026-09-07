# 推理角 designs-specs.md

> 本文档由 AI 基于 `docs/project/idea/推理角/design.md`（260906 开发者审核通过，含出题质量标准与两碗参考汤）与《总需求文档.md》生成，是开发的直接依据。依赖：样式/designs-specs.md（MdDialog / GoConfigDialog / ConfirmDialog / Toast 与主题色系约束）、回收站/designs-specs.md（接入约定）、致知己/designs-specs.md（画像注入 profileDigest 惯例）。
>
> **v1.3（260907）题库预生成**：三处取题（汤库 / 每日一题 / 练习场）改为题库预存取用，AI 后台补充——消除「现场等 AI 出题」。设计文档：`docs/superpowers/specs/2026-09-07-reasoning-question-bank-design.md`（开发者会话内逐节批准）。增量见 §0 常量、§1 DB v14、§2 UI、§4 IPC 与补充泵、§6 接线、§8 验收。

## 0. 命名与常量

- 模块 id：`reasoning`；侧边栏名「推理角」；图标 Material Symbols `psychology`；位置：致知己与回收站之间。
- 模块内双板块切换（照 WikiModule 板块切换 chips 惯例）：海龟汤 / 思维墙，默认海龟汤，板块选择不持久化。
- md 目录：`md/turtle/`（对局记录 `{gameId}.md`）、`md/wall/`（每日题详情 `{YYYY-MM-DD}.md`）、`md/wall/bank/`（精选题库详情 `{id}.md`）。
- 难度枚举：`easy | medium | hard`（简单 / 中等 / 困难）。
- 每日题/练习场题型（**v1.2 洞察题型池**）：`insight_invariant | strategy_protocol | counter_probability`（不变量与构造 / 策略协议设计 / 反直觉概率）。旧枚举 `logic_grid | truth_lie | sequence | verbal_trap` 全部退池不再生成（真假话推理为开发者明令删除），历史行的显示名映射保留。
- 精选题库标签（v1.2，自由文本）：认知推理 / 策略协议 / 构造编码 / 不变量构造 / 组合计数 / 递推构造 / 反直觉概率。
- 汤状态：`fresh | playing | solved | abandoned`（未玩 / 进行中 / 已破 / 弃汤），终态后不可再开局（已知汤底，重玩无意义）。
- 回收站来源值：`reasoning_soup` / `reasoning_game`（两值同属回收站「推理角」页签）。
- 不新增 AI 频道（v1）：`CHANNEL_BY_MODULE` 不加 reasoning 映射（默认助手频道）；不新增 settings key；不新增定时任务（v1.3 起每日题为「打开现取」——从预生成池转正，池空才现场出题；补充泵为事件触发的一次性后台任务，非定时器）。
- 题库常量（v1.3，`electron/services/reasoningStock.ts`）：`SOUP_TARGET=10 / SOUP_LOW=5`（汤库 fresh 存量目标/低水位）、`PUZZLE_TARGET=10 / PUZZLE_LOW=5`（wall_pool 题池）。新事件 `reasoning:stockChanged`（补充泵每补完一批推送，照 `recycle:changed` 模式，渲染层刷新汤库列表）。

## 1. 数据表（DB v12 起；v11 已被灵感文档标题迁移占用；v1.2 增量见本节末）

```sql
CREATE TABLE turtle_soups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,              -- 汤名，如《调音师》
  surface TEXT NOT NULL,            -- 汤面
  bottom TEXT NOT NULL,             -- 汤底
  analysis TEXT NOT NULL,           -- 裁判解析（判答用完整背景，如霸王别姬典故全貌）
  difficulty TEXT NOT NULL,         -- easy|medium|hard（AI 自评）
  theme_tag TEXT NOT NULL,          -- 题材标签一枚
  status TEXT NOT NULL DEFAULT 'fresh',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE turtle_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  soup_id INTEGER NOT NULL,             -- 不设外键：删汤不级联删局（对局记录是快照，自包含）
  status TEXT NOT NULL DEFAULT 'playing',   -- playing|solved|abandoned
  question_count INTEGER NOT NULL DEFAULT 0, -- 有效判断问答数（invalid 引导不计）
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,               -- 开局到终局墙钟时间
  md_path TEXT,                      -- 局终写入的对局记录 md
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_turtle_games_soup ON turtle_games(soup_id);

CREATE TABLE turtle_game_messages (  -- 问答流逐条即时落库（中断续玩/多局并行的根基）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES turtle_games(id),
  role TEXT NOT NULL,                -- user|assistant|system
  type TEXT NOT NULL,                -- question|answer|invalid|guess|verdict|notice
                                     -- invalid=非判断句引导回复（续玩载入时弱化渲染的依据）
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_turtle_msgs_game ON turtle_game_messages(game_id);

CREATE TABLE wall_puzzles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,         -- YYYY-MM-DD（本地时区），一天一题
  puzzle_text TEXT NOT NULL,         -- 题面全文
  answer_standard TEXT NOT NULL,     -- 标准答案（判答依据，局终前不写入任何 md）
  hints TEXT NOT NULL DEFAULT '[]',  -- JSON string[]，三级提示（出题时一次生成）
  puzzle_type TEXT NOT NULL,         -- logic_grid|truth_lie|sequence|verbal_trap
  difficulty TEXT NOT NULL,          -- 出题难度（连胜推导）
  status TEXT NOT NULL DEFAULT 'answering', -- answering|correct|wrong
  hints_used INTEGER NOT NULL DEFAULT 0,
  my_answer TEXT,
  md_path TEXT,                      -- 局终写入的详情 md
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- v12 迁移同时：`initDb` 目录清单追加 `md/turtle`、`md/wall`。
- 连胜口径：自今日（已答）或昨日（今日未答）起按 date 倒序连续 `status='correct'` 的天数；遇到无记录日或 `wrong` 即止。出题难度 = `min(2, 连胜)`（**v1.2：答对 1 天即升一档**）封顶 `hard`；答错连胜清零，次日回 easy。
- 每日题记录不可删除、不进回收站（墙是真实历史）。

**DB v13（v1.2 洞察题重做）**：① `ALTER TABLE wall_puzzles ADD COLUMN standard_reasoning TEXT`（出题时的标准论证，判答讲解注入与详情 md「标准论证」节共用）；② 新表 `wall_bank`——精选题库（双层题源第二层）：

```sql
CREATE TABLE wall_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  tag TEXT NOT NULL,                -- 认知推理/策略协议/构造编码/…（自由文本）
  difficulty TEXT NOT NULL,         -- easy|medium|hard（策展定档）
  puzzle_text TEXT NOT NULL,
  answer_standard TEXT NOT NULL,    -- 标准结论（判答基准）
  solution TEXT NOT NULL,           -- 标准论证全文（md；局终写进详情 md）
  source TEXT NOT NULL,             -- 出处：经典（xxx）/ 原创（bugzi 的 workspace）
  status TEXT NOT NULL DEFAULT 'todo', -- todo|solved|failed，终态不可重做
  my_answer TEXT,
  md_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- v13 迁移同时插入首批评选 10 题（`electron/db/wallBankSeed.ts`，答案/论证均经人工验证；对话中已向开发者示过答案的原创题不收原题——2026 卡片题改用 2017 变体，18 日期认知题未收录）；目录清单追加 `md/wall/bank`。
- 精选题库记录不可删除、不进回收站（同「墙是真实历史」口径）。

**DB v14（v1.3 题库预生成）**：新表 `wall_pool`——每日一题/练习场共用的预生成题池：

```sql
CREATE TABLE wall_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  puzzle_text TEXT NOT NULL,          -- 题面
  answer_standard TEXT NOT NULL,      -- 标准结论
  standard_reasoning TEXT NOT NULL,   -- 标准论证（判答讲解用，照 v13 口径）
  hints TEXT NOT NULL DEFAULT '[]',   -- 三级提示 JSON（出题时一次生成）
  puzzle_type TEXT NOT NULL,          -- 三洞察题型
  difficulty TEXT NOT NULL,           -- easy|medium|hard
  created_at TEXT NOT NULL
);
```

- 池是**未消费的储备**：无 `deleted_at`、不进回收站、无删除入口；被取走即转正（每日题）或消耗（练习场）。新表空起，首填由补充泵完成。
- 存量口径：汤库存量 = `turtle_soups` 中 `status='fresh' AND deleted_at IS NULL` 行数（回收站软删不算；恢复回收站 fresh 汤使存量回升）；题池存量 = `wall_pool` 行数。

## 2. 模块本体（src/modules/reasoning/）

**ReasoningModule.tsx：**

- 标题区（icon + 推理角 + 副标题「把 AI 当陪练的推理健身房」）+ 双板块 chips；子组件 TurtlePanel / WallPanel。
- 照现有模块 keep-alive 渲染接入 App.tsx；监听 `MODULE_ACTIVATED_EVENT`；进入思维墙板块（含模块激活且当前板块为思维墙）时调 `wall:ensureToday`——「打开现取」（v1.3：池转正秒开，池空才现场出题）。模块激活时另调 `reasoning:stockCheck` 触发补充泵（v1.3）。

**TurtlePanel · 汤库 tab：**

- 工具行：「来 3 碗汤」按钮 + 难度偏好选择（随机 / 简单 / 中等 / 困难，默认随机，单次有效不持久化）+ 难度筛选 chips（全部 / 简单 / 中等 / 困难）。
- 生成中按钮 loading「AI 出汤中…」；LLM 未配置点按钮弹 GoConfigDialog（全局规则 8，下同）。
- **v1.3 定位变化**：「来 3 碗汤」从唯一获取途径退居**手动补充**（fresh 存货由补充泵自动维持）；行为与样式原样保留，与泵并发各自独立插库。
- **v1.3 事件刷新**：监听 `reasoning:stockChanged` 刷新汤库列表——后台补的汤渐进出现，无 toast。汤库为空时空态文案改「AI 正在后台备汤，稍候即有新汤；或点『来 3 碗汤』立即补」。
- 列表行：汤名 + 难度 badge + 题材 chip + 状态标记（未玩/进行中/已破/弃汤）。**列表不展示汤面**（开局后才见，保留神秘感）；`playing` 行点击=续局，`fresh` 行点击=开局，终态行不可点。
- 汤行删除：二次确认（ConfirmDialog）→ 回收站；`playing` 状态的汤不可删（提示先结束对局——放弃或破汤）。

**TurtlePanel · 对局视图（主栏内嵌，点汤/续局进入）：**

- 顶部：返回列表 + 汤名/难度/题材 + 状态徽标 + 统计（问 N · 用时 mm:ss 实时跳动）；下方汤面卡片（全文）。
- 问答流：气泡式（user 右 / assistant 左，照 AI 边栏消息样式惯例）；`verdict`（猜汤底判定，含破/未破+方向反馈）整块强调样式；`invalid` 引导消息弱化样式。
- 底部输入行：提问输入框 + 发送；「我猜汤底」→ 行内展开多行推理输入 + 提交/收起；「放弃」→ ConfirmDialog 二次确认。
- LLM 调用中输入区 loading 防连发。
- 终局（ask/guess/abandon 的 IPC 返回终态后）：问答流尾部展示汤底卡片 + 「查看复盘」按钮 → MdDialog 打开 `md_path`（渲染态，双击编辑能力沿用全局弹窗默认，不特殊禁用）。
- 中断续玩 = 每条消息即时落库的自然结果，无显式保存。

**TurtlePanel · 对局记录 tab：**

- 终局局列表，按 `ended_at` 倒序：汤名 + 结果徽标（已破 / 弃汤）+ 提问数 + 用时 + 结束时间；点击开 MdDialog；行删除二次确认 → 回收站（进行中的局不在此列表、不可删，丢弃走「放弃」）。

**WallPanel · 今日题区：**

- 无题：进入板块即 `ensureToday`（v1.3 正常路径从池转正**秒回**，零 LLM 调用）；LLM 未配置 catch `LLM_NOT_CONFIGURED` → GoConfigDialog；生成中占位仅兜底路径出现，文案「题库见底，现场出题中…」（v1.3）。
- `answering`：题面卡片（题型 + 难度 badge）+ 多行作答输入 + 「提交作答」+「要提示（已用 N/3）」——提示直接取库存下一级（不调 LLM），用尽后按钮文案「提示已用完」禁用。
- `done`：结果卡（对 / 错、我的作答、是否用了提示）+「查看讲解」→ MdDialog。答错即终局，当日不可再答。
- 对/错的状态呈现遵循样式 specs 主题色系约束（不引入大红大绿彩亮色）。

**WallPanel · 打卡墙（月历）：**

- 月视图网格（表头 日 一 二 三 四 五 六）；格子三态：无记录=空、`correct`=主题色亮底 + 提示级数角标（0 级不标）、`wrong`=close 图标；今天描边高亮；月份 ‹ › 切换。
- 点有记录的格子 → MdDialog 打开当日 `md_path`。
- 顶部统计行：当前连胜 N 天 · 本月答对 X · 答错 Y。

**WallPanel · 练习场（v1.1 增补，design v2 备选「练习场」提前落地）：**

- 打卡墙下方独立 zone（icon `fitness_center`）：随时刷题、自选难度（下拉 随机/简单/中等/困难，默认随机，单次有效不持久化——照汤库难度偏好惯例），**不计入打卡墙/连胜/月历**，不落库、不写 md。
- 数据是**会话级**的：主进程内存 Map `practiceBank` 暂存（题面/标准答案/三级提示），容量 10 条防累积，应用重启即清（练习无存档语义）。判答入参 id 失效（重启后）抛 `PRACTICE_GONE`，渲染层 toast 后重出一道。
- 交互照每日一题同款：出题（`wall:practiceNew`，v1.3 优先从 wall_pool 按难度/题型筛选取题——DELETE 池行后入 practiceBank，秒回；池中无匹配兜底现场两阶段生成，loading「题库见底，现场出题中…」）→ 作答卡（quiz-card + 三级提示内存直取 `wall:practiceHint`）→ 判答（`wall:practiceAnswer`，宽松等价 + 完整讲解，一题一命判答即终局）→ 结果卡（对/错 + 我的作答 + 标准答案 + **讲解内联 MdView 渲染** `.rs-explain`，无复盘文档）+「再来一道」。换题直接再点「来一道」（弃当前题）。
- **v1.2 题型自选**：难度下拉旁加题型下拉（随机题型 / 不变量与构造 / 策略协议设计 / 反直觉概率，默认随机，单次有效不持久化），`practiceNew` 第二参传入。
- 出题/判答复用 `generateWallPuzzle` / `judgeWallAnswer`，画像注入口径不变（出题注入、判答不注入）。

**WallPanel · 精选题库（v1.2 双层题源第二层，打卡墙与练习场之间）：**

- 人工策展的存量难题随 DB v13 种子入库（首批 10 题），**AI 只判答不出题**；目录 `md/wall/bank/{id}.md` 局终一次写入。
- 列表行：状态图标（未做 help / 已破 task_alt / 未破 close）+ 标题 + 标签 badge + 难度 badge + 出处（悬停 title）；头部计数「已破 N / 总数」；点行打开当前题卡。
- 当前题卡：题面 + 多行作答输入（结论 + 论证，结论对即算对）+「提交作答」（判答 → 结果内联呈现 + 列表状态刷新）+「看解答」（**二次确认**，终态记 failed 直接揭示标准答案与论证）。终态后再点行 = 结果回看 +「查看完整档案」开 MdDialog。
- 一题一命：`todo → solved / failed` 终态不可重做（墙是真实历史）；记录不进回收站。LLM 未配置走 GoConfigDialog（全局规则 8）。

## 3. AI 服务（electron/ai/services.ts 新增六函数）

统一：出题类（generateSoups / generateWallPuzzle）注入 `profileDigest()` 画像摘要；判答类（judgeSoupQuestion / judgeSoupGuess / judgeWallAnswer）与点评（soupReview）不注入（design 模块整合节口径）。除 generateWallPuzzle 为两阶段（出题 + 审题验证，v1.2）外全部单趟 `chatCompletion`，数据由 IPC 层查库传入。**v1.3 不新增 AI 函数**——补充泵（`electron/services/reasoningStock.ts`）是编排层，复用 generateSoups / generateWallPuzzle，注入口径不变（泵调的正是出题类）。

**generateSoups(preference)**（temperature 0.9，jsonMode）：

- 人设：资深海龟汤出题人。指令要点：一次原创 3 碗（禁止搬运网传经典）；每碗三件套齐全；按难度偏好出题、AI 自评难度并打一枚题材标签。
- **质量标准（design 汤库节，写入 prompt）**：①汤面铺足可供盘问的具体事实（抓手，参考《致命日记》五则日记、《谁盖住了我》四次「被盖住」的结构）②汤底逐一回收汤面全部细节，无悬空元素 ③本格自洽、无超自然 ④事实链封闭、全部可被是/否问答判定。反面锚点：汤面只给结论（如「现场被人布置过」）而不铺事实 = 不合格。
- 自检指令：输出前逐碗检查上述四条，不合格的碗重写替换，最终恰 3 碗。输出 schema：`{soups: [{title, surface, bottom, analysis, difficulty, theme}]}`；解析失败或不足 3 碗抛错，**不落半截数据**；3 碗同事务插库（status=fresh）。

**judgeSoupQuestion(soup 三件套, 最近问答历史, question)**（temperature 0.2，jsonMode）：

- system = 裁判人设 + 该汤汤面/汤底/裁判解析全文 + 回复协议；历史注入最近 30 条防重复问。
- 回复四类：`yes / no / irrelevant / invalid`（非判断句）。`reply` 要求复述式一句话（如「否，这两个人不是互相杀害」），不添加汤面汤底之外的新信息；`invalid` 固定引导「请提能用是/否回答的问题」。输出 `{type, reply}`。

**judgeSoupGuess(三件套, 历史, reasoning)**（temperature 0.2，jsonMode）：

- 判「破汤 / 未破」；未破给方向反馈：`hits`（已命中的点，string[]）、`misses`（偏了的方向，string[]）、`feedback`（一句话），**不泄露关键缺失信息**；已破 `solved: true`。输出 `{solved, hits, misses, feedback}`。

**soupReview(三件套, 全问答流, 结果)**（temperature 0.5，非 jsonMode）：

- 教练人设：提问效率点评——哪个问题问在关键上、哪些是浪费、推理链评价；弃汤加指出卡点。输出 md 片段（200 字内），由 IPC 层拼进对局记录 md。

**generateWallPuzzle(difficulty, opts?)**（v1.2 洞察题重做；两阶段管线，出题 temperature 0.9 / 审题 0.2，jsonMode）：

- `opts.type` 指定题型（不传随机）；`opts.avoid` 近期题面摘要清单（防同构重出）。人设：洞察级命题人，核心禁令 = 不出「已知套路 + 更大计算量」的模板题（纯排除、纯网格、纯逐轮剪枝、套公式即解一律不合格）。
- **三题型**：不变量与构造（答案藏在守恒量里，常放一层恰好放行的假守恒当诱饵）/ 策略协议设计（设计必胜/必达协议并论证无懈可击）/ 反直觉概率（结论违反朴素直觉，需严格论证）。
- **难度锚定**（写进 prompt，难度来自洞察深度而非计算量）：简单 = 单工具但映射不显然；中等 = 两层洞察链或含诱饵，可能需自建辅助构造；困难 = 三层以上链或需发明本题特有不变量/协议，结论反直觉。
- **硬性质量标准**（逐条自检）：结论唯一可判定或方案可验证；题面自包含、无需大量簿记；不可被模板直接套解；至少埋一条「看似可行的错误路线」；hints 三级递进（方向→工具→关键构造，不直接给答案）；reasoning 标准论证全文（200~500 字，闭合无跳步）。输出 `{puzzle, answer, reasoning, hints[3]}`。
- **阶段二 · 审题（半盲验证）**：审题人只看题面 + 标准结论（不给论证），必须独立重新推演，过四关——结论正确 / 结论唯一（无歧解）/ 条件自洽完备 / 实际难度达标且不被模板套解。不过 → 问题清单回注重出一次，仍不过抛错**不落库**。

**judgeWallAnswer(题面, 标准答案, 标准论证, myAnswer)**（temperature 0.1，jsonMode；v1.2 验证式判答）：

- 宽松等价：结论实质相同即算对（同一数值 / 同一结论 / 同一策略或等价构造）；只给结论不论证也算对，附带论证时讲解中顺带点评（亮点/漏洞），但不因论证问题改变判定。
- 注入标准论证，讲解 = 判定理由 + 完整标准论证（150~400 字 md）。输出 `{correct, explanation}`。判答不注入画像。

## 4. IPC（`turtle:*` / `wall:*`）

```
turtle:listSoups(difficulty?)            → 汤列表（不含 surface/bottom/analysis）
turtle:openSoup(soupId)                  → { gameId, title, surface, difficulty, theme }
                                           fresh → 开新局（建 game 行）；playing → 返回现有局（续玩）
turtle:game(gameId)                      → { title, surface, difficulty, theme, status,
                                             questionCount, startedAt, messages[] }（进行中不含 bottom）
turtle:ask(gameId, question)             → { type, reply }（落 question + answer 两条消息；
                                           type≠invalid 时 question_count+1）
turtle:guess(gameId, reasoning)          → { solved, bottom?, hits?, misses?, feedback, mdPath? }
                                           （落 guess + verdict 消息；solved → 主进程完成终局链后返回）
turtle:abandon(gameId)                   → { bottom, mdPath }（落 notice；主进程完成终局链）
turtle:discardSoup(soupId)               → 回收站（playing 抛 PLAYING）
turtle:discardGame(gameId)               → 回收站（仅终局局）
turtle:listGames()                       → 终局局列表（ended_at 倒序）

wall:ensureToday()                       → { phase: 'answering'|'done', puzzleId?, puzzle?,
                                             hintsUsed?, result? }（v1.3：当日无题从 wall_pool
                                           取题转正——按连胜难度+题型避近2日匹配，四级放宽
                                           （难度+题型→仅难度→任意→池空兜底现场两阶段生成），
                                           同事务 INSERT wall_puzzles + DELETE 池行，零 LLM 秒回；
                                           取题后触发补充泵）
wall:answer(puzzleId, myAnswer)          → { correct, standardAnswer, explanation, mdPath }
                                           （落终态 + 写 md + 更新连胜推导所需的全部字段）
wall:hint(puzzleId)                      → { level, text } | null（用尽返回 null）
wall:month(year, month)                  → [{ date, status, hintsUsed, difficulty }]（当月有记录的天）
wall:recordPath(date)                    → md 路径 | null

wall:practiceNew(pref)                   → { id, puzzle, typeZh, diffZh, hintsTotal }（v1.1 练习场：
                                           pref=random|easy|medium|hard，random 主进程随机；
                                           会话级内存暂存，不落库不写 md；v1.2 加 typePref 题型可选；
                                           v1.3 优先从 wall_pool 按难度/题型筛选取题——DELETE 池行
                                           后入 practiceBank（取走视为消耗，不恢复），无匹配兜底
                                           现场生成；取题后触发补充泵）
wall:practiceAnswer(id, myAnswer)        → { correct, standardAnswer, explanation }（一题一命判答即终局；
                                           id 失效（重启）抛 PRACTICE_GONE；无 md）
wall:practiceHint(id)                    → { level, text } | null（内存直取不调 LLM；用尽/失效 null）

wall:bankList()                          → [{ id, title, tag, diffZh, difficulty, source, status,
                                           mdPath }]（v1.2 精选题库列表，不泄答案与论证）
wall:bankOpen(id)                        → { id, title, tag, puzzle, status, myAnswer, mdPath }（不泄底）
wall:bankAnswer(id, myAnswer)            → { correct, standardAnswer, explanation, mdPath }
                                           （判答 + 写详情 md + 落终态 solved/failed；已答抛 ALREADY_ANSWERED）
wall:bankReveal(id)                      → { standardAnswer, solution, mdPath }
                                           （看解答：不判答直接揭示 + 写 md + 落终态 failed）

reasoning:stockCheck()                   → void（v1.3：触发题库补充泵；模块激活时调，
                                           fire-and-forget，不返回存量——UI 不展示库存）
```

**补充泵（v1.3，`electron/services/reasoningStock.ts`，仿 scheduler.ts 惯例）：**

- 入口 `ensureReasoningStock()`，全部调用点 fire-and-forget（`void ensureReasoningStock()`），**永不抛错、永不弹窗**；单例 `pumping` 标志防并发重入（手动「来 3 碗汤」不经泵，与泵并发各自独立插库，最坏多 3 碗，可接受）。
- **汤侧**：fresh 存量 < `SOUP_LOW`(5) → 循环调 `generateSoups('random')`（每批 3 碗、难度错开）直到 ≥ `SOUP_TARGET`(10)。`generateSoups` 零改动（其近 200 碗避免清单天然覆盖全部 fresh 存货）。
- **题侧**：池数 < `PUZZLE_LOW`(5) → 循环调 `generateWallPuzzle(difficulty, { type, avoid })` 逐道入池直到 ≥ `PUZZLE_TARGET`(10)。难度 = 池内数量最稀缺档（并列随机，保证连胜任何档位有货）；题型 = 池内 + 近 2 日历史合计最少见（保池内题型多样）；avoid = 近 20 题 `wall_puzzles` 题面摘要 + **池内全部题面摘要**（防池内互相同构）。
- 单批失败（含 LLM 未配置）catch 记 console.warn 跳出，下次触发再补；每补完一批 `win()?.webContents.send('reasoning:stockChanged')`（照 `recycle:changed` 模式）。
- **三个触发点**：① `main.ts` 启动后延迟 10s 跑一次（错开启动高峰，unref）；② 每次消耗后——每日题转正后、练习场取题后（含兜底路径）、点汤**开新局**后（fresh−1；续局/终局不触发）；③ 进入推理角模块时（`reasoning:stockCheck`）。
- 避免清单口径：池题以**生成时刻**为准（当时近 20 题 + 池内互避）；池 ≤ 10 道周转快，转正不做二次校验（YAGNI）。

**终局链（`turtle:guess` solved 与 `turtle:abandon` 共用，主进程内完成）：**

1. `soupReview(...)` 生成点评 → 2. 拼对局记录 md（结构见下）写 `md/turtle/{gameId}.md` → 3. 更新 game（status/ended_at/duration_ms/md_path）与 soup.status（solved/abandoned）→ 4. 返回渲染层（展示汤底 + 开复盘弹窗）。

**对局记录 md 结构**（`md/turtle/{gameId}.md`）：

```
# {汤名}（{难度}·{题材}）
## 汤面 / ## 汤底 / ## 结果（已破|弃汤 · 问 N · 用时 mm:ss）
## 问答全程（Q/A 逐条；guess/verdict 用引用块）
## 最终推理 / ## AI 点评
```

**每日题详情 md 结构**（`md/wall/{YYYY-MM-DD}.md`，局终一次写入）：

```
# {YYYY-MM-DD} 每日一题（{题型}·{难度}）
## 题面 / ## 我的作答（含提示使用 N/3）/ ## 判定（对|错）/ ## 标准答案 / ## 讲解
```

## 5. 回收站接入（第 6 板块「推理角」）

- `RecycleSource` 追加 `'reasoning_soup' | 'reasoning_game'`；TABLES：`reasoning_soup → turtle_soups`、`reasoning_game → turtle_games`；MD_FIELDS：soup 为 null（汤无 md），game 为 `md_path`。
- `item:discard` 的 RECYCLE_MAP 追加 `turtle_soups → reasoning_soup`、`turtle_games → reasoning_game`。
- restore：两者均清 `deleted_at` 回原列表（soup 状态不变；game 回对局记录列表）。
- hardDelete：soup = 删行（对局记录 md 是快照，不受影响，design 明确）；game = 照 zhijiji 特判——先收 md 路径，删消息行 + game 行 + recycle 记录，最后删 md 文件。
- RecycleModule 页签追加「推理角」（顺序：格言库/万象库/灵感泉/辩真阁/致知己/推理角），恢复提示「恢复到推理角」；页签内两来源条目混排，payload 摘要区分汤/局。

## 6. 渲染层接线

- `src/shared/types.ts` + `src/renderer/api.d.ts`：`ModuleId` 加 `'reasoning'`；`RecycleRow.source` 联合类型追加两值；`Api` 加 `turtle` / `wall` 两命名空间（形状照 §4）；`TurtleSoupRow / TurtleGameRow / TurtleGameMessage / WallPuzzleRow / WallDayCell` 等类型定义。
- `electron/preload.ts`：桥接新通道（与 Api 保持同步）；v1.3 加 `reasoning:stockCheck` 与 `reasoning:stockChanged` 事件桥接（照 `recycle:changed` 模式）。
- `App.tsx`：MODULES 在 recycle 前插 `{ id: 'reasoning', label: '推理角', icon: 'psychology' }`；keep-alive 渲染 `<ReasoningModule />`；`CHANNEL_BY_MODULE` 不加映射；本模块无需 onOpenAi（赛后讨论由用户手动到助手频道）。
- 样式入 App.css（照现有模式），遵循双主题 CSS 变量与「框/按键/弹窗用主题相近色系」约束，图标一律 Material Symbols。

## 7. 总需求文档同步（开发者审核后生效）

- 条目 3：结构化数据清单 + 汤库 / 对局 / 问答消息 / 每日题；md 清单 + 对局记录、每日题详情。
- 条目 5：回收站五板块 → 六板块（+ 推理角：汤恢复回汤库、对局记录恢复回记录列表；每日题不进回收站）。
- 条目 12：侧边栏顺序插入推理角（致知己之后、回收站之前）。
- 条目 8（LLM 未配置交互）、条目 9（不新增频道、画像注入口径）无需改动，推理角按现行规则执行。
- v1.3：条目 3 结构化数据清单追加 `wall_pool`（预生成题池）；其余条目无改动（不新增模块/板块/定时任务/settings）。

## 8. 验收清单

- [X]  侧边栏第八模块「推理角」顺序正确；双板块切换正常，默认海龟汤
- [X]  来 3 碗汤：难度偏好可选、生成 3 碗三件套齐全、AI 自评难度+题材标签；LLM 未配置弹引导；生成失败不落半截数据
- [ ]  对局：只答「是/否/与汤无关」；非判断句引导且不计提问数；猜汤底判定+方向反馈（不泄露关键缺失）；放弃二次确认后揭示汤底
- [ ]  中断续玩 / 多局并行：问答逐条落库，关 App 重开续局；进行中的汤不可删
- [ ]  局终：自动存档（快照式 md 含汤面汤底全文）+ AI 点评（破/弃都点评）；删汤不影响已有对局记录
- [ ]  对局记录：倒序列表 + MdDialog 查看 + 删除进回收站推理角板块；恢复回记录列表
- [ ]  思维墙：打开现出（无定时器）；当天没来墙上空格；标准答案随题存库
- [ ]  作答：宽松等价判答；答错即终局揭示答案+讲解；答对也讲解；提示最多 3 级（用提示仍算打卡成功并标注级数）
- [ ]  难度递进：**v1.2 连胜 1 天升一档**封顶困难；答错清零回简单；题型轮换（近 2 日不重）+ 近 20 题避免清单
- [ ]  打卡墙月历三态格子、点格子回看当日详情；每日题记录不可删除、不进回收站
- [ ]  **v1.2 出题质量**：两阶段管线（出题→审题独立验证结论/唯一/可解/难度达标，两次不过不落库）；洞察题型池三类型生效，无模板题
- [ ]  **v1.1 练习场**：难度 + 题型双下拉随时刷题，不计入墙与连胜；提示三级；PRACTICE_GONE 优雅降级
- [ ]  **v1.2 精选题库**：首批 10 题入库展示；作答终态判答 + 看解答二次确认；详情 md 含标准论证；已破计数正确
- [ ]  回收站第 6 板块：汤/对局记录二次确认入站、恢复、3 天彻底删除（game 连带消息与 md）
- [ ]  画像注入口径：出题注入、判答/点评不注入；typecheck 双配置通过
- [ ]  **v1.3 每日题池命中秒开**（零 LLM 等待）；连胜难度推导与题型轮换（避近 2 日）行为不变
- [ ]  **v1.3 练习场**：按难度/题型从池取题秒回；池无匹配兜底现场生成；PRACTICE_GONE 口径不变
- [ ]  **v1.3 补充泵**：汤库 fresh < 5 补到 10、题池 < 5 补到 10（难度稀缺优先、题型多样、avoid 含近 20 题 + 池内互避）；三触发点（启动延迟 10s / 消耗后 / 进入模块）各自生效
- [ ]  **v1.3 边界**：池空兜底现场生成（文案「题库见底，现场出题中…」）；LLM 未配置泵静默（console.warn）而手动入口照规则 8；两阶段失败不落池；`pumping` 防重入；转正同事务不双份；`reasoning:stockChanged` 列表渐进刷新 + 空态文案更新；池表不进回收站
