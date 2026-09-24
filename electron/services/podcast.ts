// 播客台服务（播客台 specs §2，2026-09-24-播客台-design.md）：
// 订阅与拉源管线（iTunes 搜索 + RSS 直链）+ 文字稿转写队列（RSS 自带优先 / ASR 兜底，串行后台）
// + AI 导读卡（jobId 取消接线）。定位「读文字稿」：本服务零音频播放。
// 手法同源借鉴 feed.ts（XML 解析/网络层/错误映射，不强行抽公共）、reasoningStock（推送渐进刷新）。
import { app, net, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { XMLParser } from 'fast-xml-parser'
import { getDb, nowIso } from '../db/db'
import { getSetting } from '../db/settings'
import { SettingsKeys, parseAsrConfig } from '../../src/shared/types'
import type {
  AsrConfig,
  ItunesPodcast,
  PodcastEpisodeDetail,
  PodcastEpisodeSummary,
  PodcastFeed
} from '../../src/shared/types'
import { chatCompletion, notifyActivityChanged, registerLlmActivityProvider } from '../ai/llm'
import { isLlmConfigured } from '../ai/services'
import { beginJob, endJob } from '../ai/jobs'
import { stripTags } from './feed'

/** 常规浏览器 UA（feed.ts 同款） */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 拉源 / 抓文字稿超时（音频下载与 ASR 调用另用长超时） */
const TIMEOUT_MS = 15_000

/** 音频下载长超时（百 MB 级文件 15s 必断） */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/** ASR 单片（单次直传）超时 */
const ASR_TIMEOUT_MS = 10 * 60_000

/** 音频 ≤ 此字节数整文件直传，超限分片（design §五） */
const ASR_DIRECT_MAX = 45 * 1024 * 1024

/** 分片目标大小（~40MB） */
const CHUNK_TARGET = 40 * 1024 * 1024

/** 首次订阅入库存量集数上限（想读哪集手点哪集，防一订阅就烧 10 集 ASR 费用） */
const FIRST_PULL_LIMIT = 10

/** 导读卡文字稿输入截断（超长截头部保留） */
const SUMMARY_INPUT_MAX = 60_000

const xml = new XMLParser({ ignoreAttributes: false })

// ---------- 工具 ----------

/** XML 值取文本（feed.ts 同款） */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  if (v && typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    const t = (v as Record<string, unknown>)['#text']
    return typeof t === 'string' ? t.trim() : ''
  }
  return ''
}

/** 值归一为数组（单子节点=对象、多节点=数组；feed.ts 同款） */
function toArray(v: unknown): Record<string, unknown>[] {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]) as Record<string, unknown>[]
}

/** guid 兜底哈希（feed.ts 同款） */
function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

/** 时间解析：RFC822/ISO 通吃（feed.ts 同款） */
function toIso(s: string): string | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** 网络/解析错误 → 可读中文（feed.ts 同款文案口径） */
function friendlyError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e)
  if (/timeout|aborted|signal is aborted/i.test(msg)) return '网络请求超时（应用自动跟随系统代理，可检查网络后重试）'
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ERR_/i.test(msg)) return `网络请求失败：${msg}`
  return msg
}

