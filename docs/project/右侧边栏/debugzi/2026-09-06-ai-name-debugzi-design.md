# 设计：给 AI 助手起名 debugzi（优化建议区第 16 轮）

- **日期**：2026-09-06（260906）
- **来源**：`docs/project/优化建议区.md` 待完成条目「给我的AI起名叫做debugzi」
- **流程**：brainstorming——开发者逐项确认（范围 → 方案 → 设计），260906 会话内批准后实施
- **规模**：纯文案与常量抽取，4 文件，无 DB 迁移、无新组件
- **已归档**：260907 落地归档（260906 实施完成，见 `docs/log/260906.md`）

## 背景与命名

用户名 bugzi，AI 助手起名 **debugzi**（bug / debug 配对梗）。拼写按任务原文全小写 `debugzi`。

## 已确认的关键决策

| 决策点 | 结论 |
| --- | --- |
| 覆盖范围 | **身份全面落地**：身份位（标题/角色标签/自称/对话入口）换成 debugzi；功能描述类「AI」字样保留 |
| 拼写 | 全小写 `debugzi`（与 bugzi 风格一致） |
| 可配置性 | 不做成设置项——一次性命名，YAGNI（方案 B 否决） |
| 常量落点 | `src/shared/types.ts`（文件本就是「共享类型与常量」，主进程/渲染层共用，方案 C 写死否决） |
| 频道人设 | 五频道人设不重复写名——身份行 + 频道行拼合自然形成「debugzi 在此频道扮演该角色」 |
| 欢迎引导 | 彩蛋加入（开发者选「方案 A + 彩蛋」） |

## 实施

### ① 常量（`src/shared/types.ts`）

```ts
// AI 助手名字（优化建议区：起名 debugzi，与用户 bugzi 配对）：主进程 prompt 与渲染层文案共用
export const AI_NAME = 'debugzi'
```

### ② UI 身份位（`src/components/AiSidebar.tsx`，import AI_NAME）

| 位置 | 原文 | 改后 |
| --- | --- | --- |
| 边栏标题 | `AI 助手` | `{AI_NAME}` |
| 收起态 tooltip | `展开 AI 助手` | `` `展开 ${AI_NAME}` `` |
| `ROLE_LABEL.assistant` | `'AI'` | `AI_NAME`（消息气泡角色标签） |
| 思考中占位（原硬编码） | `AI` | `{AI_NAME}` |
| 输入框 placeholder | `问 AI（…）` | `` `问 ${AI_NAME}（…）` ``（仅动前缀） |
| 画像建议提示 | `AI 想把这条加入「我的画像」` | `` `${AI_NAME} 想把…` `` |

`.ai-msg-role` 为 flex 自适应无固定宽度，7 字符放得下。

### ③ System prompt 身份声明（`electron/ai/services.ts` aiChat）

```
你是 bugzi 的个人工作台「bug子的workspace」的 AI 助手，名叫 debugzi。对话中提到自己时自称 debugzi。用户当前所在模块：X。
```

### ④ 欢迎引导彩蛋（`src/modules/profile/WelcomeGuide.tsx` 第 3 步）

「建议先去个人中心配置 LLM，以启用 AI 功能」→「建议先去个人中心配置 LLM，让 debugzi 上线陪你开工」（括号内功能列举保留「AI 对话」等功能描述）。

### 明确不动

- 功能描述类「AI」：问 AI / AI 解读 / 让 AI 追问 / AI 编撰徽章 / GoConfigDialog「以启用 AI 功能」、WelcomeGuide 功能列举
- 频道人设文案、DB 结构、会话/频道机制
- class 名等代码标识符（`ai-title` 等）

## 验证

- `npm run typecheck` 双 tsconfig 通过（260906 已跑）
- 冒烟：边栏标题显示 debugzi；对话后 AI 自称 debugzi；角色标签/思考中占位/placeholder 均显示新名；欢迎引导彩蛋（需清 user_name 重启触发）
- git 提交由开发者执行

## 追加（260906 同日）：AI 编撰条出处署名 debugzi

开发者追加指令：格言库出处为「AI 编撰」的条目，出处改成 debugzi。署名逻辑与命名一致——谁写的署谁的名；行尾「AI」徽章是生成方式标识而非署名，保留。

- 生成 prompt：编撰条 `source 标「debugzi」`（`generateMottos`）
- `mottoKind` 容错正则扩为 `/(?:ai\s*编撰|debugzi)/i`（新署名可识别、旧格式兼容）
- **DB v10 迁移**：`UPDATE mottos SET source='debugzi' WHERE origin='ai' AND source LIKE '%AI%编撰%'`（含回收站软删行；限定 origin='ai'；LIKE 口径同 v6 回填）
- 编辑表单 placeholder 与三处注释同步；v6 历史迁移代码不动
