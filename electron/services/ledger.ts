// 账本服务（账本 specs §2）：账户/分类/流水 CRUD + 月度统计，纯本地零 AI
import { getDb, nowIso } from '../db/db'
import { discardToRecycle } from './recycle'

/** 金额上限（分）：约 1 亿元，防手滑（specs §0） */
export const MAX_AMOUNT_CENTS = 9_999_999_999

/** 流水入站前的显示名联表口径（specs §5 快照冗余 / §2.3 防悬空共用） */
const TX_SELECT = `
  SELECT t.*, c.name AS category_name, a.name AS account_name
  FROM ledger_tx t
  LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.deleted_at IS NULL
  LEFT JOIN ledger_accounts a ON a.id = t.account_id AND a.deleted_at IS NULL
`

// ---------- 账户 ----------

export function listAccounts(): (Record<string, unknown> & { balance_cents: number })[] {
  return getDb()
    .prepare(
      `SELECT a.id, a.name, a.initial_balance_cents, a.sort, a.created_at,
        a.initial_balance_cents + COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents ELSE -t.amount_cents END), 0) AS balance_cents
      FROM ledger_accounts a
      LEFT JOIN ledger_tx t ON t.account_id = a.id AND t.deleted_at IS NULL
      WHERE a.deleted_at IS NULL
      GROUP BY a.id
      ORDER BY a.sort, a.id`
    )
    .all() as (Record<string, unknown> & { balance_cents: number })[]
}

export function saveAccount(id: number | null, name: string, initialBalanceCents: number): void {
  const d = getDb()
  const n = name.trim()
  if (!n) throw new Error('账户名不能为空')
  if (initialBalanceCents < 0) throw new Error('期初余额不能为负')
  const dup = d
    .prepare('SELECT 1 FROM ledger_accounts WHERE name = ? AND deleted_at IS NULL AND id != ?')
    .get(n, id ?? 0)
  if (dup) throw new Error('已存在同名账户')
  if (id == null) {
    const tail = d
      .prepare('SELECT MAX(sort) AS m FROM ledger_accounts WHERE deleted_at IS NULL')
      .get() as { m: number | null }
    d.prepare(
      'INSERT INTO ledger_accounts (name, initial_balance_cents, sort, created_at) VALUES (?, ?, ?, ?)'
    ).run(n, initialBalanceCents, (tail.m ?? 0) + 1, nowIso())
  } else {
    d.prepare('UPDATE ledger_accounts SET name = ?, initial_balance_cents = ? WHERE id = ?').run(
      n,
      initialBalanceCents,
      id
    )
  }
}

