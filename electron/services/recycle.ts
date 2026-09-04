// 回收站服务：入站/恢复/彻底删除/3天自动清理（回收站 specs §1/§3/§4）
import { getDb, nowIso } from '../db/db'
import { mdDelete } from './files'

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000

export type RecycleSource = 'mottos' | 'wiki' | 'inspirations' | 'verify' | 'zhijiji'

const TABLES: Record<RecycleSource, string> = {
  mottos: 'mottos',
  wiki: 'wiki_entries',
  inspirations: 'inspirations',
  verify: 'verify_records',
  zhijiji: 'zhijiji_questions'
}

// 各来源的附属 md 路径字段（mottos 仅正式区有笔记；zhijiji 为多 md，hardDelete 特判处理）
const MD_FIELDS: Record<RecycleSource, string | null> = {
  mottos: 'note_path',
  wiki: 'md_path',
  inspirations: 'md_path',
  verify: 'md_path',
  zhijiji: null
}

export interface RecycleRow {
  id: number
  source: RecycleSource
  item_id: number
  payload: string
  created_at: string
}

/** 条目丢弃入回收站：软删除标记 + 快照兜底（specs §5 接入约定） */
export function discardToRecycle(source: RecycleSource, itemId: number): void {
  const d = getDb()
  const table = TABLES[source]
  const row = d.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(itemId) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  const now = nowIso()
  d.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(now, itemId)
  d.prepare(
    'INSERT INTO recycle_bin (source, item_id, payload, created_at) VALUES (?, ?, ?, ?)'
  ).run(source, itemId, JSON.stringify(row), now)
}

/** 恢复：清 deleted_at、删回收记录（specs §3：回来源模块最初级区） */
export function restoreFromRecycle(recycleId: number): { source: RecycleSource; item_id: number } {
  const d = getDb()
  const rb = d.prepare('SELECT * FROM recycle_bin WHERE id = ?').get(recycleId) as RecycleRow | undefined
  if (!rb) throw new Error('NOT_FOUND')
  switch (rb.source) {
    case 'mottos':
      // 回草稿区（回收站 specs §3），插到区首（sort 取草稿区最小值-1）
      {
        const head = d
          .prepare('SELECT MIN(sort) AS m FROM mottos WHERE status = ? AND deleted_at IS NULL')
          .get('draft') as { m: number | null }
        d.prepare('UPDATE mottos SET deleted_at = NULL, status = ?, sort = ? WHERE id = ?').run(
          'draft',
          head.m == null ? 0 : head.m - 1,
          rb.item_id
        )
      }
      break
    case 'wiki':
      // 回原板块：仅清标记
      d.prepare('UPDATE wiki_entries SET deleted_at = NULL WHERE id = ?').run(rb.item_id)
      break
    case 'inspirations':
      // 回草稿区
      d.prepare('UPDATE inspirations SET deleted_at = NULL, status = ? WHERE id = ?').run('draft', rb.item_id)
      break
    case 'verify':
      // 回历史记录列表：仅清标记
      d.prepare('UPDATE verify_records SET deleted_at = NULL WHERE id = ?').run(rb.item_id)
      break
    case 'zhijiji':
      // 回主列表：清标记 + 触碰 updated_at（浮回列表顶部，版本 md 原样保留）
      d.prepare('UPDATE zhijiji_questions SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(
        nowIso(),
        rb.item_id
      )
      break
  }
  d.prepare('DELETE FROM recycle_bin WHERE id = ?').run(recycleId)
  return { source: rb.source, item_id: rb.item_id }
}

/** 彻底删除：DELETE 原记录 + 附属 md + wiki 高光 + recycle_bin 记录 */
export function hardDelete(recycleId: number): void {
  const d = getDb()
  const rb = d.prepare('SELECT * FROM recycle_bin WHERE id = ?').get(recycleId) as
    | RecycleRow
    | undefined
  if (!rb) throw new Error('NOT_FOUND')
  const table = TABLES[rb.source]
  const mdField = MD_FIELDS[rb.source]
  let mdPath: string | null = null
  if (mdField) {
    const row = d.prepare(`SELECT ${mdField} AS p FROM ${table} WHERE id = ?`).get(rb.item_id) as
      | { p: string | null }
      | undefined
    mdPath = row?.p ?? null
  }
  if (rb.source === 'wiki') {
    d.prepare('DELETE FROM wiki_highlights WHERE entry_id = ?').run(rb.item_id)
  }
  if (rb.source === 'zhijiji') {
    // 一问题多版本 md：先收齐路径再删行（问题行 + 全部版本行），最后逐个删文件
    const vs = d
      .prepare('SELECT md_path FROM zhijiji_versions WHERE question_id = ?')
      .all(rb.item_id) as { md_path: string }[]
    d.prepare('DELETE FROM zhijiji_versions WHERE question_id = ?').run(rb.item_id)
    d.prepare('DELETE FROM zhijiji_questions WHERE id = ?').run(rb.item_id)
    d.prepare('DELETE FROM recycle_bin WHERE id = ?').run(recycleId)
    for (const v of vs) mdDelete(v.md_path)
    return
  }
  d.prepare(`DELETE FROM ${table} WHERE id = ?`).run(rb.item_id)
  d.prepare('DELETE FROM recycle_bin WHERE id = ?').run(recycleId)
  if (mdPath) mdDelete(mdPath)
}

/** 超期清理：created_at <= now-3天 → 彻底删除（启动 + 每日零点调用，静默） */
export function cleanupExpired(): number {
  const d = getDb()
  const expired = d
    .prepare('SELECT id FROM recycle_bin WHERE created_at <= ?')
    .all(new Date(Date.now() - RETENTION_MS).toISOString()) as { id: number }[]
  for (const r of expired) {
    hardDelete(r.id)
  }
  return expired.length
}

/** 全量列表（按入站时间倒序） */
export function listRecycle(): RecycleRow[] {
  return getDb()
    .prepare('SELECT * FROM recycle_bin ORDER BY created_at DESC')
    .all() as unknown as RecycleRow[]
}
