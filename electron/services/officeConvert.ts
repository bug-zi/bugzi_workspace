// 办公台格式转换纯函数库（办公台 specs §5）：docx⇄md、pptx⇄大纲md、xlsx/csv⇆网格。
// 仅主进程使用；不做公式计算（xlsx 读缓存显示值）；异常一律抛 Error（调用方负责回滚）。
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { marked, type Token, type Tokens } from 'marked'
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ImageRun,
  AlignmentType
} from 'docx'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import type { OfficeSheet } from '../../src/shared/types'

// ---------- docx → md ----------

/** docx 转 md；图片落 imagesDir 并以 `${webPrefix}/images/<名>` 引用（调用方传 bzres 前缀） */
export async function docxToMd(buf: Buffer, imagesDir: string, webPrefix: string): Promise<string> {
  let imgSeq = 0
  const { value: html } = await mammoth.convertToHtml(
    { buffer: buf },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        imgSeq += 1
        const ext = (image.contentType.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
        const name = `img-${imgSeq}.${ext}`
        writeFileSync(join(imagesDir, name), await image.readAsBuffer())
        return { src: `${webPrefix}/images/${name}` }
      })
    }
  )
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  td.use(gfm)
  return td.turndown(html)
}

// ---------- md → docx ----------

const HEI = '黑体'
const SONG = '宋体'

/** 行内 token → TextRun（粗/斜/删/代码/链接转文字；未识别类型降级纯文本） */
function inlineRuns(
  tokens: Token[] | undefined,
  fallback: string,
  base?: { bold?: boolean; italics?: boolean; strike?: boolean }
): TextRun[] {
  if (!tokens || tokens.length === 0) return [new TextRun({ text: fallback, font: SONG, size: 24, ...base })]
  return tokens.flatMap((t): TextRun[] => {
    if (t.type === 'strong') return inlineRuns(t.tokens, '', { ...base, bold: true })
    if (t.type === 'em') return inlineRuns(t.tokens, '', { ...base, italics: true })
    if (t.type === 'del') return inlineRuns(t.tokens, '', { ...base, strike: true })
    if (t.type === 'codespan') return [new TextRun({ text: t.text, font: 'Consolas', size: 22, ...base })]
    if (t.type === 'link' || t.type === 'text' || t.type === 'escape') return inlineRuns((t as Tokens.Text).tokens, t.text, base)
    return [new TextRun({ text: (t as { raw?: string }).raw ?? '', font: SONG, size: 24, ...base })]
  })
}

/** png/jpg 尺寸嗅探（ImageRun 需要宽高；其余/异常按 480×320 兜底） */
function imageSize(buf: Buffer): { width: number; height: number } {
  try {
    if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2
      while (off < buf.length - 9) {
        if (buf[off] !== 0xff) {
          off += 1
          continue
        }
        const marker = buf[off + 1]
        const len = buf.readUInt16BE(off + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) }
        }
        off += 2 + len
      }
    }
  } catch {
    /* 兜底 */
  }
  return { width: 480, height: 320 }
}

/** md 图片引用（<officeRoot> 相对：bzres://office/<id>/images/x）→ docx 居中图片段；读不到文件返回 null 跳过 */
function imageParagraph(src: string, officeRoot: string): Paragraph | null {
  const m = src.match(/bzres:\/\/office\/(\d+)\/images\/(.+)/)
  if (!m) return null
  let buf: Buffer
  try {
    buf = readFileSync(join(officeRoot, m[1], 'images', decodeURIComponent(m[2])))
  } catch {
    return null
  }
  const { width, height } = imageSize(buf)
  const scale = Math.min(1, 480 / width)
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new ImageRun({
        data: buf,
        type: decodeURIComponent(m[2]).endsWith('.jpg') ? 'jpg' : 'png',
        transformation: { width: Math.round(width * scale), height: Math.round(height * scale) }
      })
    ]
  })
}

function tableOf(t: Tokens.Table): Table {
  const cell = (s: string, head: boolean): TableCell =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: s, bold: head, font: SONG, size: 22 })] })]
    })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: t.header.map((c) => cell(c.text, true)) }),
      ...t.rows.map((r) => new TableRow({ children: r.map((c) => cell(c.text, false)) }))
    ]
  })
}

/** md 转 docx 落盘（黑体标题/宋体正文、A4 1 英寸边距；引用=左缘线缩进、代码=等宽浅底）
 *  officeRoot = userData/office（图片 bzres 引用按 <officeRoot>/<id>/images/ 解析） */
