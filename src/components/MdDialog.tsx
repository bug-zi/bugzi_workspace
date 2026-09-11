// 全局 md 弹窗组件（样式 specs §5）：默认渲染态，双击编辑，退出保存
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { renderMd } from './MdView'
import './MdDialog.css'

export interface MdDialogProps {
  open: boolean
  title: string
  /** 标题下方的小字副标题（格言笔记弹窗：出处行；不传则不渲染） */
  subtitle?: string
  /** 标题右侧小 pill（万象卡片：所属板块名；不传则不渲染，其余模块行为不变） */
  titleTag?: string
  /** md 相对路径（userData 下）；content 直传时不需（书架笔记总览） */
  filePath?: string
  /** 直接给 md 内容（提供则不读文件——书架笔记总览按需生成，不落盘；书架 v2.0 §三） */
  content?: string
  /** 纯查看模式：不显示「双击正文编辑」、双击不进编辑态（内容数据源不在文件） */
  readOnly?: boolean
  /** 头部「关闭」旁动作按钮（书架笔记总览：导出） */
  headerAction?: { label: string; icon?: string; onClick: () => void }
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
  /** 生成审核流（万象库第一遍生成，优化建议区）：底部三选——加入=关闭（走 onClose），
   *  丢弃/直接删除由调用方处理（需自行二次确认）；Esc/遮罩关闭同样视为「加入」 */
  review?: {
    onDiscard: () => void
    onDelete: () => void
  }
  /** 万象库待学习卡片（260910 待学习区）：底部操作条——learn 态三钮（直接删除/丢弃/学会了）、
   *  learned 态单钮（已学会，点击移回待学习区；onDiscard/onDelete 不传则不渲染）。
   *  关闭/遮罩/Esc = 留在待学习区，不强制三选一（区别于 review 流，头部关闭钮保留）。 */
  learnBar?: {
    learned: boolean
    onToggle: () => void
    onDiscard?: () => void
    onDelete?: () => void
  }
  /** 学习库卡片（260911 学习库）：底部学习操作条——mode 决定按钮组：new=未学（学会了）、
   *  review=到期复习（记住了/忘记了）、done=已学未到期或毕业（只读态显示 statusText）。
   *  关闭/遮罩/Esc = 保留现状，不强制操作（同 learnBar 口径，头部关闭钮保留）。 */
  studyBar?: {
    mode: 'new' | 'review' | 'done'
    /** done 态状态文案（如「已学 · 3 天后复习」/「已毕业」） */
    statusText?: string
    onLearn?: () => void
    onRemember?: () => void
    onForget?: () => void
  }
  /** 致知己版本化扩展（致知己 specs §2）：版本切换条 + 保存即版本 + 让 AI 追问 */
  versioned?: {
    /** 全部版本（seq 倒序），label 如 v3-260905 */
    versions: { id: number; label: string }[]
    /** 当前展示版本 id */
    currentId: number | null
    /** 切换版本（换 filePath 重载；编辑态下非当前 chip 禁用防误触丢草稿） */
    onSelect: (id: number) => void
    /** 保存（编辑退出、内容有变化时）：overwrite=勾选覆盖当前版本，默认存新版本；替代默认 md.write */
    onSave: (content: string, overwrite: boolean) => Promise<void> | void
    /** 让 AI 追问（携带当前正文，非编辑态） */
    onAskAi: (content: string) => void
  }
  /** 浮生记大事件标记（文笔坊 specs §2.2，仅浮生记传入）：编辑态头部显示开关，切换即时生效 */
  eventToggle?: { checked: boolean; onChange: (v: boolean) => void }
  /** 首次打开即进入编辑态（致知己新建 v1 空文档；版本切换不触发） */
  autoEdit?: boolean
  /** 右侧内嵌栏（致知己追问，优化建议区第13轮）：传入则弹窗加宽为「md 区 + 侧栏」双栏，交互不出弹窗 */
  sidePanel?: ReactNode
}

