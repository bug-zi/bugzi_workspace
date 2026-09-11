// 信息源服务（信息源 specs §2）：RSS/Atom 拉取解析 + 正文两级策略 + AI 总结（按需缓存，signal 穿透）
import { net } from 'electron'
import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { getDb, nowIso } from '../db/db'
import { chatCompletion } from '../ai/llm'
import { ensureNotCancelled } from '../ai/jobs'
import type {
  ArticleRecord,
  ArticleSummary,
  FeedFetchResult,
  FeedListView,
  FeedRecord,
  FeedView
} from '../../src/shared/types'

/** 常规浏览器 UA（部分站点对无 UA/非常规 UA 直接 403） */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 单源网络超时（specs §0） */
const TIMEOUT_MS = 15_000

/** RSS 自带全文判够阈值：剥标签后 ≥ 此字符数不抓网页（specs §0） */
const FULL_TEXT_MIN = 500

/** 拉取入库时间窗（天）：发布时间早于 now-N 天的条目不入库（260911 补充需求；无日期条目视作新发照常进） */
const FETCH_WINDOW_DAYS = 7

/** AI 总结输入截断（specs §2.3） */
const SUMMARY_INPUT_MAX = 8000

/** 预置三源（specs §0；首次 feeds:list 幂等 seed，标题 probe 失败退常量） */
const SEED_FEEDS = [
  { title: 'tw93 weekly', feed_url: 'https://weekly.tw93.fun/rss.xml' },
  { title: 'aiznb weekly', feed_url: 'https://aiznb.com/weekly/atom.xml' },
  { title: 'ursb blog', feed_url: 'https://ursb.me/blog/feed.xml' }
]

const xml = new XMLParser({ ignoreAttributes: false })

// ---------- 工具 ----------

/** XML 值取文本：fast-xml-parser 对含属性/嵌套节点返回对象 */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  if (v && typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    const t = (v as Record<string, unknown>)['#text']
    return typeof t === 'string' ? t.trim() : ''
  }
  return ''
}

/** 值归一为数组（单子节点=对象、多节点=数组） */
function toArray(v: unknown): Record<string, unknown>[] {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]) as Record<string, unknown>[]
}

/** guid 兜底哈希（无 guid/link 用，specs §1） */
function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

/** 时间解析：RFC822/ISO 通吃，失败返回 null（展示侧 COALESCE 排序兜底） */
function toIso(s: string): string | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** 剥 HTML 标签为纯文本 */
export function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface FeedItem {
  guid: string
  title: string
  link: string
  author: string
  publishedIso: string | null
  contentHtml: string | null
}

/** 解析 RSS 2.0 / Atom 为归一化条目（格式混杂在 Service 层兜住） */
function parseFeed(text: string): { channelTitle: string; items: FeedItem[] } {
  const doc = xml.parse(text) as Record<string, unknown>
  // RSS 2.0：rss.channel.item[]
  const channel = (doc?.rss as Record<string, unknown>)?.channel as Record<string, unknown> | undefined
  if (channel) {
    return {
      channelTitle: textOf(channel.title),
      items: toArray(channel.item).map((i) => {
        const link = textOf(i.link)
        return {
          guid: textOf(i.guid) || sha16(link || textOf(i.title)),
          title: textOf(i.title) || '（无标题）',
          link,
          author: textOf(i['dc:creator']) || textOf(i.author),
          publishedIso: toIso(textOf(i.pubDate) || textOf(i['dc:date'])),
          contentHtml: i['content:encoded'] ? textOf(i['content:encoded']) : textOf(i.description) || null
        }
      })
    }
  }
  // Atom：feed.entry[]
  const atom = doc?.feed as Record<string, unknown> | undefined
  if (atom) {
    return {
      channelTitle: textOf(atom.title),
      items: toArray(atom.entry).map((e) => {
        const linkEl = toArray(e.link).find((l) => l['@_rel'] === undefined || l['@_rel'] === 'alternate')
        const href = typeof linkEl?.['@_href'] === 'string' ? linkEl['@_href'] : ''
        // Atom content 可能是 {'@_type':'html','#text':...} 或纯文本；缺则退 summary
        const content = e.content ?? e.summary
        return {
          guid: textOf(e.id) || sha16(href || textOf(e.title)),
          title: textOf(e.title) || '（无标题）',
          link: href,
          author: textOf(toArray(e.author)[0]?.name),
          publishedIso: toIso(textOf(e.published) || textOf(e.updated)),
          contentHtml: content !== undefined ? textOf(content) || null : null
        }
      })
    }
  }
  throw new Error('无法识别的订阅格式（非 RSS/Atom）')
}

