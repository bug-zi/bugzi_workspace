// 信息源（信息源 specs §3）：源列表 + 文章列表三段式 + 阅读视图（主栏内切换）
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArticleSummary, FeedRecord } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import ArticleView, { relTime } from './ArticleView'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import './feed.css'

type FeedWithUnread = FeedRecord & { unread: number }

export default function FeedModule(props: { onNavigateToProfile?: () => void }) {
  const { toast } = useToast()
  const [feeds, setFeeds] = useState<FeedWithUnread[]>([])
  const [activeFeed, setActiveFeed] = useState<number | null>(null)
  const [articles, setArticles] = useState<ArticleSummary[]>([])
  const [fetching, setFetching] = useState(false)
  const [readingId, setReadingId] = useState<number | null>(null)
  const [readingArticle, setReadingArticle] = useState<Awaited<ReturnType<typeof window.api.articles.open>> | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addUrl, setAddUrl] = useState('')
  const [probing, setProbing] = useState(false)
  const [probed, setProbed] = useState<{ title: string; siteUrl: string } | null>(null)
  const [removeTarget, setRemoveTarget] = useState<FeedWithUnread | null>(null)
  const [renameTarget, setRenameTarget] = useState<FeedWithUnread | null>(null)
  const [renameText, setRenameText] = useState('')
  const fetchingRef = useRef(false)

  const load = useCallback(async () => {
    const [fs, as] = await Promise.all([window.api.feeds.list(), window.api.articles.list(activeFeed)])
    setFeeds(fs)
    setArticles(as)
  }, [activeFeed])

  /** 拉取全部源 + 刷新（进模块自动 + 手动刷新共用） */
  const refresh = useCallback(async (): Promise<void> => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    setFetching(true)
    try {
      const rs = await window.api.feeds.fetchAll()
      const added = rs.reduce((n, r) => n + r.added, 0)
      const failed = rs.filter((r) => !r.ok)
      if (added > 0) toast(`新收 ${added} 篇文章`)
      if (failed.length > 0) toast(`${failed.length} 个源拉取失败（标红示意）`)
      await load()
    } catch (e) {
      toast(`拉取失败：${(e as Error).message}`)
    } finally {
      fetchingRef.current = false
      setFetching(false)
    }
  }, [load])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useModuleActivated('feed', () => void refresh())
  useEffect(() => {
    void load()
  }, [load])

  const totalUnread = feeds.reduce((n, f) => n + f.unread, 0)
  const activeFeedRow = feeds.find((f) => f.id === activeFeed)

  /** 打开文章（open 内置标已读 + 懒抓正文） */
  const openArticle = async (id: number): Promise<void> => {
    try {
      const full = await window.api.articles.open(id)
      setReadingArticle(full)
      setReadingId(id)
      void load() // 未读态即时消失
    } catch (e) {
      toast(`打开失败：${(e as Error).message}`)
    }
  }

  const backToList = (): void => {
    setReadingId(null)
    setReadingArticle(null)
    void load()
  }

  const doAdd = async (): Promise<void> => {
    if (!addUrl.trim()) return
    try {
      setProbing(true)
      await window.api.feeds.add(addUrl.trim())
      toast('订阅成功')
      setAddOpen(false)
      setAddUrl('')
      setProbed(null)
      await refresh()
    } catch (e) {
      toast(`订阅失败：${(e as Error).message}`)
    } finally {
      setProbing(false)
    }
  }

  const doProbe = async (): Promise<void> => {
    if (!addUrl.trim()) return
    setProbed(null)
    setProbing(true)
    try {
      setProbed(await window.api.feeds.probe(addUrl.trim()))
    } catch (e) {
      toast(`验证失败：${(e as Error).message}`)
    } finally {
      setProbing(false)
    }
  }

  const doRemove = async (): Promise<void> => {
    if (!removeTarget) return
    await window.api.feeds.remove(removeTarget.id)
    toast('已删除订阅')
    if (activeFeed === removeTarget.id) setActiveFeed(null)
    setRemoveTarget(null)
    await load()
  }

  const doRename = async (): Promise<void> => {
    if (!renameTarget || !renameText.trim()) return
    await window.api.feeds.rename(renameTarget.id, renameText.trim())
    setRenameTarget(null)
    await load()
  }

  // ----- 阅读视图（主栏整体切换） -----
  if (readingId !== null && readingArticle) {
    const feedTitle = feeds.find((f) => f.id === readingArticle.feed_id)?.title ?? ''
    return (
      <ArticleView
        article={readingArticle}
        feedTitle={feedTitle}
        onBack={backToList}
        onChanged={() => void load()}
        onNavigateToProfile={props.onNavigateToProfile}
      />
    )
  }

  // ----- 列表态（三段式） -----
  return (
    <div className="module-page feed-page">
      <div className="module-header">
        <div className="module-title">信息源</div>
        <div className="module-sub">
          {feeds.length} 个源{totalUnread > 0 ? ` · ${totalUnread} 篇未读` : ''}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => void refresh()} disabled={fetching}>
            <span className={`material-symbols-outlined${fetching ? ' spin' : ''}`}>refresh</span>
            {fetching ? '拉取中' : '刷新'}
          </button>
          <button
            className="btn"
            onClick={async () => {
              await window.api.articles.markAllRead(activeFeed)
              await load()
            }}
          >
            <span className="material-symbols-outlined">done_all</span>全部标已读
          </button>
        </div>
      </div>

      <div className="feed-body">
        {/* 左窄栏：源列表 */}
        <aside className="feed-sources">
          <div
            className={`feed-src-item${activeFeed === null ? ' active' : ''}`}
            onClick={() => setActiveFeed(null)}
          >
            <span className="feed-src-name">全部文章</span>
            {totalUnread > 0 && <span className="feed-unread-badge">{totalUnread}</span>}
          </div>
          {feeds.map((f) => (
            <div
              key={f.id}
              className={`feed-src-item${activeFeed === f.id ? ' active' : ''}`}
              title={f.fetch_error ? `上次拉取失败：${f.fetch_error}` : f.feed_url}
              onClick={() => setActiveFeed(f.id)}
            >
              {f.fetch_error && <span className="feed-src-error" />}
              <span className="feed-src-name">{f.title}</span>
              {f.unread > 0 && <span className="feed-unread-badge">{f.unread}</span>}
              <span className="row-actions">
                <button
                  className="icon-btn"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation()
                    setRenameTarget(f)
                    setRenameText(f.title)
                  }}
                >
                  <span className="material-symbols-outlined">edit</span>
                </button>
                <button
                  className="icon-btn danger"
                  title="删除订阅"
                  onClick={(e) => {
                    e.stopPropagation()
                    setRemoveTarget(f)
                  }}
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </span>
            </div>
          ))}
          <button className="btn feed-add-btn" onClick={() => setAddOpen(true)}>
            <span className="material-symbols-outlined">add</span>添加订阅
          </button>
        </aside>

        {/* 中栏：文章列表 */}
        <div className="feed-list">
          {articles.length === 0 ? (
            <div className="empty-state">
              <span className="material-symbols-outlined">rss_feed</span>
              {fetching ? '正在拉取…' : activeFeedRow ? '该源暂无文章' : '暂无文章，点「刷新」拉取'}
            </div>
          ) : (
            articles.map((a) => (
              <div key={a.id} className={`feed-art-row${a.read_at ? '' : ' unread'}`} onClick={() => void openArticle(a.id)}>
                <div className="feed-art-title">{a.title}</div>
                {a.preview && <div className="feed-art-preview">{a.preview}</div>}
                <div className="feed-art-meta">
                  {activeFeed === null && <span>{feeds.find((f) => f.id === a.feed_id)?.title ?? ''}</span>}
                  <span>{relTime(a.published_at ?? a.fetched_at)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 添加订阅弹窗：URL → 验证显源名 → 订阅 */}
      {addOpen && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAddOpen(false)}>
          <div className="dialog" style={{ width: 440 }}>
            <div className="dialog-header">添加订阅</div>
            <div className="dialog-body">
              <input
                className="field"
                placeholder="RSS/Atom 链接，如 https://example.com/feed.xml"
                value={addUrl}
                onChange={(e) => {
                  setAddUrl(e.target.value)
                  setProbed(null)
                }}
                autoFocus
              />
              {probed && (
                <div className="feed-probe-line ok">
                  验证通过：{probed.title}
                  {probed.siteUrl ? `（${probed.siteUrl}）` : ''}
                </div>
              )}
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button className="btn" disabled={probing || !addUrl.trim()} onClick={() => void doProbe()}>
                验证
              </button>
              <button className="btn btn-primary" disabled={probing || !addUrl.trim()} onClick={() => void doAdd()}>
                订阅
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名弹窗 */}
      {renameTarget && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setRenameTarget(null)}>
          <div className="dialog" style={{ width: 380 }}>
            <div className="dialog-header">重命名源</div>
            <div className="dialog-body">
              <input
                className="field"
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && void doRename()}
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setRenameTarget(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void doRename()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删源二次确认（连文章彻底删，不入回收站） */}
      <ConfirmDialog
        open={!!removeTarget}
        title="删除订阅"
        danger
        confirmText="彻底删除"
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => void doRemove()}
      >
        将删除「{removeTarget?.title}」及其全部文章，不可恢复（不入回收站）。
      </ConfirmDialog>
    </div>
  )
}
