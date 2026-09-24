// 娱乐城服务（娱乐城 specs §1/§3/§5）：共用钱包 / 塔罗记录 / 德扑对局存取与结算 / 21点战绩。
// 筹码只以整数流转；余额变动一律在事务内完成（specs §1）。
import { getDb, nowIso } from '../db/db'
import { mdWrite } from './files'
import { discardToRecycle } from './recycle'
import { YULE_BUY_IN, YULE_PRIZES, YULE_RELIEF_AMOUNT, YULE_RELIEF_THRESHOLD } from '../../src/shared/types'

function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------- 钱包 ----------

export interface WalletView {
  balance: number
  reliefAvailable: boolean
  reliefAmount: number
  threshold: number
}

function ensureWallet(): { balance: number; relief_date: string | null } {
  const d = getDb()
  let row = d.prepare('SELECT balance, relief_date FROM yule_wallet WHERE id = 1').get() as
    | { balance: number; relief_date: string | null }
    | undefined
  if (!row) {
    d.prepare('INSERT INTO yule_wallet (id, balance, relief_date, created_at, updated_at) VALUES (1, ?, NULL, ?, ?)').run(
      5000,
      nowIso(),
      nowIso()
    )
    row = d.prepare('SELECT balance, relief_date FROM yule_wallet WHERE id = 1').get() as {
      balance: number
      relief_date: string | null
    }
  }
  return row
}

export function getWallet(): WalletView {
  const row = ensureWallet()
  return {
    balance: row.balance,
    reliefAvailable: row.balance < YULE_RELIEF_THRESHOLD,
    reliefAmount: YULE_RELIEF_AMOUNT,
    threshold: YULE_RELIEF_THRESHOLD
  }
}

