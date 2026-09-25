# 赋诗苑 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/生活模块/赋诗苑/design.md`（260925 开发者审核通过）与《总需求文档.md》生成，是开发的直接依据。依赖：样式/designs-specs.md（MdDialog / GoConfigDialog / ConfirmDialog / Toast 与主题色系约束，禁 emoji 图标、禁彩亮色）、回收站/designs-specs.md（接入约定）、致知己/学习库（画像注入 profileDigest 惯例）。实现中凡与既有代码惯例冲突处，以既有惯例为准并在日志记偏差。
>
> **DB 版本注记**：本文档写作时最新为 v53（260925 问题疑惑区修复轮占用）。本模块新表原规划为 v54；**260925 播客台同日落地实际占用 v54**（其 specs 基于同一 v53 基线各自顺延所致），本模块迁移顺延取号 **v55**（推理角 v1.8 教训）。
>
> **实施落地（260925）**：v55 三表 + 三页签全量落地。两处实施形态偏差（以实现为准）：① `FEIHUA_KEYWORDS` 关键字池落 `src/shared/types.ts`（渲染层自由练选字需要，免开 IPC，`fushiNorm` 同处）；② MdDialog copilot 槽不带 `getSelection` prop——选区由 MdDialog 内部跟踪（textarea onSelect），采纳文本手术（替换首个选区命中 / 尾部追加）也由 MdDialog 完成，调用方只持 LLM 状态（busy/suggestion + onRun/onAdopt/onDismiss）。其余按本 specs 实施。

## 0. 命名与常量

- 模块 id：`fushi`（App.tsx MODULES 已有占位行）；侧边栏名「赋诗苑」；图标 Material Symbols `brush`（260926 开发者指令由占位 `auto_awesome` 改为毛笔图标）；位置：生活模式区第 5 位（副本库与推理角之间），占位转正后排序不变。
- 模块内三页签：「飞花令｜斗诗台｜诗集」，默认飞花令；页签切换用 `recycle-tabs` 样式（InterviewBankPanel 同款），选择不持久化；切页签不丢进行中对局（keep-alive 天然满足，对局态存渲染层组件 state）。
- md 目录：`md/fushi/poems/<id>.md`（诗作）、`md/fushi/games/<id>.md`（对局留档）。
- 体裁枚举：**`jueju | lvshi | ci | modern | free`**（绝句 / 律诗 / 词 / 现代诗 / 自由体），中文名映射 `GENRE_ZH` 常量（不用 ü 避免编码坑）；斗诗出题体裁限前四种（free 不进斗诗题面）。
- 对局类型：`feihua | doushi`；胜负枚举统一 `win | lose | draw`（我方视角；飞花令不产生 draw）。
- 飞花令关键字池 `FEIHUA_KEYWORDS`（`electron/services/fushi.ts`，常量约 30 字）：月 风 雪 花 春 江 夜 酒 山 云 柳 梦 秋 舟 灯 霜 桥 烟 雨 剑 琴 故人 长亭 天涯 归 眠 醉 寒 玉 马——实施时可微调字表，原则：常用意象、名句覆盖率高、单字为主（双字词仅限「故人 / 长亭 / 天涯」）。
- 回收站来源值：`fushi_poem` / `fushi_game`（同属回收站「赋诗苑」块，条目标注来源页签）。
- AI 场景标签（`src/shared/types.ts` LLM 场景标签映射表，紧邻 `'wenbi:copilot'` 条目）：`fushi:feihua`（赋诗苑·飞花令）、`fushi:doushi`（赋诗苑·斗诗台）、`fushi:copilot`（赋诗苑·诗友）。
- 不新增 AI 边栏频道（`CHANNEL_BY_MODULE` 不加 fushi，默认助手频道）；不新增 settings key；新增定时触发仅「每日一令定档」一处挂现有午夜 scheduler。
- 飞花令文本归一化 `fushiNorm(s)`：去全部空白与中英文标点（复用 `questionNorm` 的正则口径）、小写——判字与查重共用。

## 1. 数据表（DB v55）