/** itunes:duration → 秒（「HH:MM:SS」/「MM:SS」/纯秒三种） */
function parseDurationSec(raw: unknown): number | null {
  const s = textOf(raw)
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').map((p) => Number(p.trim()))
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return null
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

// ---------- RSS 解析（RSS 2.0 + itunes/podcast 命名空间） ----------

interface ParsedTranscript {
  url: string
  type: string
}

interface ParsedEpisode {
  guid: string
  title: string
  publishedIso: string | null
  enclosureUrl: string
  durationSec: number | null
  shownotes: string
  /** 按 type 优先级升序（[0] 最优）：text/html > text/plain > srt > vtt > json */
  transcripts: ParsedTranscript[]
}

interface ParsedPodcastFeed {
  title: string
  artist: string
  artworkUrl: string | null
  items: ParsedEpisode[]
}

const TRANSCRIPT_TYPE_ORDER = [
  'text/html',
  'text/plain',
  'application/srt',
  'application/x-subrip',
  'text/vtt',
  'application/vtt',
  'application/json'
]

function transcriptRank(t: ParsedTranscript): number {
  const i = TRANSCRIPT_TYPE_ORDER.indexOf((t.type || '').toLowerCase())
  return i === -1 ? 99 : i
}

/** 解析播客 RSS（只支持 RSS 2.0——播客生态一统，iTunes 订阅源全部 RSS 2.0） */
function parsePodcastFeed(text: string): ParsedPodcastFeed {
  const doc = xml.parse(text) as Record<string, unknown>
  const channel = (doc?.rss as Record<string, unknown>)?.channel as Record<string, unknown> | undefined
  if (!channel) throw new Error('无法识别的播客订阅格式（非 RSS 2.0）')
  const itunesImage = channel['itunes:image'] as Record<string, unknown> | undefined
  const channelImage = channel.image as Record<string, unknown> | undefined
  const artworkUrl =
    textOf(itunesImage?.['@_href']) || textOf(channelImage?.url) || textOf(channelImage?.['@_href']) || null
  const items = toArray(channel.item).map((i): ParsedEpisode => {
    const enclosureUrl = textOf(toArray(i.enclosure)[0]?.['@_url'])
    const transcripts = toArray(i['podcast:transcript'])
      .map((t): ParsedTranscript => ({
        url: String(t['@_url'] ?? '').trim(),
        type: String(t['@_type'] ?? '').trim()
      }))
      .filter((t) => /^https?:\/\//i.test(t.url))
      .sort((a, b) => transcriptRank(a) - transcriptRank(b))
    return {
      guid: textOf(i.guid) || sha16(enclosureUrl || textOf(i.title)),
      title: textOf(i.title) || '（无标题）',
      publishedIso: toIso(textOf(i.pubDate)),
      enclosureUrl,
      durationSec: parseDurationSec(i['itunes:duration']),
      shownotes: i['content:encoded'] ? textOf(i['content:encoded']) : textOf(i.description),
      transcripts
    }
  })
  return {
    title: textOf(channel.title),
    artist: textOf(channel['itunes:author']) || textOf(channel.author),
    artworkUrl,
    items
  }
}

// ---------- 网络 ----------

function httpGet(url: string, timeoutMs = TIMEOUT_MS, cancel?: AbortSignal): Promise<Response> {
  return net.fetch(url, { signal: taskSignal(timeoutMs, cancel), headers: { 'User-Agent': UA } })
}

// ---------- 行映射 ----------

type FeedRow = Record<string, unknown>

function mapFeedRow(r: FeedRow): PodcastFeed {
  return {
    id: Number(r.id),
    title: String(r.title),
    artist: String(r.artist ?? ''),
    artwork_url: (r.artwork_url as string | null) ?? null,
    feed_url: String(r.feed_url),
    auto_transcribe: Number(r.auto_transcribe) === 1,
    created_at: String(r.created_at),
    last_fetched_at: (r.last_fetched_at as string | null) ?? null,
    fetch_error: (r.fetch_error as string | null) ?? null,
    unread: Number(r.unread ?? 0),
    untranscribed: Number(r.untranscribed ?? 0),
    rss_transcripts: Number(r.rss_transcripts ?? 0)
  }
}

// ---------- 订阅列表 / 增改删 ----------

/** 订阅列表 + 各节目未读/未转写计数（podcast:feedsList） */
export function listPodcastFeeds(): PodcastFeed[] {
  const rows = getDb()
    .prepare(
      `SELECT f.*,
        (SELECT COUNT(*) FROM podcast_episodes e WHERE e.feed_id = f.id AND e.read_at IS NULL) AS unread,
        (SELECT COUNT(*) FROM podcast_episodes e WHERE e.feed_id = f.id AND e.transcript_state IN ('none','failed')
           AND (e.transcript_url IS NULL OR e.transcript_url = '')) AS untranscribed,
        (SELECT COUNT(*) FROM podcast_episodes e WHERE e.feed_id = f.id AND e.transcript_url IS NOT NULL AND e.transcript_url != '') AS rss_transcripts
       FROM podcast_feeds f ORDER BY f.created_at, f.id`
    )
    .all() as unknown as FeedRow[]
  return rows.map(mapFeedRow)
}

/** 自动转写开关 / 改显示名（拉新永不覆盖显示名——命名归用户管，与信息源同口径） */
export function updatePodcastFeed(id: number, patch: { auto_transcribe?: boolean; title?: string }): void {
  const d = getDb()
  if (patch.auto_transcribe != null) {
    d.prepare('UPDATE podcast_feeds SET auto_transcribe = ? WHERE id = ?').run(patch.auto_transcribe ? 1 : 0, id)
  }
  const t = patch.title?.trim()
  if (t) d.prepare('UPDATE podcast_feeds SET title = ? WHERE id = ?').run(t, id)
}

/** 退订连删该节目全部单集与文字稿（二次确认在渲染层；不入回收站） */
export function deletePodcastFeed(id: number): void {
  const d = getDb()
  const eps = d.prepare('SELECT id FROM podcast_episodes WHERE feed_id = ?').all(id) as { id: number }[]
  for (const e of eps) dequeueTranscribe(e.id)
  d.prepare('DELETE FROM podcast_episodes WHERE feed_id = ?').run(id)
  d.prepare('DELETE FROM podcast_feeds WHERE id = ?').run(id)
}

// ---------- RSS 直链 probe ----------

async function probePodcastFeed(
  raw: string
): Promise<{ feedUrl: string; title: string; artist: string; artworkUrl: string | null }> {
  const u = raw.trim()
  if (!/^https?:\/\//i.test(u)) throw new Error('请输入 http/https 链接')
  let res: Response
  try {
    res = await httpGet(u)
  } catch (e) {
    throw new Error(friendlyError(e))
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const parsed = parsePodcastFeed(await res.text())
  if (!parsed.title) throw new Error('订阅源未提供节目名')
  return { feedUrl: u, title: parsed.title, artist: parsed.artist, artworkUrl: parsed.artworkUrl }
}

// ---------- iTunes 搜索 ----------

async function itunesLookupFeedUrl(trackId: number): Promise<string | null> {
  try {
    const res = await httpGet(`https://itunes.apple.com/lookup?id=${trackId}&entity=podcast`)
    if (!res.ok) return null
    const data = (await res.json()) as { results?: { feedUrl?: unknown }[] }
    const u = data.results?.[0]?.feedUrl
    return typeof u === 'string' && u ? u : null
  } catch {
    return null
  }
}

/** iTunes Search API 主进程代理搜索（渲染层直连有 CORS 与代理问题）；feedUrl 缺失就地 lookup 补全 */
export async function itunesSearch(term: string): Promise<ItunesPodcast[]> {
  const q = term.trim()
  if (!q) return []
  const res = await httpGet(
    `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=podcast&country=CN&limit=20`
  )
  if (!res.ok) throw new Error(`iTunes 搜索失败：HTTP ${res.status}`)
  const data = (await res.json()) as { results?: Record<string, unknown>[] }
  const out: ItunesPodcast[] = []
  for (const r of data.results ?? []) {
    const trackId = Number(r.trackId)
    if (!Number.isFinite(trackId)) continue
    let feedUrl = typeof r.feedUrl === 'string' && r.feedUrl ? r.feedUrl : null
    if (!feedUrl) feedUrl = await itunesLookupFeedUrl(trackId)
    const art = typeof r.artworkUrl100 === 'string' ? r.artworkUrl100.replace('/100x100', '/600x600') : null
    const count = Number(r.trackCount)
    out.push({
      trackId,
      name: String(r.trackName ?? r.collectionName ?? ''),
      artist: String(r.artistName ?? ''),
      artworkUrl: art,
      trackCount: Number.isFinite(count) ? count : null,
      feedUrl
    })
  }
  return out
}

// ---------- 订阅与拉源 ----------

export type PodcastAddInput =
  | { kind: 'itunes'; name: string; artist: string; artworkUrl: string | null; feedUrl: string }
  | { kind: 'rss'; url: string }

/** 订阅 + 首拉最近 10 集（全部停 none 态不自动转写）；feed_url UNIQUE 查重 */
export async function addPodcastFeed(input: PodcastAddInput, autoTranscribe: boolean): Promise<PodcastFeed> {
  let feedUrl: string
  let title: string
  let artist: string
  let artworkUrl: string | null
  if (input.kind === 'itunes') {
    feedUrl = input.feedUrl
    title = input.name
    artist = input.artist
    artworkUrl = input.artworkUrl
  } else {
    const probed = await probePodcastFeed(input.url)
    feedUrl = probed.feedUrl
    title = probed.title
    artist = probed.artist
    artworkUrl = probed.artworkUrl
  }
  if (!feedUrl) throw new Error('该节目未提供 RSS 地址，无法订阅')
  const d = getDb()
  const exists = d.prepare('SELECT id FROM podcast_feeds WHERE feed_url = ?').get(feedUrl)
  if (exists) throw new Error('该节目已订阅')
  const r = d
    .prepare(
      'INSERT INTO podcast_feeds (title, artist, artwork_url, feed_url, auto_transcribe, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(title, artist, artworkUrl, feedUrl, autoTranscribe ? 1 : 0, nowIso())
  const id = Number(r.lastInsertRowid)
  await fetchPodcastFeed(id, feedUrl, true)
  return mapFeedRow(d.prepare('SELECT * FROM podcast_feeds WHERE id = ?').get(id) as FeedRow)
}

/** 拉单源并按 (feed_id, guid) 去重入库；isFirst 只入库最近 10 集。返回新增集数（失败记 fetch_error 不抛） */
async function fetchPodcastFeed(feedId: number, feedUrl: string, isFirst: boolean): Promise<number> {
  try {
    const res = await httpGet(feedUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const parsed = parsePodcastFeed(await res.text())
    const d = getDb()
    let items = parsed.items
    if (isFirst) {
      // 最近 10 集：有日期按时间倒序、无日期排最后保 RSS 文档序，合计取前 10
      items = items
        .map((it, idx) => ({ it, idx }))
        .sort((a, b) => {
          const ta = a.it.publishedIso
          const tb = b.it.publishedIso
          if (ta && tb && ta !== tb) return ta < tb ? 1 : -1
          if (ta && !tb) return -1
          if (!ta && tb) return 1
          return a.idx - b.idx
        })
        .slice(0, FIRST_PULL_LIMIT)
        .map((x) => x.it)
    }
    const ins = d.prepare(
      `INSERT OR IGNORE INTO podcast_episodes
        (feed_id, guid, title, shownotes, published_at, duration_sec, enclosure_url, transcript_url, transcript_state, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'none', ?)`
    )
    const feed = d.prepare('SELECT auto_transcribe FROM podcast_feeds WHERE id = ?').get(feedId) as
      | { auto_transcribe: number }
      | undefined
    let added = 0
    for (const it of items) {
      const best = it.transcripts[0] ?? null
      const r = ins.run(
        feedId,
        it.guid,
        it.title,
        it.shownotes,
        it.publishedIso,
        it.durationSec,
        it.enclosureUrl,
        best?.url ?? null,
        nowIso()
      )
      if (Number(r.changes) > 0) {
        added++
        // 增量新集且开关开 → 自动入转写队列（首拉不自动转写）
        if (!isFirst && feed?.auto_transcribe) {
          enqueueTranscribe(Number(r.lastInsertRowid))
        }
      }
    }
    d.prepare('UPDATE podcast_feeds SET last_fetched_at = ?, fetch_error = NULL WHERE id = ?').run(nowIso(), feedId)
    return added
  } catch (e) {
    getDb().prepare('UPDATE podcast_feeds SET fetch_error = ? WHERE id = ?').run(friendlyError(e), feedId)
    return 0
  }
}

/** 并发拉全部源新集，返回总新增（进模块/手动刷新） */
export async function fetchAllPodcastFeeds(): Promise<number> {
  const feeds = getDb()
    .prepare('SELECT id, feed_url FROM podcast_feeds')
    .all() as unknown as { id: number; feed_url: string }[]
  let added = 0
  await Promise.all(
    feeds.map(async (f) => {
      added += await fetchPodcastFeed(f.id, f.feed_url, false)
    })
  )
  return added
}

// ---------- 单集查询 ----------

function mapEpisodeSummary(r: FeedRow): PodcastEpisodeSummary {
  return {
    id: Number(r.id),
    feed_id: Number(r.feed_id),
    feed_title: String(r.feed_title ?? ''),
    title: String(r.title),
    published_at: (r.published_at as string | null) ?? null,
    duration_sec: (r.duration_sec as number | null) ?? null,
    transcript_state: (r.transcript_state as PodcastEpisodeSummary['transcript_state']) ?? 'none',
    has_rss_transcript: r.transcript_url != null && r.transcript_url !== '',
    transcript_error: (r.transcript_error as string | null) ?? null,
    read_at: (r.read_at as string | null) ?? null
  }
}

/** 单集流（收件箱制，260925）：view=inbox 未读（默认首屏）/ archived 已读归档 / all 全部；
 *  发布倒序，无日期退 fetched_at。归档只动视图分类，转写状态/文字稿不受影响 */
export function listPodcastEpisodes(
  feedId: number | null,
  view: 'inbox' | 'archived' | 'all' = 'all'
): PodcastEpisodeSummary[] {
  const cond =
    view === 'inbox' ? 'AND e.read_at IS NULL' : view === 'archived' ? 'AND e.read_at IS NOT NULL' : ''
  const rows = getDb()
    .prepare(
      `SELECT e.id, e.feed_id, f.title AS feed_title, e.title, e.published_at, e.duration_sec,
              e.transcript_state, e.transcript_url, e.transcript_error, e.read_at, e.fetched_at
       FROM podcast_episodes e JOIN podcast_feeds f ON f.id = e.feed_id
       WHERE (? IS NULL OR e.feed_id = ?) ${cond}
       ORDER BY COALESCE(e.published_at, e.fetched_at) DESC, e.id DESC`
    )
    .all(feedId, feedId) as unknown as FeedRow[]
  return rows.map(mapEpisodeSummary)
}

/** 收件箱一键清空：全部（或指定节目）未读置为已读 = 归档（已转写与否无关） */
export function markAllEpisodesRead(feedId: number | null): number {
  const r = getDb()
    .prepare('UPDATE podcast_episodes SET read_at = ? WHERE read_at IS NULL AND (? IS NULL OR feed_id = ?)')
    .run(nowIso(), feedId, feedId)
  return Number(r.changes)
}

/** 标已读/未读切换 */
export function setEpisodeRead(id: number, read: boolean): void {
  getDb().prepare('UPDATE podcast_episodes SET read_at = ? WHERE id = ?').run(read ? nowIso() : null, id)
}

/** 删单集（硬删，不入回收站；在队列中的顺带摘除） */
export function deleteEpisode(id: number): void {
  dequeueTranscribe(id)
  getDb().prepare('DELETE FROM podcast_episodes WHERE id = ?').run(id)
}

/** 阅读视图全量（文字稿 + shownotes + summary_md + 节目封面） */
export function getEpisodeDetail(id: number): PodcastEpisodeDetail {
  const r = getDb()
    .prepare(
      `SELECT e.*, f.title AS feed_title, f.artwork_url
       FROM podcast_episodes e JOIN podcast_feeds f ON f.id = e.feed_id WHERE e.id = ?`
    )
    .get(id) as FeedRow | undefined
  if (!r) throw new Error('单集不存在')
  const source = (r.transcript_source as string | null) ?? null
  return {
    ...mapEpisodeSummary(r),
    shownotes: String(r.shownotes ?? ''),
    transcript_text: (r.transcript_text as string | null) ?? null,
    transcript_source: source === 'rss' || source === 'asr' ? source : null,
    summary_md: (r.summary_md as string | null) ?? null,
    summary_at: (r.summary_at as string | null) ?? null,
    artwork_url: (r.artwork_url as string | null) ?? null
  }
}

// ---------- 文字稿转写队列（内存串行，重启续跑） ----------

const transcribeQueue: number[] = []
let transcribePumping = false

/** 在途转写活动（挂右栏「AI 调用」面板 llm:activity，260925）：episodeId → 展示项。
 *  jobId 进全局任务注册表——面板取消钮 / 「全部取消」经 ai:cancel 中止，取消的单集回退 none 态可重试 */
const activeTranscribes = new Map<number, { configName: string; startedAt: number; jobId: string }>()
const ACTIVITY_SEQ_BASE = 1_000_000 // 与 llm callSeq 空间隔离，仅作面板 React key

registerLlmActivityProvider(() =>
  [...activeTranscribes.entries()].map(([id, v]) => ({
    seq: ACTIVITY_SEQ_BASE + id,
    scene: 'podcast:transcribe',
    configName: v.configName,
    startedAt: v.startedAt,
    jobId: v.jobId
  }))
)

/** 任务级信号：服务商超时与用户取消（AI 面板）合并 */
function taskSignal(timeoutMs: number, cancel?: AbortSignal): AbortSignal {
  return cancel ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]) : AbortSignal.timeout(timeoutMs)
}

// ---------- AI 排版（ASR 原文 → 可读文章；260925 开发者需求） ----------
// 口径：仅排版——分段 + 剥离非语音标记（🎼😊 等转写系统输出的情绪/音乐标记），
// 语音内容一字不改不增不减（不纠错不改写不总结）。后台尽力而为：失败/取消/LLM 未配置
// 均保留原始转写（state done），绝不因排版丢转写成果。design「转写零 LLM」据此修订为
// 「转打标不涉 LLM；ASR 产物后处理经 LLM 排版（scene podcast:polish）」。

const POLISH_CHUNK_CHARS = 3500

const POLISH_PROMPT = `你是文字排版助手。下面是一段播客语音转写的原始文字。请只做排版整理，严格遵守：
1. 除排版外对文字内容一字不改：不改写、不纠错、不总结、不增删任何词语；
2. 删除非语音标记符号（如 🎼🎵😊😡🤢 等转写系统输出的情绪/音乐标记），这些不是说话内容；
3. 按语义把长段切分成自然段，段与段之间空一行；
4. 直接输出排版后的全文，不要任何解释、开场白或标题。

原始文字：`

/** 按句末标点切成 ≤max 字的块（长文分块防模型输出截断；块间无重叠——排版不需要跨块上下文） */
function splitForPolish(text: string, max = POLISH_CHUNK_CHARS): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + max, text.length)
    if (end < text.length) {
      const win = text.slice(start, end)
      const last = Math.max(
        win.lastIndexOf('。'),
        win.lastIndexOf('！'),
        win.lastIndexOf('？'),
        win.lastIndexOf('；'),
        win.lastIndexOf('\n')
      )
      if (last > max * 0.5) end = start + last + 1
    }
    out.push(text.slice(start, end))
    start = end
  }
  return out
}

/** 逐块排版（串行；单块失败/返回空 → 回退原块，排版永不让文字变少） */
async function polishTranscript(text: string, signal?: AbortSignal): Promise<string> {
  if (!isLlmConfigured()) return text
  const chunks = splitForPolish(text)
  const out: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const res = await chatCompletion({
      messages: [{ role: 'user', content: `${POLISH_PROMPT}\n${chunks[i]}` }],
      temperature: 0.1,
      scene: 'podcast:polish',
      signal
    })
    out.push(res.content.trim() || chunks[i])
    console.info(`[podcast] 排版 ${i + 1}/${chunks.length}（原 ${chunks[i].length} 字 → 出 ${res.content.trim().length} 字）`)
  }
  return out.join('\n\n')
}

