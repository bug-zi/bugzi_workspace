// 对弈社 Pane 公共件（2026-09-26 对弈社 design §5/§6）：会话 Hook（开局/快照节流/恢复/
// 悔棋/认输/终局/AI worker 调度）+ 开局面板 + 记录面板 + 战绩行 + 终局浮层。
// 各棋 Pane 提供引擎操作集（DuiyiEngineOps）与 worker 工厂；交互与棋盘渲染各自实现。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DuiyiGameKey, DuiyiGameRow, DuiyiStats } from '../../renderer/api'
import ConfirmDialog from '../../components/ConfirmDialog'

export type DuiyiResult = 'win' | 'loss' | 'draw'

export interface DuiyiEngineOps<S, M> {
  /** 新局状态 */
  create(difficulty: number, boardSpec: number | null): S
  /** 快照解析（坏快照返回 null） */
  parse(raw: string, difficulty: number, boardSpec: number | null): S | null
  apply(s: S, m: M): S
  status(s: S): { over: boolean; result?: DuiyiResult; reason?: string }
  /** 每次落子后的状态修正（围棋双 pass → 标记阶段在此切入） */
  afterApply?(s: S): S
  isMyTurn(s: S): boolean
  moveCount(s: S): number
}

export const DIFF_LABEL: Record<number, string> = { 1: '入门', 2: '进阶', 3: '挑战' }

export interface DuiyiSession<S, M> {
  row: DuiyiGameRow | null
  st: S | null
  thinking: boolean
  finished: { result: DuiyiResult; reason: string } | null
  stats: Record<DuiyiGameKey | 'total', DuiyiStats> | null
  records: DuiyiGameRow[]
  /** 我方回合是否可落子 */
  canPlay: boolean
  canUndo: boolean
  startGame(difficulty: number, boardSpec: number | null): Promise<void>
  myMove(m: M): void
  /** 标记阶段等特殊流程直接落状态（含持久化与终局检查） */
  commitState(s: S): void
  finishWith(s: S, result: DuiyiResult, reason: string): void
  undo(): void
  resign(): void
  /** 弃当前进行中局回开局面板（二次确认由调用方做） */
  dropPlaying(): void
  reloadMeta(): void
  discardRecord(id: number): Promise<void>
}

