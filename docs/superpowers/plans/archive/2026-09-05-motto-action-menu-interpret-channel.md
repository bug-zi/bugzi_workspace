# 格言库功能气泡菜单 + 「格言·解读」频道 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 格言条目功能图标收进单击召唤的通用气泡菜单（新 `ActionMenu` 组件），行布局改单行（出处右置），并新增「格言·解读」AI 频道实现一键自动解读。

**Architecture:** 三层递进：① 纯代码新增 `motto` 频道（channel 列 DB v9 已存在，零迁移）——类型 + 人格 + 边栏 UI + 模块→频道映射；② 新建通用 `ActionMenu` 组件（fixed 锚定 + 防溢出 + portal）；③ `MottosModule` 行重构（单击 260ms 防抖开菜单 / 双击开笔记 / 出处标签尾部收纳），菜单「AI 解读」经既有 `openAiWith(text,{auto:true})` + pending 机制直发新频道，AiSidebar 发送链路零改动。

**Tech Stack:** Electron 44 + React 19 + TypeScript（electron-vite），无 CSS 框架（App.css 主题变量）。

**Spec:** `docs/superpowers/specs/archive/2026-09-05-motto-action-menu-interpret-channel-design.md`（260907 一并归档）

**已归档：** 260907 落地归档——260906 按本计划 5 任务执行完毕（见 `docs/log/260906.md`）。

**项目适配（优先于技能默认）：**
- **Git 纪律：AI 禁止执行任何 git 操作**（项目 CLAUDE.md）。本计划不含 commit 步骤；每任务完成后由开发者自行 commit。
- **无单测框架**（package.json 仅 typecheck/smoke）。验证方式 = `npm run typecheck` + `npm run build` + 开发者人工冒烟（清单见 Task 5），不写 test-first 步骤。

**执行偏差记录（260906 实施时）：** ①归档轮次第14轮 → **第15轮**（第14轮已被同日追问栏优化占用，轮次只增不减）；②日志追加 260905.md → 新建 `docs/log/260906.md`（实施日为 260906）；③`MottosModuleProps.onOpenAi` 签名补第二参 `opts?: { auto?: boolean }`（否则 Step 4.3 的双参调用过不了 typecheck，App.openAiWith 本就支持）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/shared/types.ts` | 修改 | `AiChannel` 加 `'motto'`；`SettingsKeys` 加 `AiActiveSessionMotto` |
| `src/renderer/api.d.ts` | 修改 | `AiChannel` 加 `'motto'`（渲染层独立副本） |
| `electron/ai/services.ts` | 修改 | 主进程 `ACTIVE_SESSION_KEYS` + `CHANNEL_PERSONAS` 加 motto |
| `src/components/AiSidebar.tsx` | 修改 | `CHANNELS` + `ACTIVE_SESSION_KEYS` 加 motto |
| `src/App.tsx` | 修改 | `CHANNEL_BY_MODULE` 加 `mottos: 'motto'` |
| `src/components/ActionMenu.tsx` | 新建 | 通用锚定气泡菜单组件 |
| `src/components/ActionMenu.css` | 新建 | 菜单样式（主题变量，非彩亮色） |
| `src/modules/mottos/MottosModule.tsx` | 修改 | 行重构 + 菜单接入 + AI 解读动作 |
| `src/App.css` | 修改 | 格言行单行布局样式 |
| `docs/log/260905.md` | 修改 | 追加当日开发记录 |
| `docs/project/优化建议区.md` | 修改 | 完成条目归档为第 14 轮 |

---

### Task 1: 「格言·解读」频道——类型与主进程

**Files:**
- Modify: `src/shared/types.ts:14`（AiChannel）、`src/shared/types.ts:34`（SettingsKeys）
- Modify: `src/renderer/api.d.ts:5`（AiChannel）
- Modify: `electron/ai/services.ts:18-24`（ACTIVE_SESSION_KEYS）、`electron/ai/services.ts:146-154`（CHANNEL_PERSONAS）

- [x] **Step 1.1: 扩展 `src/shared/types.ts` 的 AiChannel 与 SettingsKeys**

第 14 行替换：

```ts
// AI 边栏频道（DB v9：ai_sessions.channel；致知己 specs §4，存量会话归 assistant）
export type AiChannel = 'assistant' | 'motto' | 'wiki' | 'zhijiji' | 'verify'
```

SettingsKeys 块（34 行 `AiActiveSessionWiki` 之前）插入一行，使频道 key 按频道顺序排列：

```ts
  AiActiveChannel: 'ai_active_channel',
  AiActiveSessionMotto: 'ai_active_session_motto',
  AiActiveSessionWiki: 'ai_active_session_wiki',
