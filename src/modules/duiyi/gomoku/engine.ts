// 五子棋引擎（2026-09-26 对弈社 design §3.4）：15×15 无禁手自由规则，我执黑先手。
// 连五即胜（长连亦胜）、满盘和；AI = 棋型打分（活四/冲四/活三…攻防双向）+ 候选限制搜索。

export const GM_SIZE = 15

export interface GmMove {
  pos: number
}

export interface GmState {
  /** 0 空 1 黑（我） 2 白（AI） */
  board: number[]
  turn: 1 | 2
  history: { pos: number; player: number }[]
}

const idx = (r: number, c: number): number => r * GM_SIZE + c
const rowOf = (i: number): number => Math.floor(i / GM_SIZE)
const colOf = (i: number): number => i % GM_SIZE
const inB = (r: number, c: number): boolean => r >= 0 && r < GM_SIZE && c >= 0 && c < GM_SIZE
const other = (p: number): number => (p === 1 ? 2 : 1)

const DIRS: [number, number][] = [[0, 1], [1, 0], [1, 1], [1, -1]]

export function initGmState(): GmState {
  return { board: new Array<number>(GM_SIZE * GM_SIZE).fill(0), turn: 1, history: [] }
}

/** 落子后该点四方向连子数（≥5 即胜） */
function lineLenFrom(board: number[], pos: number, player: number): number {
  const r = rowOf(pos)
  const c = colOf(pos)
  let best = 1
  for (const [dr, dc] of DIRS) {
    let n = 1
    for (const s of [1, -1]) {
      let rr = r + dr * s
      let cc = c + dc * s
      while (inB(rr, cc) && board[idx(rr, cc)] === player) {
        n++
        rr += dr * s
        cc += dc * s
      }
    }
    if (n > best) best = n
  }
  return best
}

export function gmWinnerAt(board: number[], pos: number, player: number): boolean {
  return lineLenFrom(board, pos, player) >= 5
}

export function applyGmMove(prev: GmState, m: GmMove): GmState {
  if (prev.board[m.pos] !== 0) return prev
  const board = prev.board.slice()
  board[m.pos] = prev.turn
  return {
    board,
    turn: other(prev.turn) as 1 | 2,
    history: [...prev.history, { pos: m.pos, player: prev.turn }]
  }
}

/** 全部可落点（空点；无子时天元） */
export function gmCandidates(state: GmState): number[] {
  const { board } = state
  if (board.every((v) => v === 0)) return [idx(7, 7)]
  const seen = new Set<number>()
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0) continue
    const r = rowOf(i)
    const c = colOf(i)
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const rr = r + dr
        const cc = c + dc
        if (inB(rr, cc) && board[idx(rr, cc)] === 0) seen.add(idx(rr, cc))
      }
    }
  }
  return [...seen]
}

// ---------- 棋型打分 ----------

/** 在 pos 落 player 子后，四方向合成的棋型分 */
function placeScore(board: number[], pos: number, player: number): number {
  const r = rowOf(pos)
  const c = colOf(pos)
  let total = 0
  for (const [dr, dc] of DIRS) {
    let n = 1
    let openEnds = 0
    for (const s of [1, -1]) {
      let rr = r + dr * s
      let cc = c + dc * s
      while (inB(rr, cc) && board[idx(rr, cc)] === player) {
        n++
        rr += dr * s
        cc += dc * s
      }
      if (inB(rr, cc) && board[idx(rr, cc)] === 0) openEnds++
    }
    total += shapeScore(n, openEnds)
  }
  return total
}

function shapeScore(n: number, open: number): number {
  if (n >= 5) return 1000000 // 连五
  if (n === 4) return open >= 1 ? 100000 : 1200 // 活四 / 冲四（无端冲四仍能成五当对方不挡？无端=死四）
  if (n === 3) return open === 2 ? 5000 : open === 1 ? 600 : 0
  if (n === 2) return open === 2 ? 250 : open === 1 ? 40 : 0
  return open === 2 ? 20 : 0
}

/** 站在 player 视角的局面启发：落子点攻防合成 */
function candidateScore(state: GmState, pos: number, player: number): number {
  const opp = other(player)
  const attack = placeScore(state.board, pos, player)
  const defend = placeScore(state.board, pos, opp)
  // 我方成五 > 挡对方成五 > 我活四 > 挡对方活四 …
  return attack + defend * 0.9
}

export interface GmStatus {
  over: boolean
  /** 我方（黑）视角 */
  result?: 'win' | 'loss' | 'draw'
  reason?: string
}

export function gmStatusOf(state: GmState): GmStatus {
  const last = state.history[state.history.length - 1]
  if (!last) return { over: false }
  if (gmWinnerAt(state.board, last.pos, last.player)) {
    return {
      over: true,
      result: last.player === 1 ? 'win' : 'loss',
      reason: last.player === 1 ? '我方连五' : 'AI 连五'
    }
  }
  if (state.history.length === GM_SIZE * GM_SIZE) {
    return { over: true, result: 'draw', reason: '满盘和棋' }
  }
  return { over: false }
}

// ---------- AI ----------

/** 简单候选限制 negamax：depth 按档（入门 0 纯打分 / 进阶 2 / 挑战 4），候选宽度递减 */
function gmNegamax(state: GmState, depth: number, alpha: number, beta: number, width: number): number {
  const me = state.turn
  const last = state.history[state.history.length - 1]
  if (last && gmWinnerAt(state.board, last.pos, last.player)) {
    // 上一步落子方赢 = 当前方输
    return -1000000 + state.history.length
  }
  if (state.history.length >= GM_SIZE * GM_SIZE) return 0
  if (depth <= 0) {
    // 叶子：行棋方最优候选分（近似局面评估）
    let best = 0
    for (const pos of gmCandidates(state)) {
      const v = candidateScore(state, pos, me)
      if (v > best) best = v
    }
    return best
  }
  const cands = gmCandidates(state)
    .map((pos) => ({ pos, v: candidateScore(state, pos, me) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, width)
  let best = -Infinity
  for (const { pos } of cands) {
    const next = applyGmMove(state, { pos })
    const v = -gmNegamax(next, depth - 1, -beta, -alpha, Math.max(4, Math.floor(width / 2)))
    if (v > best) best = v
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best === -Infinity ? 0 : best
}

export function findBestGmMove(state: GmState, difficulty: number): GmMove | null {
  if (state.board.every((v) => v === 0)) return { pos: idx(7, 7) }
  const cands = gmCandidates(state)
    .map((pos) => ({ pos, v: candidateScore(state, pos, state.turn) }))
    .sort((a, b) => b.v - a.v)
  // 即胜即取 / 即挡即防（成五分在 placeScore 已封顶）
  const top = cands[0]
  if (top && top.v >= 1000000) return { pos: top.pos }
  let depth = 0
  let width = 1
  let jitter = 0
  if (difficulty === 2) {
    depth = 2
    width = 8
  } else if (difficulty >= 3) {
    depth = 4
    width = 12
  } else {
    width = 6
    jitter = 150 // 入门：近优软采样
  }
  const scored = cands.slice(0, width).map(({ pos }) => {
    const next = applyGmMove(state, { pos })
    const v = depth === 0 ? candidateScore(state, pos, state.turn) : -gmNegamax(next, depth - 1, -Infinity, Infinity, Math.max(4, Math.floor(width / 2)))
    return { pos, v }
  })
  const best = Math.max(...scored.map((s) => s.v))
  const pool = scored.filter((s) => s.v >= best - jitter)
  return { pos: pool[Math.floor(Math.random() * pool.length)].pos }
}
