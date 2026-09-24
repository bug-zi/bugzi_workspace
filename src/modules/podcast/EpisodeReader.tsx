// 阅读视图（播客台 specs §4.3）：AI 导读卡（自动生成 + 缓存，jobId 取消接线）+ 文字稿全文 MdView
// + 划词「问 AI」（sel-bubble 同款手法，进播客频道不 auto）+「追问本集」（构造上下文 auto 直发）
// 打开即标已读；无文字稿时 shownotes 兜底 + 「转写本集」入口
import { useCallback, useEffect, useRef, useState } from 'react'
import { SettingsKeys, parseAsrConfig } from '../../shared/types'
import type { PodcastEpisodeDetail } from '../../shared/types'
import type { AiChannel } from '../../shared/types'
import MdView from '../../components/MdView'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'

interface Props {
  episodeId: number
  onBack: () => void
  /** 已读/导读卡变化后刷新列表 */
  onChanged: () => void
  onOpenAi: (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => void
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

export default function EpisodeReader(props: Props) {
  const { toast } = useToast()
  const [detail, setDetail] = useState<PodcastEpisodeDetail | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [genJob, setGenJob] = useState<string | null>(null)
  const [genError, setGenError] = useState('')
  const [goConfig, setGoConfig] = useState(false)
  const [asrConfigOpen, setAsrConfigOpen] = useState(false)
  const [read, setRead] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const d = await window.api.podcast.episodeDetail(props.episodeId)
      setDetail(d)
      setSummary(d.summary_md)
      setRead(d.read_at != null)
      setGenError('')
    } catch (e) {
      toast(`读取单集失败：${(e as Error).message}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.episodeId])

  useEffect(() => {
    void load()
  }, [load])

  // 打开即标已读（一次；可手动切回「再看看」）
  useEffect(() => {
    void window.api.podcast
      .episodeRead(props.episodeId, true)
      .then(() => props.onChanged())
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.episodeId])

  /** 发起导读卡生成（自动 + 缓存：无缓存才跑） */
  const runSummary = useCallback(
    async (jobId: string): Promise<void> => {
      setGenJob(jobId)
      setGenError('')
      try {
        const md = await window.api.podcast.generateSummary(jobId, props.episodeId)
        setSummary(md)
      } catch (e) {
        const msg = (e as Error).message
        if (msg.includes('已取消')) toast('已取消')
        else if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
        else setGenError(msg)
      } finally {
        setGenJob(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.episodeId]
  )

  useEffect(() => {
    if (detail && !detail.summary_md) void runSummary(crypto.randomUUID())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, detail?.summary_md])

  // 划词「问 AI」气泡（MdDialog sel-bubble 同款手法：mouseup 出泡、点击气泡本身不移除）
  useEffect(() => {
    const body = bodyRef.current
    if (!body || !detail) return
    let bubble: HTMLDivElement | null = null
    const removeBubble = (): void => {
      bubble?.remove()
      bubble = null
    }
    const onMouseUp = (e: MouseEvent): void => {
      // 点击气泡本身：不移除，交给按钮 click 处理（DOM 顺序 mousedown→mouseup→click）
      if (bubble && e.target instanceof Node && bubble.contains(e.target)) return
      removeBubble()
      const sel = window.getSelection()
      const text = sel?.toString().trim() ?? ''
      if (!sel || !text || text.length > 500) return
      const range = sel.getRangeAt(0)
      if (!body.contains(range.commonAncestorContainer)) return
      const rect = range.getBoundingClientRect()
      bubble = document.createElement('div')
      bubble.className = 'sel-bubble'
      const btn = document.createElement('button')
      btn.textContent = '问 AI'
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        props.onOpenAi(`关于「${detail.title}」：「${text}」\n\n请结合本集内容帮我解释。`, {
          channel: 'podcast'
        })
        removeBubble()
        sel.removeAllRanges()
      })
      bubble.append(btn)
      document.body.appendChild(bubble)
      const bw = 90
      bubble.style.left = `${Math.max(8, rect.left + rect.width / 2 - bw / 2)}px`
      bubble.style.top = `${Math.max(8, rect.top - 40)}px`
    }
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      removeBubble()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id])

  if (!detail) {
    return (
      <div className="module-page feed-reader-page">
        <div className="feed-reader-bar">
          <button className="btn" onClick={props.onBack}>
            <span className="material-symbols-outlined">arrow_back</span>返回列表
          </button>
        </div>
      </div>
    )
  }

  const toggleRead = async (): Promise<void> => {
    try {
      await window.api.podcast.episodeRead(detail.id, !read)
      setRead(!read)
      props.onChanged()
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`)
    }
  }

