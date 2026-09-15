// 阅读视图（信息源 specs §3.2）：AI 总结卡（jobId 全局取消接线）+ 消毒正文 + 去原文
// 260911：头部加显式已读/再看看与收藏星标（与列表行双入口）
import { useCallback, useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { SettingsKeys } from '../../shared/types'
import type { ArticleRecord } from '../../shared/types'
import { useAppSettings } from '../../theme/ThemeProvider'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'

interface Props {
  article: ArticleRecord
  feedTitle: string
  onBack: () => void
  /** 总结/已读状态变化后刷新列表 */
  onChanged: () => void
  /** LLM 未配置「去配置」直达个人中心（全局规则） */
  onNavigateToProfile?: () => void
}

/** 相对时间（列表与阅读视图共用格式） */
export function relTime(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const d = new Date(t)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

// ===== Ctrl+滚轮字体缩放（260916 新功能开发区）：仅阅读视图，全局记一档（settings feed_reader_zoom）=====
const ZOOM_MIN = 80
const ZOOM_MAX = 200
const ZOOM_STEP = 10
const ZOOM_DEFAULT = 100

function clampZoom(v: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v))
}

/** settings 原始值解析：非数字/非正/越界回落 100，并对齐 10 步进 */
function parseZoom(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return ZOOM_DEFAULT
  return clampZoom(Math.round(n / ZOOM_STEP) * ZOOM_STEP)
}

