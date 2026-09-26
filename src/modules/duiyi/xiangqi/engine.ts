// 中国象棋引擎（2026-09-26 对弈社 design §3.1）：9×10 全走法——蹩马腿/塞象眼/象不过河/
// 仕困九宫/将帅照面/兵过河横走；将死与困毙均判负（长将禁着与自然和局不做）。
// 我方红（正数），AI 黑（负数）；state 可 JSON 序列化。
import { findBestMove, MATE_SCORE, type SearchAdapter } from '../common'

export const BOARD_W = 9
export const BOARD_H = 10

// 棋子编码（绝对值）：1 帅/将 2 仕 3 相 4 马 5 车 6 炮 7 兵；正=红（我方）负=黑（AI）
export const XK = { K: 1, A: 2, B: 3, N: 4, R: 5, C: 6, P: 7 } as const

export interface XqMove {
  from: number
  to: number
  captured?: number
}

export interface XqState {
  board: number[]
  turn: 1 | -1
  history: { from: number; to: number; piece: number; captured?: number }[]
}

const idx = (r: number, c: number): number => r * BOARD_W + c
const rowOf = (i: number): number => Math.floor(i / BOARD_W)
const colOf = (i: number): number => i % BOARD_W
const inBoard = (r: number, c: number): boolean => r >= 0 && r < BOARD_H && c >= 0 && c < BOARD_W
const inPalace = (r: number, c: number, side: number): boolean =>
  c >= 3 && c <= 5 && (side === 1 ? r >= 7 : r <= 2)
const crossedRiver = (r: number, side: number): boolean => (side === 1 ? r <= 4 : r >= 5)
const fwd = (side: number): number => (side === 1 ? -1 : 1)

export function initXqState(): XqState {
  const b = new Array<number>(90).fill(0)
  const back = [XK.R, XK.N, XK.B, XK.A, XK.K, XK.A, XK.B, XK.N, XK.R]
  for (let c = 0; c < 9; c++) {
    b[idx(0, c)] = -back[c]
    b[idx(9, c)] = back[c]
  }
  b[idx(2, 1)] = -XK.C
  b[idx(2, 7)] = -XK.C
  b[idx(7, 1)] = XK.C
  b[idx(7, 7)] = XK.C
  for (const c of [0, 2, 4, 6, 8]) {
    b[idx(3, c)] = -XK.P
    b[idx(6, c)] = XK.P
  }
  return { board: b, turn: 1, history: [] }
}

/** 某子从 from 出发的伪合法目标（不含被将过滤） */
function pseudoTargets(board: number[], from: number): number[] {
  const p = board[from]
  const side = p > 0 ? 1 : -1
  const t = Math.abs(p)
  const r = rowOf(from)
  const c = colOf(from)
  const out: number[] = []
  const push = (rr: number, cc: number): void => {
    if (!inBoard(rr, cc)) return
    const q = board[idx(rr, cc)]
    if (q === 0 || (q > 0 ? 1 : -1) !== side) out.push(idx(rr, cc))
  }
  switch (t) {
    case XK.K: {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const rr = r + dr
        const cc = c + dc
        if (inPalace(rr, cc, side)) push(rr, cc)
      }
      break
    }
    case XK.A: {
      for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const rr = r + dr
        const cc = c + dc
        if (inPalace(rr, cc, side)) push(rr, cc)
      }
      break
    }
    case XK.B: {
      for (const [dr, dc] of [[-2, -2], [-2, 2], [2, -2], [2, 2]]) {
        const rr = r + dr
        const cc = c + dc
        if (!inBoard(rr, cc)) continue
        if (side === 1 ? rr < 5 : rr > 4) continue // 象不过河
        if (board[idx(r + dr / 2, c + dc / 2)] !== 0) continue // 塞象眼
        push(rr, cc)
      }
      break
    }
    case XK.N: {
      for (const [dr, dc] of [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]]) {
        const rr = r + dr
        const cc = c + dc
        if (!inBoard(rr, cc)) continue
        // 蹩马腿：长轴方向的相邻格
        const legR = r + (Math.abs(dr) === 2 ? dr / 2 : 0)
        const legC = c + (Math.abs(dc) === 2 ? dc / 2 : 0)
        if (board[idx(legR, legC)] !== 0) continue
        push(rr, cc)
      }
      break
    }
    case XK.R: {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        let rr = r + dr
        let cc = c + dc
        while (inBoard(rr, cc)) {
          const q = board[idx(rr, cc)]
          if (q === 0) {
            out.push(idx(rr, cc))
          } else {
            if ((q > 0 ? 1 : -1) !== side) out.push(idx(rr, cc))
            break
          }
          rr += dr
          cc += dc
        }
      }
      break
    }
    case XK.C: {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        let rr = r + dr
        let cc = c + dc
        let screen = false
        while (inBoard(rr, cc)) {
          const q = board[idx(rr, cc)]
          if (!screen) {
            if (q === 0) out.push(idx(rr, cc))
            else screen = true
          } else if (q !== 0) {
            if ((q > 0 ? 1 : -1) !== side) out.push(idx(rr, cc))
            break
          }
          rr += dr
          cc += dc
        }
      }
      break
    }
    case XK.P: {
      push(r + fwd(side), c)
      if (crossedRiver(r, side)) {
        push(r, c - 1)
        push(r, c + 1)
      }
      break
    }
  }
  return out
}

