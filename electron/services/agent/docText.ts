// 通用全文抓取（260929 自 papers/science 抽取共用）：URL → 正文文本统一管线——
// PDF 直链（.pdf 扩展名先验 + 响应 %PDF- 魔数兜底）走二进制下载 + pdfjs 逐页抽文本，
// 其余按 HTML + Readability 抽正文。此前非 arXiv 的 PDF 直链被当 HTML 解析，抽出 0 字符
// 误报「正文过短」降级 meta_only（如哥大课程站 Go scheduler 论文直链）。
// 260929 排版保留：HTML 分支额外产出正文 Markdown（DOM 序列化，标题/列表/引用/代码块/
// 表格/链接/图片/强调），供原文页保排版渲染；text（纯文本）继续作长度守卫与 LLM 输入兜底。
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

// linkedom 导出类型对实例不友好，这里用本地结构类型（与其 DOM 实现结构兼容）
interface LodNode {
  readonly nodeType: number
  readonly nodeName: string
  readonly textContent: string | null
  readonly childNodes: Iterable<LodNode>
}
interface LodElement extends LodNode {
  getAttribute(name: string): string | null
  querySelectorAll(selector: string): Iterable<LodElement>
}
interface LodDocument {
  readonly body: LodElement | null
  readonly documentElement: LodElement | null
}
import { politeFetch, politeFetchBinary } from './guardrails'

export type DocText = { kind: 'pdf' | 'html'; text: string; md?: string }

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

function looksLikePdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf')
  } catch {
    return /\.pdf($|[?#])/i.test(url)
  }
}

/** PDF 二进制 → 抽文本；sink 传落盘路径（论文库复用已存 PDF），不传则临时文件用完即删（科普线） */
async function pdfBufToText(buf: Buffer, sink?: string): Promise<string> {
  const file = sink ?? join(tmpdir(), `bugzi-doctext-${Date.now()}.pdf`)
  writeFileSync(file, buf)
  try {
    return await extractPdfText(file)
  } finally {
    if (!sink) {
      try {
        unlinkSync(file)
      } catch {
        /* 已清理 */
      }
    }
  }
}

// ---------- 正文 DOM → Markdown（保排版，linkedom 节点遍历，零额外依赖） ----------

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV',
  'FIGURE', 'FIGCAPTION', 'ADDRESS', 'DL', 'DT', 'DD', 'FIELDSET', 'FORM', 'HGROUP', 'CENTER'
])

function absUrl(raw: string | null, base: string): string {
  if (!raw) return ''
  try {
    return new URL(raw, base).toString()
  } catch {
    return raw
  }
}

function childrenInline(el: LodElement, base: string): string {
  let out = ''
  for (const c of el.childNodes) out += inlineMd(c, base)
  return out
}

/** 行内序列化（块级标签交 walkBlocks；未知标签递归子节点） */
function inlineMd(node: LodNode, base: string): string {
  if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ')
  if (node.nodeType !== 1) return ''
  const el = node as LodElement
  switch (el.nodeName) {
    case 'SCRIPT':
    case 'STYLE':
    case 'NOSCRIPT':
    case 'TEMPLATE':
    case 'SVG':
    case 'IFRAME':
    case 'BUTTON':
    case 'INPUT':
    case 'SELECT':
      return ''
    case 'BR':
      return '\n'
    case 'STRONG':
    case 'B': {
      const t = childrenInline(el, base).trim()
      return t ? `**${t}**` : ''
    }
    case 'EM':
    case 'I': {
      const t = childrenInline(el, base).trim()
      return t ? `*${t}*` : ''
    }
    case 'DEL':
    case 'S': {
      const t = childrenInline(el, base).trim()
      return t ? `~~${t}~~` : ''
    }
    case 'CODE': {
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      return t ? `\`${t}\`` : ''
    }
    case 'A': {
      const t = childrenInline(el, base).trim()
      const href = absUrl(el.getAttribute('href'), base)
      if (!t) return ''
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return t
      return `[${t}](${href})`
    }
    case 'IMG': {
      const src = absUrl(el.getAttribute('src'), base)
      const alt = (el.getAttribute('alt') ?? '').replace(/[[\]]/g, '')
      return src ? `![${alt}](${src})` : ''
    }
    default:
      return childrenInline(el, base)
  }
}

function liMd(li: LodElement, base: string, ordered: boolean, index: number, depth: number): string {
  const prefix = '  '.repeat(depth) + (ordered ? `${index}.` : '-') + ' '
  const subLists: string[] = []
  let inline = ''
  for (const c of li.childNodes) {
    if (c.nodeType === 1 && ((c as LodElement).nodeName === 'UL' || (c as LodElement).nodeName === 'OL')) {
      const sub = listItemsMd(c as LodElement, base, (c as LodElement).nodeName === 'OL', depth + 1)
      if (sub) subLists.push(sub)
    } else {
      inline += inlineMd(c, base)
    }
  }
  const text = inline.replace(/\s+/g, ' ').trim()
  if (!text && subLists.length === 0) return ''
  return [prefix + text, ...subLists].join('\n')
}

function listItemsMd(list: LodElement, base: string, ordered: boolean, depth: number): string {
  const out: string[] = []
  let i = 1
  for (const c of list.childNodes) {
    if (c.nodeType === 1 && (c as LodElement).nodeName === 'LI') {
      const t = liMd(c as LodElement, base, ordered, i, depth)
      if (t) {
        out.push(t)
        i++
      }
    }
  }
  return out.join('\n')
}

