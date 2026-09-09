// 海龟汤板块（推理角 specs §2）：汤库 / 对局（自由局）/ 对局记录
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TurtleGameMessageRow,
  TurtleGamePayload,
  TurtleGameRecordRow,
  TurtleSoupRow
} from '../../renderer/api'
import { TURTLE_GAME_EVENT } from '../../shared/types'
import { MODULE_ACTIVATED_EVENT, MODULE_DEACTIVATED_EVENT } from '../../App'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

const DIFF_ZH: Record<string, string> = { easy: '简单', medium: '中等', hard: '困难' }
const SOUP_STATUS_ZH: Record<string, string> = {
  fresh: '未玩',
  playing: '进行中',
  solved: '已破',
  abandoned: '弃汤'
}
const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'easy', label: '简单' },
  { id: 'medium', label: '中等' },
  { id: 'hard', label: '困难' }
]
const PREFERENCES = [
  { id: 'random', label: '随机难度' },
  { id: 'easy', label: '简单' },
  { id: 'medium', label: '中等' },
  { id: 'hard', label: '困难' }
]

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 问答流单条渲染：guess/verdict 强调块、invalid 引导弱化、notice 斜体注记 */
function MsgView({ m }: { m: TurtleGameMessageRow }) {
  if (m.type === 'guess') {
    return (
      <div className="rs-msg user rs-guess" title="我猜汤底">
        {m.content}
      </div>
    )
  }
  if (m.type === 'verdict') {
    return <div className="rs-verdict">{m.content}</div>
  }
  if (m.type === 'notice') {
    return <div className="rs-notice">{m.content}</div>
  }
  if (m.type === 'invalid') {
    return <div className="rs-msg ai rs-invalid">{m.content}</div>
  }
  if (m.role === 'user') {
    return <div className="rs-msg user">{m.content}</div>
  }
  return <div className="rs-msg ai">{m.content}</div>
}