/** 删账户：入回收站 + 级联软删名下流水（已在站的流水不动，specs §2.1） */
export function removeAccount(id: number): { cascaded: number } {
  const d = getDb()
  const acc = d.prepare('SELECT * FROM ledger_accounts WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!acc) throw new Error('NOT_FOUND')
  discardToRecycle('ledger_account', id)
  const r = d
    .prepare('UPDATE ledger_tx SET deleted_at = ? WHERE account_id = ? AND deleted_at IS NULL')
    .run(nowIso(), id)
  return { cascaded: Number(r.changes) }
}

// ---------- 分类 ----------

export function listCategories(): Record<string, unknown>[] {
  return getDb()
    .prepare('SELECT * FROM ledger_categories WHERE deleted_at IS NULL ORDER BY kind, sort, id')
    .all() as Record<string, unknown>[]
}

export function saveCategory(id: number | null, name: string, kind: 'expense' | 'income'): void {
  const d = getDb()
  const n = name.trim()
  if (!n) throw new Error('分类名不能为空')
  if (kind !== 'expense' && kind !== 'income') throw new Error('分类类型不合法')
  const dup = d
    .prepare(
      'SELECT 1 FROM ledger_categories WHERE name = ? AND kind = ? AND deleted_at IS NULL AND id != ?'
    )
    .get(n, kind, id ?? 0)
  if (dup) throw new Error('已存在同名分类')
  if (id == null) {
    const tail = d
      .prepare('SELECT MAX(sort) AS m FROM ledger_categories WHERE kind = ? AND deleted_at IS NULL')
      .get(kind) as { m: number | null }
    const base = kind === 'expense' ? 0 : 100
    d.prepare(
      'INSERT INTO ledger_categories (name, kind, sort, created_at) VALUES (?, ?, ?, ?)'
    ).run(n, kind, (tail.m ?? base - 1) + 1, nowIso())
  } else {
    d.prepare('UPDATE ledger_categories SET name = ?, kind = ? WHERE id = ?').run(n, kind, id)
  }
}

/** 删分类：在用流水断链为未分类（软删流水不断链——恢复保持原分类，specs §2.2）→ 入回收站 */
export function removeCategory(id: number): { detached: number } {
  const d = getDb()
  const cat = d.prepare('SELECT * FROM ledger_categories WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!cat) throw new Error('NOT_FOUND')
  const r = d
    .prepare('UPDATE ledger_tx SET category_id = NULL WHERE category_id = ? AND deleted_at IS NULL')
    .run(id)
  discardToRecycle('ledger_category', id)
  return { detached: Number(r.changes) }
}

// ---------- 流水 ----------

export interface LedgerTxInput {
  date: string
  type: 'expense' | 'income'
  amountCents: number
  categoryId: number | null
  accountId: number
  note: string
}

export function listTx(month: string, categoryId?: number | null): Record<string, unknown>[] {
  const d = getDb()
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份参数不合法')
  let sql = `${TX_SELECT} WHERE t.deleted_at IS NULL AND strftime('%Y-%m', t.date) = ?`
  const args: unknown[] = [month]
  if (categoryId === -1) {
    // 占比条「未分类」桶下钻（categoryId 为 NULL 与「全部」的 null 需区分，specs §2.3）
    sql += ' AND t.category_id IS NULL'
  } else if (categoryId != null) {
    sql += ' AND t.category_id = ?'
    args.push(categoryId)
  }
  sql += ' ORDER BY t.date DESC, t.id DESC'
  return d.prepare(sql).all(...(args as never[])) as Record<string, unknown>[]
}

export function saveTx(id: number | null, tx: LedgerTxInput): void {
  const d = getDb()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.date) || Number.isNaN(new Date(tx.date).getTime())) {
    throw new Error('日期不合法')
  }
  if (!Number.isInteger(tx.amountCents) || tx.amountCents <= 0 || tx.amountCents > MAX_AMOUNT_CENTS) {
    throw new Error('金额不合法（需大于 0 且不超过 1 亿元）')
  }
  if (tx.type !== 'expense' && tx.type !== 'income') throw new Error('类型不合法')
  const acc = d
    .prepare('SELECT 1 FROM ledger_accounts WHERE id = ? AND deleted_at IS NULL')
    .get(tx.accountId)
  if (!acc) throw new Error('账户不存在或已删除')
  if (tx.categoryId != null) {
    const cat = d
      .prepare('SELECT 1 FROM ledger_categories WHERE id = ? AND deleted_at IS NULL')
      .get(tx.categoryId)
    if (!cat) throw new Error('分类不存在或已删除')
  }
  if (id == null) {
    d.prepare(
      'INSERT INTO ledger_tx (date, type, amount_cents, category_id, account_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(tx.date, tx.type, tx.amountCents, tx.categoryId, tx.accountId, tx.note ?? '', nowIso())
  } else {
    d.prepare(
      'UPDATE ledger_tx SET date = ?, type = ?, amount_cents = ?, category_id = ?, account_id = ?, note = ? WHERE id = ?'
    ).run(tx.date, tx.type, tx.amountCents, tx.categoryId, tx.accountId, tx.note ?? '', id)
  }
}

/** 删流水：入站前行快照冗余分类/账户显示名（specs §5，回收站摘要用） */
export function removeTx(id: number): void {
  const d = getDb()
  const row = d.prepare(`${TX_SELECT} WHERE t.id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  d.prepare(
    'INSERT INTO recycle_bin (source, item_id, payload, created_at) VALUES (?, ?, ?, ?)'
  ).run('ledger_tx', id, JSON.stringify(row), nowIso())
  d.prepare('UPDATE ledger_tx SET deleted_at = ? WHERE id = ?').run(nowIso(), id)
}

// ---------- 统计 ----------

/** 月度统计：收支合计 + 支出分类排行（断链归「未分类」桶，specs §2.3） */
export function stats(month: string): {
  incomeCents: number
  expenseCents: number
  breakdown: { categoryId: number | null; name: string; cents: number; pct: number }[]
} {
  const d = getDb()
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份参数不合法')
  const totals = d
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents END), 0) AS income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents END), 0) AS expense
      FROM ledger_tx WHERE deleted_at IS NULL AND strftime('%Y-%m', date) = ?`
    )
    .get(month) as { income: number; expense: number }
  const groups = d
    .prepare(
      `SELECT t.category_id AS categoryId, COALESCE(c.name, '未分类') AS name, SUM(t.amount_cents) AS cents
      FROM ledger_tx t
      LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.deleted_at IS NULL
      WHERE t.deleted_at IS NULL AND t.type = 'expense' AND strftime('%Y-%m', t.date) = ?
      GROUP BY t.category_id, c.name
      ORDER BY cents DESC`
    )
    .all(month) as { categoryId: number | null; name: string; cents: number }[]
  const expense = totals.expense ?? 0
  return {
    incomeCents: totals.income ?? 0,
    expenseCents: expense,
    breakdown: groups.map((g) => ({
      categoryId: g.categoryId,
      name: g.name,
      cents: g.cents,
      pct: expense > 0 ? Math.round((g.cents / expense) * 100) : 0
    }))
  }
}
