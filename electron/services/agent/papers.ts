// 正式文献服务（超级工作台 2.0 批次B spec §2）：发现箱终选转正、全文抓取
// （arXiv PDF → pdfjs legacy 抽文本 / 网页 → readability 抽正文）、手动传 PDF 兜底。
// 抓取失败降级 meta_only，主管道不炸（总纲 §5.1 兜底）。
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { getDb, nowIso, userDataDir } from '../../db/db'
import { mdDelete, mdWrite } from '../files'
import { politeFetch, politeFetchBinary } from './guardrails'
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
  const r = d
    .prepare(
      "INSERT INTO papers (title, authors, year, date, summary, tags, language, url, source, status, discovery_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)"
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
      id,
      now,
      now
    )
  d.prepare("UPDATE discover_items SET status = 'accepted' WHERE id = ?").run(id)
  const paperId = Number(r.lastInsertRowid)
  // 转正即自动管道：抓全文 → 导读卡 → embed_index（make_digest runner 内串）
  enqueue('make_digest', { refId: paperId, trigger: 'auto' })
  return { paperId }
}

export function listPapers(): PaperRow[] {
  const rows = getDb().prepare('SELECT * FROM papers ORDER BY id DESC').all() as unknown as Record<string, unknown>[]
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
  for (const suffix of ['.txt', '.pdf']) {
    try {
      unlinkSync(join(userDataDir(), 'papers', `${id}${suffix}`))
    } catch {
      /* 无该文件 */
    }
  }
  console.info(`[agent:papers] 文献 #${id}《${paper.title}》已彻底删除（含 ${interps.length} 份解读产物）`)
}

/** 全文缓存绝对路径 */
function txtPath(paperId: number): string {
  return join(userDataDir(), 'papers', `${paperId}.txt`)
}

function pdfPath(paperId: number): string {
  return join(userDataDir(), 'papers', `${paperId}.pdf`)
}

export function readFulltext(paperId: number): string | null {
  const p = txtPath(paperId)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf-8')
}

/** arXiv 链接 → 规范 id（arxiv.org/abs/2101.00001 / /pdf/2101.00001v2 → 2101.00001） */
function arxivIdOf(url: string): string | null {
  const m = url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/)
  if (!m) return null
  return m[1].replace(/\.pdf$/, '').replace(/v\d+$/, '')
}

/** pdfjs legacy 构建（Node fake worker）逐页抽文本（书籍解读批次E 复用） */
export async function extractPdfText(pdfAbsPath: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(readFileSync(pdfAbsPath))
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: false })
  const doc = await loadingTask.promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    pages.push(
      tc.items
        .map((it) => ('str' in it ? (it as { str: string }).str : ''))
        .join(' ')
    )
    page.cleanup()
  }
  await loadingTask.destroy()
  return pages.join('\n\n').replace(/[ \t]+/g, ' ').trim()
}

/** 抓全文：成功置 ready 并落 papers/{id}.txt；任一步失败置 meta_only（不抛错） */
export async function ensureFulltext(paper: PaperRow): Promise<void> {
  if (paper.status === 'ready' && existsSync(txtPath(paper.id))) return
  const d = getDb()
  const fail = (reason: string): void => {
    d.prepare("UPDATE papers SET status = 'meta_only', updated_at = ? WHERE id = ?").run(nowIso(), paper.id)
    console.warn(`[agent:papers] 《${paper.title}》全文抓取失败（meta_only）：${reason}`)
  }
  try {
    let text = ''
    const aid = arxivIdOf(paper.url)
    if (aid) {
      const buf = await politeFetchBinary(`https://arxiv.org/pdf/${aid}`)
      writeFileSync(pdfPath(paper.id), buf)
      text = await extractPdfText(pdfPath(paper.id))
    } else {
      const { text: html } = await politeFetch(paper.url)
      const { document } = parseHTML(html)
      const parsed = new Readability(document).parse()
      const plain = (parsed?.textContent ?? '').replace(/\s+\n/g, '\n').trim()
      if (plain.length < 200) throw new Error('正文过短')
      text = plain
    }
    if (text.length < 200) throw new Error('抽取文本过短')
    writeFileSync(txtPath(paper.id), text, 'utf-8')
    d.prepare("UPDATE papers SET status = 'ready', fulltext_path = ?, updated_at = ? WHERE id = ?").run(
      `papers/${paper.id}.txt`,
      nowIso(),
      paper.id
    )
    console.info(`[agent:papers] 《${paper.title}》全文就绪（${Math.round(text.length / 1000)}k 字符）`)
  } catch (e) {
    fail((e as Error).message)
  }
}

/** 手动传 PDF 兜底：复制入 papers/{id}.pdf → 抽取 → 成功置 ready */
export async function importManualPdf(paperId: number, srcAbsPath: string): Promise<boolean> {
  const paper = getPaper(paperId)
  if (!paper) throw new Error('NOT_FOUND')
  copyFileSync(srcAbsPath, pdfPath(paperId))
  try {
    const text = await extractPdfText(pdfPath(paperId))
    if (text.length < 200) throw new Error('抽取文本过短（扫描版 PDF 无文本层？）')
    writeFileSync(txtPath(paperId), text, 'utf-8')
    getDb()
      .prepare("UPDATE papers SET status = 'ready', fulltext_path = ?, updated_at = ? WHERE id = ?")
      .run(`papers/${paperId}.txt`, nowIso(), paperId)
    console.info(`[agent:papers] 《${paper.title}》手动 PDF 导入成功`)
    return true
  } catch (e) {
    console.warn(`[agent:papers] 手动 PDF 抽取失败：${(e as Error).message}`)
    throw e
  }
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
