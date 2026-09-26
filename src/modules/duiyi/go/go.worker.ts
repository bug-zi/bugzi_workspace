// 围棋 AI worker（启发式弱手，难度不影响强度只影响小随机度）
import { findBestGoMove } from './engine'
import type { GoMove, GoState } from './engine'

self.onmessage = (e: MessageEvent<{ state: GoState; difficulty: number; seq: number }>): void => {
  const { state, seq } = e.data
  try {
    const move = findBestGoMove(state)
    ;(self as unknown as Worker).postMessage({ seq, move })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ seq, move: null, error: String(err) })
  }
}