export default function TurtlePanel() {
  const { toast } = useToast()
  // 库视图状态（gameData 非空 = 对局视图）
  const [gameData, setGameData] = useState<TurtleGamePayload | null>(null)
  const [libTab, setLibTab] = useState<'soups' | 'records'>('soups')
  const [soups, setSoups] = useState<TurtleSoupRow[]>([])
  const [records, setRecords] = useState<TurtleGameRecordRow[]>([])
  const [filter, setFilter] = useState('all')
  const [preference, setPreference] = useState('random')
  const [genJob, setGenJob] = useState<string | null>(null)
  const generating = genJob != null
  // 对局进行态
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false) // ask / guess / abandon 的 LLM 调用中
  const [busyJob, setBusyJob] = useState<string | null>(null) // busy 对应的 jobId（取消按钮用）
  const [reportBusy, setReportBusy] = useState(false) // 复盘报告懒生成中（优化建议区第26轮）
  const [reportJob, setReportJob] = useState<string | null>(null)
  const [guessOpen, setGuessOpen] = useState(false)
  const [guessText, setGuessText] = useState('')
  const [revealed, setRevealed] = useState<{ bottom: string; mdPath: string | null } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  // ---------- 净用时计时（优化建议区第26轮）：主进程记账，渲染层只发边界事件 ----------
  const [moduleActive, setModuleActive] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')
  const playing = gameData?.status === 'playing'
  const timerActive = playing && moduleActive && pageVisible
  const baseMsRef = useRef(0) // 已结算净用时（payload.activeMs 种子）
  const segStartRef = useRef<number | null>(null) // 本地当前活跃段起点（仅显示用）

  const settleLocalSegment = (): void => {
    if (segStartRef.current != null) {
      baseMsRef.current += Date.now() - segStartRef.current
      segStartRef.current = null
    }
  }
  // 弹窗与确认
  const [abandonTarget, setAbandonTarget] = useState<TurtleGamePayload | null>(null)
  const [discardSoupTarget, setDiscardSoupTarget] = useState<TurtleSoupRow | null>(null)
  const [discardGameTarget, setDiscardGameTarget] = useState<TurtleGameRecordRow | null>(null)
  const [recordDoc, setRecordDoc] = useState<{ title: string; subtitle: string; path: string } | null>(
    null
  )
  const [goConfig, setGoConfig] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const chatBottomRef = useRef<HTMLDivElement>(null)

  const loadSoups = useCallback(async () => {
    setSoups(await window.api.turtle.listSoups(filter === 'all' ? undefined : filter))
  }, [filter])

  const loadRecords = useCallback(async () => {
    setRecords(await window.api.turtle.listGames())
  }, [])

  useEffect(() => {
    void loadSoups()
  }, [loadSoups])
  useEffect(() => {
    void loadRecords()
  }, [loadRecords])

  // 草稿本联动（优化建议区第21轮）：进出对局视图广播对局上下文（App 接住传 DraftSidebar，
  // 面板据此自动切海龟汤频道 + 新建草稿以汤名命名；不预填正文，开发者 260907 定）
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(TURTLE_GAME_EVENT, {
        detail: gameData ? { title: gameData.title } : null
      })
    )
  }, [gameData])

  // keep-alive：切回推理角时刷新（后台可能已终局）
  useModuleActivated('reasoning', () => {
    if (!gameData) {
      void loadSoups()
      void loadRecords()
    }
  })

  // 题库预生成（v1.3）：补充泵后台补的汤渐进出现（事件驱动刷新，无 toast 打扰；对局视图同样安全刷新列表态）
  useEffect(() => {
    const off = window.api.reasoning.onStockChanged(() => void loadSoups())
    return off
  }, [loadSoups])

  // 模块激活/失活跟踪（常驻挂载，初始非激活；激活/失活事件对维护）
  useEffect(() => {
    const on = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === 'reasoning') setModuleActive(true)
    }
    const off = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === 'reasoning') setModuleActive(false)
    }
    window.addEventListener(MODULE_ACTIVATED_EVENT, on)
    window.addEventListener(MODULE_DEACTIVATED_EVENT, off)
    return () => {
      window.removeEventListener(MODULE_ACTIVATED_EVENT, on)
      window.removeEventListener(MODULE_DEACTIVATED_EVENT, off)
    }
  }, [])

  // 窗口可见性跟踪（最小化/被完全遮挡 → 暂停；失焦但可见不暂停——可能正盯着汤面思考）
  useEffect(() => {
    const h = (): void => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [])

  // 活跃边界翻转：本地开段/结算段 + 通知主进程（对非 playing 局 no-op，终局竞态无害）
  useEffect(() => {
    const gameId = gameData?.gameId
    if (!gameId) return
    if (timerActive) {
      if (segStartRef.current == null) segStartRef.current = Date.now()
      void window.api.turtle.timerStart(gameId)
    } else {
      settleLocalSegment()
      void window.api.turtle.timerPause(gameId)
    }
    // 离开对局视图（gameId 变化/置空）：结算本地段并兜底 pause
    return () => {
      settleLocalSegment()
      void window.api.turtle.timerPause(gameId)
    }
  }, [timerActive, gameData?.gameId])

  // 用时显示：活跃段每秒跳动；终局/回看直接取落库净用时
  useEffect(() => {
    if (!gameData) return
    if (!playing) {
      setElapsed(gameData.durationMs ?? 0)
      return
    }
    const show = (): void =>
      setElapsed(
        baseMsRef.current + (segStartRef.current != null ? Date.now() - segStartRef.current : 0)
      )
    show()
    const t = setInterval(show, 1000)
    return () => clearInterval(t)
  }, [gameData, playing, timerActive])

  // 问答流自动滚到底
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ block: 'end' })
  }, [gameData?.messages.length, revealed, busy])

  const handleErr = (e: unknown): void => {
    const msg = String((e as Error).message)
    if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
    else setFailMsg(msg)
  }

  const generate = async (): Promise<void> => {
    if (genJob) return
    const jobId = crypto.randomUUID()
    setGenJob(jobId)
    try {
      const r = await window.api.turtle.generate(
        jobId,
        preference as 'random' | 'easy' | 'medium' | 'hard'
      )
      toast(`已出 ${r.inserted} 碗汤`)
      await loadSoups()
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else handleErr(e)
    } finally {
      setGenJob(null)
    }
  }

  /** 开局 / 续局 / 终局回看（playing 汤点击 = 续玩；终局汤点击 = 只读回看，payload 自带汤底） */
  const openSoup = async (soup: TurtleSoupRow): Promise<void> => {
    if (busy) return
    try {
      const g = await window.api.turtle.openSoup(soup.id)
      setGameData(g)
      baseMsRef.current = g.activeMs ?? 0
      segStartRef.current = null
      setRevealed(g.bottom ? { bottom: g.bottom, mdPath: g.mdPath ?? null } : null)
      setInput('')
      setGuessOpen(false)
      setGuessText('')
      await loadSoups()
    } catch (e) {
      handleErr(e)
    }
  }

  const ask = async (): Promise<void> => {
    const q = input.trim()
    if (!q || !gameData || busy) return
    const jobId = crypto.randomUUID()
    setBusy(true)
    setBusyJob(jobId)
    // 乐观上屏（照 AI 边栏同款机制）：问题即刻入对话流、输入框即刻清空，裁判回复到达后再追加
    const optimisticId = -Date.now()
    setInput('')
    setGameData((prev) =>
      prev && {
        ...prev,
        messages: [
          ...prev.messages,
          {
            id: optimisticId,
            role: 'user' as const,
            type: 'question' as const,
            content: q,
            created_at: new Date().toISOString()
          }
        ]
      }
    )
    try {
      const r = await window.api.turtle.ask(jobId, gameData.gameId, q)
      setGameData((prev) =>
        prev && {
          ...prev,
          questionCount: r.questionCount,
          messages: [
            ...prev.messages,
            {
              id: optimisticId - 1,
              role: 'assistant' as const,
              type: r.type === 'invalid' ? ('invalid' as const) : ('answer' as const),
              content: r.reply,
              created_at: new Date().toISOString()
            }
          ]
        }
      )
    } catch (e) {
      // 判答失败：主进程未落库此问答——回滚乐观消息、还原输入，保持界面与库一致
      setGameData((prev) =>
        prev && { ...prev, messages: prev.messages.filter((m) => m.id !== optimisticId) }
      )
      setInput(q)
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else handleErr(e)
    } finally {
      setBusy(false)
      setBusyJob(null)
    }
  }

  const guess = async (): Promise<void> => {
    const g = guessText.trim()
    if (!g || !gameData || busy) return
    const jobId = crypto.randomUUID()
    setBusy(true)
    setBusyJob(jobId)
    try {
      const r = await window.api.turtle.guess(jobId, gameData.gameId, g)
      const vText = r.solved
        ? `破汤！${r.feedback}`
        : `未破。${r.hits.length ? `已命中：${r.hits.join('；')}。` : ''}${
            r.misses.length ? `有偏差：${r.misses.join('；')}。` : ''
          }${r.feedback}`
      const now = new Date().toISOString()
      setGuessText('')
      setGuessOpen(false)
      setGameData((prev) =>
        prev && {
          ...prev,
          status: r.solved ? 'solved' : prev.status,
          durationMs: r.solved ? r.durationMs : prev.durationMs,
          messages: [
            ...prev.messages,
            { id: -Date.now(), role: 'user' as const, type: 'guess' as const, content: g, created_at: now },
            { id: -Date.now() - 1, role: 'assistant' as const, type: 'verdict' as const, content: vText, created_at: now }
          ]
        }
      )
      if (r.solved && r.bottom) {
        setRevealed({ bottom: r.bottom, mdPath: null })
      }
      await loadSoups()
      await loadRecords()
    } catch (e) {
      // 取消：判答未落库，guessText/guessOpen 未动，可改后重交
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else handleErr(e)
    } finally {
      setBusy(false)
      setBusyJob(null)
    }
  }

  const doAbandon = async (): Promise<void> => {
    if (!abandonTarget || busy) return
    const jobId = crypto.randomUUID()
    setBusy(true)
    setBusyJob(jobId)
    try {
      const r = await window.api.turtle.abandon(jobId, abandonTarget.gameId)
      const now = new Date().toISOString()
      setGameData((prev) =>
        prev && {
          ...prev,
          status: 'abandoned',
          durationMs: r.durationMs,
          messages: [
            ...prev.messages,
            {
              id: -Date.now(),
              role: 'system' as const,
              type: 'notice' as const,
              content: '我放弃了本局，揭示汤底。',
              created_at: now
            }
          ]
        }
      )
      setRevealed({ bottom: r.bottom, mdPath: null })
      setAbandonTarget(null)
      await loadSoups()
      await loadRecords()
    } catch (e) {
      // 终局链已无 LLM 调用（秒回），此处失败即真失败（库/网络层）
      handleErr(e)
    } finally {
      setBusy(false)
      setBusyJob(null)
    }
  }

  const doDiscardSoup = async (): Promise<void> => {
    if (!discardSoupTarget) return
    try {
      await window.api.turtle.discardSoup(discardSoupTarget.id)
      toast('已放入回收站')
      setDiscardSoupTarget(null)
      await loadSoups()
    } catch (e) {
      handleErr(e)
      setDiscardSoupTarget(null)
    }
  }

  const doDiscardGame = async (): Promise<void> => {
    if (!discardGameTarget) return
    try {
      await window.api.turtle.discardGame(discardGameTarget.id)
      toast('已放入回收站')
      setDiscardGameTarget(null)
      await loadRecords()
    } catch (e) {
      handleErr(e)
      setDiscardGameTarget(null)
    }
  }

  const backToLibrary = (): void => {
    setGameData(null)
    setRevealed(null)
    void loadSoups()
    void loadRecords()
  }

  /** 打开复盘报告（优化建议区第26轮懒生成）：已有 md 直接开；无则现场生成（可取消/失败可重试） */
  const openReport = async (
    gameId: number,
    title: string,
    subtitle: string,
    knownPath?: string | null
  ): Promise<void> => {
    if (knownPath) {
      setRecordDoc({ title, subtitle, path: knownPath })
      return
    }
    if (reportBusy) return
    const jobId = crypto.randomUUID()
    setReportBusy(true)
    setReportJob(jobId)
    toast('复盘生成中…')
    try {
      const path = await window.api.turtle.report(jobId, gameId)
      setRecordDoc({ title, subtitle, path })
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else handleErr(e)
    } finally {
      setReportBusy(false)
      setReportJob(null)
    }
  }

  // 公共弹窗层（对局 / 库两视图共用）：原先只挂在库视图尾部，对局分支早返回将其隔离，
  // 对局中点「放弃」等弹窗无响应——提取为变量，两视图各自渲染
  const dialogs = (
    <>
      {/* 放弃二次确认（总需求文档第 1 条） */}
      <ConfirmDialog
        open={abandonTarget != null}
        title="放弃本局"
        confirmText="放弃并看汤底"
        danger
        onConfirm={() => void doAbandon()}
        onCancel={() => setAbandonTarget(null)}
      >
        放弃后本局记为「弃汤」并立即揭示汤底；复盘报告（含 AI 卡点点评）点「查看复盘」时生成。该汤不可再玩。
      </ConfirmDialog>

      {/* 汤删除二次确认 */}
      <ConfirmDialog
        open={discardSoupTarget != null}
        title="放入回收站"
        confirmText="丢弃"
        danger
        onConfirm={() => void doDiscardSoup()}
        onCancel={() => setDiscardSoupTarget(null)}
      >
        将《{discardSoupTarget?.title ?? ''}》放入回收站，3 天后自动彻底删除；已有对局记录不受影响。
      </ConfirmDialog>

      {/* 对局记录删除二次确认 */}
      <ConfirmDialog
        open={discardGameTarget != null}
        title="放入回收站"
        confirmText="丢弃"
        danger
        onConfirm={() => void doDiscardGame()}
        onCancel={() => setDiscardGameTarget(null)}
      >
        将「《{discardGameTarget?.title ?? ''}》对局记录」放入回收站，3 天后自动彻底删除。
      </ConfirmDialog>

      {/* 对局记录 / 复盘（全局 md 弹窗，渲染态查看） */}
      <MdDialog
        key={recordDoc?.path ?? 'none'}
        open={recordDoc != null}
        title={recordDoc?.title ?? ''}
        subtitle={recordDoc?.subtitle}
        filePath={recordDoc?.path ?? ''}
        onClose={() => setRecordDoc(null)}
      />

      {/* LLM 未配置（全局规则 8） */}
      <GoConfigDialog
        open={goConfig}
        kind="llm"
        onGoConfig={() => setGoConfig(false)}
        onCancel={() => setGoConfig(false)}
      />

      {/* 调用失败 */}
      {failMsg && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setFailMsg(null)}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">出错了</div>
            <div className="dialog-body" style={{ lineHeight: 1.7, wordBreak: 'break-all' }}>
              {failMsg}
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setFailMsg(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  // ---------- 对局视图 ----------
  if (gameData) {
    const playing = gameData.status === 'playing'
    return (
      <>
        <div className="zone rs-game">
        <div className="zone-header rs-game-header">
          <button className="btn btn-ghost" onClick={backToLibrary}>
            <span className="material-symbols-outlined">arrow_back</span>
            返回
          </button>
          <span className="rs-game-title" title={gameData.title}>
            《{gameData.title}》
          </span>
          <span className="badge">{DIFF_ZH[gameData.difficulty] ?? gameData.difficulty}</span>
          <span className="badge">{gameData.theme}</span>
          <span className="module-sub rs-game-meta">
            问 {gameData.questionCount} · 用时 {fmtDuration(elapsed)}
          </span>
        </div>
        <div className="zone-body rs-game-body">
          <div className="rs-surface">
            <div className="rs-surface-title">汤面</div>
            <div className="rs-surface-text">{gameData.surface}</div>
          </div>

          <div className="rs-chat">
            {gameData.messages.map((m) => (
              <MsgView key={m.id} m={m} />
            ))}
            {busy && (
              <div className="rs-msg ai rs-thinking">
                <span className="material-symbols-outlined spin">progress_activity</span>
                裁判思考中…
                {busyJob && (
                  <button
                    className="btn btn-ghost rs-stop"
                    onClick={() => void window.api.ai.cancel(busyJob)}
                    title="取消本次判答"
                  >
                    停止
                  </button>
                )}
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {revealed && (
            <div className="rs-reveal">
              <div className="rs-reveal-title">
                {gameData.status === 'solved' ? '汤底（破汤）' : '汤底（弃汤揭示）'}
              </div>
              <div className="rs-surface-text">{revealed.bottom}</div>
              <div className="rs-reveal-actions">
                <button
                  className="btn btn-primary"
                  disabled={reportBusy}
                  onClick={() =>
                    void openReport(
                      gameData.gameId,
                      `《${gameData.title}》· 对局复盘`,
                      `${gameData.status === 'solved' ? '已破汤' : '弃汤'} · 问 ${gameData.questionCount}`,
                      revealed.mdPath
                    )
                  }
                >
                  <span className={`material-symbols-outlined${reportBusy ? ' spin' : ''}`}>
                    description
                  </span>
                  {reportBusy ? '复盘生成中…' : '查看复盘'}
                </button>
                {reportBusy && reportJob && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => void window.api.ai.cancel(reportJob)}
                    title="取消生成"
                  >
                    停止
                  </button>
                )}
              </div>
            </div>
          )}

          {playing ? (
            <div className="rs-input">
              {guessOpen ? (
                <>
                  <textarea
                    className="field rs-guess-input"
                    rows={3}
                    placeholder="写下你的完整推理，提交猜汤底（次数不限）…"
                    value={guessText}
                    onChange={(e) => setGuessText(e.target.value)}
                    autoFocus
                  />
                  <div className="rs-input-actions">
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => {
                        setGuessOpen(false)
                        setGuessText('')
                      }}
                    >
                      收起
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={!guessText.trim() || busy}
                      onClick={() => void guess()}
                    >
                      {busy ? '判定中…' : '提交推理'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <input
                    className="field"
                    placeholder="提一个判断类问题（能用是/否回答）…"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void ask()
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    disabled={!input.trim() || busy}
                    onClick={() => void ask()}
                  >
                    提问
                  </button>
                  <button className="btn" disabled={busy} onClick={() => setGuessOpen(true)}>
                    我猜汤底
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => setAbandonTarget(gameData)}
                  >
                    放弃
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="rs-finished module-sub">本局已结束，点顶部「返回」回汤库</div>
          )}
        </div>
      </div>
        {dialogs}
      </>
    )
  }

  // ---------- 库视图 ----------
  return (
    <>
      <div className="card" style={{ padding: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          className="field"
          style={{ width: 'auto' }}
          value={preference}
          onChange={(e) => setPreference(e.target.value)}
          title="出题难度偏好"
        >
          {PREFERENCES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={generating} onClick={() => void generate()}>
          <span className={`material-symbols-outlined${generating ? ' spin' : ''}`}>casino</span>
          {generating ? '出题中，审题人正在验汤…' : '来 3 碗汤'}
        </button>
        {genJob && (
          <button className="btn" onClick={() => void window.api.ai.cancel(genJob)} title="取消本次生成">
            <span className="material-symbols-outlined">stop_circle</span>
            取消
          </button>
        )}
        <div className="recycle-tabs" style={{ marginLeft: 'auto' }}>
          <button
            className={`recycle-tab${libTab === 'soups' ? ' active' : ''}`}
            onClick={() => setLibTab('soups')}
          >
            汤库
          </button>
          <button
            className={`recycle-tab${libTab === 'records' ? ' active' : ''}`}
            onClick={() => setLibTab('records')}
          >
            对局记录
          </button>
        </div>
      </div>

      {libTab === 'soups' && (
        <div className="zone">
          <div className="zone-header" style={{ cursor: 'default' }}>
            <span className="material-symbols-outlined">extension</span>
            <span>汤库</span>
            <span className="zone-count">{soups.length}</span>
            <div className="zone-actions" onClick={(e) => e.stopPropagation()}>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={`tag-chip mini${filter === f.id ? ' active' : ''}`}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="zone-body">
            {soups.length === 0 && (
              <div className="empty-state">
                <span className="material-symbols-outlined">extension</span>
                汤库是空的——AI 正在后台备汤，稍候即有新汤；或点「来 3 碗汤」立即补
              </div>
            )}
            {soups.map((s) => (
              <div
                className="row-item"
                key={s.id}
                onClick={() => void openSoup(s)}
                title={
                  s.status === 'playing'
                    ? '继续这碗汤'
                    : s.status === 'fresh'
                      ? '开局'
                      : '已终局，点击回看本局问答与汤底'
                }
              >
                <div className="row-main">
                  <div className="row-title">《{s.title}》</div>
                  <div className="row-sub">
                    {DIFF_ZH[s.difficulty] ?? s.difficulty} · {s.theme_tag} · {fmtDate(s.created_at)}
                  </div>
                </div>
                <span className={`badge${s.status === 'solved' ? ' primary' : ''}`}>
                  {SOUP_STATUS_ZH[s.status] ?? s.status}
                </span>
                {s.status !== 'playing' && (
                  <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="icon-btn danger"
                      title={s.status === 'fresh' ? '放入回收站' : '放入回收站（不影响已有对局记录）'}
                      onClick={() => setDiscardSoupTarget(s)}
                    >
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {libTab === 'records' && (
        <div className="zone">
          <div className="zone-header" style={{ cursor: 'default' }}>
            <span className="material-symbols-outlined">history</span>
            <span>对局记录</span>
            <span className="zone-count">{records.length}</span>
          </div>
          <div className="zone-body">
            {records.length === 0 && (
              <div className="empty-state">
                <span className="material-symbols-outlined">history</span>
                还没有对局记录，破一碗汤或弃一碗汤后自动存档
              </div>
            )}
            {records.map((r) => (
              <div
                className="row-item"
                key={r.id}
                onClick={() =>
                  void openReport(
                    r.id,
                    `《${r.title}》· 对局复盘`,
                    `${r.status === 'solved' ? '已破汤' : '弃汤'} · 问 ${r.question_count}`,
                    r.md_path
                  )
                }
              >
                <span className="material-symbols-outlined">description</span>
                <div className="row-main">
                  <div className="row-title">《{r.title}》</div>
                  <div className="row-sub">
                    {r.status === 'solved' ? '已破汤' : '弃汤'} · 提问 {r.question_count} 次 · 用时{' '}
                    {fmtDuration(r.duration_ms ?? 0)} · {fmtDate(r.ended_at)}
                    {!r.md_path && ' · 复盘待生成'}
                  </div>
                </div>
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="icon-btn danger"
                    title="放入回收站"
                    onClick={() => setDiscardGameTarget(r)}
                  >
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {dialogs}
    </>
  )
}