export default function MdDialog(props: MdDialogProps) {
  const { open, title, subtitle, titleTag, filePath, content: directContent, readOnly, headerAction, onClose, onChanged, selectionActions, onTitleChange, review, learnBar, studyBar, versioned, eventToggle, autoEdit, sidePanel } = props
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [titleDraft, setTitleDraft] = useState(title)
  // 致知己：覆盖当前版本勾选（每次进入编辑态重置）
  const [overwrite, setOverwrite] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  // autoEdit 仅在 open 的首次加载生效（版本切换换 filePath 不再触发）
  const wasOpenRef = useRef(false)

  useEffect(() => {
    setTitleDraft(title)
  }, [title])

  // 打开/换文件时加载（content 直传优先——书架笔记总览按需生成不落盘）
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    if (directContent !== undefined) {
      wasOpenRef.current = true
      setLoading(false)
      setEditing(false)
      setOverwrite(false)
      setContent(directContent)
      return
    }
    if (!filePath) return
    const firstOpen = !wasOpenRef.current
    wasOpenRef.current = true
    setLoading(true)
    setEditing(false)
    setOverwrite(false)
    window.api.md
      .read(filePath)
      .then((c) => {
        setContent(c)
        if (firstOpen && autoEdit) {
          setDraft(c)
          setEditing(true)
        }
      })
      .catch(() => setContent('（读取失败）'))
      .finally(() => setLoading(false))
  }, [open, filePath, directContent, autoEdit])

  // ==text== → <mark>（渲染后处理，避免 marked 不识别）
  // deps 含 loading：加载中 bodyRef 被 loading 分支卸载，读完 setContent 时 ref 还是 null 会早退；
  // loading 翻回 false 重新挂上 bodyRef 后需重跑本 effect，否则首开渲染空白（进编辑态再退出才显示）
  useEffect(() => {
    if (!open || loading || !bodyRef.current) return
    bodyRef.current.innerHTML = renderMd(content)
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
  }, [content, open, editing, loading])

  const saveAndExit = useCallback(async () => {
    if (draft !== content) {
      if (versioned) {
        // 致知己：保存即版本（specs §2），写库/写文件由模块处理
        await versioned.onSave(draft, overwrite)
        setContent(draft)
        onChanged?.()
      } else if (filePath) {
        await window.api.md.write(filePath, draft)
        setContent(draft)
        onChanged?.()
      }
    }
    setEditing(false)
  }, [draft, content, filePath, onChanged, versioned, overwrite])

  /** 关闭：编辑态先保存草稿再关 */
  const close = useCallback((): void => {
    if (editing) {
      void saveAndExit().then(() => onClose())
    } else {
      onClose()
    }
  }, [editing, saveAndExit, onClose])

  // Esc 关闭（编辑态先保存）。keep-alive 下隐藏模块的弹窗不响应 Esc：
  // 祖先 display:none 时 getBoundingClientRect 全为 0，据此判断弹窗是否真正可见
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && overlayRef.current) {
        const rect = overlayRef.current.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) close()
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
      ref={overlayRef}
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          close()
        }
      }}
    >
      <div className={`dialog md-dialog${editing ? ' editing' : ''}${sidePanel ? ' has-side' : ''}`}>
        <div className="dialog-header">
          <div className="dialog-title-wrap">
            <div className="dialog-title-line">
              {onTitleChange ? (
                <input
                  className="field title-input"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  style={{ fontWeight: 500 }}
                />
              ) : (
                <span className="dialog-title" title={title}>
                  {title}
                </span>
              )}
              {titleTag && <span className="dialog-title-tag">{titleTag}</span>}
            </div>
            {subtitle && (
              <span className="dialog-subtitle" title={subtitle}>
                {subtitle}
              </span>
            )}
          </div>
          {!editing && !readOnly && (
            <span className="edit-hint">双击正文编辑</span>
          )}
          {editing ? (
            <>
              {eventToggle && (
                <label className="ver-overwrite" title="大事件：浮生记顶部「大事件」小节置顶聚合">
                  <input
                    type="checkbox"
                    checked={eventToggle.checked}
                    onChange={(e) => eventToggle.onChange(e.target.checked)}
                    style={{ accentColor: 'var(--color-primary)' }}
                  />
                  大事件
                </label>
              )}
              {versioned && (
                <label className="ver-overwrite" title="勾选后保存时序号不变、日期更新为覆盖当日">
                  <input
                    type="checkbox"
                    checked={overwrite}
                    onChange={(e) => setOverwrite(e.target.checked)}
                    style={{ accentColor: 'var(--color-primary)' }}
                  />
                  覆盖当前版本
                </label>
              )}
              <button className="btn btn-primary" onClick={() => void saveAndExit()}>
                完成
              </button>
            </>
          ) : review ? null : (
            <>
              {headerAction && (
                <button className="btn btn-ghost" onClick={headerAction.onClick} title={headerAction.label}>
                  {headerAction.icon && <span className="material-symbols-outlined">{headerAction.icon}</span>}
                  {headerAction.label}
                </button>
              )}
              <button
                className="btn btn-ghost close-btn"
                onClick={close}
                title="关闭"
              >
                关闭
              </button>
            </>
          )}
        </div>
        {/* 版本切换条 + 让 AI 追问（致知己）：一次呈现一个版本，点击切换 */}
        {versioned && (
          <div className="dialog-versionbar">
            {versioned.versions.map((v) => (
              <button
                key={v.id}
                className={`ver-chip${v.id === versioned.currentId ? ' current' : ''}`}
                onClick={() => v.id !== versioned.currentId && versioned.onSelect(v.id)}
                disabled={editing && v.id !== versioned.currentId}
                title={
                  editing && v.id !== versioned.currentId
                    ? '编辑态下不可切换（先完成编辑）'
                    : `切换到 ${v.label}`
                }
              >
                {v.label}
              </button>
            ))}
            <button
              className="btn btn-ghost ver-ask"
              onClick={() => !editing && versioned.onAskAi(content)}
              disabled={editing || loading}
              title="携带当前版本答案，让 AI 在边栏追问检验"
            >
              <span className="material-symbols-outlined">contact_support</span>
              让 AI 追问
            </button>
          </div>
        )}
        {/* 正文区 + 右侧内嵌栏（优化建议区第13轮）：sidePanel 存在时双栏并排，交互不出弹窗 */}
        <div className="dialog-split">
          <div className="dialog-body" onDoubleClick={() => !editing && !readOnly && startEditing()}>
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
          {sidePanel && <aside className="dialog-side">{sidePanel}</aside>}
        </div>
        {/* 生成审核三选（优化建议区）：加入=关闭并保留，丢弃/直接删除由调用方确认后执行 */}
        {review && !editing && (
          <div className="dialog-footer">
            <button className="btn btn-danger-deep" onClick={review.onDelete}>
              直接删除
            </button>
            <button className="btn btn-danger" onClick={review.onDiscard}>
              丢弃
            </button>
            <button className="btn btn-primary" onClick={close}>
              加入
            </button>
          </div>
        )}
        {/* 待学习操作条（260910 万象库待学习区）：学会了才进板块；learned 态只留切换钮。
            关闭（头部/遮罩/Esc）= 留在待学习区，不强制三选一。 */}
        {learnBar && !editing && (
          <div className="dialog-footer">
            {learnBar.onDelete && (
              <button className="btn btn-danger-deep" onClick={learnBar.onDelete}>
                直接删除
              </button>
            )}
            {learnBar.onDiscard && (
              <button className="btn btn-danger" onClick={learnBar.onDiscard}>
                丢弃
              </button>
            )}
            {learnBar.learned ? (
              <button className="btn" onClick={learnBar.onToggle} title="点击移回待学习区">
                <span className="material-symbols-outlined">task_alt</span>
                已学会
              </button>
            ) : (
              <button className="btn btn-primary" onClick={learnBar.onToggle} title="学会了才加入板块">
                学会了
              </button>
            )}
          </div>
        )}
        {/* 学习库操作条（260911 学习库）：学会了进 1/3/7/15 天复习序列；到期卡记住了升档/忘记了重置；done 态只读 */}
        {studyBar && !editing && (
          <div className="dialog-footer">
            {studyBar.mode === 'new' && (
              <button className="btn btn-primary" onClick={studyBar.onLearn} title="学会后进入 1/3/7/15 天间隔复习">
                学会了
              </button>
            )}
            {studyBar.mode === 'review' && (
              <>
                <button className="btn btn-danger" onClick={studyBar.onForget} title="重置回第 1 档，明天再来">
                  忘记了
                </button>
                <button className="btn btn-primary" onClick={studyBar.onRemember} title="升一档，复习间隔拉长">
                  记住了
                </button>
              </>
            )}
            {studyBar.mode === 'done' && (
              <span className="module-sub" style={{ padding: '6px 0' }}>{studyBar.statusText ?? ''}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )

  function startEditing(): void {
    setDraft(content)
    setOverwrite(false)
    setEditing(true)
  }
}
