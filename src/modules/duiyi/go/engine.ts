// 围棋引擎（2026-09-26 对弈社 design §3.5）：N×N（9/13/19）中国规则——禁自杀、简单劫、
// 连续两次 pass 终局 → 死子标记（整组切换）→ 区域法数子（贴目 7.5）。
// 我执黑（1）先手，AI 执白（2）。AI 为启发式弱手（大棋盘明示娱乐级）。
export const GO_KOMI = 7.5

export type GoPhase = 'play' | 'marking'

export interface GoMove {
  pos: number | null // null = pass
}

export interface GoState {
  size: number
  /** 0 空 1 黑（我） 2 白（AI） */
  board: number[]
  turn: 1 | 2
  /** 简单劫：被提单子后本轮禁回提点，无则 -1 */
  ko: number
  passes: number
  phase: GoPhase
  /** 死子标记集合（marking 阶段；整组切换由 UI 调 toggleDeadGroup） */
  dead: number[]
  history: { pos: number | null; player: number }[]
}

const rowOf = (i: number, n: number): number => Math.floor(i / n)
const colOf = (i: number, n: number): number => i % n

export function initGoState(size: number): GoState {
  return {
    size,
    board: new Array<number>(size * size).fill(0),
    turn: 1,
    ko: -1,
    passes: 0,
    phase: 'play',
    dead: [],
    history: []
  }
}

function neighbors(i: number, n: number): number[] {
  const r = rowOf(i, n)
  const c = colOf(i, n)
  const out: number[] = []
  if (r > 0) out.push(i - n)
  if (r < n - 1) out.push(i + n)
  if (c > 0) out.push(i - 1)
  if (c < n - 1) out.push(i + 1)
  return out
}

/** 含 i 的整组棋子与气数 */
export function goGroup(board: number[], n: number, i: number): { stones: number[]; libs: number } {
  const color = board[i]
  const stones: number[] = [i]
  const seen = new Set<number>([i])
  const libs = new Set<number>()
  for (let k = 0; k < stones.length; k++) {
    for (const nb of neighbors(stones[k], n)) {
      if (board[nb] === 0) libs.add(nb)
      else if (board[nb] === color && !seen.has(nb)) {
        seen.add(nb)
        stones.push(nb)
      }
    }
  }
  return { stones, libs: libs.size }
}

/** 落子合法：空点、非自杀、非劫回提 */
export function goIsLegal(state: GoState, pos: number): boolean {
  if (state.board[pos] !== 0) return false
  if (pos === state.ko) return false
  const n = state.size
  const board = state.board.slice()
  board[pos] = state.turn
  // 提对方无气群
  for (const nb of neighbors(pos, n)) {
    if (board[nb] !== 0 && board[nb] !== state.turn) {
      const g = goGroup(board, n, nb)
      if (g.libs === 0) g.stones.forEach((s) => (board[s] = 0))
    }
  }
  const own = goGroup(board, n, pos)
  return own.libs > 0
}

export function applyGoMove(prev: GoState, m: GoMove): GoState {
  if (m.pos == null) {
    return { ...prev, turn: (prev.turn === 1 ? 2 : 1) as 1 | 2, ko: -1, passes: prev.passes + 1, history: [...prev.history, { pos: null, player: prev.turn }] }
  }
  if (!goIsLegal(prev, m.pos)) return prev
  const n = prev.size
  const board = prev.board.slice()
  const me = prev.turn
  board[m.pos] = me
  let captured = 0
  let lastCap = -1
  for (const nb of neighbors(m.pos, n)) {
    if (board[nb] !== 0 && board[nb] !== me) {
      const g = goGroup(board, n, nb)
      if (g.libs === 0) {
        g.stones.forEach((s) => {
          board[s] = 0
          captured++
          lastCap = s
        })
      }
    }
  }
  // 简单劫：恰好提一子且己方落子成单子一气 → 劫点 = 被提位
  let ko = -1
  if (captured === 1) {
    const own = goGroup(board, n, m.pos)
    if (own.stones.length === 1 && own.libs === 1) ko = lastCap
  }
  return {
    ...prev,
    board,
    turn: (me === 1 ? 2 : 1) as 1 | 2,
    ko,
    passes: 0,
    history: [...prev.history, { pos: m.pos, player: me }]
  }
}

/** 死子标记切换（整组；marking 阶段用） */
export function goToggleDeadGroup(state: GoState, pos: number): GoState {
  const g = goGroup(state.board, state.size, pos)
  const isDead = state.dead.includes(pos)
  const dead = isDead ? state.dead.filter((d) => !g.stones.includes(d)) : [...state.dead, ...g.stones]
  return { ...state, dead }
}

export interface GoScore {
  black: number
  white: number
  /** 黑 - 白（含贴目） */
  diff: number
  result: 'win' | 'loss' | 'draw'
  reason: string
}

