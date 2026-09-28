// 科普文章阅读视图（260929 抓取三页签阅读：原文｜导读卡｜精读版，默认原文）：
// 原文 = 简体中文全文（zh 由全文缓存生成 md 包装 sa-{id}-source.md 作高光载体；en 显示 translation
// 译文产物，缺译文静默补翻译管道、就绪前先展示英文原文）；划词高光/取消高光/问 AI 作用于原文与解读
// 产物；wiki:// 内链（轻加工退役后不再产生，历史残留仍可点）+ 关联与相关折叠 chips。
// 生成中按「任务类型+refId」精确匹配、可围观逐章落盘的半成品（5s 轮询）。
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

const TABS: {
  view: 'digest' | 'deepread'
  label: string
  task: string
  kind: 'digest' | 'deepread'
  pathOf: (id: number) => string
}[] = [
  {
    view: 'digest',
    label: '导读卡',
    task: 'science_digest',
    kind: 'digest',
    pathOf: (id) => `md/interpretations/sa-${id}-digest.md`
  },
  {
    view: 'deepread',
    label: '精读版',
    task: 'science_deepread',
    kind: 'deepread',
    pathOf: (id) => `md/interpretations/sa-${id}-deepread.md`
  }
]

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
  /** 原文 / 导读卡 / 精读版（默认原文） */
  const [view, setView] = useState<'source' | 'digest' | 'deepread'>('source')
  /** zh 原文 md 包装路径（ensureSource 幂等获取；en 用 translation 产物） */
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [mdText, setMdText] = useState('')
  const [runningTasks, setRunningTasks] = useState<{ type: string; refId: number | null; progress: string | null }[]>([])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [forceKind, setForceKind] = useState<'digest' | 'deepread' | null>(null)
  const [linksOpen, setLinksOpen] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  // 关联词条/相关内容 chips 折叠（260923 反馈：过多挤占正文，默认收起）
  const [assocOpen, setAssocOpen] = useState(false)
  const [createTarget, setCreateTarget] = useState<string | null>(null)
  const [createSection, setCreateSection] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [sections, setSections] = useState<WikiSection[]>([])
  // 旧英文条目缺译文的补翻译只自动触发一次
  const autoTrigRef = useRef(false)
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

  const interpOf = (kind: 'digest' | 'deepread' | 'translation'): InterpretationRow | undefined =>
    detail?.interpretations.find((i) => i.kind === kind && i.status === 'done')

  const runningOf = (taskType: string): { progress: string | null } | null =>
    detail ? (runningTasks.find((t) => t.type === taskType && t.refId === detail.article.id) ?? null) : null
  // 忙判定（260928）：在飞 + 排队未派发都算忙
  const busyOf = (taskType: string): { progress: string | null } | null =>
    runningOf(taskType) ?? (detail?.active.includes(taskType) ? { progress: null } : null)

  const tab = TABS.find((t) => t.view === view)
  const digestRow = detail ? interpOf('digest') : undefined
  const deepreadRow = detail ? interpOf('deepread') : undefined
  const transRow = detail ? interpOf('translation') : undefined
  const digestBusy = busyOf('science_digest')
  const deepreadBusy = busyOf('science_deepread')
  const fetching = detail ? busyOf('science_fetch') : null
  const row = view === 'digest' ? digestRow : deepreadRow
  const busy = view === 'digest' ? digestBusy : deepreadBusy
  const busyHere = view === 'source' ? !!fetching : !!busy
  const currentRow = view === 'source' ? undefined : row

  // 原文 md：en=translation 产物（在飞读半成品路径）；zh=ensureSource 包装 md
  const sourceMdPath =
    detail && detail.article.status === 'ready'
      ? detail.article.language === 'en'
        ? (transRow?.md_path ??
          (runningOf('science_fetch') ? `md/interpretations/sa-${detail.article.id}-translate.md` : undefined))
        : sourcePath
      : undefined
  // 高光落盘目标：原文视图=原文 md；解读视图=产物 md
  const hlPath = view === 'source' ? sourceMdPath : currentRow?.md_path
  const contentPath =
    view === 'source'
      ? sourceMdPath
      : (row?.md_path ?? (busy && runningOf(tab?.task ?? '') ? tab?.pathOf(detail?.article.id ?? 0) : undefined))

  // zh 原文包装 md（划词高光载体，幂等）：就绪后进原文视图时确保存在
  useEffect(() => {
    if (!detail || detail.article.status !== 'ready' || detail.article.language !== 'zh') return
    let cancelled = false
    void window.api.science
      .ensureSource(detail.article.id)
      .then((p) => {
        if (!cancelled) setSourcePath(p)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [detail?.article.id, detail?.article.status, detail?.article.language])

  // 旧英文条目缺译文：静默补一次翻译管道（幂等），就绪前原文视图先展示英文原文
  useEffect(() => {
    if (!detail || detail.article.status !== 'ready' || detail.article.language !== 'en') return
    if (transRow || fetching || autoTrigRef.current) return
    autoTrigRef.current = true
    void window.api.science.retryFetch(detail.article.id).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.article.id, detail?.article.status, detail?.article.language, !!transRow, !!fetching])

  // 生成中每 5s 刷新详情与 md（逐部分落盘实时可见；任务终态事件本身也会触发即时刷新）
  useEffect(() => {
    if (!busyHere) return
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [busyHere, load])

  // 队列事件：本文相关任务（入队/终态都刷）→ 即时刷新详情
  useEffect(() => {
    const off = window.api.agent.onAgentStatus((s: AgentStatusSnapshot) => {
      setRunningTasks(s.runningTasks ?? [])
      const ev = s.lastEvent
      if (!ev) return
      if (ev.type === 'science_fetch' || ev.type === 'science_digest' || ev.type === 'science_deepread') {
        void load()
      }
    })
    return off
  }, [load])

  // 内容装载：原文无 md 时（en 译文在飞 / zh 包装未就绪）读全文缓存转段落展示；有 md 读 md
  useEffect(() => {
    setEditing(false)
    if (!contentPath) {
      if (view === 'source' && detail && detail.article.status === 'ready') {
        let cancelled = false
        void window.api.science.fulltext(detail.article.id).then(({ raw, isMd }) => {
          if (cancelled) return
          setMdText(
            raw
              ? `# 原文：${detail.article.title}\n\n${
                  isMd ? raw.trim() : raw.split(/\n+/).map((s) => s.trim()).filter(Boolean).join('\n\n')
                }`
              : ''
          )
        })
        return () => {
          cancelled = true
        }
      }
      setMdText('')
      return
    }
    let cancelled = false
    void window.api.md
      .read(contentPath)
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
  }, [view, detail?.article.id, detail?.article.status, contentPath, mdVersion, sourcePath])

  /** 生成/重生成；done 且未 force 先弹确认 */
  const generate = (kind: 'digest' | 'deepread', force = false): void => {
    if (!detail) return
    const existing = detail.interpretations.find((i) => i.kind === kind && i.status === 'done')
    if (existing && !force) {
      setForceKind(kind)
      return
    }
    void window.api.science
      .interpret(detail.article.id, kind, force)
      .then(() => {
        toast(kind === 'digest' ? '导读卡生成中，完成后自动更新' : '精读版生成中，逐章进行')
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
    if (!detail || !hlPath) return
    const md = await window.api.md.read(hlPath)
    const wrapped = `==${text}==`
    if (!md.includes(wrapped) && md.includes(text)) {
      await window.api.md.write(hlPath, md.replace(text, wrapped))
    }
    await window.api.science.highlightAdd(detail.article.id, text)
    void load()
    toast('已加入高光')
  }

  const onUnhighlight = async (text: string): Promise<void> => {
    if (!detail || !hlPath) return
    const md = await window.api.md.read(hlPath)
    const wrapped = `==${text}==`
    if (md.includes(wrapped)) {
      await window.api.md.write(hlPath, md.replaceAll(wrapped, text))
    }
    await window.api.science.highlightRemove(detail.article.id, text)
    void load()
    toast('已取消高光')
  }

  const onAskAi = (text: string): void => {
    props.onOpenAi(`关于科普文章《${detail?.article.title ?? ''}》：「${text}」\n\n请帮我解释。`)
  }

  // ---------- wiki:// 概念链接（轻加工退役后不再产生，历史残留仍可点） ----------

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
    if (!detail || !contentPath) return
    await window.api.md.write(contentPath, draft)
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

  // 划词气泡：编辑态/无 md 载体不出（高光写盘以 hlPath 为准；原文页可高光/问 AI）
  useSelectionBubble(
    !editing && !!hlPath && !!mdText,
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
        {view !== 'source' && contentPath && (
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
        <button
          className="btn"
          onClick={() => {
            if (!detail) return
            void window.api.shell.openExternal(detail.article.url)
          }}
          title={`网页原链：${detail?.article.url ?? ''}`}
        >
          <span className="material-symbols-outlined">open_in_new</span>
          网页原链
        </button>
        <button className="btn" onClick={() => setLinksOpen(true)} title="管理本文的手动/语义关联">
          <span className="material-symbols-outlined">hub</span>
          关联知识
        </button>
        <button className="btn btn-danger" onClick={() => setDelOpen(true)}>
          <span className="material-symbols-outlined">delete</span>
          删除
        </button>
      </div>

      {/* 视图页签：原文｜导读卡｜精读版 + 生成/重生成动作 + 关联折叠 */}
      <div className="recycle-tabs domain-tabs" style={{ flexShrink: 0 }}>
        <button
          className={`recycle-tab${view === 'source' ? ' active' : ''}`}
          title={
            fetching
              ? `全文抓取/翻译中${fetching?.progress ? ` · ${fetching.progress}` : ''}`
              : '简体中文全文（英文原文已自动翻译）'
          }
          onClick={() => setView('source')}
        >
          原文{fetching ? ' …' : ''}
        </button>
        {TABS.map(({ view: v, label, task }) => {
          const b = busyOf(task)
          return (
            <button
              key={v}
              className={`recycle-tab${view === v ? ' active' : ''}`}
              title={b ? `${label}生成中${b.progress ? ` · ${b.progress}` : ''}` : undefined}
              onClick={() => setView(v)}
            >
              {label}
              {b ? ' …' : ''}
            </button>
          )
        })}
        {view !== 'source' && (
          <>
            {row && !busy && (
              <button className="icon-btn" title={`重新生成${tab?.label}（覆盖现有产物）`} onClick={() => setForceKind(view)}>
                <span className="material-symbols-outlined">refresh</span>
              </button>
            )}
            {!row && !busy && (
              <button className="btn btn-primary" onClick={() => tab && generate(tab.kind)}>
                <span className="material-symbols-outlined">auto_awesome</span>
                生成{tab?.label}
              </button>
            )}
          </>
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
          ) : mdText ? (
            <MdView md={mdText} bodyRef={bodyRef} />
          ) : view === 'source' && fetching ? (
            <div className="empty-state">
              <span className="material-symbols-outlined spin">progress_activity</span>
              中文版生成中…（英文原文已抓取，翻译完成后自动替换；本视图每 5 秒自动刷新）
            </div>
          ) : view !== 'source' ? (
            busyHere ? (
              <div className="empty-state">
                <span className="material-symbols-outlined spin">progress_activity</span>
                {busy?.progress
                  ? `${tab?.label ?? ''}生成中 · ${busy.progress}——逐章落盘，已生成部分可直接阅读；本视图每 5 秒自动刷新`
                  : `${tab?.label ?? ''}已入队，排队生成中——轮到后自动开始，完成后自动更新`}
              </div>
            ) : (
              <div className="empty-state">
                <span className="material-symbols-outlined">auto_awesome</span>
                {`还未生成${tab?.label ?? '解读产物'}——点击页签行「生成${tab?.label ?? ''}」开始（后台逐章进行，完成后自动更新）`}
              </div>
            )
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
        title={`重新生成${forceKind === 'digest' ? '导读卡' : '精读版'}`}
        danger
        confirmText="重新生成"
        onConfirm={() => forceKind && generate(forceKind, true)}
        onCancel={() => setForceKind(null)}
      >
        已有生成产物，重新生成将覆盖现有内容。确定继续？
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
