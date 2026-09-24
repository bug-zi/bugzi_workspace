# 娱乐城 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/生活模块/娱乐城/design.md`（260925 开发者会话内逐段审核通过）生成，是开发的直接依据。依赖：样式/designs-specs.md（MdDialog / MdView / ConfirmDialog / Toast 与主题色系约束）、回收站接入约定（source 映射与 md 连带删除）、致知己 profileDigest 画像注入惯例。
>
> **DB 版本基线**：260925 当日 `user_version` 已至 **v54**；娱乐城新表自 **v56** 起——**v55 已被并行会话赋诗苑 specs 预留**（260925 播客台落地时因 v54 被占而顺延改定）。若落地时版本再被其他模块占用，按实际顺延，本节表结构不变。
>
> **v1.0 实施注记（260925 落地时修订三处）**：① DB 版本再顺延——v55 赋诗苑、v56 副本库同日落码，娱乐城四表实落 **v57**；② 德扑引擎落位由 `electron/services/poker/engine.ts` 改 **`src/modules/yule/poker/engine.ts`**（纯函数不碰 DB/IPC，逐手交互推进在渲染层更简，主进程无需引用；快照仍经 IPC 存库，specs §3 序列化口径不变）；③ AI 调用按仓库实况惯例为**一次性返回 + jobId 取消**（specs 原写「流式」系笔误，推理角同款实为一次性；生成中均有 busy 态提示）。

## 0. 命名与常量

- 模块 id：`yule`；侧边栏名「娱乐城」；图标 Material Symbols `casino`；位置：生活区推理角与记账本之间（`src/App.tsx` MODULES 去 `pending: true`）。
- 模块内三页签（照 WikiModule 板块切换 chips 惯例）：`taro 塔罗 | poker 德扑 | blackjack 21点`，默认塔罗，页签选择不持久化。
- 钱包常量：`INITIAL_WALLET = 5000`（首次进入赠送）；`RELIEF_AMOUNT = 2000`；`RELIEF_THRESHOLD = 1000`（余额低于此值可领）；救济每日限一次（本地日期 `YYYY-MM-DD` 比较）。
- 德扑常量：`BUY_IN = 1000`；`START_STACK = 1000`；盲注 10/20 起、**每 8 手翻倍**；奖池 `PRIZE = [2000, 1200, 800, 0]`（名次 1-4，无抽水）；AI 行动假延时 ≈800ms；同时只允许一场 `playing` 局。
- 21 点常量：4 副牌靴、剩余约 25% 时重洗；Blackjack 赔 3:2；庄家软 17 停；玩家可 要牌(hit) / 停牌(stand) / 加倍(double)；保险与分牌不做（v2）。
- 塔罗牌阵：`single`（单张·每日指引）/ `three`（三张·过去-现在-未来）；凯尔特十字进 v2。
- md 目录：`md/yule/taro/`（塔罗解读 `{recordId}.md`）、`md/yule/poker/`（AI 复盘 `{gameId}-review.md`）。
- 回收站来源值：`yule_taro` / `yule_poker`（同属回收站「娱乐城」板块）。
- AI 边栏**不新增频道**（照推理角 v1 口径：玩法在主栏）；不新增 settings key；不新增定时任务。
- 画像注入口径：塔罗解读**注入** profileDigest（个性化解读类）；德扑 AI 复盘**不注入**（分析类）。
- 21 点战绩、钱包：聚合/单行数据，不可删、不进回收站。

## 1. 数据表（DB v56）

```sql
CREATE TABLE yule_wallet (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  balance INTEGER NOT NULL,          -- 筹码余额（整数，不存分/小数）
  relief_date TEXT,                  -- 最近一次领救济的本地日期 YYYY-MM-DD
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE taro_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spread TEXT NOT NULL,              -- single | three
  question TEXT NOT NULL DEFAULT '', -- 所问之事（可空）
  cards TEXT NOT NULL,               -- JSON [{name, nameZh, upright, position}]
                                     -- name=牌英文名/序号，nameZh=中文名，upright=是否正位，position=牌位中文（如「过去」）
  md_path TEXT NOT NULL,             -- 解读全文 md
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE poker_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'playing', -- playing | finished | abandoned
  my_rank INTEGER,                   -- 1..4；abandoned 固定 4
  prize INTEGER NOT NULL DEFAULT 0,  -- 返入钱包的奖励（abandoned=0）
  hands_count INTEGER NOT NULL DEFAULT 0,
  hand_log TEXT NOT NULL DEFAULT '[]', -- JSON 每手流水（手号/盲注/我的底牌/关键行动/结果/我的净变动）
  state TEXT,                        -- playing 时 = 桌面完整状态快照 JSON（中断续玩根基）
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  review_md_path TEXT,               -- AI 复盘 md（可空，终局后按需生成）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE blackjack_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hands INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  pushes INTEGER NOT NULL DEFAULT 0, -- 平局
  net INTEGER NOT NULL DEFAULT 0,    -- 净收益（筹码）
  updated_at TEXT NOT NULL
);
```

