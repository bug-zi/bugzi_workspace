// 对弈社·中国象棋 Pane：SVG 棋盘（河界/九宫斜线）+ 圆形汉字子 + 点选走子 + AI worker 调度
import { useMemo, useState } from 'react'
import type { DuiyiGameKey } from '../../../renderer/api'
import ConfirmDialog from '../../../components/ConfirmDialog'
import { xqLegalMoves, xqStatusOf, applyXqMove, initXqState } from './engine'
import type { XqMove, XqState } from './engine'
import {
  DuiyiOverDialog,
  DuiyiRecordPanel,
  DuiyiSetupPanel,
  DuiyiStatsRow,
  useDuiyiSession
} from '../pane-kit'
import DuiyiHelpDialog from '../DuiyiHelpDialog'

const CELL = 46
const PAD = 26
const W = PAD * 2 + CELL * 8
const H = PAD * 2 + CELL * 9

const CHAR: Record<number, string> = {
  1: '帥',
  2: '仕',
  3: '相',
  4: '馬',
  5: '車',
  6: '炮',
  7: '兵',
  [-1]: '將',
  [-2]: '士',
  [-3]: '象',
  [-4]: '馬',
  [-5]: '車',
  [-6]: '炮',
  [-7]: '卒'
}

const col = (i: number): number => i % 9
const row = (i: number): number => Math.floor(i / 9)

const OPS = {
  create: (): XqState => initXqState(),
  parse: (raw: string): XqState | null => {
    try {
      const o = JSON.parse(raw) as XqState
      if (Array.isArray(o.board) && o.board.length === 90 && (o.turn === 1 || o.turn === -1) && Array.isArray(o.history)) {
        return o
      }
      return null
    } catch {
      return null
    }
  },
  apply: applyXqMove,
  status: (s: XqState) => xqStatusOf(s),
  isMyTurn: (s: XqState): boolean => s.turn === 1,
  moveCount: (s: XqState): number => s.history.length
}

export default function XiangqiPane() {
  const ops = OPS
  const sess = useDuiyiSession<XqState, XqMove>('xiangqi' as DuiyiGameKey, ops, () =>
    new Worker(new URL('./xiangqi.worker.ts', import.meta.url), { type: 'module' })
  )
  const [difficulty, setDifficulty] = useState(2)
  const [selected, setSelected] = useState<number | null>(null)
  const [confirmNew, setConfirmNew] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  const targets = useMemo(
    () => (sess.st && selected != null && sess.canPlay ? xqLegalMoves(sess.st, selected) : []),
    [sess.st, selected, sess.canPlay]
  )
  const targetSet = useMemo(() => new Set(targets.map((m) => m.to)), [targets])

  const onCell = (i: number): void => {
    if (!sess.canPlay || !sess.st) return
    const p = sess.st.board[i]
    if (selected != null && targetSet.has(i)) {
      const m = targets.find((mv) => mv.to === i)!
      sess.myMove(m)
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
              <span>轮到你（红方） · 第 {Math.floor(st.history.length / 2) + 1} 回合</span>
            ) : (
              <span>等待中…</span>
            )}
            <span className="dy-status-right">难度 {['', '入门', '进阶', '挑战'][sess.row?.difficulty ?? 2]}</span>
          </div>
          <div className="dy-xq-board" style={{ width: W, height: H }}>
            <svg className="dy-xq-grid" width={W} height={H}>
              {/* 横线 */}
              {Array.from({ length: 10 }, (_, r) => (
                <line
                  key={`h${r}`}
                  x1={PAD}
                  y1={PAD + r * CELL}
                  x2={PAD + 8 * CELL}
                  y2={PAD + r * CELL}
                  className="dy-grid-line"
                />
              ))}
              {/* 竖线：边线贯通，中间列在河界断开 */}
              {Array.from({ length: 9 }, (_, c) =>
                c === 0 || c === 8 ? (
                  <line
                    key={`v${c}`}
                    x1={PAD + c * CELL}
                    y1={PAD}
                    x2={PAD + c * CELL}
                    y2={PAD + 9 * CELL}
                    className="dy-grid-line"
                  />
                ) : (
                  [
                    <line key={`vt${c}`} x1={PAD + c * CELL} y1={PAD} x2={PAD + c * CELL} y2={PAD + 4 * CELL} className="dy-grid-line" />,
                    <line key={`vb${c}`} x1={PAD + c * CELL} y1={PAD + 5 * CELL} x2={PAD + c * CELL} y2={PAD + 9 * CELL} className="dy-grid-line" />
                  ]
                )
              )}
              {/* 九宫斜线 */}
              {[
                [0, 3, 2, 5],
                [0, 5, 2, 3],
                [9, 3, 7, 5],
                [9, 5, 7, 3]
              ].map(([r1, c1, r2, c2], i) => (
                <line
                  key={`p${i}`}
                  x1={PAD + c1 * CELL}
                  y1={PAD + r1 * CELL}
                  x2={PAD + c2 * CELL}
                  y2={PAD + r2 * CELL}
                  className="dy-grid-line thin"
                />
              ))}
              {/* 炮/兵位标记（简化：炮位小角标） */}
              {[2, 7].flatMap((r) =>
                [1, 7].map((c) => (
                  <circle key={`m${r}${c}`} cx={PAD + c * CELL} cy={PAD + r * CELL} r={2.5} className="dy-grid-dot" />
                ))
              )}
            </svg>
            {/* 棋子 */}
            {st.board.map((p, i) => {
              if (p === 0) return null
              const x = PAD + col(i) * CELL
              const y = PAD + row(i) * CELL
              const cls = p > 0 ? 'red' : 'black'
              return (
                <button
                  key={i}
                  className={`dy-xq-piece ${cls}${selected === i ? ' sel' : ''}`}
                  style={{ left: x, top: y }}
                  onClick={() => onCell(i)}
                >
                  {CHAR[p]}
                </button>
              )
            })}
            {/* 选中/落点标记层（点击空白交点） */}
            <div className="dy-xq-clicks">
              {Array.from({ length: 90 }, (_, i) => {
                const isTarget = targetSet.has(i)
                const isSel = selected === i
                if (st.board[i] !== 0 && !isTarget && !isSel) return null
                return (
                  <button
                    key={i}
                    className={`dy-xq-hit${isTarget ? ' target' : ''}${isSel ? ' sel' : ''}`}
                    style={{ left: PAD + col(i) * CELL, top: PAD + row(i) * CELL }}
                    onClick={() => onCell(i)}
                  />
                )
              })}
            </div>
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
          title="中国象棋"
          sub="楚河汉界 · 全走法人机对弈（蹩马腿 / 塞象眼 / 将帅照面 / 困毙判负）"
          difficulty={difficulty}
          onDifficulty={setDifficulty}
          onStart={() => void sess.startGame(difficulty, null)}
        />
      )}

      <DuiyiStatsRow gameZh="中国象棋" stats={sess.stats} />
      <DuiyiRecordPanel gameZh="中国象棋" records={sess.records} onDiscard={(id) => void sess.discardRecord(id)} />

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

      <DuiyiHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} game="xiangqi" />
    </div>
  )
}
