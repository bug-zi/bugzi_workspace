// 写作台文章页（2026-09-08 页面化 design）：模块内页面替代弹窗，打开即编辑 + 800ms 自动保存 + Copilot 协笔
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WenbiArticleRecord } from '../../shared/types'
import { renderMd } from '../../components/MdView'
import { useToast } from '../../components/Toast'
import './ArticlePage.css'

type CopilotAction = 'draft' | 'continue' | 'polish' | 'rewrite'

const ZONE_LABELS: Record<WenbiArticleRecord['zone'], string> = {
  idea: '构思区',
  writing: '写作区',
  done: '完稿区',
  published: '已发布区'
}

const ACTION_LABELS: Record<CopilotAction, string> = {
  draft: 'AI 起稿',
  continue: '续写',
  polish: '润色建议',
  rewrite: '改写建议'
}

export interface ArticlePageProps {
  /** 当前文章（父级 openDoc；key=id 挂载，切换文章即重挂） */
  item: WenbiArticleRecord
  /** 模块是否激活（keep-alive 隐藏时 flush 未保存草稿） */
  active: boolean
  /** 返回看板（页面已 flush，调用方负责刷新列表并清 openDoc） */
  onBack: () => void
  /** 标题改后同步父级 openDoc（看板列表在返回时统一刷新） */
  onRenamed: (title: string) => void
  /** LLM 未配置 → 去配置弹窗（父级持有 GoConfigDialog） */
  onGoConfig: () => void
}

