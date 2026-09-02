// AI 助手边栏（样式 specs §4）：自由对话 + 模块感知 + 单会话持久 + 系统消息推送
import { useEffect, useRef, useState } from 'react'
import type { AiMessageRow } from '../renderer/api'
import { SettingsKeys } from '../shared/types'
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

export default function AiSidebar(props: AiSidebarProps) {
  const { collapsed, onToggle, currentModule, pendingAsk, onPendingAskConsumed, messagesVersion, onNavigateToProfile } = props
  const [messages, setMessages] = useState<AiMessageRow[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [needConfig, setNeedConfig] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const loadAll = async (): Promise<void> => {
    const msgs = await window.api.ai.messages()
    setMessages(msgs)
  }

  useEffect(() => {
    void loadAll()
  }, [])

  // 系统消息推送到达 → 重新加载并滚动到底
  useEffect(() => {
    if (messagesVersion > 0) void loadAll()
  }, [messagesVersion])

  // 主进程主动推消息（ai:message 事件）
  useEffect(() => {
    return window.api.ai.onMessage(() => {
      void loadAll()
    })
  }, [])

  // 滚动到底
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, sending])

  // 万象库问 AI 预填
  useEffect(() => {
    if (pendingAsk) {
      setInput(pendingAsk)
      onPendingAskConsumed()
    }
  }, [pendingAsk, onPendingAskConsumed])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    setInput('')
    try {
      await window.api.ai.chat(text, currentModule)
      await loadAll()
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('LLM_NOT_CONFIGURED')) {
        setNeedConfig(true)
      } else {
        setMessages((arr) => [
          ...arr,
          { id: -Date.now(), role: 'system', ai_module: null, content: `请求失败：${msg}`, created_at: '' }
        ])
      }
    } finally {
      setSending(false)
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
      <div className="ai-header">
        <span className="material-symbols-outlined">forum</span>
        <span className="ai-title">AI 助手</span>
        <button className="btn btn-ghost" onClick={onToggle} title="收起">
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
      <div className="ai-list" ref={listRef}>
        {messages.length === 0 && <div className="ai-empty">和 AI 聊聊吧（感知当前模块：{moduleLabel(currentModule)}）</div>}
        {messages.map((m) => (
          <div key={m.id} className={`ai-msg ${m.role}`}>
            <div className="ai-msg-role">{ROLE_LABEL[m.role] ?? m.role}</div>
            <div className="ai-msg-content md-view">{m.content}</div>
          </div>
        ))}
        {sending && <div className="ai-msg assistant"><div className="ai-msg-role">AI</div><div className="ai-msg-content">思考中…</div></div>}
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
