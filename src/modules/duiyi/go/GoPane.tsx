// 对弈社·围棋 Pane：N×N（9/13/19）线格棋盘 + 落子/虚着 + 双 pass 死子标记数子
import { useMemo, useState } from 'react'
import ConfirmDialog from '../../../components/ConfirmDialog'
import { applyGoMove, goIsLegal, goScore, goStatusOf, goToggleDeadGroup, initGoState } from './engine'
import type { GoMove, GoState } from './engine'
import {
  DuiyiOverDialog,
  DuiyiRecordPanel,
  DuiyiSetupPanel,
  DuiyiStatsRow,
  useDuiyiSession
} from '../pane-kit'
import DuiyiHelpDialog from '../DuiyiHelpDialog'

const CELL = 30
const PAD = 20

const rowOf = (i: number, n: number): number => Math.floor(i / n)
const colOf = (i: number, n: number): number => i % n

function starPoints(n: number): number[] {
  if (n === 9) return [20, 24, 40, 56, 60]
  if (n === 13) return [42, 45, 48, 81, 84, 87, 120, 123, 126]
  return [60, 66, 72, 174, 180, 186, 288, 294, 300]
}

const OPS = {
  create: (difficulty: number, boardSpec: number | null): GoState => initGoState(boardSpec ?? 9),
  parse: (raw: string, _difficulty: number, boardSpec: number | null): GoState | null => {
    try {
      const o = JSON.parse(raw) as GoState
      if (
        o.size &&
        Array.isArray(o.board) &&
        o.board.length === o.size * o.size &&
        (o.turn === 1 || o.turn === 2) &&
        Array.isArray(o.dead) &&
        Array.isArray(o.history)
      ) {
        return o
      }
      return null
    } catch {
      void boardSpec
      return null
    }
  },
  apply: applyGoMove,
  // 双 pass 不自动终局：进入标记阶段（afterApply 切 phase），确认数子时显式 finishWith
  status: (s: GoState): { over: boolean; result?: 'win' | 'loss' | 'draw'; reason?: string } =>
    s.phase === 'marking' ? { over: false } : goStatusOf(s),
  afterApply: (s: GoState): GoState =>
    s.passes >= 2 && s.phase === 'play' ? { ...s, phase: 'marking' as const } : s,
  isMyTurn: (s: GoState): boolean => s.turn === 1,
  moveCount: (s: GoState): number => s.history.length
}

