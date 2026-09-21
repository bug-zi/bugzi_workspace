# debugzi 统一会话流（频道降级为会话标签）实施计划

> **已实施归档（260921 20:10）**：全部任务落地，typecheck 双配置 + build 通过，开发者确认效果；本文随 design 移入 `debugzi/archive/`，优化建议区归档为第48轮。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 debugzi 边栏常驻 7 频道 pill 条，频道降级为会话属性标签——边栏变为「全量会话列表 + 聊天区」，模块动作照旧自动切入对应场景会话。

**Architecture:** 数据层零迁移（`ai_sessions.channel` 已有）。主进程新增全量会话查询、`aiChat` 人设改为按会话 id 查 channel；激活键走双轨（新增全局键 `ai_active_session_global` 供边栏启动恢复，原 7 个 per-channel 键保留服务模块动作定位与拓展坞）。渲染层重排 `AiSidebar`（删 activeChannel 状态与频道条、全量列表 + 场景徽章、推送跟随切换），`ChannelChatPanel` 补写全局键。

**Tech Stack:** Electron 44 + React 19 + TypeScript（electron-vite）。无测试框架——验证手段为 `npm run typecheck`（双 tsconfig）+ `npm run build` + 人工冒烟。

**纪律（开发者指令，必须遵守）：**
- **禁止执行任何 git 命令**（add/commit/push 等全部）。本计划不含 commit 步骤，改动完成后由开发者自行提交。
- 设计依据：`docs/project/右侧边栏/debugzi/2026-09-21-debugzi统一会话流-design.md`（下称「设计文档」），实施前先通读。

---

### Task 1: 共享常量——SettingsKeys 增全局键、删 AiActiveChannel

**Files:**
- Modify: `src/shared/types.ts:58-64`

- [ ] **Step 1.1: 删除 AiActiveChannel、新增 AiActiveSessionGlobal**

将（SettingsKeys 对象内）：

```ts
  AiActiveSessionId: 'ai_active_session_id',
  // 频道制（DB v9）：当前所在频道 + 各频道独立激活会话（assistant 沿用 AiActiveSessionId）
  AiActiveChannel: 'ai_active_channel',
  AiActiveSessionMotto: 'ai_active_session_motto',
```

替换为：

```ts
  AiActiveSessionId: 'ai_active_session_id',
  // 频道制（DB v9）：各场景独立激活会话（assistant 沿用 AiActiveSessionId）。
  // 统一会话流（优化建议区第48轮）：新增全局键=边栏当前会话（启动恢复「最后聊过的会话」）；
  // per-channel 键保留，服务模块动作场景定位与弹窗拓展坞。原 AiActiveChannel 键废弃删除（DB 旧行无害留存）。
  AiActiveSessionGlobal: 'ai_active_session_global',
  AiActiveSessionMotto: 'ai_active_session_motto',
```

- [ ] **Step 1.2: 验证无残留引用**

Run: `grep -rn "AiActiveChannel" src electron`
Expected: 无输出（Task 4 会删掉 AiSidebar 中最后两处使用；若此时仍有引用属预期，Task 4 完成后复查一次）。

---

### Task 2: 主进程 services——全量列表 + 人设按会话查

**Files:**
- Modify: `electron/ai/services.ts:29-34`（listAiSessions 附近）、`electron/ai/services.ts:301-325`（aiChat）

- [ ] **Step 2.1: 新增 listAllAiSessions**

在 `listAiSessions` 函数（`electron/ai/services.ts:30`）之后紧挨着新增：

```ts
/** 全量会话列表（跨场景；统一会话流：边栏一个列表看全部会话，最近活跃在前） */
export function listAllAiSessions(): AiSession[] {
  return getDb()
    .prepare('SELECT * FROM ai_sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC')
    .all() as unknown as AiSession[]
}
```

- [ ] **Step 2.2: aiChat 人设改按会话 channel**

在 `aiChat`（`electron/ai/services.ts:301`）函数体开头（`autoTitleSession` 调用之前）插入：

```ts
  // 人设以会话归属为准（统一会话流）：按会话 id 查 channel，渲染层传参仅作会话不存在时的兜底
  const sess = getDb()
    .prepare('SELECT channel FROM ai_sessions WHERE id = ?')
    .get(sessionId) as { channel: string } | undefined
  const ch = ((sess?.channel as AiChannel | undefined) ?? channel) ?? 'assistant'
```

