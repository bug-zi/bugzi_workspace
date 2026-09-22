// 文献页签（超级工作台 2.0 批次B + 260921 验证反馈）：
// 订阅 agent:status 推送实现海选/解读产物的实时刷新（无需手动刷新页面）；
// 发现箱与正式文献支持彻底删除（二次确认）；发布日期精确到日。
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
  PaperRow
} from '../../renderer/api'
import './literature.css'

type SubTab = 'discover' | 'papers'

interface PaperDetail {
  paper: PaperRow
  interpretations: InterpretationRow[]
  related: RelatedLink[]
}

const SOURCE_LABEL: Record<string, string> = { arxiv: 'arXiv' }

function sourceBadge(s: string): string {
  return SOURCE_LABEL[s] ?? (s.startsWith('mcp:') ? `MCP·${s.slice(4)}` : s)
}

function dateLabel(row: { date: string | null; year: number | null }): string {
  if (row.date) return row.date
  return row.year != null ? String(row.year) : ''
}

export default function LiteraturePanel({
  onOpenAi,
  openPaperId,
  onOpenPaperConsumed
}: {
  onOpenAi?: () => void
  /** 跨模块深链（批次F）：置值时自动打开该文献详情，消费后回调复位 */
  openPaperId?: number | null
  onOpenPaperConsumed?: () => void
}) {
  const { toast } = useToast()
  const [subTab, setSubTab] = useState<SubTab>('discover')
  const [items, setItems] = useState<DiscoverItemRow[]>([])
  const [papers, setPapers] = useState<PaperRow[]>([])
  const [domains, setDomains] = useState<AgentDomainRow[]>([])
  const [collectDomain, setCollectDomain] = useState<number | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [detail, setDetail] = useState<PaperDetail | null>(null)
  const [viewMd, setViewMd] = useState<{ title: string; filePath: string; tag: string } | null>(null)
  const [forceKind, setForceKind] = useState<'digest' | 'lecture' | 'translate' | null>(null)
  const [delPaper, setDelPaper] = useState<PaperRow | null>(null)
  const [delDiscover, setDelDiscover] = useState<DiscoverItemRow | null>(null)
  const [linksOpen, setLinksOpen] = useState(false)
  const [runningTypes, setRunningTypes] = useState<string[]>([])
  const detailIdRef = useRef<number | null>(null)

  const loadDiscover = useCallback((): void => {
    void window.api.agent.discoverList().then(setItems)
  }, [])
  const loadPapers = useCallback((): void => {
    void window.api.agent.papers().then(setPapers)
  }, [])
  const loadDomains = useCallback((): void => {
    void window.api.agent.domains().then((ds) => {
      const deep = ds.filter((d) => d.track === 'deep' && d.enabled)
      setDomains(deep)
      setCollectDomain((cur) => cur ?? deep[0]?.id ?? null)
    })
  }, [])

  useEffect(() => {
    loadDiscover()
    loadPapers()
    loadDomains()
  }, [loadDiscover, loadPapers, loadDomains])

  // 实时刷新（260921 验证反馈）：队列事件随 agent:status 推送，按任务类型增量刷新对应列表/详情
  useEffect(() => {
    const off = window.api.agent.onAgentStatus((s: AgentStatusSnapshot) => {
      setRunningTypes(s.runningTypes ?? [])
      const ev = s.lastEvent
      if (!ev || ev.status === 'enqueued') return
      if (ev.type === 'collect_deep') {
        loadDiscover()
        toast(ev.status === 'done' ? '海选完成，发现箱已更新' : '海选任务失败，详见控制台 [agent] 日志')
      } else if (ev.type === 'make_digest' || ev.type === 'lecture' || ev.type === 'translate') {
        loadPapers()
        const pid = detailIdRef.current
        if (pid != null) void window.api.agent.paperDetail(pid).then(setDetail).catch(() => {})
        const msg =
          ev.status === 'done'
            ? '解读产物已更新'
            : ev.status === 'failed'
              ? '解读任务失败，详见控制台 [agent] 日志'
              : ''
        if (msg) toast(msg)
      }
    })
    return off
  }, [loadDiscover, loadPapers, toast])

  useEffect(() => {
    detailIdRef.current = detail?.paper.id ?? null
  }, [detail])

  // 跨模块深链（批次F）：相关内容点击 → 打开指定文献详情
  useEffect(() => {
    if (openPaperId == null) return
    const id = openPaperId
    onOpenPaperConsumed?.()
    void openDetail(id)
  }, [openPaperId])

  // 信息源·发现箱只呈论文候选（260923 开发者反馈：科普候选归万象库科普页签）
  const discovered = items.filter((i) => i.status === 'discovered' && i.source_type !== 'article')
  const acceptedCount = items.filter((i) => i.status === 'accepted').length
  const rejectedCount = items.filter((i) => i.status === 'rejected').length

  const runCollect = async (): Promise<void> => {
    if (collectDomain == null) {
      toast('暂无启用的深读领域，请先到个人档「超级工作台」添加')
      return
    }
    setCollecting(true)
    try {
      await window.api.agent.runCollect(collectDomain)
      toast('海选已入队，完成后发现箱自动更新')
    } catch (e) {
      toast(`入队失败：${(e as Error).message}`)
    } finally {
      setCollecting(false)
    }
  }

  const accept = async (id: number): Promise<void> => {
    try {
      await window.api.agent.discoverAccept(id)
      toast('已转正，全文抓取与导读卡生成中（完成后自动出现）')
      loadDiscover()
      loadPapers()
    } catch (e) {
      toast(`转正失败：${(e as Error).message}`)
    }
  }

  const reject = async (id: number): Promise<void> => {
    await window.api.agent.discoverReject(id)
    loadDiscover()
  }

  const removeDiscover = async (): Promise<void> => {
    const it = delDiscover
    setDelDiscover(null)
    if (!it) return
    await window.api.agent.discoverDelete(it.id)
    toast('已删除该发现条目')
    loadDiscover()
  }

  const removePaper = async (): Promise<void> => {
    const p = delPaper
    setDelPaper(null)
    if (!p) return
    await window.api.agent.paperDelete(p.id)
    toast('文献已彻底删除（含解读产物与全文缓存）')
    if (detail?.paper.id === p.id) setDetail(null)
    loadPapers()
    loadDiscover()
  }

  const openDetail = async (paperId: number): Promise<void> => {
    try {
      setDetail(await window.api.agent.paperDetail(paperId))
    } catch (e) {
      toast(`打开详情失败：${(e as Error).message}`)
    }
  }

  const interpOf = (kind: 'digest' | 'lecture' | 'translate'): InterpretationRow | undefined => {
    const k: InterpretationRow['kind'] = kind === 'translate' ? 'translation' : kind
    return detail?.interpretations.find((i) => i.kind === k && i.status === 'done')
  }

  const generating = (kind: 'digest' | 'lecture' | 'translate'): boolean => {
    const t = kind === 'digest' ? 'make_digest' : kind
    return runningTypes.includes(t)
  }

  /** 生成/重生成解读；done 且未 force 的先弹确认 */
  const generate = (kind: 'digest' | 'lecture' | 'translate', force = false): void => {
    if (!detail) return
    const existing = interpOf(kind)
    if (existing && !force) {
      setForceKind(kind)
      return
    }
    void window.api.agent
      .runInterpret(detail.paper.id, kind, force)
      .then(() => {
        toast(kind === 'digest' ? '导读卡生成中，完成后自动更新' : '任务已入队，逐章生成中')
        setForceKind(null)
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

  const refreshDetail = (): void => {
    if (detail) void window.api.agent.paperDetail(detail.paper.id).then(setDetail).catch(() => {})
  }

  const importPdf = async (): Promise<void> => {
    if (!detail) return
    try {
      const ok = await window.api.agent.importPaperPdf(detail.paper.id)
      if (ok) {
        toast('PDF 导入成功，全文已就绪')
        refreshDetail()
      }
    } catch (e) {
      toast(`导入失败：${(e as Error).message}`)
    }
  }

  const KIND_META: { kind: 'digest' | 'lecture' | 'translate'; label: string }[] = [
    { kind: 'digest', label: '导读卡' },
    { kind: 'lecture', label: '精讲' },
    { kind: 'translate', label: '精译' }
  ]

  return (
    <div className="literature-panel">
      {/* AI 海选卡（260921 验证反馈：样式优化） */}
      <div className="lit-collect-bar">
        <div className="lit-collect-info">
          <div className="lit-collect-title">
            <span className="material-symbols-outlined">search_insights</span>
            AI 海选
          </div>
          <div className="module-sub">AI 搜索并筛选候选文献，只呈元信息与推荐理由；「接受」后才入库正式文献区</div>
        </div>
        <div className="lit-collect-ctrl">
          {domains.length > 0 ? (
            <select
              className="lit-select"
              value={collectDomain ?? ''}
              onChange={(e) => setCollectDomain(Number(e.target.value))}
              title="选择深读领域"
            >
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="module-sub">暂无启用深读领域</span>
          )}
          <button className="btn btn-primary" onClick={() => void runCollect()} disabled={collecting}>
            <span className="material-symbols-outlined">play_arrow</span>
            跑一轮海选
          </button>
        </div>
      </div>

      <div className="lit-toolbar">
        <div className="recycle-tabs">
          <button
            className={`recycle-tab${subTab === 'discover' ? ' active' : ''}`}
            onClick={() => setSubTab('discover')}
          >
            发现箱{discovered.length > 0 ? `（${discovered.length}）` : ''}
          </button>
          <button
            className={`recycle-tab${subTab === 'papers' ? ' active' : ''}`}
            onClick={() => setSubTab('papers')}
          >
            正式文献{papers.length > 0 ? `（${papers.length}）` : ''}
          </button>
        </div>
      </div>

      {subTab === 'discover' && (
        <div className="lit-list">
          {discovered.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">inbox</span>
              发现箱空空的——点「跑一轮海选」，AI 找到的论文候选会先出现在这里，由你决定是否入库
            </div>
          )}
          {discovered.map((it) => (
            <div className="lit-item" key={it.id}>
              <div className="row-main">
                <div className="row-title">{it.title}</div>
                <div className="row-sub">
                  {(it.authors.length ? it.authors.slice(0, 4).join(', ') : '佚名')}
                  {dateLabel(it) ? ` · ${dateLabel(it)}` : ''}
                  {` · ${it.language === 'zh' ? '中文' : '英文'}`}
                  {it.length_est ? ` · 约 ${it.length_est}` : ''}
                </div>
                {it.reason && <div className="lit-reason">「{it.reason}」</div>}
              </div>
              <div className="row-actions">
                <span className="badge">{sourceBadge(it.source)}</span>
                <button className="btn btn-primary" onClick={() => void accept(it.id)}>
                  接受
                </button>
                <button className="btn" onClick={() => void reject(it.id)}>
                  拒绝
                </button>
                <button className="icon-btn danger" title="彻底删除该条目" onClick={() => setDelDiscover(it)}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
          {(acceptedCount > 0 || rejectedCount > 0) && (
            <div className="lit-muted-row">
              已接受 {acceptedCount} · 已拒绝 {rejectedCount}（论文在正式文献区查看）
            </div>
          )}
        </div>
      )}

      {subTab === 'papers' && (
        <div className="lit-list">
          {papers.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">auto_stories</span>
              还没有正式文献——在发现箱「接受」候选后，论文会入库到这里
            </div>
          )}
          {papers.map((p) => (
            <div className="lit-item" key={p.id}>
              <div className="row-main" onClick={() => void openDetail(p.id)}>
                <div className="row-title">{p.title}</div>
                <div className="row-sub">
                  {(p.authors.length ? p.authors.slice(0, 4).join(', ') : '佚名')}
                  {dateLabel(p) ? ` · ${dateLabel(p)}` : ''}
                  {p.digest_md ? ' · 已有导读卡' : ''}
                </div>
              </div>
              <div className="row-actions">
                <span className={`badge ${p.status === 'ready' ? 'primary' : ''}`}>
                  {p.status === 'ready' ? '全文就绪' : '仅元信息'}
                </span>
                <button className="icon-btn danger" title="彻底删除文献" onClick={() => setDelPaper(p)}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 文献详情弹窗 */}
      {detail && (
        <div
          className="dialog-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && setDetail(null)}
        >
          <div className="dialog lit-detail" style={{ width: 640 }}>
            <div className="dialog-header">{detail.paper.title}</div>
            <div className="dialog-body">
              <div className="lit-meta">
                {(detail.paper.authors.length ? detail.paper.authors.slice(0, 6).join(', ') : '佚名')}
                {dateLabel(detail.paper) ? ` · ${dateLabel(detail.paper)}` : ''}
                {` · ${detail.paper.language === 'zh' ? '中文' : '英文'}`}
                <span className={`badge ${detail.paper.status === 'ready' ? 'primary' : ''}`} style={{ marginLeft: 8 }}>
                  {detail.paper.status === 'ready' ? '全文就绪' : '仅元信息'}
                </span>
                <span className="badge" style={{ marginLeft: 6 }}>{sourceBadge(detail.paper.source)}</span>
              </div>
              {detail.paper.summary && <div className="lit-summary">{detail.paper.summary}</div>}

              <div className="lit-actions">
                {KIND_META.map(({ kind, label }) => {
                  const row = interpOf(kind)
                  const busy = generating(kind)
                  return (
                    <span key={kind} className="lit-kind-group">
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          if (busy) return
                          if (row?.md_path) {
                            setViewMd({ title: `${label}：${detail.paper.title}`, filePath: row.md_path, tag: label })
                          } else {
                            generate(kind)
                          }
                        }}
                      >
                        <span className={`material-symbols-outlined${busy ? ' spin' : ''}`}>
                          {busy ? 'progress_activity' : row ? 'visibility' : 'auto_awesome'}
                        </span>
                        {busy ? `${label}生成中…` : row ? `查看${label}` : `生成${label}`}
                      </button>
                      {row && !busy && (
                        <button
                          className="icon-btn"
                          title={`重新生成${label}（覆盖现有产物）`}
                          onClick={() => setForceKind(kind)}
                        >
                          <span className="material-symbols-outlined">refresh</span>
                        </button>
                      )}
                    </span>
                  )
                })}
                {detail.paper.status === 'meta_only' && (
                  <button className="btn" onClick={() => void importPdf()}>
                    <span className="material-symbols-outlined">upload_file</span>
                    手动传 PDF
                  </button>
                )}
              </div>
              <div className="lit-hint">
                生成在后台进行、逐章落盘，完成后此处自动更新；重新生成将覆盖现有产物。
              </div>

              {detail.related.length > 0 && (
                <div className="lit-related">
                  <div className="setting-label">相关内容</div>
                  {detail.related.map((r) => (
                    <div
                      className="lit-related-row"
                      key={r.link_id}
                      onClick={() => {
                        if (r.peer_type === 'paper') void openDetail(r.peer_id)
                        else {
                          setDetail(null)
                          openRelated(r)
                        }
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
            </div>
            <div className="dialog-footer">
              <button
                className="btn btn-primary"
                onClick={() => {
                  void window.api.agent.askLiterature('paper', detail.paper.id)
                  onOpenAi?.()
                }}
                title="注入该文献上下文，在右栏「文献·追问」场景继续提问"
              >
                <span className="material-symbols-outlined">forum</span>
                追问
              </button>
              <button
                className="btn"
                onClick={() => setLinksOpen(true)}
                title="管理本文献的手动/语义关联"
              >
                <span className="material-symbols-outlined">hub</span>
                关联知识
              </button>
              <button className="btn btn-danger" onClick={() => setDelPaper(detail.paper)}>
                <span className="material-symbols-outlined">delete</span>
                删除文献
              </button>
              <button className="btn" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 解读产物查看（MdDialog：双击进编辑，实时渲染） */}
      {viewMd && (
        <MdDialog
          open
          title={viewMd.title}
          titleTag={viewMd.tag}
          filePath={viewMd.filePath}
          onClose={() => setViewMd(null)}
          onChanged={refreshDetail}
        />
      )}

      {/* 关联知识管理（批次F：双向列表 + 手动添加） */}
      <KnowledgeLinksDialog
        open={linksOpen && detail != null}
        srcType="paper"
        srcId={detail?.paper.id ?? 0}
        title={detail?.paper.title ?? ''}
        onClose={() => setLinksOpen(false)}
      />

      {/* 重生成确认 */}
      <ConfirmDialog
        open={forceKind !== null}
        title={`重新生成${forceKind === 'digest' ? '导读卡' : forceKind === 'lecture' ? '精讲' : '精译'}`}
        danger
        confirmText="重新生成"
        onConfirm={() => forceKind && generate(forceKind, true)}
        onCancel={() => setForceKind(null)}
      >
        已有生成产物，重新生成将覆盖现有内容（精讲/精译已生成部分会从头重写）。确定继续？
      </ConfirmDialog>

      {/* 删除文献确认（彻底删：连解读产物 md、全文/PDF 缓存、向量与链接） */}
      <ConfirmDialog
        open={delPaper !== null}
        title="删除文献"
        danger
        confirmText="彻底删除"
        onConfirm={() => void removePaper()}
        onCancel={() => setDelPaper(null)}
      >
        确认彻底删除《{delPaper?.title}》？其导读卡/精讲/精译产物、全文缓存与相关推荐将一并删除，不可恢复。
      </ConfirmDialog>

      {/* 删除发现条目确认 */}
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
    </div>
  )
}