export default function GoPane() {
  const ops = OPS
  const sess = useDuiyiSession<GoState, GoMove>('go', ops, () =>
    new Worker(new URL('./go.worker.ts', import.meta.url), { type: 'module' })
  )
  const [difficulty, setDifficulty] = useState(2)
  const [boardSize, setBoardSize] = useState(9)
  const [confirmNew, setConfirmNew] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  const n = sess.st?.size ?? boardSize
  const cell = n >= 19 ? 26 : n >= 13 ? 30 : 34
  const W = PAD * 2 + cell * (n - 1)

  const marking = sess.st?.phase === 'marking'
  const lastMove = useMemo(() => {
    if (!sess.st || sess.st.history.length === 0) return null
    const h = sess.st.history[sess.st.history.length - 1]
    return h.pos != null ? h.pos : null
  }, [sess.st])

  const preview = useMemo(() => {
    if (!sess.st) return null
    return goScore(sess.st)
  }, [sess.st])

  const onCell = (i: number): void => {
    const s = sess.st
    if (!s) return
    if (s.phase === 'marking') {
      if (s.board[i] !== 0) sess.commitState(goToggleDeadGroup(s, i))
      return
    }
    if (!sess.canPlay) return
    if (!goIsLegal(s, i)) return
    sess.myMove({ pos: i })
  }

  const extra = (
    <div className="dy-setup-row">
      <span className="dy-setup-label">棋盘</span>
      {[9, 13, 19].map((sz) => (
        <button
          key={sz}
          className={`btn dy-diff-btn${boardSize === sz ? ' active' : ''}`}
          onClick={() => setBoardSize(sz)}
          title={sz === 19 ? '19 路 AI 为娱乐级陪玩' : undefined}
        >
          {sz} 路{sz === 19 ? '（AI 娱乐级）' : ''}
        </button>
      ))}
    </div>
  )

  const s = sess.st
  return (
    <div className="dy-pane">
      {s ? (
        <div className="dy-board-wrap">
          <div className="dy-status">
            {sess.finished ? (
              <span>对局结束 · {sess.finished.reason}</span>
            ) : marking ? (
              <span>
                死子标记：点棋子整组标记/取消（当前预览 黑 {preview?.black} —— 白 {preview?.white}）
              </span>
            ) : sess.thinking ? (
              <>
                <span className="material-symbols-outlined spin">progress_activity</span> AI 思考中…
              </>
            ) : sess.canPlay ? (
              <span>轮到你（黑） · 第 {s.history.length + 1} 手</span>
            ) : (
              <span>等待中…</span>
            )}
            <span className="dy-status-right">
              {n} 路 · 难度 {['', '入门', '进阶', '挑战'][sess.row?.difficulty ?? 2]}
            </span>
          </div>
          <div className="dy-go-board" style={{ width: W, height: W }}>
            <svg className="dy-xq-grid" width={W} height={W}>
              {Array.from({ length: n }, (_, r) => (
                <line
                  key={`h${r}`}
                  x1={PAD}
                  y1={PAD + r * cell}
                  x2={PAD + (n - 1) * cell}
                  y2={PAD + r * cell}
                  className="dy-grid-line"
                />
              ))}
              {Array.from({ length: n }, (_, c) => (
                <line
                  key={`v${c}`}
                  x1={PAD + c * cell}
                  y1={PAD}
                  x2={PAD + c * cell}
                  y2={PAD + (n - 1) * cell}
                  className="dy-grid-line"
                />
              ))}
              {starPoints(n).map((p) => (
                <circle key={p} cx={PAD + colOf(p, n) * cell} cy={PAD + rowOf(p, n) * cell} r={3} className="dy-grid-dot" />
              ))}
            </svg>
            {s.board.map((v, i) =>
              v !== 0 ? (
                <span
                  key={i}
                  className={`dy-stone ${v === 1 ? 'black' : 'white'}${lastMove === i ? ' last' : ''}${
                    marking && s.dead.includes(i) ? ' dead' : ''
                  }${marking ? ' markable' : ''}`}
                  style={{ left: PAD + colOf(i, n) * cell, top: PAD + rowOf(i, n) * cell }}
                  onClick={() => onCell(i)}
                />
              ) : null
            )}
            {/* 空点热区（标记阶段棋子自身接管点击，热区不挡） */}
            {!marking && (
              <div className="dy-go-hits">
                {s.board.map((v, i) =>
                  v === 0 ? (
                    <button
                      key={i}
                      className="dy-gm-hit"
                      style={{ left: PAD + colOf(i, n) * cell, top: PAD + rowOf(i, n) * cell }}
                      onClick={() => onCell(i)}
                      disabled={!sess.canPlay}
                    />
                  ) : null
                )}
              </div>
            )}
          </div>
          <div className="dy-controls">
            {!marking ? (
              <>
                <button className="btn" disabled={!sess.canPlay} onClick={() => sess.myMove({ pos: null })}>
                  <span className="material-symbols-outlined">do_not_disturb_on</span>
                  虚着（pass）
                </button>
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
              </>
            ) : (
              <>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    const score = goScore(s)
                    sess.finishWith(s, score.result, score.reason)
                  }}
                >
                  <span className="material-symbols-outlined">check</span>
                  确认数子
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    const cleared = { ...s, dead: [] }
                    const score = goScore(cleared)
                    sess.finishWith(cleared, score.result, score.reason + '（未标记死子）')
                  }}
                >
                  跳过标记（全按活子）
                </button>
                <button className="btn" disabled={!!sess.finished} onClick={() => setConfirmNew(true)}>
                  <span className="material-symbols-outlined">restart_alt</span>
                  新开一局
                </button>
              </>
            )}
            <button className="btn" onClick={() => setHelpOpen(true)}>
              <span className="material-symbols-outlined">help</span>
              帮助
            </button>
          </div>
          {/* 提子参考行（当前死子数） */}
          {marking && (
            <div className="module-sub" style={{ textAlign: 'center' }}>
              已标记死子 {s.dead.length} 枚（黑 {s.dead.filter((d) => s.board[d] === 1).length} / 白{' '}
              {s.dead.filter((d) => s.board[d] === 2).length}）· 贴目 7.5 已计入白方
            </div>
          )}
        </div>
      ) : (
        <DuiyiSetupPanel
          title="围棋"
          sub="中国规则 · 禁自杀 / 简单劫 / 双虚着终局死子标记数子；你执黑先行"
          difficulty={difficulty}
          onDifficulty={setDifficulty}
          extra={extra}
          onStart={() => void sess.startGame(difficulty, boardSize)}
        />
      )}

      <DuiyiStatsRow gameZh="围棋" stats={sess.stats} />
      <DuiyiRecordPanel gameZh="围棋" records={sess.records} onDiscard={(id) => void sess.discardRecord(id)} />

      {sess.finished && (
        <DuiyiOverDialog
          result={sess.finished.result}
          reason={sess.finished.reason}
          onReplay={() => {
            sess.dropPlaying()
            void sess.startGame(difficulty, boardSize)
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
          void sess.startGame(difficulty, boardSize)
        }}
        onCancel={() => setConfirmNew(false)}
      >
        当前进行中的对局将被放弃（不计战绩、不留记录），确定开新局？
      </ConfirmDialog>

      <DuiyiHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} game="go" />
    </div>
  )
}