然后将 system prompt 拼装数组中的（`electron/ai/services.ts:318`）：

```ts
    CHANNEL_PERSONAS[channel] ?? CHANNEL_PERSONAS.assistant,
```

替换为：

```ts
    CHANNEL_PERSONAS[ch] ?? CHANNEL_PERSONAS.assistant,
```

函数签名与 IPC 通道不变（`channel` 参数保留作兜底，`ai:chat` 处理器零改动）。

---

### Task 3: IPC 透传 + 渲染层类型契约

**Files:**
- Modify: `electron/ipc.ts:536-538`（aiSession:list 处理器）及顶部 './ai/services' import 行
- Modify: `src/renderer/api.d.ts:997-998`（aiSession.list 注释）

- [ ] **Step 3.1: ipc.ts import 补 listAllAiSessions**

在 `electron/ipc.ts` 顶部从 `./ai/services` 的既有 import 花括号中加入 `listAllAiSessions`（与 `listAiSessions` 同一条 import）。

- [ ] **Step 3.2: aiSession:list 支持全量**

将：

```ts
  ipcMain.handle('aiSession:list', (_e, channel?: string) =>
    listAiSessions((channel ?? 'assistant') as AiChannel)
  )
```

替换为：

```ts
  ipcMain.handle('aiSession:list', (_e, channel?: string) =>
    // 统一会话流：不传 channel = 全部场景（边栏全量列表）；传 channel = 该场景（模块动作定位/拓展坞）
    channel == null ? listAllAiSessions() : listAiSessions(channel as AiChannel)
  )
```

（preload.ts `list(channel?: string)` 透传签名本就兼容，零改动。）

- [ ] **Step 3.3: api.d.ts 注释同步**

将 `src/renderer/api.d.ts` 中：

```ts
    /** 会话列表（最近活跃在前，按频道隔离） */
    list(channel?: AiChannel): Promise<AiSessionRow[]>
```

替换为：

```ts
    /** 会话列表（最近活跃在前）；统一会话流：不传 channel = 全部场景，传 channel = 该场景（拓展坞/模块定位） */
    list(channel?: AiChannel): Promise<AiSessionRow[]>
```

---

### Task 4: AiSidebar.tsx 重构（核心）

**Files:**
- Modify: `src/components/AiSidebar.tsx`（多段，逐段给出）

- [ ] **Step 4.1: 头注释与常量区**

① 文件首行注释改为：

```tsx
// AI 助手边栏（统一会话流，优化建议区第48轮）：全量会话列表 + 场景标签 + 模块感知 + 多会话管理 + 系统消息推送 + 画像建议卡片
```

② `CHANNELS` 数组的注释改为（数组内容不动）：

```tsx
/** 场景清单（统一会话流：频道降级为会话属性标签，仅用于列表徽章 / 头部指示 / tooltip） */
```

③ `CHANNELS` 数组之后新增：

```tsx
const channelInfo = (ch: AiChannel): { label: string; icon: string } =>
  CHANNELS.find((c) => c.id === ch) ?? { label: '助手', icon: 'forum' }
```

④ `ACTIVE_SESSION_KEYS` 注释改为：

```tsx
/** 各场景激活会话的 settings key（与主进程 services.ACTIVE_SESSION_KEYS 同步；模块动作场景定位与拓展坞继续使用） */
```

⑤ `persistActive` 函数之后新增两件：

```tsx
/** 边栏当前会话（全局键）落库：启动恢复「最后聊过的会话」（统一会话流） */
async function persistGlobalActive(id: number | null): Promise<void> {
  await window.api.settings.set(SettingsKeys.AiActiveSessionGlobal, id == null ? '' : String(id))
}

/** 列表中找会话场景（找不到按助手） */
function channelOf(id: number, list: AiSessionRow[]): AiChannel {
  return list.find((s) => s.id === id)?.channel ?? 'assistant'
}
```

- [ ] **Step 4.2: 状态区——删 activeChannel state，改派生**

删除这两行 state 与 ref：

```tsx
  const [activeChannel, setActiveChannel] = useState<AiChannel>('assistant')
```

```tsx
  const activeChannelRef = useRef<AiChannel>('assistant')
  activeChannelRef.current = activeChannel
```

