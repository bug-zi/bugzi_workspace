// 日本将棋引擎（2026-09-26 对弈社 design §3.3）：9×9 + 持驹打入 + 升变。
// 规则范围：升变区三段可选升、底/底线强制升（步香底一行、桂底两行）、打入（禁二步/
// 禁死子打入/禁打步诘）、王手诘み；千日手与持将棋不做。
// 我方先手（正数，下方，向上行进），AI 后手（负数）。state 可 JSON 序列化。
import { findBestMove, MATE_SCORE, type SearchAdapter } from '../common'

// 绝对类型：1 王 2 飛 3 角 4 金 5 銀 6 桂 7 香 8 歩；>10 为成子（type+10）
export const SK = { K: 1, R: 2, B: 3, G: 4, S: 5, N: 6, L: 7, P: 8 } as const

export interface SgMove {
  to: number
  /** 盘上走子来源格（drop 时缺省） */
  from?: number
  /** 打入的未成子类型（2..8） */
  drop?: number
  /** 走子升变选择（打入永不升） */
  promote?: boolean
  captured?: number
}

export interface SgState {
  board: number[]
  /** 持驹：键 '1'（我）/ '-1'（AI）→ 按类型 2..8 计数数组 */
  hands: Record<string, number[]>
  turn: 1 | -1
  history: { to: number; from?: number; drop?: number; piece: number; captured?: number; promote?: boolean }[]
}

const rowOf = (i: number): number => Math.floor(i / 9)
const colOf = (i: number): number => i % 9
const idx = (r: number, c: number): number => r * 9 + c
const inB = (r: number, c: number): boolean => r >= 0 && r < 9 && c >= 0 && c < 9
const signOf = (p: number): number => (p > 0 ? 1 : -1)
const baseType = (p: number): number => (Math.abs(p) > 10 ? Math.abs(p) - 10 : Math.abs(p))
const isPromoted = (p: number): boolean => Math.abs(p) > 10
const fwd = (side: number): number => (side === 1 ? -1 : 1)
/** side 的升变区（对方三段） */
const inZone = (r: number, side: number): boolean => (side === 1 ? r <= 2 : r >= 6)
const LAST = 8

const HAND_TYPES = [SK.R, SK.B, SK.G, SK.S, SK.N, SK.L, SK.P]

export function initSgState(): SgState {
  const b = new Array<number>(81).fill(0)
  const back = [SK.L, SK.N, SK.S, SK.G, SK.K, SK.G, SK.S, SK.N, SK.L]
  for (let c = 0; c < 9; c++) {
    b[idx(0, c)] = -back[c]
    b[idx(8, c)] = back[c]
  }
  // 飞角标准位：各方自视角「左角右飞」——先手角 col 1 / 飞 col 7，后手镜像（260926 开发者指正）
  b[idx(1, 1)] = -SK.R
  b[idx(1, 7)] = -SK.B
  b[idx(7, 1)] = SK.B
  b[idx(7, 7)] = SK.R
  for (let c = 0; c < 9; c++) {
    b[idx(2, c)] = -SK.P
    b[idx(6, c)] = SK.P
  }
  return {
    board: b,
    hands: { '1': [0, 0, 0, 0, 0, 0, 0], '-1': [0, 0, 0, 0, 0, 0, 0] },
    turn: 1,
    history: []
  }
}

/** side 手中类型 t 的持驹数 */
const handCount = (st: SgState, side: number, t: number): number => st.hands[String(side)][t - 2]

