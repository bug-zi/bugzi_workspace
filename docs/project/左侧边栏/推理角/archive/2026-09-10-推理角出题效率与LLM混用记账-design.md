# 推理角出题效率与 LLM 混用/记账 设计文档

> 日期：2026-09-10 · 状态：brainstorming 会话定稿（待开发者最终审阅）
> 来源：优化建议区「待完成」条目（推理角出题速度慢 + token 消耗/AI 使用情况不可见）
> 方案：会话三案对比后开发者拍板 **方案 A：咽喉点记账 + 受控并行**，追加需求 **模型池溢出路由（混用）**

## 1. 背景与问题

开发者四点痛点全中：池空时现场出题慢、后台建池太慢、海龟汤交互慢、整体感知慢。

摸底定位的结构性原因：

1. **两阶段质量管线（不动）**：思维墙每道题 = 出题（temp 0.9）→ 独立审题（temp 0.2 半盲重演）→ 打回重出再审，最少 2 趟、最坏 4 趟 LLM 调用；海龟汤一批 3 碗 = 1 趟出汤 + 逐碗审题 + 打回重出。
2. **全链路刻意串行**：补充泵题池逐道 → 再逐批补汤，串行跑完约 20 趟+ 调用；串行是为了防中转通道 429 共振。
3. **token 完全不可见**：全仓 25 处 LLM 调用都走 `chatCompletion`（electron/ai/llm.ts:47）这一个咽喉点，但 `ChatResult` 只取 content，上游响应自带的 usage 字段被丢弃。

## 2. 实测数据（2026-09-10，脚本实测后删除）

| 项 | gpt（中转 gpt-5.6，token.aiedulab.cn） | glm（glm-5.3-flash，智谱官方 coding 端点） |
|---|---|---|
| 连通性 | HTTP 200 | HTTP 200 |
| 最小请求（max_tokens=1）延迟 | **11.7 秒** | **0.7 秒** |
| 真实 JSON 生成 | — | 2.7s，内容正确、finish=stop |
| 4 路并发 | 未测 | **全部 200，延迟无恶化（~1.3s/个）** |
| usage 字段 | 未确认（按缺失容错设计） | 完整（prompt/completion/total 齐全） |

**关键结论**：gpt 中转首字延迟 ~12s 是历史「到处都慢」的主因（20 趟串行 × 12s 起步 = 分钟级）；glm 快 16 倍、并发扛 4 路、usage 上报完整。开发者已将 glm 设为默认配置。

## 3. 目标与非目标

**目标**（质量红线：两阶段出题审题管线一行不改）：

1. 模型混用：默认模型（glm）在途满载时，新调用自动溢出到有余量的其他配置（gpt）。
2. token/AI 使用可观测：分场景汇总统计 + AI 实时活动指示。
3. 补充泵并行化：三级串行解开，建池时间大幅缩短。

**非目标**（开发者已划出范围）：

- 不做逐次调用明细账本、不做费用估算（token 单价）。
- 不做按场景指定模型（如「审题专用 gpt」）——溢出路由已覆盖核心诉求，模型分工留待统计数据说话后另立项。
- 不清理 llm_usage 历史数据（一天几十行，一年 ~2 万行，SQLite 无压力）。

## 4. 设计 §1 模型池溢出路由（混用核心）

`chatCompletion` 咽喉点内实现，25 处调用点零改动、完全透明：

```
调用进来（带 scene 标签）→
  默认配置在途数 < 其并发上限？→ 用默认（现状行为）
  否则 → 遍历其他配置，挑在途数最低且有余量的 → 用它
  全满 → 仍发默认配置（不排队，429 三层兜底照常收尾）
```

- **`LlmConfig` 加可选字段 `maxConcurrent?: number`**：个人档 LLM 卡片编辑表单加一行「并发上限」数字输入（留空 = 不限 = 永不溢出，行为与现状一致）。开发者场景：glm 填 3~4、gpt 填 2。
- **在途计数**：主进程内存按配置 id 计数，调用开始 +1、结束（无论成败/取消，finally 保证）-1，重启清零。纯内存不落库。
- **无模型亲和要求**：两阶段出题/审题各趟可能落在不同模型，prompt 无状态，无影响。
- **选择只影响路由，不做准入控制**：caps 是路由提示不是闸门，无死锁/饿死顾虑。
- 429 三层兜底（chatCompletion 内重试 / 泵层瞬态重试 / 自愈重排）全部保留。