/** 破产救济：余额低于阈值且当日未领（specs §0） */
export function claimRelief(): WalletView {
  const d = getDb()
  const row = ensureWallet()
  if (row.balance >= YULE_RELIEF_THRESHOLD) throw new Error('余额充足，无需救济')
  if (row.relief_date === todayLocal()) throw new Error('今日救济已领取，明天再来')
  d.exec('BEGIN')
  try {
    d.prepare('UPDATE yule_wallet SET balance = balance + ?, relief_date = ?, updated_at = ? WHERE id = 1').run(
      YULE_RELIEF_AMOUNT,
      todayLocal(),
      nowIso()
    )
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
  return getWallet()
}

// ---------- 塔罗 ----------

export interface TaroSaveInput {
  spread: string // single | three
  question: string
  cards: { name: string; upright: boolean; position: string }[]
  md: string // 解读全文（AI 生成 + 牌面头部，渲染层组装）
}

export interface TaroRecordRow {
  id: number
  spread: string
  question: string
  cards: string // JSON
  md_path: string
  created_at: string
  updated_at: string
}

export function taroSave(input: TaroSaveInput): TaroRecordRow {
  const d = getDb()
  const now = nowIso()
  const info = d
    .prepare('INSERT INTO taro_records (spread, question, cards, md_path, created_at, updated_at) VALUES (?, ?, ?, \'\', ?, ?)')
    .run(input.spread, input.question, JSON.stringify(input.cards), now, now)
  const id = Number(info.lastInsertRowid)
  const mdPath = `md/yule/taro/${id}.md`
  mdWrite(mdPath, input.md)
  d.prepare('UPDATE taro_records SET md_path = ? WHERE id = ?').run(mdPath, id)
  return d.prepare('SELECT * FROM taro_records WHERE id = ?').get(id) as unknown as TaroRecordRow
}

export function taroList(): TaroRecordRow[] {
  return getDb()
    .prepare('SELECT * FROM taro_records WHERE deleted_at IS NULL ORDER BY id DESC')
    .all() as unknown as TaroRecordRow[]
}

export function taroRemove(id: number): void {
  const d = getDb()
  const row = d.prepare('SELECT id FROM taro_records WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!row) throw new Error('NOT_FOUND')
  discardToRecycle('yule_taro', id)
}

// ---------- 德扑 ----------

export interface PokerGameRow {
  id: number
  status: string // playing | finished | abandoned
  my_rank: number | null
  prize: number
  hands_count: number
  hand_log: string // JSON HandLogEntry[]
  state: string | null // playing 时 = 引擎快照 JSON
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  review_md_path: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export function pokerStart(initialState: string): PokerGameRow {
  const d = getDb()
  if (d.prepare("SELECT id FROM poker_games WHERE status = 'playing' AND deleted_at IS NULL").get())
    throw new Error('已有进行中的对局，请先完成或弃赛')
  const w = ensureWallet()
  if (w.balance < YULE_BUY_IN) throw new Error(`筹码不足（买入 ${YULE_BUY_IN}），可先领取救济`)
  const now = nowIso()
  d.exec('BEGIN')
  try {
    d.prepare('UPDATE yule_wallet SET balance = balance - ?, updated_at = ? WHERE id = 1').run(YULE_BUY_IN, now)
    const info = d
      .prepare(
        "INSERT INTO poker_games (status, hands_count, hand_log, state, started_at, created_at, updated_at) VALUES ('playing', 0, '[]', ?, ?, ?, ?)"
      )
      .run(initialState, now, now, now)
    const id = Number(info.lastInsertRowid)
    d.exec('COMMIT')
    return d.prepare('SELECT * FROM poker_games WHERE id = ?').get(id) as unknown as PokerGameRow
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}

export function pokerPlayingState(): PokerGameRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM poker_games WHERE status = 'playing' AND deleted_at IS NULL LIMIT 1")
      .get() as PokerGameRow | undefined) ?? null
  )
}

export function pokerSaveState(id: number, state: string, handsCount: number, handsLog: string): void {
  const d = getDb()
  const row = d.prepare("SELECT id FROM poker_games WHERE id = ? AND status = 'playing'").get(id)
  if (!row) return // 局已终态（finish/abandon 竞速），快照丢弃
  d.prepare('UPDATE poker_games SET state = ?, hands_count = ?, hand_log = ?, updated_at = ? WHERE id = ?').run(
    state,
    handsCount,
    handsLog,
    nowIso(),
    id
  )
}

/** 终局结算：按名次发奖入钱包 + 写终态（specs §3 事务口径） */
export function pokerFinish(id: number, rank: number, handsLog: string, durationMs: number): PokerGameRow {
  const d = getDb()
  const row = d.prepare("SELECT * FROM poker_games WHERE id = ? AND status = 'playing'").get(id) as
    | PokerGameRow
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  const prize = YULE_PRIZES[rank - 1] ?? 0
  const now = nowIso()
  d.exec('BEGIN')
  try {
    if (prize > 0) d.prepare('UPDATE yule_wallet SET balance = balance + ?, updated_at = ? WHERE id = 1').run(prize, now)
    d.prepare(
      "UPDATE poker_games SET status = 'finished', my_rank = ?, prize = ?, hand_log = ?, ended_at = ?, duration_ms = ?, state = NULL, updated_at = ? WHERE id = ?"
    ).run(rank, prize, handsLog, now, durationMs, now, id)
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
  return d.prepare('SELECT * FROM poker_games WHERE id = ?').get(id) as unknown as PokerGameRow
}

/** 弃赛：记第 4 名、无奖励，买入不退（specs §2） */
export function pokerAbandon(id: number): void {
  const d = getDb()
  const row = d
    .prepare("SELECT id, started_at FROM poker_games WHERE id = ? AND status = 'playing'")
    .get(id) as { id: number; started_at: string } | undefined
  if (!row) throw new Error('NOT_FOUND')
  const now = nowIso()
  d.prepare(
    "UPDATE poker_games SET status = 'abandoned', my_rank = 4, prize = 0, state = NULL, ended_at = ?, duration_ms = ?, updated_at = ? WHERE id = ?"
  ).run(now, Date.now() - new Date(row.started_at).getTime(), now, id)
}

export function pokerList(): PokerGameRow[] {
  return getDb()
    .prepare("SELECT * FROM poker_games WHERE status != 'playing' AND deleted_at IS NULL ORDER BY id DESC")
    .all() as unknown as PokerGameRow[]
}

/** AI 复盘落盘：写 md + 回写指针（specs §2） */
export function pokerSaveReview(id: number, md: string): string {
  const d = getDb()
  const row = d.prepare('SELECT id, review_md_path FROM poker_games WHERE id = ? AND deleted_at IS NULL').get(id) as
    | { id: number; review_md_path: string | null }
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  const mdPath = row.review_md_path ?? `md/yule/poker/${id}-review.md`
  mdWrite(mdPath, md)
  d.prepare('UPDATE poker_games SET review_md_path = ?, updated_at = ? WHERE id = ?').run(mdPath, nowIso(), id)
  return mdPath
}

export function pokerRemove(id: number): void {
  const d = getDb()
  const row = d.prepare('SELECT id FROM poker_games WHERE id = ? AND deleted_at IS NULL AND status != ?').get(id, 'playing')
  if (!row) throw new Error('NOT_FOUND')
  discardToRecycle('yule_poker', id)
}

// ---------- 21 点 ----------

export interface BlackjackStatsView {
  hands: number
  wins: number
  losses: number
  pushes: number
  net: number
}

function ensureBjStats(): void {
  const d = getDb()
  if (!d.prepare('SELECT id FROM blackjack_stats WHERE id = 1').get()) {
    d.prepare('INSERT INTO blackjack_stats (id, hands, wins, losses, pushes, net, updated_at) VALUES (1, 0, 0, 0, 0, 0, ?)').run(nowIso())
  }
}

/** 每手结算：钱包净变动 + 战绩累加同事务（specs §3） */
export function blackjackSettle(
  bet: number,
  result: 'win' | 'lose' | 'push' | 'blackjack',
  net: number
): { balance: number; stats: BlackjackStatsView } {
  const d = getDb()
  if (!Number.isInteger(bet) || bet <= 0) throw new Error('注额不合法')
  if (!Number.isInteger(net)) throw new Error('结算值不合法')
  ensureBjStats()
  const w = ensureWallet()
  if (net < 0 && w.balance < -net) throw new Error('筹码不足')
  const now = nowIso()
  d.exec('BEGIN')
  try {
    d.prepare('UPDATE yule_wallet SET balance = balance + ?, updated_at = ? WHERE id = 1').run(net, now)
    const col = result === 'win' || result === 'blackjack' ? 'wins' : result === 'lose' ? 'losses' : 'pushes'
    d.prepare(
      `UPDATE blackjack_stats SET hands = hands + 1, ${col} = ${col} + 1, net = net + ?, updated_at = ? WHERE id = 1`
    ).run(net, now)
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
  const bal = d.prepare('SELECT balance FROM yule_wallet WHERE id = 1').get() as { balance: number }
  const stats = d.prepare('SELECT hands, wins, losses, pushes, net FROM blackjack_stats WHERE id = 1').get() as unknown as BlackjackStatsView
  return { balance: bal.balance, stats }
}

export function blackjackGetStats(): BlackjackStatsView {
  ensureBjStats()
  return getDb().prepare('SELECT hands, wins, losses, pushes, net FROM blackjack_stats WHERE id = 1').get() as unknown as BlackjackStatsView
}
