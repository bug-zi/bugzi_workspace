// 阅读计时（书架 v2.0 §五）：页面可见 + 窗口聚焦 + 组件可见（keep-alive 切走模块时
// display:none → rect 高度 0）三条件同时满足才计秒；每满 30 秒批量 flush，
// 退出阅读 flush 余量；强杀最多丢 30 秒（与进度节流同哲学）。
import { useEffect } from 'react'
import type { RefObject } from 'react'

export function useReadingTimer(
  active: boolean,
  bookId: number | null,
  hostRef: RefObject<HTMLDivElement | null>
): void {
  useEffect(() => {
    if (!active || bookId == null) return
    let seconds = 0 // 自上次 flush 以来的整秒数
    const visible = (): boolean =>
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      hostRef.current != null &&
      hostRef.current.getBoundingClientRect().height > 0
    const flush = (): void => {
      if (seconds > 0) {
        void window.api.books.addReadTime(bookId, seconds)
        seconds = 0
      }
    }
    const tick = window.setInterval(() => {
      if (visible()) seconds += 1
      if (seconds >= 30) flush()
    }, 1000)
    return () => {
      window.clearInterval(tick)
      flush() // 退出阅读 flush 余量
    }
  }, [active, bookId, hostRef])
}