function notifyTaskChanged(): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('podcast:taskChanged')
}

function setTranscribeState(id: number, state: PodcastEpisodeSummary['transcript_state'], error?: string): void {
  getDb()
    .prepare('UPDATE podcast_episodes SET transcript_state = ?, transcript_error = ? WHERE id = ?')
    .run(state, error ?? null, id)
  notifyTaskChanged()
}

/** 手动触发/自动入队：仅 none|failed 可入（queued/doing 幂等跳过） */
export function enqueueTranscribe(episodeId: number): void {
  const row = getDb()
    .prepare('SELECT transcript_state FROM podcast_episodes WHERE id = ?')
    .get(episodeId) as { transcript_state: string } | undefined
  if (!row) return
  if (row.transcript_state !== 'none' && row.transcript_state !== 'failed') return
  setTranscribeState(episodeId, 'queued')
  transcribeQueue.push(episodeId)
  void pumpTranscribeQueue()
}

/** 从待处理队列摘除（删单集/退订用；正在跑的一集靠行已删的防御自灭） */
function dequeueTranscribe(episodeId: number): void {
  const i = transcribeQueue.indexOf(episodeId)
  if (i !== -1) transcribeQueue.splice(i, 1)
}

async function pumpTranscribeQueue(): Promise<void> {
  if (transcribePumping) return
  transcribePumping = true
  try {
    while (transcribeQueue.length > 0) {
      const id = transcribeQueue.shift()!
      try {
        await processTranscribe(id)
      } catch (e) {
        // processTranscribe 内部已置 failed，这里只记日志防队列中断
        console.warn(`[podcast] 单集 ${id} 转写失败：`, (e as Error).message)
      }
    }
  } finally {
    transcribePumping = false
  }
}

