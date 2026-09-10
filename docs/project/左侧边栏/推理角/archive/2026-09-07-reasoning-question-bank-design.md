# 设计：推理角题库预生成——海龟汤 + 每日一题 + 练习场（优化建议区第 21 轮）

- **状态**：已实施（260909，v1.8 版本注见 designs-specs.md；三处实施适配——DB 版本顺延为 v26、wall_pool 增 title 列、练习场取池题并轨生成即入 wall_bank 口径）。待冒烟验证后移入 `archive/`。
- **日期**：2026-09-07（260907）
- **来源**：`docs/project/优化建议区.md` 待完成条目「推理角——海龟汤和每日谜题让AI临时生成不太好……大概每次预存10道海龟汤10道谜题，从题库中抽出后，看情况AI自行在后台补充题目」
- **流程**：brainstorming——开发者逐项确认（范围 → 触发时机 → 方案 → 设计三节），260907 会话内批准后实施
- **规模**：1 新表（DB v14）+ 1 新服务文件 + 4 文件改道/接线，无新 UI 组件、无 settings key、无定时任务

## 背景与痛点

推理角（260906/07 建成，DB v13）三处取题依赖 AI 临时生成，用户要等：

| 场景 | 现状 | 痛点 |
| --- | --- | --- |
| 海龟汤「来 3 碗汤」 | 前台单趟 LLM 生成 3 碗入 `turtle_soups` | 汤库没货时必须等一批才能玩 |
| 思维墙每日一题 | 「打开现出」——每天首进板块 `wall:ensureToday` 现场两阶段出题（出题 0.9 + 审题 0.2，重试最多 4 趟） | 每天必等一次，等待最长 |
| 练习场「来一道」 | 每次点都现场两阶段出题（入会话内存 `practiceBank`） | 每次都等 |

关键观察：**汤库本身已是持久题库**（`turtle_soups` 中 fresh 状态即存货），缺的只是「后台自动补货」；**每日一题没有任何库存概念**（`wall_puzzles` 按 date 一天一行），需要新增预生成池。

## 已确认的关键决策

| 决策点 | 结论 |
| --- | --- |
| 覆盖范围 | **三处一并题库化**（汤库 + 每日一题 + 练习场）——练习场等待最长，一并纳入体验统一（开发者选定） |
| 补充触发时机 | **启动 + 消耗后 + 进入模块**三处触发，存量低于低水位即后台补到目标值；保留手动按钮兜底（开发者选定） |
| 架构方案 | **方案一：持久预生成池 + 主进程补充泵**（方案二会话内存、方案三纯定时均已否决） |
| 存量参数 | 汤库目标 10 / 低水位 5；题池目标 10 / 低水位 5；常量写死不进 settings（YAGNI） |
| 池空兜底 | 现场生成兜底（现有两阶段管线原样保留），玩法永不卡死 |
| 「来 3 碗汤」按钮 | 保留原样——从唯一途径退居手动补充（带难度偏好 + 前台 loading），与泵并发最多多出 3 碗，无碍 |
| 玩法逻辑 | 难度连胜推导、题型轮换（避近 2 日）、三级提示、避免清单全部保留——只是把「出题」提前到补充泵 |

## 数据模型（DB v14）

新表 `wall_pool`——每日一题/练习场共用的预生成题池：

```sql
CREATE TABLE wall_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  puzzle_text TEXT NOT NULL,          -- 题面
  answer_standard TEXT NOT NULL,      -- 标准结论
  standard_reasoning TEXT NOT NULL,   -- 标准论证（判答讲解用，照 v13 口径）
  hints TEXT NOT NULL DEFAULT '[]',   -- 三级提示 JSON（出题时一次生成）
  puzzle_type TEXT NOT NULL,          -- insight_invariant | strategy_protocol | counter_probability
  difficulty TEXT NOT NULL,           -- easy | medium | hard
  created_at TEXT NOT NULL
);
```