- v56 迁移同时：`initDb` 目录清单追加 `md/yule/taro`、`md/yule/poker`。
- 钱包与 21 点战绩均为**单行惰性创建**：首次读取无行则插入初始值（钱包 5000 / 战绩全 0）。
- 塔罗 78 张牌表（英文名/中文名/大小阿卡纳序号）为前端常量 `src/modules/yule/taro/cards.ts`，**不内置牌意文案**（牌意由 LLM 自身知识生成，prompt 只传牌名 + 正逆位 + 牌位）。
- 筹码只以整数流转；钱包余额变动必须发生在服务层事务内（21 点每手结算、德扑扣买入/发奖各自一个事务，禁止渲染层拼装余额回写）。

## 2. 模块本体（src/modules/yule/）

- `YuleModule.tsx`：三页签 chips + 模块头右侧**钱包角标**（Material Symbols 筹码图标 + 余额数字，三页签共用常驻）；余额 < `RELIEF_THRESHOLD` 时角标旁出「领救济」按钮（点击调 `wallet:relief`，成功 Toast，当日已领置灰文案「今日已领」）。页签切换不卸载各页签内部 state（对局进行中切走切回不丢）。
- `taro/`：`TaroPane.tsx`（牌阵选择卡 + 所问之事输入 + 牌堆抽牌 + 逐张翻牌 CSS 动画 + 摆阵区 + 「AI 解读」流式 MdView + 记录列表）；`cards.ts`（78 张牌常量 + 牌阵定义：单张牌位「指引」，三张牌位「过去/现在/未来」）。牌背用主题色系纹样，禁止 emoji 花色，花色符号用 Unicode ♠♥♦♣（文本符号非 emoji）。
- `poker/`：`PokerPane.tsx` 两态——**大厅态**（买入卡：买入额/盲注结构/奖励表 + 「开局」按钮 + 进行中恢复卡 + 记录列表）与**牌桌态**（椭圆牌桌、四座位含 AI 昵称与筹码量、庄钮 D 标识、公共牌五格、底池、我的底牌大图、行动条：弃牌/过牌/跟注/加注[滑条 + ½池/满池/全下快捷]/全下）；局终结算卡（名次/奖励/用时/手数 + 「AI 复盘」按钮）。
- `blackjack/`：`BlackjackPane.tsx`（下注快捷筹码按钮 + 庄/闲牌面 + 操作条：要牌/停牌/加倍 + 结算横幅 + 战绩统计卡：总手数/胜率/净收益）。
- 视觉硬性规则：无 emoji 图标（fonts.google.com Material Symbols）；牌桌绿毡感/卡牌/按钮配色由主题色系衍生（浅色粉系/深色宝蓝系），禁彩亮饱和色。

## 3. 服务层与德扑引擎（electron/services/）

- `yule.ts`：钱包读取/救济（校验余额阈值 + `relief_date !== today`，写 `relief_date`）；塔罗记录建/列/删（md 文件写入用户数据目录）；德扑开局（事务：扣买入 1000 + 建 `playing` 行）/ 状态快照保存 / 终局结算（事务：按 `my_rank` 发奖入钱包 + 写终态）/ 弃赛（`my_rank=4`、prize 0）/ 记录列表；21 点每手结算（事务：余额 ±净变动 + `blackjack_stats` 同事务累加）。
- `poker/engine.ts`（**纯函数核心**，不碰 DB/IPC）：洗牌发牌、盲注位轮转、7 选 5 手牌评估、边池简化口径（全下超额部分按比例回退，单桌 4 人场景实现按标准边池规则）、街结算；`serialize/deserialize` 全状态快照（引擎可整局无副作用推进，UI 每步渲染快照）。AI 决策函数输入 = 快照 + 性格参数，输出 = 动作；决策依据 = 简化手牌强度（翻前 Chen 公式 / 翻后成牌等级）+ 底池赔率 + 位置系数 + 少量随机扰动。
- AI 对手三性格预设（常量参数对象，座位随机分配）：**紧凶**（进池范围窄、加注果断、少诈唬）/ **松凶**（进池宽、诈唬频率高、爱加注）/ **跟注站**（进池宽、几乎不弃牌、极少加注）。昵称固定三选：如「老K」「半仙」「铁跟」，中文名非 emoji。

## 4. AI 服务（electron/ai/services.ts 新增两函数）

