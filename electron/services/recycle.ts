// 回收站服务：入站/恢复/彻底删除/3天自动清理（回收站 specs §1/§3/§4）
import { getDb, nowIso, recordMottoTombstone } from '../db/db'
import { mdDelete } from './files'

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000

export type RecycleSource =
  | 'mottos'
  | 'wiki'
  | 'inspirations'
  | 'verify'
  | 'zhijiji'
  | 'reasoning_soup'
  | 'reasoning_game'
  | 'drafts'
  | 'wenbi_journal'
  | 'wenbi_article'
  | 'ledger_tx'
  | 'ledger_account'
  | 'ledger_category'
  | 'canvases'
  | 'learn'
  | 'prophet'
  | 'twelve_question'
  | 'qa'

const TABLES: Record<RecycleSource, string> = {
  mottos: 'mottos',
  wiki: 'wiki_entries',
  inspirations: 'inspirations',
  verify: 'verify_records',
  zhijiji: 'zhijiji_questions',
  reasoning_soup: 'turtle_soups',
  reasoning_game: 'turtle_games',
  drafts: 'drafts',
  wenbi_journal: 'wenbi_journals',
  wenbi_article: 'wenbi_articles',
  ledger_tx: 'ledger_tx',
  ledger_account: 'ledger_accounts',
  ledger_category: 'ledger_categories',
  canvases: 'canvases',
  learn: 'learn_nodes',
  prophet: 'prophet_records',
  twelve_question: 'twelve_questions',
  qa: 'qa_records'
}

