# 娱乐城 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/生活模块/娱乐城/design.md`（260925 开发者会话内逐段审核通过）生成，是开发的直接依据。依赖：样式/designs-specs.md（MdDialog / MdView / ConfirmDialog / Toast 与主题色系约束）、回收站接入约定（source 映射与 md 连带删除）、致知己 profileDigest 画像注入惯例。
>
> **DB 版本基线**：260925 当日 `user_version` 已至 **v54**；娱乐城新表自 **v56** 起——**v55 已被并行会话赋诗苑 specs 预留**（260925 播客台落地时因 v54 被占而顺延改定）。若落地时版本再被其他模块占用，按实际顺延，本节表结构不变。
>
> **v1.0 实施注记（260925 落地时修订三处）**：① DB 版本再顺延——v55 赋诗苑、v56 副本库同日落码，娱乐城四表实落 **v57**；② 德扑引擎落位由 `electron/services/poker/engine.ts` 改 **`src/modules/yule/poker/engine.ts`**（纯函数不碰 DB/IPC，逐手交互推进在渲染层更简，主进程无需引用；快照仍经 IPC 存库，specs §3 序列化口径不变）；③ AI 调用按仓库实况惯例为**一次性返回 + jobId 取消**（specs 原写「流式」系笔误，推理角同款实为一次性；生成中均有 busy 态提示）。
>
> **260926 麻将房增补注记**：开发者审核通过 design.md「板块 D · 麻将房（灵溪麻将）」后增补本文件 **§9–§16**。模块页签由三改四（`taro | poker | blackjack | mahjong`），本文 §0/§2 中「三页签」等表述为 v1 落地时状态，麻将房一律以 §9 起为准；新表 **DB v61**（v60 已被同日播客台删除墓碑占用，见 §10 版本注记）；实施拆三阶段见 §16。
>
> **260926 德扑修复与交互增强注记**：引擎修三处——①**行动权推进缺失**（原 `syncAwaiting` 只校验不推进 `toAct`，每条街仅一人行动一次、其余人整手无操作；新增 `advanceTurn` 于每次行动后移交给下一位待行动者，「加注重开行动」口径不变）；②**单挑翻前首行动**改由 BB 实际座位找下家（庄家/SB 先动，不假设座位相邻）；③**幽灵底池**（`finishHand` 结清时归零全员 `bet/totalBet`——出局者残留 totalBet 曾被弃牌局/摊牌按 ΣtotalBet 重复发放）。另：全下跑马改逐街发牌（160ms 节拍逐步揭牌）+ `notice` 提示条说明无下注环节。渲染层 PokerPane：座位动作标签（过牌/跟注 X/下注 X/加注到 X/全下 X/弃牌，跨街保留）、行动者座位主题色描边、顶栏当前街名、「本手动态」流水、待行动提示（谁在行动/底池/需跟注）、加注提交前钳制本街合法区间、旧快照恢复 `normalizeState` 补新字段默认值；玩法弹窗补「全下跑马」与「界面说明」两节。验证：引擎 esbuild bundle + 临时仿真四组（首行动口径 / 30 局随机策略资金守恒与多动作街 / 200 手单挑流 / 20 局全下跑马压力）ALL PASS 后临时件已删。

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

## 9. 麻将房 · 命名与常量（260926 增）

- 页签 id `mahjong`，名「麻将房」，排 21 点之后（`YuleModule.tsx` 页签数组追加）。
- 规则蓝本：百度百科「灵溪麻将」词条全文（开发者确认为老家苍南打法，全量实现、无需修正）。
- 常量：`MAHJONG_CHIP_PER_TAI = 10`（1 台 = 10 筹码，v1 固定）；`ZHahu_PENALTY_TAI = 26`（诈胡罚 26 子 = 260 筹码）；一圈 = 每人坐庄两次（连庄同庄继续计数，全员庄次数 ≥2 即圈终，圈长 ≥8 局）；AI 行动假延时 ≈800ms；同时只允许一场 `playing` 圈。
- AI 昵称固定三选：**桥头王 / 阿灵 / 老算盘**（灵溪风味，非 emoji）；性格预设三档：**激进**（碰杠阈值低、防守系数低）/ **均衡** / **稳健**（防守优先、副露保守）。
- md 目录：`md/yule/mahjong/`（AI 讲牌 `{gameId}-explain.md`）。
- 回收站来源值：`yule_mahjong`（并入既有回收站「娱乐城」板块，不新增板块）。
- 画像口径：AI 讲牌**不注入** profileDigest（分析类，照德扑复盘口径）。
- 不新增 AI 边栏频道、settings key、定时任务。

## 10. 麻将房 · 数据表（DB v61）

