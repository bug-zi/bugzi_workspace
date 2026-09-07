# 草稿本 designs-specs.md —— 实现规格

> 依据草稿本/design.md 与已实现代码整理（260907，优化建议区第 21 轮 + 同日两轮反馈修订终态）；本文档为 AI 维护的实现正本，后续改动同步更新。

## 1. 数据与存储

- **DB v14** 新表 `drafts(id, title, channel, md_path, created_at, updated_at, deleted_at)`，`channel` 普通字段（加频道零迁移），`deleted_at` 软删（回收站）。
- 正文真实 md 文件：`md/drafts/{id}.md`（用户数据目录）；删除草稿时连 md 一并清理（彻底删除路径）。

## 2. 设置键（settings 表）

| key | 用途 |
|---|---|
| `right_panel_expanded` | 右缘面板态：`'ai'` \| `'draft'` \| `''`（都收起）；默认 'ai' |
| `draft_width` | 面板宽度 280–560px |
| `draft_active_channel` | 激活频道（general/turtle） |
| `draft_active_general` / `draft_active_turtle` | 各频道激活草稿 id（镜像 AI 边栏 per-channel active session 模式） |

## 3. IPC 契约（preload `api.draft`）

| 通道 | 签名 | 说明 |
|---|---|---|
| `draft:list` | `(channel?): Draft[]` | 某频道草稿列表（updated_at 倒序） |
| `draft:create` | `(channel, title?, content?): number` | 新建草稿返回 id（海龟汤联动传入《汤名》标题；正文空白） |
| `draft:rename` | `(id, title): boolean` | 改标题，**不动 updated_at** |
| `draft:save` | `(id, content): boolean` | 保存正文（md 写入 + bump updated_at 浮顶） |
| `draft:touch` | `(id): boolean` | 只 bump updated_at（大窗编辑后 MdDialog 自行保存） |
| `item:discard` | `('drafts', id): boolean` | 通用丢弃通道：软删入回收站（前端二次确认） |

## 4. 回收站整合（RecycleSource 第七来源 `drafts`）

- RecycleModule「草稿本」页签（七块之一）；恢复去向「草稿本·原频道」（清 deleted_at）；彻底删除删行 + 删 md；3 天自动清理适用。

## 5. 渲染层组件（src/components/DraftSidebar.tsx/.css）

- **props**：`onCollapse()`（头部收起）；`turtleGame: { title } | null`（App 监听 `TURTLE_GAME_EVENT` 持有传入，面板收起不丢上下文）。
- **挂载**：App `rightPanel === 'draft'` 时按需挂载（与 AiSidebar 互斥）。
- 内部常量：`CHANNELS`（general 通用 `edit_note` / turtle 海龟汤 `psychology`）、`ACTIVE_DRAFT_KEYS`（per-channel 激活草稿 settings key）。
- 行为要点：
  - 渲染态 MdView，**双击**进 textarea 编辑；编辑态**自动保存**——停止输入 800ms 静默落库（失败 toast），落库后同步 content 使脏检查归零；「完成」键 + Esc 退出编辑。
  - **落袋兜底**：编辑中切换草稿/频道/收起面板/组件卸载时 flush 待保存内容，兜住防抖窗口内最后输入。
  - 切换条浮层：单击切换草稿 / hover 重命名（行内）·删除（二次确认 → item:discard）；updated_at 倒序浮顶。
  - 海龟汤联动：`turtleGame` 非空且面板展开 → 自动切海龟汤频道；对局中「+」新建 → 标题「《汤名》」正文空白；通用频道不受对局影响。
  - 左缘 7px 拖宽 280–560px（`--draft-width` CSS 变量实时生效），持久化 `draft_width`。

## 6. 事件契约

- `TURTLE_GAME_EVENT`（`src/shared/types` 常量，'bugzi:turtle-game'）：TurtlePanel 进出对局派发 `CustomEvent`，detail `{ title } | null`；App.tsx 接住持 state 传 DraftSidebar。

## 7. 验收清单（现状核对）

- [x] 右缘双面板互斥、细条双图标入口、展开态持久化；debugzi 常驻挂载生成任务不中断
- [x] 双频道独立激活草稿、pill 切换、拖宽持久化
- [x] 新建/双击编辑/800ms 自动保存/完成键/落袋兜底/大窗编辑（MdDialog 同一 md，touch 浮顶）
- [x] 重命名不动 updated_at；删除二次确认入回收站、恢复回原频道、彻底删除删行 + md
- [x] 海龟汤进对局自动切频道、《汤名》新建（无正文预填）、局终草稿永存
