// 国际象棋引擎（2026-09-26 对弈社 design §3.2）：8×8 全规则——王车易位/吃过路兵/兵升变
// （四选，搜索内含升变四种）/逼和/将死/王对王自动和；三次重复与五十回合不做。
// 我方白（正数），AI 黑（负数）；row 7 = 白底线。state 可 JSON 序列化。
import { findBestMove, MATE_SCORE, type SearchAdapter } from '../common'

export const CK = { K: 1, Q: 2, R: 3, B: 4, N: 5, P: 6 } as const

export interface CsMove {
  from: number
  to: number
  captured?: number
  /** 升变目标（绝对类型 2|3|4|5；应用时按行棋方加符号） */
  promo?: number
  /** 吃过路兵：captured 兵在 from 同列 to 行 */
  isEp?: boolean
  /** 王车易位方向：K 短易位 / Q 长易位（to = 王目标格） */
  castle?: 'K' | 'Q'
}

export interface CsState {
  board: number[]
  turn: 1 | -1
  castling: { wk: boolean; wq: boolean; bk: boolean; bq: boolean }
  /** 吃过路兵目标格（被吃兵后方空格），无则 null */
  ep: number | null
  history: { from: number; to: number; piece: number; captured?: number; promo?: number; castle?: string }[]
}

const rowOf = (i: number): number => Math.floor(i / 8)
const colOf = (i: number): number => i % 8
const idx = (r: number, c: number): number => r * 8 + c
const inB = (r: number, c: number): boolean => r >= 0 && r < 8 && c >= 0 && c < 8
const signOf = (p: number): number => (p > 0 ? 1 : -1)

const BACK: number[] = [CK.R, CK.N, CK.B, CK.Q, CK.K, CK.B, CK.N, CK.R]

export function initCsState(): CsState {
  const b = new Array<number>(64).fill(0)
  for (let c = 0; c < 8; c++) {
    b[idx(0, c)] = -BACK[c]
    b[idx(1, c)] = -CK.P
    b[idx(6, c)] = CK.P
    b[idx(7, c)] = BACK[c]
  }
  return {
    board: b,
    turn: 1,
    castling: { wk: true, wq: true, bk: true, bq: true },
    ep: null,
    history: []
  }
}

/** by 方是否攻击 sq（不含王；王邻接单列处理） */
function isAttacked(board: number[], sq: number, by: number): boolean {
  const r = rowOf(sq)
  const c = colOf(sq)
  // 兵：白兵攻击 (r+1,c±1)（白向上），故白兵位于 (r+1,c±1) 时攻击本格
  const pr = by === 1 ? r + 1 : r - 1
  for (const dc of [-1, 1]) {
    if (inB(pr, c + dc) && board[idx(pr, c + dc)] === CK.P * by) return true
  }
  // 马
  for (const [dr, dc] of [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]]) {
    const rr = r + dr
    const cc = c + dc
    if (inB(rr, cc) && board[idx(rr, cc)] === CK.N * by) return true
  }
  // 王
  for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
    const rr = r + dr
    const cc = c + dc
    if (inB(rr, cc) && board[idx(rr, cc)] === CK.K * by) return true
  }
  // 滑子：斜（象/后）直（车/后）
  const slide = (drs: number[], dcs: number[], hits: number[]): boolean => {
    for (let k = 0; k < drs.length; k++) {
      let rr = r + drs[k]
      let cc = c + dcs[k]
      while (inB(rr, cc)) {
        const q = board[idx(rr, cc)]
        if (q !== 0) {
          if (signOf(q) === by && hits.includes(Math.abs(q))) return true
          break
        }
        rr += drs[k]
        cc += dcs[k]
      }
    }
    return false
  }
  if (slide([-1, 1, 0, 0], [0, 0, -1, 1], [CK.R, CK.Q])) return true
  if (slide([-1, -1, 1, 1], [-1, 1, -1, 1], [CK.B, CK.Q])) return true
  return false
}

function kingSq(board: number[], side: number): number {
  for (let i = 0; i < 64; i++) if (board[i] === CK.K * side) return i
  return -1
}

