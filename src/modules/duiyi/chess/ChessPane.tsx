// 对弈社·国际象棋 Pane：8×8 棋盘格 + 中文单字子 + 点选走子 + 升变四选弹窗
import { useMemo, useState } from 'react'
import ConfirmDialog from '../../../components/ConfirmDialog'
import { csLegalMoves, csStatusOf, applyCsMove, initCsState, CK } from './engine'
import type { CsMove, CsState } from './engine'
import {
  DuiyiOverDialog,
  DuiyiRecordPanel,
  DuiyiSetupPanel,
  DuiyiStatsRow,
  useDuiyiSession
} from '../pane-kit'
import DuiyiHelpDialog from '../DuiyiHelpDialog'

const CHAR: Record<number, string> = { 1: '王', 2: '后', 3: '车', 4: '象', 5: '马', 6: '兵' }
const PROMO_LABEL: Record<number, string> = { 2: '后', 3: '车', 4: '象', 5: '马' }

const row = (i: number): number => Math.floor(i / 8)
const col = (i: number): number => i % 8

const OPS = {
  create: (): CsState => initCsState(),
  parse: (raw: string): CsState | null => {
    try {
      const o = JSON.parse(raw) as CsState
      if (
        Array.isArray(o.board) &&
        o.board.length === 64 &&
        (o.turn === 1 || o.turn === -1) &&
        o.castling &&
        Array.isArray(o.history)
      ) {
        return o
      }
      return null
    } catch {
      return null
    }
  },
  apply: applyCsMove,
  status: (s: CsState) => csStatusOf(s),
  isMyTurn: (s: CsState): boolean => s.turn === 1,
  moveCount: (s: CsState): number => s.history.length
}

export default function ChessPane() {
  const ops = OPS
  const sess = useDuiyiSession<CsState, CsMove>('chess', ops, () =>
    new Worker(new URL('./chess.worker.ts', import.meta.url), { type: 'module' })
  )
  const [difficulty, setDifficulty] = useState(2)
  const [selected, setSelected] = useState<number | null>(null)
  const [confirmNew, setConfirmNew] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [promoPick, setPromoPick] = useState<{ to: number; options: CsMove[] } | null>(null)

  const targets = useMemo(
    () => (sess.st && selected != null && sess.canPlay ? csLegalMoves(sess.st, selected) : []),
    [sess.st, selected, sess.canPlay]
  )
  const targetSet = useMemo(() => new Set(targets.map((m) => m.to)), [targets])

  const onCell = (i: number): void => {
    if (!sess.canPlay || !sess.st) return
    const p = sess.st.board[i]
    if (selected != null && targetSet.has(i)) {
      const options = targets.filter((m) => m.to === i)
      if (options[0].promo) {
        setPromoPick({ to: i, options })
        return
      }
      sess.myMove(options[0])
      setSelected(null)
      return
    }
    if (p > 0) {
      setSelected(selected === i ? null : i)
      return
    }
    setSelected(null)
  }

  const st = sess.st
  return (
    <div className="dy-pane">
      {st ? (
        <div className="dy-board-wrap">
          <div className="dy-status">
            {sess.finished ? (
              <span>对局结束 · {sess.finished.reason}</span>
            ) : sess.thinking ? (
              <>
                <span className="material-symbols-outlined spin">progress_activity</span> AI 思考中…
              </>
            ) : sess.canPlay ? (
              <span>轮到你（白方） · 第 {Math.floor(st.history.length / 2) + 1} 回合</span>
            ) : (
              <span>等待中…</span>
            )}
            <span className="dy-status-right">难度 {['', '入门', '进阶', '挑战'][sess.row?.difficulty ?? 2]}</span>
          </div>
          <div className="dy-cs-board">
            {st.board.map((p, i) => {
              const dark = (row(i) + col(i)) % 2 === 1
              const isTarget = targetSet.has(i)
              const isSel = selected === i
              return (
                <button
                  key={i}
                  className={`dy-cs-cell ${dark ? 'dark' : 'light'}${isTarget ? ' target' : ''}${isSel ? ' sel' : ''}`}
                  onClick={() => onCell(i)}
                >
                  {p !== 0 && (
                    <span className={`dy-cs-piece ${p > 0 ? 'white' : 'black'}`}>{CHAR[Math.abs(p)]}</span>
                  )}
                </button>
              )
            })}
          </div>
          <div className="dy-controls">
            <button className="btn" disabled={!sess.canUndo} onClick={sess.undo}>
              <span className="material-symbols-outlined">undo</span>
              悔棋
            </button>
            <button className="btn" disabled={sess.thinking || !!sess.finished} onClick={() => setConfirmNew(true)}>
              <span className="material-symbols-outlined">restart_alt</span>
              新开一局
            </button>
            <button className="btn danger-ghost" disabled={!!sess.finished} onClick={sess.resign}>
              <span className="material-symbols-outlined">flag</span>
              认输
            </button>
            <button className="btn" onClick={() => setHelpOpen(true)}>
              <span className="material-symbols-outlined">help</span>
              帮助
            </button>
          </div>
        </div>
      ) : (
        <DuiyiSetupPanel
          title="国际象棋"
          sub="完整规则人机对弈（王车易位 / 吃过路兵 / 升变 / 逼和）"
          difficulty={difficulty}
          onDifficulty={setDifficulty}
          onStart={() => void sess.startGame(difficulty, null)}
        />
      )}

      <DuiyiStatsRow gameZh="国际象棋" stats={sess.stats} />
      <DuiyiRecordPanel gameZh="国际象棋" records={sess.records} onDiscard={(id) => void sess.discardRecord(id)} />

      {sess.finished && (
        <DuiyiOverDialog
          result={sess.finished.result}
          reason={sess.finished.reason}
          onReplay={() => {
            sess.dropPlaying()
            void sess.startGame(difficulty, null)
          }}
          onClose={sess.dropPlaying}
        />
      )}

      {promoPick && (
        <div className="dialog-overlay">
          <div className="dialog" style={{ width: 320 }}>
            <div className="dialog-header">兵的升变</div>
            <div className="dialog-body dy-promo-row">
              {promoPick.options.map((m) => (
                <button
                  key={m.promo}
                  className="btn dy-promo-btn"
                  onClick={() => {
                    sess.myMove(m)
                    setPromoPick(null)
                    setSelected(null)
                  }}
                >
                  <span className="dy-cs-piece white">{PROMO_LABEL[m.promo!]}</span>
                  {PROMO_LABEL[m.promo!]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmNew}
        title="新开一局"
        confirmText="开新局"
        danger
        onConfirm={() => {
          setConfirmNew(false)
          sess.dropPlaying()
          void sess.startGame(difficulty, null)
        }}
        onCancel={() => setConfirmNew(false)}
      >
        当前进行中的对局将被放弃（不计战绩、不留记录），确定开新局？
      </ConfirmDialog>

      <DuiyiHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} game="chess" />
    </div>
  )
}
