# 格言库：功能气泡菜单 + 「格言·解读」频道 设计文档

- 日期：2026-09-05（260905）
- 来源：`docs/project/优化建议区.md` 待完成区唯一条目（实施后归档为第 14 轮）
- 状态：已经开发者逐节确认（260905，brainstorming 流程）；已于 260906 实施完成（见 `docs/log/260906.md`，优化建议区归档第 15 轮）
- 已归档：260907 落地归档（气泡菜单 /「格言·解读」频道已上线）
- 修订（260906 开发者反馈）：AI 徽标不再置于序号旁，并入行尾标签组与用户标签同款样式同位置（「AI、首个标签 +N」）；标签组移至出处**左侧**，行尾顺序 `#标签 → ——出处 → ⋯`

## 背景与目标

格言条目行尾功能图标（加入沉淀区/标签/复制/删除/编辑…）越挂越多、占据行宽，正文与出处空间被挤压。本次：

1. 新增「AI 解读」入口：点击后把格言自动发送到 AI 边栏**新建的「格言·解读」频道**并自动生成解读。
2. 功能图标全部收进**单击召唤的气泡菜单**，腾出的右侧空间放出处。
3. 行布局改单行：`序号 + AI徽章(编撰条) + 正文(左) + ——出处(右侧小字浅色) + #标签(行尾小字) + ⋯`。

## 已确认的交互决策

| 决策点 | 结论 |
|---|---|
| 打开笔记弹窗入口 | **双击行 = 打开 md 笔记弹窗**（正式区且有笔记；草稿/沉淀区双击无操作）；菜单内「查看笔记」项兜底 |
| 标签显示 | 行尾小字：`sell` 图标 + 首个标签名 + `+N` 计数；无标签不显示；悬停 title 看全部 |
| 出处位置 | 右侧、不贴正文；小字体浅色（沿用 `motto-source` 样式）；nowrap + ellipsis + title；无出处显示「——（出处待补）」 |
| 浮窗形式 | 气泡菜单（fixed 锚定行尾弹出），非行内展开条 |
| 实现方案 | 抽通用 `ActionMenu` 组件（方案一），万象库/灵感泉现有菜单暂不迁移 |
| 解读人格 | 字面义 → 背景出处 → 引申义/适用场景，150~300 字，不掉书袋、不灌鸡汤 |
| 解读开放范围 | 三区均可（草稿区也可先解读再决定去留） |

## 1 · 格言行重构（UI 层）

**涉及文件**：`src/modules/mottos/MottosModule.tsx`、`MottosModule.css`

新行结构：

```
[序号] [AI徽章(仅编撰条)] [正文 flex:1 左对齐·保留换行] [——出处 右对齐 nowrap+ellipsis] [# 标签小字] [⋯ 按钮]
```

- AI 徽章从行尾图标排移到序号旁。
- 行上不再渲染任何功能 icon-btn；`row-actions` 容器删除。

**交互时序**：

| 手势 | 行为 |
|---|---|
| 单击行 / 单击 ⋯ | 260ms 防抖后开气泡菜单（防抖给双击让路；定时器存 ref） |
| 双击行 | 清除单击定时器；正式区且 `note_path` 存在 → `setViewId(m.id)` 打开笔记弹窗 |
| 拖拽 | 原样保留（dragstart 与 click 浏览器天然区分，区内排序不受影响） |

**菜单项按区**（顺序统一为：AI 解读 / 编辑 / 标签 / 复制 / 区特有项 ∥ 丢弃）：

- 草稿区：AI 解读 / 编辑（仅 AI 编撰条：`origin==='ai' && gen_kind!=='excerpt'`）/ 标签 / 复制 / 加入沉淀区 ∥ 丢弃
- 沉淀区：AI 解读 / 编辑（仅 AI 编撰条）/ 标签 / 复制 / 加入正式区 ∥ 丢弃
- 正式区：AI 解读 / 编辑（全量）/ 标签 / 复制 / 查看笔记 ∥ 丢弃

菜单项动作复用现有函数：标签 → 关菜单 + 展开 `tag-edit-row`；编辑 → 关菜单 + `setEditing`；复制 → `copyMotto`（toast 保留）；加入沉淀/正式区 → `mottos.setStatus` + `load`；查看笔记 → `setViewId`；丢弃 → `setDiscardTarget` 二次确认（不变）。

## 2 · ActionMenu 通用组件（新文件）

**涉及文件**：新建 `src/components/ActionMenu.tsx` + `src/components/ActionMenu.css`

