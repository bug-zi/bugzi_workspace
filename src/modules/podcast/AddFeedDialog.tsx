// 添加订阅弹窗（播客台 specs §4.2）：「搜节目」（iTunes Search API，默认）｜「RSS 直链」双入口
// + 订阅时勾选「自动转写新集」（默认开，仅对新集生效）；feedUrl 缺失的结果项置灰不可订
import { useState } from 'react'
import type { ItunesPodcast } from '../../shared/types'
import { useToast } from '../../components/Toast'

interface Props {
  open: boolean
  onClose: () => void
  /** 订阅成功回调（父层刷新双列表） */
  onAdded: () => void
}

export default function AddFeedDialog(props: Props) {
  const { toast } = useToast()
  const [mode, setMode] = useState<'search' | 'rss'>('search')
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<ItunesPodcast[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [subId, setSubId] = useState<string | null>(null)
  const [rssUrl, setRssUrl] = useState('')
  const [rssBusy, setRssBusy] = useState(false)
  const [autoTranscribe, setAutoTranscribe] = useState(true)

  if (!props.open) return null

  const doSearch = async (): Promise<void> => {
    const q = term.trim()
    if (!q || searching) return
    setSearching(true)
    try {
      const rows = await window.api.podcast.itunesSearch(q)
      setResults(rows)
      setSearched(true)
    } catch (e) {
      toast(`搜索失败：${(e as Error).message}`)
    } finally {
      setSearching(false)
    }
  }

  const subscribe = async (
    input: Parameters<typeof window.api.podcast.feedsAdd>[0],
    busyKey: string
  ): Promise<void> => {
    setSubId(busyKey)
    try {
      await window.api.podcast.feedsAdd(input, autoTranscribe)
      toast('订阅成功，已拉取最近 10 集')
      props.onAdded()
      props.onClose()
    } catch (e) {
      toast(`订阅失败：${(e as Error).message}`)
    } finally {
      setSubId(null)
    }
  }

  const doSubscribeRss = async (): Promise<void> => {
    const u = rssUrl.trim()
    if (!u || rssBusy) return
    setRssBusy(true)
    try {
      await subscribe({ kind: 'rss', url: u }, 'rss')
    } finally {
      setRssBusy(false)
    }
  }

  const switchMode = (m: 'search' | 'rss'): void => {
    setMode(m)
    setResults([])
    setSearched(false)
  }

  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog" style={{ width: 520 }}>
        <div className="dialog-header">添加订阅</div>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="pc-add-tabs">
            <button className={`pc-add-tab${mode === 'search' ? ' active' : ''}`} onClick={() => switchMode('search')}>
              搜节目
            </button>
            <button className={`pc-add-tab${mode === 'rss' ? ' active' : ''}`} onClick={() => switchMode('rss')}>
              RSS 直链
            </button>
          </div>

          {mode === 'search' ? (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="field"
                  style={{ flex: 1 }}
                  placeholder="输入节目名（如 乱翻书）回车搜索"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void doSearch()}
                />
                <button className="btn" onClick={() => void doSearch()} disabled={searching || !term.trim()}>
                  <span className="material-symbols-outlined">{searching ? 'progress_activity spin' : 'search'}</span>
                  {searching ? '搜索中…' : '搜索'}
                </button>
              </div>
              <div className="pc-add-results">
                {searched && results.length === 0 && !searching && (
                  <div className="pc-add-empty">没有找到相关节目，可换关键词或改用 RSS 直链</div>
                )}
                {results.map((r) => (
                  <div className="pc-add-row" key={r.trackId}>
                    {r.artworkUrl ? (
                      <img className="pc-add-cover" src={r.artworkUrl} alt="" />
                    ) : (
                      <span className="pc-add-cover pc-add-cover-empty">
                        <span className="material-symbols-outlined">podcasts</span>
                      </span>
                    )}
                    <div className="pc-add-main">
                      <div className="pc-add-title">{r.name}</div>
                      <div className="pc-add-sub">
                        {r.artist}
                        {r.trackCount != null ? ` · ${r.trackCount} 集` : ''}
                        {r.feedUrl == null ? ' · 无 RSS 地址' : ''}
                      </div>
                    </div>
                    <button
                      className="btn btn-primary"
                      disabled={r.feedUrl == null || subId != null}
                      title={r.feedUrl == null ? '该节目未提供 RSS 地址，无法订阅' : '订阅'}
                      onClick={() =>
                        r.feedUrl != null &&
                        void subscribe({ kind: 'itunes', name: r.name, artist: r.artist, artworkUrl: r.artworkUrl, feedUrl: r.feedUrl }, String(r.trackId))
                      }
                    >
                      {subId === String(r.trackId) ? '订阅中…' : '订阅'}
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="field"
                style={{ flex: 1 }}
                placeholder="粘贴播客 RSS 地址（https://…）"
                value={rssUrl}
                onChange={(e) => setRssUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void doSubscribeRss()}
              />
              <button className="btn" onClick={() => void doSubscribeRss()} disabled={rssBusy || !rssUrl.trim()}>
                <span className="material-symbols-outlined">{rssBusy ? 'progress_activity spin' : 'podcasts'}</span>
                {rssBusy ? '订阅中…' : '订阅'}
              </button>
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.9em' }}>
            <input
              type="checkbox"
              checked={autoTranscribe}
              onChange={(e) => setAutoTranscribe(e.target.checked)}
              style={{ accentColor: 'var(--color-primary)' }}
            />
            自动转写新集（订阅后新到的单集自动排入转写队列；本次拉取的存量集仍需手动点击）
          </label>
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
