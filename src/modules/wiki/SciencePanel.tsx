// 科普页签（超级工作台 2.0 批次D spec §6）：科普文章列表 + 解读阅读视图（MdDialog 只读 +
// 划词高光/问AI + footer 产物切换/原文出处/关联词条）+ 跑一轮科普海选卡。
// 词条跳转/建词条经 WikiModule 注入回调（onOpenEntry / onCreateEntry），保持生成链路单点。
import { useCallback, useEffect, useRef, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import MdDialog from '../../components/MdDialog'
import KnowledgeLinksDialog, { type RelatedLink } from '../../components/KnowledgeLinksDialog'
import { useToast } from '../../components/Toast'
import { openRelated, relatedIcon } from '../../services/relatedNav'
import type {
  AgentDomainRow,
  AgentStatusSnapshot,
  DiscoverItemRow,
  InterpretationRow,
  ScienceArticleRow,
  ScienceHighlightRow,
  WikiSection
} from '../../renderer/api'
import './science.css'

interface ScienceDetail {
  article: ScienceArticleRow
  interpretations: InterpretationRow[]
  highlights: ScienceHighlightRow[]
  related: RelatedLink[]
}

/** 解读版产物（按语言自动分流：en=translation 全文解读 / zh=light 轻加工） */
function autoKindOf(article: ScienceArticleRow): 'translation' | 'light' {
  return article.language === 'en' ? 'translation' : 'light'
}

export interface SciencePanelProps {
  /** 划词问 AI（模块默认频道） */
  onOpenAi: (prefill?: string) => void
  /** 展开右栏（追问后跟随） */
  bumpAi: () => void
  /** 打开词条弹窗（词条命中 / 建词条成功后） */
  onOpenEntry: (entryId: number) => void
  /** 建词条（走万象手动生成链路；成功返回 entryId，冲突返回 null） */
  onCreateEntry: (term: string, sectionId: number | null) => Promise<number | null>
  /** 「出自科普文章」回链跳转入口：置值时打开该文详情，消费后回调复位 */
  openArticleId: number | null
  onOpenArticleConsumed: () => void
}

export default function SciencePanel(props: SciencePanelProps) {
  const { toast } = useToast()
  const [articles, setArticles] = useState<ScienceArticleRow[]>([])
  const [candidates, setCandidates] = useState<DiscoverItemRow[]>([])
  const [delDiscover, setDelDiscover] = useState<DiscoverItemRow | null>(null)
  const [domains, setDomains] = useState<AgentDomainRow[]>([])
  const [collectDomain, setCollectDomain] = useState<number | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [sections, setSections] = useState<WikiSection[]>([])
  const [detail, setDetail] = useState<ScienceDetail | null>(null)
  const [mdVersion, setMdVersion] = useState(0)
  const [showLecture, setShowLecture] = useState(false)
  const [runningTypes, setRunningTypes] = useState<string[]>([])
  const [delTarget, setDelTarget] = useState<ScienceArticleRow | null>(null)
  const [forceKind, setForceKind] = useState<'translate' | 'light' | 'lecture' | null>(null)
  const [createTarget, setCreateTarget] = useState<string | null>(null)
  const [createSection, setCreateSection] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  // 关联知识管理弹窗（批次F）
  const [linksOpen, setLinksOpen] = useState(false)
  // 子页签（260923 反馈：发现箱/正式文章分页签，同信息源文献页签口径）
  const [subTab, setSubTab] = useState<'discover' | 'articles'>('discover')
  // 阅读视图页脚折叠（260923 反馈：关联词条/相关内容 chips 过多挤占正文，默认收起）
  const [assocOpen, setAssocOpen] = useState(false)
  const detailIdRef = useRef<number | null>(null)

  const loadArticles = useCallback((): void => {
    void window.api.science.list().then(setArticles)
  }, [])
  // 发现箱（260923 修订：科普候选自信息源文献页签迁入本页签，接受/拒绝在此完成）
  const loadCandidates = useCallback((): void => {
    void window.api.agent
      .discoverList()
      .then((rows) => setCandidates(rows.filter((r) => r.source_type === 'article' && r.status === 'discovered')))
  }, [])
  const loadDomains = useCallback((): void => {
    void window.api.agent.domains().then((ds) => {
      const sci = ds.filter((d) => d.track === 'science' && d.enabled)
      setDomains(sci)
      setCollectDomain((cur) => cur ?? sci[0]?.id ?? null)
    })
  }, [])

  useEffect(() => {
    loadArticles()
    loadCandidates()
    loadDomains()
    void window.api.wiki.sections().then(setSections)
  }, [loadArticles, loadCandidates, loadDomains])

  useEffect(() => {
    detailIdRef.current = detail?.article.id ?? null
  }, [detail])

  // 换文章时页脚回到收起态（阅读优先）
  useEffect(() => {
    setAssocOpen(false)
  }, [detail?.article.id])

  const refreshDetail = useCallback((): void => {
    const id = detailIdRef.current
    if (id == null) return
    void window.api.science
      .detail(id)
      .then((d) => {
        setDetail(d)
        setMdVersion((v) => v + 1)
      })
      .catch(() => {})
  }, [])

  // 实时刷新：海选完成 → 列表；解读产物完成/失败 → 列表 + 当前详情
  useEffect(() => {
    const off = window.api.agent.onAgentStatus((s: AgentStatusSnapshot) => {
      setRunningTypes(s.runningTypes ?? [])
      const ev = s.lastEvent
      if (!ev || ev.status === 'enqueued') return
      if (ev.type === 'collect_science') {
        loadArticles()
        loadCandidates()
        toast(ev.status === 'done' ? '科普海选完成，发现箱已更新' : '科普海选失败，详见控制台 [agent] 日志')
      } else if (ev.type === 'science_fetch') {
        loadArticles()
        refreshDetail()
      } else if (ev.type === 'science_translate' || ev.type === 'science_light' || ev.type === 'science_lecture') {
        loadArticles()
        refreshDetail()
        if (ev.status === 'failed') toast('解读任务失败，详见控制台 [agent] 日志')
      }
    })
    return off
  }, [loadArticles, loadCandidates, refreshDetail, toast])

  // 「出自科普文章」回链跳转入口
  useEffect(() => {
    if (props.openArticleId == null) return
    const id = props.openArticleId
    props.onOpenArticleConsumed()
    void window.api.science
      .detail(id)
      .then((d) => {
        setShowLecture(false)
        setDetail(d)
        setMdVersion((v) => v + 1)
      })
      .catch((e) => toast(`打开文章失败：${(e as Error).message}`))
  }, [props.openArticleId])

  const runCollect = async (): Promise<void> => {
    if (collectDomain == null) {
      toast('暂无启用的科普领域，请先到个人档「超级工作台」添加')
      return
    }
    setCollecting(true)
    try {
      await window.api.agent.runCollect(collectDomain)
      toast('科普海选已入队，完成后本页自动更新')
    } catch (e) {
      toast(`入队失败：${(e as Error).message}`)
    } finally {
      setCollecting(false)
    }
  }

  const removeArticle = async (): Promise<void> => {
    const t = delTarget
    setDelTarget(null)
    if (!t) return
    await window.api.science.delete(t.id)
    toast('科普文章已彻底删除（含解读产物与高光）')
    if (detail?.article.id === t.id) setDetail(null)
    loadArticles()
  }

  // ---------- 发现箱候选（接受 / 拒绝 / 删除） ----------

  const acceptCandidate = async (id: number): Promise<void> => {
    try {
      await window.api.agent.discoverAccept(id)
      toast('已转正，全文抓取与解读生成中（完成后入库下方正式列表）')
      loadCandidates()
      loadArticles()
    } catch (e) {
      toast(`转正失败：${(e as Error).message}`)
    }
  }

  const rejectCandidate = async (id: number): Promise<void> => {
    await window.api.agent.discoverReject(id)
    loadCandidates()
  }

  const removeDiscover = async (): Promise<void> => {
    const it = delDiscover
    setDelDiscover(null)
    if (!it) return
    await window.api.agent.discoverDelete(it.id)
    toast('已删除该发现条目')
    loadCandidates()
  }

  // ---------- 详情与产物 ----------

  const interpOf = (kind: 'translation' | 'light' | 'lecture'): InterpretationRow | undefined =>
    detail?.interpretations.find((i) => i.kind === kind && i.status === 'done')

  const busyOf = (taskType: string): boolean => runningTypes.includes(taskType)
  const autoKind = detail ? autoKindOf(detail.article) : 'light'
  const autoRow = detail ? interpOf(autoKind) : undefined
  const lectureRow = detail ? interpOf('lecture') : undefined
  const currentRow = detail ? (showLecture ? lectureRow : autoRow) : undefined

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
      .then(() => toast('任务已入队，逐部分生成中'))
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
    refreshDetail()
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
    refreshDetail()
    toast('已取消高光')
  }

  const onAskAi = (text: string): void => {
    props.onOpenAi(`关于科普文章《${detail?.article.title ?? ''}》：「${text}」\n\n请帮我解释。`)
  }

  // ---------- wiki:// 概念链接 ----------

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

  const confirmCreate = async (): Promise<void> => {
    if (!detail || !createTarget || creating) return
    setCreating(true)
    try {
      const entryId = await props.onCreateEntry(createTarget, createSection)
      if (entryId != null) {
        await window.api.science.linkManual(detail.article.id, createTarget, entryId)
        toast(`词条「${createTarget}」已生成并建立关联`)
        refreshDetail()
      }
    } finally {
      setCreating(false)
      setCreateTarget(null)
    }
  }

  // ---------- 阅读视图 footer ----------

  const footer = detail ? (
    <div className="sci-footer">
      <div className="sci-footer-row">
        <button
          className="btn"
          disabled={busyOf(autoKind === 'translation' ? 'science_translate' : 'science_light')}
          onClick={() => {
            if (busyOf(autoKind === 'translation' ? 'science_translate' : 'science_light')) return
            if (autoRow?.md_path) {
              setShowLecture(false)
              setMdVersion((v) => v + 1)
            } else {
              generate(autoKind === 'translation' ? 'translate' : 'light')
            }
          }}
        >
          <span
            className={`material-symbols-outlined${busyOf(autoKind === 'translation' ? 'science_translate' : 'science_light') ? ' spin' : ''}`}
          >
            {busyOf(autoKind === 'translation' ? 'science_translate' : 'science_light')
              ? 'progress_activity'
              : autoRow
                ? 'auto_stories'
                : 'auto_awesome'}
          </span>
          {busyOf(autoKind === 'translation' ? 'science_translate' : 'science_light')
            ? '解读生成中…'
            : autoRow
              ? '查看解读版'
              : '生成解读版'}
        </button>
        <button
          className="btn"
          disabled={busyOf('science_lecture')}
          onClick={() => {
            if (busyOf('science_lecture')) return
            if (lectureRow?.md_path) {
              setShowLecture(true)
              setMdVersion((v) => v + 1)
            } else {
              generate('lecture')
            }
          }}
        >
          <span className={`material-symbols-outlined${busyOf('science_lecture') ? ' spin' : ''}`}>
            {busyOf('science_lecture') ? 'progress_activity' : 'school'}
          </span>
          {busyOf('science_lecture') ? '精讲生成中…' : lectureRow ? '查看精讲' : '生成精讲'}
        </button>
        <button
          className="btn"
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
        <span style={{ flex: 1 }} />
        {detail.article.status === 'meta_only' ? (
          <button
            className="btn"
            onClick={() => {
              if (!detail) return
              void window.api.science
                .retryFetch(detail.article.id)
                .then(() => toast('重试抓取中，完成后自动解读'))
                .catch((e) => toast(`重试失败：${(e as Error).message}`))
            }}
            title="重新抓取全文；成功后自动入队解读"
          >
            <span className="material-symbols-outlined">cloud_download</span>
            重试抓取
          </button>
        ) : (
          <button
            className="btn"
            onClick={() => detail && void window.api.shell.openExternal(detail.article.url)}
            title={detail.article.source}
          >
            <span className="material-symbols-outlined">open_in_new</span>
            原文出处
          </button>
        )}
        {detail.article.concepts.length + detail.related.length > 0 && (
          <button
            className="btn"
            onClick={() => setAssocOpen((v) => !v)}
            title="展开/收起关联词条与相关内容（阅读时可收起）"
          >
            <span className="material-symbols-outlined">{assocOpen ? 'expand_less' : 'expand_more'}</span>
            {assocOpen
              ? '收起关联'
              : `关联与相关（${detail.article.concepts.length + detail.related.length}）`}
          </button>
        )}
        <button className="btn" onClick={() => detail && setLinksOpen(true)} title="管理本文的手动/语义关联">
          <span className="material-symbols-outlined">hub</span>
          关联知识
        </button>
        <button className="btn btn-danger" onClick={() => detail && setDelTarget(detail.article)}>
          <span className="material-symbols-outlined">delete</span>
          删除
        </button>
      </div>
      {assocOpen && detail.related.length > 0 && (
        <div className="sci-footer-row sci-concepts">
          <span className="sci-concepts-label">相关内容</span>
          {detail.related.map((r) => (
            <button
              key={r.link_id}
              className="sci-chip"
              title={r.origin === 'manual' ? '手动关联，点击打开' : `语义相似 ${Math.round(r.score * 100)}%，点击打开`}
              onClick={() => {
                setDetail(null)
                openRelated(r)
              }}
            >
              <span className="material-symbols-outlined sci-chip-icon">{relatedIcon(r.peer_type)}</span>
              {r.title}
            </button>
          ))}
        </div>
      )}
      {assocOpen && detail.article.concepts.length > 0 && (
        <div className="sci-footer-row sci-concepts">
          <span className="sci-concepts-label">关联词条</span>
          {detail.article.concepts.map((c) => (
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
    </div>
  ) : null

  const readingContent = currentRow?.md_path
  const langLabel = detail?.article.language === 'en' ? '英文' : '中文'
  const metaMd = detail
    ? `# ${detail.article.title}\n\n> ${langLabel}${detail.article.domain_name ? ' · ' + detail.article.domain_name : ''}${detail.article.date ? ' · ' + detail.article.date : detail.article.year != null ? ' · ' + detail.article.year : ''} · ${detail.article.source}\n\n${detail.article.summary || '（暂无摘要）'}\n\n${
        detail.article.status === 'meta_only'
          ? '> ⚠ 全文尚未抓取到：可在下方「重试抓取」，成功后自动开始解读。'
          : '> 全文已就绪，点击下方「生成解读版」开始解读。'
      }\n`
    : ''

  return (
    <div className="science-panel">
      {/* 跑一轮科普海选卡 */}
      <div className="sci-collect-bar">
        <div className="sci-collect-info">
          <div className="sci-collect-title">
            <span className="material-symbols-outlined">science</span>
            AI 科普海选
          </div>
          <div className="module-sub">AI 按科普领域搜罗深入浅出的好文章；「接受」后入库本页并自动解读</div>
        </div>
        <div className="sci-collect-ctrl">
          {domains.length > 0 ? (
            <select
              className="sci-select"
              value={collectDomain ?? ''}
              onChange={(e) => setCollectDomain(Number(e.target.value))}
              title="选择科普领域"
            >
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="module-sub">暂无启用科普领域</span>
          )}
          <button className="btn btn-primary" onClick={() => void runCollect()} disabled={collecting}>
            <span className="material-symbols-outlined">play_arrow</span>
            跑一轮科普海选
          </button>
        </div>
      </div>

      {/* 子页签（260923 反馈：发现箱 / 正式文章，同信息源文献页签口径） */}
      <div className="sci-toolbar">
        <div className="recycle-tabs">
          <button
            className={`recycle-tab${subTab === 'discover' ? ' active' : ''}`}
            onClick={() => setSubTab('discover')}
          >
            发现箱{candidates.length > 0 ? `（${candidates.length}）` : ''}
          </button>
          <button
            className={`recycle-tab${subTab === 'articles' ? ' active' : ''}`}
            onClick={() => setSubTab('articles')}
          >
            正式文章{articles.length > 0 ? `（${articles.length}）` : ''}
          </button>
        </div>
      </div>

      {/* 发现箱（科普候选） */}
      {subTab === 'discover' && (
        <div className="sci-list">
          {candidates.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">inbox</span>
              发现箱空空的——点「跑一轮科普海选」，AI 找到的候选会先出现在这里，由你决定是否入库
            </div>
          )}
          {candidates.map((it) => (
            <div className="sci-item" key={`d-${it.id}`}>
              <div className="row-main">
                <div className="row-title">{it.title}</div>
                <div className="row-sub">
                  {it.language === 'zh' ? '中文' : '英文'}
                  {it.date ? ` · ${it.date}` : it.year != null ? ` · ${it.year}` : ''}
                </div>
                {it.reason && <div className="sci-reason">「{it.reason}」</div>}
              </div>
              <div className="row-actions">
                <span className="badge">{it.source.startsWith('mcp:') ? `MCP·${it.source.slice(4)}` : it.source}</span>
                <button className="btn btn-primary" onClick={() => void acceptCandidate(it.id)}>
                  接受
                </button>
                <button className="btn" onClick={() => void rejectCandidate(it.id)}>
                  拒绝
                </button>
                <button className="icon-btn danger" title="彻底删除该条目" onClick={() => setDelDiscover(it)}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 正式文章（转正入库，自动解读） */}
      {subTab === 'articles' && (
        <div className="sci-list">
          {articles.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">science</span>
              还没有科普文章——在发现箱「接受」候选后，文章会入库到这里并自动解读
            </div>
          )}
          {articles.map((a) => (
          <div
            className="sci-item"
            key={a.id}
            onClick={() => {
              void window.api.science
                .detail(a.id)
                .then((d) => {
                  setShowLecture(false)
                  setDetail(d)
                  setMdVersion((v) => v + 1)
                })
                .catch((e) => toast(`打开详情失败：${(e as Error).message}`))
            }}
          >
            <div className="row-main">
              <div className="row-title">{a.title}</div>
              <div className="row-sub">
                {a.domain_name ?? ''}
                {a.domain_name ? ' · ' : ''}
                {a.language === 'en' ? '英文' : '中文'}
                {a.date ? ` · ${a.date}` : a.year != null ? ` · ${a.year}` : ''}
                {` · ${a.concepts.length} 个关联词条`}
              </div>
            </div>
            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
              {a.domain_name && <span className="badge">{a.domain_name}</span>}
              <span className={`badge ${a.status === 'ready' ? 'primary' : ''}`}>
                {a.status === 'ready' ? '全文就绪' : '仅元信息'}
              </span>
              <button className="icon-btn danger" title="彻底删除" onClick={() => setDelTarget(a)}>
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
          </div>
        ))}
        </div>
      )}

      {/* 解读阅读视图 */}
      {detail && (
        <MdDialog
          key={`${detail.article.id}-${mdVersion}-${showLecture ? 'lec' : 'auto'}`}
          open
          title={detail.article.title}
          titleTag={[langLabel, currentRow ? undefined : '待解读'].filter((x): x is string => !!x)}
          subtitle={`${detail.article.domain_name ?? ''}${detail.article.domain_name ? ' ｜ ' : ''}${detail.article.source}`}
          filePath={readingContent ?? undefined}
          content={readingContent ? undefined : metaMd}
          readOnly
          selectionActions={
            currentRow
              ? {
                  onHighlight: (t) => void onHighlight(t),
                  onUnhighlight: (t) => void onUnhighlight(t),
                  onAskAi
                }
              : undefined
          }
          onWikiLink={currentRow ? onWikiLink : undefined}
          footerBar={footer}
          onClose={() => {
            setDetail(null)
            loadArticles()
          }}
        />
      )}

      {/* 删除确认（彻底删：连解读产物/高光/链接/全文缓存） */}
      <ConfirmDialog
        open={delTarget !== null}
        title="删除科普文章"
        danger
        confirmText="彻底删除"
        onConfirm={() => void removeArticle()}
        onCancel={() => setDelTarget(null)}
      >
        确认彻底删除《{delTarget?.title}》？其解读产物、划词高光、关联词条链接与全文缓存将一并删除，不可恢复。
      </ConfirmDialog>

      {/* 发现条目删除确认（候选阶段，无连带产物） */}
      <ConfirmDialog
        open={delDiscover !== null}
        title="删除发现条目"
        danger
        confirmText="删除"
        onConfirm={() => void removeDiscover()}
        onCancel={() => setDelDiscover(null)}
      >
        确认删除「{delDiscover?.title}」？下次海选仍可能重新发现它。
      </ConfirmDialog>

      {/* 关联知识管理（批次F：双向列表 + 手动添加） */}
      <KnowledgeLinksDialog
        open={linksOpen && detail != null}
        srcType="science_article"
        srcId={detail?.article.id ?? 0}
        title={detail?.article.title ?? ''}
        onClose={() => setLinksOpen(false)}
      />

      {/* 重生成确认 */}
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
