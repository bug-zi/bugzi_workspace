// 论文阅读视图（260929 抓取三页签阅读：原文｜导读卡｜精读版，默认原文）：
// 原文 = 简体中文全文（zh 直读缓存；en 显示 translation 译文产物，缺译文静默补翻译管道）。
// 导读卡（大致内容+文章脉络）/精读版（关键部分拆解）按需生成，空态给生成按钮；
// 生成中按「任务类型+refId」精确匹配、可围观逐章落盘的半成品（5s 轮询）。划词仅「问 AI」（含原文）。
import { useCallback, useEffect, useRef, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import KnowledgeLinksDialog, { type RelatedLink } from '../../components/KnowledgeLinksDialog'
import MdView from '../../components/MdView'
import { useToast } from '../../components/Toast'
import { openRelated, relatedIcon } from '../../services/relatedNav'
import { useReaderZoom } from '../../hooks/useReaderZoom'
import { useSelectionBubble } from '../../hooks/useSelectionBubble'
import { useFillHeight } from '../../hooks/useFillHeight'
import type { AgentStatusSnapshot, InterpretationRow, PaperRow } from '../../renderer/api'

interface PaperDetail {
  paper: PaperRow
  interpretations: InterpretationRow[]
  related: RelatedLink[]
  /** 该文献在队/在跑任务类型（含排队未派发项，260928） */
  active: string[]
}

type ReadView = 'source' | 'digest' | 'deepread'

const SOURCE_LABEL: Record<string, string> = { arxiv: 'arXiv' }

function sourceBadge(s: string): string {
  return SOURCE_LABEL[s] ?? (s.startsWith('mcp:') ? `MCP·${s.slice(4)}` : s)
}

function dateLabel(row: { date: string | null; year: number | null }): string {
  if (row.date) return row.date
  return row.year != null ? String(row.year) : ''
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
    task: 'make_digest',
    kind: 'digest',
    pathOf: (id) => `md/interpretations/${id}-digest.md`
  },
  {
    view: 'deepread',
    label: '精读版',
    task: 'paper_deepread',
    kind: 'deepread',
    pathOf: (id) => `md/interpretations/${id}-deepread.md`
  }
]

