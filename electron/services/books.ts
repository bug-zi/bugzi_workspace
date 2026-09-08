// 书架服务（书架 specs §2 + 优化第1轮 §8.5）：导入（复制 + epub 元数据/封面解析 + 查重回滚）/ 删除 / 读取 / 进度 / 划词笔记
import { copyFileSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { unzipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import { getDb, nowIso, userDataDir } from '../db/db'
import type { BooksImportResult, BooksNote, BooksRecord } from '../../src/shared/types'

/** XML 解析器（OPF/container.xml；属性带 @_ 前缀） */
const xml = new XMLParser({ ignoreAttributes: false })

/** XML 值取文本：fast-xml-parser 对含属性/嵌套节点返回对象，纯文本返回字符串 */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (v && typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)['#text'] ?? '').trim()
  }
  return ''
}

/** mime → 封面扩展名（bzres 已支持的图片类型） */
function coverExt(mediaType: string, href: string): string {
  if (mediaType.includes('png')) return 'png'
  if (mediaType.includes('webp')) return 'webp'
  if (mediaType.includes('gif')) return 'gif'
  const e = extname(href).replace('.', '').toLowerCase()
  return e === 'png' || e === 'webp' || e === 'gif' ? e : 'jpg'
}

interface EpubMeta {
  title: string
  author: string
  cover: { bytes: Uint8Array; ext: string } | null
}

/** 解析 epub 包内元数据：container.xml → OPF → dc:title / dc:creator / 封面图（缺项逐级降级） */
function parseEpubMeta(buf: Buffer): EpubMeta {
  const files = unzipSync(new Uint8Array(buf))
  const container = files['META-INF/container.xml']
  if (!container) return { title: '', author: '', cover: null }
  const containerXml = xml.parse(Buffer.from(container).toString('utf-8')) as Record<string, unknown>
  const rootfile = (containerXml?.container as Record<string, unknown>)?.rootfiles as
    | Record<string, unknown>
    | undefined
  const opfPath = textOfPath(rootfile?.rootfile)
  if (!opfPath) return { title: '', author: '', cover: null }

  const opf = files[opfPath]
  if (!opf) return { title: '', author: '', cover: null }
  const opfXml = xml.parse(Buffer.from(opf).toString('utf-8')) as Record<string, unknown>
  const pkg = opfXml.package as Record<string, unknown> | undefined
  const metadata = pkg?.metadata as Record<string, unknown> | undefined
  const title = textOf(metadata?.['dc:title'])
  const author = textOf(metadata?.['dc:creator'])

  // 封面定位三级：meta[name=cover]→manifest 项 id → properties 含 cover-image → href 名含 cover 的图片项
  const manifest = pkg?.manifest as Record<string, unknown> | undefined
  const items = toArray(manifest?.item)
  let coverHref: string | null = null
  let coverType = ''
  const metas = toArray(metadata?.meta)
  const named = metas.find(
    (m) => textOf(m?.['@_name']) === 'cover' && typeof m?.['@_content'] === 'string'
  )
  if (named) {
    const item = items.find((it) => it?.['@_id'] === named['@_content'])
    if (item && String(item['@_media-type'] ?? '').startsWith('image/')) {
      coverHref = String(item['@_href'] ?? '')
      coverType = String(item['@_media-type'] ?? '')
    }
  }
  if (!coverHref) {
    const item = items.find((it) => String(it?.['@_properties'] ?? '').includes('cover-image'))
    if (item && String(item['@_media-type'] ?? '').startsWith('image/')) {
      coverHref = String(item['@_href'] ?? '')
      coverType = String(item['@_media-type'] ?? '')
    }
  }
  if (!coverHref) {
    const item = items.find(
      (it) => /cover/i.test(String(it?.['@_href'] ?? '')) && String(it?.['@_media-type'] ?? '').startsWith('image/')
    )
    if (item) {
      coverHref = String(item['@_href'] ?? '')
      coverType = String(item['@_media-type'] ?? '')
    }
  }

  let cover: EpubMeta['cover'] = null
  if (coverHref) {
    // href 相对 OPF 目录，可能百分号编码
    let zipPath = coverHref
    try {
      zipPath = decodeURIComponent(coverHref)
    } catch {
      /* 保持原样 */
    }
    const rel = join(dirname(opfPath), zipPath).replace(/\\/g, '/')
    const bytes = files[rel] ?? files[zipPath]
    if (bytes) cover = { bytes, ext: coverExt(coverType, coverHref) }
  }
  return { title, author, cover }
}

/** rootfile 节点取 full-path（单对象或数组） */
function textOfPath(rootfile: unknown): string {
  if (!rootfile) return ''
  const one = Array.isArray(rootfile) ? rootfile[0] : rootfile
  return typeof one === 'object' && one !== null ? String((one as Record<string, unknown>)['@_full-path'] ?? '') : ''
}

/** 值归一为数组（fast-xml-parser 单子节点返回对象、多节点返回数组） */
function toArray(v: unknown): Record<string, unknown>[] {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]) as Record<string, unknown>[]
}

