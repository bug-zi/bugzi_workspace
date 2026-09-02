// md 渲染共享件：marked + DOMPurify 消毒（单一实现，MdDialog / AI 边栏共用）
// ==高光== → <mark>（万象卡片划词标记）；外链经事件委托走系统浏览器
import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.use({ gfm: true, breaks: true })

/** md → 安全 HTML；==高光== → <mark> */
export function renderMd(md: string): string {
  const html = marked.parse(md) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }).replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
}

export interface MdViewProps {
  md: string
  /** 追加到根 div 的类名（如 AI 气泡的 ai-msg-content） */
  className?: string
  /** 对外暴露渲染根节点（划词等需要定位正文的场景） */
  bodyRef?: RefObject<HTMLDivElement | null>
}

export default function MdView(props: MdViewProps) {
  const { md, className, bodyRef } = props
  const localRef = useRef<HTMLDivElement>(null)
  const html = useMemo(() => renderMd(md), [md])

  // 外链拦截：事件委托挂在容器上，html 更新无需重挂监听
  useEffect(() => {
    const el = localRef.current
    if (!el) return
    const onClick = (e: MouseEvent): void => {
      const a = (e.target as HTMLElement).closest('a')
      const href = a?.getAttribute('href') ?? ''
      if (a && /^https?:/.test(href)) {
        e.preventDefault()
        void window.api.shell.openExternal(href)
      }
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [])

  return (
    <div
      ref={(el) => {
        localRef.current = el
        if (bodyRef) bodyRef.current = el
      }}
      className={`md-view${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
