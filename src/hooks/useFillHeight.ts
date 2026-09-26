// 阅读视图贴底高度：量根节点视口 top，撑到窗口底部（-12px 呼吸边距）。
// 同一组件在「整页切换」（信息源式）与「页签容器内嵌」（万象库科普，头部/页签仍可见）两种
// 场景下都能恰好占满剩余空间，免写魔法数高度。
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export function useFillHeight(): { ref: RefObject<HTMLDivElement | null>; height: number | undefined } {
  const ref = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number | undefined>(undefined)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = (): void => {
      const top = el.getBoundingClientRect().top
      setHeight(Math.max(320, window.innerHeight - top - 12))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  return { ref, height }
}