export function useDuiyiSession<S, M>(
  game: DuiyiGameKey,
  ops: DuiyiEngineOps<S, M>,
  makeWorker: () => Worker
): DuiyiSession<S, M> {
  const [row, setRow] = useState<DuiyiGameRow | null>(null)
  const [st, setSt] = useState<S | null>(null)
  const [thinking, setThinking] = useState(false)
  const [finished, setFinished] = useState<{ result: DuiyiResult; reason: string } | null>(null)
  const [stats, setStats] = useState<Record<DuiyiGameKey | 'total', DuiyiStats> | null>(null)
  const [records, setRecords] = useState<DuiyiGameRow[]>([])
  const rowRef = useRef<DuiyiGameRow | null>(null)
  const stRef = useRef<S | null>(null)
  const undoStack = useRef<S[]>([])
  const startedAt = useRef<number>(Date.now())
  const saveTimer = useRef<number | null>(null)
  const seqRef = useRef(0)
  const workerRef = useRef<Worker | null>(null)

  const loadMeta = useCallback(async (): Promise<void> => {
    try {
      const [s, r] = await Promise.all([window.api.duiyi.stats(), window.api.duiyi.list(game)])
      setStats(s)
      setRecords(r)
    } catch {
      /* 元信息加载失败不打断对局 */
    }
  }, [game])

  const persist = useCallback(
    (s: S, immediate = false): void => {
      const r = rowRef.current
      if (!r) return
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      const run = (): void => {
        void window.api.duiyi.saveState(game, r.id, JSON.stringify(s), ops.moveCount(s))
      }
      if (immediate) run()
      else saveTimer.current = window.setTimeout(run, 1200)
    },
    [game, ops]
  )

  const finishWith = useCallback(
    (s: S, result: DuiyiResult, reason: string): void => {
      const r = rowRef.current
      if (!r) return
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      const duration = Date.now() - startedAt.current
      setFinished({ result, reason })
      setThinking(false)
      rowRef.current = null
      void window.api.duiyi
        .finish(r.id, result, reason, JSON.stringify(s), ops.moveCount(s), duration)
        .then(() => loadMeta())
    },
    [game, ops, loadMeta]
  )

  // AI 走子回包：seq 防串局（悔棋/新局后的迟到回包直接丢弃）
  const onAiMessage = useCallback(
    (msg: { seq: number; move: M | null; error?: string }): void => {
      if (msg.seq !== seqRef.current) return
      const cur = stRef.current
      const r = rowRef.current
      setThinking(false)
      if (!cur || !r) return
      if (!msg.move) {
        finishWith(cur, 'win', 'AI 无着可走')
        return
      }
      let s2 = ops.apply(cur, msg.move)
      if (ops.afterApply) s2 = ops.afterApply(s2)
      stRef.current = s2
      setSt(s2)
      persist(s2)
      const stat = ops.status(s2)
      if (stat.over && stat.result) finishWith(s2, stat.result, stat.reason ?? '')
    },
    [ops, persist, finishWith]
  )

  useEffect(() => {
    void loadMeta()
    const w = makeWorker()
    workerRef.current = w
    w.onmessage = (e: MessageEvent<{ seq: number; move: M | null; error?: string }>): void =>
      onAiMessage(e.data)
    void window.api.duiyi.playing(game).then((playing) => {
      if (!playing) return
      const parsed = playing.state ? ops.parse(playing.state, playing.difficulty, playing.board_spec) : null
      if (!parsed) return // 坏快照：按无局处理，下次开新局自动顶掉
      rowRef.current = playing
      stRef.current = parsed
      startedAt.current = new Date(playing.started_at).getTime()
      undoStack.current = []
      setRow(playing)
      setSt(parsed)
    })
    return () => {
      w.onmessage = null
      w.terminate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scheduleAi = useCallback(
    (s: S): void => {
      const r = rowRef.current
      if (!r) return
      seqRef.current += 1
      setThinking(true)
      workerRef.current?.postMessage({ state: s, difficulty: r.difficulty, seq: seqRef.current })
    },
    []
  )

  const startGame = useCallback(
    async (difficulty: number, boardSpec: number | null): Promise<void> => {
      const s = ops.create(difficulty, boardSpec)
      const r = await window.api.duiyi.start(game, difficulty, boardSpec, JSON.stringify(s))
      rowRef.current = r
      stRef.current = s
      undoStack.current = []
      startedAt.current = Date.now()
      seqRef.current += 1
      setFinished(null)
      setRow(r)
      setSt(s)
    },
    [game, ops]
  )

  const myMove = useCallback(
    (m: M): void => {
      const cur = stRef.current
      if (!cur || !rowRef.current || thinking || finished) return
      if (!ops.isMyTurn(cur)) return
      undoStack.current = [...undoStack.current, cur]
      let s1 = ops.apply(cur, m)
      if (ops.afterApply) s1 = ops.afterApply(s1)
      stRef.current = s1
      setSt(s1)
      persist(s1)
      const stat = ops.status(s1)
      if (stat.over && stat.result) {
        finishWith(s1, stat.result, stat.reason ?? '')
        return
      }
      scheduleAi(s1)
    },
    [ops, persist, finishWith, scheduleAi, thinking, finished]
  )

  const commitState = useCallback(
    (s: S): void => {
      stRef.current = s
      setSt(s)
      persist(s, true)
      const stat = ops.status(s)
      if (stat.over && stat.result) finishWith(s, stat.result, stat.reason ?? '')
    },
    [ops, persist, finishWith]
  )

  const undo = useCallback((): void => {
    if (thinking || undoStack.current.length === 0 || finished) return
    const prev = undoStack.current.pop()!
    stRef.current = prev
    setSt(prev)
    persist(prev, true)
  }, [thinking, finished, persist])

  const resign = useCallback((): void => {
    const cur = stRef.current
    if (cur && rowRef.current && !finished) finishWith(cur, 'loss', '认输')
  }, [finishWith, finished])

  const dropPlaying = useCallback((): void => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    rowRef.current = null
    stRef.current = null
    seqRef.current += 1
    setThinking(false)
    setFinished(null)
    setRow(null)
    setSt(null)
  }, [])

  const discardRecord = useCallback(
    async (id: number): Promise<void> => {
      await window.api.duiyi.discard(id)
      await loadMeta()
    },
    [loadMeta]
  )

  const canPlay = st != null && row != null && !thinking && finished == null && ops.isMyTurn(st)
  const canUndo = st != null && row != null && !thinking && finished == null && undoStack.current.length > 0

  return {
    row,
    st,
    thinking,
    finished,
    stats,
    records,
    canPlay,
    canUndo,
    startGame,
    myMove,
    commitState,
    finishWith,
    undo,
    resign,
    dropPlaying,
    reloadMeta: () => void loadMeta(),
    discardRecord
  }
}

// ---------- 公共 UI 小件 ----------

export function DuiyiSetupPanel(props: {
  title: string
  sub: string
  difficulty: number
  onDifficulty: (d: number) => void
  extra?: React.ReactNode
  onStart: () => void
}) {
  const { title, sub, difficulty, onDifficulty, extra, onStart } = props
  return (
    <div className="dy-setup">
      <div className="dy-setup-card">
        <div className="dy-setup-title">
          <span className="material-symbols-outlined">chess</span>
          <span>{title}</span>
        </div>
        <div className="module-sub">{sub}</div>
        <div className="dy-setup-row">
          <span className="dy-setup-label">棋力</span>
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              className={`btn dy-diff-btn${difficulty === d ? ' active' : ''}`}
              onClick={() => onDifficulty(d)}
            >
              {DIFF_LABEL[d]}
            </button>
          ))}
        </div>
        {extra}
        <button className="btn btn-primary dy-start-btn" onClick={onStart}>
          <span className="material-symbols-outlined">sports_esports</span>
          开始对弈
        </button>
        <div className="module-sub">人机对弈 · 你执先手；进行中的局切走再回自动续玩</div>
      </div>
    </div>
  )
}