```sql
CREATE TABLE fushi_poems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  genre TEXT NOT NULL,               -- jueju|lvshi|ci|modern|free
  md_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE fushi_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                -- feihua|doushi
  topic TEXT NOT NULL,               -- feihua=关键字；doushi=主题
  genre TEXT,                        -- doushi 体裁；feihua 为 NULL
  result TEXT NOT NULL,              -- win|lose|draw（我方视角）
  rounds INTEGER NOT NULL DEFAULT 0, -- feihua=双方有效出句总数；doushi=1
  daily INTEGER NOT NULL DEFAULT 0,  -- 1=每日一令局（当日打卡依据）
  md_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE fushi_daily (
  date TEXT PRIMARY KEY,             -- YYYY-MM-DD 本地时区
  keyword TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
```

- v55 迁移同时：`initDb` 目录清单追加 `md/fushi/poems`、`md/fushi/games`。
- **每日一令定档** `ensureFushiDaily()`（`electron/services/fushi.ts`，同步幂等零 LLM，同 `ensureInterviewDaily` 模式）：`fushi_daily` 已有今日行即跳过；关键字 = `FEIHUA_KEYWORDS[daysSince('2026-09-25') % 池长]`（天数差按本地日期算，稳定可复现）。触发三处：main.ts 启动延迟、scheduler 午夜零点（与 ensureInterviewDaily 同一挂点追加）、`fushi:daily` handler 内。
- **打卡判定**：每日一令局终局（写入 `fushi_games.daily=1` 行）即 `UPDATE fushi_daily SET done = 1 WHERE date = 今日`。自由局不写 done。中断弃局不落库，当日可重开（done 仍 0）。
- **连胜口径** `fushiStreak()`（与 `learnStreak` 同构，自写不复用——表不同）：自今日（done=1 含今日，否则从昨日起）往回数 `fushi_daily.done=1` 连续天数，缺行或 0 即断。
- **热力图第四源**：`electron/services/overview.ts` `heatmapOverview` 增查 `fushi_daily`（done=1）；`HeatmapDay`（`src/shared/types.ts:1233`）增 `fushi: boolean`，`blank()` 与聚合循环同步加字段；`level = learn + wall + challenge + fushi`（0–4）。`HeatmapCard.tsx` 色阶适配五档（现四档 0–3，色阶数组与图例扩一位，色彩仍主题色系渐进、禁彩亮色），悬停明细文案追加「飞花令」。

## 2. UI

### 2.1 FushiModule（`src/modules/fushi/FushiModule.tsx`）

- 顶部三 chips 页签；三面板组件同目录拆文件：`FeihuaPanel.tsx` / `DoushiPanel.tsx` / `PoemsPanel.tsx`；对局视图组件 `FeihuaGame.tsx` / `DoushiGame.tsx`（各自面板内条件渲染，切页签保留 state——面板不卸载，仅 display 切换或提升 state 至 Module 均可，实施时取改动小者）。

### 2.2 飞花令页签

- **每日一令卡**（置顶）：关键字大字展示 + 「连胜 N」徽标 + 主按钮；三态——`未开局`（「开始今日飞花令」）/ `进行中`（回对局视图）/ `已终局`（「今日已打卡 · 胜/负」+「回看对局」按钮，当日不再可开局）。数据 `fushi:daily` 一次取齐（keyword/done/streak/今日局 id）。
- **自由练入口**：每日卡下方折叠行——关键字选择（池字胶囊 + 随机一颗），点击即开自由局（daily=0）。
- **对局视图**（FeihuaGame）：消息流（双方诗句气泡，AI 句附逐句讲解小字，我方句纯文本）；底部输入行（placeholder「接一句含『×』的诗句」）+「我接不上了」认负按钮（二次确认 ConfirmDialog）。
- **判字与查重（渲染层即时）**：我方提交先过 `fushiNorm`——不含关键字行内红字提示「这句里没有『×』」（不计回合不调 AI）；与本局已出句归一化重复提示「这句本局说过了」。AI 回合由主进程校验（§3.1）。
- **终局**：结果卡（胜 / 负 + 双方句数）+「查看留档」入口；无重开。终局只有两条路径——我点「我接不上了」认负（二次确认）判负；主进程返回 AI 连续三次出句不合格（giveUp）判我胜。其余关闭（切模块 / 关弹窗 / 关 App）一律**弃局**：不留档、不计打卡、当日可重开（与 §1 打卡判定互洽）。
- **历史对局列表**：本页签下半区，行 = 类型徽标（每日 / 自由）+ 关键字 + 胜负色徽 + 轮次 + 日期；点击只读回看（终局 md 渲染，全局 md 弹窗 readOnly）；行删除 icon 二次确认入回收站。