export default function ArticlePage(props: ArticlePageProps) {
  const { item, active, onBack, onRenamed, onGoConfig } = props
  const { toast } = useToast()
  const [title, setTitle] = useState(item.title)
  const [titleDraft, setTitleDraft] = useState(item.title)
  // content=已落盘内容，draft=编辑草稿；两者差值即脏
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [loading, setLoading] = useState(true)
  const [readFail, setReadFail] = useState(false)
  // Copilot（MdDialog 移植）：textarea 选区跟踪 + 生成中状态 + 建议卡
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const selRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 })
  const [copilotBusy, setCopilotBusy] = useState<CopilotAction | null>(null)
  // 全局取消（260908）：进行中任务的 jobId，工具栏挂取消键走 ai.cancel 统一通道
  const [copilotJob, setCopilotJob] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<{
    action: CopilotAction
    text: string
    selStart: number
    selEnd: number
  } | null>(null)
  const trackSel = (): void => {
    const ta = taRef.current
    if (ta) selRef.current = { start: ta.selectionStart, end: ta.selectionEnd }
  }
  const hasSelection = (): boolean => selRef.current.end > selRef.current.start
  const bodyRef = useRef<HTMLDivElement>(null)
  // 切预览/编辑保持滚动位置：两态滚动容器不同（编辑=textarea 内部滚动、预览=article-body 滚动），
  // 切换瞬间按比例捕获，新态渲染完成后等比恢复（两态内容高度不等，像素不可直映，比例近似）
  const bodyScrollRef = useRef<HTMLDivElement>(null)
  const scrollRatioRef = useRef<number | null>(null)
  const activeScroller = (): HTMLTextAreaElement | HTMLDivElement | null =>
    mode === 'edit' ? taRef.current : bodyScrollRef.current
  const captureScroll = (): void => {
    const el = activeScroller()
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    scrollRatioRef.current = max > 0 ? el.scrollTop / max : null
  }

  // 进入页面加载正文；失败页内占位（design §5）
  useEffect(() => {
    let alive = true
    setLoading(true)
    setReadFail(false)
    window.api.md
      .read(item.md_path)
      .then((c) => {
        if (!alive) return
        setContent(c)
        setDraft(c)
      })
      .catch(() => {
        if (alive) setReadFail(true)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [item.md_path])

  /** 落盘当前草稿：800ms 防抖窗口外的兜底（切预览/返回/失活/卸载），成功后对齐 content 重置脏标记 */
  const flush = useCallback(async (): Promise<void> => {
    if (draft === content) return
    try {
      await window.api.md.write(item.md_path, draft)
      await window.api.wenbi.articleTouch(item.id)
      setContent(draft)
    } catch {
      toast('自动保存失败，稍后重试')
    }
  }, [draft, content, item.id, item.md_path, toast])

  // 最新 flush 存 ref：卸载 cleanup / 失活 effect 里调用时拿到最新闭包
  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  }, [flush])

  // 自动保存（草稿本先例）：停止输入 800ms 且有改动 → 静默落盘 + touch 浮顶
  useEffect(() => {
    if (mode !== 'edit') return
    const timer = setTimeout(() => {
      if (draft === content) return
      void flushRef.current()
    }, 800)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, mode])

  // 模块失活（keep-alive 隐藏：切浮生记/切其他模块）时落袋
  useEffect(() => {
    if (!active) void flushRef.current()
  }, [active])

  // 卸载兜底（返回看板后的二次 flush 是 no-op；防直接切换文章等路径漏保存）
  useEffect(() => () => void flushRef.current(), [])

  // 进入编辑态聚焦（进入页面默认编辑态并聚焦，design §1；loading 结束 textarea 才挂载，需一并依赖）
  useEffect(() => {
    if (mode === 'edit' && !loading) taRef.current?.focus()
  }, [mode, loading])

  /** 预览 = 已保存内容的所见：先 flush 再切换，保证两态内容一致；
   *  切换前捕获滚动比例（textarea 在 flush 重渲染后仍挂载且 scrollTop 不丢，放 await 后更准） */
  const toPreview = async (): Promise<void> => {
    if (mode === 'preview' || loading || readFail) return
    await flushRef.current()
    captureScroll()
    setMode('preview')
  }
  const toEdit = (): void => {
    if (mode === 'edit') return
    captureScroll()
    setMode('edit')
  }

  /** 返回看板：flush 后交回调（父级刷新列表 + 清 openDoc，design §1） */
  const back = async (): Promise<void> => {
    await flushRef.current()
    onBack()
  }

  /** 标题行内编辑：回车/失焦提交 rename（不动 updated_at），Esc 还原 */
  const commitTitle = (): void => {
    const t = titleDraft.trim()
    if (!t || t === title) return
    window.api.wenbi
      .articleRename(item.id, t)
      .then(() => {
        setTitle(t)
        onRenamed(t)
      })
      .catch((e) => toast(`重命名失败：${(e as Error).message}`))
  }

  const runCopilot = async (action: CopilotAction): Promise<void> => {
    if (copilotBusy) return
    const sel = draft.slice(selRef.current.start, selRef.current.end)
    if ((action === 'polish' || action === 'rewrite') && !sel.trim()) return
    const jobId = crypto.randomUUID()
    setCopilotBusy(action)
    setCopilotJob(jobId)
    try {
      // 主进程从落盘正文取上下文：先落袋保证 AI 看到最新内容（含防抖窗口内的输入）
      await flushRef.current()
      const text = await window.api.wenbi.copilot(jobId, item.id, action, sel || undefined)
      setSuggestion({ action, text, selStart: selRef.current.start, selEnd: selRef.current.end })
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('已取消')) toast('已取消')
      else if (msg.includes('LLM_NOT_CONFIGURED')) onGoConfig()
      else toast(`协笔失败：${msg}`)
    } finally {
      setCopilotBusy(null)
      setCopilotJob(null)
    }
  }

  /** 采纳：润色/改写替换发起时选区；起稿/续写插入发起时光标处——只改草稿，落盘仍走自动保存 */
  const adoptSuggestion = (): void => {
    if (!suggestion) return
    if (suggestion.action === 'polish' || suggestion.action === 'rewrite') {
      setDraft(draft.slice(0, suggestion.selStart) + suggestion.text + draft.slice(suggestion.selEnd))
    } else {
      const pos = suggestion.selEnd
      setDraft(draft.slice(0, pos) + suggestion.text + draft.slice(pos))
    }
    setSuggestion(null)
  }

  // 预览渲染（renderMd 管线与 md 弹窗同源，==高光== 后处理一致）+ 外链拦截走系统浏览器
  useEffect(() => {
    if (mode !== 'preview' || loading || !bodyRef.current) return
    bodyRef.current.innerHTML = renderMd(content)
    bodyRef.current.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href') ?? ''
      if (/^https?:/.test(href)) {
        a.addEventListener('click', (e) => {
          e.preventDefault()
          void window.api.shell.openExternal(href)
        })
      }
    })
  }, [mode, content, loading])

  // 模式切换后等比恢复滚动位置：rAF 等新态渲染（预览含 innerHTML 注入）完成再量取容器高度
  useEffect(() => {
    const ratio = scrollRatioRef.current
    if (ratio == null) return
    scrollRatioRef.current = null
    const raf = requestAnimationFrame(() => {
      const el = activeScroller()
      if (!el) return
      const max = el.scrollHeight - el.clientHeight
      if (max > 0) el.scrollTop = ratio * max
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // 字数统计（去空白计，编辑态实时）
  const wordCount = draft.replace(/\s/g, '').length

  return (
    <div className={`article-page${mode === 'edit' ? ' editing' : ''}`}>
      <div className="article-toolbar">
        <button className="btn btn-ghost" onClick={() => void back()} title="返回看板（未保存内容自动落盘）">
          <span className="material-symbols-outlined">arrow_back</span>
          看板
        </button>
        <input
          className="article-title-input"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            else if (e.key === 'Escape') {
              setTitleDraft(title)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          title={title}
          spellCheck={false}
        />
        <span className="article-zone-tag" title="当前所在区（在看板上可跨区移动）">
          {ZONE_LABELS[item.zone]}
        </span>
        <div className="article-mode-toggle">
          <button className={mode === 'edit' ? 'active' : ''} onClick={toEdit} title="编辑（打开即写，自动保存）">
            编辑
          </button>
          <button
            className={mode === 'preview' ? 'active' : ''}
            onClick={() => void toPreview()}
            title="预览（先保存再切换）"
          >
            预览
          </button>
        </div>
        {mode === 'edit' && (
          <div className="article-copilot-bar">
            <button
              className="btn btn-ghost"
              disabled={copilotBusy != null}
              onClick={() => void runCopilot('draft')}
              title="基于标题生成大纲或开头"
            >
              <span className="material-symbols-outlined">auto_awesome</span>
              起稿
            </button>
            <button
              className="btn btn-ghost"
              disabled={copilotBusy != null}
              onClick={() => void runCopilot('continue')}
              title="从光标处接着往下写"
            >
              <span className="material-symbols-outlined">arrow_forward</span>
              续写
            </button>
            <button
              className="btn btn-ghost"
              disabled={copilotBusy != null || !hasSelection()}
              onClick={() => void runCopilot('polish')}
              title={hasSelection() ? '润色选中段落（保持原意）' : '先选中要润色的段落'}
            >
              <span className="material-symbols-outlined">brush</span>
              润色
            </button>
            <button
              className="btn btn-ghost"
              disabled={copilotBusy != null || !hasSelection()}
              onClick={() => void runCopilot('rewrite')}
              title={hasSelection() ? '换一种写法重写选中段落' : '先选中要改写的段落'}
            >
              <span className="material-symbols-outlined">refresh</span>
              改写
            </button>
            {copilotBusy && (
              <>
                <span className="module-sub">协笔生成中…</span>
                <button
                  className="btn"
                  onClick={() => void window.api.ai.cancel(copilotJob ?? '')}
                  title="取消本次协笔"
                >
                  <span className="material-symbols-outlined">stop_circle</span>
                </button>
              </>
            )}
          </div>
        )}
        <span className="article-wordcount">{wordCount} 字</span>
      </div>
      <div className="article-body" ref={bodyScrollRef}>
        {loading ? (
          <div className="article-column article-placeholder">加载中…</div>
        ) : readFail ? (
          <div className="article-column article-placeholder">（读取失败）</div>
        ) : mode === 'edit' ? (
          <div className="article-column">
            <textarea
              className="article-editor"
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onSelect={trackSel}
              onKeyUp={trackSel}
              onClick={trackSel}
              spellCheck={false}
              placeholder="从这里开始写……"
            />
          </div>
        ) : (
          <div className="article-column">
            <div className="md-view article-md" ref={bodyRef} />
          </div>
        )}
      </div>
      {/* Copilot 建议预览卡（MdDialog 移植）：对照 + 采纳/放弃/重新生成，采纳只改草稿不直接落盘 */}
      {suggestion && mode === 'edit' && (
        <div className="article-suggest-card">
          <div className="article-suggest-head">
            <span>{ACTION_LABELS[suggestion.action]}</span>
            <span className="module-sub">采纳后随自动保存落盘</span>
          </div>
          <div className="article-suggest-body">
            {(suggestion.action === 'polish' || suggestion.action === 'rewrite') && (
              <>
                <div className="article-suggest-diff">
                  <div className="module-sub">原文</div>
                  <div className="md-view">{draft.slice(suggestion.selStart, suggestion.selEnd)}</div>
                </div>
                <div className="article-suggest-diff ai">
                  <div className="module-sub">AI 版</div>
                  <div
                    className="md-view"
                    ref={(el) => {
                      if (el) el.innerHTML = renderMd(suggestion.text)
                    }}
                  />
                </div>
              </>
            )}
            {(suggestion.action === 'draft' || suggestion.action === 'continue') && (
              <div
                className="md-view"
                ref={(el) => {
                  if (el) el.innerHTML = renderMd(suggestion.text)
                }}
              />
            )}
          </div>
          <div className="article-suggest-foot">
            <button
              className="btn btn-ghost"
              disabled={copilotBusy != null}
              onClick={() => void runCopilot(suggestion.action)}
            >
              重新生成
            </button>
            <button className="btn" onClick={() => setSuggestion(null)}>
              放弃
            </button>
            <button className="btn btn-primary" onClick={adoptSuggestion}>
              采纳
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