/** 启动恢复：polishing（排版中断，原始转写已在库）直接完稿；queued/downloading/transcribing 重置重入队 */
export function resumePodcastTranscribes(): void {
  const d = getDb()
  d.prepare("UPDATE podcast_episodes SET transcript_state = 'done' WHERE transcript_state = 'polishing'").run()
  const rows = d
    .prepare(
      "SELECT id FROM podcast_episodes WHERE transcript_state IN ('queued','downloading','transcribing')"
    )
    .all() as unknown as { id: number }[]
  if (rows.length === 0) return
  for (const r of rows) {
    setTranscribeState(r.id, 'queued')
    transcribeQueue.push(r.id)
  }
  console.info(`[podcast] 重启恢复转写队列 ${rows.length} 集`)
  void pumpTranscribeQueue()
}

/** 处理一集：RSS 文字稿直抓优先，否则下载音频走 ASR（≤45MB 整传 / 超限 mp3 帧对齐分片）。
 *  全程登记 AI 面板活动（可经面板取消；取消回退 none 态可重试） */
async function processTranscribe(id: number): Promise<void> {
  const d = getDb()
  const ep = d
    .prepare('SELECT id, title, enclosure_url, transcript_url FROM podcast_episodes WHERE id = ?')
    .get(id) as { id: number; title: string; enclosure_url: string; transcript_url: string | null } | undefined
  if (!ep) return // 行已删（退订竞态），静默自灭
  const jobId = `podcast-asr-${id}`
  const cancelAc = beginJob(jobId)
  const registerActivity = (configName: string): void => {
    activeTranscribes.set(id, { configName, startedAt: Date.now(), jobId })
    notifyActivityChanged()
  }
  try {
    if (ep.transcript_url) {
      registerActivity('RSS 文字稿直抓')
      setTranscribeState(id, 'downloading')
      const { raw, type } = await fetchTranscriptFile(ep.transcript_url, cancelAc.signal)
      const text = normalizeParagraphs(transcriptToText(raw, type, ep.transcript_url))
      if (!text.trim()) throw new Error('RSS 文字稿内容为空')
      d.prepare(
        "UPDATE podcast_episodes SET transcript_text = ?, transcript_source = 'rss', transcript_state = 'done', transcript_error = NULL WHERE id = ?"
      ).run(text, id)
      notifyTaskChanged()
      return
    }
    if (!ep.enclosure_url) throw new Error('本集没有可下载的音频地址（enclosure 缺失）')
    const cfg = parseAsrConfig(getSetting(SettingsKeys.AsrConfig))
    if (!cfg.apiUrl || !cfg.apiKey || !cfg.model) {
      throw new Error('ASR 未配置，去个人档配置后重试')
    }
    registerActivity(cfg.model)
    setTranscribeState(id, 'downloading')
    const tmpPath = join(app.getPath('temp'), `podcast-${id}-${Date.now()}.mp3`)
    try {
      const buf = await downloadAudio(ep.enclosure_url, tmpPath, id, cancelAc.signal)
      setTranscribeState(id, 'transcribing')
      const text =
        buf.length <= ASR_DIRECT_MAX
          ? await transcribeBuffer(buf, cfg, cancelAc.signal)
          : await transcribeChunked(buf, cfg, cancelAc.signal)
      const out = normalizeParagraphs(text)
      if (!out.trim()) throw new Error('转写结果为空')
      // 原始转写先落库（state=polishing）——排版中断/失败/取消时已有产物在库不丢
      d.prepare(
        "UPDATE podcast_episodes SET transcript_text = ?, transcript_source = 'asr', transcript_state = 'polishing', transcript_error = NULL WHERE id = ?"
      ).run(out, id)
      notifyTaskChanged()
      let finalText = out
      try {
        finalText = await polishTranscript(out, cancelAc.signal)
      } catch (pe) {
        // 排版失败或用户取消：保留原始转写直接完稿（cancel 时 ASR 已花钱，不回退 none）
        console.warn(`[podcast] 单集 ${id} 排版未完成，保留原始转写：`, (pe as Error).message)
      }
      d.prepare("UPDATE podcast_episodes SET transcript_text = ?, transcript_state = 'done' WHERE id = ?").run(
        finalText,
        id
      )
      notifyTaskChanged()
    } finally {
      await unlink(tmpPath).catch(() => {})
    }
  } catch (e) {
    if (cancelAc.signal.aborted) {
      setTranscribeState(id, 'none') // 用户取消 → 回未转写，可再点重试
    } else {
      setTranscribeState(id, 'failed', friendlyError(e))
    }
  } finally {
    activeTranscribes.delete(id)
    endJob(jobId)
    notifyActivityChanged()
  }
}

