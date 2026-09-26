// 对弈社·日本将棋 Pane：9×9 棋盘 + 双方持驹区 + 点选走子/打入 + 成/不成弹窗
import { useMemo, useState } from 'react'
import ConfirmDialog from '../../../components/ConfirmDialog'
import { sgLegalMoves, sgStatusOf, applySgMove, initSgState, SK } from './engine'
import type { SgMove, SgState } from './engine'
import {
  DuiyiOverDialog,
  DuiyiRecordPanel,
  DuiyiSetupPanel,
  DuiyiStatsRow,
  useDuiyiSession
} from '../pane-kit'
import DuiyiHelpDialog from '../DuiyiHelpDialog'

const CHAR: Record<number, string> = {
  1: '王',
  2: '飛',
  3: '角',
  4: '金',
  5: '銀',
  6: '桂',
  7: '香',
  8: '歩',
  12: '竜',
  13: '馬',
  15: '全',
  16: '圭',
  17: '杏',
  18: 'と'
}
const HAND_TYPES = [SK.R, SK.B, SK.G, SK.S, SK.N, SK.L, SK.P]

const row = (i: number): number => Math.floor(i / 9)
const col = (i: number): number => i % 9

const OPS = {
  create: (): SgState => initSgState(),
  parse: (raw: string): SgState | null => {
    try {
      const o = JSON.parse(raw) as SgState
      if (
        Array.isArray(o.board) &&
        o.board.length === 81 &&
        (o.turn === 1 || o.turn === -1) &&
        o.hands &&
        o.hands['1'] &&
        o.hands['-1'] &&
        Array.isArray(o.history)
      ) {
        return o
      }
      return null
    } catch {
      return null
    }
  },
  apply: applySgMove,
  status: (s: SgState) => sgStatusOf(s),
  isMyTurn: (s: SgState): boolean => s.turn === 1,
  moveCount: (s: SgState): number => s.history.length
}

export default function ShogiPane() {
  const ops = OPS
  const sess = useDuiyiSession<SgState, SgMove>('shogi', ops, () =>
    new Worker(new URL('./shogi.worker.ts', import.meta.url), { type: 'module' })
  )
  const [difficulty, setDifficulty] = useState(2)
  const [selected, setSelected] = useState<number | null>(null)
  const [dropType, setDropType] = useState<number | null>(null)
  const [confirmNew, setConfirmNew] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [promoPick, setPromoPick] = useState<{ to: number; options: SgMove[] } | null>(null)

  const allMoves = useMemo(
    () => (sess.st && sess.canPlay ? sgLegalMoves(sess.st) : []),
    [sess.st, sess.canPlay]
  )
  const targets = useMemo(() => {
    if (!sess.st || !sess.canPlay) return []
    if (dropType != null) return allMoves.filter((m) => m.drop === dropType)
    if (selected != null) return allMoves.filter((m) => m.from === selected)
    return []
  }, [allMoves, dropType, selected, sess.st, sess.canPlay])
  const targetSet = useMemo(() => new Set(targets.map((m) => m.to)), [targets])

  const clearSel = (): void => {
    setSelected(null)
    setDropType(null)
  }

  const onCell = (i: number): void => {
    if (!sess.canPlay || !sess.st) return
    const p = sess.st.board[i]
    if (targetSet.has(i)) {
      const options = targets.filter((m) => m.to === i)
      if (options.length > 1 && options.some((m) => m.promote)) {
        setPromoPick({ to: i, options })
        return
      }
      sess.myMove(options[0])
      clearSel()
      return
    }
    if (dropType == null && p > 0) {
      setSelected(selected === i ? null : i)
      setDropType(null)
      return
    }
    clearSel()
  }

  const handRow = (side: 1 | -1): React.ReactNode => {
    const st = sess.st
    if (!st) return null
    const hand = st.hands[String(side)]
    return (
      <div className={`dy-sg-hand ${side === 1 ? 'mine' : 'theirs'}`}>
        <span className="dy-sg-hand-label">{side === 1 ? '我的持驹' : 'AI 持驹'}</span>
        {HAND_TYPES.filter((t) => hand[t - 2] > 0).length === 0 && <span className="module-sub">无</span>}
        {HAND_TYPES.filter((t) => hand[t - 2] > 0).map((t) => (
          <button
            key={t}
            className={`dy-sg-hand-piece${dropType === t ? ' sel' : ''}${side === 1 && sess.canPlay ? ' pickable' : ''}`}
            disabled={side !== 1 || !sess.canPlay}
            onClick={() => {
              setDropType(dropType === t ? null : t)
              setSelected(null)
            }}
          >
            {CHAR[t]}
            <i>{hand[t - 2]}</i>
          </button>
        ))}
      </div>
    )
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
              <span>轮到你（先手） · 第 {Math.floor(st.history.length / 2) + 1} 手</span>
            ) : (
              <span>等待中…</span>
            )}
            <span className="dy-status-right">难度 {['', '入门', '进阶', '挑战'][sess.row?.difficulty ?? 2]}</span>
          </div>
          {handRow(-1)}
          <div className="dy-sg-board">
            {st.board.map((p, i) => {
              const isTarget = targetSet.has(i)
              const isSel = selected === i
              return (
                <button
                  key={i}
                  className={`dy-sg-cell${isTarget ? ' target' : ''}${isSel ? ' sel' : ''}`}
                  onClick={() => onCell(i)}
                >
                  {p !== 0 && (
                    <span className={`dy-sg-piece ${p > 0 ? 'mine' : 'theirs'}`}>
                      {CHAR[Math.abs(p)]}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {handRow(1)}
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
          title="日本将棋"
          sub="持驹打入 · 升变全规则人机对弈（二步 / 打步诘等禁手齐备）"
          difficulty={difficulty}
          onDifficulty={setDifficulty}
          onStart={() => void sess.startGame(difficulty, null)}
        />
      )}

      <DuiyiStatsRow gameZh="日本将棋" stats={sess.stats} />
      <DuiyiRecordPanel gameZh="日本将棋" records={sess.records} onDiscard={(id) => void sess.discardRecord(id)} />

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
          <div className="dialog" style={{ width: 300 }}>
            <div className="dialog-header">升变选择</div>
            <div className="dialog-body dy-promo-row">
              {promoPick.options.map((m) => (
                <button
                  key={m.promote ? 'p' : 'n'}
                  className="btn dy-promo-btn"
                  onClick={() => {
                    sess.myMove(m)
                    setPromoPick(null)
                    clearSel()
                  }}
                >
                  {m.promote ? '成（升变）' : '不成'}
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

      <DuiyiHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} game="shogi" />
    </div>
  )
}
