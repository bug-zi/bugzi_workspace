// 海龟汤板块（推理角 specs §2）：汤库 / 对局（自由局）/ 对局记录
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TurtleGameMessageRow,
  TurtleGamePayload,
  TurtleGameRecordRow,
  TurtleSoupRow
} from '../../renderer/api'
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
  const [generating, setGenerating] = useState(false)
  // 对局进行态
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false) // ask / guess / abandon 的 LLM 调用中
  const [guessOpen, setGuessOpen] = useState(false)
  const [guessText, setGuessText] = useState('')
  const [revealed, setRevealed] = useState<{ bottom: string; mdPath: string } | null>(null)
  const [elapsed, setElapsed] = useState(0)
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

  // keep-alive：切回推理角时刷新（后台可能已终局）
  useModuleActivated('reasoning', () => {
    if (!gameData) {
      void loadSoups()
      void loadRecords()
    }
  })

  // 对局用时实时跳动（局终即停）
  useEffect(() => {
    if (!gameData || gameData.status !== 'playing') return
    const tick = (): number => Date.now() - new Date(gameData.startedAt).getTime()
    setElapsed(tick())
    const t = setInterval(() => setElapsed(tick()), 1000)
    return () => clearInterval(t)
  }, [gameData])

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
    if (generating) return
    setGenerating(true)
    try {
      const r = await window.api.turtle.generate(
        preference as 'random' | 'easy' | 'medium' | 'hard'
      )
      toast(`已出 ${r.inserted} 碗汤`)
      await loadSoups()
    } catch (e) {
      handleErr(e)
    } finally {
      setGenerating(false)
    }
  }

  /** 开局 / 续局（playing 汤点击 = 续玩） */
  const openSoup = async (soup: TurtleSoupRow): Promise<void> => {
    if (busy) return
    try {
      const g = await window.api.turtle.openSoup(soup.id)
      setGameData(g)
      setRevealed(null)
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
    setBusy(true)
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
      const r = await window.api.turtle.ask(gameData.gameId, q)
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
      handleErr(e)
    } finally {
      setBusy(false)
    }
  }

  const guess = async (): Promise<void> => {
    const g = guessText.trim()
    if (!g || !gameData || busy) return
    setBusy(true)
    try {
      const r = await window.api.turtle.guess(gameData.gameId, g)
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
          messages: [
            ...prev.messages,
            { id: -Date.now(), role: 'user' as const, type: 'guess' as const, content: g, created_at: now },
            { id: -Date.now() - 1, role: 'assistant' as const, type: 'verdict' as const, content: vText, created_at: now }
          ]
        }
      )
      if (r.solved && r.bottom && r.mdPath) {
        setRevealed({ bottom: r.bottom, mdPath: r.mdPath })
      }
      await loadSoups()
      await loadRecords()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusy(false)
    }
  }

  const doAbandon = async (): Promise<void> => {
    if (!abandonTarget || busy) return
    setBusy(true)
    try {
      const r = await window.api.turtle.abandon(abandonTarget.gameId)
      const now = new Date().toISOString()
      setGameData((prev) =>
        prev && {
          ...prev,
          status: 'abandoned',
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
      setRevealed({ bottom: r.bottom, mdPath: r.mdPath })
      setAbandonTarget(null)
      await loadSoups()
      await loadRecords()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusy(false)
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

  const openRecord = (title: string, subtitle: string, path: string): void => {
    if (path) setRecordDoc({ title, subtitle, path })
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
        放弃后本局记为「弃汤」并揭示汤底，AI 会附一段卡点点评；该汤不可再玩。
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
              <div>
                <button
                  className="btn btn-primary"
                  onClick={() =>
                    openRecord(
                      `《${gameData.title}》· 对局复盘`,
                      `${gameData.status === 'solved' ? '已破汤' : '弃汤'} · 问 ${gameData.questionCount}`,
                      revealed.mdPath
                    )
                  }
                >
                  <span className="material-symbols-outlined">description</span>
                  查看复盘
                </button>
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
          {generating ? 'AI 出汤中…' : '来 3 碗汤'}
        </button>
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
                汤库是空的，点「来 3 碗汤」让 AI 出题
              </div>
            )}
            {soups.map((s) => {
              const startable = s.status === 'fresh' || s.status === 'playing'
              return (
                <div
                  className="row-item"
                  key={s.id}
                  onClick={() => startable && void openSoup(s)}
                  style={{ cursor: startable ? 'pointer' : 'default' }}
                  title={startable ? (s.status === 'playing' ? '继续这碗汤' : '开局') : '已终局，不可再玩'}
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
              )
            })}
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
                  openRecord(
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