/** 时长展示（ms → X分Y秒 / X小时Y分） */
export function fmtDuration(ms: number | null): string {
  if (ms == null) return '--'
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total} 秒`
  if (total < 3600) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
  return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分`
}

export function fmtDyDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function DuiyiRecordPanel(props: {
  gameZh: string
  records: DuiyiGameRow[]
  onDiscard: (id: number) => void
}) {
  const { gameZh, records, onDiscard } = props
  const [delTarget, setDelTarget] = useState<DuiyiGameRow | null>(null)
  return (
    <section className="zone dy-records">
      <div className="zone-header">
        <span>对局记录</span>
        <span className="zone-count">{records.length}</span>
      </div>
      <div className="zone-body">
        {records.length === 0 && (
          <div className="empty-state" style={{ padding: '14px 0' }}>
            <span className="material-symbols-outlined">history</span>
            还没有{gameZh}对局记录
          </div>
        )}
        {records.map((r) => (
          <div className="row-item" key={r.id}>
            <div className="row-main">
              <div className="row-title">
                <span className={`dy-res-badge ${r.result}`}>{r.result === 'win' ? '胜' : r.result === 'loss' ? '负' : '和'}</span>
                {r.reason ?? ''}
              </div>
              <div className="row-sub">
                {fmtDyDate(r.started_at)} · {DIFF_LABEL[r.difficulty] ?? r.difficulty} · {r.move_count} 手 ·{' '}
                {fmtDuration(r.duration_ms)}
              </div>
            </div>
            <div className="row-actions">
              <button className="icon-btn danger" title="删除（进回收站）" onClick={() => setDelTarget(r)}>
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={delTarget != null}
        title="删除对局记录"
        confirmText="删除"
        danger
        onConfirm={() => {
          if (delTarget) onDiscard(delTarget.id)
          setDelTarget(null)
        }}
        onCancel={() => setDelTarget(null)}
      >
        将删除这局{gameZh}记录并放入回收站（3 天后自动彻底删除）。
      </ConfirmDialog>
    </section>
  )
}

export function DuiyiStatsRow(props: { gameZh: string; stats: Record<DuiyiGameKey | 'total', DuiyiStats> | null }) {
  const { gameZh, stats } = props
  if (!stats) return null
  const g = stats.total
  return (
    <div className="dy-stats-row">
      <span className="dy-stats-item">
        {gameZh}战绩 <b className="win">{g.win}</b> 胜 <b className="loss">{g.loss}</b> 负{' '}
        {g.draw > 0 && (
          <>
            <b className="draw">{g.draw}</b> 和
          </>
        )}
      </span>
      <span className="dy-stats-item dim">
        五棋总战绩 {g.win + g.loss + g.draw} 局 · 胜率 {g.win + g.loss + g.draw > 0 ? Math.round((g.win / (g.win + g.loss + g.draw)) * 100) : 0}%
      </span>
    </div>
  )
}

/** 终局浮层（再来一局 / 回开局面板） */
export function DuiyiOverDialog(props: {
  result: DuiyiResult
  reason: string
  onReplay: () => void
  onClose: () => void
}) {
  const { result, reason, onReplay, onClose } = props
  return (
    <div className="dialog-overlay">
      <div className="dialog" style={{ width: 360 }}>
        <div className="dialog-header">{result === 'win' ? '你赢了' : result === 'loss' ? '你输了' : '和棋'}</div>
        <div className="dialog-body" style={{ textAlign: 'center', lineHeight: 1.8 }}>
          <div className={`dy-over-icon ${result}`}>
            <span className="material-symbols-outlined">{result === 'win' ? 'emoji_events' : result === 'loss' ? 'sentiment_dissatisfied' : 'handshake'}</span>
          </div>
          {reason}
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={onClose}>
            回看棋局
          </button>
          <button className="btn btn-primary" onClick={onReplay}>
            再来一局
          </button>
        </div>
      </div>
    </div>
  )
}
