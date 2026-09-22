// 书籍全文抽取（超级工作台 2.0 批次E spec §1）：epub（unzipSync → container.xml → OPF →
// spine 顺序 xhtml 剥标签，spine 缺失兜底 manifest 全量）/ pdf（复用 papers.extractPdfText）
// → books/{id}.txt 一次性缓存；<200 字符视为抽取失败抛错（扫描版/异构包），不炸其他功能。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import { getDb, userDataDir } from '../../db/db'
import { extractPdfText } from './papers'

/** XML 解析器（OPF/container.xml；属性带 @_ 前缀，books.ts 同款） */
const xml = new XMLParser({ ignoreAttributes: false })

/** XML 值取文本（books.ts 同款容错） */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (v && typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)['#text'] ?? '').trim()
  }
  return ''
}

/** 值归一为数组（fast-xml-parser 单子节点返回对象、多节点返回数组） */
function toArray(v: unknown): Record<string, unknown>[] {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]) as Record<string, unknown>[]
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

export interface BookFileRef {
  id: number
  title: string
  author: string
  format: 'epub' | 'pdf'
  file_path: string
}

export function getBookRow(id: number): BookFileRef | null {
  const r = getDb()
    .prepare('SELECT id, title, author, format, file_path FROM books WHERE id = ?')
    .get(id) as BookFileRef | undefined
  return r ?? null
}

export function bookFulltextPath(bookId: number): string {
  return join(userDataDir(), 'books', `${bookId}.txt`)
}

export function readBookFulltext(bookId: number): string | null {
  const p = bookFulltextPath(bookId)
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

/** epub → 纯文本：spine 顺序逐项 xhtml 剥标签；spine 缺失/解析失败兜底 manifest 全部 xhtml */
function epubText(buf: Buffer): string {
  const files = unzipSync(new Uint8Array(buf))
  const container = files['META-INF/container.xml']
  if (!container) return ''
  const containerXml = xml.parse(Buffer.from(container).toString('utf-8')) as Record<string, unknown>
  const rootfile = (containerXml?.container as Record<string, unknown>)?.rootfiles
  const one = Array.isArray(rootfile) ? rootfile[0] : rootfile
  const opfPath = typeof one === 'object' && one !== null ? String((one as Record<string, unknown>)['@_full-path'] ?? '') : ''
  if (!opfPath) return ''
  const opf = files[opfPath]
  if (!opf) return ''
  const opfXml = xml.parse(Buffer.from(opf).toString('utf-8')) as Record<string, unknown>
  const pkg = opfXml.package as Record<string, unknown> | undefined
  const manifest = pkg?.manifest as Record<string, unknown> | undefined
  const items = toArray(manifest?.item)
  const isXhtml = (href: string, mt: string): boolean =>
    mt.includes('xhtml') || mt.includes('html') || /\.x?html?$/i.test(href)
  const idToHref = new Map<string, string>()
  const xhtmlHrefs: string[] = []
  for (const it of items) {
    const href = String(it?.['@_href'] ?? '')
    const mt = String(it?.['@_media-type'] ?? '')
    const id = textOf(it?.['@_id'])
    if (!href) continue
    if (id) idToHref.set(id, href)
    if (isXhtml(href, mt)) xhtmlHrefs.push(href)
  }
  // spine 顺序优先
  const spine = pkg?.spine as Record<string, unknown> | undefined
  const itemrefs = toArray(spine?.itemref)
  let order: string[] = []
  for (const r of itemrefs) {
    const href = idToHref.get(String(r?.['@_idref'] ?? ''))
    if (href) order.push(href)
  }
  if (order.length === 0) order = xhtmlHrefs
  const parts: string[] = []
  for (const href of order) {
    let zipPath = href
    try {
      zipPath = decodeURIComponent(href)
    } catch {
      /* 保持原样 */
    }
    const rel = join(dirname(opfPath), zipPath).replace(/\\/g, '/')
    const bytes = files[rel] ?? files[zipPath]
    if (!bytes) continue
    const txt = stripHtml(Buffer.from(bytes).toString('utf-8'))
    if (txt) parts.push(txt)
  }
  return parts.join('\n\n')
}

/** 全书章节标题清单（导读结构感知用：书超长截断时注入，最多 80 行） */
export function extractOutline(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim()
    if (!line || line.length > 40) continue
    if (
      /^(第[一二三四五六七八九十百千0-9]+[章节篇部卷]|Chapter\s+\d+|CHAPTER\s+\d+|[0-9]{1,3}[.、]\s*\S+)/.test(
        line
      )
    ) {
      const key = line.replace(/\s+/g, '')
      if (!seen.has(key)) {
        seen.add(key)
        out.push(line)
        if (out.length >= 80) break
      }
    }
  }
  return out
}

/** 抽取（带缓存）：books/{id}.txt ≥200 字符直接复用；否则按格式抽取并写缓存 */
export async function ensureBookFulltext(book: BookFileRef): Promise<string> {
  const cached = readBookFulltext(book.id)
  if (cached && cached.length >= 200) return cached
  let text = ''
  if (book.format === 'pdf') {
    text = await extractPdfText(join(userDataDir(), book.file_path))
  } else {
    text = epubText(readFileSync(join(userDataDir(), book.file_path)))
  }
  if (text.length < 200) {
    throw new Error('全文抽取失败：扫描版 PDF 无文本层或 epub 结构异常（无文本内容无法生成导读）')
  }
  writeFileSync(bookFulltextPath(book.id), text, 'utf-8')
  console.info(`[agent:booktext] 《${book.title}》全文就绪（${Math.round(text.length / 1000)}k 字符）`)
  return text
}