/** 某子从 (r,c) 出发的一步/滑行目标集合（按类型与是否成子） */
function pieceTargets(board: number[], from: number, side: number): number[] {
  const p = board[from]
  const t = baseType(p)
  const prom = isPromoted(p)
  const r = rowOf(from)
  const c = colOf(from)
  const f = fwd(side)
  const out: number[] = []
  const push = (rr: number, cc: number): void => {
    if (!inB(rr, cc)) return
    const q = board[idx(rr, cc)]
    if (q === 0 || signOf(q) !== side) out.push(idx(rr, cc))
  }
  const slide = (dr: number, dc: number): void => {
    let rr = r + dr
    let cc = c + dc
    while (inB(rr, cc)) {
      const q = board[idx(rr, cc)]
      if (q === 0) out.push(idx(rr, cc))
      else {
        if (signOf(q) !== side) out.push(idx(rr, cc))
        break
      }
      rr += dr
      cc += dc
    }
  }
  const steps = (offs: [number, number][]): void => {
    for (const [dr, dc] of offs) push(r + dr, c + dc)
  }
  const GOLD: [number, number][] = [[f, 0], [f, -1], [f, 1], [0, -1], [0, 1], [-f, 0]]
  const DIAG4: [number, number][] = [[-1, -1], [-1, 1], [1, -1], [1, 1]]
  const ORTHO4: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]]
  if (prom) {
    if (t === SK.R) {
      ORTHO4.forEach(([dr, dc]) => slide(dr, dc))
      steps(DIAG4)
    } else if (t === SK.B) {
      DIAG4.forEach(([dr, dc]) => slide(dr, dc))
      steps(ORTHO4)
    } else {
      steps(GOLD) // +P +L +N +S 均行金
    }
    return out
  }
  switch (t) {
    case SK.K:
      steps([...ORTHO4, ...DIAG4])
      break
    case SK.G:
      steps(GOLD)
      break
    case SK.S:
      steps([[f, 0], ...DIAG4])
      break
    case SK.N:
      push(r + 2 * f, c - 1)
      push(r + 2 * f, c + 1)
      break
    case SK.L:
      slide(f, 0)
      break
    case SK.P:
      push(r + f, c)
      break
    case SK.R:
      ORTHO4.forEach(([dr, dc]) => slide(dr, dc))
      break
    case SK.B:
      DIAG4.forEach(([dr, dc]) => slide(dr, dc))
      break
  }
  return out
}

/** by 方伪合法走法（不含打入与升变变体展开——攻击判定用） */
function pseudoMovesAll(board: number[], by: number): SgMove[] {
  const out: SgMove[] = []
  for (let i = 0; i < 81; i++) {
    const p = board[i]
    if (p === 0 || signOf(p) !== by) continue
    for (const to of pieceTargets(board, i, by)) out.push({ from: i, to })
  }
  return out
}

export function applySgMove(prev: SgState, m: SgMove): SgState {
  const board = prev.board.slice()
  const hands: Record<string, number[]> = { '1': prev.hands['1'].slice(), '-1': prev.hands['-1'].slice() }
  const side = prev.turn
  let piece: number
  let captured: number | undefined
  const hist: SgState['history'][number] = { to: m.to, piece: 0 }
  if (m.drop) {
    piece = m.drop * side
    hands[String(side)][m.drop - 2] -= 1
    board[m.to] = piece
    hist.drop = m.drop
  } else {
    piece = board[m.from!]
    captured = board[m.to]
    if (captured) {
      hands[String(side)][baseType(captured) - 2] += 1
      hist.captured = captured
    }
    board[m.from!] = 0
    // 升变编码保号（type+10）：正数加 10、负数减 10——AI 子升变 -3 → -13，
    // 原 piece+10 会把 -3 变成 +7（我方香）造成 260926 冒烟 bug
    board[m.to] = m.promote ? (piece > 0 ? piece + 10 : piece - 10) : piece
    hist.from = m.from
    hist.promote = m.promote
  }
  hist.piece = piece
  return {
    board,
    hands,
    turn: (side === 1 ? -1 : 1) as 1 | -1,
    history: [...prev.history, hist]
  }
}

function kingSq(board: number[], side: number): number {
  for (let i = 0; i < 81; i++) if (board[i] === SK.K * side) return i
  return -1
}

function isInCheck(state: SgState, side: number): boolean {
  const ks = kingSq(state.board, side)
  if (ks < 0) return true
  return pseudoMovesAll(state.board, -side).some((m) => m.to === ks)
}

/** 升变是否强制（步香抵底线 / 桂抵底两行则必升，否则该着非法） */
function mustPromote(t: number, toRow: number, side: number): boolean {
  const last = side === 1 ? 0 : LAST
  if (t === SK.P || t === SK.L) return toRow === last
  if (t === SK.N) return toRow === last || toRow === (side === 1 ? 1 : LAST - 1)
  return false
}

/** 走子（非打入）升变合法性与变体展开 */
function promoVariants(state: SgState, m: SgMove): SgMove[] {
  const p = state.board[m.from!]
  if (isPromoted(p)) return [m]
  const side = state.turn
  const t = baseType(p)
  if (!inZone(rowOf(m.to), side) && !inZone(rowOf(m.from!), side)) return [m]
  if (mustPromote(t, rowOf(m.to), side)) return [{ ...m, promote: true }]
  return [m, { ...m, promote: true }]
}

