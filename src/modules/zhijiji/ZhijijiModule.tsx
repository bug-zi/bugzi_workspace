// 致知己模块（致知己 specs §2 + 优化建议区第13/14轮）：问题 + 多版本答案，保存即版本，
// 弹窗右侧内嵌追问栏（可收起/拖宽/多会话，与全局边栏同频道同数据），AI 只追问不代笔
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { AiChannel, AiMessageRow, AiSessionRow, ZhijijiQuestion, ZhijijiVersion } from '../../renderer/api'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import MdView from '../../components/MdView'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { SettingsKeys } from '../../shared/types'
import ProphetPanel from './ProphetPanel'
import TwelvePanel from './TwelvePanel'

export interface ZhijijiModuleProps {
  onNavigateToProfile: () => void
  /** 模块动作请求展开右栏（预言家切频道 / 十二问题问 AI 追问频道）；opts.auto 时切频道后自动发送 */
  onOpenAi: (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => void
  /** 通知 App 层 AiSidebar 重载（预言家分析过程消息推送后） */
  bumpAi: () => void
}

/** 标签输入解析：逗号（,，）或顿号（、）分隔多个 */
const parseTagInput = (raw: string): string[] =>
  raw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** 助手消息中的协议标记（画像建议/检索）：追问栏内仅剥除显示，不影响数据 */
const PROFILE_SUGGEST_RE = /^<<<PROFILE_SUGGEST:[^>]*>>>\s*$/m
const PROFILE_LOOKUP_RE = /^<<<PROFILE_LOOKUP:[^>]*>>>\s*$/m

/** 追问栏宽度范围与默认（优化建议区第14轮：拖拽调宽，弹窗总宽不变正文区伸缩） */
const PANEL_W_MIN = 240
const PANEL_W_MAX = 560
const PANEL_W_DEFAULT = 320

const clampPanelW = (w: number): number => Math.min(PANEL_W_MAX, Math.max(PANEL_W_MIN, Math.round(w)))

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const ROLE_LABEL: Record<string, string> = { user: '我', assistant: 'AI', system: '系统' }

/** 相对时间（会话切换器用，同 AiSidebar） */
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

/** 追问栏收起后的右侧细条：点击展开 */
function PanelRail(props: { onExpand: () => void }) {
  return (
    <div className="zj-chat-rail">
      <button className="icon-btn" onClick={props.onExpand} title="展开追问栏">
        <span className="material-symbols-outlined">chevron_left</span>
      </button>
      <span className="zj-chat-rail-text">追问</span>
    </div>
  )
}

/** 弹窗内嵌追问栏（优化建议区第13/14轮）：致知己·追问频道的会话视图 + 输入发送，
 *  与全局 AI 边栏同频道同数据；支持收起、拖宽、会话切换、/clear 与 /compact */
function ZhijijiChat(props: {
  width: number
  onWidthChange: (w: number) => void
  onCollapse: () => void
  autoAsk: { text: string; n: number } | null
  onAutoAskConsumed: () => void
  onNeedConfig: () => void
}) {
  const { width, onWidthChange, onCollapse, autoAsk, onAutoAskConsumed, onNeedConfig } = props
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
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sidRef = useRef<number | null>(null)
  const sendingRef = useRef(false)

  const loadSessions = async (): Promise<void> => {
    setSessions(await window.api.aiSession.list('zhijiji'))
  }

  /** 载入致知己频道的激活会话消息（激活失效则兜底该频道最近一个） */
  const load = async (): Promise<void> => {
    const list = await window.api.aiSession.list('zhijiji')
    const active = await window.api.aiSession.active('zhijiji')
    const aid = active != null && list.some((s) => s.id === active) ? active : (list[0]?.id ?? null)
    sidRef.current = aid
    setSessions(list)
    if (aid != null) setMessages(await window.api.ai.messages(aid))
    else setMessages([])
  }

  useEffect(() => {
    void load()
  }, [])

  // 新消息自动滚底
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, sending])

  /** 输入框高度自适应（同全局边栏第17轮）：基准两行随内容长高，超过 CSS max-height（30vh）后内部滚动 */
  const fitInput = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  // 输入或追问栏宽度变化（折行数变化）→ 重算输入框高度
  useEffect(() => {
    fitInput()
  }, [input, width])

  /** 切换会话（同频道内），并设为频道激活（全局边栏与追问栏保持一致） */
  const switchSession = async (id: number): Promise<void> => {
    if (id === sidRef.current) {
      setSessOpen(false)
      return
    }
    sidRef.current = id
    setSessOpen(false)
    await window.api.settings.set(SettingsKeys.AiActiveSessionZhijiji, String(id))
    setMessages(await window.api.ai.messages(id))
  }

  /** 新会话（手动开启；/clear 清空当前会话走 clearAiSession） */
  const newSession = async (): Promise<void> => {
    const s = await window.api.aiSession.create('zhijiji')
    await window.api.settings.set(SettingsKeys.AiActiveSessionZhijiji, String(s.id))
    sidRef.current = s.id
    setSessions((arr) => [s, ...arr])
    setMessages([])
    setSessOpen(false)
  }

  /** 会话改名提交（Enter） */
  const commitRename = async (id: number): Promise<void> => {
    const title = renameText.trim()
    setRenamingId(null)
    if (!title) return
    await window.api.aiSession.rename(id, title)
    await loadSessions()
  }

  /** 删除会话（二次确认）：主进程删消息+会话行，删的是激活会话时同频道自动切换 */
  const doDeleteSession = async (): Promise<void> => {
    if (!delSess) return
    setDelSess(null)
    await window.api.aiSession.delete(delSess.id, 'zhijiji')
    await load()
  }

  const sendText = async (text: string): Promise<void> => {
    const t = text.trim()
    if (!t || sendingRef.current) return
    // 斜杠命令（优化建议区第14轮及修订）：/clear 清空当前会话；/compact 压缩当前会话上下文
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
        await window.api.settings.set(SettingsKeys.AiActiveSessionZhijiji, String(ns.id))
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
        const s = await window.api.aiSession.create('zhijiji')
        await window.api.settings.set(SettingsKeys.AiActiveSessionZhijiji, String(s.id))
        sid = s.id
        sidRef.current = sid
      }
      // 乐观上屏（同全局边栏第11轮）：负 id 临时行，完成后由 DB 记录替换
      setMessages((arr) => [
        ...arr,
        { id: -Date.now(), session_id: sid ?? -1, role: 'user', ai_module: null, content: t, created_at: '' }
      ])
      await window.api.ai.chat(jobId, t, 'zhijiji', sid, 'zhijiji')
      if (sidRef.current === sid) await load()
      else await loadSessions()
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

  // 版本条「让 AI 追问」→ 直发进本栏
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
    const onMove = (ev: MouseEvent): void => onWidthChange(clampPanelW(startWidth + (ev.clientX - startX)))
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      onWidthChange(clampPanelW(startWidth + (ev.clientX - startX)))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
  }

  const curSession = sessions.find((s) => s.id === sidRef.current) ?? null

  return (
    <div className="zj-chat" style={{ width: `${width}px` }}>
      <div className="zj-chat-resizer" onMouseDown={startResize} title="拖拽调整宽度" />
      <div className="zj-chat-head">
        <span className="material-symbols-outlined" title="较真的朋友 · 只提问不代笔">
          contact_support
        </span>
        <span className="zj-chat-title">追问</span>
        {/* 会话切换器（优化建议区第14轮）：问题关联与否由你决定怎么分会话 */}
        <button className="zj-chat-sess" onClick={() => setSessOpen((v) => !v)} title="切换/新建会话">
          <span className="zj-chat-sess-name">{curSession ? curSession.title : '新会话'}</span>
          <span className="material-symbols-outlined">{sessOpen ? 'expand_less' : 'expand_more'}</span>
        </button>
        <button className="icon-btn" onClick={() => void newSession()} title="开启新会话（/clear）">
          <span className="material-symbols-outlined">add</span>
        </button>
        <button className="icon-btn" onClick={onCollapse} title="收起追问栏">
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
        {sessOpen && (
          <div className="zj-chat-sess-pop">
            {sessions.length === 0 && <div className="zj-chat-sess-empty">暂无会话</div>}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`zj-chat-sess-item${s.id === sidRef.current ? ' active' : ''}`}
                onClick={() => void switchSession(s.id)}
                title="单击切换会话"
              >
                {renamingId === s.id ? (
                  <input
                    className="zj-chat-sess-rename"
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
                    <span className="zj-chat-sess-it-title">{s.title}</span>
                    <span className="zj-chat-sess-it-time">{relTime(s.updated_at)}</span>
                    <button
                      className="zj-chat-sess-act"
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
                      className="zj-chat-sess-act del"
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
            <button className="btn zj-chat-sess-new" onClick={() => void newSession()}>
              <span className="material-symbols-outlined">add</span>
              新会话
            </button>
          </div>
        )}
      </div>
      <div className="zj-chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="zj-chat-empty">
            点版本条上的「让 AI 追问」，或直接在这里和 AI 讨论当前答案
          </div>
        )}
        {messages.map((m) => {
          const body = m.content.replace(PROFILE_SUGGEST_RE, '').replace(PROFILE_LOOKUP_RE, '').trim()
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
      </div>
      <div className="zj-chat-input">
        <textarea
          ref={inputRef}
          placeholder={'回应追问…'}
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

export default function ZhijijiModule(props: ZhijijiModuleProps) {
  const { toast } = useToast()
  const [questions, setQuestions] = useState<ZhijijiQuestion[]>([])
  // 新问题
  const [adding, setAdding] = useState(false)
  const [addTitle, setAddTitle] = useState('')
  const [addTags, setAddTags] = useState('')
  const [addAiInit, setAddAiInit] = useState(false)
  const [createJob, setCreateJob] = useState<string | null>(null)
  const creating = createJob != null
  // 详情弹窗：问题 + 版本列表 + 当前版本
  const [viewQ, setViewQ] = useState<ZhijijiQuestion | null>(null)
  const [versions, setVersions] = useState<ZhijijiVersion[]>([])
  const [curVerId, setCurVerId] = useState<number | null>(null)
  const [autoEdit, setAutoEdit] = useState(false)
  // 追问栏自动发送请求（版本条「让 AI 追问」）
  const [askPrompt, setAskPrompt] = useState<{ text: string; n: number } | null>(null)
  // 追问栏布局（优化建议区第14轮）：宽度 + 收起态，持久化 settings
  const [panelW, setPanelW] = useState(PANEL_W_DEFAULT)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  // 删除确认 / LLM 未配置
  const [discardTarget, setDiscardTarget] = useState<ZhijijiQuestion | null>(null)
  const [needConfig, setNeedConfig] = useState(false)
  // 三 tab（2026-09-12 设计 §二）：沉淀 = 原问题+版本区；tab 不持久化（万象库/推理角惯例）
  const [tab, setTab] = useState<'core' | 'prophet' | 'twelve'>('core')
  const switchTab = (t: 'core' | 'prophet' | 'twelve'): void => {
    setTab(t)
    if (t !== 'core') {
      setViewQ(null)
      setAdding(false)
    }
  }

  const curVersion = versions.find((v) => v.id === curVerId) ?? null

  const load = async (): Promise<void> => {
    const rows = await window.api.zhijiji.list()
    setQuestions(rows)
    // 弹窗打开中：同步标题/版本数/更新时间（改名、保存版本后列表保持新鲜）
    setViewQ((vq) => rows.find((r) => r.id === vq?.id) ?? vq)
  }

  useEffect(() => {
    void load()
    // 追问栏布局偏好
    void window.api.settings.get(SettingsKeys.ZjPanelWidth).then((v) => {
      const n = v ? Number(v) : NaN
      if (Number.isFinite(n) && n >= PANEL_W_MIN && n <= PANEL_W_MAX) setPanelW(n)
    })
    void window.api.settings.get(SettingsKeys.ZjPanelCollapsed).then((v) => setPanelCollapsed(v === '1'))
  }, [])

  // keep-alive：切回致知己时刷新（回收站恢复等问题列表可能已变）
  useModuleActivated('zhijiji', () => void load())

  const changePanelW = (w: number): void => {
    setPanelW(w)
    void window.api.settings.set(SettingsKeys.ZjPanelWidth, String(w))
  }

  const togglePanel = (): void => {
    const next = !panelCollapsed
    setPanelCollapsed(next)
    void window.api.settings.set(SettingsKeys.ZjPanelCollapsed, next ? '1' : '0')
  }

  /** 打开问题详情：载入版本列表并定位到最新版本 */
  const open = async (q: ZhijijiQuestion, auto: boolean): Promise<void> => {
    const vs = await window.api.zhijiji.versions(q.id)
    setVersions(vs)
    setCurVerId(vs[0]?.id ?? null)
    setViewQ(q)
    setAutoEdit(auto)
  }

  /** 新建问题：默认空白 v1 直开编辑态；勾选 AI 初始化则 LLM 先出 v0 参考答案（失败不创建） */
  const createQuestion = async (): Promise<void> => {
    if (creating) return
    const t = addTitle.trim()
    if (!t) {
      toast('请填写问题标题')
      return
    }
    if (addAiInit) {
      const configured = await window.api.ai.configured()
      if (!configured) {
        setNeedConfig(true)
        return
      }
    }
    const jobId = crypto.randomUUID()
    setCreateJob(jobId)
    try {
      const r = await window.api.zhijiji.createQuestion(jobId, t, parseTagInput(addTags), addAiInit || undefined)
      setAdding(false)
      setAddTitle('')
      setAddTags('')
      setAddAiInit(false)
      toast(addAiInit ? 'AI 初始答案（v0）已生成，在此基础上写出你的 v1' : '已创建，写下属于你的 v1')
      await load()
      const rows = await window.api.zhijiji.list()
      const q = rows.find((x) => x.id === r.questionId)
      // 空白 v1 直开编辑态；AI v0 先渲染阅读，双击再动笔
      if (q) await open(q, !r.mdPath.endsWith('-v0.md'))
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else if (msg.includes('LLM_NOT_CONFIGURED')) setNeedConfig(true)
      else toast(`创建失败：${msg.slice(0, 100)}`)
    } finally {
      setCreateJob(null)
    }
  }

  /** 保存即版本（MdDialog versioned.onSave）：默认新版本，勾选覆盖当前版本 */
  const saveVersion = async (content: string, overwrite: boolean): Promise<void> => {
    if (!viewQ) return
    try {
      if (overwrite && curVerId != null) {
        await window.api.zhijiji.overwriteVersion(curVerId, content)
        toast('已覆盖当前版本')
      } else {
        const r = await window.api.zhijiji.saveNewVersion(viewQ.id, content)
        toast(`已保存新版本 v${r.seq}-${r.date}`)
        const vs = await window.api.zhijiji.versions(viewQ.id)
        setVersions(vs)
        setCurVerId(r.versionId)
      }
      await load()
    } catch (e) {
      toast(`保存失败：${String((e as Error).message).slice(0, 80)}`)
      throw e
    }
  }

  /** 让 AI 追问（版本条按钮）：直发弹窗内嵌追问栏（优化建议区第13轮，交互不出弹窗） */
  const askAi = async (content: string): Promise<void> => {
    const configured = await window.api.ai.configured()
    if (!configured) {
      setNeedConfig(true)
      return
    }
    if (panelCollapsed) togglePanel()
    const label = curVersion ? `v${curVersion.seq}-${curVersion.date}` : '当前版本'
    setAskPrompt((p) => ({
      text: `请对我写给自己的这个答案发起追问（较真地检验它，不要替我重写）：\n\n【问题】${viewQ?.title ?? ''}\n【当前版本】${label}\n【我的答案】\n${content}`,
      n: (p?.n ?? 0) + 1
    }))
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    await window.api.zhijiji.discard(discardTarget.id)
    toast('已放入回收站')
    if (viewQ?.id === discardTarget.id) setViewQ(null)
    setDiscardTarget(null)
    await load()
  }

  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">self_improvement</span>
        <span className="module-title">致知己</span>
        <span className="module-sub">把属于自己的答案沉淀成版本</span>
        {tab === 'core' && (
          <div className="zone-actions" style={{ marginLeft: 'auto' }}>
            <button className="btn" onClick={() => setAdding(true)}>
              <span className="material-symbols-outlined">add</span>
              新问题
            </button>
          </div>
        )}
      </div>

      {/* 三 tab：沉淀 ｜ 预言家 ｜ 十二问题（recycle-tabs 同款样式，万象库百科|辩真一致） */}
      <div className="recycle-tabs">
        <button className={`recycle-tab${tab === 'core' ? ' active' : ''}`} onClick={() => switchTab('core')}>
          沉淀
        </button>
        <button className={`recycle-tab${tab === 'prophet' ? ' active' : ''}`} onClick={() => switchTab('prophet')}>
          预言家
        </button>
        <button className={`recycle-tab${tab === 'twelve' ? ' active' : ''}`} onClick={() => switchTab('twelve')}>
          十二问题
        </button>
      </div>

      {tab === 'core' && (
        <>
      <section className="zone">
        <div className="zone-body">
          {questions.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">self_improvement</span>
              还没有问题，点右上角「新问题」开始写下属于自己的答案
            </div>
          )}
          {questions.map((q) => (
            <div className="row-item" key={q.id} onClick={() => void open(q, false)} title="点击打开答案版本">
              <div className="row-main">
                <div className="row-title">{q.title}</div>
                <div className="row-sub">
                  {(q.tags ?? []).slice(0, 4).map((t) => (
                    <span key={t} className="tag-chip mini">
                      {t}
                    </span>
                  ))}
                  {q.tags.length > 4 && <span className="tag-chip mini more">+{q.tags.length - 4}</span>}
                  　{q.version_count} 个版本 ｜ 更新 {fmtTime(q.updated_at)}
                </div>
              </div>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn danger"
                  title="删除（进回收站）"
                  onClick={() => setDiscardTarget(q)}
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 答案版本弹窗：md 区 + 右侧内嵌追问栏（可收起/拖宽/多会话） */}
      <MdDialog
        open={viewQ != null}
        title={viewQ?.title ?? ''}
        filePath={curVersion?.md_path ?? ''}
        onClose={() => setViewQ(null)}
        onChanged={() => void load()}
        onTitleChange={viewQ ? (t) => void window.api.zhijiji.renameQuestion(viewQ.id, t).then(load) : undefined}
        autoEdit={autoEdit}
        versioned={{
          versions: versions.map((v) => ({ id: v.id, label: `v${v.seq}-${v.date}` })),
          currentId: curVerId,
          onSelect: (id) => setCurVerId(id),
          onSave: saveVersion,
          onAskAi: (content) => void askAi(content)
        }}
        sidePanel={
          viewQ ? (
            panelCollapsed ? (
              <PanelRail onExpand={togglePanel} />
            ) : (
              <ZhijijiChat
                width={panelW}
                onWidthChange={changePanelW}
                onCollapse={togglePanel}
                autoAsk={askPrompt}
                onAutoAskConsumed={() => setAskPrompt(null)}
                onNeedConfig={() => setNeedConfig(true)}
              />
            )
          ) : undefined
        }
      />

      {/* 新问题弹窗（可选 AI 初始化答案 v0） */}
      {adding && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && !creating && setAdding(false)}>
          <div className="dialog" style={{ width: 440 }}>
            <div className="dialog-header">新问题</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                className="field"
                placeholder="问题标题（必填，如：线性代数和 AI 有什么渊源？）"
                value={addTitle}
                onChange={(e) => setAddTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void createQuestion()}
                autoFocus
              />
              <input
                className="field"
                placeholder="领域标签（可选，逗号或顿号分隔，如：线性代数、AI）"
                value={addTags}
                onChange={(e) => setAddTags(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void createQuestion()}
              />
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.9em', cursor: 'pointer' }}
                title="勾选后由 AI 先思考该问题并给出初始参考答案，记为 v0 版本；之后你在其上写自己的 v1、v2…"
              >
                <input
                  type="checkbox"
                  checked={addAiInit}
                  onChange={(e) => setAddAiInit(e.target.checked)}
                  style={{ accentColor: 'var(--color-primary)' }}
                />
                AI 初始化答案（生成 v0 参考答案，我再写自己的 v1）
              </label>
              <div className="module-sub">
                {addAiInit ? 'AI 生成约需十几秒，创建后会先展示 v0 供阅读' : '创建后直接打开空白 v1，双击即可开始写属于你的答案'}
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAdding(false)} disabled={creating}>
                取消
              </button>
              {createJob && (
                <button
                  className="btn"
                  onClick={() => void window.api.ai.cancel(createJob)}
                  title="取消本次生成"
                >
                  <span className="material-symbols-outlined">stop_circle</span>
                  取消
                </button>
              )}
              <button className="btn btn-primary" onClick={() => void createQuestion()} disabled={creating}>
                {creating ? 'AI 思考中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认（全局规则） */}
      <ConfirmDialog
        open={discardTarget != null}
        title="删除问题"
        confirmText="删除"
        danger
        onConfirm={() => void doDiscard()}
        onCancel={() => setDiscardTarget(null)}
      >
        将删除问题「{discardTarget?.title}」并放入回收站（全部版本答案一并封存，3 天后彻底删除）。
      </ConfirmDialog>

      {/* LLM 未配置引导（全局规则：不置灰，点击提示 + 去配置） */}
      <GoConfigDialog
        open={needConfig}
        kind="llm"
        onGoConfig={() => {
          setNeedConfig(false)
          props.onNavigateToProfile()
        }}
        onCancel={() => setNeedConfig(false)}
      />
        </>
      )}

      {tab === 'prophet' && (
        <ProphetPanel
          onOpenAi={props.onOpenAi}
          bumpAi={props.bumpAi}
          onNavigateToProfile={props.onNavigateToProfile}
        />
      )}
      {tab === 'twelve' && (
        <TwelvePanel onOpenAi={props.onOpenAi} onNavigateToProfile={props.onNavigateToProfile} />
      )}
    </div>
  )
}