- `taroInterpret`：输入 = profileDigest + 所问之事 + 牌阵 + 每张牌（牌位中文/牌名/正逆位）；输出 md——逐张解读（牌位语境 + 正逆位牌意 + 与所问之事的勾连）+ 整体综合 + 一句可执行建议；**流式**返回（照推理角同款流式调用惯例）。
- `pokerReview`：输入 = 名次/盈亏/手数 + `hand_log` 关键手节选；输出 md——整体表现、2-3 个关键决策点复盘（该时刻的信息与选项、我的选择的期望值评述）、改进建议；**不注入**画像；流式。
- LLM 未配置：塔罗「AI 解读」、德扑「AI 复盘」按钮不置灰，点击弹「去配置」直达个人档（全局规则）；德扑牌桌与 21 点本体零 LLM 照常可玩。

## 5. IPC（`yule:wallet:*` / `yule:taro:*` / `yule:poker:*` / `yule:blackjack:*`）

```
yule:wallet:get                        → { balance, reliefAvailable, reliefAmount, threshold }
yule:wallet:relief                     → 领救济（校验失败返回明确错误文案）
yule:taro:save(input)                  → 建记录 + 写 md（解读完成后渲染层调用）
yule:taro:list / yule:taro:remove(id)  → 列表 / 移入回收站
yule:poker:start                       → 校验余额≥1000、扣买入、建 playing 局，返回初始快照
yule:poker:state                       → 取进行中局（无则 null，恢复续玩用）
yule:poker:saveState(state)            → 渲染层每步推进后回写快照（节流）
yule:poker:finish(rank, handLog, …)    → 终局结算：发奖入钱包 + 写终态（事务）
yule:poker:abandon                     → 弃赛：rank=4 / prize=0 / status=abandoned
yule:poker:list / yule:poker:remove(id)
yule:poker:review(gameId)              → 组装 hand_log 调 pokerReview，写复盘 md 回写 review_md_path
yule:blackjack:settle(bet, result, net)→ 每手结算事务（余额 + 战绩）
yule:blackjack:stats                   → 战绩聚合读取
```

- `preload.ts` / `src/renderer/api.d.ts` 同步暴露 `window.api.yule.*` 桥（照 ledger 模块接线模式）。

## 6. 回收站接入

- 新来源值：`yule_taro`（表 `taro_records`，md 连带字段 `md_path`）、`yule_poker`（表 `poker_games`，md 连带字段 `review_md_path`——终局对局的手牌流水在行内 JSON，不随删）。
- 恢复：清 `deleted_at` 回记录列表（照「回来源模块最初级区」口径）；彻底删：连 md 文件一并删。
- 回收站侧栏新增「娱乐城」板块（排在「推理角」之后）；3 天自动彻底清理照全局机制。
- 21 点战绩、钱包不进回收站；塔罗/德扑删除均二次确认（全局硬性规则）。

## 7. 渲染层接线与文档同步

- `src/shared/types.ts`：`ModuleId` 增 `'yule'` 正式视图（移出占位注释行，占位清单剩 播客台/副本库/赋诗苑）。
- `src/App.tsx`：MODULES 该行去 `pending: true`；主栏 keep-alive 挂载 `YuleModule`（照 pending→正式接线模式，如记账本）。
- README.md 与 `docs/project/左侧边栏/侧边栏模块布局.md` 同步：娱乐城去「占位」标注、补模块简介一句话。

## 8. 验收清单

- 三页签切换流畅、钱包角标三页签常驻、余额显示正确；首次进入赠送 5000。
- 救济：余额 <1000 时按钮出现，领 2000 成功；当日再点提示已领；次日可再领；余额充足时无按钮。
- 塔罗：单张/三张抽牌与逐张翻牌动画；AI 解读流式渲染；解读自动入库，记录列表弹全局 md 弹窗回看；删除二次确认入回收站「娱乐城」块；LLM 未配置时解读按钮弹「去配置」。
- 德扑：开局扣 1000；完整对局流程（盲注轮转/四街发牌/行动条各操作/摊牌比牌/筹码归零淘汰）；AI 三性格行为可感知（跟注站几乎不弃牌等）；终局按名次发奖回钱包；重启 App 续打进行中局；弃赛二次确认记第 4 名；记录列表 + AI 复盘 md 生成与回看；复盘删除连带 md 入回收站。
- 21 点：下注/要牌/停牌/加倍全流程；Blackjack 3:2、庄软 17 停；每手钱包即时结算、战绩累计正确；牌靴剩约 25% 重洗；未结算退出退回注额。
- 回收站「娱乐城」块恢复/彻底删（md 连带）；3 天自动清理生效。
- `npm run typecheck` 与 `npm run build` 通过；浅/深双主题下牌桌、卡牌、弹窗配色符合主题色系硬性规则。
- 左栏娱乐城不再置灰、点击进模块；播客台/副本库/赋诗苑占位不受影响。