/** 打入合法性（不含打步诘检测——单独做） */
function canDrop(board: number[], side: number, t: number, to: number): boolean {
  if (board[to] !== 0) return false
  const last = side === 1 ? 0 : LAST
  if ((t === SK.P || t === SK.L) && rowOf(to) === last) return false
  if (t === SK.N && (rowOf(to) === last || rowOf(to) === (side === 1 ? 1 : LAST - 1))) return false
  if (t === SK.P) {
    // 二步：同列已有己方未成步
    const c = colOf(to)
    for (let r = 0; r < 9; r++) {
      if (board[idx(r, c)] === SK.P * side) return false
    }
  }
  return true
}

export function sgLegalMoves(state: SgState, from?: number): SgMove[] {
  const side = state.turn
  const out: SgMove[] = []
  const consider = (m: SgMove): void => {
    const next = applySgMove(state, m)
    if (!isInCheck(next, side)) out.push(m)
  }
  for (let i = 0; i < 81; i++) {
    const p = state.board[i]
    if (p === 0 || signOf(p) !== side) continue
    if (from != null && i !== from) continue
    for (const to of pieceTargets(state.board, i, side)) {
      const base: SgMove = { to, from: i, ...(state.board[to] ? { captured: state.board[to] } : {}) }
      for (const v of promoVariants(state, base)) consider(v)
    }
  }
  if (from == null) {
    for (const t of HAND_TYPES) {
      if (handCount(state, side, t) <= 0) continue
      for (let to = 0; to < 81; to++) {
        if (!canDrop(state.board, side, t, to)) continue
        const m: SgMove = { to, drop: t }
        if (t === SK.P) {
          // 打步诘禁手：打步直接将死对方 → 非法
          const next = applySgMove(state, m)
          const opp = -side
          if (isInCheck(next, opp) && sgLegalMoves(next).length === 0) continue
        }
        consider(m)
      }
    }
  }
  return out
}

export interface SgStatus {
  over: boolean
  /** 我方（先手）视角 */
  result?: 'win' | 'loss'
  reason?: string
}

export function sgStatusOf(state: SgState): SgStatus {
  if (sgLegalMoves(state).length > 0) return { over: false }
  const loser = state.turn
  return {
    over: true,
    result: loser === 1 ? 'loss' : 'win',
    reason: loser === 1 ? '我方被诘み' : 'AI 被诘み'
  }
}

// ---------- AI ----------

const VALUES: Record<number, number> = {
  [SK.K]: 100000,
  [SK.R]: 1000,
  [SK.B]: 800,
  [SK.G]: 550,
  [SK.S]: 450,
  [SK.N]: 350,
  [SK.L]: 300,
  [SK.P]: 100
}
const PROMO_BONUS: Record<number, number> = {
  [SK.R]: 200,
  [SK.B]: 200,
  [SK.G]: 0,
  [SK.S]: 100,
  [SK.N]: 150,
  [SK.L]: 150,
  [SK.P]: 320
}

function evalSente(state: SgState): number {
  let s = 0
  for (const p of state.board) {
    if (p === 0) continue
    const side = signOf(p)
    const t = Math.abs(p)
    let v = VALUES[baseType(t)]
    if (t > 10) v += PROMO_BONUS[t - 10]
    s += side * v
  }
  for (const side of [1, -1]) {
    const hand = state.hands[String(side)]
    for (let i = 0; i < hand.length; i++) {
      const t = i + 2
      s += side * Math.round(VALUES[t] * 1.05) * hand[i]
    }
  }
  return s
}

const sgAdapter: SearchAdapter<SgState, SgMove> = {
  legalMoves: sgLegalMoves,
  apply: applySgMove,
  evaluate: (st) => evalSente(st) * st.turn,
  terminalValue: (st) => (sgLegalMoves(st).length === 0 ? -MATE_SCORE : null),
  orderScore: (m) => (m.captured ? VALUES[baseType(m.captured)] * 10 - 1 : 0)
}

export function findBestSgMove(state: SgState, difficulty: number): SgMove | null {
  return findBestMove(state, sgAdapter, difficulty)
}
