// AI 助手边栏（样式 specs §4 + 频道制）：四频道独立会话 + 模块感知 + 多会话管理 + 系统消息推送 + 画像建议卡片
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { AiChannel, AiMessageRow, AiSessionRow } from '../renderer/api'
import { SettingsKeys } from '../shared/types'
import ConfirmDialog from './ConfirmDialog'
import MdView from './MdView'
import { useToast } from './Toast'
import './AiSidebar.css'

export interface AiSidebarProps {
  collapsed: boolean
  onToggle: () => void
  currentModule: string
  /** 模块动作带来的频道请求（万象问AI/辩真验证/致知己追问）：auto 时切频道后自动发送 */
  pending: { text: string; channel: AiChannel; auto: boolean } | null
  onPendingConsumed: () => void
  /** 系统消息（辩真阁验证过程）触发展开 */
  messagesVersion: number
  onNavigateToProfile: () => void
}

const ROLE_LABEL: Record<string, string> = { user: '我', assistant: 'AI', system: '系统' }

/** 频道清单（DB v9 频道制，致知己 specs §4）：外壳不变，内部按场景分频道 */
const CHANNELS: { id: AiChannel; label: string; icon: string }[] = [
  { id: 'assistant', label: '助手', icon: 'forum' },
  { id: 'motto', label: '格言·解读', icon: 'psychology' },
  { id: 'wiki', label: '万象·问答', icon: 'public' },
  { id: 'zhijiji', label: '致知己·追问', icon: 'self_improvement' },
  { id: 'verify', label: '辩真·核查', icon: 'fact_check' }
]

