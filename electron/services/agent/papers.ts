import { logInfo, logWarn } from '../logger'
// 正式文献服务（260929 抓取三页签阅读改造）：发现箱终选转正（转正入队 paper_fetch 幂等管道：
// 抓全文 → en 译文 → ready → embed）、全文抓取（管线在 docText：PDF 直链/网页自适应）、
// 手动传 PDF 兜底。抓取失败降级 meta_only，主管道不炸。
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, nowIso, userDataDir } from '../../db/db'
import { extractPdfText, fetchDocText } from './docText'
import { mdDelete, mdWrite } from '../files'
import { enqueue } from './queue'
import { scienceAcceptRow } from './science'
import type { DiscoverItemRow, InterpretationRow, PaperRow } from '../../../src/shared/types'

function parseJsonArr(raw: unknown): string[] {
  try {
    const p = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function hydrateDiscover(r: Record<string, unknown>): DiscoverItemRow {
  return {
    id: Number(r.id),
    source_type: r.source_type === 'article' ? 'article' : 'paper',
    title: String(r.title),
    authors: parseJsonArr(r.authors),
    year: (r.year as number | null) ?? null,
    date: (r.date as string | null) ?? null,
    summary: String(r.summary ?? ''),
    tags: parseJsonArr(r.tags),
    language: String(r.language ?? 'en'),
    length_est: String(r.length_est ?? ''),
    url: String(r.url),
    source: String(r.source ?? ''),
    reason: String(r.reason ?? ''),
    status: (r.status as DiscoverItemRow['status']) ?? 'discovered',
    domain_id: (r.domain_id as number | null) ?? null,
    created_at: String(r.created_at)
  }
}

function hydratePaper(r: Record<string, unknown>): PaperRow {
  return {
    id: Number(r.id),
    title: String(r.title),
    authors: parseJsonArr(r.authors),
    year: (r.year as number | null) ?? null,
    date: (r.date as string | null) ?? null,
    summary: String(r.summary ?? ''),
    tags: parseJsonArr(r.tags),
    language: String(r.language ?? 'en'),
    url: String(r.url),
    source: String(r.source ?? ''),
    status: r.status === 'meta_only' ? 'meta_only' : 'ready',
    fulltext_path: (r.fulltext_path as string | null) ?? null,
    digest_md: (r.digest_md as string | null) ?? null,
    glossary: (r.glossary as string | null) ?? null,
    domain_id: (r.domain_id as number | null) ?? null,
    discovery_id: (r.discovery_id as number | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at)
  }
}

export function listDiscover(status?: DiscoverItemRow['status']): DiscoverItemRow[] {
  const rows = (
    status
      ? getDb().prepare('SELECT * FROM discover_items WHERE status = ? ORDER BY id DESC').all(status)
      : getDb().prepare('SELECT * FROM discover_items ORDER BY id DESC').all()
  ) as unknown as Record<string, unknown>[]
  return rows.map(hydrateDiscover)
}

export function rejectDiscover(id: number): void {
  getDb().prepare("UPDATE discover_items SET status = 'rejected' WHERE id = ?").run(id)
}

export function acceptDiscover(id: number): { paperId: number } | { scienceId: number } {
  const d = getDb()
  const row = d.prepare('SELECT * FROM discover_items WHERE id = ?').get(id) as
    | (Record<string, unknown> & { status: string; source_type: string })
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  if (row.status !== 'discovered') throw new Error('该条目已处理')
  // 科普分流（批次D）：article 条目转正入 science_articles，主进程路由、渲染层零分支
  if (row.source_type === 'article') return scienceAcceptRow(row)
  const now = nowIso()
  // 转正即 meta_only（全文未抓不标就绪，260928 三态化）；抓取中由 task_runs 派生显示
  const r = d
    .prepare(
      "INSERT INTO papers (title, authors, year, date, summary, tags, language, url, source, status, domain_id, discovery_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'meta_only', ?, ?, ?, ?)"
    )
    .run(
      String(row.title),
      String(row.authors ?? '[]'),
      (row.year as number | null) ?? null,
      (row.date as string | null) ?? null,
      String(row.summary ?? ''),
      String(row.tags ?? '[]'),
      String(row.language ?? 'en'),
      String(row.url),
      String(row.source ?? ''),
      (row.domain_id as number | null) ?? null,
      id,
      now,
      now
    )
  d.prepare("UPDATE discover_items SET status = 'accepted' WHERE id = ?").run(id)
  const paperId = Number(r.lastInsertRowid)
  // 转正即自动管道：抓全文 → en 译文 → ready → embed_index（paper_fetch runner 内串，260929 三页签改造）
  enqueue('paper_fetch', { refId: paperId, trigger: 'auto' })
  return { paperId }
}

export function listPapers(): PaperRow[] {
  const rows = getDb().prepare('SELECT * FROM papers ORDER BY id DESC').all() as unknown as Record<string, unknown>[]
  // 自愈（260928 三态化）：标 ready 但缓存文件缺失 → 回 meta_only 并重新入队抓取
  // （治「转正后抓取中途退出 App，启动恢复把任务终态化，论文永远就绪却读不出」的死状态）
  const d = getDb()
  for (const r of rows) {
    const id = Number(r.id)
    if (r.status === 'ready' && !existsSync(mdPath(id)) && !existsSync(txtPath(id))) {
      d.prepare("UPDATE papers SET status = 'meta_only', updated_at = ? WHERE id = ?").run(nowIso(), id)
      r.status = 'meta_only'
      enqueue('paper_fetch', { refId: id, trigger: 'auto' })
      logWarn('agent', `[agent:papers] #${id}《${String(r.title)}》就绪但缓存缺失，已自动重抓`)
    }
  }
  return rows.map(hydratePaper)
}

export function getPaperRaw(id: number): Record<string, unknown> | undefined {
  return getDb().prepare('SELECT * FROM papers WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
}

export function getPaper(id: number): PaperRow | null {
  const r = getPaperRaw(id)
  return r ? hydratePaper(r) : null
}

export function listInterpretations(ownerId: number): InterpretationRow[] {
  return getDb()
    .prepare('SELECT * FROM interpretations WHERE owner_type = ? AND owner_id = ? ORDER BY id DESC')
    .all('paper', ownerId) as unknown as InterpretationRow[]
}

/** 发现箱待终选数（任务中心/总导览用；260923 修订：科普候选归万象库科普页签，此处只计论文） */
export function pendingDiscoverCount(): number {
  const r = getDb()
    .prepare("SELECT COUNT(*) AS n FROM discover_items WHERE status = 'discovered' AND source_type = 'paper'")
    .get() as { n: number }
  return Number(r.n) || 0
}

/** 删除发现条目（彻底删，不入回收站；连带其向量） */
export function deleteDiscover(id: number): void {
  const d = getDb()
  d.prepare("DELETE FROM embeddings WHERE entity_type = 'discover' AND entity_id = ?").run(id)
  d.prepare('DELETE FROM discover_items WHERE id = ?').run(id)
}

/** 删除正式文献（彻底删，不入回收站）：连带解读产物 md、全文/ PDF 缓存、向量、知识链接 */
export function deletePaper(id: number): void {
  const d = getDb()
  const paper = getPaper(id)
  if (!paper) return
  const interps = d
    .prepare('SELECT md_path FROM interpretations WHERE owner_type = ? AND owner_id = ?')
    .all('paper', id) as { md_path: string | null }[]
  d.prepare("DELETE FROM interpretations WHERE owner_type = 'paper' AND owner_id = ?").run(id)
  d.prepare("DELETE FROM embeddings WHERE entity_type = 'paper' AND entity_id = ?").run(id)
  d.prepare("DELETE FROM knowledge_links WHERE (src_type = 'paper' AND src_id = ?) OR (dst_type = 'paper' AND dst_id = ?)").run(id, id)
  d.prepare('DELETE FROM papers WHERE id = ?').run(id)
  // 文件清理放库后（库删成功为主，文件失败仅留痕）
  for (const it of interps) mdDelete(it.md_path)
  for (const suffix of ['.md', '.txt', '.pdf']) {
    try {
      unlinkSync(join(userDataDir(), 'papers', `${id}${suffix}`))
    } catch {
      /* 无该文件 */
    }
  }
  logInfo('agent', `[agent:papers] 文献 #${id}《${paper.title}》已彻底删除（含 ${interps.length} 份解读产物）`)
}

/** 全文缓存绝对路径（HTML 抓取=保排版 Markdown .md；PDF 抽取/存量=纯文本 .txt，渲染层按行切段） */
function txtPath(paperId: number): string {
  return join(userDataDir(), 'papers', `${paperId}.txt`)
}

function mdPath(paperId: number): string {
  return join(userDataDir(), 'papers', `${paperId}.md`)
}

function pdfPath(paperId: number): string {
  return join(userDataDir(), 'papers', `${paperId}.pdf`)
}

export function readFulltext(paperId: number): string | null {
  for (const p of [mdPath(paperId), txtPath(paperId)]) {
    if (existsSync(p)) return readFileSync(p, 'utf-8')
  }
  return null
}

/** 原文渲染源（IPC agent:paperFulltext）：isMd=true 直接按 Markdown 渲染；false 纯文本按行切段 */
export function readPaperSource(paperId: number): { raw: string | null; isMd: boolean } {
  const mdP = mdPath(paperId)
  if (existsSync(mdP)) return { raw: readFileSync(mdP, 'utf-8'), isMd: true }
  const txtP = txtPath(paperId)
  if (existsSync(txtP)) return { raw: readFileSync(txtP, 'utf-8'), isMd: false }
  return { raw: null, isMd: false }
}

/** arXiv 链接 → 规范 id（arxiv.org/abs/2101.00001 / /pdf/2101.00001v2 → 2101.00001） */
function arxivIdOf(url: string): string | null {
  const m = url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/)
  if (!m) return null
  return m[1].replace(/\.pdf$/, '').replace(/v\d+$/, '')
}

/** 抓全文缓存（不置 ready——ready 由 paper_fetch 管道在译文就绪后统一置）；
 *  HTML 落保排版 .md、PDF 落纯文本 .txt；缓存已可用（.md 存在，或 ≥200 字符）直接返回——
 *  仅存量 .txt 亦重抓升级 .md（排版保留，260929），任一步失败置 meta_only（不抛错） */
export async function ensureFulltext(paper: PaperRow): Promise<void> {
  const cached = readFulltext(paper.id)
  if (cached && cached.length >= 200 && existsSync(mdPath(paper.id))) return
  const d = getDb()
  const fail = (reason: string): void => {
    d.prepare("UPDATE papers SET status = 'meta_only', updated_at = ? WHERE id = ?").run(nowIso(), paper.id)
    logWarn('agent', `[agent:papers] 《${paper.title}》全文抓取失败（meta_only）：${reason}`)
  }
  try {
    const aid = arxivIdOf(paper.url)
    const doc = await fetchDocText(aid ? `https://arxiv.org/pdf/${aid}` : paper.url, {
      pdfSink: pdfPath(paper.id),
      asPdf: Boolean(aid)
    })
    if (doc.text.length < 200) {
      throw new Error(doc.kind === 'pdf' ? '抽取文本过短（扫描版 PDF 无文本层？）' : '正文过短')
    }
    const isMd = doc.kind === 'html' && !!doc.md
    writeFileSync(isMd ? mdPath(paper.id) : txtPath(paper.id), isMd ? doc.md! : doc.text, 'utf-8')
    d.prepare('UPDATE papers SET fulltext_path = ?, updated_at = ? WHERE id = ?').run(
      `papers/${paper.id}${isMd ? '.md' : '.txt'}`,
      nowIso(),
      paper.id
    )
    logInfo(
      'agent',
      `[agent:papers] 《${paper.title}》全文缓存就绪（${isMd ? 'Markdown 保排版' : '纯文本'}，${Math.round(doc.text.length / 1000)}k 字符）`
    )
  } catch (e) {
    fail((e as Error).message)
  }
}

/** 手动传 PDF 兜底：复制入 papers/{id}.pdf → 抽取缓存（不置 ready）；IPC 成功后入队 paper_fetch 补译/就绪 */
export async function importManualPdf(paperId: number, srcAbsPath: string): Promise<boolean> {
  const paper = getPaper(paperId)
  if (!paper) throw new Error('NOT_FOUND')
  copyFileSync(srcAbsPath, pdfPath(paperId))
  try {
    const text = await extractPdfText(pdfPath(paperId))
    if (text.length < 200) throw new Error('抽取文本过短（扫描版 PDF 无文本层？）')
    writeFileSync(txtPath(paperId), text, 'utf-8')
    getDb()
      .prepare('UPDATE papers SET fulltext_path = ?, updated_at = ? WHERE id = ?')
      .run(`papers/${paperId}.txt`, nowIso(), paperId)
    logInfo('agent', `[agent:papers] 《${paper.title}》手动 PDF 导入成功（ready 由 paper_fetch 管道置）`)
    return true
  } catch (e) {
    logWarn('agent', `[agent:papers] 手动 PDF 抽取失败：${(e as Error).message}`)
    throw e
  }
}

/** 重试抓取（260929 三页签改造）：幂等入队 paper_fetch（抓缺 → 译缺 → 建链/就绪），
 *  行内重试与导入 PDF 补译共用同一入口 */
export function retryPaperFetch(paperId: number): void {
  if (!getPaper(paperId)) throw new Error('NOT_FOUND')
  enqueue('paper_fetch', { refId: paperId, trigger: 'manual' })
}

// ---------- 导读卡产物登记工具（interpret.ts 共用） ----------

export function upsertInterpretation(
  ownerType: InterpretationRow['owner_type'],
  ownerId: number,
  kind: InterpretationRow['kind'],
  mdPath: string,
  tokensUsed: number
): void {
  const d = getDb()
  const now = nowIso()
  const existing = d
    .prepare('SELECT id FROM interpretations WHERE owner_type = ? AND owner_id = ? AND kind = ?')
    .get(ownerType, ownerId, kind) as { id: number } | undefined
  if (existing) {
    d.prepare('UPDATE interpretations SET status = ?, md_path = ?, tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?').run(
      'done',
      mdPath,
      tokensUsed,
      now,
      existing.id
    )
    return
  }
  d.prepare(
    "INSERT INTO interpretations (owner_type, owner_id, kind, status, md_path, tokens_used, created_at, updated_at) VALUES (?, ?, ?, 'done', ?, ?, ?, ?)"
  ).run(ownerType, ownerId, kind, mdPath, tokensUsed, now, now)
}

export function writeInterpretationMd(name: string, content: string): string {
  const rel = `md/interpretations/${name}`
  mdWrite(rel, content)
  return rel
}