在 `keepScrollRef` 声明之后新增：

```tsx
  /** 派生：当前会话行与场景（统一会话流：场景跟随会话，非独立状态） */
  const activeSessionRow = sessions.find((s) => s.id === activeId) ?? null
  const activeChannel: AiChannel = activeSessionRow?.channel ?? 'assistant'
  const activeChannelRef = useRef<AiChannel>('assistant')
  activeChannelRef.current = activeChannel
```

- [ ] **Step 4.3: loadSessions 全量化 + initSessions 取代 loadForChannel**

① `loadSessions` 改为（返回列表供跟随切换复用）：

```tsx
  const loadSessions = async (): Promise<AiSessionRow[]> => {
    const list = await window.api.aiSession.list()
    setSessions(list)
    return list
  }
```

② 整体删除 `loadForChannel` 函数（约 150-168 行），原位新增：

```tsx
  /** 初始化会话流：全量列表 + 恢复全局激活会话（失效回退全量最近；空库则无激活） */
  const initSessions = async (): Promise<void> => {
    setDispositionSid(null)
    const list = await loadSessions()
    let aid: number | null = null
    try {
      const saved = await window.api.settings.get(SettingsKeys.AiActiveSessionGlobal)
      const n = saved ? Number(saved) : NaN
      if (Number.isInteger(n) && n > 0 && list.some((s) => s.id === n)) aid = n
    } catch {
      /* 读失败走回退 */
    }
    if (aid == null && list.length > 0) aid = list[0].id
    activeIdRef.current = aid
    // 命令式同步 ref（render 前后续异步链路依赖，同旧 loadForChannel 手法）
    activeChannelRef.current = aid != null ? channelOf(aid, list) : 'assistant'
    setActiveId(aid)
    if (aid != null) {
      await persistActive(aid, channelOf(aid, list))
      await persistGlobalActive(aid)
      await loadMessages(aid)
    } else {
      setMessages([])
    }
  }
```

③ 初始化 effect（约 170-190 行）整体替换为：

```tsx
  // 初始化：恢复全局激活会话（最后聊过的会话）+ 恢复保存的边栏宽度
  useEffect(() => {
    void (async () => {
      await initSessions()
      const savedW = await window.api.settings.get(SettingsKeys.AiWidth)
      const w = savedW ? Number(savedW) : NaN
      if (Number.isFinite(w) && w >= AI_WIDTH_MIN && w <= AI_WIDTH_MAX) {
        setAiWidth(w)
        applyAiWidth(w)
      }
    })()
  }, [])
```

- [ ] **Step 4.4: 推送跟随切换 + messagesVersion effect**

① onMessage effect（约 192-200 行）整体替换为：

```tsx
  // 系统消息/预言家推送到达 → 刷新全量列表并跟随切换到接收会话（统一流下推送必达可见）
  useEffect(() => {
    return window.api.ai.onMessage((msg) => {
      void (async () => {
        const list = await loadSessions()
        const m = msg as AiMessageRow | null
        if (m && typeof m === 'object') await followSession(m.session_id, list)
      })()
    })
  }, [])
```

② messagesVersion effect（约 202-209 行）整体替换为：

```tsx
  // 辩真阁验证流程触发展开（App 层 messagesVersion）
  useEffect(() => {
    if (messagesVersion > 0) {
      void (async () => {
        await loadSessions()
        const aid = activeIdRef.current
        if (aid != null) await loadMessages(aid)
      })()
    }
  }, [messagesVersion])
```

③ 在 `loadMessages` 定义之后（组件内任意靠近位置，建议跟在 initSessions 后）新增：

```tsx
  /** 跟随切换到指定会话（推送必达）：与手动切换同口径写双键；已是当前会话则仅重载消息 */
  const followSession = async (id: number, list: AiSessionRow[]): Promise<void> => {
    if (id === activeIdRef.current) {
      await loadMessages(id)
      return
    }
    if (!list.some((s) => s.id === id)) return
    activeIdRef.current = id
    activeChannelRef.current = channelOf(id, list)
    setActiveId(id)
    await persistActive(id, channelOf(id, list))
    await persistGlobalActive(id)
    await loadMessages(id)
  }
```

- [ ] **Step 4.5: 删 switchChannel，pending 改走 focusChannelSession**

① 整体删除 `switchChannel` 函数（约 243-252 行）。