```ts
export interface ActionMenuItem {
  key: string
  icon: string            // material symbols 名（https://fonts.google.com/icons，禁 emoji）
  label: string
  danger?: boolean        // 丢弃等危险项（用 --color-danger 系）
  separatorAbove?: boolean
  onClick: () => void
}
export interface ActionMenuProps {
  anchorEl: HTMLElement   // 锚定元素（格言行）
  items: ActionMenuItem[]
  onClose: () => void
}
```

行为规格：

- **定位**：挂载时读 `anchorEl.getBoundingClientRect()`，`position:fixed`，菜单右缘对齐锚点右缘、顶部 = 锚点底部 + 6px；菜单底部超出视口 → 翻转至锚点上方；右缘溢出 → 左移。（算法取自第 8 轮万象库板块菜单的防溢出实现。）
- **渲染**：`createPortal(…, document.body)`，避免被行容器裁剪。
- **关闭**：外部 `mousedown`（capture 阶段）/ `wheel` / `Esc` / `resize` → `onClose()`；点菜单项 → `onClick()` + `onClose()`。
- **互斥**：MottosModule 维护 `menuFor: { id: number; anchorEl: HTMLElement } | null`，点新行时旧菜单卸载、新菜单挂载。

## 3 · 「格言·解读」频道（数据层）

channel 列 DB v9 已存在（文本列），**零 DB 迁移**，纯代码新增：

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts`、`src/renderer/api.d.ts` | `AiChannel` 联合类型加 `'motto'`（两处都要） |
| `src/components/AiSidebar.tsx` | `CHANNELS` 加 `{ id: 'motto', label: '格言·解读', icon: 'psychology' }`；`ACTIVE_SESSION_KEYS` 加 motto 项 |
| `src/shared/types.ts`（`SettingsKeys`） | 新增 `AiActiveSessionMotto` settings key |
| `electron/ai/services.ts` | 主进程 `ACTIVE_SESSION_KEYS` 同步加 motto；`CHANNEL_PERSONAS` 加人格：「当前频道是『格言·解读』，你是格言解读员：先讲字面义，再讲背景/出处语境，最后给引申义与适用场景，全文 150~300 字，语言平实，不掉书袋、不灌鸡汤。」 |
| `src/App.tsx` | `CHANNEL_BY_MODULE` 加 `mottos: 'motto'` |

**解读动作链路**（复用现有 pending 机制，AiSidebar 零改动）：

```
菜单点「AI 解读」→ 关菜单 → onOpenAi(`请解读这条格言：「${content}」${source ? ` —— ${source}` : ''}`, { auto: true })
→ App.openAiWith：展开边栏 + setAiPending({ text, channel: CHANNEL_BY_MODULE['mottos']='motto', auto:true })
→ AiSidebar pending effect：切「格言·解读」频道 → sendText 自动发送 → 乐观上屏（第 11 轮机制）
```

## 4 · 边界与错误处理

- **LLM 未配置**：点「AI 解读」→ 边栏 send 现有「去配置」路径（与万象问 AI 同款），格言侧不特判。
- **发送失败**：现有逻辑保留用户消息不掉数据。
- **双击误触**：260ms 内单击不生效；双击仅正式区有笔记时动作。
- **快速连点多行**：菜单互斥切换，不叠加。
- **菜单定位溢出**：上下/左右自适应（组件规格第 2 节）。
- **长句**：正文保留现有换行与 title；出处/标签 nowrap + ellipsis + title。

## 5 · 验收清单

1. 三区行布局：长句换行、无出处（出处待补）、多标签（+N）、AI 徽章在序号旁
2. 单击开菜单；点另一行切换；Esc / 点外部 / 滚动关闭
3. 双击正式区打开笔记弹窗；草稿/沉淀区双击无事；双击不闪菜单
4. 拖拽排序正常，拖拽不触发菜单
5. 各菜单项动作正确且菜单自动关闭；丢弃有二次确认
6. 解读全链路：边栏展开 → 切「格言·解读」→ 自动发送 → 乐观上屏 → AI 回复；三区均可解读
7. LLM 未配置时点解读 → 「去配置」提示
8. 新频道内自由对话、会话切换/新建/删除/改名正常；重启后激活会话恢复
9. `npm run typecheck` 通过

## 明确不做（YAGNI）

- 不迁移万象库/灵感泉现有两处菜单到 ActionMenu（等它们下次改动时再说）
- 不做解读结果回写格言笔记（解读留在频道会话里）
- 不改 DB schema、不加 IPC 通道
- 画像注入策略随频道制现有规则走，不为格言频道单独定制
