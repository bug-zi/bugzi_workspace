// 科普文章阅读视图（260927 长文阅读视图化，详情逻辑自 SciencePanel 弹窗整体平移）：
// 解读版｜精讲｜原文三视图 + 划词高光/取消高光/问 AI + wiki:// 词条链接 + 关联与相关折叠 chips。
// 默认只读 + 顶栏编辑钮；生成中按「任务类型+refId」精确匹配、可围观逐部分落盘的半成品（5s 轮询）；
// 原文视图读全文缓存、只读无划词。高度贴底自适应（useFillHeight，页签容器内嵌场景通用）。
import { useCallback, useEffect, useRef, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import KnowledgeLinksDialog, { type RelatedLink } from '../../components/KnowledgeLinksDialog'
import MdView from '../../components/MdView'
import { useToast } from '../../components/Toast'
import { openRelated, relatedIcon } from '../../services/relatedNav'
import { useReaderZoom } from '../../hooks/useReaderZoom'
import { useSelectionBubble } from '../../hooks/useSelectionBubble'
import { useFillHeight } from '../../hooks/useFillHeight'
import type {
  AgentStatusSnapshot,
  InterpretationRow,
  ScienceArticleRow,
  ScienceHighlightRow,
  WikiSection
} from '../../renderer/api'

interface ScienceDetail {
  article: ScienceArticleRow
  interpretations: InterpretationRow[]
  highlights: ScienceHighlightRow[]
  related: RelatedLink[]
  /** 该文章在队/在跑任务类型（含排队未派发项，260928） */
  active: string[]
}

/** 解读版产物（按语言自动分流：en=translation 全文解读 / zh=light 轻加工） */
function autoKindOf(article: ScienceArticleRow): 'translation' | 'light' {
  return article.language === 'en' ? 'translation' : 'light'
}

export default function ScienceReader(props: {
  articleId: number
  onBack: () => void
  /** 产物/删除等变化后刷新列表 */
  onChanged: () => void
  /** 划词问 AI（模块默认频道） */
  onOpenAi: (prefill?: string) => void
  /** 展开右栏（追问后跟随） */
  bumpAi: () => void
  /** 打开词条弹窗（词条命中 / 建词条成功后） */
  onOpenEntry: (entryId: number) => void
  /** 建词条（走万象手动生成链路；成功返回 entryId，冲突返回 null） */
  onCreateEntry: (term: string, sectionId: number | null) => Promise<number | null>
}) {
  const { toast } = useToast()
  const [detail, setDetail] = useState<ScienceDetail | null>(null)
  const [mdVersion, setMdVersion] = useState(0)
  /** 解读版 / 精讲 / 原文（原文全文 App 内可读 + 生成中可看半成品） */
  const [view, setView] = useState<'auto' | 'lecture' | 'source'>('auto')
  const [sourceMd, setSourceMd] = useState<string | null>(null)
  const [mdText, setMdText] = useState('')
  const [runningTasks, setRunningTasks] = useState<{ type: string; refId: number | null; progress: string | null }[]>([])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [forceKind, setForceKind] = useState<'translate' | 'light' | 'lecture' | null>(null)
  const [linksOpen, setLinksOpen] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  // 关联词条/相关内容 chips 折叠（260923 反馈：过多挤占正文，默认收起）
  const [assocOpen, setAssocOpen] = useState(false)
  const [createTarget, setCreateTarget] = useState<string | null>(null)
  const [createSection, setCreateSection] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [sections, setSections] = useState<WikiSection[]>([])
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const { scrollRef, zoom, zoomBarVisible, resetZoom } = useReaderZoom()
  const { ref: rootRef, height: rootHeight } = useFillHeight()

  const load = useCallback(async (): Promise<void> => {
    try {
      const d = await window.api.science.detail(props.articleId)
      setDetail(d)
      setMdVersion((v) => v + 1)
    } catch (e) {
      toast(`打开文章失败：${(e as Error).message}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.articleId])

  useEffect(() => {
    void load()
    void window.api.wiki.sections().then(setSections)
  }, [load])

  const interpOf = (kind: 'translation' | 'light' | 'lecture'): InterpretationRow | undefined =>
    detail?.interpretations.find((i) => i.kind === kind && i.status === 'done')

  const runningOf = (taskType: string): { progress: string | null } | null =>
    detail ? (runningTasks.find((t) => t.type === taskType && t.refId === detail.article.id) ?? null) : null
  // 忙判定（260928）：在飞 + 排队未派发都算忙（runningTasks 只含在飞项，排队段此前无提示）
  const busyOf = (taskType: string): { progress: string | null } | null =>
    runningOf(taskType) ?? (detail?.active.includes(taskType) ? { progress: null } : null)
  const autoKind = detail ? autoKindOf(detail.article) : 'light'
  const autoRow = detail ? interpOf(autoKind) : undefined
  const lectureRow = detail ? interpOf('lecture') : undefined
  const autoBusy = busyOf(autoKind === 'translation' ? 'science_translate' : 'science_light')
  const autoRunning = runningOf(autoKind === 'translation' ? 'science_translate' : 'science_light')
  const lectureBusy = busyOf('science_lecture')
  const busyHere = !!autoBusy || !!lectureBusy
  const fetching = detail ? detail.article.status !== 'ready' && detail.active.includes('science_fetch') : false
  const currentRow = view === 'source' ? undefined : view === 'lecture' ? lectureRow : autoRow

  // 生成中实时围观：done 台账未落也按约定路径读半成品 md（产物逐部分落盘，读到的永远是已完成部分）。
  // 仅在飞任务读半成品路径——排队任务文件尚未产生，走「排队生成中」占位
  const autoPath =
    detail
      ? autoRow?.md_path ??
        (autoRunning ? `md/interpretations/sa-${detail.article.id}-${autoKind === 'translation' ? 'translate' : 'light'}.md` : undefined)
      : undefined
  const lecturePath = detail
    ? lectureRow?.md_path ?? (runningOf('science_lecture') ? `md/interpretations/sa-${detail.article.id}-lecture.md` : undefined)
    : undefined
  const readingContent = view === 'lecture' ? lecturePath : autoPath

  // 生成中每 5s 刷新详情与 md（逐部分落盘实时可见；任务终态事件本身也会触发即时刷新）
  useEffect(() => {
    if (!busyHere) return
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [busyHere, load])

  // 队列事件：本文相关任务（入队/终态都刷，260928 排队段也要点亮生成中）→ 即时刷新详情
  useEffect(() => {
    const off = window.api.agent.onAgentStatus((s: AgentStatusSnapshot) => {
      setRunningTasks(s.runningTasks ?? [])
      const ev = s.lastEvent
      if (!ev) return
      if (ev.type === 'science_fetch' || ev.type === 'science_translate' || ev.type === 'science_light' || ev.type === 'science_lecture') {
        void load()
      }
    })
    return off
  }, [load])

  // 原文视图：读全文缓存转纯文本 md（只读，无高光/内链）
  useEffect(() => {
    if (view !== 'source' || !detail) return
    let cancelled = false
    void window.api.science.fulltext(detail.article.id).then((raw) => {
      if (cancelled) return
      setSourceMd(
        raw
          ? `# 原文：${detail.article.title}\n\n${raw
              .split(/\n+/)
              .map((s) => s.trim())
              .filter(Boolean)
              .join('\n\n')}`
          : '（原文缓存缺失，可「重试抓取」后再试）'
      )
    })
    return () => {
      cancelled = true
    }
    // status 变化也要重读（260928：抓取完成 ready 后原文视图自动出内容）
  }, [view, detail?.article.id, detail?.article.status])

  // 内容装载：原文用 sourceMd；解读产物读 md 文件（mdVersion 变化重读，替代原 MdDialog key 重挂）
  useEffect(() => {
    setEditing(false)
    if (view === 'source') {
      setMdText(sourceMd ?? '')
      return
    }
    if (!readingContent) {
      setMdText('')
      return
    }
    let cancelled = false
    void window.api.md
      .read(readingContent)
      .then((md) => {
        if (!cancelled) setMdText(md)
      })
      .catch(() => {
        if (!cancelled) setMdText('')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, detail?.article.id, readingContent, mdVersion, sourceMd])

  /** 生成/重生成；done 且未 force 先弹确认 */
  const generate = (kind: 'translate' | 'light' | 'lecture', force = false): void => {
    if (!detail) return
    const dbKind = kind === 'translate' ? 'translation' : kind === 'light' ? 'light' : 'lecture'
    const existing = detail.interpretations.find((i) => i.kind === dbKind && i.status === 'done')
    if (existing && !force) {
      setForceKind(kind)
      return
    }
    void window.api.science
      .interpret(detail.article.id, kind, force)
      .then(() => {
        toast('任务已入队，逐部分生成中')
        setForceKind(null)
        setMdVersion((v) => v + 1)
      })
      .catch((e: unknown) => {
        const msg = (e as Error).message
        if (msg.includes('INTERPRET_EXISTS')) {
          setForceKind(kind)
          return
        }
        toast(`触发失败：${msg}`)
      })
  }

  // ---------- 划词高光 / 问 AI ----------

  const onHighlight = async (text: string): Promise<void> => {
    if (!detail || !currentRow?.md_path) return
    const md = await window.api.md.read(currentRow.md_path)
    const wrapped = `==${text}==`
    if (!md.includes(wrapped) && md.includes(text)) {
      await window.api.md.write(currentRow.md_path, md.replace(text, wrapped))
    }
    await window.api.science.highlightAdd(detail.article.id, text)
    void load()
    toast('已加入高光')
  }

  const onUnhighlight = async (text: string): Promise<void> => {
    if (!detail || !currentRow?.md_path) return
    const md = await window.api.md.read(currentRow.md_path)
    const wrapped = `==${text}==`
    if (md.includes(wrapped)) {
      await window.api.md.write(currentRow.md_path, md.replaceAll(wrapped, text))
    }
    await window.api.science.highlightRemove(detail.article.id, text)
    void load()
    toast('已取消高光')
  }

  const onAskAi = (text: string): void => {
    props.onOpenAi(`关于科普文章《${detail?.article.title ?? ''}》：「${text}」\n\n请帮我解释。`)
  }

  // ---------- wiki:// 概念链接（MdView 只拦外链，wiki:// 在此拦截） ----------

  const onWikiLink = (term: string): void => {
    if (!detail) return
    const c = detail.article.concepts.find((x) => x.term === term)
    if (c?.entry_id != null) {
      props.onOpenEntry(c.entry_id)
      return
    }
    // 未命中词条 → 建词条流（选板块后走万象生成链路）
    setCreateSection(sections[0]?.id ?? null)
    setCreateTarget(term)
  }

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onClick = (e: MouseEvent): void => {
      const a = (e.target as HTMLElement).closest('a')
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (href.startsWith('wiki://')) {
        e.preventDefault()
        onWikiLink(href.slice('wiki://'.length))
      }
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mdText, editing])

  const confirmCreate = async (): Promise<void> => {
    if (!detail || !createTarget || creating) return
    setCreating(true)
    try {
      const entryId = await props.onCreateEntry(createTarget, createSection)
      if (entryId != null) {
        await window.api.science.linkManual(detail.article.id, createTarget, entryId)
        toast(`词条「${createTarget}」已生成并建立关联`)
        void load()
      }
    } finally {
      setCreating(false)
      setCreateTarget(null)
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (!detail || !readingContent) return
    await window.api.md.write(readingContent, draft)
    setEditing(false)
    setMdVersion((v) => v + 1)
    toast('已保存')
  }

  const removeArticle = async (): Promise<void> => {
    if (!detail) return
    await window.api.science.delete(detail.article.id)
    toast('科普文章已彻底删除（含解读产物与高光）')
    props.onChanged()
    props.onBack()
  }

  // 划词气泡：编辑态/原文/无产物不出（高光写盘以 currentRow.md_path 为准）
  useSelectionBubble(
    !editing && view !== 'source' && !!currentRow && !!mdText,
    bodyRef,
    detail
      ? {
          onHighlight: (t) => void onHighlight(t),
          onUnhighlight: (t) => void onUnhighlight(t),
          onAskAi
        }
      : undefined
  )

  const article = detail?.article
  const langLabel = article?.language === 'en' ? '英文' : '中文'
  const metaMd = article
    ? `# ${article.title}\n\n> ${langLabel}${article.domain_name ? ' · ' + article.domain_name : ''}${article.date ? ' · ' + article.date : article.year != null ? ' · ' + article.year : ''} · ${article.source}\n\n${article.summary || '（暂无摘要）'}\n\n${
        fetching
          ? '> 全文抓取中…完成后自动开始解读；失败会降级为「仅元信息」，可点顶栏「重试抓取」。'
          : article.status === 'meta_only'
            ? '> ⚠ 全文尚未抓取到：可点顶栏「重试抓取」，成功后自动开始解读。'
            : '> 全文已就绪，点页签行「生成解读版」开始解读。'
      }\n`
    : ''

  return (
    <div className="module-reader-page" ref={rootRef} style={rootHeight != null ? { height: rootHeight } : undefined}>
      <div className="module-reader-bar">
        <button
          className="btn"
          onClick={() => {
            props.onChanged()
            props.onBack()
          }}
        >
          <span className="material-symbols-outlined">arrow_back</span>返回列表
        </button>
        <div className="reader-title">{article?.title ?? '…'}</div>
        {view !== 'source' && readingContent && (
          <button
            className="btn"
            onClick={() => {
              if (editing) void saveEdit()
              else {
                setDraft(mdText)
                setEditing(true)
              }
            }}
          >
            <span className="material-symbols-outlined">{editing ? 'save' : 'edit'}</span>
            {editing ? '保存' : '编辑'}
          </button>
        )}
        <button
          className="btn btn-primary"
          onClick={() => {
            if (!detail) return
            void window.api.agent.askLiterature('science', detail.article.id)
            props.bumpAi()
          }}
          title="注入该文章解读/全文上下文，在右栏「文献·追问」场景继续提问"
        >
          <span className="material-symbols-outlined">forum</span>
          追问
        </button>
        {article?.status === 'ready' ? (
          <button
            className="btn"
            onClick={() => {
              if (!detail) return
              void window.api.shell.openExternal(detail.article.url)
            }}
            title={`网页原链：${article.url}`}
          >
            <span className="material-symbols-outlined">open_in_new</span>
            网页原链
          </button>
        ) : (
          <button
            className="btn"
            disabled={fetching}
            onClick={() => {
              if (!detail) return
              void window.api.science
                .retryFetch(detail.article.id)
                .then(() => toast('重试抓取中，完成后自动解读'))
                .catch((e) => toast(`重试失败：${(e as Error).message}`))
            }}
            title={fetching ? '抓取任务进行中，请稍候' : '重新抓取全文；成功后自动入队解读'}
          >
            <span className="material-symbols-outlined">cloud_download</span>
            重试抓取
          </button>
        )}
        <button className="btn" onClick={() => setLinksOpen(true)} title="管理本文的手动/语义关联">
          <span className="material-symbols-outlined">hub</span>
          关联知识
        </button>
        <button className="btn btn-danger" onClick={() => setDelOpen(true)}>
          <span className="material-symbols-outlined">delete</span>
          删除
        </button>
      </div>

      {/* 视图页签：解读版｜精讲｜原文 + 生成动作 + 关联折叠 */}
      <div className="recycle-tabs domain-tabs" style={{ flexShrink: 0 }}>
        <button
          className={`recycle-tab${view === 'auto' ? ' active' : ''}`}
          title={autoBusy ? `解读生成中${autoBusy?.progress ? ` · ${autoBusy.progress}` : ''}` : undefined}
          onClick={() => setView('auto')}
        >
          解读版{autoBusy ? ' …' : ''}
        </button>
        <button
          className={`recycle-tab${view === 'lecture' ? ' active' : ''}`}
          title={lectureBusy ? `精讲生成中${lectureBusy?.progress ? ` · ${lectureBusy.progress}` : ''}` : undefined}
          onClick={() => setView('lecture')}
        >
          精讲{lectureBusy ? ' …' : ''}
        </button>
        <button
          className={`recycle-tab${view === 'source' ? ' active' : ''}`}
          onClick={() => setView('source')}
          title={
            article?.status === 'ready'
              ? '在 App 内阅读原文全文'
              : fetching
                ? '全文抓取中，完成后可读'
                : '全文未抓取到，可「重试抓取」'
          }
        >
          原文
        </button>
        {view === 'auto' && !autoRow && !autoBusy && (
          <button className="btn btn-primary" onClick={() => generate(autoKind === 'translation' ? 'translate' : 'light')}>
            <span className="material-symbols-outlined">auto_awesome</span>
            生成解读版
          </button>
        )}
        {view === 'lecture' && !lectureRow && !lectureBusy && (
          <button className="btn btn-primary" onClick={() => generate('lecture')}>
            <span className="material-symbols-outlined">auto_awesome</span>
            生成精讲
          </button>
        )}
        {article && article.concepts.length + (detail?.related.length ?? 0) > 0 && (
          <button className="btn" onClick={() => setAssocOpen((v) => !v)} title="展开/收起关联词条与相关内容">
            <span className="material-symbols-outlined">{assocOpen ? 'expand_less' : 'expand_more'}</span>
            {assocOpen ? '收起关联' : `关联与相关（${article.concepts.length + (detail?.related.length ?? 0)}）`}
          </button>
        )}
      </div>

      {/* 关联词条/相关内容 chips（默认收起） */}
      {assocOpen && detail && detail.related.length > 0 && (
        <div className="sci-footer-row sci-concepts" style={{ flexShrink: 0 }}>
          <span className="sci-concepts-label">相关内容</span>
          {detail.related.map((r) => (
            <button
              key={r.link_id}
              className="sci-chip"
              title={r.origin === 'manual' ? '手动关联，点击打开' : `语义相似 ${Math.round(r.score * 100)}%，点击打开`}
              onClick={() => openRelated(r)}
            >
              <span className="material-symbols-outlined sci-chip-icon">{relatedIcon(r.peer_type)}</span>
              {r.title}
            </button>
          ))}
        </div>
      )}
      {assocOpen && article && article.concepts.length > 0 && (
        <div className="sci-footer-row sci-concepts" style={{ flexShrink: 0 }}>
          <span className="sci-concepts-label">关联词条</span>
          {article.concepts.map((c) => (
            <button
              key={c.term}
              className={`sci-chip${c.entry_id == null ? ' missing' : ''}`}
              title={c.entry_id == null ? '暂无词条，点击可创建' : '打开词条'}
              onClick={() => {
                if (c.entry_id != null) props.onOpenEntry(c.entry_id)
                else {
                  setCreateSection(sections[0]?.id ?? null)
                  setCreateTarget(c.term)
                }
              }}
            >
              {c.term}
              {c.entry_id == null && <span className="sci-chip-add">＋建</span>}
            </button>
          ))}
        </div>
      )}

      <div className="module-reader-scroll" ref={scrollRef}>
        <article className="module-reader-article" style={{ fontSize: `${zoom}%` }}>
          {editing ? (
            <div>
              <textarea
                className="field"
                style={{ width: '100%', minHeight: '55vh', fontFamily: 'monospace', lineHeight: 1.7 }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" onClick={() => void saveEdit()}>
                  <span className="material-symbols-outlined">save</span>
                  保存
                </button>
                <button className="btn" onClick={() => setEditing(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : view === 'source' ? (
            fetching ? (
              <div className="empty-state">
                <span className="material-symbols-outlined spin">progress_activity</span>
                全文抓取中…（抓取任务在队列中进行，完成后自动就绪；失败会降级为「仅元信息」）
              </div>
            ) : mdText ? (
              <MdView md={mdText} />
            ) : (
              <div className="empty-state">
                <span className="material-symbols-outlined spin">progress_activity</span>
                加载中…
              </div>
            )
          ) : mdText ? (
            <MdView md={mdText} bodyRef={bodyRef} />
          ) : busyHere ? (
            <div className="empty-state">
              <span className="material-symbols-outlined spin">progress_activity</span>
              已入队，排队生成中——轮到后自动开始，完成后自动更新
            </div>
          ) : metaMd ? (
            <MdView md={metaMd} />
          ) : (
            <div className="empty-state">
              <span className="material-symbols-outlined spin">progress_activity</span>
              加载中…
            </div>
          )}
        </article>
      </div>

      {zoomBarVisible && (
        <button className="module-reader-zoom" title="点击复位 100%" onClick={resetZoom}>
          <span className="material-symbols-outlined">text_increase</span>
          {zoom}%
        </button>
      )}

      <ConfirmDialog
        open={forceKind !== null}
        title="重新生成解读"
        danger
        confirmText="重新生成"
        onConfirm={() => forceKind && generate(forceKind, true)}
        onCancel={() => setForceKind(null)}
      >
        已有生成产物，重新生成将覆盖现有内容（逐部分生成会从头重写）。确定继续？
      </ConfirmDialog>

      <ConfirmDialog
        open={delOpen}
        title="删除科普文章"
        danger
        confirmText="彻底删除"
        onConfirm={() => void removeArticle()}
        onCancel={() => setDelOpen(false)}
      >
        确认彻底删除《{article?.title}》？其解读产物、划词高光、关联词条链接与全文缓存将一并删除，不可恢复。
      </ConfirmDialog>

      <KnowledgeLinksDialog
        open={linksOpen && detail != null}
        srcType="science_article"
        srcId={detail?.article.id ?? 0}
        title={detail?.article.title ?? ''}
        onClose={() => setLinksOpen(false)}
      />

      {/* 建词条（选板块 → 走万象生成链路） */}
      {createTarget && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setCreateTarget(null)}>
          <div className="dialog" style={{ width: 400 }}>
            <div className="dialog-header">创建词条「{createTarget}」</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="module-sub">万象库暂无该词条，选择板块后由 AI 生成知识卡片（先进待学习区），并自动建立与本文的关联。</div>
              <select
                className="field"
                value={createSection ?? ''}
                onChange={(e) => setCreateSection(Number(e.target.value))}
              >
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setCreateTarget(null)}>
                取消
              </button>
              <button className="btn btn-primary" disabled={createSection == null || creating} onClick={() => void confirmCreate()}>
                {creating ? '生成中…' : '生成并关联'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