② pending effect（约 254-272 行）整体替换为：

```tsx
  // 模块动作请求（万象问AI预填/致知己追问自动发送/辩真验证推送/格言解读直发）：定位场景会话再动作
  useEffect(() => {
    if (!pending) return
    let cancelled = false
    void (async () => {
      try {
        await focusChannelSession(pending.channel)
        if (cancelled) return
        if (pending.auto) await sendText(pending.text)
        else if (pending.text) setInput(pending.text)
      } finally {
        if (!cancelled) onPendingConsumed()
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])
```

③ 紧跟 pending effect 之后新增：

```tsx
  /** 定位某场景的会话并切换过去（模块动作入口）：场景激活键 → 校验 → 场景最近会话 → 都无则新建场景会话；双键落库 */
  const focusChannelSession = async (ch: AiChannel): Promise<void> => {
    const scoped = await window.api.aiSession.list(ch)
    const active = await window.api.aiSession.active(ch)
    let target = active != null && scoped.some((s) => s.id === active) ? active : (scoped[0]?.id ?? null)
    if (target == null) {
      const s = await window.api.aiSession.create(ch)
      await persistActive(s.id, ch)
      setSessions((arr) => [s, ...arr])
      target = s.id
    }
    if (target === activeIdRef.current) return
    activeIdRef.current = target
    // 命令式同步 ref：target 必属场景 ch（scoped 列表或新建），render 前 pending.auto 的 sendText 即依赖它
    activeChannelRef.current = ch
    setActiveId(target)
    setPanelOpen(false)
    setRenamingId(null)
    await persistActive(target, ch)
    await persistGlobalActive(target)
    await loadMessages(target)
  }
```

- [ ] **Step 4.6: switchSession / newSession / commitRename**

① `switchSession` 整体替换为：

```tsx
  /** 切换会话（全量列表，跨场景）：写全局键 + 该会话场景激活键（模块动作可接上） */
  const switchSession = async (id: number): Promise<void> => {
    setDispositionSid(null)
    if (id === activeId) {
      setPanelOpen(false)
      return
    }
    if (!sessions.some((s) => s.id === id)) return
    activeIdRef.current = id
    activeChannelRef.current = channelOf(id, sessions)
    setActiveId(id)
    setPanelOpen(false)
    setRenamingId(null)
    await persistActive(id, channelOf(id, sessions))
    await persistGlobalActive(id)
    await loadMessages(id)
  }
```

② `newSession` 整体替换为（「＋」只开助手会话——设计决策 #3）：

```tsx
  /** 新建会话（「＋」只开助手会话）并切换过去 */
  const newSession = async (): Promise<void> => {
    const s = await window.api.aiSession.create('assistant')
    await persistActive(s.id, 'assistant')
    await persistGlobalActive(s.id)
    setSessions((arr) => [s, ...arr])
    activeIdRef.current = s.id
    activeChannelRef.current = 'assistant'
    setActiveId(s.id)
    setMessages([])
    setPanelOpen(false)
  }
```

③ `commitRename` 内 `await loadSessions(activeChannelRef.current)` 改为 `await loadSessions()`。

- [ ] **Step 4.7: sendText 两处**

① `/compact` 分支（约 337-342 行）将：

```tsx
        const ns = await window.api.aiSession.compact(jobId, sid)
        await persistActive(ns.id, activeChannelRef.current)
        activeIdRef.current = ns.id
        setActiveId(ns.id)
        await loadSessions(activeChannelRef.current)
        await loadMessages(ns.id)
```

替换为：

```tsx
        const ns = await window.api.aiSession.compact(jobId, sid)
        await persistActive(ns.id, ns.channel)
        await persistGlobalActive(ns.id)
        activeIdRef.current = ns.id
        setActiveId(ns.id)
        await loadSessions()
        await loadMessages(ns.id)
```

② 主发送分支（约 358-380 行）将：

```tsx
    const channel = activeChannelRef.current
    let sid = activeIdRef.current
    try {
      if (sid == null) {
        // 无激活会话（如全删光后直接发消息）→ 在当前频道自动新建
        const s = await window.api.aiSession.create(channel)
        await persistActive(s.id, channel)
        sid = s.id
        activeIdRef.current = sid
        setSessions((arr) => [s, ...arr])
        setActiveId(sid)
      }
```

