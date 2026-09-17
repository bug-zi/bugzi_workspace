// 弹窗内嵌会话栏（拓展坞）：MdDialog sidePanel 通用的频道会话视图 + 输入发送，
// 与全局 AI 边栏同频道同数据。支持收起（细条）、拖宽、多会话切换、/clear 与 /compact。
// 首例为致知己·追问栏（优化建议区第13/14轮），学习库「问 AI」拓展坞（优化建议区第42轮）复用。
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { AiChannel, AiMessageRow, AiSessionRow } from '../renderer/api'
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

/** 栏宽度范围与默认（可收起 + 拖拽调宽，弹窗总宽不变正文区伸缩） */
export const CHAT_PANEL_W_MIN = 240
export const CHAT_PANEL_W_MAX = 560
export const CHAT_PANEL_W_DEFAULT = 320

export const clampChatPanelW = (w: number): number =>
  Math.min(CHAT_PANEL_W_MAX, Math.max(CHAT_PANEL_W_MIN, Math.round(w)))

const ROLE_LABEL: Record<string, string> = { user: '我', assistant: 'AI', system: '系统' }

/** 相对时间（会话切换器用，同全局边栏） */
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

/** 收起后的右侧细条：点击展开 */
export function ChannelChatRail(props: { title: string; onExpand: () => void }) {
  return (
    <div className="dlg-chat-rail">
      <button className="icon-btn" onClick={props.onExpand} title={`展开${props.title}`}>
        <span className="material-symbols-outlined">chevron_left</span>
      </button>
      <span className="dlg-chat-rail-text">{props.title}</span>
    </div>
  )
}

export interface ChannelChatPanelProps {
  /** AI 频道（人格与数据隔离）；currentModule 同值落 ai_module */
  channel: AiChannel
  /** 频道激活会话的 settings 持久化键（切会话/新会话/compact 后回写，与全局边栏一致） */
  sessionKey: string
  /** 头部与收起细条的标题 */
  title: string
  /** 头部图标（material-symbols 名称） */
  icon: string
  /** 头部图标悬停说明 */
  iconTitle?: string
  /** 输入框占位文案 */
  placeholder?: string
  /** 无消息时的空态引导 */
  emptyHint: string
  /** 助手消息中剥除显示的协议标记（不影响数据） */
  stripPatterns?: RegExp[]
  width: number
  onWidthChange: (w: number) => void
  onCollapse: () => void
  /** 直发请求（调用方动作，如「让 AI 追问」/划词问 AI）：n 变化触发重发 */
  autoAsk: { text: string; n: number } | null
  onAutoAskConsumed: () => void
  onNeedConfig: () => void
}

