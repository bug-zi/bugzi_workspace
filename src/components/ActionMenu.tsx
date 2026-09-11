import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import './ActionMenu.css'

export interface ActionMenuItem {
  key: string
  /** material symbols 图标名（禁 emoji）；可选——不传不渲染图标位（字体选择轮：字体项无勾不占位） */
  icon?: string
  label: string
  danger?: boolean
  separatorAbove?: boolean
  /** 项级样式透传（字体选择轮：fontFamily 自渲染预览） */
  style?: CSSProperties
  /** 图标级样式透传（260911 阅读背景：色块预设只染图标不染文字） */
  iconStyle?: CSSProperties
  onClick: () => void
}

export interface ActionMenuProps {
  /** 锚定元素（与 anchorPoint 二选一）：菜单右缘对齐其右缘、顶部在其下方 6px；底部溢出翻到上方 */
  anchorEl?: HTMLElement
  /** 锚定坐标（优化建议区第39轮：格言库菜单跟随点击处）：左缘对齐 x、顶部在 y 下方 6px；右溢向左回移、底溢翻上方 */
  anchorPoint?: { x: number; y: number }
  items: ActionMenuItem[]
  onClose: () => void
}

/**
 * 通用锚定气泡菜单（优化建议区第15轮：格言行功能浮窗）。
 * fixed 定位 + 视口防溢出 + createPortal 到 body（不被行容器裁剪）。
 * 关闭：外部 mousedown（capture）/ wheel / Esc / resize；点菜单项先 onClose 再 onClick。
 */
export default function ActionMenu(props: ActionMenuProps) {
  const { anchorEl, anchorPoint, items, onClose } = props
  const ref = useRef<HTMLDivElement | null>(null)
  // 先在屏幕外渲染拿真实尺寸，再定位（两次：同步 + rAF 兜底）
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 })

  useEffect(() => {
    const place = (): void => {
      const a = anchorEl?.getBoundingClientRect()
      const el = ref.current
      const w = el?.offsetWidth ?? 180
      const h = el?.offsetHeight ?? 240
      // 点锚定（第39轮）：菜单左缘对齐点击 x；元素锚定：右缘对齐锚右缘
      let left = anchorPoint != null ? anchorPoint.x : a != null ? a.right - w : 8
      let top = anchorPoint != null ? anchorPoint.y + 6 : a != null ? a.bottom + 6 : 8
      // 底部溢出翻到锚点上方（点锚定参考点击 y，元素锚定参考锚上缘）
      const flipTop = anchorPoint != null ? anchorPoint.y : (a?.top ?? 8)
      if (top + h > window.innerHeight - 8) top = Math.max(8, flipTop - h - 6)
      // 点锚定右溢向左回移；元素锚定本就右对齐，只需左缘下限
      if (anchorPoint != null && left + w > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - 8 - w)
      }
      if (left < 8) left = 8
      setPos({ top, left })
    }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [anchorEl, anchorPoint])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div className="action-menu" ref={ref} style={{ top: pos.top, left: pos.left }} role="menu">
      {items.map((it) => (
        <div key={it.key}>
          {it.separatorAbove && <div className="action-menu-sep" />}
          <button
            className={`action-menu-item${it.danger ? ' danger' : ''}`}
            style={it.style}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            {it.icon && (
              <span className="material-symbols-outlined" style={it.iconStyle}>
                {it.icon}
              </span>
            )}
            {it.label}
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
