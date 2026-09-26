// 五子棋 AI worker
import { findBestGmMove } from './engine'
import type { GmMove, GmState } from './engine'

self.onmessage = (e: MessageEvent<{ state: GmState; difficulty: number; seq: number }>): void => {
  const { state, difficulty, seq } = e.data
  try {
    const move = findBestGmMove(state, difficulty)
    ;(self as unknown as Worker).postMessage({ seq, move })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ seq, move: null, error: String(err) })
  }
}
