// AI 助手边栏（统一会话流，优化建议区第48轮）：全量会话列表 + 场景标签 + 模块感知 + 多会话管理 + 系统消息推送 + 画像建议卡片
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { AiChannel, AiMessageRow, AiSessionRow } from '../renderer/api'
import { AI_NAME, SettingsKeys } from '../shared/types'
import ConfirmDialog from './ConfirmDialog'
import MdView from './MdView'
import { useToast } from './Toast'
import {
  ChatDispositionBar,
  SaveChatDialog,
  buildChatTranscriptMd,
  isDispositionChannel,
  type DispositionChannel
} from './ChatDisposition'
import './AiSidebar.css'

export interface AiSidebarProps {
  /** 收起（右缘面板互斥制：debugzi / 草稿本 / 都收起，优化建议区第21轮） */
  collapsed: boolean
  /** 都收起时由本组件渲染右缘细条双图标入口（草稿本展开时不渲染，右缘让位） */
  showRail: boolean
  /** 展开 debugzi（细条图标） */
  onExpand: () => void
  /** 收起（头部按钮） */
  onCollapse: () => void
  /** 细条上切到草稿本 */
  onOpenDraft: () => void
  /** 细条上切到资源管理器 */
  onOpenFiles: () => void
  /** 细条上切到画布 */
  onOpenCanvas: () => void
  currentModule: string
  /** 模块动作带来的频道请求（万象问AI/辩真验证/致知己追问）：auto 时切频道后自动发送 */
  pending: { text: string; channel: AiChannel; auto: boolean } | null
  onPendingConsumed: () => void
  /** 系统消息（辩真阁验证过程）触发展开 */
  messagesVersion: number
  onNavigateToProfile: () => void
}

const ROLE_LABEL: Record<string, string> = { user: '我', assistant: AI_NAME, system: '系统' }

/** 场景清单（统一会话流：频道降级为会话属性标签，仅用于列表徽章 / 头部指示 / tooltip） */
const CHANNELS: { id: AiChannel; label: string; icon: string }[] = [
  { id: 'assistant', label: '助手', icon: 'forum' },
  { id: 'motto', label: '格言·解读', icon: 'psychology' },
  { id: 'learn', label: '学习·问答', icon: 'school' },
  { id: 'wiki', label: '万象·问答', icon: 'public' },
  { id: 'zhijiji', label: '致知己·追问', icon: 'self_improvement' },
  { id: 'verify', label: '辩真·核查', icon: 'fact_check' },
  { id: 'prophet', label: '致知己·预言家', icon: 'auto_awesome' },
  { id: 'literature', label: '文献·追问', icon: 'auto_stories' }
]

const channelInfo = (ch: AiChannel): { label: string; icon: string } =>
  CHANNELS.find((c) => c.id === ch) ?? { label: '助手', icon: 'forum' }

/** 各场景激活会话的 settings key（与主进程 services.ACTIVE_SESSION_KEYS 同步；模块动作场景定位与拓展坞继续使用） */
const ACTIVE_SESSION_KEYS: Record<AiChannel, string> = {
  assistant: SettingsKeys.AiActiveSessionId,
  motto: SettingsKeys.AiActiveSessionMotto,
  wiki: SettingsKeys.AiActiveSessionWiki,
  zhijiji: SettingsKeys.AiActiveSessionZhijiji,
  verify: SettingsKeys.AiActiveSessionVerify,
  learn: SettingsKeys.AiActiveSessionLearn,
  prophet: SettingsKeys.AiActiveSessionProphet,
  literature: SettingsKeys.AiActiveSessionLiterature
}

/** 画像提炼协议标记（主进程 PROFILE_SUGGEST_INSTRUCTION 约定）：<<<PROFILE_SUGGEST:类别|内容>>> */
const PROFILE_SUGGEST_RE = /^<<<PROFILE_SUGGEST:([^|>]+)\|([^>]*)>>>\s*$/m