## 5. 设计 §2 llm_usage 记账（DB v27）

咽喉点每次**逻辑调用**落一行（429 多次重试只记最终一趟，耗时含重试等待——统计语义是「趟」）：

```sql
CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  scene TEXT NOT NULL,            -- 两段式 模块:动作，见场景表
  config_name TEXT NOT NULL,      -- 'glm' / 'gpt'
  model TEXT NOT NULL,
  ok INTEGER NOT NULL,            -- 1 成功 0 失败（含取消）
  duration_ms INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  tokens_estimated INTEGER NOT NULL DEFAULT 0,  -- 上游未返回 usage 时按字符估算
  error_brief TEXT                -- 失败时的错误摘要（截断）
);
CREATE INDEX idx_llm_usage_created ON llm_usage(created_at);
```

- **usage 缺失容错**：上游响应无 usage（gpt 中转待验证）→ prompt_tokens ≈ ceil(prompt 字符数/2)、completion 同理（中文 ~2 字符/token 的粗估），`tokens_estimated=1`，统计页显示 ≈ 标记。
- **scene 场景表**（`ChatOptions` 加可选 `scene?: string`，默认 `other`；中文标签映射放 `src/shared/types.ts` 供统计页与活动指示共用；25 处调用点在实施计划中逐一标注）：

| scene | 中文名 | scene | 中文名 |
|---|---|---|---|
| reasoning:wall-compose | 推理角·出题 | motto:generate | 格言库·生成 |
| reasoning:wall-review | 推理角·审题 | wiki:card | 万象库·知识卡 |
| reasoning:wall-judge | 推理角·判答 | wiki:quiz | 万象库·测一测 |
| reasoning:soup-compose | 推理角·出汤 | inspiration:diverge | 灵感泉·发散 |
| reasoning:soup-review | 推理角·审汤 | inspiration:refine | 灵感泉·自评 |
| reasoning:soup-ask | 推理角·判问 | verify:check | 万象库·辩真核查 |
| reasoning:soup-guess | 推理角·判汤底 | zhijiji:v0 | 致知己·AI 初始化 |
| reasoning:soup-report | 推理角·复盘 | wenbi:copilot | 文笔坊·协笔 |
| reasoning:soup-backfill | 推理角·诡计回填 | feed:summary | 信息源·总结 |
| ai:chat | debugzi·对话 | mcp:research | MCP·配置研究 |
| ai:compact | AI·上下文压缩 | wiki:suggest | 万象库·词条构思 |
| other | 其他 | | |

> 勘误（写计划时核对源码）：调用点全量实为 **27 处**（含 `chatCompletion(req)` 变参与箭头包装形式）；scene 表相应补 `ai:compact`（compactAiSession）与 `wiki:suggest`（suggestWikiTerm）两标签。

- 记账写库失败静默 warn，绝不影响调用本身；LLM 未配置在记账前就抛 `LlmNotConfiguredError`（现状不变）。
- 取消（signal abort）：记 ok=0、error_brief='已取消'（中止时无 usage，token 记 0）。

## 6. 设计 §3 并行补充泵

三级串行全部解开（`electron/services/reasoningStock.ts` + `electron/ai/services.ts` generateSoups）：

1. **泵顶层双路**：`pumpPuzzles` 与 `pumpSoups` 同时跑（两路各自容错互不阻断的现有结构不变，仅由顺序 await 改并发）。
2. **题池内两道并行**：一次配对补两道；难度/题型一次性算好并**强制互异**（防两路读到同一稀缺档各出同类型的题），避免清单取配对前的池快照；插库仍逐条落、`reasoning:stockChanged` 逐条推送（汤库列表渐进刷新不变）。单道质量类失败不废整泵：`Promise.allSettled` 配对，另一道照常，非瞬态错误在泵循环结束后上抛走现有 warn 路径。
3. **汤批内 3 碗审题并行**：审题互相独立（半盲、各看各题），首轮 `Promise.all` 同发；**打回重出阶段保持串行**（重出要带「同批已保留碗」互避清单，串行才能保证清单正确）。此改动对「来 3 碗汤」手动入口同样生效，质量口径不变。

**质量零改动**：prompt、两阶段、打回上限、审题独立性全部原样，纯粹把「等待」变「并发」。峰值在途约 5 路（2 出题 + 3 审汤）+ 用户交互调用；配合 §1 路由，glm 满载溢出 gpt —— 「glm 忙就使 gpt」在此自动发生。