export function applyCsMove(prev: CsState, m: CsMove): CsState {
  const board = prev.board.slice()
  const side = prev.turn
  const piece = board[m.from]
  board[m.from] = 0
  if (m.isEp) {
    board[idx(rowOf(m.from), colOf(m.to))] = 0 // 被吃兵在 from 行、to 列
  }
  board[m.to] = m.promo ? m.promo * side : piece
  if (m.castle) {
    const row = side === 1 ? 7 : 0
    if (m.castle === 'K') {
      board[idx(row, 5)] = board[idx(row, 7)]
      board[idx(row, 7)] = 0
    } else {
      board[idx(row, 3)] = board[idx(row, 0)]
      board[idx(row, 0)] = 0
    }
  }
  const castling = { ...prev.castling }
  if (piece === CK.K * side) {
    if (side === 1) {
      castling.wk = false
      castling.wq = false
    } else {
      castling.bk = false
      castling.bq = false
    }
  }
  for (const [sq, key] of [
    [63, 'wk'],
    [56, 'wq'],
    [7, 'bk'],
    [0, 'bq']
  ] as const) {
    if (m.from === sq || m.to === sq) castling[key] = false
  }
  const ep = Math.abs(piece) === CK.P && Math.abs(rowOf(m.to) - rowOf(m.from)) === 2 ? idx((rowOf(m.from) + rowOf(m.to)) / 2, colOf(m.from)) : null
  return {
    board,
    turn: (side === 1 ? -1 : 1) as 1 | -1,
    castling,
    ep,
    history: [
      ...prev.history,
      {
        from: m.from,
        to: m.to,
        piece,
        ...(m.captured ? { captured: m.captured } : {}),
        ...(m.promo ? { promo: m.promo } : {}),
        ...(m.castle ? { castle: m.castle } : {})
      }
    ]
  }
}

/** 伪合法走法（升变一步拆四） */
function pseudoMoves(state: CsState, side: number, from?: number): CsMove[] {
  const b = state.board
  const out: CsMove[] = []
  const add = (fromSq: number, to: number, extra?: Partial<CsMove>): void => {
    const q = b[to]
    if (q !== 0 && signOf(q) === side) return
    const base: CsMove = { from: fromSq, to, ...(q ? { captured: q } : {}), ...extra }
    const t = Math.abs(b[fromSq])
    const promoRow = side === 1 ? 0 : 7
    if (t === CK.P && rowOf(to) === promoRow) {
      for (const promo of [CK.Q, CK.R, CK.B, CK.N]) out.push({ ...base, promo })
    } else {
      out.push(base)
    }
  }
  for (let i = 0; i < 64; i++) {
    const p = b[i]
    if (p === 0 || signOf(p) !== side) continue
    if (from != null && i !== from) continue
    const r = rowOf(i)
    const c = colOf(i)
    const t = Math.abs(p)
    if (t === CK.P) {
      const f = side === 1 ? -1 : 1
      const startRow = side === 1 ? 6 : 1
      if (inB(r + f, c) && b[idx(r + f, c)] === 0) {
        add(i, idx(r + f, c))
        if (r === startRow && b[idx(r + 2 * f, c)] === 0) add(i, idx(r + 2 * f, c))
      }
      for (const dc of [-1, 1]) {
        const rr = r + f
        const cc = c + dc
        if (!inB(rr, cc)) continue
        const q = b[idx(rr, cc)]
        if (q !== 0 && signOf(q) !== side) add(i, idx(rr, cc))
        else if (state.ep === idx(rr, cc) && q === 0) add(i, idx(rr, cc), { isEp: true, captured: CK.P * -side })
      }
    } else if (t === CK.N) {
      for (const [dr, dc] of [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]]) {
        if (inB(r + dr, c + dc)) add(i, idx(r + dr, c + dc))
      }
    } else if (t === CK.K) {
      for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
        if (inB(r + dr, c + dc)) add(i, idx(r + dr, c + dc))
      }
      // 王车易位（王不在将中、路径空且途经格不被攻）
      const home = side === 1 ? 7 : 0
      if (i === idx(home, 4) && !isAttacked(b, i, -side)) {
        const kRight = side === 1 ? state.castling.wk : state.castling.bk
        const qRight = side === 1 ? state.castling.wq : state.castling.bq
        if (kRight && b[idx(home, 5)] === 0 && b[idx(home, 6)] === 0 && b[idx(home, 7)] === CK.R * side
          && !isAttacked(b, idx(home, 5), -side) && !isAttacked(b, idx(home, 6), -side)) {
          out.push({ from: i, to: idx(home, 6), castle: 'K' })
        }
        if (qRight && b[idx(home, 1)] === 0 && b[idx(home, 2)] === 0 && b[idx(home, 3)] === 0 && b[idx(home, 0)] === CK.R * side
          && !isAttacked(b, idx(home, 3), -side) && !isAttacked(b, idx(home, 2), -side)) {
          out.push({ from: i, to: idx(home, 2), castle: 'Q' })
        }
      }
    } else {
      const dirs =
        t === CK.R
          ? [[-1, 0], [1, 0], [0, -1], [0, 1]]
          : t === CK.B
            ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
            : [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]
      for (const [dr, dc] of dirs) {
        let rr = r + dr
        let cc = c + dc
        while (inB(rr, cc)) {
          add(i, idx(rr, cc))
          if (b[idx(rr, cc)] !== 0) break
          rr += dr
          cc += dc
        }
      }
    }
  }
  return out
}