/** side 方是否被将军（含将帅照面） */
function isInCheck(board: number[], side: number): boolean {
  let kr = -1
  let kc = -1
  for (let i = 0; i < 90; i++) {
    if (board[i] === XK.K * side) {
      kr = rowOf(i)
      kc = colOf(i)
      break
    }
  }
  const enemy = -side
  // 车/将照面 与 炮：四方向扫描
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    let rr = kr + dr
    let cc = kc + dc
    let screen = false
    while (inBoard(rr, cc)) {
      const q = board[idx(rr, cc)]
      if (q !== 0) {
        if (!screen) {
          if (q === XK.R * enemy || q === XK.K * enemy) return true
          screen = true
        } else {
          if (q === XK.C * enemy) return true
          break
        }
      }
      rr += dr
      cc += dc
    }
  }
  // 马
  for (const [dr, dc] of [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]]) {
    const hr = kr + dr
    const hc = kc + dc
    if (!inBoard(hr, hc) || board[idx(hr, hc)] !== XK.N * enemy) continue
    // 马腿相对马而言：马位向将位长轴方向一步
    const legR = hr + (Math.abs(dr) === 2 ? -dr / 2 : 0)
    const legC = hc + (Math.abs(dc) === 2 ? -dc / 2 : 0)
    if (board[idx(legR, legC)] === 0) return true
  }
  // 兵（敌兵前进方向 = +side？敌 side=-1 时前进步 +1，即攻击 (kr-1,kc)；红兵相反）
  if (inBoard(kr - fwd(enemy), kc) && board[idx(kr - fwd(enemy), kc)] === XK.P * enemy) return true
  for (const dc of [-1, 1]) {
    if (inBoard(kr, kc + dc) && board[idx(kr, kc + dc)] === XK.P * enemy && crossedRiver(kr, enemy)) return true
  }
  return false
}

export function applyXqMove(prev: XqState, m: XqMove): XqState {
  const board = prev.board.slice()
  const piece = board[m.from]
  board[m.to] = piece
  board[m.from] = 0
  return {
    board,
    turn: (prev.turn === 1 ? -1 : 1) as 1 | -1,
    history: [...prev.history, { from: m.from, to: m.to, piece, ...(m.captured ? { captured: m.captured } : {}) }]
  }
}

export function xqLegalMoves(state: XqState, from?: number): XqMove[] {
  const side = state.turn
  const out: XqMove[] = []
  for (let i = 0; i < 90; i++) {
    const p = state.board[i]
    if (p === 0 || (p > 0 ? 1 : -1) !== side) continue
    if (from != null && i !== from) continue
    for (const to of pseudoTargets(state.board, i)) {
      const captured = state.board[to]
      const next = applyXqMove(state, { from: i, to, ...(captured ? { captured } : {}) })
      if (!isInCheck(next.board, side)) out.push({ from: i, to, ...(captured ? { captured } : {}) })
    }
  }
  return out
}

export interface XqStatus {
  over: boolean
  /** 我方（红）视角 */
  result?: 'win' | 'loss'
  reason?: string
}

export function xqStatusOf(state: XqState): XqStatus {
  if (xqLegalMoves(state).length > 0) return { over: false }
  const loser = state.turn
  const checked = isInCheck(state.board, loser)
  return {
    over: true,
    result: loser === 1 ? 'loss' : 'win',
    reason: checked ? (loser === 1 ? '红方被将死' : '黑方被将死') : loser === 1 ? '红方困毙' : '黑方困毙'
  }
}

// ---------- AI ----------

const VALUES = [0, 10000, 200, 200, 400, 900, 450, 100]

/** 红 > 0 优 */
function evalRed(state: XqState): number {
  let s = 0
  for (let i = 0; i < 90; i++) {
    const p = state.board[i]
    if (p === 0) continue
    const t = Math.abs(p)
    const side = p > 0 ? 1 : -1
    let v = VALUES[t]
    if (t === XK.P) {
      const r = rowOf(i)
      const crossed = crossedRiver(r, side)
      if (crossed) {
        v += 100
        const deep = side === 1 ? 4 - r : r - 5
        v += Math.max(0, Math.min(3, deep)) * 30
      }
    } else if (t === XK.N || t === XK.C || t === XK.R) {
      if (crossedRiver(rowOf(i), side)) v += 20
    }
    s += side * v
  }
  return s
}

const xqAdapter: SearchAdapter<XqState, XqMove> = {
  legalMoves: xqLegalMoves,
  apply: applyXqMove,
  evaluate: (st) => evalRed(st) * st.turn,
  terminalValue: (st) => (xqLegalMoves(st).length === 0 ? -MATE_SCORE : null),
  orderScore: (m) => (m.captured ? VALUES[Math.abs(m.captured)] * 10 - 1 : 0)
}

export function findBestXqMove(state: XqState, difficulty: number): XqMove | null {
  return findBestMove(state, xqAdapter, difficulty)
}
