// 划词气泡（自 MdDialog 原样抽出共用）：正文选区浮出「问 AI/高光/取消高光」操作泡。
// active=false 或未传 actions 时不生效；选区整体落在既有 <mark> 内出「取消高光」
// （整段标记文本，防嵌套 ==标记== 脏写）。调用方持有 onHighlight/onUnhighlight/onAskAi。
import { useEffect } from 'react'
import type { RefObject } from 'react'

export interface SelectionActions {
  onHighlight?: (text: string) => void
  /** 选区落在既有高光 <mark> 内时出「取消高光」（text 为整段标记文本；不传则该场景仍出「高光」） */
  onUnhighlight?: (text: string) => void
  onAskAi: (text: string) => void
}

export function useSelectionBubble(
  active: boolean,
  bodyRef: RefObject<HTMLDivElement | null>,
  actions: SelectionActions | undefined
): void {
  useEffect(() => {
    const body = bodyRef.current
    if (!active || !body || !actions) return
    let bubble: HTMLDivElement | null = null
    const removeBubble = (): void => {
      bubble?.remove()
      bubble = null
    }
    const onMouseUp = (e: MouseEvent): void => {
      // 点击气泡本身：不移除，交给按钮 click 处理。若在此移除，click 派发前按钮已脱离
      // DOM，click 事件不会触发（「高光/问 AI」点击无响应的根因，DOM 顺序 mousedown→mouseup→click）
      if (bubble && e.target instanceof Node && bubble.contains(e.target)) return
      removeBubble()
      const sel = window.getSelection()
      const text = sel?.toString().trim() ?? ''
      if (!text || text.length > 500 || !sel) return
      const range = sel.getRangeAt(0)
      if (!body.contains(range.commonAncestorContainer)) return
      const rect = range.getBoundingClientRect()
      bubble = document.createElement('div')
      bubble.className = 'sel-bubble'
      const mkBtn = (label: string, onClick: () => void): HTMLButtonElement => {
        const b = document.createElement('button')
        b.textContent = label
        b.addEventListener('click', (e) => {
          e.stopPropagation()
          onClick()
          removeBubble()
          sel.removeAllRanges()
        })
        return b
      }
      const anc = range.commonAncestorContainer
      const ancEl = anc.nodeType === Node.TEXT_NODE ? anc.parentElement : (anc as Element)
      const markEl = ancEl?.closest('mark') ?? null
      const { onHighlight, onUnhighlight, onAskAi } = actions
      const btns = [mkBtn('问 AI', () => onAskAi(text))]
      if (markEl && onUnhighlight) btns.unshift(mkBtn('取消高光', () => onUnhighlight(markEl.textContent ?? '')))
      else if (onHighlight) btns.unshift(mkBtn('高光', () => onHighlight(text)))
      bubble.append(...btns)
      document.body.appendChild(bubble)
      const bw = 150
      bubble.style.left = `${Math.max(8, rect.left + rect.width / 2 - bw / 2)}px`
      bubble.style.top = `${Math.max(8, rect.top - 40)}px`
    }
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      removeBubble()
    }
  }, [active, actions, bodyRef])
}