```

- [x] **Step 1.2: 同步 `src/renderer/api.d.ts` 第 5 行**

```ts
/** AI 边栏频道（DB v9 频道制） */
export type AiChannel = 'assistant' | 'motto' | 'wiki' | 'zhijiji' | 'verify'
```

- [x] **Step 1.3: `electron/ai/services.ts` 的 ACTIVE_SESSION_KEYS 加 motto（18-24 行）**

```ts
const ACTIVE_SESSION_KEYS: Record<AiChannel, string> = {
  assistant: SettingsKeys.AiActiveSessionId,
  motto: SettingsKeys.AiActiveSessionMotto,
  wiki: SettingsKeys.AiActiveSessionWiki,
  zhijiji: SettingsKeys.AiActiveSessionZhijiji,
  verify: SettingsKeys.AiActiveSessionVerify
}
```

- [x] **Step 1.4: 同文件 CHANNEL_PERSONAS 加格言解读员人格（146-154 行）**

在 `assistant:` 条目后插入（保持频道顺序一致）：

```ts
  motto:
    '当前频道是「格言·解读」，你是格言解读员：用户发来一条格言，请依次给出——①字面义：用平实的话讲清这句话在说什么；②背景与出处：它从哪里来、原来的语境是什么（不确定的内容要明说，绝不编造）；③引申与适用：今天什么场景下用得上、怎么用。全文 150~300 字，语言平实，不掉书袋、不灌鸡汤。',
```

- [x] **Step 1.5: 类型检查**

Run: `npm run typecheck`
Expected: 通过（TS 可能报 `Record<AiChannel,string>` 缺 key 的位置已被上述步骤补齐；若 AiSidebar.tsx / src App.tsx 报 `ACTIVE_SESSION_KEYS`/`CHANNELS` 类型不匹配——那是 Task 2 的内容，本任务结束时若仅这两处报错，先完成 Task 2 再统一验证亦可。顺序执行 Task 2 后必须全绿）。

---

### Task 2: 边栏频道 UI + 模块→频道映射

**Files:**
- Modify: `src/components/AiSidebar.tsx:26-39`
- Modify: `src/App.tsx:28-32`

- [x] **Step 2.1: AiSidebar.tsx 的 CHANNELS 加 motto（放助手之后，对应左侧栏模块顺序格言库居首）**

```ts
const CHANNELS: { id: AiChannel; label: string; icon: string }[] = [
  { id: 'assistant', label: '助手', icon: 'forum' },
  { id: 'motto', label: '格言·解读', icon: 'psychology' },
  { id: 'wiki', label: '万象·问答', icon: 'public' },
  { id: 'zhijiji', label: '致知己·追问', icon: 'self_improvement' },
  { id: 'verify', label: '辩真·核查', icon: 'fact_check' }
]
```

- [x] **Step 2.2: 同文件 ACTIVE_SESSION_KEYS 加 motto（34-39 行）**

```ts
const ACTIVE_SESSION_KEYS: Record<AiChannel, string> = {
  assistant: SettingsKeys.AiActiveSessionId,
  motto: SettingsKeys.AiActiveSessionMotto,
  wiki: SettingsKeys.AiActiveSessionWiki,
  zhijiji: SettingsKeys.AiActiveSessionZhijiji,
  verify: SettingsKeys.AiActiveSessionVerify
}
```

- [x] **Step 2.3: App.tsx CHANNEL_BY_MODULE 加 mottos 映射（28-32 行）**

```ts
const CHANNEL_BY_MODULE: Partial<Record<ModuleId, AiChannel>> = {
  mottos: 'motto',
  wiki: 'wiki',
  verify: 'verify',
  zhijiji: 'zhijiji'
}
```

- [x] **Step 2.4: 类型检查**

Run: `npm run typecheck`
Expected: 全绿（Task 1+2 合起来补齐了 `Record<AiChannel,…>` 的所有 key）。

- [x] **Step 2.5: 人工冒烟点（开发者 `npm run dev`）**

边栏频道条出现「格言·解读」；点击切换正常；新会话/历史会话互不串频道；重启后停留在格言频道。AiSidebar 内部（persistActive / loadForChannel / sendText）全部经 `ACTIVE_SESSION_KEYS[channel]` 间接取 key，无其他改动点。

---

### Task 3: ActionMenu 通用组件

**Files:**
- Create: `src/components/ActionMenu.tsx`
- Create: `src/components/ActionMenu.css`

- [x] **Step 3.1: 新建 `src/components/ActionMenu.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './ActionMenu.css'