替换为：

```tsx
    const channel = activeChannelRef.current
    let sid = activeIdRef.current
    try {
      if (sid == null) {
        // 无激活会话（如全删光后直接发消息）→ 新建助手会话（「＋」同语义）
        const s = await window.api.aiSession.create('assistant')
        await persistActive(s.id, 'assistant')
        await persistGlobalActive(s.id)
        sid = s.id
        activeIdRef.current = sid
        setSessions((arr) => [s, ...arr])
        setActiveId(sid)
      }
```

并将同分支尾部：

```tsx
      await window.api.ai.chat(jobId, t, currentModule, sid, channel)
      await loadSessions(channel) // 首条消息自动命名 + updated_at 排序变化
      await loadMessages(sid)
      if (isDispositionChannel(channel)) setDispositionSid(sid)
```

替换为：

```tsx
      await window.api.ai.chat(jobId, t, currentModule, sid, channel)
      await loadSessions() // 首条消息自动命名 + updated_at 排序变化
      await loadMessages(sid)
      if (isDispositionChannel(channel)) setDispositionSid(sid)
```

- [ ] **Step 4.8: doDelete 会话分支**

将（约 455-467 行）：

```tsx
    if (target.kind === 'session') {
      const channel = activeChannelRef.current
      await window.api.aiSession.delete(target.id, channel)
      const [list, active] = await Promise.all([
        window.api.aiSession.list(channel),
        window.api.aiSession.active(channel)
      ])
      setSessions(list)
      activeIdRef.current = active
      setActiveId(active)
      if (active != null) await loadMessages(active)
      else setMessages([])
      setPanelOpen(list.length > 0)
    }
```

替换为：

```tsx
    if (target.kind === 'session') {
      await window.api.aiSession.delete(target.id, channelOf(target.id, sessions))
      const list = await loadSessions()
      const wasActive = activeIdRef.current === target.id
      const next = wasActive ? (list[0]?.id ?? null) : activeIdRef.current
      if (wasActive) {
        await persistGlobalActive(next)
        if (next != null) await persistActive(next, channelOf(next, list))
      }
      activeIdRef.current = next
      activeChannelRef.current = next != null ? channelOf(next, list) : 'assistant'
      setActiveId(next)
      if (next != null) await loadMessages(next)
      else setMessages([])
      setPanelOpen(list.length > 0)
    }
```

- [ ] **Step 4.9: UI——头部 pill、删频道条、浮层徽章、空态、placeholder**

① render 函数体内（约 519-520 行）删除：

```tsx
  const channelLabel = CHANNELS.find((c) => c.id === activeChannel)?.label ?? '助手'
  const activeSessionRow = sessions.find((s) => s.id === activeId) ?? null
```

替换为：

```tsx
  const sessionLabel = channelInfo(activeChannel).label
```

② 头部（约 525-534 行）整体替换为（插入场景 pill）：

```tsx
      <div className="ai-header">
        <span className="material-symbols-outlined">forum</span>
        <span className="ai-title">{AI_NAME}</span>
        {activeChannel !== 'assistant' && (
          <span
            className="ai-head-pill"
            title={`当前会话场景：${channelInfo(activeChannel).label}（人设与历史独立）`}
          >
            {channelInfo(activeChannel).label}
          </span>
        )}
        <button className="btn btn-ghost" onClick={() => setPanelOpen((v) => !v)} title="会话列表">
          <span className="material-symbols-outlined">list</span>
        </button>
        <button className="btn btn-ghost" onClick={onCollapse} title="收起">
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
```

③ 整体删除频道条区块（约 535-548 行，含注释）：

```tsx
      {/* 频道切换条（常驻顶部，随时可切；各频道独立会话历史与人设） */}
      <div className="ai-channels">
        {CHANNELS.map((c) => (
          ...
        ))}
      </div>
```

④ 会话浮层头（约 554-555 行）`<span>会话（{channelLabel}）</span>` 改为 `<span>会话</span>`。

⑤ 会话行（`sessions.map` 内，约 562-568 行）在行容器 div 开标签之后、`{renamingId === s.id ...}` 之前插入场景徽章：

```tsx
                    <span className="ai-session-badge" title={channelInfo(s.channel).label}>
                      <span className="material-symbols-outlined">{channelInfo(s.channel).icon}</span>
                    </span>
```