- 池是**未消费的储备**：无 `deleted_at`、不进回收站、无删除入口；被取走即转正（每日题）或消耗（练习场）。
- 汤库**零新表**：fresh 汤即存货。
- 存量口径：汤库存量 = `turtle_soups` 中 `status='fresh' AND deleted_at IS NULL` 行数（回收站软删的不算）；题池存量 = `wall_pool` 行数。
- 新表空起，无数据迁移负担，首填由泵完成。

## 补充泵（新文件 `electron/services/reasoningStock.ts`，仿 scheduler.ts 惯例）

```ts
export async function ensureReasoningStock(): Promise<void>  // 全部调用点 fire-and-forget（void 调用），永不抛错
```

- **单例 `pumping` 标志**防并发重入（含与手动「来 3 碗汤」并发的场景——手动入口不经泵，各自独立插库，最坏多 3 碗，可接受）。
- **汤侧**：fresh 存量 < 5 → 循环调既有 `generateSoups('random')`（每批 3 碗、难度错开）直到 ≥ 10。`generateSoups` 零改动——其内部近 200 碗避免清单天然覆盖全部 fresh 存货。
- **题侧**：池数 < 5 → 循环调既有 `generateWallPuzzle(difficulty, { type, avoid })` 逐道入池直到 ≥ 10：
  - **难度 = 池内数量最稀缺档**（并列随机）——保证连胜升到任何档位都有货；
  - **题型 = 池内 + 近 2 日历史合计最少见的题型**——保持池内题型多样；
  - **avoid = 近 20 题 `wall_puzzles` 题面摘要 + 池内全部题面摘要**（防池内互相同构；池 ≤ 10 道 × 60 字，prompt 长度无虞）。
- 单批失败（含 LLM 未配置抛 `LLM_NOT_CONFIGURED`）catch 记 console.warn 跳出，下次触发再补——**泵永不抛错、永不弹窗**（同 scheduler 静默惯例）。
- 每补完一批推 `reasoning:stockChanged` 事件（照 `recycle:changed` 模式），渲染层渐进刷新。
- 画像注入口径不变：泵调的正是出题类函数（注入），判答/点评不注入。

**三个触发点**：

1. `main.ts` 启动后**延迟 10s** 跑一次（错开启动高峰，`unref`）；
2. 每次消耗后 fire-and-forget：每日题转正后、练习场取题后、点汤**开新局**后（fresh−1；续局不触发，终局不减 fresh 不触发）；
3. 进入推理角模块时：渲染层在现有模块激活回调里加调新 IPC `reasoning:stockCheck`（覆盖「LLM 事后才配置好」场景）。

## 取题链路

### 每日一题 `wall:ensureToday` 改道

- 当日已有行 → 原样返回（不变）。
- 无行 → **从池中选**，四级放宽：
  1. 难度 = 连胜推导档 **且** 题型 ∉ 近 2 日 → 池内随机；
  2. 仅按难度匹配；
  3. 池内任意一道；
  4. 池空 → **兜底现场两阶段生成**（现有管线原样，「出题中…」loading 仅此场景出现）。
- 池命中 → 转正 = 同事务（BEGIN…COMMIT）`INSERT INTO wall_puzzles`（date=今天，题面/答案/论证/提示/题型/难度全量来自池行）+ `DELETE` 池行 → 返回。**全程零 LLM 调用，秒开**。
- 取题后（含兜底路径）`void ensureReasoningStock()`。

### 练习场 `wall:practiceNew` 改道

- 按难度/题型下拉筛选（随机=不限）→ 池中随机取一道 → DELETE 池行 → 进现有 `practiceBank` 会话内存（结构、容量 10、重启即清口径全不变，取走的池题视为消耗）→ 返回。**秒开**。
- 池中无匹配（如指定题型但池里没有）→ 兜底现场生成（现状链路）。
- 取题后 `void ensureReasoningStock()`。
- 狂刷致池见底 → 自动补充 + 后续兜底现场生成，优雅降级。

### 海龟汤

- 玩法零变化：点 fresh 汤即开局（本就秒开）；开新局后触发泵。

### 避免清单口径说明

池题的避免清单以**生成时刻**为准（当时的近 20 题 + 池内互避）；池最多 10 道、周转快，转正时与新历史同构的概率极低，不做转正时二次校验（YAGNI）。