export async function mdToDocx(md: string, officeRoot: string, outPath: string): Promise<void> {
  const children: (Paragraph | Table)[] = []
  for (const tk of marked.lexer(md)) {
    if (tk.type === 'heading') {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: tk.text, bold: true, font: HEI, size: [44, 36, 32, 28][Math.min(tk.depth, 4) - 1] })
          ],
          spacing: { before: 240, after: 120 }
        })
      )
    } else if (tk.type === 'table') {
      children.push(tableOf(tk as Tokens.Table))
    } else if (tk.type === 'list') {
      for (const item of (tk as Tokens.List).items) {
        children.push(
          new Paragraph({
            children: inlineRuns(item.tokens, item.text),
            bullet: { level: 0 },
            spacing: { after: 60 }
          })
        )
      }
    } else if (tk.type === 'blockquote') {
      for (const p of (tk.tokens ?? []).filter((x): x is Tokens.Paragraph => x.type === 'paragraph')) {
        children.push(
          new Paragraph({
            children: inlineRuns(p.tokens ?? [], ''),
            indent: { left: 480 },
            spacing: { after: 80 },
            border: { left: { style: 'single', size: 12, color: 'BBBBBB', space: 8 } }
          })
        )
      }
    } else if (tk.type === 'code') {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: tk.text, font: 'Consolas', size: 20, shading: { fill: 'F2F2F2' } })],
          spacing: { after: 80 }
        })
      )
    } else if (tk.type === 'space') {
      continue
    } else if (tk.type === 'paragraph') {
      for (const child of tk.tokens ?? []) {
        if (child.type === 'image') {
          const img = imageParagraph((child as { href: string }).href, officeRoot)
          if (img) children.push(img)
        }
      }
      children.push(new Paragraph({ children: inlineRuns(tk.tokens, ''), spacing: { after: 120 } }))
    } else {
      children.push(new Paragraph({ children: inlineRuns(undefined, tk.raw), spacing: { after: 120 } }))
    }
  }
  const doc = new Document({
    sections: [
      {
        properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
        children
      }
    ]
  })
  writeFileSync(outPath, await Packer.toBuffer(doc))
}

// ---------- pptx ⇆ 大纲 md ----------

function slideNo(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
}

/** pptx → 大纲 md（pptx 本质 zip+xml：提取各 slide 的 <a:t> 文本；首个非空行作页标题，其余作要点） */
export async function pptxToOutline(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  names.sort((a, b) => slideNo(a) - slideNo(b))
  const pages: string[] = []
  for (const n of names) {
    const xml = await zip.file(n)!.async('string')
    const lines = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1].trim()).filter(Boolean)
    if (lines.length === 0) continue
    const [head, ...rest] = lines
    pages.push(`## ${head}\n${rest.map((l) => `- ${l}`).join('\n')}`)
  }
  if (pages.length === 0) throw new Error('未解析到任何幻灯片文本')
  return pages.join('\n\n')
}

/** 大纲 md → pptx（按 ^## 切页的简单版式：标题 + 项目符号要点，16:9） */
export async function outlineToPptx(md: string, outPath: string): Promise<void> {
  const pages = md
    .split(/\n(?=## )/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (pages.length === 0) throw new Error('大纲为空，无法生成 PPT')
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'W16x9', width: 13.33, height: 7.5 })
  pptx.layout = 'W16x9'
  for (const p of pages) {
    const lines = p.split('\n').map((l) => l.trim()).filter(Boolean)
    const title = lines[0].replace(/^##\s*/, '')
    const points = lines.slice(1).map((l) => l.replace(/^-\s*/, ''))
    const slide = pptx.addSlide()
    slide.addText(title, { x: 0.6, y: 0.5, w: 12.1, fontSize: 28, bold: true, color: '1F2933' })
    if (points.length > 0) {
      slide.addText(
        points.map((t) => ({ text: t, options: { bullet: true, fontSize: 16, color: '3E4C59' } })),
        { x: 0.9, y: 1.6, w: 11.5, h: 5.2 }
      )
    }
  }
  await pptx.writeFile({ fileName: outPath })
}

// ---------- xlsx / csv ⇆ 网格 ----------

/** 读工作簿为网格（raw:false → 公式单元格取缓存显示值；defval:'' 补空位） */
export function readWorkbook(buf: Buffer): OfficeSheet[] {
  const wb = XLSX.read(buf, { type: 'buffer' })
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], { header: 1, raw: false, defval: '' })
  }))
}

/** 网格写回工作簿（csv 单 sheet 固定名 Sheet1） */
export function writeWorkbook(sheets: OfficeSheet[], outPath: string, kind: 'xlsx' | 'csv'): void {
  const wb = XLSX.utils.book_new()
  const list = kind === 'csv' ? [{ name: 'Sheet1', rows: sheets[0]?.rows ?? [['']] }] : sheets
  for (const s of list) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows.length ? s.rows : [['']]), s.name)
  }
  writeFileSync(outPath, XLSX.write(wb, { type: 'buffer', bookType: kind }) as Buffer)
}