export function ChannelChatPanel(props: ChannelChatPanelProps) {
  const {
    channel,
    sessionKey,
    title,
    icon,
    iconTitle,
    placeholder,
    emptyHint,
    stripPatterns,
    width,
    onWidthChange,
    onCollapse,
    autoAsk,
    onAutoAskConsumed,
    onNeedConfig
  } = props
  const { toast } = useToast()
  const [messages, setMessages] = useState<AiMessageRow[]>([])
  const [sessions, setSessions] = useState<AiSessionRow[]>([])
  const [sessOpen, setSessOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [delSess, setDelSess] = useState<{ id: number; title: string } | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendJob, setSendJob] = useState<string | null>(null)
  // 三选条（优化建议区第47轮）：本轮 AI 回复后待处置的会话 id；null=已消费/无
  const [dispositionSid, setDispositionSid] = useState<number | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [archiveAsk, setArchiveAsk] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sidRef = useRef<number | null>(null)
  const sendingRef = useRef(false)

  const loadSessions = async (): Promise<void> => {
    setSessions(await window.api.aiSession.list(channel))
  }

  /** 载入频道的激活会话消息（激活失效则兜底该频道最近一个） */
  const load = async (): Promise<void> => {
    const list = await window.api.aiSession.list(channel)
    const active = await window.api.aiSession.active(channel)
    const aid = active != null && list.some((s) => s.id === active) ? active : (list[0]?.id ?? null)
    sidRef.current = aid
    setSessions(list)
    if (aid != null) setMessages(await window.api.ai.messages(aid))
    else setMessages([])
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 新消息自动滚底
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, sending])

  /** 输入框高度自适应（同全局边栏）：基准两行随内容长高，超过 CSS max-height（30vh）后内部滚动 */
  const fitInput = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  // 输入或栏宽变化（折行数变化）→ 重算输入框高度
  useEffect(() => {
    fitInput()
  }, [input, width])

  /** 切换会话（同频道内），并设为频道激活（全局边栏与本栏保持一致） */
  const switchSession = async (id: number): Promise<void> => {
    setDispositionSid(null)
    if (id === sidRef.current) {
      setSessOpen(false)
      return
    }
    sidRef.current = id
    setSessOpen(false)
    await window.api.settings.set(sessionKey, String(id))
    setMessages(await window.api.ai.messages(id))
  }

  /** 新会话（手动开启；/clear 清空当前会话走 clearAiSession） */
  const newSession = async (): Promise<void> => {
    setDispositionSid(null)
    const s = await window.api.aiSession.create(channel)
    await window.api.settings.set(sessionKey, String(s.id))
    sidRef.current = s.id
    setSessions((arr) => [s, ...arr])
    setMessages([])
    setSessOpen(false)
  }

  /** 会话改名提交（Enter） */
  const commitRename = async (id: number): Promise<void> => {
    const t = renameText.trim()
    setRenamingId(null)
    if (!t) return
    await window.api.aiSession.rename(id, t)
    await loadSessions()
  }

  /** 删除会话（二次确认）：主进程删消息+会话行，删的是激活会话时同频道自动切换 */
  const doDeleteSession = async (): Promise<void> => {
    if (!delSess) return
    setDelSess(null)
    setDispositionSid(null)
    await window.api.aiSession.delete(delSess.id, channel)
    await load()
  }

  /** 终结式切新会话（保存/归档后共用，优化建议区第47轮） */
  const concludeToNewSession = async (): Promise<void> => {
    const s = await window.api.aiSession.create(channel)
    await window.api.settings.set(sessionKey, String(s.id))
    sidRef.current = s.id
    setSessions((arr) => [s, ...arr])
    setMessages([])
  }

  /** 归档：会话入回收站「AI 会话」块，终结式切新会话 */
  const doArchive = async (): Promise<void> => {
    const sid = sidRef.current
    if (sid == null) return
    setArchiveAsk(false)
    await window.api.aiSession.archive(sid)
    setDispositionSid(null)
    toast('会话已移入回收站「AI 会话」')
    await concludeToNewSession()
  }

  /** 保存成功：卡片已落模块，终结式切新会话 */
  const onChatSaved = (target: string): void => {
    setSaveOpen(false)
    setDispositionSid(null)
    toast(`已保存到${target}`)
    void concludeToNewSession()
  }

  const sendText = async (text: string): Promise<void> => {
    const t = text.trim()
    if (!t || sendingRef.current) return
    // 斜杠命令：/clear 清空当前会话；/compact 压缩当前会话上下文
    const cmd = t.match(/^\/(clear|compact)$/i)
    if (cmd) {
      const name = cmd[1].toLowerCase()
      const sid = sidRef.current
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
        await window.api.settings.set(sessionKey, String(ns.id))
        sidRef.current = ns.id
        await loadSessions()
        setMessages(await window.api.ai.messages(ns.id))
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
    let sid = sidRef.current
    try {
      if (sid == null) {
        const s = await window.api.aiSession.create(channel)
        await window.api.settings.set(sessionKey, String(s.id))
        sid = s.id
        sidRef.current = sid
      }
      // 乐观上屏（同全局边栏）：负 id 临时行，完成后由 DB 记录替换
      setDispositionSid(null) // 新一轮开始，上一轮的三选条收起
      setMessages((arr) => [
        ...arr,
        { id: -Date.now(), session_id: sid ?? -1, role: 'user', ai_module: null, content: t, created_at: '' }
      ])
      await window.api.ai.chat(jobId, t, channel, sid, channel)
      if (sidRef.current === sid) await load()
      else await loadSessions()
      if (isDispositionChannel(channel) && sidRef.current === sid) setDispositionSid(sid)
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('LLM_NOT_CONFIGURED')) onNeedConfig()
      else if (msg.includes('已取消')) {
        // 取消：用户消息主进程已落库，重载替换乐观行；不产生 assistant 回复、不加错误占位
        if (sid != null && sidRef.current === sid) await load()
      } else
        setMessages((arr) => [
          ...arr,
          { id: -Date.now(), session_id: sid ?? -1, role: 'system', ai_module: null, content: `请求失败：${msg}`, created_at: '' }
        ])
    } finally {
      sendingRef.current = false
      setSending(false)
      setSendJob(null)
    }
  }

  // 直发请求（调用方动作）→ 进本栏
  useEffect(() => {
    if (!autoAsk) return
    void sendText(autoAsk.text).then(() => onAutoAskConsumed())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk])

  /** 左缘拖拽调宽（同全局边栏模式）：移动中实时生效，松手经父组件持久化 */
  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const onMove = (ev: MouseEvent): void => onWidthChange(clampChatPanelW(startWidth + (ev.clientX - startX)))
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      onWidthChange(clampChatPanelW(startWidth + (ev.clientX - startX)))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
  }

  const curSession = sessions.find((s) => s.id === sidRef.current) ?? null

  return (
    <div className="dlg-chat" style={{ width: `${width}px` }}>
      <div className="dlg-chat-resizer" onMouseDown={startResize} title="拖拽调整宽度" />
      <div className="dlg-chat-head">
        <span className="material-symbols-outlined" title={iconTitle}>
          {icon}
        </span>
        <span className="dlg-chat-title">{title}</span>
        {/* 会话切换器：会话关联与否由你决定分会话 */}
        <button className="dlg-chat-sess" onClick={() => setSessOpen((v) => !v)} title="切换/新建会话">
          <span className="dlg-chat-sess-name">{curSession ? curSession.title : '新会话'}</span>
          <span className="material-symbols-outlined">{sessOpen ? 'expand_less' : 'expand_more'}</span>
        </button>
        <button className="icon-btn" onClick={() => void newSession()} title="开启新会话（/clear）">
          <span className="material-symbols-outlined">add</span>
        </button>
        <button className="icon-btn" onClick={onCollapse} title={`收起${title}`}>
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
        {sessOpen && (
          <div className="dlg-chat-sess-pop">
            {sessions.length === 0 && <div className="dlg-chat-sess-empty">暂无会话</div>}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`dlg-chat-sess-item${s.id === sidRef.current ? ' active' : ''}`}
                onClick={() => void switchSession(s.id)}
                title="单击切换会话"
              >
                {renamingId === s.id ? (
                  <input
                    className="dlg-chat-sess-rename"
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
                    <span className="dlg-chat-sess-it-title">{s.title}</span>
                    <span className="dlg-chat-sess-it-time">{relTime(s.updated_at)}</span>
                    <button
                      className="dlg-chat-sess-act"
                      title="重命名会话"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenamingId(s.id)
                        setRenameText(s.title)
                      }}
                    >
                      <span className="material-symbols-outlined">edit</span>
                    </button>
                    <button
                      className="dlg-chat-sess-act del"
                      title="删除该会话"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDelSess({ id: s.id, title: s.title })
                      }}
                    >
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </>
                )}
              </div>
            ))}
            <button className="btn dlg-chat-sess-new" onClick={() => void newSession()}>
              <span className="material-symbols-outlined">add</span>
              新会话
            </button>
          </div>
        )}
      </div>
      <div className="dlg-chat-list" ref={listRef}>
        {messages.length === 0 && <div className="dlg-chat-empty">{emptyHint}</div>}
        {messages.map((m) => {
          let body = m.content
          for (const re of stripPatterns ?? []) body = body.replace(re, '')
          body = body.trim()
          return (
            <div key={m.id} className={`ai-msg ${m.role}`}>
              <div className="ai-msg-role">
                <span>{ROLE_LABEL[m.role] ?? m.role}</span>
              </div>
              {m.role === 'assistant' ? (
                <MdView md={body} className="ai-msg-content" />
              ) : (
                <div className="ai-msg-content">{body}</div>
              )}
            </div>
          )
        })}
        {sending && (
          <div className="ai-msg assistant">
            <div className="ai-msg-role">AI</div>
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
          dispositionSid === sidRef.current &&
          isDispositionChannel(channel) && (
            <ChatDispositionBar
              onContinue={() => setDispositionSid(null)}
              onSave={() => setSaveOpen(true)}
              onArchive={() => setArchiveAsk(true)}
            />
          )}
      </div>
      <div className="dlg-chat-input">
        <textarea
          ref={inputRef}
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              const text = input.trim()
              if (!text || sendingRef.current) return
              setInput('')
              void sendText(text)
            }
          }}
          rows={2}
        />
        <button
          className="btn btn-primary"
          disabled={sending || !input.trim()}
          onClick={() => {
            const text = input.trim()
            if (!text || sendingRef.current) return
            setInput('')
            void sendText(text)
          }}
        >
          <span className="material-symbols-outlined">send</span>
        </button>
      </div>
      <SaveChatDialog
        open={saveOpen && sidRef.current != null && isDispositionChannel(channel)}
        channel={channel as DispositionChannel}
        defaultTitle={curSession?.title ?? '新对话'}
        md={buildChatTranscriptMd(curSession?.title ?? '新对话', channel as DispositionChannel, messages)}
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
      {/* 删除会话二次确认（全局规则） */}
      <ConfirmDialog
        open={delSess != null}
        title="删除会话"
        confirmText="删除"
        danger
        onConfirm={() => void doDeleteSession()}
        onCancel={() => setDelSess(null)}
      >
        将彻底删除会话「{delSess?.title}」及其全部消息，删除后不可恢复。
      </ConfirmDialog>
    </div>
  )
}