## UI 变化（刻意做少——无感即最佳）

- **每日一题/练习场**：正常路径秒开，界面结构与现状完全一致；loading 文案微调为「题库见底，现场出题中…」——让用户明白这是例外路径。
- **汤库列表**：监听 `reasoning:stockChanged` 刷新——后台补的汤渐进出现，无 toast 打扰。
- **空库空态文案**：汤库为空时改为「AI 正在后台备汤，稍候即有新汤；或点『来 3 碗汤』立即补」——覆盖刚触发补充、列表还空的窗口期。
- 不加存量徽标、不加进度条、不加设置项；样式与主题约束全部不动（纯逻辑层改动）。

## 边界与错误处理

| 场景 | 行为 |
| --- | --- |
| LLM 未配置 | 泵静默跳过（console.warn）；手动按钮/开局入口照全局规则 8 弹「去配置」 |
| 两阶段出题两次不过 | 不落池（维持「不落半截数据」口径），泵 warn 跳出，下次触发再试 |
| 泵运行中 App 退出 | 进程直接退，每批独立落库，无脏数据 |
| 手动「来 3 碗汤」与泵并发 | 各自独立插库，最坏多 3 碗，可接受 |
| 转正事务崩溃 | BEGIN…COMMIT 回滚，最坏池行残留可再取，不出现「既入墙又留池」双份 |
| 池题存留跨多天 | 无过期机制（YAGNI）——生成时刻避免口径已覆盖绝大部分同构风险 |
| 回收站 | 池表不进回收站；汤/对局回收逻辑不变；恢复回收站 fresh 汤使存量回升，无碍 |

## 改动面清单

| 文件 | 改动 |
| --- | --- |
| `electron/db/db.ts` | v14 迁移（新表 wall_pool） |
| `electron/services/reasoningStock.ts` | 新增（泵 + 存量常量） |
| `electron/main.ts` | 启动延迟 10s 触发泵 |
| `electron/ipc.ts` | `wall:ensureToday` / `wall:practiceNew` 改道取题、`turtle:openSoup` 开新局触发泵、新 IPC `reasoning:stockCheck` |
| `electron/preload.ts` + `src/renderer/api.d.ts` | 桥接新通道与 `reasoning:stockChanged` 事件 |
| `src/modules/reasoning/ReasoningModule.tsx` | 模块激活时调 `reasoning:stockCheck` |
| `src/modules/reasoning/TurtlePanel.tsx` | 事件刷新 + 空态文案 |
| `src/modules/reasoning/WallPanel.tsx` / `PracticePanel.tsx` | loading 文案 |

## 验收清单

- [ ] 每日一题池命中秒开（零 LLM 等待）；连胜难度推导与题型轮换行为不变
- [ ] 练习场按难度/题型从池取题秒开；无匹配兜底现场生成；PRACTICE_GONE 口径不变
- [ ] 汤库 fresh 存量 < 5 自动补到 10（启动 / 消耗后 / 进入模块三触发点各自生效）
- [ ] 题池 < 5 补到 10：难度稀缺优先、题型多样、避免清单含近 20 题 + 池内互避
- [ ] 池空时每日题/练习场兜底现场生成，loading 文案「题库见底，现场出题中…」
- [ ] LLM 未配置：泵静默（console.warn），手动入口照全局规则 8
- [ ] 两阶段失败不落池；`pumping` 标志防重入；手动与泵并发无异常
- [ ] `reasoning:stockChanged` 推送后汤库列表渐进刷新；空态文案更新
- [ ] 池表不进回收站；回收站推理角板块行为不变
- [ ] typecheck 双配置通过

## specs 同步说明

- `docs/project/idea/推理角/designs-specs.md` 已同步 v1.3 增量（开发者 260907 授权更新）。
- `design.md`（开发者主导）中「每天首次进入思维墙，若当日无题则 AI 现场出一道（打开现出，无定时器）」一句与实现不再一致，建议开发者改为「每天首次进入思维墙，从预生成题池取一道当日的题（打开现取）；池空才现场出题」。