⑥ 空态（约 620-624 行）整体替换为：

```tsx
            <div className="ai-empty">
              新对话将以 {AI_NAME} 助手身份回答（感知当前模块：{moduleLabel(currentModule)}）
            </div>
```

⑦ 输入框 placeholder（约 714 行）`placeholder={`问 ${AI_NAME}（${channelLabel}｜${moduleLabel(currentModule)}）`}` 改为：

```tsx
          placeholder={`问 ${AI_NAME}（${sessionLabel}｜${moduleLabel(currentModule)}）`}
```

⑧ 三选条条件（约 689-692 行）与 `SaveChatDialog`（约 729-740 行）中的 `activeChannel` 引用**不需要改**——Step 4.2 已将其变为派生值，原表达式语义自动成立（三选条按当前会话场景判断）。逐一目检确认即可。

---

### Task 5: AiSidebar.css——删频道条样式、增 pill 与徽章

**Files:**
- Modify: `src/components/AiSidebar.css:52-83`（.ai-channels / .ai-channel 系列）

- [ ] **Step 5.1: 删除频道条样式块**

整体删除以下选择器及其规则（约 52-83 行，以文件实际为准）：`.ai-channels`、`.ai-channel`、`.ai-channel .material-symbols-outlined`、`.ai-channel:hover`、`.ai-channel.active`。

- [ ] **Step 5.2: 新增头部 pill 与场景徽章样式**

在删除位置新增（配色全走既有主题变量，零彩亮）：

```css
/* 头部场景指示 pill（统一会话流：当前会话非助手场景时显示） */
.ai-head-pill {
  flex-shrink: 0;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--color-primary);
  background: var(--color-primary-soft);
  color: var(--color-text);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 0.72em;
}

/* 会话列表行场景徽章 */
.ai-session-badge {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary-soft);
  color: var(--color-text-secondary);
}
.ai-session-badge .material-symbols-outlined {
  font-size: 13px;
}
```

（若 `.ai-session-item` 为 flex 布局则徽章天然行首对齐；冒烟时目检行内对齐，必要时微调 margin。）

---

### Task 6: ChannelChatPanel.tsx——激活键双轨

**Files:**
- Modify: `src/components/ChannelChatPanel.tsx`（模块级 helper + 5 处调用点）

- [ ] **Step 6.1: 确认 import**

确认文件顶部已 `import { SettingsKeys } from '../shared/types'`（该文件现从 '../renderer/api' 引类型、从 './Toast' 引 hook；若无 SettingsKeys import 则补充）。

- [ ] **Step 6.2: 新增双键 helper**

模块级（`clampChatPanelW` 附近）新增：

```tsx
/** 激活会话双键落库：场景键（本栏定位）+ 全局键（边栏启动恢复口径，统一会话流） */
async function persistActiveBoth(sessionKey: string, id: number | null): Promise<void> {
  await window.api.settings.set(sessionKey, id == null ? '' : String(id))
  await window.api.settings.set(SettingsKeys.AiActiveSessionGlobal, id == null ? '' : String(id))
}
```

- [ ] **Step 6.3: 替换全部 5 处单键写入**

以下 5 处 `window.api.settings.set(sessionKey, String(x))` 全部替换为 `persistActiveBoth(sessionKey, x)`：

1. `switchSession`（约 165 行）：`await window.api.settings.set(sessionKey, String(id))` → `await persistActiveBoth(sessionKey, id)`
2. `newSession`（约 173 行）：`await window.api.settings.set(sessionKey, String(s.id))` → `await persistActiveBoth(sessionKey, s.id)`
3. `concludeToNewSession`（约 201 行）：同上 → `await persistActiveBoth(sessionKey, s.id)`
4. `sendText` 的 `/compact` 分支（约 254 行）：`await window.api.settings.set(sessionKey, String(ns.id))` → `await persistActiveBoth(sessionKey, ns.id)`
5. `sendText` 的无会话兜底分支（约 277 行）：`await window.api.settings.set(sessionKey, String(s.id))` → `await persistActiveBoth(sessionKey, s.id)`

验证：`grep -n "settings.set(sessionKey" src/components/ChannelChatPanel.tsx` 应无输出。

---

### Task 7: 类型检查与构建

- [ ] **Step 7.1: typecheck 双配置**