// ---------- RSS 文字稿抓取与解析 ----------

async function fetchTranscriptFile(url: string, cancel?: AbortSignal): Promise<{ raw: string; type: string }> {
  let res: Response
  try {
    res = await httpGet(url, TIMEOUT_MS, cancel)
  } catch (e) {
    throw new Error(friendlyError(e))
  }
  if (!res.ok) throw new Error(`文字稿下载失败：HTTP ${res.status}`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  return { raw: await res.text(), type }
}

/** URL 扩展名 → 粗类型（响应头 content-type 缺失/错标时兜底） */
function typeFromUrl(url: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'html' || ext === 'htm') return 'text/html'
  if (ext === 'srt') return 'application/srt'
  if (ext === 'vtt') return 'text/vtt'
  if (ext === 'json') return 'application/json'
  return 'text/plain'
}

function transcriptToText(raw: string, type: string, url: string): string {
  const t = type || typeFromUrl(url)
  if (t.includes('json')) {
    try {
      return collectJsonText(JSON.parse(raw))
    } catch {
      return raw
    }
  }
  if (t.includes('html')) return stripTags(raw)
  if (t.includes('srt') || t.includes('vtt') || t.includes('subrip')) {
    return raw
      .split(/\r?\n/)
      .filter((line) => {
        const s = line.trim()
        return s !== '' && !/^\d+$/.test(s) && !s.includes('-->') && s !== 'WEBVTT' && !/^NOTE\b/.test(s)
      })
      .join('\n')
  }
  return raw
}