// 各来源的附属 md 路径字段（mottos 仅正式区有笔记；zhijiji 为多 md、reasoning_game 为
// 一局一 md + 多消息行，hardDelete 特判处理）
const MD_FIELDS: Record<RecycleSource, string | null> = {
  mottos: 'note_path',
  wiki: 'md_path',
  inspirations: 'md_path',
  verify: 'md_path',
  qa: 'md_path',
  zhijiji: null,
  reasoning_soup: null,
  reasoning_game: 'md_path',
  drafts: 'md_path',
  wenbi_journal: 'md_path',
  wenbi_article: 'md_path',
  ledger_tx: null,
  ledger_account: null,
  ledger_category: null,
  // 画布：path 指向 canvas/{id}.excalidraw（mdDelete 对 userData 内任意文件通用）
  canvases: 'path',
  learn: null, // learn 卡片 md 派生为 md/learn/<id>.md（无表列），hardDelete 特判清理
  prophet: 'analysis_md_path',
  twelve_question: null // 想法为 DB 行，hardDelete 特判清理
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
    case 'qa':
      // 回问答历史列表：仅清标记
      d.prepare('UPDATE qa_records SET deleted_at = NULL WHERE id = ?').run(rb.item_id)
      break
    case 'zhijiji':
      // 回主列表：清标记 + 触碰 updated_at（浮回列表顶部，版本 md 原样保留）
      d.prepare('UPDATE zhijiji_questions SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(
        nowIso(),
        rb.item_id
      )
      break
    case 'prophet':
      // 回预言家列表：清标记 + 触碰 updated_at（浮回列表顶部，md 快照与频道会话原样保留）
      d.prepare('UPDATE prophet_records SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(
        nowIso(),
        rb.item_id
      )
      break
    case 'twelve_question':
      // 回十二问题列表：仅清标记（想法行未动，恢复即全量回来）
      d.prepare('UPDATE twelve_questions SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(
        nowIso(),
        rb.item_id
      )
      break
    case 'reasoning_soup':
    case 'reasoning_game':
      // 回推理角原列表：仅清标记（汤回汤库、对局记录回记录列表；汤状态与局状态不变）
      d.prepare(`UPDATE ${TABLES[rb.source]} SET deleted_at = NULL WHERE id = ?`).run(rb.item_id)
      break
    case 'drafts':
      // 回草稿本原频道：仅清标记（channel 保留，恢复后仍在原频道列表）
      d.prepare('UPDATE drafts SET deleted_at = NULL WHERE id = ?').run(rb.item_id)
      break
    case 'canvases':
      // 回画布面板：仅清标记
      d.prepare('UPDATE canvases SET deleted_at = NULL WHERE id = ?').run(rb.item_id)
      break
    case 'learn':
      // 回知识树原主题：仅清标记（主题存续由「删主题判空含回收站节点」保证）
      d.prepare('UPDATE learn_nodes SET deleted_at = NULL WHERE id = ?').run(rb.item_id)
      break
    case 'wenbi_journal':
      // 回浮生记时间线：仅清标记（分节钉在 created_at，无需复位）
      d.prepare('UPDATE wenbi_journals SET deleted_at = NULL WHERE id = ?').run(rb.item_id)
      break
    case 'wenbi_article':
      // 回写作台构思区区末（文笔坊 specs §5：恢复回最初级区）
      {
        const tail = d
          .prepare("SELECT MAX(sort) AS m FROM wenbi_articles WHERE zone = 'idea' AND deleted_at IS NULL")
          .get() as { m: number | null }
        d.prepare("UPDATE wenbi_articles SET deleted_at = NULL, zone = 'idea', sort = ? WHERE id = ?").run(
          (tail.m ?? 0) + 1,
          rb.item_id
        )
      }
      break
    case 'ledger_tx':
      // 回账本月度列表：原日期/账户/分类不变（账本 specs §5）
      d.prepare('UPDATE ledger_tx SET deleted_at = NULL WHERE id = ?').run(rb.item_id)
      break
    case 'ledger_category':
      // 回分类列表：历史流水保持未分类，不自动回挂（账本 specs §5）
      d.prepare('UPDATE ledger_categories SET deleted_at = NULL WHERE id = ?').run(rb.item_id)
      break
    case 'ledger_account':
      // 回账本账户列表 + 级联拉回名下流水；有独立回收记录的在站流水不越权拉活
      // （「先删流水后删账户」场景防幽灵恢复，账本 specs §5）
      {
        d.prepare('UPDATE ledger_accounts SET deleted_at = NULL WHERE id = ?').run(rb.item_id)
        d.prepare(
          `UPDATE ledger_tx SET deleted_at = NULL WHERE account_id = ?
           AND id NOT IN (SELECT item_id FROM recycle_bin WHERE source = 'ledger_tx')`
        ).run(rb.item_id)
      }
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
  if (rb.source === 'learn') {
    // 知识点卡：md 路径派生为 md/learn/<id>.md，连同高光记录一起清理（同 wiki 口径）
    d.prepare('DELETE FROM learn_highlights WHERE node_id = ?').run(rb.item_id)
    mdDelete(`md/learn/${rb.item_id}.md`)
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
  if (rb.source === 'reasoning_game') {
    // 一局一 md + 多条问答消息：先收 md 路径，删消息行 + 局行 + 回收记录，最后删 md 文件
    const row = d.prepare('SELECT md_path FROM turtle_games WHERE id = ?').get(rb.item_id) as
      | { md_path: string | null }
      | undefined
    d.prepare('DELETE FROM turtle_game_messages WHERE game_id = ?').run(rb.item_id)
    d.prepare('DELETE FROM turtle_games WHERE id = ?').run(rb.item_id)
    d.prepare('DELETE FROM recycle_bin WHERE id = ?').run(recycleId)
    if (row?.md_path) mdDelete(row.md_path)
    return
  }
  if (rb.source === 'twelve_question') {
    // 删题连想法：先删想法行再删题行 + 回收记录（想法无 md）
    d.prepare('DELETE FROM twelve_thoughts WHERE question_id = ?').run(rb.item_id)
    d.prepare('DELETE FROM twelve_questions WHERE id = ?').run(rb.item_id)
    d.prepare('DELETE FROM recycle_bin WHERE id = ?').run(recycleId)
    return
  }
  if (rb.source === 'mottos') {
    // 物理删除前写墓碑留底（优化建议区第24轮）：供生成查重，防已删格言复现
    const row = d.prepare('SELECT content FROM mottos WHERE id = ?').get(rb.item_id) as
      | { content: string }
      | undefined
    if (row) recordMottoTombstone(row.content)
  }
  if (rb.source === 'ledger_account') {
    // 删账户行 + 级联物理删名下流水；有独立回收记录的在站流水留给自己的回收流程处置
    // （账本 specs §5，与 restore 的 NOT IN 守卫同口径）
    d.prepare(
      `DELETE FROM ledger_tx WHERE account_id = ?
       AND id NOT IN (SELECT item_id FROM recycle_bin WHERE source = 'ledger_tx')`
    ).run(rb.item_id)
  }
  // reasoning_soup 走默认路径：仅删汤行（汤无 md；对局记录是快照，不随汤删除——specs §5）
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