Run: `npm run typecheck`
Expected: main 与 renderer 两个 tsconfig 均 0 error。若报 `AiActiveChannel` 残留引用，回 Task 1 Step 1.2 复查。

- [ ] **Step 7.2: build**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 7.3: 复查废弃键残留**

Run: `grep -rn "AiActiveChannel" src electron`
Expected: 无输出。

---

### Task 8: 人工冒烟（开发者执行，按设计文档 §6 清单）

- [ ] 频道条消失；头部场景 pill 跟随当前会话场景变化；助手会话无 pill
- [ ] 会话浮层全量平铺、徽章正确、跨场景切换流畅；重启恢复最后聊过的会话
- [ ] 五条模块动作路径：格言「AI 解读」/ 万象「问 AI」划词 / 致知己「追问」/ 辩真验证推送 / 学习库划词（拓展坞）——均自动切入对应场景会话；场景无会话时自动新建
- [ ] 拓展坞与边栏同一会话两处一致；拓展坞切会话后边栏跟随
- [ ] 「＋」只开助手会话；人设抽查（万象会话讲解员口吻 / 致知己会话追问者口吻 / 助手通用口吻）
- [ ] 三选条仅 learn/wiki/zhijiji 会话出现；保存/归档后自动切助手新会话；归档入回收站「AI 会话」块可恢复
- [ ] `/clear` `/compact`、会话重命名、删除会话（删激活会话回退全量最近）
- [ ] LLM 未配置「去配置」；双主题目检

---

### Task 9: 文档同步与归档（冒烟通过后）

**Files:**
- Modify: `docs/project/右侧边栏/debugzi/design.md`
- Modify: `docs/project/右侧边栏/右侧边栏.md`
- Modify: `docs/project/右侧边栏/debugzi/designs-specs.md`（仅头部增注记）
- Modify: `CLAUDE.md`
- Modify: `docs/project/优化建议区.md`
- Modify: `docs/log/260921.md`（追加小节）
- Move: 本 design + plan 两份文档 → `docs/project/右侧边栏/debugzi/archive/`

- [ ] **Step 9.1: debugzi/design.md**——「§2 频道制」改写为「统一会话流」（频道降级为会话属性标签：无频道条、全量会话列表 + 场景徽章、头部场景 pill、「＋」只开助手、模块动作定位不变、全局激活键双轨、人设按会话查、推送跟随切换）；「§3 会话制」的「按频道隔离」表述改「全量列表」；「§7 版本演进摘要」表追加一行：`| 第 48 轮 | 统一会话流（频道降级为会话标签，删除常驻频道条） |`。

- [ ] **Step 9.2: 右侧边栏.md**——「使用」第 3 条改写：频道 pill 切换 → 全量会话列表 + 场景徽章；补一句全局激活会话口径。

- [ ] **Step 9.3: debugzi/designs-specs.md**——文件头部追加「增量注记（260921 第 48 轮）：统一会话流」小节，指向 design.md 与归档 plan，不重写全文。

- [ ] **Step 9.4: CLAUDE.md**——「全局硬性规则」三栏布局 bullet 中右侧边栏描述改为统一会话流口径（可收起/展开，全量会话列表 + 会话场景标签，模块动作自动切入对应场景会话；三选条限学习·问答/万象·问答/致知己·追问三类会话——按会话场景判断，保存/归档后自动切新会话）。

- [ ] **Step 9.5: 优化建议区.md**——待完成区该条目勾结并移入归档区：顶部新增「### 第 48 轮（260921）：debugzi 统一会话流（频道降级为会话标签）」小节（归档规则：新轮次插最上方），条目保留原始描述并附完成说明（实施要点 + 待冒烟项），格式对齐第 47 轮条目。

- [ ] **Step 9.6: dev log**——`docs/log/260921.md` 追加本轮小节，标题下附 `> 创建于 YYYY-MM-DD HH:MM`（用 bash `date "+%Y-%m-%d %H:%M"` 取实际时间，不估不编）；记录设计决策、改动面、typecheck/build 结果与冒烟清单。

- [ ] **Step 9.7: 文档归档**——将 `2026-09-21-debugzi统一会话流-design.md` 与 `2026-09-21-debugzi统一会话流-plan.md` 移入 `docs/project/右侧边栏/debugzi/archive/`（文件移动，非 git 操作）。