/** 助手消息拆分：正文 + 画像建议（无标记则 suggest 为 null） */
function splitSuggest(content: string): { body: string; suggest: { category: string; content: string } | null } {
  const m = content.match(PROFILE_SUGGEST_RE)
  if (!m) return { body: content, suggest: null }
  return {
    body: content.replace(PROFILE_SUGGEST_RE, '').trimEnd(),
    suggest: { category: m[1].trim(), content: m[2].trim() }
  }
}

/** 边栏宽度拖拽范围（px，优化建议区「拖拽调整窗口大小」；默认值同 global.css --ai-width） */
const AI_WIDTH_MIN = 280
const AI_WIDTH_MAX = 560
const AI_WIDTH_DEFAULT = 320

const clampAiWidth = (w: number): number => Math.min(AI_WIDTH_MAX, Math.max(AI_WIDTH_MIN, Math.round(w)))

/** 宽度写 :root 的 --ai-width（样式即生效） */
function applyAiWidth(w: number): void {
  document.documentElement.style.setProperty('--ai-width', `${w}px`)
}

/** 待确认的删除操作（会话或单条消息，均需二次确认） */
type ConfirmTarget = { kind: 'session'; id: number; title: string } | { kind: 'message'; id: number }

/** 某频道的激活会话落库（主进程系统消息推送按频道读它） */
async function persistActive(id: number | null, channel: AiChannel): Promise<void> {
  await window.api.settings.set(ACTIVE_SESSION_KEYS[channel], id == null ? '' : String(id))
}

/** 边栏当前会话（全局键）落库：启动恢复「最后聊过的会话」（统一会话流） */
async function persistGlobalActive(id: number | null): Promise<void> {
  await window.api.settings.set(SettingsKeys.AiActiveSessionGlobal, id == null ? '' : String(id))
}

/** 列表中找会话场景（找不到按助手） */
function channelOf(id: number, list: AiSessionRow[]): AiChannel {
  return list.find((s) => s.id === id)?.channel ?? 'assistant'
}