// ---------- 拉取 ----------

/** 网络拉取统一入口：Electron net.fetch 走 Chromium 网络栈，自动跟随系统代理
 *  （260911 修复：主进程全局 fetch 不读系统代理，墙外源〔如 feedburner〕直连超时报 Error） */
function httpGet(url: string): Promise<Response> {
  return net.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': UA } })
}

/** 网络/解析错误 → 可读中文（260911：原始报错如「fetch failed」对用户排查无意义） */
function friendlyError(e: unknown): string {
  const err = e instanceof Error ? e : new Error(String(e))
  const raw = `${err.name} ${err.message} ${String((err as Error & { cause?: unknown }).cause ?? '')}`
  const PROXY_HINT = '（应用自动跟随系统代理，需代理的站点请确认系统代理已开启）'
  if (/NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i.test(raw)) return '域名无法解析，请检查地址是否正确'
  if (/PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED/i.test(raw)) return `代理连接失败${PROXY_HINT}`
  if (/TIMED_OUT|timed.?out|timeout|abort/i.test(raw)) return `连接超时：请检查地址是否正确${PROXY_HINT}`
  if (/CONNECTION_REFUSED/i.test(raw)) return '连接被拒绝，站点可能暂时不可用'
  if (/fetch failed|ERR_CONNECTION|ERR_CERT|ERR_TLS/i.test(raw)) return `连接失败：请检查地址是否正确${PROXY_HINT}`
  return err.message
}

/** 拉取单源并按 (feed_id, guid) 去重入库；成功清 fetch_error，失败记错误（不抛）。
 *  260911：入库限 7 天窗口（FETCH_WINDOW_DAYS）——发布时间早于 now-7 天的条目跳过，防首次订阅拉进整段历史；
 *  无日期条目视作新发照常进（跳过会让无日期源永远拉不到文章；guid 去重防重复）。 */