### 2.3 斗诗台页签

- 「新斗诗」主按钮 → 生成中态（防重复点击）→ 进入对局视图。
- **对局视图**（DoushiGame）：题面卡（主题 + 体裁徽标）；我方写作框（纯文本 textarea，多行，无 Copilot）；提交按钮（空文本禁用）→ 提交后 AI 作品区亮出（生成中显示进行态）→ 下方点评区：四维评分条（切题 / 格律 / 意象 / 意境，各 10 分，进度条形式）+ 总评文字 + 胜负徽标。
- 终局动作：「存入诗集」（把我的诗转诗集：title=主题、genre=对局体裁、content=我的诗全文；成功 toast「已入诗集」）、「查看留档」；斗诗提交即终局，无重开。
- 历史对局列表同飞花令（类型徽标区分）。

### 2.4 诗集页签

- 顶部：「+ 新作」按钮 + 体裁筛选胶囊（全部｜绝句｜律诗｜词｜现代诗｜自由体）。行组件 = 标题 + 体裁小徽 + 更新时间；行点击开 MdDialog；行删除 icon 二次确认入回收站。
- 新作：弹窗输入标题 + 选体裁 → `fushi:poemAdd` 创建占位 md → 打开 MdDialog 编辑态（autoEdit）。
- **MdDialog 新增通用 `copilot` 扩展位**（回调化、模块无关，260908 删除的 copilot 机制以新形态回归）：

  ```ts
  copilot?: {
    busy: boolean
    suggestion: string | null          // null=无建议卡
    onRun: (action: 'draft' | 'continue' | 'polish' | 'rewrite' | 'duiju' | 'gelo', selection: string) => void
    onAdopt: () => void                // 采纳：MdDialog 已完成替换/追加正文手术，调用方清 busy/suggestion
    onDismiss: () => void
  }
  ```

  - 渲染：编辑态正文 textarea 下方工具行（起稿 / 续写 / 对句 / 格律点评常驻；润色 / 改写仅选中文本时出现）；`suggestion` 非空时建议预览卡（AI 版 + 采纳 / 放弃 / 重新生成）。busy 中工具行禁用并显进行态。选区由 MdDialog 内部跟踪（textarea onSelect）。
  - 对话框其余调用方不传 copilot，行为零变化（ MdDialog 现有 17 处调用无感）。

### 2.5 LLM 未配置

- 全局规则：AI 按钮不置灰，点击 toast 提示并弹 GoConfigDialog（goConfig kind 'llm'）直达个人档。每日一令卡、连胜、热力图、历史列表、诗集浏览不依赖 LLM。

## 3. AI 服务（`electron/ai/services.ts`）

全部函数：末位 `signal` 参（260908 全局取消惯例）；全中文 prompt；system 注入 `profileDigest()`（斗诗与 copilot；飞花令出句不注入）。

### 3.1 飞花令出句 `feihuaAiTurn(keyword, usedLines, history, signal)`

- 输出 JSON：`{ "line": "诗句", "note": "一句话讲解（出处/意境）" }`，`jsonMode: true`，scene `fushi:feihua`，temperature 0.7。
- prompt 约束：必须是**真实存在的古诗词原句**（禁止编造拼凑）；必须含关键字「×」；不得与本局已出句重复；难度随回合渐进（冷门句优先在后半程出）。
- **主进程校验**：返回后 `fushiNorm(line)` 查含字 + 对 `usedLines` 查重；不合格内部重试 ≤2 次；三次均不合格返回 `{ giveUp: true }`（渲染层据此判我胜——AI 接不上）。`history` 只传逐句 `line` 文本（讲解不回注，控 token）。