export default function ArticleView(props: Props) {
  const { toast } = useToast()
  const { settings, setSetting } = useAppSettings()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [zoom, setZoom] = useState<number>(() => parseZoom(settings[SettingsKeys.FeedZoom]))
  const [zoomBarVisible, setZoomBarVisible] = useState(false)
  const [summary, setSummary] = useState<string | null>(props.article.summary_text)
  const [genJob, setGenJob] = useState<string | null>(null)
  const [genError, setGenError] = useState('')
  const [goConfig, setGoConfig] = useState(false)
  const [read, setRead] = useState(!!props.article.read_at)
  const [fav, setFav] = useState(!!props.article.favorited_at)

  /** 发起总结（按需 + 缓存：无缓存才跑；jobId 取消接线同 WikiModule 惯例） */
  const runSummarize = useCallback(
    async (jobId: string): Promise<void> => {
      setGenJob(jobId)
      setGenError('')
      try {
        const s = await window.api.articles.summarize(jobId, props.article.id)
        setSummary(s)
        props.onChanged()
      } catch (e) {
        const msg = (e as Error).message
        if (msg.includes('已取消')) {
          toast('已取消')
        } else if (msg.includes('LLM_NOT_CONFIGURED')) {
          setGoConfig(true) // 全局规则：不置灰，弹「去配置」直达个人中心
        } else {
          setGenError(msg)
        }
      } finally {
        setGenJob(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.article.id]
  )

  /** 已读/再看看（260911）：与列表行双入口，读完好顺手点 */
  const toggleRead = async (): Promise<void> => {
    try {
      await window.api.articles.setRead(props.article.id, !read)
      setRead(!read)
      props.onChanged()
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`)
    }
  }

  /** 收藏/取消收藏（260911） */
  const toggleFav = async (): Promise<void> => {
    try {
      await window.api.articles.setFavorite(props.article.id, !fav)
      setFav(!fav)
      props.onChanged()
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`)
    }
  }

  // Ctrl+滚轮缩放：原生非 passive 监听（React 合成 onWheel 是 passive，preventDefault 无效）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault() // 阻断 Chromium/Electron 默认整页缩放
      setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 缩放落库（全局一档记忆；挂载时回写同值无副作用）
  useEffect(() => {
    void setSetting(SettingsKeys.FeedZoom, String(zoom))
  }, [zoom, setSetting])

  // 指示条：变化浮出，1.5s 无变化淡出
  useEffect(() => {
    setZoomBarVisible(true)
    const t = window.setTimeout(() => setZoomBarVisible(false), 1500)
    return () => window.clearTimeout(t)
  }, [zoom])

  // 打开文章：无缓存总结自动生成（specs §3.2）
  useEffect(() => {
    setSummary(props.article.summary_text)
    setGenError('')
    setRead(!!props.article.read_at)
    setFav(!!props.article.favorited_at)
    if (!props.article.summary_text) void runSummarize(crypto.randomUUID())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.article.id])

  const html = props.article.content_fetched_html || props.article.content_feed_html
  const sanitized = html ? DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }) : ''

  return (
    <div className="module-page feed-reader-page">
      <div className="feed-reader-bar">
        <button className="btn" onClick={props.onBack}>
          <span className="material-symbols-outlined">arrow_back</span>返回列表
        </button>
        <div className="bk-reader-title" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {props.article.title}
        </div>
        <button
          className={`icon-btn feed-star${fav ? ' on' : ''}`}
          title={fav ? '取消收藏' : '收藏'}
          onClick={() => void toggleFav()}
        >
          <span className="material-symbols-outlined">star</span>
        </button>
        <button className="btn" onClick={() => void toggleRead()}>
          <span className="material-symbols-outlined">{read ? 'move_to_inbox' : 'mark_email_read'}</span>
          {read ? '再看看' : '已读'}
        </button>
        {props.article.url && (
          <button className="btn" onClick={() => void window.api.shell.openExternal(props.article.url)} title={props.article.url}>
            <span className="material-symbols-outlined">open_in_new</span>去原文
          </button>
        )}
      </div>

      <div className="feed-reader-scroll" ref={scrollRef}>
        <article className="feed-article" style={{ fontSize: `${zoom}%` }}>
          <h1>{props.article.title}</h1>
          <div className="feed-article-meta">
            <span>{props.feedTitle}</span>
            <span>{relTime(props.article.published_at ?? props.article.fetched_at)}</span>
            {props.article.author && <span>{props.article.author}</span>}
          </div>

          {/* AI 总结卡（置顶） */}
          <div className="feed-summary-card">
            <div className="feed-summary-head">
              <span className="material-symbols-outlined">auto_awesome</span>
              AI 总结
              <span style={{ opacity: 0.7 }}>· AI 生成</span>
            </div>
            {summary ? (
              <div className="feed-summary-body">{summary}</div>
            ) : genJob ? (
              <div className="feed-summary-body" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="material-symbols-outlined spin">progress_activity</span>
                正在总结文章…
                <button
                  className="btn"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => void window.api.ai.cancel(genJob)}
                >
                  <span className="material-symbols-outlined">stop_circle</span>停止
                </button>
              </div>
            ) : genError ? (
              <div className="feed-summary-body">
                <div className="feed-summary-err">总结失败：{genError}</div>
                <button className="btn" style={{ marginTop: 8 }} onClick={() => void runSummarize(crypto.randomUUID())}>
                  <span className="material-symbols-outlined">refresh</span>重试
                </button>
              </div>
            ) : (
              <div className="feed-summary-body" style={{ color: 'var(--color-text-secondary)', fontSize: '0.85em' }}>
                <button className="btn" onClick={() => void runSummarize(crypto.randomUUID())}>
                  <span className="material-symbols-outlined">auto_awesome</span>生成 AI 总结
                </button>
              </div>
            )}
          </div>

          {/* 正文（消毒后渲染；双失败兜底「去原文」） */}
          {sanitized ? (
            <div className="feed-article-body" dangerouslySetInnerHTML={{ __html: sanitized }} />
          ) : (
            <div className="feed-fallback">
              <span className="material-symbols-outlined">article</span>
              未能获取正文（订阅仅提供摘要且网页抓取失败）
              {props.article.url && (
                <button className="btn" onClick={() => void window.api.shell.openExternal(props.article.url)}>
                  <span className="material-symbols-outlined">open_in_new</span>去原文阅读
                </button>
              )}
            </div>
          )}
        </article>
      </div>

      {zoomBarVisible && (
        <button className="feed-zoom-bar" title="点击复位 100%" onClick={() => setZoom(ZOOM_DEFAULT)}>
          <span className="material-symbols-outlined">text_increase</span>
          {zoom}%
        </button>
      )}

      <GoConfigDialog
        open={goConfig}
        kind="llm"
        onGoConfig={() => {
          setGoConfig(false)
          props.onNavigateToProfile?.()
        }}
        onCancel={() => setGoConfig(false)}
      />
    </div>
  )
}