/** JSON 文字稿（podcast namespace transcript type=application/json）：递归收集字符串字段拼接 */
function collectJsonText(v: unknown, out: string[] = []): string {
  if (typeof v === 'string') {
    const s = v.trim()
    if (s) out.push(s)
  } else if (Array.isArray(v)) {
    v.forEach((x) => collectJsonText(x, out))
  } else if (v && typeof v === 'object') {
    Object.values(v).forEach((x) => collectJsonText(x, out))
  }
  return out.join('\n\n')
}

/** 归一化为 md 段落（连续非空行合成段、段间空行），保证阅读视图 MdView 段落渲染正确 */
function normalizeParagraphs(text: string): string {
  const paras: string[] = []
  let cur: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t) cur.push(t)
    else if (cur.length > 0) {
      paras.push(cur.join(' '))
      cur = []
    }
  }
  if (cur.length > 0) paras.push(cur.join(' '))
  return paras.join('\n\n')
}

// ---------- ASR（OpenAI 兼容 /audio/transcriptions；全程零 LLM 参与） ----------

async function downloadAudio(
  url: string,
  destPath: string,
  episodeId: number,
  cancel?: AbortSignal
): Promise<Buffer> {
  let res: Response
  try {
    res = await net.fetch(url, {
      signal: taskSignal(DOWNLOAD_TIMEOUT_MS, cancel),
      headers: { 'User-Agent': UA }
    })
  } catch (e) {
    throw new Error(friendlyError(e))
  }
  if (!res.ok) throw new Error(`音频下载失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // 临时文件落盘（用完即删，finally 兜底）；分片转写直接用内存 Buffer（subarray 零拷贝），避免二次读盘
  await writeFile(destPath, buf)
  getDb().prepare('UPDATE podcast_episodes SET audio_bytes = ? WHERE id = ?').run(buf.length, episodeId)
  return buf
}

/** mp3 帧同步字节（0xFF + 次字节高 5 位全 1）向后查找，分片切在帧边界上 */
function findFrameSync(buf: Buffer, from: number): number {
  for (let i = Math.max(0, from); i < buf.length - 1; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) return i
  }
  return buf.length
}

async function transcribeChunked(buf: Buffer, cfg: AsrConfig, cancel?: AbortSignal): Promise<string> {
  const parts: string[] = []
  let offset = 0
  let idx = 0
  while (offset < buf.length) {
    let end = Math.min(offset + CHUNK_TARGET, buf.length)
    if (end < buf.length) end = findFrameSync(buf, end)
    if (end <= offset) end = buf.length // 防御：帧同步找不到时剩余全切
    const chunk = buf.subarray(offset, end)
    idx++
    console.info(`[podcast] 分片转写 #${idx}（${(chunk.length / 1024 / 1024).toFixed(1)}MB）`)
    parts.push((await transcribeBuffer(chunk, cfg, cancel)).trim())
    offset = end
  }
  return parts.filter((p) => p.length > 0).join('\n\n')
}