### 3.2 斗诗 `doushiCompose(topic, genre, signal)` 与 `doushiJudge(topic, genre, myPoem, aiPoem, signal)`

- compose：按主题体裁作诗一首，返回纯文本（现代诗可多节，近体诗须守句数与对仗常规；不强求平仄全合但明显出律处避免），scene `fushi:doushi`，temperature 0.8。
- judge：JSON `{ "scores": {"cut": n, "meter": n, "imagery": n, "mood": n}, "total_comment": "总评", "verdict": "win|lose|draw" }`——四维各 10 分制（切题/格律/意象/意境），verdict 我方视角，平局允许；点评须双方对照着说、先总后分，近体诗给平仄硬伤提示。scene 同上，temperature 0.3。
- 主进程 `doushiSubmit` 串行两调用（compose → judge），一次 IPC 返回全部结果。

### 3.3 诗词 Copilot `fushiCopilot(id, action, selection, signal)`

- 六动作：`draft`（立意方向 + 开头建议）/ `continue`（续写）/ `polish` / `rewrite`（选中段）/ `duiju`（对句：选中句为上句出下句候选 3 个，或正文末句为上句）/ `gelo`（格律点评：全文平仄 / 押韵 / 对仗审查 + 修改建议；modern/free 只给节奏与意象建议）。返回纯文本建议（markdown 片段），建议卡渲染 MdView。
- 上下文：从 `fushi_poems.md_path` 读全文 + title/genre + `profileDigest()`；温度 draft/continue/duiju 0.7，polish/rewrite/gelo 0.4（copilotWriting 同档）。
- 与 `wenbi:copilot`（copilotWriting）**独立函数不合并**——诗体 prompt 差异大，共享的只有模式。

## 4. IPC / preload / 类型

主进程 `electron/ipc.ts` 新增通道（命名 `fushi:*`；jobId 首参的均为 AI 通道，`beginJob/ai.cancel` 接入）：

| 通道 | 签名 | 说明 |
|---|---|---|
| `fushi:daily` | `()` → `{ date, keyword, done, streak, todayGameId }` | ensureFushiDaily 后读；todayGameId=当日 daily 局 id（回看用） |
| `fushi:feihuaTurn` | `(jobId, keyword, usedLines: string[])` → `{ line, note } \| { giveUp: true }` | AI 出句 + 主进程校验重试 |
| `fushi:feihuaEnd` | `(keyword, daily, result, rounds, lines: { side: 'me'\|'ai', line, note? }[])` → `gameId` | 终局落库两步（INSERT→写 md→UPDATE path）+ daily 局回写 done=1 |
| `fushi:doushiNew` | `(jobId)` → `{ topic, genre }` | AI 出题（主题 4–8 字 + GENRE_ZH 四选一） |
| `fushi:doushiSubmit` | `(jobId, topic, genre, myPoem)` → `{ gameId, aiPoem, scores, totalComment, verdict }` | 串行 compose→judge→落库留档（result 判定：win=myPoem 胜） |
| `fushi:games` | `(type?: 'feihua'\|'doushi')` → `FushiGameRow[]` | 历史列表（deleted_at IS NULL，id 倒序） |
| `fushi:gameDelete` | `(id)` → `true` | discardToRecycle('fushi_game', id) |
| `fushi:poems` | `(genre?: string)` → `FushiPoemRow[]` | 诗集列表 |
| `fushi:poemAdd` | `(title, genre, content?)` → `id` | content 缺省写占位「（双击编辑开始创作）」 |
| `fushi:poemDelete` | `(id)` → `true` | discardToRecycle('fushi_poem', id) |
| `fushi:copilot` | `(jobId, id, action, selection?)` → `string` | §3.3；LLM 未配置抛 LLM_NOT_CONFIGURED |