## 7. 设计 §4 个人档「AI 使用」统计区

个人档新增 section（LLM 配置区之后，ProfileModule.tsx）：

- **两张数字卡**：今日 token 总量 / 本月 token 总量（副行：调用次数）。
- **时间范围 pill**：今日 | 本月 | 全部。
- **分场景明细表**：场景（中文名）、调用次数、失败次数、平均耗时、token 合计（估算值带 ≈）。
- 新 IPC `llm:stats`（参数 range）：一条聚合 SQL（WHERE created_at 按范围 + GROUP BY scene）返回汇总行；进页面加载 + 手动刷新小按钮。
- 「失败次数 + 平均耗时」顺带暴露「哪个场景又慢又爱坏」，为后续模型分工立项供数据。

## 8. 设计 §5 AI 实时活动指示

- 主进程在途调用表（§1 已有），起止广播 `llm:activity`，payload = `{ items: [{ scene, configName }] }`（不带 startedAt，YAGNI）。
- **展示位**：左栏模块列表下方底部区域（`sidebar-spacer` 之后；注：白噪音控件 260908 已进模块列表不再钉底部，原设计「白噪音控件下方」措辞据此勘误）——**空闲时完全隐藏**（不渲染），忙时显示「AI · 出题中 ×2」主题色小圆点 + 呼吸动画；同 scene 聚合计数。新组件（如 `src/components/LlmActivity.tsx`）。
- 纯指示不可点；全局可见（任意模块都能看到后台在干活）、零新弹层。
- 与汤库列表渐进刷新互补：指示器说「正在补」，stockChanged 说「补到了」。

## 9. 边界与容错（贯穿）

- **LLM 未配置**：现状不变（记账前抛 `LlmNotConfiguredError`，功能按钮走「去配置」全局规则）。
- **429 重试**：只记最终一趟；全满硬冲默认配置的场景由三层兜底收尾。
- **取消**：在途计数 finally 减、记账 ok=0；活动指示必须归零（无泄漏）。
- **个人档「测试连接」/「获取模型列表」**：独立路径不经咽喉点，不路由不记账（用户手动诊断动作）。
- **记账失败**：静默 warn，不影响调用。
- **并发上限留空**：不限 = 永不溢出，行为与现状完全一致（存量配置零迁移）。

## 10. 涉及文件（预估，实施计划细化）

| 文件 | 改动 |
|---|---|
| electron/ai/llm.ts | 溢出路由 + 在途计数 + llm:activity 广播 + usage 记账 + ChatOptions.scene |
| electron/ai/services.ts | 25 处调用点 scene 标注（部分）；generateSoups 首轮审题并行 |
| electron/ai/mcpResearch.ts | scene 标注 |
| electron/ipc.ts | scene 标注（ai:chat 等）；新 llm:stats IPC |
| electron/services/feed.ts | scene 标注 |
| electron/services/reasoningStock.ts | 三级并行化解开 |
| electron/db/db.ts | DB v27：llm_usage 表 + 索引 |
| src/shared/types.ts | LlmConfig.maxConcurrent、场景中文标签表、stats IPC 类型 |
| preload + src/renderer/api.d.ts | llm:stats / llm:activity 透传（三处手工同步惯例） |
| src/modules/profile/ProfileModule.tsx | LLM 表单「并发上限」输入 + AI 使用统计区 |
| src/components/LlmActivity.tsx（新） | 活动指示组件（App.tsx 挂左栏底部白噪音控件下方） |

## 11. 验收要点

- typecheck 双配置通过；含 DB v27 迁移需重启 dev。
- **建池提速实测**：清空 wall_pool + turtle_soups 后计时对比（预期从分钟级到数十秒级，取决于 glm 占用与溢出情况）。
- **混用验证**：glm 并发上限设 1，同时触发出题 + 来 3 碗汤，观察调用溢出到 gpt（统计页 config_name 出现两列数据）。
- 个人档统计区数据正确（分场景 token/次数/耗时/失败）；glm 行 token 非 0 非 ≈，gpt 行视上游是否报 usage。
- 活动指示：空闲不渲染、生成中出现并计数、全部结束后归零消失；取消生成后也归零。
- 汤批并行审题后，「来 3 碗汤」成功率与质量无回归（打回重出仍走串行互避）。
