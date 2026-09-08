// 阅读键盘映射（书架优化第1轮 §8.2）：WASD 与方向键同权；输入控件聚焦时不劫持
export type ReaderKeyDir = 'up' | 'down' | 'left' | 'right'

/** 键值 → 方向（无输入保护；keyup 停滚动必须总能归一） */
export function dirOfKey(e: KeyboardEvent): ReaderKeyDir | null {
  const k = e.key.toLowerCase()
  if (k === 'w' || k === 'arrowup') return 'up'
  if (k === 's' || k === 'arrowdown') return 'down'
  if (k === 'a' || k === 'arrowleft') return 'left'
  if (k === 'd' || k === 'arrowright') return 'right'
  return null
}

/** keydown → 方向；非导航键或输入场景（input/textarea/contentEditable）返回 null */
export function parseReaderKey(e: KeyboardEvent): ReaderKeyDir | null {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return null
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  return dirOfKey(e)
}

/** 阅读模式（全局记忆，settings.BooksReadingMode） */
export type ReadingMode = 'scroll' | 'page'

/** 按住流式滚动器（260909 开发者反馈：W/S 要细、要流式）：
 *  keydown（忽略系统重发）登记方向并启动 rAF 循环，逐帧小步 scrollTop → 60fps 连续流动；
 *  keyup 注销方向；全部松开即停。 */
export interface HoldScroller {
  /** 登记按住方向（dir：-1 上 / 1 下）与滚动元素 */
  press: (dir: -1 | 1, scroller: HTMLElement) => void
  /** 注销方向（不传 = 全清） */
  release: (dir?: -1 | 1) => void
  /** 全部停止（blur / 卸载清理） */
  stop: () => void
}

/** 滚动速度（px/ms，≈ 550px/s；再乘帧间隔） */
const HOLD_VELOCITY = 0.55

export function createHoldScroller(): HoldScroller {
  const held = new Map<-1 | 1, HTMLElement>()
  let raf = 0
  let last = 0
  const stopLoop = (): void => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    last = 0
  }
  const tick = (t: number): void => {
    const dt = last ? Math.min(t - last, 50) : 16
    last = t
    for (const [dir, el] of held) el.scrollTop += dir * HOLD_VELOCITY * dt
    if (held.size > 0) raf = requestAnimationFrame(tick)
    else stopLoop()
  }
  const ensure = (): void => {
    if (!raf) {
      last = 0
      raf = requestAnimationFrame(tick)
    }
  }
  return {
    press: (dir, scroller) => {
      held.set(dir, scroller)
      ensure()
    },
    release: (dir) => {
      if (dir) held.delete(dir)
      else held.clear()
      if (held.size === 0) stopLoop()
    },
    stop: () => {
      held.clear()
      stopLoop()
    }
  }
}
