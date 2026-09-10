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
  /** 锚定元素：菜单右缘对齐其右缘、顶部在其下方 6px；底部溢出翻到上方 */
  anchorEl: HTMLElement
  items: ActionMenuItem[]
  onClose: () => void
}

/**
 * 通用锚定气泡菜单（优化建议区第15轮：格言行功能浮窗）。
 * fixed 定位 + 视口防溢出 + createPortal 到 body（不被行容器裁剪）。
 * 关闭：外部 mousedown（capture）/ wheel / Esc / resize；点菜单项先 onClose 再 onClick。
 */
export default function ActionMenu(props: ActionMenuProps) {
  const { anchorEl, items, onClose } = props
  const ref = useRef<HTMLDivElement | null>(null)
  // 先在屏幕外渲染拿真实尺寸，再定位（两次：同步 + rAF 兜底）
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 })

  useEffect(() => {
    const place = (): void => {
      const a = anchorEl.getBoundingClientRect()
      const el = ref.current
      const w = el?.offsetWidth ?? 180
      const h = el?.offsetHeight ?? 240
      let left = a.right - w
      let top = a.bottom + 6
      if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6)
      if (left < 8) left = 8
      setPos({ top, left })
    }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [anchorEl])

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
