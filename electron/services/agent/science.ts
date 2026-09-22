// 科普线服务（超级工作台 2.0 批次D spec §3/§5）：发现箱 article 条目转正分流、全文抓取
// （网页 → readability 抽正文，失败降级 meta_only 不炸）、科普文章查询/删除、划词高光、
// 概念自动建链（concepts → wiki_entries 精确/双向模糊）与 knowledge_links 通用增删查（批次 F 复用）。
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { getDb, nowIso, userDataDir } from '../../db/db'
import { mdDelete } from '../files'
import { politeFetch } from './guardrails'
import { enqueue, registerTask } from './queue'
import type { TaskContext } from './queue'
import type { ScienceArticleRow, ScienceConcept, ScienceHighlightRow } from '../../../src/shared/types'

function parseJsonArr(raw: unknown): string[] {
  try {
    const p = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseConcepts(raw: unknown): ScienceConcept[] {
  try {
    const p = JSON.parse(String(raw ?? '[]'))
    if (!Array.isArray(p)) return []
    return p
      .filter((x): x is { term?: unknown } => !!x && typeof x === 'object')
      .map((x) => ({
        term: typeof x.term === 'string' ? x.term : '',
        entry_id: typeof (x as { entry_id?: unknown }).entry_id === 'number' ? (x as { entry_id: number }).entry_id : null
      }))
      .filter((c) => !!c.term)
  } catch {
    return []
  }
}

function hydrateScience(r: Record<string, unknown>): ScienceArticleRow {
  let glossary: { en: string; zh: string }[] | null = null
  try {
    const p = JSON.parse(String(r.glossary ?? 'null'))
    if (Array.isArray(p)) {
      glossary = p.filter((g): g is { en: string; zh: string } => typeof g?.en === 'string' && typeof g?.zh === 'string')
    }
  } catch {
    /* glossary 保持 null */
  }
  return {
    id: Number(r.id),
    title: String(r.title),
    authors: parseJsonArr(r.authors),
    year: (r.year as number | null) ?? null,
    date: (r.date as string | null) ?? null,
    summary: String(r.summary ?? ''),
    tags: parseJsonArr(r.tags),
    language: r.language === 'en' ? 'en' : 'zh',
    url: String(r.url),
    source: String(r.source ?? ''),
    domain_id: (r.domain_id as number | null) ?? null,
    domain_name: (r.domain_name as string | null) ?? null,
    status: r.status === 'ready' ? 'ready' : 'meta_only',
    fulltext_path: (r.fulltext_path as string | null) ?? null,
    glossary,
    concepts: parseConcepts(r.concepts),
    discovery_id: (r.discovery_id as number | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at)
  }
}

const SCIENCE_SELECT = 'SELECT s.*, d.name AS domain_name FROM science_articles s LEFT JOIN agent_domains d ON d.id = s.domain_id'

export function listScienceArticles(): ScienceArticleRow[] {
  const rows = getDb().prepare(`${SCIENCE_SELECT} ORDER BY s.id DESC`).all() as unknown as Record<string, unknown>[]
  return rows.map(hydrateScience)
}

export function getScienceArticle(id: number): ScienceArticleRow | null {
  const r = getDb().prepare(`${SCIENCE_SELECT} WHERE s.id = ?`).get(id) as Record<string, unknown> | undefined
  return r ? hydrateScience(r) : null
}

export function listScienceHighlights(articleId: number): ScienceHighlightRow[] {
  return getDb()
    .prepare('SELECT * FROM science_highlights WHERE article_id = ? ORDER BY id DESC')
    .all(articleId) as unknown as ScienceHighlightRow[]
}

// ---------- 转正分流（papers.acceptDiscover 路由目标） ----------

/** discover（source_type='article'）→ science_articles；随后 science_fetch 抓全文并按语言自动解读 */
export function scienceAcceptRow(row: Record<string, unknown>): { scienceId: number } {
  const d = getDb()
  const now = nowIso()
  const discoverId = Number(row.id)
  const r = d
    .prepare(
      "INSERT INTO science_articles (title, authors, year, date, summary, tags, language, url, source, domain_id, status, discovery_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'meta_only', ?, ?, ?)"
    )
    .run(
      String(row.title),
      String(row.authors ?? '[]'),
      (row.year as number | null) ?? null,
      (row.date as string | null) ?? null,
      String(row.summary ?? ''),
      String(row.tags ?? '[]'),
      row.language === 'en' ? 'en' : 'zh',
      String(row.url),
      String(row.source ?? ''),
      (row.domain_id as number | null) ?? null,
      discoverId,
      now,
      now
    )
  d.prepare("UPDATE discover_items SET status = 'accepted' WHERE id = ?").run(discoverId)
  const scienceId = Number(r.lastInsertRowid)
  enqueue('science_fetch', { refId: scienceId, trigger: 'auto' })
  return { scienceId }
}

// ---------- 全文抓取（science_fetch） ----------

function txtPath(articleId: number): string {
  return join(userDataDir(), 'science', `${articleId}.txt`)
}

export function readScienceFulltext(articleId: number): string | null {
  const p = txtPath(articleId)
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

/** 抓全文：成功置 ready 并落 science/{id}.txt；任一步失败置 meta_only（不抛错，降级合法） */
export async function ensureScienceFulltext(article: ScienceArticleRow): Promise<void> {
  if (article.status === 'ready' && existsSync(txtPath(article.id))) return
  const d = getDb()
  const fail = (reason: string): void => {
    d.prepare("UPDATE science_articles SET status = 'meta_only', updated_at = ? WHERE id = ?").run(nowIso(), article.id)
    console.warn(`[agent:science] 《${article.title}》全文抓取失败（meta_only）：${reason}`)
  }
  try {
    const { text: html } = await politeFetch(article.url)
    const { document } = parseHTML(html)
    const parsed = new Readability(document).parse()
    const plain = (parsed?.textContent ?? '').replace(/\s+\n/g, '\n').trim()
    if (plain.length < 200) throw new Error('正文过短')
    writeFileSync(txtPath(article.id), plain, 'utf-8')
    d.prepare("UPDATE science_articles SET status = 'ready', fulltext_path = ?, updated_at = ? WHERE id = ?").run(
      `science/${article.id}.txt`,
      nowIso(),
      article.id
    )
    console.info(`[agent:science] 《${article.title}》全文就绪（${Math.round(plain.length / 1000)}k 字符）`)
  } catch (e) {
    fail((e as Error).message)
  }
}

/** 按语言自动解读入队（已有同类产物/进行中则跳过）；en→全文解读、zh→轻加工 */
function enqueueAutoInterpret(articleId: number): void {
  const a = getScienceArticle(articleId)
  if (!a) return
  const kind = a.language === 'en' ? 'translation' : 'light'
  const existing = getDb()
    .prepare("SELECT id FROM interpretations WHERE owner_type = 'science_article' AND owner_id = ? AND kind = ?")
    .get(articleId, kind)
  if (existing) return
  enqueue(a.language === 'en' ? 'science_translate' : 'science_light', { refId: articleId, trigger: 'auto' })
}

async function scienceFetchRunner(ctx: TaskContext): Promise<void> {
  const article = getScienceArticle(ctx.refId ?? 0)
  if (!article) throw new Error('NOT_FOUND')
  await ensureScienceFulltext(article)
  enqueueAutoInterpret(article.id)
}

registerTask({ type: 'science_fetch', priority: 10, singleton: true, maxRetries: 1 }, scienceFetchRunner)

/** meta_only 条目「重试抓取」：成功后照常入队自动解读 */
export async function retryScienceFetch(id: number): Promise<void> {
  const article = getScienceArticle(id)
  if (!article) throw new Error('NOT_FOUND')
  await ensureScienceFulltext(article)
  enqueueAutoInterpret(id)
}

// ---------- 删除（彻底删，不入回收站；先库后文件） ----------

export function deleteScienceArticle(id: number): void {
  const d = getDb()
  const article = getScienceArticle(id)
  if (!article) return
  const interps = d
    .prepare("SELECT md_path FROM interpretations WHERE owner_type = 'science_article' AND owner_id = ?")
    .all(id) as { md_path: string | null }[]
  d.prepare("DELETE FROM interpretations WHERE owner_type = 'science_article' AND owner_id = ?").run(id)
  d.prepare('DELETE FROM science_highlights WHERE article_id = ?').run(id)
  d.prepare("DELETE FROM embeddings WHERE entity_type = 'science_article' AND entity_id = ?").run(id)
  d
    .prepare("DELETE FROM knowledge_links WHERE (src_type = 'science_article' AND src_id = ?) OR (dst_type = 'science_article' AND dst_id = ?)")
    .run(id, id)
  d.prepare('DELETE FROM science_articles WHERE id = ?').run(id)
  for (const it of interps) mdDelete(it.md_path)
  try {
    unlinkSync(txtPath(id))
  } catch {
    /* 无该文件 */
  }
  console.info(`[agent:science] 科普文章 #${id}《${article.title}》已彻底删除（含 ${interps.length} 份解读产物）`)
}

// ---------- 划词高光（万象词条同机制：md 标记由渲染层写，此处管登记表） ----------

export function addScienceHighlight(articleId: number, text: string): void {
  const d = getDb()
  const dup = d.prepare('SELECT id FROM science_highlights WHERE article_id = ? AND text = ?').get(articleId, text)
  if (dup) return
  d.prepare('INSERT INTO science_highlights (article_id, text, created_at) VALUES (?, ?, ?)').run(articleId, text, nowIso())
}

export function removeScienceHighlight(articleId: number, text: string): void {
  getDb().prepare('DELETE FROM science_highlights WHERE article_id = ? AND text = ?').run(articleId, text)
}

// ---------- 词条↔文章双向链接 ----------

/** 解读产物完成尾调用：concepts 逐 term 匹配 wiki_entries（精确=1 / 双向模糊=0.8）→ similarity 建链 + entry_id 回填 */
export function linkConcepts(articleId: number): void {
  const d = getDb()
  const article = getScienceArticle(articleId)
  if (!article || article.concepts.length === 0) return
  let changed = false
  const next = article.concepts.map((c) => {
    if (c.entry_id != null) return c
    const term = c.term.trim()
    if (!term) return c
    let hit = d
      .prepare("SELECT id FROM wiki_entries WHERE term = ? AND deleted_at IS NULL AND state != 'pool' ORDER BY id LIMIT 1")
      .get(term) as { id: number } | undefined
    let score = 1
    if (!hit) {
      hit = d
        .prepare(
          "SELECT id FROM wiki_entries WHERE deleted_at IS NULL AND state != 'pool' AND (term LIKE ? OR (? LIKE '%' || term || '%' AND LENGTH(term) >= 2)) ORDER BY id LIMIT 1"
        )
        .get(`%${term}%`, term) as { id: number } | undefined
      score = 0.8
    }
    if (!hit) return c
    changed = true
    try {
      d
        .prepare("INSERT OR IGNORE INTO knowledge_links (src_type, dst_type, src_id, dst_id, origin, score, created_at) VALUES ('science_article', 'wiki', ?, ?, 'similarity', ?, ?)")
        .run(articleId, hit.id, score, nowIso())
    } catch {
      /* 链接失败不影响 */
    }
    return { ...c, entry_id: hit.id }
  })
  if (changed) {
    d.prepare('UPDATE science_articles SET concepts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), nowIso(), articleId)
  }
}

/** 解读产物完成尾合并 concepts（保留既有 entry_id；总量封顶 30） */
export function mergeScienceConcepts(articleId: number, terms: string[]): void {
  const article = getScienceArticle(articleId)
  if (!article) return
  const existing = new Map(article.concepts.map((c) => [c.term, c]))
  for (const t of terms) {
    const term = t.trim()
    if (!term) continue
    if (!existing.has(term)) existing.set(term, { term, entry_id: null })
  }
  getDb()
    .prepare('UPDATE science_articles SET concepts = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify([...existing.values()].slice(0, 30)), nowIso(), articleId)
}

/** 「建词条」成功回写：concepts.entry_id 回填 + manual 链接（人确认写入语义归位 origin='manual'） */
export function scienceLinkManual(articleId: number, term: string, entryId: number): void {
  const d = getDb()
  const row = d.prepare('SELECT concepts FROM science_articles WHERE id = ?').get(articleId) as
    | { concepts: string }
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  const concepts = parseConcepts(row.concepts)
  const idx = concepts.findIndex((c) => c.term === term)
  if (idx >= 0) concepts[idx] = { ...concepts[idx], entry_id: entryId }
  else concepts.push({ term, entry_id: entryId })
  d.prepare('UPDATE science_articles SET concepts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(concepts), nowIso(), articleId)
  try {
    d
      .prepare("INSERT OR IGNORE INTO knowledge_links (src_type, dst_type, src_id, dst_id, origin, score, created_at) VALUES ('science_article', 'wiki', ?, ?, 'manual', 1, ?)")
      .run(articleId, entryId, nowIso())
  } catch {
    /* 链接失败不阻塞 */
  }
}

/** 实体标题解析（knowledge_links 联表展示；批次F 补 book/learn_node） */
export function resolveEntityTitle(type: string, id: number): string {
  if (type === 'paper') {
    const r = getDb().prepare('SELECT title FROM papers WHERE id = ?').get(id) as { title: string } | undefined
    return r?.title ?? ''
  }
  if (type === 'wiki') {
    const r = getDb().prepare('SELECT term FROM wiki_entries WHERE id = ?').get(id) as { term: string } | undefined
    return r?.term ?? ''
  }
  if (type === 'science_article') {
    const r = getDb().prepare('SELECT title FROM science_articles WHERE id = ?').get(id) as { title: string } | undefined
    return r?.title ?? ''
  }
  if (type === 'book') {
    const r = getDb().prepare('SELECT title FROM books WHERE id = ?').get(id) as { title: string } | undefined
    return r?.title ?? ''
  }
  if (type === 'learn_node') {
    const r = getDb().prepare('SELECT title FROM learn_nodes WHERE id = ? AND level = 2').get(id) as
      | { title: string }
      | undefined
    return r?.title ?? ''
  }
  return ''
}

export interface LinkRow {
  link_id: number
  peer_type: string
  peer_id: number
  title: string
  origin: 'manual' | 'similarity'
  score: number
}

/** 双向合并查询：给定一端，返回全部链接（两方向），peer 标题已解析 */
export function listLinks(srcType: string, srcId: number): LinkRow[] {
  const rows = getDb()
    .prepare(
      'SELECT id, src_type, dst_type, src_id, dst_id, origin, score FROM knowledge_links WHERE (src_type = ? AND src_id = ?) OR (dst_type = ? AND dst_id = ?) ORDER BY score DESC, id DESC'
    )
    .all(srcType, srcId, srcType, srcId) as unknown as {
    id: number
    src_type: string
    dst_type: string
    src_id: number
    dst_id: number
    origin: 'manual' | 'similarity'
    score: number
  }[]
  return rows
    .map((r) => {
      const peerIsDst = r.src_type === srcType && r.src_id === srcId
      const peerType = peerIsDst ? r.dst_type : r.src_type
      const peerId = peerIsDst ? r.dst_id : r.src_id
      return {
        link_id: r.id,
        peer_type: peerType,
        peer_id: peerId,
        title: resolveEntityTitle(peerType, peerId),
        origin: r.origin,
        score: r.score
      }
    })
    .filter((x) => !!x.title)
}

/** 科普详情「相关内容」（批次F：双向合并全量 LinkRow，含 link_id/origin） */
export function scienceRelated(articleId: number): LinkRow[] {
  return listLinks('science_article', articleId)
}

/** 相关内容标题检索（批次F 五类型全量） */
export function entitySearch(type: string, q: string): { id: number; title: string }[] {
  const kw = `%${q.trim()}%`
  if (!q.trim()) return []
  if (type === 'paper') {
    return getDb()
      .prepare('SELECT id, title FROM papers WHERE title LIKE ? ORDER BY id DESC LIMIT 10')
      .all(kw) as unknown as { id: number; title: string }[]
  }
  if (type === 'science_article') {
    return getDb()
      .prepare('SELECT id, title FROM science_articles WHERE title LIKE ? ORDER BY id DESC LIMIT 10')
      .all(kw) as unknown as { id: number; title: string }[]
  }
  if (type === 'book') {
    return getDb()
      .prepare('SELECT id, title FROM books WHERE title LIKE ? ORDER BY id DESC LIMIT 10')
      .all(kw) as unknown as { id: number; title: string }[]
  }
  if (type === 'learn_node') {
    return getDb()
      .prepare('SELECT id, title FROM learn_nodes WHERE level = 2 AND deleted_at IS NULL AND title LIKE ? ORDER BY id DESC LIMIT 10')
      .all(kw) as unknown as { id: number; title: string }[]
  }
  if (type === 'wiki') {
    return (
      getDb()
        .prepare("SELECT id, term AS title FROM wiki_entries WHERE term LIKE ? AND deleted_at IS NULL AND state != 'pool' ORDER BY id DESC LIMIT 10")
        .all(kw) as unknown as { id: number; title: string }[]
    )
  }
  return []
}

/** 手动建链（origin='manual'，UNIQUE 冲突静默跳过；批次 F KnowledgeLinksDialog 用） */
export function addLink(srcType: string, srcId: number, dstType: string, dstId: number): void {
  if (srcType === dstType && srcId === dstId) return
  try {
    getDb()
      .prepare("INSERT OR IGNORE INTO knowledge_links (src_type, dst_type, src_id, dst_id, origin, score, created_at) VALUES (?, ?, ?, ?, 'manual', 1, ?)")
      .run(srcType, dstType, srcId, dstId, nowIso())
  } catch {
    /* 冲突静默 */
  }
}

export function deleteLink(linkId: number): void {
  getDb().prepare('DELETE FROM knowledge_links WHERE id = ?').run(linkId)
}