> 版本注记（260926）：本节原规划 v60，同日播客台删除墓碑（`podcast_deleted_eps`）先落 v60，按撞车顺延惯例麻将房改 **v61**（specs §顶部「当前基线 v59」表述随之过时，以实际撞车顺延为准）。

```sql
CREATE TABLE mahjong_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'playing', -- playing | finished | abandoned
  round_count INTEGER NOT NULL DEFAULT 0, -- 已完成局数
  my_net INTEGER NOT NULL DEFAULT 0,      -- 我本圈已结算部分净收益（筹码）
  round_log TEXT NOT NULL DEFAULT '[]',   -- JSON 逐局流水：{round, dealerSeat, result(胡/流局/诈胡/杀猪),
                                          --   winSeat/fangpaoSeat, 各家 tai 明细与净变动, 特殊牌型标记}
  state TEXT,                             -- playing 时 = 引擎完整状态快照 JSON（中断续玩根基）
  started_at TEXT NOT NULL,
  ended_at TEXT,
  explain_md_path TEXT,                   -- AI 讲牌 md（圈终后按需生成）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

- v60 迁移同时：`initDb` 目录清单追加 `md/yule/mahjong`。
- 钱包复用 `yule_wallet` 单行；**每局结算独立事务**（余额 ±我方净变动 + `round_log` 追加 + `my_net` 累加同一事务），禁止渲染层拼装余额回写；`finishRound` 以 `(gameId, round)` 幂等（重复回调直接返回已结算结果）。

## 11. 麻将房 · 规则引擎（src/modules/yule/mahjong/engine.ts，渲染层纯 TS，不碰 DB/IPC）

### 11.1 牌模型与开局

- 牌 id 字符串：`W1..W9`（万）/`T1..T9`（筒）/`S1..S9`（索）各 ×4；`EF/SF/WF/NF`（东南西北风）各 ×4；`RZ/FC/BB`（中发白）各 ×4；`F1..F8`（春夏秋冬梅兰菊竹）各 ×1；共 144 张。分类工具：序数牌（W/T/S）、字牌（风+中发）、花牌（F1-F8）；**白板 BB 属字牌但走补花**。
- 开局：掷骰两次定庄与拿牌方位（头家先掷，2/5/6/10 南家二掷、3/7/11 西家二掷、4/8/9/12 北家二掷，两次和数从方位家牌墙右起数墩；**定位墩两张亮出即财神，亮出后放回原墩**——即全场与财神同面的牌皆为财神。此口径由百科「杀猪胡…五个财神 +26、六个 +52」条目反推锁定：仅当同面 4 张全部流通才可能手持 5-6 财神）。庄 17 张、闲 16 张（每人依次 2 墩轮拿）→ **庄先抓第 17 张（头牌），再开始全员补花**。
- 补花：庄起逆时针，亮出手中全部花牌/白板，从牌墙尾部依次补 1 换 1；补进又得花/白板，等本轮全员补完再补；**起手 4 同花（或 4 白板）作暗杠，只补 1 张**。补花区（显示牌）每家公开横排。
- 财神规则：可代替**除花牌与白板外**任意牌；不可吃、不可碰、不可杠、不可打出；花/白板面的财神不可补花（留在手中只计台）。

### 11.2 行牌状态机

- 状态：`dealing → flowerFix → turn{ draw → act → claim } → roundEnd → (settle) → 下一局 …`；`act`（持牌者）：打出 / 暗杠 / 补杠 / 宣言杀猪 / 自摸胡；`claim`（响应窗，打出后）：**胡 > 碰/杠 > 吃**（吃仅下家，多候选弹选择）；多家胡按放炮者座次顺延第一位，**财神单钓者让胡**（其听牌任牌可胡，不具截胡优先权）；AI 补杠时开抢杠响应窗。
- 流局：可摸张数 ≤ `20 + 2×全场杠数`（剩 10 墩、每杠 +1 墩）即流局，全 0 台；**末 4 张**（可摸 ≤4 时摸进的牌）不许打出、不补花、不暗杠/补杠。
- 杠：明杠（碰后补杠 / 打出直杠）、暗杠，杠补牌从牌墙尾摸（杠上开花判定基于此）；补杠牌可被抢杠胡。
- 特殊胜负：**杀猪**（手持 3 同面财神 + 1 异面财神；开牌双财神时改持 2 财神）→ 轮到自己出牌时可宣言，无视牌型 13 台、他家本局计 0；**花胡**（集齐 8 花牌，补花区）无视牌型 52 台；他家 0 台同理；诈胡判定（推倒喊胡无牌型 / 打财神花白板 / 财神吃碰 / 相公 / 花白板未补 / 碰后打同张）：罚 260 筹码给其余三家各一份（庄家 ×2），诈胡者本局禁吃碰胡、计 0 台、可杠。
- 快照安全点：每次进入玩家输入等待前（轮到我 act 前、claim 窗弹出前、AI 连续行动每步后）序列化全状态落库。

### 11.3 胡牌判定与台数计算

- 胡牌型 `AA + m×AAA + n×ABC`（m/n 可为 0），财神作万能牌的**全分解枚举**（memo 化搜索，财神枚举代入 + 保留原面两种用法），**多分解各算台数取最大**（百科口径）。
- 基本台（全员计，含未胡）：① 本风位刻 1 台、字牌刻 1 台；② 序数牌明杠 3/暗杠 4，风位或字牌杠额外 +1；③ 补花区：同种花/白板 1/2/3 个 = 1/3/5 台，4 个视杠（起手齐 4=暗杠 13 台、后集齐=明杠 10 台）；④ 手持财神：序数牌面 1/2/3 张 = 2/5/8 台，字风花面 = 3/7/11 台；⑤ 开牌双财神：该面 1 张 7 台、2 张 15 台（替代 ④ 该面口径）；⑥ 未胡家：财神与单张/一对本位风或字牌成刻 → +1 台（不重复计）。
- 附加台（仅胡家，符合即叠）：自摸+1；杠开+3（不计自摸；杠补花牌再补花而胡不算）；抢杠+3；海底+3（可摸 ≤4 时摸胡，不计自摸）；混一色+7；对对胡+7；清一色+13；硬打硬+7（无财神）；财神汇+7（3 张财神未作替代入型）；单钓将：钓财神+7 / 钓他牌+13；四风齐+13（≥3 风刻/杠 + 第四风对，或四风全刻/杠；财神代风须当风本身用）；平胡 13（无刻无杠、无花白板财神）；天胡+13（庄补花毕即胡）；地胡+13（庄第一张打出即胡）；杀猪 13（无视牌型）；杀猪胡 +13/五财神+26/六财神+52；花胡 52（无视牌型；集齐 8 花而常规型也胡 → +52）。
- 翻倍：胡家累计 ≥13 台 → ×2；未胡家一律不翻。**财神汇截胡宣言限制不做**（口头默契机判不可行，财神汇台数照算，spec 显式豁免）。

### 11.4 结算（局终自动，明细弹窗确认后落钱包）

- 胡牌局：胡家向三家各收 `台数×10` 筹码；未胡三家两两台差结算（差值×10，少者付多者）；**庄家收付一律 ×2**；**四风齐包赔**：放炮者替另两家向胡家支付全额。
- 杀猪/花胡局：按 13/52 台走胡牌结算，其余三家基本台计 0、不做台差。
- 诈胡局：诈胡者向三家各付 260（庄 ×2），其余不算台差；流局全 0。
- 单局结算明细弹窗：4 家 × 台数构成/翻倍/净变动表格 + 我方钱包余额变化；AI 家只计圈内虚拟积分（结算榜显示用），不持有筹码余额。

### 11.5 AI 对手（本地启发式，零 LLM）

- 决策输入 = 快照 + 性格参数，输出 = 动作；核心：**向听数近似计算**（财神逐张代入补缺，memo 化搜索）+ 舍牌评分（向听推进 + 危险度 + 台数潜力：保留字风刻潜力、硬打硬/清一色方向感知）。
- 副露决策：碰/杠/吃按「向听推进 ≥1 或大牌方向成型」阈值；防守 = 他家副露花色推断 + 生张危险度 + 局势系数（他家大副露/多杠转扣牌），性格参数调制阈值；财神永不打出；响应窗 800ms 假延时。
- 杀猪/花胡达成时 AI 立即宣言；财神单钓让胡规则同样约束 AI。

## 12. 麻将房 · UI（MahjongPane）

- 两态照德扑结构：**大厅态**（规则简介卡：蓝本/单价/一圈口径 + 「开局」按钮 + 进行中恢复卡 + 圈战绩列表 + 「AI 讲牌」入口）与**牌桌态**。
- 牌桌态布局：顶部信息条（局号·庄标记 / 财神两张牌面 / 牌池剩墩 / 单价）；四方桌俯视——上/左/右 AI（昵称+性格徽标+庄标+补花区+副露+牌河+手牌数牌背），中央牌河；我方底部：补花区+副露+大牌横排手牌（摸牌位分隔、财神主题色高亮边+「财」角标）。
- 交互：我方回合操作条按合法性浮现 打出/暗杠/补杠/杀猪宣言/自摸胡；他家打牌后响应条浮现 胡/直杠/碰/吃/过，吃多候选行内选择条；出牌点选抬起再点出牌（防误触）；局终结算明细弹窗（§11.4）；圈终卡（积分榜/我的净收益/「AI 讲牌」+「再来一圈」）；「放弃本圈」二次确认（已结算不退，status=abandoned）。
- 牌面纯 CSS 组件 `MahjongTile`：白底圆角卡 + 数字/汉字（万筒索数字配色、风字花用汉字本体），边框与牌背纹样主题色系衍生，浅/深双主题适配；无 emoji、无图片素材；出牌飞入/摸牌滑入/胡牌高亮轻 CSS 动画。
- `HelpDialog` 增「麻将房」规则帮助页（财神/台数/翻倍/结算速查）。

## 13. 麻将房 · 服务层与 IPC（yule.ts 增 + `yule:mahjong:*`）

```
yule:mahjong:start                       → 校验无 playing 圈，建行返回 gameId
yule:mahjong:state                       → 取进行中圈（无则 null；恢复续玩）
yule:mahjong:saveState(state)            → 快照回写（安全点节流）
yule:mahjong:finishRound(gameId, round, settlement, jobId) → 单局结算事务（钱包 ±my_net + round_log 追加；幂等）
yule:mahjong:finish(gameId, summary)     → 圈终写终态（finished，ended_at/duration）
yule:mahjong:abandon(gameId)             → 放弃本圈（status=abandoned，已结算保留）
yule:mahjong:list / yule:mahjong:remove(id)
yule:mahjong:explain(gameId, jobId)      → 组装 round_log 调 mahjongExplain，写讲牌 md 回写 explain_md_path
```

- `preload.ts` / `src/renderer/api.d.ts` 同步暴露 `window.api.yule.mahjong.*`（照既有 yule 桥模式）。

## 14. 麻将房 · AI 讲牌（electron/ai/services.ts 增 `mahjongExplain`）

- 输入 = 圈摘要（局数/净收益/庄次）+ round_log 关键局节选（放炮局/被胡局/最大台数局/副露密集局的各家台数构成与结果）；输出 md——整体表现、2-3 个关键局复盘（当时牌面构成、台数账目、可选路线评述）、2-3 条改进建议；**一次性返回 + jobId 取消**（v1.0 注记③口径）；**不注入**画像。
- LLM 未配置：按钮不置灰，点击弹「去配置」；讲牌生成中 busy 态；生成失败 Toast 且不落 md。

## 15. 麻将房 · 回收站与文档同步

- 回收站来源 `yule_mahjong`（表 `mahjong_games`，md 连带字段 `explain_md_path`）：恢复清 `deleted_at`；彻底删连讲牌 md；二次确认；并入既有「娱乐城」板块（不新增侧栏块）；3 天自动清理照全局。
- 文档同步：README.md 娱乐城简介改四板块；`docs/log` 当日记一条。
- `src/shared/types.ts`：增 `MahjongGameRow` / 结算与快照视图类型（引擎状态类型从 engine.ts 导出复用）。

## 16. 麻将房 · 实施阶段与验收清单

- **阶段一**（先打起来）：§11.1–11.2 引擎核心（牌模型/掷骰开局/补花/行牌状态机/吃碰杠/流局/末 4 张）+ §12 牌桌态最小 UI（手牌/出牌/响应条/四座位/牌河）+ HelpDialog 规则页；AI 可用最简策略（暂不打台数）。
- **阶段二**（算得清钱）：§11.3 台数全套 + §11.4 结算 + §13 `finishRound` 钱包事务与幂等 + 结算明细弹窗；特殊牌型（杀猪/花胡/天胡地胡/包赔/诈胡）全量。
- **阶段三**（玩得下去）：§11.5 完整 AI（性格/防守/杀猪宣言）+ 快照续玩（§13 state 通道）+ 圈战绩/记录列表/回收站 + §14 AI 讲牌。
- 验收：
  - 开局掷骰/财神亮面/补花循环正确；庄 17 闲 16、庄先抓头牌再补花；四家起手花牌全数入补花区。
  - 行牌全流程：摸打循环、吃碰杠（含补杠抢杠响应窗）、胡>碰/杠>吃、截胡按座次、财神单钓让胡；末 4 张不打不补；流局线随杠数增长。
  - 台数抽查：自摸/杠开/混一色/对对胡/清一色/硬打硬/财神汇/单钓/四风齐/平胡/杀猪胡/花胡逐例核对 ≥13 翻倍；未胡家基本台与台差结算正确；庄家收付 ×2；包赔生效。
  - 诈胡三例（打财神/相公/推倒喊胡）各罚 260（庄 ×2）；杀猪宣言他家 0 台。
  - 钱包：单局结算落账、重复回调不重复扣；救济按钮照常可用。
  - AI 三性格行为可感知（稳健明显多防守）；杀猪/花胡达成 AI 会宣言。
  - 快照：局中关 App 重开续打；「放弃本圈」二次确认。
  - 讲牌：圈终生成 md 回看、LLM 未配置弹「去配置」、删除连带 md 入回收站「娱乐城」块。
  - `npm run typecheck` 与 `npm run build` 通过；浅/深双主题配色合规；三页签互切不打断牌局（keep-alive）。
