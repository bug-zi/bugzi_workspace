// 播客台模块（播客台 specs §4.1）：双页签「单集流｜节目」——读文字稿的学习模块，零音频播放
// 订阅（iTunes 搜索 / RSS 直链）→ 自动收新集 → 文字稿转写（RSS 自带优先 / ASR 兜底，主进程串行队列）
// → 阅读视图导读卡 + 「播客·追问」频道。删除/退订二次确认；不入回收站（信息源先例）
import { useCallback, useEffect, useState } from 'react'
import { SettingsKeys, parseAsrConfig } from '../../shared/types'
import type { PodcastEpisodeSummary, PodcastEpisodeView, PodcastFeed } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import ActionMenu from '../../components/ActionMenu'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import AddFeedDialog from './AddFeedDialog'
import EpisodeReader from './EpisodeReader'
import './podcast.css'

interface Props {
  onOpenAi: (prefill?: string, opts?: { auto?: boolean; channel?: import('../../shared/types').AiChannel }) => void
  onNavigateToProfile: () => void
}

function fmtDuration(sec: number | null): string {
  if (sec == null || sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 转写状态徽章（done 无徽章 = 就绪可读） */
function StateBadge({ ep }: { ep: PodcastEpisodeSummary }) {
  const s = ep.transcript_state
  if (s === 'done') return null
  if (s === 'queued') return <span className="pc-badge">排队中</span>
  if (s === 'downloading') return <span className="pc-badge pc-badge-busy">下载中</span>
  if (s === 'transcribing')
    return (
      <span className="pc-badge pc-badge-busy">
        <span className="material-symbols-outlined spin">progress_activity</span>转写中
      </span>
    )
  if (s === 'polishing')
    return (
      <span className="pc-badge pc-badge-busy" title="转写已完成，AI 正在整理排版">
        <span className="material-symbols-outlined spin">progress_activity</span>排版中
      </span>
    )
  if (s === 'failed')
    return (
      <span className="pc-badge pc-badge-err" title={ep.transcript_error ?? '转写失败'}>
        转写失败
      </span>
    )
  return (
    <span
      className="pc-badge pc-badge-idle"
      title={ep.has_rss_transcript ? '节目自带文字稿，点击直接抓取阅读（免 ASR、零费用）' : '无自带文字稿，需在个人档配置 ASR 后点击转写'}
    >
      {ep.has_rss_transcript ? '自带文字稿' : '需 ASR'}
    </span>
  )
}

export default function PodcastModule(props: Props) {
  const { toast } = useToast()
  const [tab, setTab] = useState<'episodes' | 'feeds'>('episodes')
  const [feeds, setFeeds] = useState<PodcastFeed[]>([])
  const [episodes, setEpisodes] = useState<PodcastEpisodeSummary[]>([])
  // 节目筛选（全部=null；节目页签点卡落到本视图带过滤）
  const [feedFilter, setFeedFilter] = useState<number | null>(null)
  // 收件箱视图（260925 归档制；260926 增收藏）：inbox=未读未收藏（默认）/ archived=已读未收藏 / all=全部 / starred=收藏
  const [view, setView] = useState<PodcastEpisodeView>('inbox')
  // 阅读视图（主栏整体切换，信息源同款）
  const [readingId, setReadingId] = useState<number | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // 二次确认目标
  const [delEpTarget, setDelEpTarget] = useState<PodcastEpisodeSummary | null>(null)
  const [delFeedTarget, setDelFeedTarget] = useState<PodcastFeed | null>(null)
  // ASR 未配置引导（手动触发转写且该集无 RSS 自带文字稿时入队前校验，design §五）
  const [asrConfigOpen, setAsrConfigOpen] = useState(false)
  // 订阅筛选下拉锚定（ActionMenu anchorEl；点项时 ActionMenu 先 onClose 再 onClick，自动收起）
  const [filterMenuAnchor, setFilterMenuAnchor] = useState<HTMLElement | null>(null)

  /** 需 ASR 的转写触发前校验：配置齐备返回 true，否则弹「去配置」返回 false（不入队空跑） */
  const ensureAsrOrDialog = async (): Promise<boolean> => {
    const cfg = parseAsrConfig(await window.api.settings.get(SettingsKeys.AsrConfig))
    if (cfg.apiUrl && cfg.apiKey && cfg.model) return true
    setAsrConfigOpen(true)
    return false
  }

  const loadFeeds = useCallback(async (): Promise<void> => {
    try {
      setFeeds(await window.api.podcast.feedsList())
    } catch {
      /* 列表失败静默（行内已有错误态兜底） */
    }
  }, [])

  const loadEpisodes = useCallback(
    async (filter: number | null, v: PodcastEpisodeView): Promise<void> => {
      try {
        setEpisodes(await window.api.podcast.episodes(filter, v))
      } catch {
        /* 静默 */
      }
    },
    []
  )

  const load = useCallback(async (): Promise<void> => {
    await Promise.all([loadFeeds(), loadEpisodes(feedFilter, view)])
  }, [loadFeeds, loadEpisodes, feedFilter, view])

  /** 进模块/手动刷新：拉全部源新集（auto_transcribe=1 的新集自动入队）+ 双列表刷新 */
  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      const added = await window.api.podcast.fetchAll()
      if (added > 0) toast(`新收 ${added} 集单集`)
      await load()
    } catch (e) {
      toast(`拉取失败：${(e as Error).message}`)
    } finally {
      setRefreshing(false)
    }
  }, [load, toast])

  useEffect(() => {
    void load()
  }, [load])
  useModuleActivated('podcast', () => void refresh())

  // 转写状态推送 → 单集流渐进刷新（徽章流转；不重拉节目列表）
  useEffect(() => {
    const off = window.api.podcast.onTaskChanged(() => void loadEpisodes(feedFilter, view))
    return off
  }, [loadEpisodes, feedFilter, view])

  const openEpisode = async (ep: PodcastEpisodeSummary): Promise<void> => {
    if (ep.transcript_state === 'done') {
      setReadingId(ep.id)
      return
    }
    if (ep.transcript_state === 'none' || ep.transcript_state === 'failed') {
      // 该集无 RSS 自带文字稿（将走 ASR）→ 先校验 ASR 配置（未配置弹「去配置」，不入队空跑）
      if (!ep.has_rss_transcript && !(await ensureAsrOrDialog())) return
      try {
        await window.api.podcast.transcribe(ep.id)
        setEpisodes((arr) =>
          arr.map((e) => (e.id === ep.id ? { ...e, transcript_state: 'queued' as const, transcript_error: null } : e))
        )
      } catch (e) {
        toast(`操作失败：${(e as Error).message}`)
      }
    }
    // queued/downloading/transcribing 点击无操作（徽章自会流转）
  }

  const toggleRead = async (ep: PodcastEpisodeSummary): Promise<void> => {
    try {
      await window.api.podcast.episodeRead(ep.id, ep.read_at == null)
      // 按当前视图重取：收件箱里标已读 = 归档出流（行消失），已归档里「再看看」= 回收件箱
      await loadEpisodes(feedFilter, view)
      void loadFeeds()
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`)
    }
  }

  const toggleStar = async (ep: PodcastEpisodeSummary): Promise<void> => {
    try {
      await window.api.podcast.episodeStar(ep.id, ep.starred_at == null)
      // 收藏出流：按当前视图重取（inbox 收藏 = 出流消失；starred 取消收藏 = 行消失）
      await loadEpisodes(feedFilter, view)
      void loadFeeds()
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`)
    }
  }

  const cancelTranscribe = async (ep: PodcastEpisodeSummary): Promise<void> => {
    try {
      await window.api.podcast.transcribeCancel(ep.id)
      setEpisodes((arr) =>
        arr.map((e) => (e.id === ep.id ? { ...e, transcript_state: 'none' as const, transcript_error: null } : e))
      )
      toast('已取消转写，可重新触发')
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`)
    }
  }

  /** 收件箱一键清空（全部标已读 = 归档；可随时在「已归档」视图「再看看」恢复） */
  const doMarkAllRead = async (): Promise<void> => {
    try {
      const n = await window.api.podcast.markAllRead(feedFilter)
      toast(n > 0 ? `已归档 ${n} 集` : '收件箱已是空的')
      await Promise.all([loadFeeds(), loadEpisodes(feedFilter, view)])
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`)
    }
  }

  const doDeleteEpisode = async (): Promise<void> => {
    if (!delEpTarget) return
    await window.api.podcast.episodeDelete(delEpTarget.id)
    toast('已删除单集')
    setDelEpTarget(null)
    await load()
  }

  const doDeleteFeed = async (): Promise<void> => {
    if (!delFeedTarget) return
    await window.api.podcast.feedsDelete(delFeedTarget.id)
    toast('已退订并删除该节目全部单集')
    if (feedFilter === delFeedTarget.id) setFeedFilter(null)
    setDelFeedTarget(null)
    await load()
  }

  const toggleAutoTranscribe = async (f: PodcastFeed): Promise<void> => {
    try {
      await window.api.podcast.feedsUpdate(f.id, { auto_transcribe: !f.auto_transcribe })
      setFeeds((arr) => arr.map((x) => (x.id === f.id ? { ...x, auto_transcribe: !f.auto_transcribe } : x)))
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`)
    }
  }

  const backToList = (): void => {
    setReadingId(null)
    void load()
  }

  const filterFeed = feeds.find((f) => f.id === feedFilter) ?? null
  const inboxTotal = feeds.reduce((n, f) => n + f.unread, 0)

  // ----- 阅读视图（主栏整体切换） -----
  if (readingId != null) {
    return (
      <EpisodeReader
        episodeId={readingId}
        onBack={backToList}
        onChanged={() => void load()}
        onOpenAi={props.onOpenAi}
        onNavigateToProfile={props.onNavigateToProfile}
      />
    )
  }

  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">podcasts</span>
        <span className="module-title">播客台</span>
        <span className="module-sub">订阅播客读文字稿 · AI 导读 · 追问讨论（本模块只负责「看」，不听）</span>
      </div>

      {/* 双页签（选择不持久化，wiki 双页签同款） */}
      <div className="recycle-tabs">
        <button className={`recycle-tab${tab === 'episodes' ? ' active' : ''}`} onClick={() => setTab('episodes')}>
          单集流
        </button>
        <button className={`recycle-tab${tab === 'feeds' ? ' active' : ''}`} onClick={() => setTab('feeds')}>
          节目{feeds.length > 0 ? `(${feeds.length})` : ''}
        </button>
      </div>

      {tab === 'episodes' ? (
        <>
          {/* 单行工具栏：操作按钮 + 视图 chips（钉位零位移）+ 清空收件箱 + 订阅筛选下拉（右对齐收束） */}
          <div className="pc-toolbar">
            <button className="btn" onClick={() => void refresh()} disabled={refreshing} title="拉取全部订阅的新集">
              <span className="material-symbols-outlined">{refreshing ? 'progress_activity spin' : 'refresh'}</span>
              刷新
            </button>
            <button className="btn" onClick={() => setAddOpen(true)}>
              <span className="material-symbols-outlined">add</span>添加订阅
            </button>
            <div className="pc-views">
              <button
                className={`pc-filter-chip${view === 'inbox' ? ' active' : ''}`}
                onClick={() => setView('inbox')}
                title="未读单集（标已读即归档出流）"
              >
                收件箱{inboxTotal > 0 ? ` ${inboxTotal}` : ''}
              </button>
              <button
                className={`pc-filter-chip${view === 'archived' ? ' active' : ''}`}
                onClick={() => setView('archived')}
              >
                已归档
              </button>
              <button className={`pc-filter-chip${view === 'all' ? ' active' : ''}`} onClick={() => setView('all')}>
                全部
              </button>
              <button
                className={`pc-filter-chip${view === 'starred' ? ' active' : ''}`}
                onClick={() => setView('starred')}
                title="收藏的单集（收件箱不再显示，未读计数不计）"
              >
                收藏
              </button>
              {view === 'inbox' && inboxTotal > 0 && (
                <button
                  className="btn"
                  onClick={() => void doMarkAllRead()}
                  title="全部标已读（归档到「已归档」，可随时「再看看」恢复）"
                >
                  <span className="material-symbols-outlined">done_all</span>
                  清空收件箱
                </button>
              )}
            </div>
            <button
              className={`pc-filter-chip pc-feed-select${feedFilter != null ? ' active' : ''}`}
              onClick={(e) => setFilterMenuAnchor(e.currentTarget)}
              title="按节目筛选单集流"
            >
              <span className="material-symbols-outlined">filter_list</span>
              <span className="pc-feed-select-label">
                {feedFilter == null ? '全部节目' : (filterFeed?.title ?? '全部节目')}
              </span>
              <span className="material-symbols-outlined">expand_more</span>
            </button>
          </div>

          {filterMenuAnchor && (
            <ActionMenu
              anchorEl={filterMenuAnchor}
              onClose={() => setFilterMenuAnchor(null)}
              items={[
                {
                  key: 'all',
                  icon: feedFilter == null ? 'check' : undefined,
                  label: '全部节目',
                  onClick: () => setFeedFilter(null)
                },
                ...feeds.map((f) => ({
                  key: String(f.id),
                  icon: feedFilter === f.id ? 'check' : undefined,
                  label: f.unread > 0 ? `${f.title}（${f.unread} 未读）` : f.title,
                  onClick: () => setFeedFilter(f.id)
                }))
              ]}
            />
          )}

          <div className="pc-ep-list">
            {episodes.length === 0 && (
              <div className="empty-state">
                <span className="material-symbols-outlined">podcasts</span>
                {feeds.length === 0
                  ? '还没有订阅，点「添加订阅」开始'
                  : view === 'inbox'
                    ? '收件箱已清空——新到的单集会自动进这里'
                    : view === 'archived'
                      ? '还没有归档的单集（标已读即归档）'
                      : view === 'starred'
                        ? '还没有收藏的单集——点单集行内的星标收藏'
                        : feedFilter == null
                          ? '暂无单集'
                          : `「${filterFeed?.title ?? ''}」暂无单集`}
              </div>
            )}
            {episodes.map((ep) => (
              <div key={ep.id} className={`pc-ep-row${ep.read_at ? '' : ' unread'}`} onClick={() => void openEpisode(ep)}>
                <span className={`pc-read-dot${ep.read_at ? ' read' : ''}`} title={ep.read_at ? '已读' : '未读'} />
                <div className="pc-ep-main">
                  <div className="pc-ep-title">{ep.title}</div>
                  <div className="pc-ep-sub">
                    <span>{ep.feed_title}</span>
                    <span>{fmtDate(ep.published_at)}</span>
                    {ep.duration_sec != null && ep.duration_sec > 0 && <span>{fmtDuration(ep.duration_sec)}</span>}
                    <StateBadge ep={ep} />
                  </div>
                </div>
                <div className="pc-ep-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="icon-btn"
                    title={ep.starred_at ? '取消收藏（按已读状态回流）' : '收藏（移入收藏页签，收件箱不再显示）'}
                    onClick={() => void toggleStar(ep)}
                  >
                    <span
                      className="material-symbols-outlined"
                      style={
                        ep.starred_at
                          ? { color: 'var(--color-primary)', fontVariationSettings: "'FILL' 1" }
                          : undefined
                      }
                    >
                      star
                    </span>
                  </button>
                  <button
                    className="icon-btn"
                    title={ep.read_at ? '标未读' : '标已读'}
                    onClick={() => void toggleRead(ep)}
                  >
                    <span className="material-symbols-outlined">{ep.read_at ? 'mark_email_unread' : 'mark_email_read'}</span>
                  </button>
                  {(ep.transcript_state === 'none' || ep.transcript_state === 'failed') && (
                    <button className="icon-btn" title="转写本集" onClick={() => void openEpisode(ep)}>
                      <span className="material-symbols-outlined">speech_to_text</span>
                    </button>
                  )}
                  {(ep.transcript_state === 'queued' ||
                    ep.transcript_state === 'downloading' ||
                    ep.transcript_state === 'transcribing') && (
                    <button
                      className="icon-btn"
                      title="取消转写（回到待转写，可重新触发）"
                      onClick={() => void cancelTranscribe(ep)}
                    >
                      <span className="material-symbols-outlined">stop_circle</span>
                    </button>
                  )}
                  <button className="icon-btn danger" title="删除单集" onClick={() => setDelEpTarget(ep)}>
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="pc-feed-list">
          {feeds.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">podcasts</span>
              还没有订阅节目，点上方「添加订阅」开始
            </div>
          )}
          {feeds.map((f) => (
            <div key={f.id} className="pc-feed-card" onClick={() => { setFeedFilter(f.id); setTab('episodes') }} title="查看该节目单集流">
              {f.artwork_url ? (
                <img className="pc-feed-cover" src={f.artwork_url} alt="" />
              ) : (
                <span className="pc-feed-cover pc-feed-cover-empty">
                  <span className="material-symbols-outlined">podcasts</span>
                </span>
              )}
              <div className="pc-feed-main">
                <div className="pc-feed-title">{f.title}</div>
                <div className="pc-feed-sub">
                  {f.artist && <span>{f.artist}</span>}
                  <span>{f.unread > 0 ? `${f.unread} 集未读` : '已全部读完'}</span>
                  {f.rss_transcripts > 0 && <span>{f.rss_transcripts} 集自带文字稿</span>}
                  <span>{f.untranscribed > 0 ? `${f.untranscribed} 集待转写（需 ASR）` : '无需 ASR'}</span>
                </div>
                {f.fetch_error && <div className="pc-feed-err" title={f.fetch_error}>上次拉取失败：{f.fetch_error}</div>}
              </div>
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.85em', flexShrink: 0 }}
                onClick={(e) => e.stopPropagation()}
                title="开启后新到的单集自动排入转写队列（不回溯存量集）"
              >
                <input
                  type="checkbox"
                  checked={f.auto_transcribe}
                  onChange={() => void toggleAutoTranscribe(f)}
                  style={{ accentColor: 'var(--color-primary)' }}
                />
                自动转写新集
              </label>
              <button
                className="icon-btn danger"
                title="退订"
                onClick={(e) => {
                  e.stopPropagation()
                  setDelFeedTarget(f)
                }}
              >
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
          ))}
        </div>
      )}

      <AddFeedDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => void load()}
      />

      <GoConfigDialog
        open={asrConfigOpen}
        kind="asr"
        onGoConfig={() => {
          setAsrConfigOpen(false)
          props.onNavigateToProfile()
        }}
        onCancel={() => setAsrConfigOpen(false)}
      />

      <ConfirmDialog
        open={delEpTarget != null}
        title="删除单集"
        danger
        confirmText="删除"
        onConfirm={() => void doDeleteEpisode()}
        onCancel={() => setDelEpTarget(null)}
      >
        将彻底删除单集「{delEpTarget?.title ?? ''}」（含文字稿与导读卡），不经过回收站，删除后无法恢复。
      </ConfirmDialog>
      <ConfirmDialog
        open={delFeedTarget != null}
        title="退订节目"
        danger
        confirmText="退订"
        onConfirm={() => void doDeleteFeed()}
        onCancel={() => setDelFeedTarget(null)}
      >
        退订「{delFeedTarget?.title ?? ''}」将连删该节目全部单集与文字稿，不经过回收站，删除后无法恢复。
      </ConfirmDialog>
    </div>
  )
}
