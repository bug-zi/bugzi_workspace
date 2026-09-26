// 象棋 AI worker：引擎搜索在线程内跑，主线程零阻塞
import { findBestXqMove } from './engine'
import type { XqMove, XqState } from './engine'

self.onmessage = (e: MessageEvent<{ state: XqState; difficulty: number; seq: number }>): void => {
  const { state, difficulty, seq } = e.data
  try {
    const move = findBestXqMove(state, difficulty)
    ;(self as unknown as Worker).postMessage({ seq, move })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ seq, move: null, error: String(err) })
  }
}
