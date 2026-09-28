// 科普页签（超级工作台 2.0 批次D spec §6）：跑一轮科普海选卡 + 发现箱/正式文章双子页签 + 领域筛选行；
// 正式文章行点击进入 ScienceReader 主栏阅读视图（260927 长文阅读视图化，详情弹窗移除）。
// 词条跳转/建词条经 WikiModule 注入回调（onOpenEntry / onCreateEntry），保持生成链路单点。
import { useCallback, useEffect, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import ScienceReader from './ScienceReader'
import type { AgentDomainRow, AgentStatusSnapshot, DiscoverItemRow, ScienceArticleRow } from '../../renderer/api'
import './science.css'

export interface SciencePanelProps {
  /** 划词问 AI（模块默认频道） */
  onOpenAi: (prefill?: string) => void
  /** 展开右栏（追问后跟随） */
  bumpAi: () => void
  /** 打开词条弹窗（词条命中 / 建词条成功后） */
  onOpenEntry: (entryId: number) => void
  /** 建词条（走万象手动生成链路；成功返回 entryId，冲突返回 null） */
  onCreateEntry: (term: string, sectionId: number | null) => Promise<number | null>
  /** 「出自科普文章」回链跳转入口：置值时打开该文阅读视图，消费后回调复位 */
  openArticleId: number | null
  onOpenArticleConsumed: () => void
}

export default function SciencePanel(props: SciencePanelProps) {
  const { toast } = useToast()
  const [articles, setArticles] = useState<ScienceArticleRow[]>([])
  const [candidates, setCandidates] = useState<DiscoverItemRow[]>([])
  const [delDiscover, setDelDiscover] = useState<DiscoverItemRow | null>(null)
  const [domains, setDomains] = useState<AgentDomainRow[]>([])
  // 领域筛选（260927）：domainsAll=science 轨全量（tab 数据源，含停用），domains=启用中（海选下拉）
  const [domainsAll, setDomainsAll] = useState<AgentDomainRow[]>([])
  const [domainFilter, setDomainFilter] = useState<'all' | number | 'none'>('all')
  const [collectDomain, setCollectDomain] = useState<number | null>(null)
  const [collecting, setCollecting] = useState(false)
  // 子页签（260923 反馈：发现箱/正式文章分页签，同信息源文献页签口径）
  const [subTab, setSubTab] = useState<'discover' | 'articles'>('discover')
  // 主栏阅读视图（260927 长文阅读视图化）：阅读对象 articleId；null=列表态
  const [readingId, setReadingId] = useState<number | null>(null)
  const [delTarget, setDelTarget] = useState<ScienceArticleRow | null>(null)
  // 抓取中文章 id 集（science_fetch 在队/在跑派生，260928 三态化）
  const [fetchingIds, setFetchingIds] = useState<Set<number>>(new Set())

  const loadArticles = useCallback((): void => {
    void window.api.science.list().then(setArticles)
    // 抓取中派生态（260928 三态化）：science_fetch 在队/在跑的文章 id 集
    void window.api.agent.activeTasks().then((rows) => {
      setFetchingIds(new Set(rows.filter((t) => t.type === 'science_fetch' && t.refId != null).map((t) => t.refId as number)))
    })
  }, [])
  // 发现箱（260923 修订：科普候选自信息源文献页签迁入本页签，接受/拒绝在此完成）
  const loadCandidates = useCallback((): void => {
    void window.api.agent
      .discoverList()
      .then((rows) => setCandidates(rows.filter((r) => r.source_type === 'article' && r.status === 'discovered')))
  }, [])
  const loadDomains = useCallback((): void => {
    void window.api.agent.domains().then((ds) => {
      const sci = ds.filter((d) => d.track === 'science')
      setDomainsAll(sci)
      const sciEnabled = sci.filter((d) => d.enabled)
      setDomains(sciEnabled)
      setCollectDomain((cur) => cur ?? sciEnabled[0]?.id ?? null)
    })
  }, [])

  useEffect(() => {
    loadArticles()
    loadCandidates()
    loadDomains()
  }, [loadArticles, loadCandidates, loadDomains])

  // 实时刷新：海选完成 → 列表（阅读视图内的详情刷新在 ScienceReader）
  useEffect(() => {
    const off = window.api.agent.onAgentStatus((s: AgentStatusSnapshot) => {
      const ev = s.lastEvent
      if (!ev) return
      // 入队事件也要刷「抓取中」徽章（260928 三态化）
      if (ev.status === 'enqueued') {
        if (ev.type === 'science_fetch') loadArticles()
        return
      }
      if (ev.type === 'collect_science') {
        loadArticles()
        loadCandidates()
        toast(ev.status === 'done' ? '科普海选完成，发现箱已更新' : '科普海选失败，详见控制台 [agent] 日志')
      } else if (ev.type === 'science_fetch') {
        loadArticles()
      } else if (ev.type === 'science_digest' || ev.type === 'science_deepread') {
        loadArticles()
        if (ev.status === 'failed') toast('解读任务失败，详见控制台 [agent] 日志')
      }
    })
    return off
  }, [loadArticles, loadCandidates, toast])

  // 「出自科普文章」回链跳转入口 → 直达阅读视图
  useEffect(() => {
    if (props.openArticleId == null) return
    const id = props.openArticleId
    props.onOpenArticleConsumed()
    setReadingId(id)
  }, [props.openArticleId])

  // ---------- 领域筛选（260927：NULL 或不在现存领域集合的条目一律归「未分类」） ----------

  const isUncategorized = (id: number | null): boolean => id == null || !domainsAll.some((d) => d.id === id)
  const matchDomain = (id: number | null): boolean => {
    if (domainFilter === 'all') return true
    if (domainFilter === 'none') return isUncategorized(id)
    return id === domainFilter
  }
  const candidatesFiltered = candidates.filter((it) => matchDomain(it.domain_id))
  const articlesFiltered = articles.filter((a) => matchDomain(a.domain_id))
  // tab 计数口径：当前子页签筛选前列表；发现箱/正式文章共用同一筛选状态
  const scopeList: { domain_id: number | null }[] = subTab === 'discover' ? candidates : articles
  const domainCount = (id: number): number => scopeList.filter((it) => it.domain_id === id).length
  const uncategorizedCount = scopeList.filter((it) => isUncategorized(it.domain_id)).length

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

  // ---------- 发现箱候选（接受 / 拒绝 / 删除） ----------

  const acceptCandidate = async (id: number): Promise<void> => {
    try {
      await window.api.agent.discoverAccept(id)
      toast('已转正，全文抓取中（就绪后可打开）')
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

  // 阅读视图（260927 长文阅读视图化）：页签容器内整页切换（万象库头部/页签仍可见，可直达百科）
  if (readingId !== null) {
    return (
      <ScienceReader
        key={readingId}
        articleId={readingId}
        onBack={() => setReadingId(null)}
        onChanged={loadArticles}
        onOpenAi={props.onOpenAi}
        bumpAi={props.bumpAi}
        onOpenEntry={props.onOpenEntry}
        onCreateEntry={props.onCreateEntry}
      />
    )
  }

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

      {/* 发现箱（科普候选） */}
      {subTab === 'discover' && (
        <div className="sci-list">
          {candidatesFiltered.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">inbox</span>
              {domainFilter === 'all'
                ? '发现箱空空的——点「跑一轮科普海选」，AI 找到的候选会先出现在这里，由你决定是否入库'
                : '该领域下暂无候选'}
            </div>
          )}
          {candidatesFiltered.map((it) => (
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

      {/* 正式文章（转正入库，自动解读）；行点击进阅读视图 */}
      {subTab === 'articles' && (
        <div className="sci-list">
          {articlesFiltered.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">science</span>
              {domainFilter === 'all'
                ? '还没有科普文章——在发现箱「接受」候选后，文章会入库到这里并自动解读'
                : '该领域下暂无文章'}
            </div>
          )}
          {articlesFiltered.map((a) => {
            const fetching = fetchingIds.has(a.id)
            return (
              <div
                className="sci-item"
                key={a.id}
                title={a.status === 'ready' ? '点击进入阅读视图' : fetching ? '抓取中，暂不可打开' : '抓取失败，可重试抓取'}
                onClick={() => {
                  if (a.status !== 'ready') {
                    toast(fetching ? '全文抓取中，就绪后即可打开' : '全文尚未就绪——可先在行内「重试抓取」')
                    return
                  }
                  setReadingId(a.id)
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
                    {a.status === 'ready' ? '全文就绪' : fetching ? '抓取中…' : '抓取失败'}
                  </span>
                  {a.status !== 'ready' && (
                    <button
                      className="btn"
                      disabled={fetching}
                      title={fetching ? '抓取任务进行中' : '重新抓取全文；英文文章会自动翻译成中文'}
                      onClick={() =>
                        void window.api.science
                          .retryFetch(a.id)
                          .then(() => toast('重试抓取中，就绪后可打开'))
                          .catch((e) => toast(`重试失败：${(e as Error).message}`))
                      }
                    >
                      重试抓取
                    </button>
                  )}
                  <button className="icon-btn danger" title="彻底删除" onClick={() => setDelTarget(a)}>
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 删除确认（列表行入口；阅读视图内删除在 ScienceReader。彻底删：连解读产物/高光/链接/全文缓存） */}
      <ConfirmDialog
        open={delTarget !== null}
        title="删除科普文章"
        danger
        confirmText="彻底删除"
        onConfirm={() => {
          const t = delTarget
          setDelTarget(null)
          if (!t) return
          void window.api.science.delete(t.id).then(() => {
            toast('科普文章已彻底删除（含解读产物与高光）')
            loadArticles()
          })
        }}
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
    </div>
  )
}