export function csLegalMoves(state: CsState, from?: number): CsMove[] {
  const side = state.turn
  return pseudoMoves(state, side, from).filter((m) => {
    const next = applyCsMove(state, m)
    const ks = kingSq(next.board, side)
    return ks >= 0 && !isAttacked(next.board, ks, -side)
  })
}

export interface CsStatus {
  over: boolean
  /** 我方（白）视角 */
  result?: 'win' | 'loss' | 'draw'
  reason?: string
}

/** 子力不足自动和：王对王 / 王对王+单轻子 */
function bareKings(board: number[]): 'draw' | null {
  const rest: number[] = []
  for (const p of board) {
    const t = Math.abs(p)
    if (t === CK.K || t === 0) continue
    rest.push(t)
  }
  if (rest.length === 0) return 'draw'
  if (rest.length === 1 && (rest[0] === CK.N || rest[0] === CK.B)) return 'draw'
  return null
}

export function csStatusOf(state: CsState): CsStatus {
  const bare = bareKings(state.board)
  if (bare) return { over: true, result: 'draw', reason: '子力不足自动和棋' }
  const moves = csLegalMoves(state)
  if (moves.length > 0) return { over: false }
  const side = state.turn
  const ks = kingSq(state.board, side)
  const checked = isAttacked(state.board, ks, -side)
  if (checked) {
    return { over: true, result: side === 1 ? 'loss' : 'win', reason: side === 1 ? '白方被将死' : '黑方被将死' }
  }
  return { over: true, result: 'draw', reason: '逼和（无子可动而未被将军）' }
}

// ---------- AI ----------

const VALUES = [0, 10000, 900, 500, 330, 320, 100]

function evalWhite(state: CsState): number {
  let s = 0
  for (let i = 0; i < 64; i++) {
    const p = state.board[i]
    if (p === 0) continue
    const side = signOf(p)
    const t = Math.abs(p)
    let v = VALUES[t]
    const r = rowOf(i)
    const c = colOf(i)
    if (t === CK.P) {
      v += (side === 1 ? 6 - r : r - 1) * 6 // 推进微加分
    } else if (t === CK.N || t === CK.B) {
      v += (Math.min(c, 7 - c) + Math.min(r, 7 - r)) * 4 // 中心倾向
    }
    s += side * v
  }
  return s
}

const csAdapter: SearchAdapter<CsState, CsMove> = {
  legalMoves: csLegalMoves,
  apply: applyCsMove,
  evaluate: (st) => evalWhite(st) * st.turn,
  terminalValue: (st) => {
    const bare = bareKings(st.board)
    if (bare) return 0
    if (csLegalMoves(st).length === 0) {
      const side = st.turn
      const ks = kingSq(st.board, side)
      return isAttacked(st.board, ks, -side) ? -MATE_SCORE : 0
    }
    return null
  },
  orderScore: (m) => (m.captured ? VALUES[Math.abs(m.captured)] * 10 - 1 : 0)
}

export function findBestCsMove(state: CsState, difficulty: number): CsMove | null {
  return findBestMove(state, csAdapter, difficulty)
}
