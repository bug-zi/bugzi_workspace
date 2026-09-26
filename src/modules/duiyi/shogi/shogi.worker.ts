// 将棋 AI worker
import { findBestSgMove } from './engine'
import type { SgMove, SgState } from './engine'

self.onmessage = (e: MessageEvent<{ state: SgState; difficulty: number; seq: number }>): void => {
  const { state, difficulty, seq } = e.data
  try {
    const move = findBestSgMove(state, difficulty)
    ;(self as unknown as Worker).postMessage({ seq, move })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ seq, move: null, error: String(err) })
  }
}