export default function PaperReader(props: {
  paperId: number
  onBack: () => void
  /** 产物/删除等变化后刷新列表 */
  onChanged: () => void
  /** 相关内容点击 paper 项：就地切换阅读目标（面板置 readingId） */
  onOpenPaper: (paperId: number) => void
  /** 划词问 AI / 追问（右栏「文献」频道） */
  onOpenAi?: (prefill?: string) => void
}) {
  const { toast } = useToast()
  const [detail, setDetail] = useState<PaperDetail | null>(null)
  const [view, setView] = useState<ReadView>('source')
  const [mdText, setMdText] = useState('')
  const [mdVersion, setMdVersion] = useState(0)
  const [runningTasks, setRunningTasks] = useState<{ type: string; refId: number | null; progress: string | null }[]>([])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [forceKind, setForceKind] = useState<'digest' | 'deepread' | null>(null)
  const [linksOpen, setLinksOpen] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  // 旧英文条目缺译文的补翻译只自动触发一次（防事件刷新重复入队；幂等管道本身也安全）
  const autoTrigRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const { scrollRef, zoom, zoomBarVisible, resetZoom } = useReaderZoom()
  const { ref: rootRef, height: rootHeight } = useFillHeight()

  const load = useCallback(async (): Promise<void> => {
    try {
      setDetail(await window.api.agent.paperDetail(props.paperId))
    } catch (e) {
      toast(`打开文献失败：${(e as Error).message}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.paperId])

  useEffect(() => {
    void load()
  }, [load])

  const interpOf = (kind: 'digest' | 'deepread' | 'translation'): InterpretationRow | undefined =>
    detail?.interpretations.find((i) => i.kind === kind && i.status === 'done')

  const busyOf = (task: string): { progress: string | null } | null =>
    detail ? (runningTasks.find((t) => t.type === task && t.refId === detail.paper.id) ?? null) : null
  // 排队未派发任务也算忙（260928）：runningTasks 只含在飞项，排队段此前无任何提示
  const queuedBusyOf = (task: string): boolean => detail?.active.includes(task) ?? false

  const tab = TABS.find((t) => t.view === view)
  const busy = tab ? (busyOf(tab.task) ?? (queuedBusyOf(tab.task) ? { progress: null } : null)) : null
  const fetching = detail ? (busyOf('paper_fetch') ?? (queuedBusyOf('paper_fetch') ? { progress: null } : null)) : null
  const row = tab ? interpOf(tab.kind) : undefined
  // 生成中围观半成品：done 台账未落也按约定路径读（精读版逐章落盘；导读卡完成时一次落盘）。
  // 仅在飞任务读半成品路径——排队任务文件尚未产生，走占位提示
  const contentPath = tab
    ? (row?.md_path ?? (busyOf(tab.task) ? tab.pathOf(detail?.paper.id ?? 0) : undefined))
    : undefined

  // 生成中每 5s 刷新（逐章落盘实时可见；任务终态事件另有即时刷新）
  useEffect(() => {
    if (!busy && !fetching) return
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [busy, fetching, load])

  // 队列事件：本文相关任务（入队/终态都刷）→ 即时刷新详情
  useEffect(() => {
    const off = window.api.agent.onAgentStatus((s: AgentStatusSnapshot) => {
      setRunningTasks(s.runningTasks ?? [])
      const ev = s.lastEvent
      if (!ev) return
      if (ev.type === 'paper_fetch' || ev.type === 'make_digest' || ev.type === 'paper_deepread') void load()
    })
    return off
  }, [load])

  // 内容装载：原文 en=translation 译文（缺译文先读英文缓存并静默补翻译）、zh=全文缓存；解读产物读 md
  useEffect(() => {
    setEditing(false)
    if (view === 'source') {
      if (!detail) return
      const paper = detail.paper
      if (paper.status !== 'ready') {
        setMdText('')
        return
      }
      let cancelled = false
      if (paper.language === 'en') {
        const trans = detail.interpretations.find((i) => i.kind === 'translation' && i.status === 'done')
        if (trans?.md_path) {
          void window.api.md
            .read(trans.md_path)
            .then((md) => {
              if (!cancelled) setMdText(md)
            })
            .catch(() => {
              if (!cancelled) setMdText('')
            })
          return () => {
            cancelled = true
          }
        }
        // 旧英文条目缺译文：静默补一次翻译管道（幂等），译文就绪前先展示英文原文
        if (!fetching && !autoTrigRef.current) {
          autoTrigRef.current = true
          void window.api.agent.paperRetryFetch(paper.id).catch(() => {})
        }
      }
      void window.api.agent.paperFulltext(paper.id).then(({ raw, isMd }) => {
        if (cancelled) return
        setMdText(
          raw
            ? `# 原文：${paper.title}\n\n${
                isMd ? raw.trim() : raw.split(/\n+/).map((s) => s.trim()).filter(Boolean).join('\n\n')
              }`
            : '（原文缓存缺失，请返回列表「重试抓取」）'
        )
      })
      return () => {
        cancelled = true
      }
    }
    if (!contentPath) {
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
  }, [view, detail?.paper.id, detail?.paper.status, detail?.interpretations, contentPath, mdVersion, fetching])

  /** 生成/重生成解读；done 且未 force 的先弹确认 */
  const generate = (kind: 'digest' | 'deepread', force = false): void => {
    if (!detail) return
    if (interpOf(kind) && !force) {
      setForceKind(kind)
      return
    }
    void window.api.agent
      .runInterpret(detail.paper.id, kind, force)
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

  const saveEdit = async (): Promise<void> => {
    if (!detail || !contentPath) return
    await window.api.md.write(contentPath, draft)
    setEditing(false)
    setMdVersion((v) => v + 1)
    toast('已保存')
  }

  const removePaper = async (): Promise<void> => {
    if (!detail) return
    await window.api.agent.paperDelete(detail.paper.id)
    toast('文献已彻底删除（含解读产物与全文缓存）')
    props.onChanged()
    props.onBack()
  }

  // 划词问 AI（无高光载体，仅问 AI；编辑态不出气泡，原文页也可问）
  useSelectionBubble(
    !editing && !!mdText,
    bodyRef,
    detail
      ? {
          onAskAi: (text) =>
            props.onOpenAi?.(`关于论文《${detail.paper.title}》：「${text}」\n\n请帮我解释。`)
        }
      : undefined
  )

  const paper = detail?.paper
  const langLabel = paper?.language === 'zh' ? '中文' : '英文'
  const emptyHint = busy ? (
    <div className="empty-state">
      <span className="material-symbols-outlined spin">progress_activity</span>
      {busy.progress
        ? `${tab?.label ?? ''}生成中 · ${busy.progress}——逐章落盘，已生成部分可直接阅读；本视图每 5 秒自动刷新`
        : `${tab?.label ?? ''}已入队，排队生成中——轮到后自动开始，完成后自动更新`}
    </div>
  ) : (
    <div className="empty-state">
      <span className="material-symbols-outlined">auto_awesome</span>
      {`暂无${tab?.label ?? '解读产物'}——点击下方按钮生成（后台逐章进行，完成后自动更新）`}
      <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={() => tab && generate(tab.kind)}>
        生成{tab?.label}
      </button>
    </div>
  )

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
        <div className="reader-title">{paper?.title ?? '…'}</div>
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
            void window.api.agent.askLiterature('paper', detail.paper.id)
            props.onOpenAi?.()
          }}
          title="注入该文献上下文，在右栏「文献·追问」场景继续提问"
        >
          <span className="material-symbols-outlined">forum</span>
          追问
        </button>
        <button className="btn" onClick={() => setLinksOpen(true)} title="管理本文献的手动/语义关联">
          <span className="material-symbols-outlined">hub</span>
          关联知识
        </button>
        <button className="btn btn-danger" onClick={() => setDelOpen(true)}>
          <span className="material-symbols-outlined">delete</span>
          删除
        </button>
      </div>

      {/* 视图页签：原文｜导读卡｜精读版 + 生成/重生成动作 */}
      <div className="recycle-tabs domain-tabs" style={{ flexShrink: 0 }}>
        <button
          className={`recycle-tab${view === 'source' ? ' active' : ''}`}
          onClick={() => setView('source')}
          title="简体中文全文（英文原文已自动翻译）"
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
      </div>

      <div className="module-reader-scroll" ref={scrollRef}>
        <article className="module-reader-article" style={{ fontSize: `${zoom}%` }}>
          {paper && (
            <div className="lit-meta" style={{ marginBottom: 10 }}>
              {(paper.authors.length ? paper.authors.slice(0, 6).join(', ') : '佚名')}
              {dateLabel(paper) ? ` · ${dateLabel(paper)}` : ''}
              {` · ${langLabel}`}
              <span className={`badge ${paper.status === 'ready' ? 'primary' : ''}`} style={{ marginLeft: 8 }}>
                {paper.status === 'ready' ? '全文就绪' : '处理中…'}
              </span>
              <span className="badge" style={{ marginLeft: 6 }}>{sourceBadge(paper.source)}</span>
            </div>
          )}

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
          ) : view === 'source' ? (
            <div className="empty-state">
              <span className="material-symbols-outlined spin">progress_activity</span>
              加载中…
            </div>
          ) : (
            emptyHint
          )}

          {/* 无任何产物时正文区给摘要打底（有产物后摘要让位正文） */}
          {paper?.summary && !editing && !mdText && view !== 'source' && !busy && (
            <div className="lit-summary" style={{ marginTop: 14 }}>
              <div className="setting-label">摘要</div>
              {paper.summary}
            </div>
          )}

          {detail && detail.related.length > 0 && (
            <div className="lit-related" style={{ marginTop: 22 }}>
              <div className="setting-label">相关内容</div>
              {detail.related.map((r) => (
                <div
                  className="lit-related-row"
                  key={r.link_id}
                  onClick={() => {
                    if (r.peer_type === 'paper') props.onOpenPaper(r.peer_id)
                    else openRelated(r)
                  }}
                  title={r.origin === 'manual' ? '手动关联，点击打开' : `语义相似 ${Math.round(r.score * 100)}%，点击打开`}
                >
                  <span className="material-symbols-outlined">{relatedIcon(r.peer_type)}</span>
                  {r.title}
                  <span className={`badge ${r.origin === 'manual' ? 'primary' : ''} lit-origin-badge`}>
                    {r.origin === 'manual' ? '手动' : `${Math.round(r.score * 100)}%`}
                  </span>
                </div>
              ))}
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
        title="删除文献"
        danger
        confirmText="彻底删除"
        onConfirm={() => void removePaper()}
        onCancel={() => setDelOpen(false)}
      >
        确认彻底删除《{paper?.title}》？其导读卡/精读版产物、全文缓存与相关推荐将一并删除，不可恢复。
      </ConfirmDialog>

      <KnowledgeLinksDialog
        open={linksOpen && detail != null}
        srcType="paper"
        srcId={detail?.paper.id ?? 0}
        title={detail?.paper.title ?? ''}
        onClose={() => setLinksOpen(false)}
      />
    </div>
  )
}
