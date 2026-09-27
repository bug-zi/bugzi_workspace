// 文献面板（260924 自信息源拆入论文库模块；超级工作台 2.0 批次B + 260921 验证反馈）：
// 订阅 agent:status 推送实现海选/产物的列表实时刷新；发现箱与正式文献支持彻底删除（二次确认）。
// 260927：领域筛选行；正式文献行点击进入 PaperReader 主栏阅读视图（阅读态整页切换、头部隐藏，播客台同款）。
import { useCallback, useEffect, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import PaperReader from './PaperReader'
import type { AgentDomainRow, AgentStatusSnapshot, DiscoverItemRow, PaperRow } from '../../renderer/api'
import './literature.css'

type SubTab = 'discover' | 'papers'

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
  onOpenAi?: (prefill?: string) => void
  /** 跨模块深链（批次F）：置值时自动打开该文献阅读视图，消费后回调复位 */
  openPaperId?: number | null
  onOpenPaperConsumed?: () => void
}) {
  const { toast } = useToast()
  const [subTab, setSubTab] = useState<SubTab>('discover')
  const [items, setItems] = useState<DiscoverItemRow[]>([])
  const [papers, setPapers] = useState<PaperRow[]>([])
  // 抓取中文献 id 集（make_digest 在队/在跑派生，260928 三态化）
  const [fetchingIds, setFetchingIds] = useState<Set<number>>(new Set())
  const [domains, setDomains] = useState<AgentDomainRow[]>([])
  // 领域筛选（260927）：domainsAll=deep 轨全量（tab 数据源，含停用），domains=启用中（海选下拉）
  const [domainsAll, setDomainsAll] = useState<AgentDomainRow[]>([])
  const [domainFilter, setDomainFilter] = useState<'all' | number | 'none'>('all')
  const [collectDomain, setCollectDomain] = useState<number | null>(null)
  const [collecting, setCollecting] = useState(false)
  // 主栏阅读视图（260927 长文阅读视图化）：阅读对象 paperId；null=列表态
  const [readingId, setReadingId] = useState<number | null>(null)
  const [delPaper, setDelPaper] = useState<PaperRow | null>(null)
  const [delDiscover, setDelDiscover] = useState<DiscoverItemRow | null>(null)

  const loadDiscover = useCallback((): void => {
    void window.api.agent.discoverList().then(setItems)
  }, [])
  const loadPapers = useCallback((): void => {
    void window.api.agent.papers().then(setPapers)
    // 抓取中派生态（260928 三态化）：make_digest 在队/在跑的文献 id 集
    void window.api.agent.activeTasks().then((rows) => {
      setFetchingIds(new Set(rows.filter((t) => t.type === 'make_digest' && t.refId != null).map((t) => t.refId as number)))
    })
  }, [])
  const loadDomains = useCallback((): void => {
    void window.api.agent.domains().then((ds) => {
      const deep = ds.filter((d) => d.track === 'deep')
      setDomainsAll(deep)
      const deepEnabled = deep.filter((d) => d.enabled)
      setDomains(deepEnabled)
      setCollectDomain((cur) => cur ?? deepEnabled[0]?.id ?? null)
    })
  }, [])

  useEffect(() => {
    loadDiscover()
    loadPapers()
    loadDomains()
  }, [loadDiscover, loadPapers, loadDomains])

  // 实时刷新（260921 验证反馈）：队列事件随 agent:status 推送，增量刷新列表（阅读视图内的详情刷新在 PaperReader）
  useEffect(() => {
    const off = window.api.agent.onAgentStatus((s: AgentStatusSnapshot) => {
      const ev = s.lastEvent
      if (!ev) return
      // 入队事件也要刷「抓取中」徽章（260928 三态化）；其余终态照旧
      if (ev.status === 'enqueued') {
        if (ev.type === 'make_digest') loadPapers()
        return
      }
      if (ev.type === 'collect_deep') {
        loadDiscover()
        toast(ev.status === 'done' ? '海选完成，发现箱已更新' : '海选任务失败，详见控制台 [agent] 日志')
      } else if (ev.type === 'make_digest' || ev.type === 'lecture' || ev.type === 'translate') {
        loadPapers()
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

  // 跨模块深链（批次F）：相关内容/知识网络点击 → 直达阅读视图
  useEffect(() => {
    if (openPaperId == null) return
    const id = openPaperId
    onOpenPaperConsumed?.()
    setReadingId(id)
  }, [openPaperId])

  // 信息源·发现箱只呈论文候选（260923 开发者反馈：科普候选归万象库科普页签）
  // 领域筛选（260927）：domain_id 为 NULL 或不在现存领域集合的条目一律归「未分类」
  const isUncategorized = (id: number | null): boolean => id == null || !domainsAll.some((d) => d.id === id)
  const matchDomain = (id: number | null): boolean => {
    if (domainFilter === 'all') return true
    if (domainFilter === 'none') return isUncategorized(id)
    return id === domainFilter
  }
  const discoveredAll = items.filter((i) => i.status === 'discovered' && i.source_type !== 'article')
  const discovered = discoveredAll.filter((i) => matchDomain(i.domain_id))
  const papersFiltered = papers.filter((p) => matchDomain(p.domain_id))
  // tab 计数口径：当前子页签筛选前列表；发现箱/正式文献共用同一筛选状态
  const scopeList: { domain_id: number | null }[] = subTab === 'discover' ? discoveredAll : papers
  const domainCount = (id: number): number => scopeList.filter((it) => it.domain_id === id).length
  const uncategorizedCount = scopeList.filter((it) => isUncategorized(it.domain_id)).length
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
    loadPapers()
    loadDiscover()
  }

  // 阅读视图（260927 长文阅读视图化）：整页切换、模块头部不渲染（播客台 EpisodeReader 同款）
  if (readingId !== null) {
    return (
      <PaperReader
        key={readingId}
        paperId={readingId}
        onBack={() => setReadingId(null)}
        onChanged={() => {
          loadPapers()
          loadDiscover()
        }}
        onOpenPaper={(id) => setReadingId(id)}
        onOpenAi={onOpenAi}
      />
    )
  }

  return (
    <div className="module-page" style={{ maxWidth: 1200 }}>
      <div className="module-header">
        <span className="material-symbols-outlined">library_books</span>
        <span className="module-title">论文库</span>
        <span className="module-sub">发现箱 · 正式文献</span>
      </div>

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
            发现箱{discoveredAll.length > 0 ? `（${discoveredAll.length}）` : ''}
          </button>
          <button
            className={`recycle-tab${subTab === 'papers' ? ' active' : ''}`}
            onClick={() => setSubTab('papers')}
          >
            正式文献{papers.length > 0 ? `（${papers.length}）` : ''}
          </button>
        </div>
        {/* 领域筛选行（260927）：两子页签共用，切换子页签保持所选领域 */}
        {scopeList.length > 0 && (
          <div className="recycle-tabs domain-tabs">
            <button
              className={`recycle-tab${domainFilter === 'all' ? ' active' : ''}`}
              onClick={() => setDomainFilter('all')}
            >
              全部（{scopeList.length}）
            </button>
            {domainsAll.map((d) => (
              <button
                key={d.id}
                className={`recycle-tab${domainFilter === d.id ? ' active' : ''}`}
                onClick={() => setDomainFilter(d.id)}
              >
                {d.name}（{domainCount(d.id)}）
              </button>
            ))}
            <button
              className={`recycle-tab${domainFilter === 'none' ? ' active' : ''}`}
              onClick={() => setDomainFilter('none')}
            >
              未分类（{uncategorizedCount}）
            </button>
          </div>
        )}
      </div>

      {subTab === 'discover' && (
        <div className="lit-list">
          {discovered.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">inbox</span>
              {domainFilter === 'all'
                ? '发现箱空空的——点「跑一轮海选」，AI 找到的论文候选会先出现在这里，由你决定是否入库'
                : '该领域下暂无候选'}
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
          {papersFiltered.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">auto_stories</span>
              {domainFilter === 'all'
                ? '还没有正式文献——在发现箱「接受」候选后，论文会入库到这里'
                : '该领域下暂无文献'}
            </div>
          )}
          {papersFiltered.map((p) => (
            <div className="lit-item" key={p.id}>
              <div className="row-main" onClick={() => setReadingId(p.id)} title="点击进入阅读视图">
                <div className="row-title">{p.title}</div>
                <div className="row-sub">
                  {(p.authors.length ? p.authors.slice(0, 4).join(', ') : '佚名')}
                  {dateLabel(p) ? ` · ${dateLabel(p)}` : ''}
                  {p.digest_md ? ' · 已有导读卡' : ''}
                </div>
              </div>
              <div className="row-actions">
                <span className={`badge ${p.status === 'ready' ? 'primary' : ''}`}>
                  {p.status === 'ready' ? '全文就绪' : fetchingIds.has(p.id) ? '抓取中…' : '仅元信息'}
                </span>
                <button className="icon-btn danger" title="彻底删除文献" onClick={() => setDelPaper(p)}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 删除文献确认（列表行入口；阅读视图内删除在 PaperReader） */}
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