  /** 追问本集：带单集标题 + 文字稿上下文进「播客·追问」频道并自动发送 */
  const askFollowUp = (): void => {
    const ctx = (detail.transcript_text || detail.shownotes).replace(/\s+/g, ' ').slice(0, 20000)
    const srcLabel = detail.transcript_text ? '本集文字稿（节选）' : '本集 shownotes（尚未转写）'
    props.onOpenAi(
      `我正在读播客单集「${detail.title}」（节目：${detail.feed_title}${detail.published_at ? `，发布于 ${fmtDate(detail.published_at)}` : ''}）。以下是${srcLabel}：\n\n${ctx}\n\n请基于本集内容陪我追问讨论，帮我吃透其中的观点与论据。`,
      { channel: 'podcast', auto: true }
    )
  }

  const transcribeNow = async (): Promise<void> => {
    // 无 RSS 自带文字稿（将走 ASR）→ 入队前校验配置（未配置弹「去配置」）
    if (!detail.has_rss_transcript) {
      const cfg = parseAsrConfig(await window.api.settings.get(SettingsKeys.AsrConfig))
      if (!(cfg.apiUrl && cfg.apiKey && cfg.model)) {
        setAsrConfigOpen(true)
        return
      }
    }
    try {
      await window.api.podcast.transcribe(detail.id)
      toast('已加入转写队列')
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`)
    }
  }

  return (
    <div className="module-page feed-reader-page">
      <div className="feed-reader-bar">
        <button className="btn" onClick={props.onBack}>
          <span className="material-symbols-outlined">arrow_back</span>返回列表
        </button>
        <div
          className="bk-reader-title"
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {detail.title}
        </div>
        <button className="btn btn-primary" onClick={askFollowUp}>
          <span className="material-symbols-outlined">forum</span>追问本集
        </button>
        <button className="btn" onClick={() => void toggleRead()}>
          <span className="material-symbols-outlined">{read ? 'move_to_inbox' : 'mark_email_read'}</span>
          {read ? '再看看' : '已读'}
        </button>
      </div>

      <div className="feed-reader-scroll">
        <article className="feed-article pc-article">
          <h1>{detail.title}</h1>
          <div className="feed-article-meta">
            <span>{detail.feed_title}</span>
            {detail.published_at && <span>{fmtDate(detail.published_at)}</span>}
            {detail.duration_sec != null && detail.duration_sec > 0 && <span>{fmtDuration(detail.duration_sec)}</span>}
            {detail.transcript_source === 'rss' && <span>文字稿 · 节目自带</span>}
            {detail.transcript_source === 'asr' && <span>文字稿 · AI 转写</span>}
          </div>

          {/* AI 导读卡（置顶；生成失败/未配置不阻塞正文） */}
          <div className="feed-summary-card">
            <div className="feed-summary-head">
              <span className="material-symbols-outlined">auto_awesome</span>
              AI 导读
              <span style={{ opacity: 0.7 }}>· AI 生成</span>
            </div>
            {summary ? (
              <div className="feed-summary-body md-view">
                <MdView md={summary} />
              </div>
            ) : genJob ? (
              <div className="feed-summary-body" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="material-symbols-outlined spin">progress_activity</span>
                正在生成本集导读…
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
                <div className="feed-summary-err">导读生成失败：{genError}</div>
                <button className="btn" style={{ marginTop: 8 }} onClick={() => void runSummary(crypto.randomUUID())}>
                  <span className="material-symbols-outlined">refresh</span>重试
                </button>
              </div>
            ) : (
              <div className="feed-summary-body" style={{ color: 'var(--color-text-secondary)', fontSize: '0.85em' }}>
                <button className="btn" onClick={() => void runSummary(crypto.randomUUID())}>
                  <span className="material-symbols-outlined">auto_awesome</span>生成导读卡
                </button>
              </div>
            )}
          </div>

          {/* 正文：文字稿全文优先，无则 shownotes 兜底 + 转写入口 */}
          {detail.transcript_text ? (
            <div className="feed-article-body md-view pc-transcript" ref={bodyRef}>
              <MdView md={detail.transcript_text} />
            </div>
          ) : (
            <div className="feed-article-body md-view pc-transcript" ref={bodyRef}>
              <div className="pc-no-transcript">
                <span className="material-symbols-outlined">graphic_eq</span>
                本集尚未转写，当前显示节目原始 shownotes
                <button className="btn" onClick={() => void transcribeNow()}>
                  <span className="material-symbols-outlined">speech_to_text</span>转写本集
                </button>
              </div>
              {detail.shownotes && <MdView md={detail.shownotes} />}
            </div>
          )}
        </article>
      </div>

      <GoConfigDialog
        open={goConfig}
        kind="llm"
        onGoConfig={() => {
          setGoConfig(false)
          props.onNavigateToProfile()
        }}
        onCancel={() => setGoConfig(false)}
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
    </div>
  )
}