async function transcribeBuffer(data: Buffer, cfg: AsrConfig, cancel?: AbortSignal): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(data)], { type: 'audio/mpeg' }), 'audio.mp3')
  form.append('model', cfg.model)
  // 中文标点引导（agent-reach #291 实证：whisper 对中文输出几乎无标点，prompt 偏置显著改善可读性；多余字段被服务端忽略无副作用）
  form.append('prompt', '以下是普通话的播客内容，请输出带标点的简体中文文字稿。')
  const url = `${cfg.apiUrl.trim().replace(/\/+$/, '')}/audio/transcriptions`
  let res: Response
  try {
    res = await net.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: taskSignal(ASR_TIMEOUT_MS, cancel)
    })
  } catch (e) {
    throw new Error(friendlyError(e))
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`ASR 服务返回 ${res.status}：${t.slice(0, 200)}`)
  }
  const out = (await res.json()) as { text?: unknown }
  return typeof out.text === 'string' ? out.text : ''
}

// ---------- ASR 配置连通性测试（个人档「测试连接」；手动诊断动作，不经队列不落库） ----------

/** 生成 0.5s 16kHz 单声道静音 WAV（探测 端点/Key/模型 三要素；纯静音返回空文本即算通） */
function silenceWav(seconds = 0.5): Buffer {
  const rate = 16000
  const n = Math.floor(rate * seconds)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + n * 2, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(n * 2, 40)
  return Buffer.concat([header, Buffer.alloc(n * 2)])
}