function tableMd(table: LodElement, base: string): string | null {
  const rows: string[][] = []
  for (const tr of table.querySelectorAll('tr')) {
    const cells: string[] = []
    for (const cell of tr.childNodes) {
      if (cell.nodeType === 1 && ((cell as LodElement).nodeName === 'TD' || (cell as LodElement).nodeName === 'TH')) {
        cells.push(inlineMd(cell, base).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim())
      }
    }
    if (cells.length) rows.push(cells)
  }
  if (rows.length === 0) return null
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]): string[] => {
    while (r.length < width) r.push('')
    return r
  }
  const head = pad(rows[0])
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)
  ]
  return lines.join('\n')
}

function hasBlockChild(el: LodElement): boolean {
  for (const c of el.childNodes) {
    if (
      c.nodeType === 1 &&
      (BLOCK_TAGS.has((c as LodElement).nodeName) || /^H[1-6]$/.test((c as LodElement).nodeName) ||
        (c as LodElement).nodeName === 'UL' ||
        (c as LodElement).nodeName === 'OL' ||
        (c as LodElement).nodeName === 'TABLE' ||
        (c as LodElement).nodeName === 'PRE' ||
        (c as LodElement).nodeName === 'BLOCKQUOTE')
    ) {
      return true
    }
  }
  return false
}

/** 块级递归：产出以空行分隔的 Markdown 块 */
function walkBlocks(el: LodElement, base: string): string {
  const parts: string[] = []
  let listBuf: string[] = []
  const flushList = (): void => {
    if (listBuf.length) {
      parts.push(listBuf.join('\n'))
      listBuf = []
    }
  }
  for (const child of el.childNodes) {
    if (child.nodeType === 3) {
      const t = (child.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (t) parts.push(t)
      continue
    }
    if (child.nodeType !== 1) continue
    const e = child as LodElement
    const tag = e.nodeName
    if (/^H[1-6]$/.test(tag)) {
      flushList()
      const t = childrenInline(e, base).trim()
      if (t) parts.push(`${'#'.repeat(Number(tag[1]))} ${t}`)
    } else if (tag === 'UL' || tag === 'OL') {
      flushList()
      const t = listItemsMd(e, base, tag === 'OL', 0)
      if (t) parts.push(t)
    } else if (tag === 'BLOCKQUOTE') {
      flushList()
      const inner = walkBlocks(e, base).trim()
      if (inner) parts.push(inner.split('\n').map((l) => `> ${l}`).join('\n'))
    } else if (tag === 'PRE') {
      flushList()
      const code = (e.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
      if (code) parts.push('```\n' + code + '\n```')
    } else if (tag === 'HR') {
      flushList()
      parts.push('---')
    } else if (tag === 'TABLE') {
      flushList()
      const t = tableMd(e, base)
      if (t) parts.push(t)
    } else if (tag === 'IMG') {
      flushList()
      const t = inlineMd(e, base).trim()
      if (t) parts.push(t)
    } else if (BLOCK_TAGS.has(tag)) {
      flushList()
      // 容器内含块级子级（Readability 会包 readability-page-1 DIV）则递归保结构，否则行内化
      const t = hasBlockChild(e) ? walkBlocks(e, base).trim() : inlineMd(e, base).trim()
      if (t) parts.push(t.replace(/\n{3,}/g, '\n\n'))
    } else {
      // 未知标签：子级含块级元素则递归分块，否则行内化
      const hasBlock = hasBlockChild(e)
      if (hasBlock) {
        flushList()
        const t = walkBlocks(e, base).trim()
        if (t) parts.push(t)
      } else {
        const t = inlineMd(e, base).trim()
        if (t) parts.push(t)
      }
    }
  }
  flushList()
  return parts.filter(Boolean).join('\n\n')
}

/** Readability 正文 → Markdown（保排版） */
function contentToMd(doc: LodDocument, base: string): string {
  const anyDoc = doc as unknown as { body?: LodElement; documentElement?: LodElement }
  // 片段重解析时节点可能全挂 documentElement（body 存在但为空）——跳过空 body
  let root = anyDoc.body ?? anyDoc.documentElement
  if (root && [...root.childNodes].length === 0) {
    root = anyDoc.documentElement ?? root
  }
  if (!root) return ''
  return walkBlocks(root, base).replace(/\n{3,}/g, '\n\n').trim()
}

/** 任意文献/文章 URL 取正文：asPdf 强制 PDF 路径（arXiv 已归一为 /pdf/ 链接），否则先验扩展名、
 *  响应 %PDF- 魔数兜底（覆盖 openreview.net/pdf?id=… 等无扩展名直链），其余按 HTML 抽正文。
 *  HTML 分返回 md（保排版 Markdown），PDF 分只有纯文本。 */
export async function fetchDocText(
  url: string,
  opts?: { pdfSink?: string; asPdf?: boolean }
): Promise<DocText> {
  if (opts?.asPdf || looksLikePdfUrl(url)) {
    return { kind: 'pdf', text: await pdfBufToText(await politeFetchBinary(url), opts?.pdfSink) }
  }
  const { text: raw } = await politeFetch(url)
  if (raw.startsWith('%PDF-')) {
    return { kind: 'pdf', text: await pdfBufToText(await politeFetchBinary(url), opts?.pdfSink) }
  }
  const { document } = parseHTML(raw)
  const parsed = new Readability(document).parse()
  const plain = (parsed?.textContent ?? '').replace(/\s+\n/g, '\n').trim()
  // linkedom 下 Readability 的 content 是序列化 HTML 字符串，浏览器环境是 Document——双形状兼容
  let md = ''
  if (parsed) {
    const rawContent = parsed.content as unknown
    const doc2 = typeof rawContent === 'string' ? parseHTML(rawContent).document : (rawContent as LodDocument)
    md = contentToMd(doc2 as LodDocument, url)
  }
  return { kind: 'html', text: plain, md: md || undefined }
}
