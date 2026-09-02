// AI 助手边栏（样式 specs §4）：自由对话 + 模块感知 + 多会话管理 + 系统消息推送
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { AiMessageRow, AiSessionRow } from '../renderer/api'
import { SettingsKeys } from '../shared/types'
import ConfirmDialog from './ConfirmDialog'
import MdView from './MdView'
import './AiSidebar.css'

export interface AiSidebarProps {
  collapsed: boolean
  onToggle: () => void
  currentModule: string
  /** 万象库「问 AI」预填文本 */
  pendingAsk: string | null
  onPendingAskConsumed: () => void
  /** 系统消息（辩真阁验证过程）触发展开 */
  messagesVersion: number
  onNavigateToProfile: () => void
}

const ROLE_LABEL: Record<string, string> = { user: '我', assistant: 'AI', system: '系统' }

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

/** 激活会话落库（settings.ai_active_session_id，主进程系统消息推送读它） */
async function persistActive(id: number | null): Promise<void> {
  await window.api.settings.set(SettingsKeys.AiActiveSessionId, id == null ? '' : String(id))
}

export default function AiSidebar(props: AiSidebarProps) {
  const { collapsed, onToggle, currentModule, pendingAsk, onPendingAskConsumed, messagesVersion, onNavigateToProfile } = props
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
  /** 删除消息后要恢复的滚动位置（null = 正常滚底） */
  const keepScrollRef = useRef<number | null>(null)

  const loadMessages = async (sessionId: number): Promise<void> => {
    setMessages(await window.api.ai.messages(sessionId))
  }

  const loadSessions = async (): Promise<void> => {
    setSessions(await window.api.aiSession.list())
  }

  // 初始化：会话列表 + 恢复上次激活会话 + 恢复保存的边栏宽度
  useEffect(() => {
    void (async () => {
      const [list, active] = await Promise.all([window.api.aiSession.list(), window.api.aiSession.active()])
      setSessions(list)
      let aid = active != null && list.some((s) => s.id === active) ? active : null
      if (aid == null && list.length > 0) {
        // 激活 id 失效（理论不应发生）→ 兜底切到最近活跃
        aid = list[0].id
        await persistActive(aid)
      }
      setActiveId(aid)
      if (aid != null) await loadMessages(aid)
      const savedW = await window.api.settings.get(SettingsKeys.AiWidth)
      const w = savedW ? Number(savedW) : NaN
      if (Number.isFinite(w) && w >= AI_WIDTH_MIN && w <= AI_WIDTH_MAX) {
        setAiWidth(w)
        applyAiWidth(w)
      }
    })()
  }, [])

  // 系统消息推送到达 → 刷新会话列表；属于当前会话则重载消息并滚动到底
  useEffect(() => {
    return window.api.ai.onMessage((msg) => {
      void loadSessions()
      if (msg && typeof msg === 'object' && (msg as AiMessageRow).session_id === activeIdRef.current) {
        void loadMessages((msg as AiMessageRow).session_id)
      }
    })
  }, [])

  // 辩真阁验证流程触发展开（App 层 messagesVersion）
  useEffect(() => {
    if (messagesVersion > 0) {
      void loadSessions()
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

  // 万象库问 AI 预填
  useEffect(() => {
    if (pendingAsk) {
      setInput(pendingAsk)
      onPendingAskConsumed()
    }
  }, [pendingAsk, onPendingAskConsumed])

  /** 切换会话 */
  const switchSession = async (id: number): Promise<void> => {
    if (id === activeId) {
      setPanelOpen(false)
      return
    }
    setActiveId(id)
    setPanelOpen(false)
    setRenamingId(null)
    await persistActive(id)
    await loadMessages(id)
  }

  /** 新建会话并切换过去 */
  const newSession = async (): Promise<void> => {
    const s = await window.api.aiSession.create()
    await persistActive(s.id)
    setSessions((arr) => [s, ...arr])
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

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    setInput('')
    let sid = activeId
    try {
      if (sid == null) {
        // 无激活会话（如全删光后直接发消息）→ 自动新建
        const s = await window.api.aiSession.create()
        await persistActive(s.id)
        sid = s.id
        setSessions((arr) => [s, ...arr])
        setActiveId(sid)
      }
      await window.api.ai.chat(text, currentModule, sid)
      await loadSessions() // 首条消息自动命名 + updated_at 排序变化
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
      setSending(false)
    }
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
      await window.api.aiSession.delete(target.id)
      const [list, active] = await Promise.all([window.api.aiSession.list(), window.api.aiSession.active()])
      setSessions(list)
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
            <div className="ai-empty">和 AI 聊聊吧（感知当前模块：{moduleLabel(currentModule)}）</div>
          )}
          {messages.map((m) => (
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
                <MdView md={m.content} className="ai-msg-content" />
              ) : (
                <div className="ai-msg-content">{m.content}</div>
              )}
            </div>
          ))}
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
          placeholder={`问 AI（当前：${moduleLabel(currentModule)}）`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          rows={2}
        />
        <button className="btn btn-primary ai-send" onClick={() => void send()} disabled={sending || !input.trim()}>
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