/** 测试 ASR 配置：真实打一次 /audio/transcriptions，把 服务商错误 翻译成可行动提示 */
export async function testAsrConfig(cfg: AsrConfig): Promise<{ ok: boolean; message: string }> {
  if (!cfg.apiUrl.trim() || !cfg.apiKey.trim() || !cfg.model.trim()) {
    return { ok: false, message: '三项配置未填全' }
  }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(silenceWav())], { type: 'audio/wav' }), 'test.wav')
  form.append('model', cfg.model)
  const url = `${cfg.apiUrl.trim().replace(/\/+$/, '')}/audio/transcriptions`
  let res: Response
  try {
    res = await net.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000)
    })
  } catch (e) {
    return { ok: false, message: `网络请求失败（或服务响应超时）：${friendlyError(e)}` }
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    if (/Model does not exist/i.test(t)) {
      return { ok: false, message: `模型「${cfg.model}」在该服务商不存在，请核对模型名（硅基流动可用 FunAudioLLM/SenseVoiceSmall）` }
    }
    if (res.status === 401) return { ok: false, message: 'API Key 无效或已过期（HTTP 401）' }
    return { ok: false, message: `服务返回 ${res.status}：${t.slice(0, 200)}` }
  }
  const out = (await res.json().catch(() => null)) as { text?: unknown } | null
  const text = typeof out?.text === 'string' ? out.text.trim() : ''
  return {
    ok: true,
    message: text
      ? `连接正常，模型返回：「${text.slice(0, 50)}」`
      : '连接正常，模型可用（测试音频为静音，返回空文本属正常）'
  }
}

// ---------- AI 导读卡（jobId 取消接线） ----------

/** 导读卡固定四节 md（阅读视图置顶展示，缓存复用不重复生成） */
export async function generateEpisodeSummary(episodeId: number, jobId: string): Promise<string> {
  const d = getDb()
  const row = d
    .prepare(
      `SELECT e.title, e.shownotes, e.transcript_text, e.summary_md, f.title AS feed_title
       FROM podcast_episodes e JOIN podcast_feeds f ON f.id = e.feed_id WHERE e.id = ?`
    )
    .get(episodeId) as
    | { title: string; shownotes: string; transcript_text: string | null; summary_md: string | null; feed_title: string }
    | undefined
  if (!row) throw new Error('单集不存在')
  if (row.summary_md) return row.summary_md
  const ac = beginJob(jobId)
  try {
    const shownotes = stripTags(row.shownotes ?? '').slice(0, 3000)
    const transcript = (row.transcript_text ?? '').slice(0, SUMMARY_INPUT_MAX)
    const prompt = `你是播客单集导读助手。请基于以下材料为本集生成中文导读卡，严格输出以下四节（Markdown 二级标题，按此顺序）：

## 单集速览
（3-4 句话概括本集讲了什么、值得读的理由）

## 核心要点
（3-6 条要点，每条一行，以「- 」开头）

## 金句与值得记住的片段
（1-3 条原句摘录或贴近原文的短语，每条一行，以「- 」开头）

## 延伸思考
（2-3 个值得读者继续琢磨的问题或不同角度，每条一行，以「- 」开头）

只输出导读卡本身，不要任何开场白或结束语。忠于材料，不确定的内容不要编造。

节目：「${row.feed_title}」
单集标题：「${row.title}」

shownotes：
${shownotes || '（无）'}

文字稿：
${transcript || '（无文字稿，仅凭 shownotes 概括，请在速览中注明「本导读基于 shownotes」）'}`
    const res = await chatCompletion({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      scene: 'podcast:summary',
      signal: ac.signal
    })
    const md = res.content.trim()
    if (!md) throw new Error('LLM 未返回内容')
    d.prepare('UPDATE podcast_episodes SET summary_md = ?, summary_at = ? WHERE id = ?').run(md, nowIso(), episodeId)
    return md
  } finally {
    endJob(jobId)
  }
}