async function fetchFeed(feedId: number, feedUrl: string): Promise<{ added: number }> {
  try {
    const res = await httpGet(feedUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const parsed = parseFeed(await res.text())
    const d = getDb()
    const ins = d.prepare(
      `INSERT OR IGNORE INTO articles (feed_id, guid, title, url, author, published_at, fetched_at, content_feed_html)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const cutoff = new Date(Date.now() - FETCH_WINDOW_DAYS * 86_400_000).toISOString()
    let added = 0
    for (const it of parsed.items) {
      if (it.publishedIso && it.publishedIso < cutoff) continue
      const r = ins.run(feedId, it.guid, it.title, it.link, it.author, it.publishedIso, nowIso(), it.contentHtml)
      added += Number(r.changes)
    }
    d.prepare('UPDATE feeds SET last_fetched_at = ?, fetch_error = NULL WHERE id = ?').run(nowIso(), feedId)
    return { added }
  } catch (e) {
    // 超时/网络/格式错误：记到源上标红，不影响其他源（260911 起映射为可读中文）
    getDb().prepare('UPDATE feeds SET fetch_error = ? WHERE id = ?').run(friendlyError(e), feedId)
    return { added: 0 }
  }
}

/** 并发拉全部源（渲染层：进模块自动 + 手动刷新） */
export async function fetchAllFeeds(): Promise<FeedFetchResult[]> {
  const feeds = getDb().prepare('SELECT id, feed_url FROM feeds').all() as unknown as { id: number; feed_url: string }[]
  return Promise.all(
    feeds.map(async (f): Promise<FeedFetchResult> => {
      const r = await fetchFeed(f.id, f.feed_url)
      // 拉取后回读错误标记（fetchFeed 失败记在源上，不抛）
      const row = getDb().prepare('SELECT fetch_error FROM feeds WHERE id = ?').get(f.id) as
        | { fetch_error: string | null }
        | undefined
      return { feedId: f.id, ok: !row?.fetch_error, error: row?.fetch_error ?? undefined, added: r.added }
    })
  )
}

/** 源列表 + 未读数（首次幂等 seed 三源：probe 真名，失败退常量名） */
export async function listFeeds(): Promise<(FeedRecord & { unread: number })[]> {
  const d = getDb()
  const count = (d.prepare('SELECT COUNT(*) AS c FROM feeds').get() as { c: number }).c
  if (count === 0) {
    for (const s of SEED_FEEDS) {
      let title = s.title
      try {
        title = (await probeFeed(s.feed_url)).title || s.title
      } catch {
        /* 离线/失败退常量名 */
      }
      d.prepare('INSERT OR IGNORE INTO feeds (title, feed_url, site_url, created_at) VALUES (?, ?, ?, ?)').run(
        title,
        s.feed_url,
        '',
        nowIso()
      )
    }
  }
  return d
    .prepare(
      `SELECT f.*, (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id AND a.read_at IS NULL AND a.favorited_at IS NULL) AS unread
       FROM feeds f ORDER BY f.created_at, f.id`
    )
    .all() as unknown as (FeedRecord & { unread: number })[]
}

/** 验证结果：feedUrl 是实际订阅地址——用户输入网站首页时为页面里发现的直链，≠ 输入值（260911 自动发现） */
export interface FeedProbe {
  title: string
  siteUrl: string
  feedUrl: string
}

/** HTML 页面发现订阅链接：<link rel="alternate" type="…rss…/…atom…">；全站缺 type 时退 href 关键词启发 */
function discoverFeedLinks(html: string, pageUrl: string): string[] {
  try {
    const { document } = parseHTML(html)
    const nodes = Array.from(document.querySelectorAll('link[rel~="alternate"][href]')) as {
      getAttribute(name: string): string | null
    }[]
    const byType = nodes.filter((el) => /rss|atom|feed/i.test(el.getAttribute('type') ?? ''))
    const source =
      byType.length > 0
        ? byType
        : nodes.filter((el) => /(?:\.rss|\.atom|\.xml|\/rss|\/feed|\/atom)/i.test(el.getAttribute('href') ?? ''))
    const out: string[] = []
    for (const el of source) {
      const href = el.getAttribute('href') ?? ''
      try {
        out.push(new URL(href, pageUrl).toString())
      } catch {
        /* 无效 href 跳过 */
      }
    }
    return [...new Set(out)]
  } catch {
    return []
  }
}

/** 按发现的链接逐个试解析（最多前 3 个，防怪站链一堆逐个打满超时） */
async function probeViaLinks(html: string, pageUrl: string, siteUrl: string): Promise<FeedProbe | null> {
  for (const feedUrl of discoverFeedLinks(html, pageUrl).slice(0, 3)) {
    try {
      const r = await httpGet(feedUrl)
      if (!r.ok) continue
      const parsed = parseFeed(await r.text())
      if (!parsed.channelTitle) continue
      return { title: parsed.channelTitle, siteUrl, feedUrl }
    } catch {
      /* 单个链接失败试下一个 */
    }
  }
  return null
}

/** 拉一次验证并取源名（添加订阅弹窗「验证」用；260911 升级——net.fetch 走系统代理 + 网站首页自动发现订阅链接） */
export async function probeFeed(url: string): Promise<FeedProbe> {
  const u = url.trim()
  if (!/^https?:\/\//.test(u)) throw new Error('请输入 http/https 链接')
  let siteUrl = ''
  try {
    siteUrl = new URL(u).origin
  } catch {
    /* 不阻断 */
  }
  let body = ''
  let isHtml = false
  try {
    const res = await httpGet(u)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body = await res.text()
    isHtml = (res.headers.get('content-type') ?? '').toLowerCase().includes('html')
  } catch (e) {
    throw new Error(friendlyError(e))
  }
  if (!isHtml) {
    // feed 直链（原路径零变化）；解析失败兜底——content-type 标错、实为 HTML 的怪站当页面做自动发现
    try {
      const parsed = parseFeed(body)
      if (!parsed.channelTitle) throw new Error('订阅源未提供名称')
      return { title: parsed.channelTitle, siteUrl, feedUrl: u }
    } catch (e) {
      const viaHtml = await probeViaLinks(body, u, siteUrl)
      if (viaHtml) return viaHtml
      throw e
    }
  }
  // 网站首页：自动发现订阅链接
  const viaHtml = await probeViaLinks(body, u, siteUrl)
  if (viaHtml) return viaHtml
  throw new Error('未在该页面发现可用的订阅源（RSS/Atom）链接，请改用 feed 直链重试')
}

/** 入库并立即拉一次（feeds:add） */
export async function addFeed(url: string): Promise<FeedRecord & { unread: number }> {
  const probed = await probeFeed(url)
  // 存实际 feed 直链——首页自动发现后 ≠ 用户输入的首页地址，否则后续拉取永远打在 HTML 上
  const clean = probed.feedUrl
  const d = getDb()
  const exists = d.prepare('SELECT id FROM feeds WHERE feed_url = ?').get(clean)
  if (exists) throw new Error('该订阅已存在')
  const r = d
    .prepare('INSERT INTO feeds (title, feed_url, site_url, created_at) VALUES (?, ?, ?, ?)')
    .run(probed.title, clean, probed.siteUrl, nowIso())
  const id = Number(r.lastInsertRowid)
  await fetchFeed(id, clean)
  return d
    .prepare(
      `SELECT f.*, (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id AND a.read_at IS NULL AND a.favorited_at IS NULL) AS unread
       FROM feeds f WHERE f.id = ?`
    )
    .get(id) as unknown as FeedRecord & { unread: number }
}

/** 改显示名（拉取永不覆盖——源名归用户管） */
export function renameFeed(id: number, title: string): void {
  getDb().prepare('UPDATE feeds SET title = ? WHERE id = ?').run(title.trim().slice(0, 60) || '未命名源', id)
}

/** 删源连文章（显式两步，不依赖外键级联；渲染层已二次确认） */
export function removeFeed(id: number): void {
  const d = getDb()
  d.prepare('DELETE FROM articles WHERE feed_id = ?').run(id)
  d.prepare('DELETE FROM feeds WHERE id = ?').run(id)
}

// ---------- 文章 ----------

/** 文章列表：unread/archive 排除收藏、30 天窗口起按 sinceDays 加载（remaining=窗口外计数，「加载更早」用）；
 *  favorite 全量按收藏时间倒序，不筛源不设窗口（design.md §5）。
 *  260911：视图查询排除收藏（收藏文章只出现在收藏页）。 */
export function listArticles(feedId: number | null, view: FeedView, sinceDays: number): FeedListView {
  const d = getDb()
  if (view === 'favorite') {
    const rows = d
      .prepare('SELECT * FROM articles WHERE favorited_at IS NOT NULL ORDER BY favorited_at DESC, id DESC')
      .all() as unknown as ArticleRecord[]
    return { articles: rows.map(toSummary), remaining: 0 }
  }
  const readClause = view === 'unread' ? 'read_at IS NULL' : 'read_at IS NOT NULL'
  const sinceIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const feedClause = feedId == null ? '' : ' AND feed_id = ?'
  const params: (string | number)[] = [sinceIso, ...(feedId == null ? [] : [feedId])]
  const rows = d
    .prepare(
      `SELECT * FROM articles WHERE ${readClause} AND favorited_at IS NULL AND COALESCE(published_at, fetched_at) >= ?${feedClause}
       ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC`
    )
    .all(...params) as unknown as ArticleRecord[]
  const remainingRow = d
    .prepare(
      `SELECT COUNT(*) AS c FROM articles WHERE ${readClause} AND favorited_at IS NULL AND COALESCE(published_at, fetched_at) < ?${feedClause}`
    )
    .get(...params) as { c: number }
  return { articles: rows.map(toSummary), remaining: remainingRow.c }
}

/** 轻量行映射（三视图共用；剥标签预览 120 字） */
function toSummary(r: ArticleRecord): ArticleSummary {
  return {
    id: r.id,
    feed_id: r.feed_id,
    title: r.title,
    url: r.url,
    author: r.author,
    published_at: r.published_at,
    fetched_at: r.fetched_at,
    read_at: r.read_at,
    favorited: !!r.favorited_at,
    has_summary: !!r.summary_text,
    preview: stripTags(r.content_fetched_html || r.content_feed_html || '').slice(0, 120)
  }
}

/** 打开文章：懒抓正文 + 全量返回（260911 起不再自动标已读——已读判定唯一入口是显式「已读」按钮） */
export async function openArticle(id: number): Promise<ArticleRecord> {
  const d = getDb()
  const row = d.prepare('SELECT * FROM articles WHERE id = ?').get(id) as unknown as ArticleRecord | undefined
  if (!row) throw new Error('NOT_FOUND')
  await extractArticle(id)
  return (d.prepare('SELECT * FROM articles WHERE id = ?').get(id) as unknown as ArticleRecord) ?? row
}

/** 显式已读/再看看（design.md §2）：true→read_at=now；false→清空回未读（行回收件箱） */
export function setArticleRead(id: number, read: boolean): void {
  getDb().prepare('UPDATE articles SET read_at = ? WHERE id = ?').run(read ? nowIso() : null, id)
}

/** 收藏/取消收藏（design.md §3）：收藏文章只出现在收藏页且永不被清理；
 *  取消后按已读状态自然回流收件箱（未读）或已归档（已读） */
export function setArticleFavorite(id: number, fav: boolean): void {
  getDb().prepare('UPDATE articles SET favorited_at = ? WHERE id = ?').run(fav ? nowIso() : null, id)
}

/** 全部标已读（feedId 空=全部源；不波及收藏——收藏未读不在收件箱展示，design.md §2） */
export function markAllRead(feedId: number | null): void {
  const d = getDb()
  if (feedId == null)
    d.prepare('UPDATE articles SET read_at = ? WHERE read_at IS NULL AND favorited_at IS NULL').run(nowIso())
  else
    d.prepare('UPDATE articles SET read_at = ? WHERE feed_id = ? AND read_at IS NULL AND favorited_at IS NULL').run(
      nowIso(),
      feedId
    )
}

/**
 * 正文两级策略（specs §2.2）：RSS 全文够长直接用；不足则 fetch 网页 → linkedom + readability 提取，
 * 结果喂 AI 总结与阅读视图两用。失败置空不报错（渲染层兜底摘要 + 去原文外链）。
 */
async function extractArticle(id: number): Promise<void> {
  const d = getDb()
  const row = d.prepare('SELECT url, content_feed_html, content_fetched_html FROM articles WHERE id = ?').get(id) as
    | { url: string; content_feed_html: string | null; content_fetched_html: string | null }
    | undefined
  if (!row) return
  if (row.content_fetched_html) return // 已抓过（缓存）
  if (stripTags(row.content_feed_html ?? '').length >= FULL_TEXT_MIN) return // RSS 全文已够
  if (!row.url) return
  try {
    const res = await httpGet(row.url)
    if (!res.ok) return
    const html = await res.text()
    const { document } = parseHTML(html)
    const parsed = new Readability(document).parse()
    if (parsed?.content) {
      d.prepare('UPDATE articles SET content_fetched_html = ? WHERE id = ?').run(parsed.content, id)
    }
  } catch {
    /* 网络失败静默：阅读视图走摘要兜底 */
  }
}

/**
 * AI 总结（按需 + 缓存，specs §2.3）：无缓存才生成；全文不足先懒抓。
 * 不注入画像（外部文章与自我认知无关）；signal 取消 → 抛「已取消」。
 */
export async function summarizeArticle(articleId: number, signal?: AbortSignal): Promise<string> {
  const d = getDb()
  const cached = d.prepare('SELECT summary_text FROM articles WHERE id = ?').get(articleId) as
    | { summary_text: string | null }
    | undefined
  if (!cached) throw new Error('NOT_FOUND')
  if (cached.summary_text) return cached.summary_text
  ensureNotCancelled(signal)
  await extractArticle(articleId)
  ensureNotCancelled(signal)
  const row = d.prepare('SELECT title, content_feed_html, content_fetched_html FROM articles WHERE id = ?').get(
    articleId
  ) as { title: string; content_feed_html: string | null; content_fetched_html: string | null } | undefined
  if (!row) throw new Error('NOT_FOUND')
  const html = row.content_fetched_html || row.content_feed_html
  const text = stripTags(html ?? '')
  if (text.length < 50) throw new Error('正文内容太少，无法总结（可「去原文」阅读）')
  const r = await chatCompletion({
    messages: [
      {
        role: 'system',
        content:
          '你是中文总结助手。阅读用户提供的文章，输出 150-300 字的客观中文总结：概括文章核心观点与关键信息，语言平实，不加评价、不加开场白、不重复标题。'
      },
      { role: 'user', content: `文章标题：${row.title}\n\n正文：\n${text.slice(0, SUMMARY_INPUT_MAX)}` }
    ],
    temperature: 0.3,
    scene: 'feed:summary',
    signal
  })
  d.prepare('UPDATE articles SET summary_text = ?, summary_at = ? WHERE id = ?').run(r.content, nowIso(), articleId)
  return r.content
}

/** 30 天已读文章彻底清理（design.md §4，替代第28轮「清正文保轻行」）：已读+未收藏+超 30 天整行 DELETE；
 *  未读文章无论多老都保留（待读积压由用户自主处理），收藏文章永不清除。
 *  启动 + 每日零点调用（scheduler.ts），静默，返回清理条数。 */
export function cleanupOldArticles(): number {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const r = getDb()
    .prepare(
      `DELETE FROM articles
       WHERE read_at IS NOT NULL AND favorited_at IS NULL
         AND COALESCE(published_at, fetched_at) < ?`
    )
    .run(cutoff)
  return Number(r.changes)
}