- preload `window.api.fushi` 命名空间 + `src/renderer/api.d.ts` 同步；`src/shared/types.ts` 新增 `FushiGameRow` / `FushiPoemRow` / `FushiDailyView` / `Genre` / `GameResult` 等接口与 `GENRE_ZH` 渲染层副本（或经主进程返回中文名，实施取一处为准）。
- 全部列表/详情读取通道渲染层 catch 兜底（逐块独立 catch 惯例）。

## 5. 回收站

- `electron/services/recycle.ts`：`RecycleSource` 联合增 `fushi_poem` / `fushi_game`；`SOURCE_TABLE` 映射两表；`restore` 分支——poem 置 `deleted_at=NULL`、game 同；两表均有 `md_path` 列，hardDelete 走 MD_FIELDS 通用路径连 md 删除（无特判）。
- 回收站 UI「赋诗苑」块：两来源混放，条目副行标「诗集 / 飞花令 / 斗诗台」（按 game.type 细分）；恢复回原页签列表。
- `src/shared/types.ts` RecycleItem source 联合同步两值。

## 6. 接线

- `src/App.tsx`：MODULES `fushi` 行删 `pending: true`；keep-alive 视图映射挂 `FushiModule`（懒加载惯例照其它模块）；占位点击提示逻辑自然失效。
- `src/shared/types.ts`：ModuleId 联合若 'fushi' 未在正式视图中注册则补（现仅占位注释）。
- scheduler 午夜 + main.ts 启动延迟：追加 `ensureFushiDaily()`（与 ensureInterviewDaily 并列）。
- 总导览：`HeatmapCard.tsx` 色阶五档适配（§1）；悬停明细加「飞花令」。
- LLM 场景标签三处（§0）。

## 7. 边界与不变式

- **判字永远是本地规则**：AI 不参与飞花令胜负判定（含字校验、查重、判负路径全部确定性代码）；AI 只出句与讲解。
- **打卡只认每日局**：`fushi_games.daily=1` 是唯一 done 触发源；自由局无论如何不写打卡。
- **对局不续玩**：过程态只存渲染层；中断（关模块/关 App）即弃局，不留档不计打卡——飞花令单局时长短，不照搬海龟汤续玩机制。
- **零 AI 自留地边界**：本模块无此设定（全模块 AI 参与是特性）；但 copilot/斗诗上下文**只读 fushi 两表与画像**，不读取浮生记等私密数据。
- md 弹窗 copilot 扩展位为通用回调槽：其他模块未来可复用，本次仅诗集传入。

## 8. 验收清单（人工冒烟）

1. 左栏生活模式出现赋诗苑正式项（非置灰），三页签切换顺畅、默认飞花令。
2. 每日一令卡显示今日关键字与连胜；开局 → 与 AI 对句多轮：我出不含关键字句被行内拦截不计回合；重复句被拦截；AI 出句均含关键字不重复；点「我接不上了」判负并留档、当日卡变「已打卡 · 负」。
3. AI 连续接不上判我胜路径（可用极生僻字如「鼋」触发 giveUp 验证）。
4. 自由局玩完不改变打卡与连胜；中断（切模块再回/重启）对局消失、当日卡仍「未开局」可重开。
5. 斗诗：新斗诗出题 → 我提交 → AI 作品与四维评分、总评、胜负出现；「存入诗集」后诗集出现该诗（标题=主题、体裁正确）；留档 md 双方诗与点评齐全。
6. 诗集：新作（autoEdit 直达编辑态）、copilot 六动作建议卡出卡/采纳/放弃/重新生成、对句与格律点评诗词特化生效；双击编辑保存后列表更新时间刷新。
7. 删除诗作/对局 → 二次确认 → 回收站「赋诗苑」块可见且标注来源页签；恢复回原位；彻底删连 md 消失（查 userData md/fushi/ 目录）。
8. 总导览热力图：飞花令打卡当日变色、level 上限 4；悬停明细含飞花令。
9. LLM 未配置（临时清空配置）：对局/copilot/斗诗按钮点击弹去配置；每日卡/连胜/热力图/历史列表正常显示。
10. `npm run typecheck` 双配置通过；重启 dev 触发 v55 迁移无报错。
