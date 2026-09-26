// 对弈社公共搜索骨架（2026-09-26 对弈社 design §3）：negamax + alpha-beta + 迭代加深时间盒。
// 各棋引擎提供合法着生成/应用/评估/终局判定四个钩子；state 必须可 JSON 序列化（快照落库要求）。

/** 棋力档（1 入门 / 2 进阶 / 3 挑战）：时间盒与最大深度；入门档在近优着中软采样带随机 */
export interface DifficultySpec {
  timeMs: number
  maxDepth: number
  /** 根层从分差 ≤ jitterBand 的着法中随机选（0 = 永远最优） */
  jitterBand: number
}

export const DIFFICULTIES: Record<number, DifficultySpec> = {
  1: { timeMs: 300, maxDepth: 2, jitterBand: 60 },
  2: { timeMs: 900, maxDepth: 4, jitterBand: 0 },
  3: { timeMs: 2000, maxDepth: 6, jitterBand: 0 }
}

/** negamax 适配器：评估分约定为「行棋方视角」（正 = 行棋方优） */
export interface SearchAdapter<S, M> {
  legalMoves(state: S): M[]
  apply(state: S, m: M): S
  /** depth 0 或叶子评估；返回行棋方视角分 */
  evaluate(state: S): number
  /** 终局判定（行棋方视角分；null = 未终局）。棋类：无合法着 = 当前方负（国象逼和返回 0） */
  terminalValue(state: S): number | null
  /** 走法排序权（大者优先；通常 MVV 吃子分，非吃子 0） */
  orderScore(m: M): number
}

export const MATE_SCORE = 100000

/**
 * 根搜索：返回最佳着（连同根层各着分供软采样）。
 * negamax 返回值即「走这步的一方」的最终期望分。
 */
function searchRoot<S, M>(
  state: S,
  adapter: SearchAdapter<S, M>,
  maxDepth: number,
  deadline: number
): { move: M; score: number }[] {
  let moves = adapter.legalMoves(state)
  if (moves.length === 0) return []
  let scored = moves.map((m) => ({ move: m, score: 0 }))
  for (let depth = 1; depth <= maxDepth; depth++) {
    const results: { move: M; score: number }[] = []
    let alpha = -Infinity
    // 上层最优排前（迭代加深走法排序）
    const order = [...scored].sort((a, b) => b.score - a.score)
    moves = order.map((r) => r.move)
    let timeout = false
    for (const m of moves) {
      const next = adapter.apply(state, m)
      const v = -negamax(next, adapter, depth - 1, -Infinity, -alpha, 1, deadline)
      if (Date.now() > deadline) {
        timeout = true
        break
      }
      results.push({ move: m, score: v })
      if (v > alpha) alpha = v
    }
    if (results.length === scored.length) scored = results
    else if (results.length > 0) {
      // 本层超时：已算完的着覆盖同位结果（顺序一致）
      for (let i = 0; i < results.length; i++) scored[i] = results[i]
    }
    if (timeout || Date.now() > deadline) break
    // 提前找到必胜：不再加深
    if (scored.some((r) => r.score >= MATE_SCORE - 100)) break
  }
  return scored
}

function negamax<S, M>(
  state: S,
  adapter: SearchAdapter<S, M>,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
  deadline: number
): number {
  const term = adapter.terminalValue(state)
  if (term != null) return term > 0 ? term - ply : term + ply // 快胜优先
  if (depth <= 0) return adapter.evaluate(state)
  const moves = adapter.legalMoves(state)
  if (moves.length === 0) return -MATE_SCORE + ply
  if (moves.length > 1) moves.sort((a, b) => adapter.orderScore(b) - adapter.orderScore(a))
  let best = -Infinity
  for (const m of moves) {
    const next = adapter.apply(state, m)
    const v = -negamax(next, adapter, depth - 1, -beta, -alpha, ply + 1, deadline)
    if (v > best) best = v
    if (best > alpha) alpha = best
    if (alpha >= beta) break
    if ((ply & 3) === 0 && Date.now() > deadline) break // 定期查超时，深层节点代价高
  }
  return best
}

/** 找最佳着（各棋 AI 入口，worker 内调用）：时间盒迭代加深 + 入门档近优软采样 */
export function findBestMove<S, M>(state: S, adapter: SearchAdapter<S, M>, difficulty: number): M | null {
  const spec = DIFFICULTIES[difficulty] ?? DIFFICULTIES[2]
  const deadline = Date.now() + spec.timeMs
  const results = searchRoot(state, adapter, spec.maxDepth, deadline)
  if (results.length === 0) return null
  const best = Math.max(...results.map((r) => r.score))
  if (spec.jitterBand > 0) {
    const pool = results.filter((r) => r.score >= best - spec.jitterBand)
    return pool[Math.floor(Math.random() * pool.length)].move
  }
  return results.find((r) => r.score === best)!.move
}
