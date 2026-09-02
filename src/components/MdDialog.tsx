// 全局 md 弹窗组件（样式 specs §5）：默认渲染态，双击编辑，退出保存
import { useCallback, useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import './MdDialog.css'

export interface MdDialogProps {
  open: boolean
  title: string
  /** md 相对路径（userData 下） */
  filePath: string
  /** 关闭弹窗（关闭键/遮罩调用；若正处于编辑态会先保存） */
  onClose: () => void
  onChanged?: () => void
  /** 万象卡片划词能力开关（仅万象库启用） */
  selectionActions?: {
    onHighlight: (text: string) => void
    onAskAi: (text: string) => void
  }
  /** 头部标题可编辑（灵感泉：标题改后列表同步） */
  onTitleChange?: (title: string) => void
}

marked.use({ gfm: true, breaks: true })

/** md → 安全 HTML；==高光== → <mark> */
function renderMd(md: string): string {
  const html = marked.parse(md) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] })
}

export default function MdDialog(props: MdDialogProps) {
  const { open, title, filePath, onClose, onChanged, selectionActions, onTitleChange } = props
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [titleDraft, setTitleDraft] = useState(title)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTitleDraft(title)
  }, [title])

  // 打开/换文件时加载
  useEffect(() => {
    if (!open || !filePath) return
    setLoading(true)
    setEditing(false)
    window.api.md
      .read(filePath)
      .then((c) => setContent(c))
      .catch(() => setContent('（读取失败）'))
      .finally(() => setLoading(false))
  }, [open, filePath])

  // ==text== → <mark>（渲染后处理，避免 marked 不识别）
  useEffect(() => {
    if (!open || !bodyRef.current) return
    const html = renderMd(content)
    bodyRef.current.innerHTML = html.replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
    // 链接拦截：外链走系统浏览器
    bodyRef.current.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href') ?? ''
      if (/^https?:/.test(href)) {
        a.addEventListener('click', (e) => {
          e.preventDefault()
          void window.api.shell.openExternal(href)
        })
      }
    })
  }, [content, open, editing])

  const saveAndExit = useCallback(async () => {
    if (draft !== content) {
      await window.api.md.write(filePath, draft)
      setContent(draft)
      onChanged?.()
    }
    setEditing(false)
  }, [draft, content, filePath, onChanged])

  /** 关闭：编辑态先保存草稿再关 */
  const close = useCallback((): void => {
    if (editing) {
      void saveAndExit().then(() => onClose())
    } else {
      onClose()
    }
  }, [editing, saveAndExit, onClose])

  // Esc 关闭（编辑态先保存）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // 划词气泡（万象卡片）
  useEffect(() => {
    const body = bodyRef.current
    if (!open || !body || !selectionActions) return
    let bubble: HTMLDivElement | null = null
    const removeBubble = (): void => {
      bubble?.remove()
      bubble = null
    }
    const onMouseUp = (): void => {
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
      bubble.append(
        mkBtn('高光', () => selectionActions.onHighlight(text)),
        mkBtn('问 AI', () => selectionActions.onAskAi(text))
      )
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
  }, [open, selectionActions])

  if (!open) return null

  const commitTitle = (): void => {
    const t = titleDraft.trim()
    if (t && t !== title) onTitleChange?.(t)
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          close()
        }
      }}
    >
      <div className={`dialog md-dialog${editing ? ' editing' : ''}`}>
        <div className="dialog-header">
          {onTitleChange ? (
            <input
              className="field title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              style={{ flex: 1, fontWeight: 500 }}
            />
          ) : (
            <span style={{ flex: 1 }} title={title}>
              {title}
            </span>
          )}
          {!editing && (
            <span className="edit-hint">双击正文编辑</span>
          )}
          {editing ? (
            <button className="btn btn-primary" onClick={() => void saveAndExit()}>
              完成
            </button>
          ) : (
            <button
              className="btn btn-ghost close-btn"
              onClick={close}
              title="关闭"
            >
              关闭
            </button>
          )}
        </div>
        <div className="dialog-body" onDoubleClick={() => !editing && startEditing()}>
          {loading ? (
            <div>加载中…</div>
          ) : editing ? (
            <textarea
              className="editor"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') void saveAndExit()
              }}
              autoFocus
              spellCheck={false}
            />
          ) : (
            <div className="md-view" ref={bodyRef} />
          )}
        </div>
      </div>
    </div>
  )

  function startEditing(): void {
    setDraft(content)
    setEditing(true)
  }
}