/** 区域法数子：死子移除后，黑=黑子+黑独围空，白=白子+白独围空+贴目 */
export function goScore(state: GoState): GoScore {
  const n = state.size
  const board = state.board.slice()
  for (const d of state.dead) board[d] = 0
  const seen = new Set<number>()
  let black = 0
  let white = 0
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 1) black++
    else if (board[i] === 2) white++
    else if (!seen.has(i)) {
      // 空域泛洪：触边颜色决定归属
      const region: number[] = [i]
      seen.add(i)
      let touchBlack = false
      let touchWhite = false
      for (let k = 0; k < region.length; k++) {
        for (const nb of neighbors(region[k], n)) {
          if (board[nb] === 0) {
            if (!seen.has(nb)) {
              seen.add(nb)
              region.push(nb)
            }
          } else if (board[nb] === 1) touchBlack = true
          else touchWhite = true
        }
      }
      if (touchBlack && !touchWhite) black += region.length
      else if (touchWhite && !touchBlack) white += region.length
    }
  }
  white += GO_KOMI
  const diff = black - white
  const result = diff > 0 ? 'win' : diff < 0 ? 'loss' : 'draw'
  return {
    black,
    white,
    diff,
    result,
    reason: `数子：黑 ${black} —— 白 ${white}（含贴目 ${GO_KOMI}），${result === 'win' ? '黑胜' : result === 'loss' ? '白胜' : '和棋'}`
  }
}

export interface GoStatus {
  over: boolean
  result?: 'win' | 'loss' | 'draw'
  reason?: string
}

export function goStatusOf(state: GoState): GoStatus {
  if (state.passes < 2) return { over: false }
  const s = goScore(state)
  return { over: true, result: s.result, reason: s.reason }
}

// ---------- AI（启发式弱手） ----------

// 星位点（(r,c) → r*n+c）：9 路 (2|4|6,2|4|6)、13 路 (3|6|9,·)、19 路 (3|9|15,·)
const STAR_9 = [20, 24, 40, 56, 60]
const STAR_13 = [42, 45, 48, 81, 84, 87, 120, 123, 126]
const STAR_19 = [60, 66, 72, 174, 180, 186, 288, 294, 300]

function starPoints(n: number): number[] {
  if (n === 9) return STAR_9
  if (n === 13) return STAR_13
  return STAR_19
}

/** 候选点：与棋子相邻/隔一 + 前半盘星位与三三 */
function goCandidates(state: GoState): number[] {
  const n = state.size
  const seen = new Set<number>()
  let hasStone = false
  for (let i = 0; i < state.board.length; i++) {
    if (state.board[i] === 0) continue
    hasStone = true
    for (const nb of neighbors(i, n)) {
      if (state.board[nb] === 0) seen.add(nb)
      // 隔一路
      const dr = rowOf(nb, n) - rowOf(i, n)
      const dc = colOf(nb, n) - colOf(i, n)
      const rr = rowOf(i, n) + dr * 2
      const cc = colOf(i, n) + dc * 2
      if (rr >= 0 && rr < n && cc >= 0 && cc < n && state.board[rr * n + cc] === 0) seen.add(rr * n + cc)
    }
  }
  if (!hasStone) return [Math.floor((n * n) / 2)]
  const moves = state.history.filter((h) => h.pos != null).length
  if (moves < n) {
    for (const sp of starPoints(n)) {
      if (state.board[sp] === 0 && !seen.has(sp)) seen.add(sp)
    }
  }
  return [...seen]
}

/** 启发式打分：提子/救吃/打吃/定式位/边线惩罚/贴棋 */
function goHeuristic(state: GoState, pos: number): number {
  const n = state.size
  const me = state.turn
  const opp = me === 1 ? 2 : 1
  const board = state.board.slice()
  board[pos] = me
  let score = 0
  let captured = 0
  for (const nb of neighbors(pos, n)) {
    if (board[nb] === opp) {
      const g = goGroup(board, n, nb)
      if (g.libs === 0) captured += g.stones.length
      else if (g.libs === 1) score += 35 // 打吃
    }
  }
  score += captured * 120
  const own = goGroup(board, n, pos)
  if (own.libs <= 1) return -1000 // 自投罗网
  if (own.libs === 2) score -= 15
  // 救援：落子前己方邻群处于叫吃
  for (const nb of neighbors(pos, n)) {
    if (state.board[nb] === me) {
      const g = goGroup(state.board, n, nb)
      if (g.libs === 1) score += 90
    }
  }
  // 连接/拆边：与己子相邻加小分
  let nearMe = 0
  for (const nb of neighbors(pos, n)) if (state.board[nb] === me) nearMe++
  score += nearMe * 8
  // 开局定式位与线位
  const moves = state.history.filter((h) => h.pos != null).length
  const r = rowOf(pos, n)
  const c = colOf(pos, n)
  const line = Math.min(r, c, n - 1 - r, n - 1 - c)
  if (moves < n * 2) {
    if (line === 2 || line === 3) score += 12 // 三线/四线略优
    if (starPoints(n).includes(pos)) score += 20
  }
  if (line === 0) score -= 30
  else if (line === 1 && moves < n * 3) score -= 12
  // 均衡：离最近己子的距离（粗略，避免全堆一处）
  if (nearMe === 0) score += 6
  return score
}

export function findBestGoMove(state: GoState): GoMove {
  const cands = goCandidates(state)
  let best: number | null = null
  let bestScore = -Infinity
  const jitter = state.size === 9 ? 0 : state.size === 13 ? 10 : 25
  for (const pos of cands) {
    if (!goIsLegal(state, pos)) continue
    let v = goHeuristic(state, pos) + Math.random() * jitter
    if (v > bestScore) {
      bestScore = v
      best = pos
    }
  }
  if (best == null) return { pos: null } // 无处可下则 pass
  return { pos: best }
}
