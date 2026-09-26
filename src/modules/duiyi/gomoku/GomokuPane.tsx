// 对弈社·五子棋 Pane：15×15 线格棋盘 + 交叉点落子
import { useMemo, useState } from 'react'
import ConfirmDialog from '../../../components/ConfirmDialog'
import { applyGmMove, gmStatusOf, initGmState, GM_SIZE } from './engine'
import type { GmMove, GmState } from './engine'
import {
  DuiyiOverDialog,
  DuiyiRecordPanel,
  DuiyiSetupPanel,
  DuiyiStatsRow,
  useDuiyiSession
} from '../pane-kit'
import DuiyiHelpDialog from '../DuiyiHelpDialog'

const CELL = 32
const PAD = 20
const W = PAD * 2 + CELL * (GM_SIZE - 1)

const col = (i: number): number => i % GM_SIZE
const row = (i: number): number => Math.floor(i / GM_SIZE)

const OPS = {
  create: (): GmState => initGmState(),
  parse: (raw: string): GmState | null => {
    try {
      const o = JSON.parse(raw) as GmState
      if (Array.isArray(o.board) && o.board.length === GM_SIZE * GM_SIZE && (o.turn === 1 || o.turn === 2) && Array.isArray(o.history)) {
        return o
      }
      return null
    } catch {
      return null
    }
  },
  apply: applyGmMove,
  status: (s: GmState) => gmStatusOf(s),
  isMyTurn: (s: GmState): boolean => s.turn === 1,
  moveCount: (s: GmState): number => s.history.length
}

export default function GomokuPane() {
  const ops = OPS
  const sess = useDuiyiSession<GmState, GmMove>('gomoku', ops, () =>
    new Worker(new URL('./gomoku.worker.ts', import.meta.url), { type: 'module' })
  )
  const [difficulty, setDifficulty] = useState(2)
  const [confirmNew, setConfirmNew] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  // 最后一手仅供渲染（引擎状态推导）
  const lastMove = useMemo(() => {
    if (!sess.st || sess.st.history.length === 0) return null
    const h = sess.st.history[sess.st.history.length - 1]
    return sess.st.board[h.pos] === h.player ? h.pos : null
  }, [sess.st])

  const onCell = (i: number): void => {
    if (!sess.canPlay || !sess.st) return
    if (sess.st.board[i] !== 0) return
    sess.myMove({ pos: i })
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
              <span>轮到你（黑） · 第 {st.history.length + 1} 手</span>
            ) : (
              <span>等待中…</span>
            )}
            <span className="dy-status-right">难度 {['', '入门', '进阶', '挑战'][sess.row?.difficulty ?? 2]}</span>
          </div>
          <div className="dy-gm-board" style={{ width: W, height: W }}>
            <svg className="dy-xq-grid" width={W} height={W}>
              {Array.from({ length: GM_SIZE }, (_, r) => (
                <line
                  key={`h${r}`}
                  x1={PAD}
                  y1={PAD + r * CELL}
                  x2={PAD + (GM_SIZE - 1) * CELL}
                  y2={PAD + r * CELL}
                  className="dy-grid-line"
                />
              ))}
              {Array.from({ length: GM_SIZE }, (_, c) => (
                <line
                  key={`v${c}`}
                  x1={PAD + c * CELL}
                  y1={PAD}
                  x2={PAD + c * CELL}
                  y2={PAD + (GM_SIZE - 1) * CELL}
                  className="dy-grid-line"
                />
              ))}
              {[48, 56, 112, 168, 176].map((p) => (
                <circle key={p} cx={PAD + col(p) * CELL} cy={PAD + row(p) * CELL} r={3} className="dy-grid-dot" />
              ))}
            </svg>
            {st.board.map((v, i) =>
              v !== 0 ? (
                <span
                  key={i}
                  className={`dy-stone ${v === 1 ? 'black' : 'white'}${lastMove === i ? ' last' : ''}`}
                  style={{ left: PAD + col(i) * CELL, top: PAD + row(i) * CELL }}
                />
              ) : (
                <button
                  key={i}
                  className="dy-gm-hit"
                  style={{ left: PAD + col(i) * CELL, top: PAD + row(i) * CELL }}
                  onClick={() => onCell(i)}
                  disabled={!sess.canPlay}
                />
              )
            )}
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
          title="五子棋"
          sub="15×15 无禁手自由规则 · 你执黑先行，连五即胜"
          difficulty={difficulty}
          onDifficulty={setDifficulty}
          onStart={() => void sess.startGame(difficulty, null)}
        />
      )}

      <DuiyiStatsRow gameZh="五子棋" stats={sess.stats} />
      <DuiyiRecordPanel gameZh="五子棋" records={sess.records} onDiscard={(id) => void sess.discardRecord(id)} />

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

      <DuiyiHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} game="gomoku" />
    </div>
  )
}
