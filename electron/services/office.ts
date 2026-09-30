// 办公台服务（办公台 specs §3/§6）：文档行 CRUD + 真相源文件读写 + 导入/导出 + AI 快照。
// 真相源口径（design §四）：docx/pptx→content.md（原件 original.* 永不改写）、xlsx→book.xlsx、
// csv→content.csv、txt→content.txt、md→content.md。异常抛 Error 由 ipc 层透传 toast。
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getDb, userDataDir, nowIso } from '../db/db'
import { discardToRecycle } from './recycle'
import {
  docxToMd,
  mdToDocx,
  pptxToOutline,
  outlineToPptx,
  readWorkbook,
  writeWorkbook
} from './officeConvert'
import type { OfficeDocRow, OfficeKind, OfficeSheet, OfficeVersionRow } from '../../src/shared/types'

const MAX_SIZE = 50 * 1024 * 1024
const EXT_KIND: Record<string, OfficeKind> = {
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  txt: 'txt',
  csv: 'csv',
  md: 'md',
  markdown: 'md'
}

export function officeDir(id: number): string {
  return join(userDataDir(), 'office', String(id))
}

/** 真相源文件名（按 kind） */
export function truthFile(kind: OfficeKind): string {
  switch (kind) {
    case 'docx':
    case 'pptx':
    case 'md':
      return 'content.md'
    case 'xlsx':
      return 'book.xlsx'
    case 'csv':
      return 'content.csv'
    case 'txt':
      return 'content.txt'
  }
}

export function listDocs(): OfficeDocRow[] {
  return getDb()
    .prepare(
      'SELECT id, name, kind, source_name, size, created_at, updated_at FROM office_documents WHERE deleted_at IS NULL ORDER BY updated_at DESC'
    )
    .all() as unknown as OfficeDocRow[]
}

export function getDoc(id: number): OfficeDocRow {
  const r = getDb()
    .prepare(
      'SELECT id, name, kind, source_name, size, created_at, updated_at FROM office_documents WHERE id = ? AND deleted_at IS NULL'
    )
    .get(id) as OfficeDocRow | undefined
  if (!r) throw new Error('NOT_FOUND')
  return r
}

function touch(id: number, size: number): void {
  getDb().prepare('UPDATE office_documents SET size = ?, updated_at = ? WHERE id = ?').run(size, nowIso(), id)
}