export default function AiSidebar(props: AiSidebarProps) {
  const {
    collapsed,
    showRail,
    onExpand,
    onCollapse,
    onOpenDraft,
    onOpenFiles,
    onOpenCanvas,
    currentModule,
    pending,
    onPendingConsumed,
    messagesVersion,
    onNavigateToProfile
  } = props
  const { toast } = useToast()
  const [sessions, setSessions] = useState<AiSessionRow[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [messages, setMessages] = useState<AiMessageRow[]>([])
  const [panelOpen, setPanelOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendJob, setSendJob] = useState<string | null>(null)
  const [needConfig, setNeedConfig] = useState(false)
  const [aiWidth, setAiWidth] = useState(AI_WIDTH_DEFAULT)
  // 三选条（优化建议区第47轮）：本轮 AI 回复后待处置的会话 id；null=已消费/无
  const [dispositionSid, setDispositionSid] = useState<number | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [archiveAsk, setArchiveAsk] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const activeIdRef = useRef<number | null>(null)
  activeIdRef.current = activeId
  const sendingRef = useRef(false)
  /** 删除消息后要恢复的滚动位置（null = 正常滚底） */
  const keepScrollRef = useRef<number | null>(null)
  /** 派生：当前会话行与场景（统一会话流：场景跟随会话，非独立状态） */
  const activeSessionRow = sessions.find((s) => s.id === activeId) ?? null
  const activeChannel: AiChannel = activeSessionRow?.channel ?? 'assistant'
  const activeChannelRef = useRef<AiChannel>('assistant')
  activeChannelRef.current = activeChannel

  const loadMessages = async (sessionId: number): Promise<void> => {
    setMessages(await window.api.ai.messages(sessionId))
  }

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

  const loadSessions = async (): Promise<AiSessionRow[]> => {
    const list = await window.api.aiSession.list()
    setSessions(list)
    return list
  }

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

  // 滚动到底；删除消息后恢复原位置（优化建议区：不跳回最下方）
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    if (keepScrollRef.current != null) {
      el.scrollTop = keepScrollRef.current
      keepScrollRef.current = null
      return
    }
    el.scrollTop = el.scrollHeight
  }, [messages, sending])

  /** 输入框高度自适应（优化建议区第17轮）：先还原 auto 测出内容真实高度再显式设高；
   *  基准仍为 rows=2，输入增多随之长高看全内容，超过 CSS max-height（30vh）后内部滚动 */
  const fitInput = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  // 输入或边栏宽度变化（折行数变化）→ 重算输入框高度
  useEffect(() => {
    fitInput()
  }, [input, aiWidth])

  // 窗口尺寸变化 → 折行与 30vh 上限随之变化，同步重算
  useEffect(() => {
    window.addEventListener('resize', fitInput)
    return () => window.removeEventListener('resize', fitInput)
  }, [])

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

  /** 新建会话（「＋」只开助手会话，优化建议区第48轮拍板）并切换过去 */
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

  /** 双击改名提交（Enter） */
  const commitRename = async (id: number): Promise<void> => {
    const title = renameText.trim()
    setRenamingId(null)
    if (!title) return
    await window.api.aiSession.rename(id, title)
    await loadSessions()
  }

  /** 发送一条消息（输入框发送与致知己追问 auto 复用；走当前频道人设） */
  const sendText = async (text: string): Promise<void> => {
    const t = text.trim()
    if (!t || sendingRef.current) return
    // 斜杠命令（优化建议区第14轮及修订）：/clear 清空当前会话；/compact 压缩当前会话上下文
    const cmd = t.match(/^\/(clear|compact)$/i)
    if (cmd) {
      const name = cmd[1].toLowerCase()
      const sid = activeIdRef.current
      if (name === 'clear') {
        if (sid == null) {
          toast('当前没有会话可清空')
          return
        }
        await window.api.aiSession.clear(sid)
        setMessages([])
        toast('已清空当前会话（上下文与记录一并清除）')
        return
      }
      if (sid == null) {
        toast('当前没有会话可压缩')
        return
      }
      sendingRef.current = true
      setSending(true)
      const jobId = crypto.randomUUID()
      setSendJob(jobId)
      try {
        const ns = await window.api.aiSession.compact(jobId, sid)
        await persistActive(ns.id, ns.channel)
        await persistGlobalActive(ns.id)
        activeIdRef.current = ns.id
        setActiveId(ns.id)
        await loadSessions()
        await loadMessages(ns.id)
        toast('已压缩为前情摘要（原会话保留在列表）')
      } catch (e) {
        const msg = String((e as Error).message)
        toast(msg.includes('已取消') ? '已取消' : `压缩失败：${msg.slice(0, 80)}`)
      } finally {
        sendingRef.current = false
        setSending(false)
        setSendJob(null)
      }
      return
    }
    sendingRef.current = true
    setSending(true)
    const jobId = crypto.randomUUID()
    setSendJob(jobId)
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
        activeChannelRef.current = 'assistant'
        setSessions((arr) => [s, ...arr])
        setActiveId(sid)
      }
      setDispositionSid(null) // 新一轮开始，上一轮的三选条收起
      // 乐观上屏（优化建议区第11轮）：用户消息先以负 id 临时显示（负 id 不渲染删除键），
      // 完成后 loadMessages 用 DB 真实记录替换；请求失败保留乐观消息（主进程先落库用户消息，显示与 DB 一致）
      setMessages((arr) => [
        ...arr,
        { id: -Date.now(), session_id: sid ?? -1, role: 'user', ai_module: null, content: t, created_at: '' }
      ])
      await window.api.ai.chat(jobId, t, currentModule, sid, channel)
      await loadSessions() // 首条消息自动命名 + updated_at 排序变化
      await loadMessages(sid)
      if (isDispositionChannel(channel)) setDispositionSid(sid)
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('LLM_NOT_CONFIGURED')) {
        setNeedConfig(true)
      } else if (msg.includes('已取消')) {
        // 取消：用户消息已落库，重载替换乐观行；不产生 assistant 回复、不加「请求失败」占位
        if (sid != null) await loadMessages(sid)
      } else {
        setMessages((arr) => [
          ...arr,
          { id: -Date.now(), session_id: sid ?? -1, role: 'system', ai_module: null, content: `请求失败：${msg}`, created_at: '' }
        ])
      }
    } finally {
      sendingRef.current = false
      setSending(false)
      setSendJob(null)
    }
  }

  const send = (): void => {
    const text = input.trim()
    if (!text || sendingRef.current) return
    setInput('')
    void sendText(text)
  }

  /** 画像建议：确认加入（入档 + 剥除消息标记行） */
  const acceptSuggest = async (msgId: number, raw: string, category: string, content: string): Promise<void> => {
    try {
      await window.api.profile.add(category, content, 'ai')
      await window.api.ai.editMessage(msgId, raw.replace(PROFILE_SUGGEST_RE, '').trimEnd())
      const aid = activeIdRef.current
      if (aid != null) await loadMessages(aid)
      toast('已加入「我的画像」')
    } catch (e) {
      toast(`加入失败：${String((e as Error).message).slice(0, 80)}`)
    }
  }

  /** 画像建议：忽略（仅剥除消息标记行） */
  const dismissSuggest = async (msgId: number, raw: string): Promise<void> => {
    await window.api.ai.editMessage(msgId, raw.replace(PROFILE_SUGGEST_RE, '').trimEnd())
    const aid = activeIdRef.current
    if (aid != null) await loadMessages(aid)
  }

  /** 拖拽左缘调宽（优化建议区）：移动中实时生效，松手持久化到 settings */
  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = aiWidth
    const onMove = (ev: MouseEvent): void => {
      const w = clampAiWidth(startWidth - (ev.clientX - startX))
      setAiWidth(w)
      applyAiWidth(w)
    }
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      void window.api.settings.set(SettingsKeys.AiWidth, String(clampAiWidth(startWidth - (ev.clientX - startX))))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
  }

  /** 确认删除（会话 / 单条消息） */
  const doDelete = async (): Promise<void> => {
    if (!confirm) return
    const target = confirm
    setConfirm(null)
    setDispositionSid(null)
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
    } else {
      // 删除后保持滚动位置，不自动跳底
      const el = listRef.current
      keepScrollRef.current = el ? el.scrollTop : null
      await window.api.ai.deleteMessage(target.id)
      const aid = activeIdRef.current
      if (aid != null) await loadMessages(aid)
    }
  }

  /** 归档：会话入回收站「AI 会话」块，终结式切新会话（优化建议区第47轮） */
  const doArchive = async (): Promise<void> => {
    const sid = activeIdRef.current
    if (sid == null) return
    setArchiveAsk(false)
    await window.api.aiSession.archive(sid)
    setDispositionSid(null)
    toast('会话已移入回收站「AI 会话」')
    await newSession()
  }

  /** 保存成功：卡片已落模块，终结式切新会话 */
  const onChatSaved = (target: string): void => {
    setSaveOpen(false)
    setDispositionSid(null)
    toast(`已保存到${target}`)
    void newSession()
  }

  if (collapsed) {
    // 草稿本/画布面板正展开：隐藏但保持挂载（进行中的生成任务 await 仍能回填状态，重展开即恢复）
    if (!showRail) return <aside className="ai-sidebar" style={{ display: 'none' }} aria-hidden />
    // 都收起：右缘细条四图标入口（debugzi / 资源管理器 / 草稿本 / 画布，互斥展开）
    return (
      <aside className="ai-sidebar collapsed">
        <button className="ai-toggle" onClick={onExpand} title={`展开 ${AI_NAME}`}>
          <span className="material-symbols-outlined">forum</span>
        </button>
        <button className="ai-toggle" onClick={onOpenFiles} title="展开资源管理器">
          <span className="material-symbols-outlined">folder_open</span>
        </button>
        <button className="ai-toggle" onClick={onOpenDraft} title="展开草稿本">
          <span className="material-symbols-outlined">edit_note</span>
        </button>
        <button className="ai-toggle" onClick={onOpenCanvas} title="展开画布">
          <span className="material-symbols-outlined">draw</span>
        </button>
      </aside>
    )
  }

  const sessionLabel = channelInfo(activeChannel).label

  return (
    <aside className="ai-sidebar">
      <div className="ai-resizer" onMouseDown={startResize} title="拖拽调整宽度" />
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
      <div className="ai-body">
        {panelOpen && (
          <>
            <div className="ai-session-backdrop" onClick={() => setPanelOpen(false)} />
            <div className="ai-session-panel">
              <div className="ai-session-panel-head">
                <span>会话</span>
                <button className="btn btn-ghost" onClick={() => void newSession()} title="开启新对话">
                  <span className="material-symbols-outlined">add</span>
                </button>
              </div>
              <div className="ai-session-list">
                {sessions.length === 0 && <div className="ai-session-empty">暂无会话，点右上角「+」开启新对话</div>}
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    className={`ai-session-item${s.id === activeId ? ' active' : ''}`}
                    onClick={() => void switchSession(s.id)}
                    title="单击切换会话"
                  >
                    <span className="ai-session-badge" title={channelInfo(s.channel).label}>
                      <span className="material-symbols-outlined">{channelInfo(s.channel).icon}</span>
                    </span>
                    {renamingId === s.id ? (
                      <input
                        className="ai-session-rename"
                        value={renameText}
                        autoFocus
                        maxLength={50}
                        onChange={(e) => setRenameText(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void commitRename(s.id)
                          }
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        onBlur={() => setRenamingId(null)}
                      />
                    ) : (
                      <>
                        <div className="ai-session-title">{s.title}</div>
                        <div className="ai-session-time">{relTime(s.updated_at)}</div>
                        <button
                          className="ai-session-act"
                          title="重命名会话"
                          onClick={(e) => {
                            e.stopPropagation()
                            setRenamingId(s.id)
                            setRenameText(s.title)
                          }}
                        >
                          <span className="material-symbols-outlined">edit</span>
                        </button>
                      </>
                    )}
                    <button
                      className="ai-session-act ai-session-del"
                      title="删除该会话"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirm({ kind: 'session', id: s.id, title: s.title })
                      }}
                    >
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        <div className="ai-list" ref={listRef}>
          {messages.length === 0 && (
            <div className="ai-empty">
              新对话将以 {AI_NAME} 助手身份回答（感知当前模块：{moduleLabel(currentModule)}）
            </div>
          )}
          {messages.map((m) => {
            const { body, suggest } =
              m.role === 'assistant' ? splitSuggest(m.content) : { body: m.content, suggest: null }
            return (
              <div key={m.id} className={`ai-msg ${m.role}`}>
                <div className="ai-msg-role">
                  <span>{ROLE_LABEL[m.role] ?? m.role}</span>
                  {m.id > 0 && (
                    <button
                      className="ai-msg-del"
                      title="删除该消息"
                      onClick={() => setConfirm({ kind: 'message', id: m.id })}
                    >
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  )}
                </div>
                {m.role === 'assistant' ? (
                  <>
                    <MdView md={body} className="ai-msg-content" />
                    {suggest && (
                      <div className="ai-profile-card">
                        <div className="ai-profile-tip">{AI_NAME} 想把这条加入「我的画像」</div>
                        <div className="ai-profile-line">
                          {suggest.category}：{suggest.content}
                        </div>
                        <div className="ai-profile-acts">
                          <button
                            className="btn btn-primary"
                            onClick={() => void acceptSuggest(m.id, m.content, suggest.category, suggest.content)}
                          >
                            加入画像
                          </button>
                          <button className="btn" onClick={() => void dismissSuggest(m.id, m.content)}>
                            忽略
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="ai-msg-content">{m.content}</div>
                )}
              </div>
            )
          })}
          {sending && (
            <div className="ai-msg assistant">
              <div className="ai-msg-role">{AI_NAME}</div>
              <div className="ai-msg-content">
                思考中…
                {sendJob && (
                  <button
                    className="btn btn-ghost ai-stop"
                    onClick={() => void window.api.ai.cancel(sendJob)}
                    title="停止生成"
                  >
                    <span className="material-symbols-outlined">stop_circle</span>
                    停止生成
                  </button>
                )}
              </div>
            </div>
          )}
          {!sending &&
            dispositionSid != null &&
            dispositionSid === activeId &&
            isDispositionChannel(activeChannel) && (
              <ChatDispositionBar
                onContinue={() => setDispositionSid(null)}
                onSave={() => setSaveOpen(true)}
                onArchive={() => setArchiveAsk(true)}
              />
            )}
        </div>
      </div>
      {needConfig && (
        <div className="ai-need-config">
          请先在个人档配置 LLM
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn" onClick={() => setNeedConfig(false)}>暂不</button>
            <button className="btn btn-primary" onClick={() => { setNeedConfig(false); onNavigateToProfile() }}>去配置</button>
          </div>
        </div>
      )}
      <div className="ai-input-row">
        <textarea
          ref={inputRef}
          className="ai-input"
          placeholder={`问 ${AI_NAME}（${sessionLabel}｜${moduleLabel(currentModule)}）`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={2}
        />
        <button className="btn btn-primary ai-send" onClick={send} disabled={sending || !input.trim()}>
          <span className="material-symbols-outlined">send</span>
        </button>
      </div>
      <SaveChatDialog
        open={saveOpen && activeId != null && isDispositionChannel(activeChannel)}
        channel={activeChannel as DispositionChannel}
        defaultTitle={activeSessionRow?.title ?? '新对话'}
        md={buildChatTranscriptMd(
          activeSessionRow?.title ?? '新对话',
          activeChannel as DispositionChannel,
          messages
        )}
        onCancel={() => setSaveOpen(false)}
        onSaved={onChatSaved}
      />
      <ConfirmDialog
        open={archiveAsk}
        title="归档对话"
        confirmText="归档"
        danger
        onConfirm={() => void doArchive()}
        onCancel={() => setArchiveAsk(false)}
      >
        将把当前会话移入回收站「AI 会话」（3 天后自动彻底删除，期间可恢复），并切换到新会话。确定归档吗？
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm != null}
        title={confirm?.kind === 'session' ? '删除会话' : '删除消息'}
        confirmText="删除"
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirm(null)}
      >
        {confirm?.kind === 'session'
          ? `将彻底删除会话「${confirm.title}」及其全部消息，删除后不可恢复。`
          : '将删除这条消息，之后 AI 的对话上下文也不再包含它。'}
      </ConfirmDialog>
    </aside>
  )
}

function moduleLabel(m: string): string {
  // 260908：辩真阁并入万象库（verify 移除）；账本→记账本、个人中心→个人档；260911 格言库并入文笔坊（mottos 移除）
  const map: Record<string, string> = {
    learn: '学习库',
    wiki: '万象库',
    inspirations: '灵感泉',
    zhijiji: '致知己',
    reasoning: '推理角',
    zangyue: '图书馆',
    feed: '信息源',
    wenbi: '文笔坊',
    ledger: '记账本',
    recycle: '回收站',
    profile: '个人档'
  }
  return map[m] ?? m
}

/** 相对时间（会话列表用） */
function relTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(t).toLocaleDateString('zh-CN')
}