export interface ActionMenuItem {
  key: string
  /** material symbols 图标名（禁 emoji） */
  icon: string
  label: string
  danger?: boolean
  separatorAbove?: boolean
  onClick: () => void
}

export interface ActionMenuProps {
  /** 锚定元素：菜单右缘对齐其右缘、顶部在其下方 6px；底部溢出翻到上方 */
  anchorEl: HTMLElement
  items: ActionMenuItem[]
  onClose: () => void
}

/**
 * 通用锚定气泡菜单（优化建议区第14轮：格言行功能浮窗）。
 * fixed 定位 + 视口防溢出 + createPortal 到 body（不被行容器裁剪）。
 * 关闭：外部 mousedown（capture）/ wheel / Esc / resize；点菜单项先 onClose 再 onClick。
 */
export default function ActionMenu(props: ActionMenuProps) {
  const { anchorEl, items, onClose } = props
  const ref = useRef<HTMLDivElement | null>(null)
  // 先在屏幕外渲染拿真实尺寸，再定位（两次：同步 + rAF 兜底）
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 })

  useEffect(() => {
    const place = (): void => {
      const a = anchorEl.getBoundingClientRect()
      const el = ref.current
      const w = el?.offsetWidth ?? 180
      const h = el?.offsetHeight ?? 240
      let left = a.right - w
      let top = a.bottom + 6
      if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6)
      if (left < 8) left = 8
      setPos({ top, left })
    }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [anchorEl])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div className="action-menu" ref={ref} style={{ top: pos.top, left: pos.left }} role="menu">
      {items.map((it) => (
        <div key={it.key}>
          {it.separatorAbove && <div className="action-menu-sep" />}
          <button
            className={`action-menu-item${it.danger ? ' danger' : ''}`}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            <span className="material-symbols-outlined">{it.icon}</span>
            {it.label}
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
```

- [x] **Step 3.2: 新建 `src/components/ActionMenu.css`**

```css
/* 通用锚定气泡菜单（优化建议区第14轮）：主题色系，禁彩亮色 */
.action-menu {
  position: fixed;
  z-index: 300;
  min-width: 176px;
  background: var(--color-surface-strong);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.action-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: 0.9em;
  text-align: left;
  cursor: pointer;
}
.action-menu-item .material-symbols-outlined {
  font-size: 18px;
  color: var(--color-text-secondary);
}
.action-menu-item:hover {
  background: var(--color-primary-soft);
}
.action-menu-item.danger,
.action-menu-item.danger .material-symbols-outlined {
  color: var(--color-danger);
}
.action-menu-sep {
  height: 1px;
  background: var(--color-border);
  margin: 4px 6px;
}
```

- [x] **Step 3.3: 类型检查**

Run: `npm run typecheck`
Expected: 通过（新文件独立编译，无依赖方）。

---

### Task 4: 格言行重构 + 菜单接入 + AI 解读

**Files:**
- Modify: `src/modules/mottos/MottosModule.tsx`（import 区、state 区 71 行后、函数区 274 行后、行 JSX 467-560、菜单渲染 605 行 MdDialog 前）
- Modify: `src/App.css`（.motto-row 区块 230-256、旧 .motto-tags 区块 644-658）

- [x] **Step 4.1: MottosModule.tsx 顶部加 import（与其他组件 import 并列）**

```tsx
import ActionMenu, { type ActionMenuItem } from '../../components/ActionMenu'
```

- [x] **Step 4.2: state 区加菜单状态（71 行 `foreverTarget` 声明之后）**

```tsx
  // 功能气泡菜单（优化建议区第14轮）：单击行 260ms 防抖召唤，双击行打开笔记（正式区）
  const [menuFor, setMenuFor] = useState<{ id: number; anchor: HTMLElement } | null>(null)
  const clickTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (clickTimer.current != null) window.clearTimeout(clickTimer.current)
  }, [])
```

- [x] **Step 4.3: 函数区加交互与动作函数（274 行 `copyMotto` 之后、拖拽函数之前）**

```tsx
  /** 单击行：260ms 防抖给双击让路，到点开/关功能气泡菜单（锚定行本身） */
  const onRowClick = (m: MottoRecord, e: React.MouseEvent): void => {
    if (clickTimer.current != null) window.clearTimeout(clickTimer.current)
    const anchor = e.currentTarget as HTMLElement
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null
      setMenuFor((cur) => (cur?.id === m.id ? null : { id: m.id, anchor }))
    }, 260)
  }

  /** 双击行：取消单击定时器；正式区且有笔记 → 打开笔记弹窗；草稿/沉淀区无事 */
  const onRowDoubleClick = (m: MottoRecord): void => {
    if (clickTimer.current != null) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    if (m.status === 'formal' && m.note_path) setViewId(m.id)
  }

  /** AI 解读（优化建议区第14轮）：发到「格言·解读」频道并自动发送（channel 经 App 模块映射） */
  const interpretMotto = (m: MottoRecord): void => {
    const body = m.content.trim()
    const text = m.source.trim() ? `请解读这条格言：「${body}」 —— ${m.source.trim()}` : `请解读这条格言：「${body}」`
    onOpenAi(text, { auto: true })
  }

  /** 功能气泡菜单项（按区拼装；顺序：AI 解读 / 编辑 / 标签 / 复制 / 区特有 ∥ 丢弃） */
  const mottoMenuItems = (m: MottoRecord): ActionMenuItem[] => {
    const items: ActionMenuItem[] = [
      { key: 'interpret', icon: 'psychology', label: 'AI 解读', onClick: () => interpretMotto(m) }
    ]
    // 编辑：正式区全量；草稿/沉淀区仅 AI 编撰条（判定与 AI 徽章一致）
    if (m.status === 'formal' || (m.origin === 'ai' && m.gen_kind !== 'excerpt')) {
      items.push({
        key: 'edit',
        icon: 'edit',
        label: '编辑',
        onClick: () => {
          setEditing(m)
          setEditContent(m.content)
          setEditSource(m.source)
          setEditTags((m.tags ?? []).join('、'))
        }
      })
    }
    items.push(
      {
        key: 'tags',
        icon: 'sell',
        label: '标签',
        onClick: () => {
          setTagEditId((cur) => (cur === m.id ? null : m.id))
          setTagInput('')
        }
      },
      {
        key: 'copy',
        icon: 'content_copy',
        label: '复制格言+出处',
        onClick: () => void copyMotto(m)
      }
    )
    if (m.status === 'draft') {
      items.push({
        key: 'toSettled',
        icon: 'moving',
        label: '加入沉淀区',
        onClick: () => void window.api.mottos.setStatus(m.id, 'settled').then(load)
      })
    } else if (m.status === 'settled') {
      items.push({
        key: 'toFormal',
        icon: 'workspace_premium',
        label: '加入正式区',
        onClick: () => void window.api.mottos.setStatus(m.id, 'formal').then(load)
      })
    } else {
      items.push({
        key: 'note',
        icon: 'notebook',
        label: '查看笔记',
        onClick: () => setViewId(m.id)
      })
    }
    items.push({
      key: 'discard',
      icon: 'delete',
      label: '丢弃',
      danger: true,
      separatorAbove: true,
      onClick: () => setDiscardTarget(m)
    })
    return items
  }