/** 单文件导入（specs §6）：50MB 上限；先插行拿 id 再建目录转换，失败回滚删行删目录 */
export async function importOne(srcPath: string): Promise<OfficeDocRow> {
  const ext = srcPath.split('.').pop()?.toLowerCase() ?? ''
  const kind = EXT_KIND[ext]
  if (!kind) throw new Error(`不支持的格式 .${ext}`)
  const size = statSync(srcPath).size
  if (size > MAX_SIZE) throw new Error('文件超过 50MB 上限')
  const d = getDb()
  const name = basename(srcPath).replace(/\.[^.]+$/, '')
  const now = nowIso()
  const { lastInsertRowid } = d
    .prepare(
      'INSERT INTO office_documents (name, kind, source_name, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(name, kind, basename(srcPath), size, now, now)
  const id = Number(lastInsertRowid)
  try {
    mkdirSync(join(officeDir(id), 'images'), { recursive: true })
    const tp = join(officeDir(id), truthFile(kind))
    if (kind === 'docx') {
      copyFileSync(srcPath, join(officeDir(id), 'original.docx'))
      const md = await docxToMd(readFileSync(srcPath), join(officeDir(id), 'images'), `bzres://office/${id}`)
      writeFileSync(tp, md, 'utf8')
    } else if (kind === 'pptx') {
      copyFileSync(srcPath, join(officeDir(id), 'original.pptx'))
      writeFileSync(tp, await pptxToOutline(readFileSync(srcPath)), 'utf8')
    } else {
      // xlsx/csv/txt/md：真相源即原文件副本
      copyFileSync(srcPath, tp)
    }
    touch(id, statSync(tp).size)
    return getDoc(id)
  } catch (e) {
    d.prepare('DELETE FROM office_documents WHERE id = ?').run(id)
    try {
      rmSync(officeDir(id), { recursive: true, force: true })
    } catch {
      /* 清理失败忽略 */
    }
    throw e
  }
}

/** 新建空文档（specs §3.4）：docx/pptx 无原件，仅空真相源；表格类空单 sheet */
export function createDoc(name: string, kind: OfficeKind): OfficeDocRow {
  const d = getDb()
  const now = nowIso()
  const { lastInsertRowid } = d
    .prepare(
      'INSERT INTO office_documents (name, kind, source_name, size, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)'
    )
    .run(name.trim() || '未命名文档', kind, now, now)
  const id = Number(lastInsertRowid)
  mkdirSync(join(officeDir(id), 'images'), { recursive: true })
  const tp = join(officeDir(id), truthFile(kind))
  if (kind === 'xlsx') writeWorkbook([{ name: 'Sheet1', rows: [['']] }], tp, 'xlsx')
  else if (kind === 'csv') writeWorkbook([{ name: 'Sheet1', rows: [['']] }], tp, 'csv')
  else writeFileSync(tp, '', 'utf8')
  touch(id, statSync(tp).size)
  return getDoc(id)
}

export function renameDoc(id: number, name: string): void {
  getDb()
    .prepare('UPDATE office_documents SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(name.trim() || '未命名文档', nowIso(), id)
}

/** 打开：文本类回真相源全文（content）；表格类回 sheets（content 为 null） */
export function openDoc(id: number): { row: OfficeDocRow; content: string | null; sheets: OfficeSheet[] | null } {
  const row = getDoc(id)
  const tp = join(officeDir(id), truthFile(row.kind))
  if (row.kind === 'xlsx' || row.kind === 'csv') {
    return { row, content: null, sheets: readWorkbook(readFileSync(tp)) }
  }
  let content = ''
  try {
    content = readFileSync(tp, 'utf8')
  } catch {
    content = ''
  }
  return { row, content, sheets: null }
}

/** 保存（specs §6）：文本类整篇写真相源；表格类全簿写回；刷新 updated_at/size */
export function saveDoc(id: number, payload: { content?: string; sheets?: OfficeSheet[] }): void {
  const row = getDoc(id)
  const tp = join(officeDir(id), truthFile(row.kind))
  if (payload.sheets) {
    writeWorkbook(payload.sheets, tp, row.kind === 'csv' ? 'csv' : 'xlsx')
  } else if (typeof payload.content === 'string') {
    writeFileSync(tp, payload.content, 'utf8')
  } else {
    return
  }
  touch(id, statSync(tp).size)
}

/** 导出到电脑（specs §6）：从真相源生成；targetPath 由 ipc 层 showSaveDialog 取得 */
export async function exportDoc(id: number, targetPath: string): Promise<void> {
  const row = getDoc(id)
  const tp = join(officeDir(id), truthFile(row.kind))
  switch (row.kind) {
    case 'docx':
      await mdToDocx(readFileSync(tp, 'utf8'), join(userDataDir(), 'office'), targetPath)
      break
    case 'pptx':
      await outlineToPptx(readFileSync(tp, 'utf8'), targetPath)
      break
    case 'xlsx':
      writeWorkbook(readWorkbook(readFileSync(tp)), targetPath, 'xlsx')
      break
    case 'csv':
      writeWorkbook(readWorkbook(readFileSync(tp)), targetPath, 'csv')
      break
    default:
      copyFileSync(tp, targetPath)
  }
}

export function discardDoc(id: number): void {
  getDoc(id)
  discardToRecycle('office', id)
}

// ---------- AI 快照（office_versions；specs §6 第 4 步） ----------

export function versionsOf(id: number): OfficeVersionRow[] {
  return getDb()
    .prepare('SELECT id, note, created_at FROM office_versions WHERE doc_id = ? ORDER BY created_at DESC, id DESC')
    .all(id) as unknown as OfficeVersionRow[]
}

/** 写入前快照：kind='doc' 存 md 全文 / 'sheet' 存全簿网格 JSON；每文档保留最近 10 份 */
export function snapshotDoc(id: number, kind: 'doc' | 'sheet', snapshot: string, note: string): void {
  const d = getDb()
  d.prepare('INSERT INTO office_versions (doc_id, kind, snapshot, note, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    kind,
    snapshot,
    note.slice(0, 50),
    nowIso()
  )
  const old = d
    .prepare(
      'SELECT id FROM office_versions WHERE doc_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 10'
    )
    .all(id) as { id: number }[]
  for (const o of old) d.prepare('DELETE FROM office_versions WHERE id = ?').run(o.id)
}

/** 恢复版本：写回真相源 + 刷 updated_at */
export function restoreVersion(versionId: number): void {
  const v = getDb().prepare('SELECT * FROM office_versions WHERE id = ?').get(versionId) as
    | { doc_id: number; kind: string; snapshot: string }
    | undefined
  if (!v) throw new Error('NOT_FOUND')
  const row = getDoc(v.doc_id)
  const tp = join(officeDir(row.id), truthFile(row.kind))
  if (v.kind === 'sheet') {
    writeWorkbook(JSON.parse(v.snapshot) as OfficeSheet[], tp, row.kind === 'csv' ? 'csv' : 'xlsx')
  } else {
    writeFileSync(tp, v.snapshot, 'utf8')
  }
  touch(row.id, statSync(tp).size)
}