/** 导入单本：查重 → 入库 → 复制 → 解析元数据与封面 → 回填路径；失败回滚（删行 + 清副本） */
function importOne(path: string, force: boolean): BooksImportResult {
  const ext = extname(path).toLowerCase()
  if (ext !== '.epub' && ext !== '.pdf') {
    return { path, status: 'failed', error: '不支持的格式（仅 epub/pdf）' }
  }
  const format: 'epub' | 'pdf' = ext.slice(1) as 'epub' | 'pdf'
  const size = statSync(path).size
  const fallbackTitle = basename(path, extname(path))

  // 元数据先行（查重键 = 解析后标题 + 文件大小，pdf 标题即文件名）
  let title = fallbackTitle
  let author = ''
  let epubCover: { bytes: Uint8Array; ext: string } | null = null
  if (format === 'epub') {
    const meta = parseEpubMeta(readFileSync(path))
    if (meta.title) title = meta.title
    author = meta.author
    epubCover = meta.cover
  }
  if (!force) {
    const dup = getDb().prepare('SELECT id FROM books WHERE title = ? AND file_size = ?').get(title, size)
    if (dup) return { path, status: 'duplicate', title }
  }

  const d = getDb()
  const r = d
    .prepare("INSERT INTO books (title, author, format, file_path, file_size, added_at) VALUES (?, ?, ?, 'PENDING', ?, ?)")
    .run(title, author, format, size, nowIso())
  const id = Number(r.lastInsertRowid)
  let filePath = `books/${id}.${format}`
  let coverPath: string | null = null
  try {
    copyFileSync(path, join(userDataDir(), filePath))
    if (epubCover) {
      coverPath = `covers/${id}.${epubCover.ext}`
      writeFileSync(join(userDataDir(), coverPath), epubCover.bytes)
    }
    d.prepare('UPDATE books SET file_path = ?, cover_path = ? WHERE id = ?').run(filePath, coverPath, id)
    return { path, status: 'imported', book: d.prepare('SELECT * FROM books WHERE id = ?').get(id) as unknown as BooksRecord }
  } catch (e) {
    // 回滚：删行 + 清理已复制的半成品
    d.prepare('DELETE FROM books WHERE id = ?').run(id)
    for (const p of [filePath, coverPath]) {
      if (p) {
        try {
          unlinkSync(join(userDataDir(), p))
        } catch {
          /* 不存在即无需清理 */
        }
      }
    }
    return { path, status: 'failed', error: (e as Error).message }
  }
}

/** 批量导入（渲染层：duplicate 弹确认后携 force 重导） */
export function importBooks(paths: string[], force?: boolean): BooksImportResult[] {
  return paths.map((p) => {
    try {
      return importOne(p, !!force)
    } catch (e) {
      return { path: p, status: 'failed', error: (e as Error).message }
    }
  })
}

/** 书架列表：最近阅读在前（从未读过按导入时间排后） */
export function listBooks(): BooksRecord[] {
  return getDb()
    .prepare('SELECT * FROM books ORDER BY (last_read_at IS NULL), last_read_at DESC, added_at DESC, id DESC')
    .all() as unknown as BooksRecord[]
}

/** 书籍二进制（喂 epub.js / pdfjs；文件缺失抛错由渲染层 toast） */
export function readBookFile(id: number): Uint8Array {
  const row = getDb().prepare('SELECT file_path FROM books WHERE id = ?').get(id) as
    | { file_path: string }
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  return new Uint8Array(readFileSync(join(userDataDir(), row.file_path)))
}

/** 进度保存（渲染层节流 3 秒 + 退出 flush 调用） */
export function saveProgress(
  id: number,
  p: { cfi?: string | null; page?: number | null; percent: number }
): void {
  getDb()
    .prepare(
      'UPDATE books SET progress_cfi = ?, progress_page = ?, progress_percent = ?, last_read_at = ? WHERE id = ?'
    )
    .run(p.cfi ?? null, p.page ?? null, p.percent, nowIso(), id)
}

/** 彻底删除：删行 + 级联清笔记 + 清理书籍/封面物理文件（渲染层已二次确认） */
export function deleteBook(id: number): void {
  const row = getDb().prepare('SELECT file_path, cover_path FROM books WHERE id = ?').get(id) as
    | { file_path: string; cover_path: string | null }
    | undefined
  getDb().prepare('DELETE FROM books WHERE id = ?').run(id)
  getDb().prepare('DELETE FROM book_notes WHERE book_id = ?').run(id)
  if (!row) return
  for (const p of [row.file_path, row.cover_path]) {
    if (p) {
      try {
        unlinkSync(join(userDataDir(), p))
      } catch {
        /* 文件缺失静默 */
      }
    }
  }
}

// ---------- 划词笔记（优化第1轮 §8.5，仅 epub） ----------

/** 某书全部笔记（created_at 倒序，最新在前） */
export function listNotes(bookId: number): BooksNote[] {
  return getDb()
    .prepare('SELECT * FROM book_notes WHERE book_id = ? ORDER BY created_at DESC, id DESC')
    .all(bookId) as unknown as BooksNote[]
}

/** 新增笔记（note 缺省 '' = 纯高光；quote 截断 500 字防超长） */
export function addNote(
  bookId: number,
  n: { cfiRange: string; quote: string; note?: string }
): BooksNote {
  const r = getDb()
    .prepare('INSERT INTO book_notes (book_id, cfi_range, quote, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, n.cfiRange, n.quote.slice(0, 500), n.note ?? '', nowIso())
  return getDb()
    .prepare('SELECT * FROM book_notes WHERE id = ?')
    .get(Number(r.lastInsertRowid)) as unknown as BooksNote
}

/** 编辑批注内容（渲染层笔记气泡/列表调用） */
export function updateNote(id: number, note: string): void {
  getDb().prepare('UPDATE book_notes SET note = ? WHERE id = ?').run(note, id)
}

/** 彻底删除单条笔记（渲染层二次确认后调用） */
export function removeNote(id: number): void {
  getDb().prepare('DELETE FROM book_notes WHERE id = ?').run(id)
}