```

- [x] **Step 4.4: 替换行 JSX（467-560 行，从 `{items.map((m, idx) => (` 到 `</div>` 行尾，即旧 `row-actions` 结束止）**

旧结构（`row-main` 双行 + `row-actions` 图标排）整体替换为：

```tsx
                {items.map((m, idx) => (
                  <Fragment key={m.id}>
                  <div
                    className="row-item motto-row"
                    draggable
                    onDragStart={(e) => onDragStart(e, m)}
                    onDragEnd={onDragEnd}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => void onDropToRow(e, m)}
                    onClick={(e) => onRowClick(m, e)}
                    onDoubleClick={() => onRowDoubleClick(m)}
                  >
                    <span className="row-index">{idx + 1}</span>
                    {/* AI 徽章仅编撰条显示（v2.0），随图标排撤销移到序号旁 */}
                    {m.origin === 'ai' && m.gen_kind !== 'excerpt' && <span className="badge">AI</span>}
                    <div className="motto-content" title={m.content}>
                      {m.content}
                    </div>
                    {/* 尾部收纳：出处（右侧小字浅色）+ 标签计数 + 菜单按钮（优化建议区第14轮单行布局） */}
                    <div className="motto-tail">
                      <span className="motto-source" title={m.source || '（出处待补）'}>
                        —— {m.source || '（出处待补）'}
                      </span>
                      {(m.tags ?? []).length > 0 && (
                        <span className="motto-tags" title={(m.tags ?? []).join('、')}>
                          <span className="material-symbols-outlined">sell</span>
                          {m.tags[0]}
                          {m.tags.length > 1 ? ` +${m.tags.length - 1}` : ''}
                        </span>
                      )}
                      <button
                        className="icon-btn motto-more"
                        title="功能菜单"
                        onClick={(e) => {
                          // ⋯ 不参与单击防抖（无双击语义），立即开菜单并掐掉行的单击定时器
                          e.stopPropagation()
                          if (clickTimer.current != null) {
                            window.clearTimeout(clickTimer.current)
                            clickTimer.current = null
                          }
                          const anchor = e.currentTarget as HTMLElement
                          setMenuFor((cur) => (cur?.id === m.id ? null : { id: m.id, anchor }))
                        }}
                      >
                        <span className="material-symbols-outlined">more_horiz</span>
                      </button>
                    </div>
                  </div>
```

紧随其后的 `tag-edit-row` 区块（562-596 行）**原样保留**，`</Fragment>` 结构不变。

- [x] **Step 4.5: 渲染菜单（605 行 `{/* 正式区笔记弹窗 */}` 注释之前插入）**

```tsx
      {/* 功能气泡菜单（优化建议区第14轮）：锚定行 / ⋯ 按钮，互斥单开 */}
      {menuFor &&
        (() => {
          const m = mottos.find((x) => x.id === menuFor.id)
          if (!m) return null
          return (
            <ActionMenu
              anchorEl={menuFor.anchor}
              items={mottoMenuItems(m)}
              onClose={() => setMenuFor(null)}
            />
          )
        })()}
```

- [x] **Step 4.6: App.css 改造格言行样式**

230-256 行区块（注释 + `.motto-row`/`.motto-content`/`.motto-sub`/`.motto-source`）替换为：

```css
/* 格言行单行布局（优化建议区第14轮）：正文占左自动换行（3 行保险上限），
   出处/标签/菜单按钮尾部收纳；行可拖拽排序，单击开功能气泡菜单、双击开笔记 */
.motto-row {
  cursor: grab;
}
.motto-row .motto-content {
  flex: 1;
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.motto-tail {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  font-size: 0.8em;
  color: var(--color-text-secondary);
}
.motto-tail .motto-source {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

644-658 行旧 `.motto-tags`（chips 容器版）替换为（**注意：`.tag-chip.mini` 系列保留不删**——致知己 ZhijijiModule.tsx:585 仍在使用）：

```css
/* 行尾标签小字（首个标签名 + 溢出计数；优化建议区第14轮单行布局） */
.motto-tags {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}
.motto-tags .material-symbols-outlined {
  font-size: 14px;
}
.motto-more {
  padding: 2px;
}
```

- [x] **Step 4.7: 类型检查 + 构建**

Run: `npm run typecheck && npm run build`
Expected: 均通过。

---

### Task 5: 验证收尾 + 文档归档

**Files:**
- Modify: `docs/log/260905.md`（追加）
- Modify: `docs/project/优化建议区.md`（待完成条目 → 归档区第 14 轮）

- [ ] **Step 5.1: 人工冒烟清单（开发者 `npm run dev`，对照 spec 第 5 节）**

1. 三区行布局：长句换行（最多 3 行）、无出处显示「——（出处待补）」、多标签显示「标签 +N」、AI 徽章在序号旁
2. 单击行开菜单；点另一行切换；Esc / 点菜单外 / 滚动列表关闭
3. 双击正式区行打开笔记弹窗；草稿/沉淀区双击无事；双击过程菜单不闪现
4. 拖拽排序正常，拖拽不触发菜单
5. 各菜单项动作正确且菜单自动关：标签展开行内编辑条、编辑弹窗、复制 toast、区流转、查看笔记、丢弃二次确认
6. AI 解读全链路：边栏展开 → 切「格言·解读」→ 自动发送 → 用户消息即时上屏 → AI 回复；三区均可触发
7. LLM 未配置时点解读 → 边栏「去配置」提示（与万象问 AI 同款）
8. 新频道内自由对话、会话切换/新建/删除/改名正常；重启后恢复激活会话与频道

- [x] **Step 5.2: 追加 `docs/log/260905.md` 开发记录**（当日已有文件则追加小节；记录本次改动文件清单与要点，格式参照该文件既有条目）

- [x] **Step 5.3: 归档 `docs/project/优化建议区.md`**

「待完成」区该条目移除；归档区顶部按既有格式新增：

```markdown
### 第14轮（260905）：格言功能气泡菜单 + 格言·解读频道

- [X]  格言库新增一个解读的功能——点击以后自动把当前句子输入到AI助手——格言·解读的频道（需要新创建这个频道）。把每条格言后面的功能图标改成气泡浮窗：单击行召唤功能菜单（AI 解读/编辑/标签/复制/区流转/查看笔记/丢弃，按区显示），双击行打开笔记弹窗（正式区），空出的右侧空间放出处——单行呈现，小字体+浅色与格言区分。（260905 完成：新建通用 ActionMenu 组件 fixed 锚定+防溢出+portal；行布局单行化——正文左、出处右、标签计数行尾；新增 motto 频道零 DB 迁移，AiChannel/CHANNELS/ACTIVE_SESSION_KEYS/CHANNEL_PERSONAS 同步扩展，格言库模块映射新频道，解读经 openAiWith(text,{auto:true}) 复用 pending 机制自动发送，AiSidebar 发送链路零改动；单击 260ms 防抖让路双击，⋯按钮免防抖直达）
```

- [x] **Step 5.4: 最终验证**

Run: `npm run typecheck && npm run build`
Expected: 通过。完成后由开发者自行 git 提交（AI 不执行 git 操作）。
