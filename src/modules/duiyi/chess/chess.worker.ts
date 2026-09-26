// 国际象棋 AI worker
import { findBestCsMove } from './engine'
import type { CsMove, CsState } from './engine'

self.onmessage = (e: MessageEvent<{ state: CsState; difficulty: number; seq: number }>): void => {
  const { state, difficulty, seq } = e.data
  try {
    const move = findBestCsMove(state, difficulty)
    ;(self as unknown as Worker).postMessage({ seq, move })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ seq, move: null, error: String(err) })
  }
}