/** 各频道激活会话的 settings key（与主进程 services.ACTIVE_SESSION_KEYS 同步） */
const ACTIVE_SESSION_KEYS: Record<AiChannel, string> = {
  assistant: SettingsKeys.AiActiveSessionId,
  motto: SettingsKeys.AiActiveSessionMotto,
  wiki: SettingsKeys.AiActiveSessionWiki,
  zhijiji: SettingsKeys.AiActiveSessionZhijiji,
  verify: SettingsKeys.AiActiveSessionVerify
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

export default function AiSidebar(props: AiSidebarProps) {
  const { collapsed, onToggle, currentModule, pending, onPendingConsumed, messagesVersion, onNavigateToProfile } = props
  const { toast } = useToast()
  const [activeChannel, setActiveChannel] = useState<AiChannel>('assistant')
  const [sessions, setSessions] = useState<AiSessionRow[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [messages, setMessages] = useState<AiMessageRow[]>([])
  const [panelOpen, setPanelOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [needConfig, setNeedConfig] = useState(false)
  const [aiWidth, setAiWidth] = useState(AI_WIDTH_DEFAULT)
  const listRef = useRef<HTMLDivElement>(null)
  const activeIdRef = useRef<number | null>(null)
  activeIdRef.current = activeId
  const activeChannelRef = useRef<AiChannel>('assistant')
  activeChannelRef.current = activeChannel
  const sendingRef = useRef(false)
  /** 删除消息后要恢复的滚动位置（null = 正常滚底） */
  const keepScrollRef = useRef<number | null>(null)

  const loadMessages = async (sessionId: number): Promise<void> => {
    setMessages(await window.api.ai.messages(sessionId))
  }

  const loadSessions = async (channel: AiChannel): Promise<void> => {
    setSessions(await window.api.aiSession.list(channel))
  }

  /** 载入某频道：会话列表 + 恢复该频道激活会话（失效则兜底最近活跃），并同步 ref */
  const loadForChannel = async (channel: AiChannel): Promise<void> => {
    const [list, active] = await Promise.all([
      window.api.aiSession.list(channel),
      window.api.aiSession.active(channel)
    ])
    setSessions(list)
    let aid = active != null && list.some((s) => s.id === active) ? active : null
    if (aid == null && list.length > 0) {
      // 激活 id 失效（理论不应发生）→ 兜底切到最近活跃
      aid = list[0].id
      await persistActive(aid, channel)
    }
    activeIdRef.current = aid
    setActiveId(aid)
    if (aid != null) await loadMessages(aid)
    else setMessages([])
  }

  // 初始化：恢复上次所在频道 + 该频道会话 + 恢复保存的边栏宽度
  useEffect(() => {
    void (async () => {
      let ch: AiChannel = 'assistant'
      try {
        const saved = await window.api.settings.get(SettingsKeys.AiActiveChannel)
        if (saved === 'wiki' || saved === 'zhijiji' || saved === 'verify' || saved === 'assistant') ch = saved
      } catch {
        /* 读失败用默认 */
      }
      activeChannelRef.current = ch
      setActiveChannel(ch)
      await loadForChannel(ch)
      const savedW = await window.api.settings.get(SettingsKeys.AiWidth)
      const w = savedW ? Number(savedW) : NaN
      if (Number.isFinite(w) && w >= AI_WIDTH_MIN && w <= AI_WIDTH_MAX) {
        setAiWidth(w)
        applyAiWidth(w)
      }
    })()
  }, [])

  // 系统消息推送到达 → 刷新当前频道会话列表；属于当前会话则重载消息并滚动到底
  useEffect(() => {
    return window.api.ai.onMessage((msg) => {
      void loadSessions(activeChannelRef.current)
      if (msg && typeof msg === 'object' && (msg as AiMessageRow).session_id === activeIdRef.current) {
        void loadMessages((msg as AiMessageRow).session_id)
      }
    })
  }, [])

  // 辩真阁验证流程触发展开（App 层 messagesVersion）
  useEffect(() => {
    if (messagesVersion > 0) {
      void loadSessions(activeChannelRef.current)
      const aid = activeIdRef.current
      if (aid != null) void loadMessages(aid)
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

  /** 切换频道：持久化 + 载入该频道会话与消息 */
  const switchChannel = async (id: AiChannel): Promise<void> => {
    if (id === activeChannelRef.current) return
    activeChannelRef.current = id
    setActiveChannel(id)
    setPanelOpen(false)
    setRenamingId(null)
    await window.api.settings.set(SettingsKeys.AiActiveChannel, id)
    await loadForChannel(id)
  }

  // 模块动作请求（万象问AI预填/致知己追问自动发送/辩真验证切频道）
  useEffect(() => {
    if (!pending) return
    let cancelled = false
    void (async () => {
      try {
        if (pending.channel !== activeChannelRef.current) await switchChannel(pending.channel)
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

  /** 切换会话（当前频道内） */
  const switchSession = async (id: number): Promise<void> => {
    if (id === activeId) {
      setPanelOpen(false)
      return
    }
    activeIdRef.current = id
    setActiveId(id)
    setPanelOpen(false)
    setRenamingId(null)
    await persistActive(id, activeChannelRef.current)
    await loadMessages(id)
  }

  /** 新建会话并切换过去（归属当前频道） */
  const newSession = async (): Promise<void> => {
    const s = await window.api.aiSession.create(activeChannelRef.current)
    await persistActive(s.id, activeChannelRef.current)
    setSessions((arr) => [s, ...arr])
    activeIdRef.current = s.id
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
    await loadSessions(activeChannelRef.current)
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
      try {
        const ns = await window.api.aiSession.compact(sid)
        await persistActive(ns.id, activeChannelRef.current)
        activeIdRef.current = ns.id
        setActiveId(ns.id)
        await loadSessions(activeChannelRef.current)
        await loadMessages(ns.id)
        toast('已压缩为前情摘要（原会话保留在列表）')
      } catch (e) {
        toast(`压缩失败：${String((e as Error).message).slice(0, 80)}`)
      } finally {
        sendingRef.current = false
        setSending(false)
      }
      return
    }
    sendingRef.current = true
    setSending(true)
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
      // 乐观上屏（优化建议区第11轮）：用户消息先以负 id 临时显示（负 id 不渲染删除键），
      // 完成后 loadMessages 用 DB 真实记录替换；请求失败保留乐观消息（主进程先落库用户消息，显示与 DB 一致）
      setMessages((arr) => [
        ...arr,
        { id: -Date.now(), session_id: sid ?? -1, role: 'user', ai_module: null, content: t, created_at: '' }
      ])
      await window.api.ai.chat(t, currentModule, sid, channel)
      await loadSessions(channel) // 首条消息自动命名 + updated_at 排序变化
      await loadMessages(sid)
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('LLM_NOT_CONFIGURED')) {
        setNeedConfig(true)
      } else {
        setMessages((arr) => [
          ...arr,
          { id: -Date.now(), session_id: sid ?? -1, role: 'system', ai_module: null, content: `请求失败：${msg}`, created_at: '' }
        ])
      }
    } finally {
      sendingRef.current = false
      setSending(false)
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
    } else {
      // 删除后保持滚动位置，不自动跳底
      const el = listRef.current
      keepScrollRef.current = el ? el.scrollTop : null
      await window.api.ai.deleteMessage(target.id)
      const aid = activeIdRef.current
      if (aid != null) await loadMessages(aid)
    }
  }

  if (collapsed) {
    return (
      <aside className="ai-sidebar collapsed">
        <button className="ai-toggle" onClick={onToggle} title="展开 AI 助手">
          <span className="material-symbols-outlined">forum</span>
        </button>
      </aside>
    )
  }

  const channelLabel = CHANNELS.find((c) => c.id === activeChannel)?.label ?? '助手'

  return (
    <aside className="ai-sidebar">
      <div className="ai-resizer" onMouseDown={startResize} title="拖拽调整宽度" />
      <div className="ai-header">
        <span className="material-symbols-outlined">forum</span>
        <span className="ai-title">AI 助手</span>
        <button className="btn btn-ghost" onClick={() => setPanelOpen((v) => !v)} title="会话列表">
          <span className="material-symbols-outlined">list</span>
        </button>
        <button className="btn btn-ghost" onClick={onToggle} title="收起">
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
      {/* 频道切换条（常驻顶部，随时可切；各频道独立会话历史与人设） */}
      <div className="ai-channels">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            className={`ai-channel${activeChannel === c.id ? ' active' : ''}`}
            onClick={() => void switchChannel(c.id)}
            title={`${c.label}频道（独立会话历史）`}
          >
            <span className="material-symbols-outlined">{c.icon}</span>
            <span className="ai-channel-label">{c.label}</span>
          </button>
        ))}
      </div>
      <div className="ai-body">
        {panelOpen && (
          <>
            <div className="ai-session-backdrop" onClick={() => setPanelOpen(false)} />
            <div className="ai-session-panel">
              <div className="ai-session-panel-head">
                <span>会话（{channelLabel}）</span>
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
              「{channelLabel}」频道（感知当前模块：{moduleLabel(currentModule)}）
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
                        <div className="ai-profile-tip">AI 想把这条加入「我的画像」</div>
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
          {sending && <div className="ai-msg assistant"><div className="ai-msg-role">AI</div><div className="ai-msg-content">思考中…</div></div>}
        </div>
      </div>
      {needConfig && (
        <div className="ai-need-config">
          请先在个人中心配置 LLM
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn" onClick={() => setNeedConfig(false)}>暂不</button>
            <button className="btn btn-primary" onClick={() => { setNeedConfig(false); onNavigateToProfile() }}>去配置</button>
          </div>
        </div>
      )}
      <div className="ai-input-row">
        <textarea
          className="ai-input"
          placeholder={`问 AI（${channelLabel}｜${moduleLabel(currentModule)}；/clear 清空会话，/compact 压缩上下文）`}
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
  const map: Record<string, string> = {
    mottos: '格言库',
    wiki: '万象库',
    inspirations: '灵感泉',
    verify: '辩真阁',
    zhijiji: '致知己',
    recycle: '回收站',
    profile: '个人中心'
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
