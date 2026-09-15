// 每日挑战（260916 新功能开发区）：挑战池 CRUD + 每日定档与打卡。
// 本地随机抽取零 AI；完成记在当天（challenge_daily.done），换一条不重置；打卡可逆。
import { getDb, nowIso } from '../db/db'
import type { ChallengePoolRow, ChallengeDailyView } from '../../src/shared/types'

/** 本地日期 YYYY-MM-DD（challenge_daily 主键口径） */
export function todayLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 取每日行（LEFT JOIN 池；条目已删 content=null） */
function getDaily(date: string): ChallengeDailyView | null {
  const row = getDb()
    .prepare(
      `SELECT cd.date, cd.challenge_id, cd.done, cp.content
       FROM challenge_daily cd LEFT JOIN challenge_pool cp ON cp.id = cd.challenge_id
       WHERE cd.date = ?`
    )
    .get(date) as { date: string; challenge_id: number; done: number; content: string | null } | undefined
  if (!row) return null
  return { date: row.date, challengeId: row.challenge_id, content: row.content, done: row.done === 1 }
}

export function challengePoolCount(): number {
  return Number((getDb().prepare('SELECT COUNT(*) AS n FROM challenge_pool').get() as { n: number }).n)
}

/** 定档：无当日行则从池随机定一条写入（BEGIN/COMMIT 内 check-and-set 防并发双写）；池空不建行返回 null */
export function ensureChallengeDaily(date: string): ChallengeDailyView | null {
  const db = getDb()
  const existing = getDaily(date)
  if (existing) return existing
  db.exec('BEGIN')
  try {
    const again = getDaily(date)
    if (again) {
      db.exec('COMMIT')
      return again
    }
    const pool = db.prepare('SELECT id FROM challenge_pool').all() as { id: number }[]
    if (pool.length === 0) {
      db.exec('COMMIT')
      return null
    }
    const pick = pool[Math.floor(Math.random() * pool.length)]
    db.prepare('INSERT INTO challenge_daily (date, challenge_id, done) VALUES (?, ?, 0)').run(date, pick.id)
    db.exec('COMMIT')
    return getDaily(date)
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** 换一条：从池重抽（排除当前条目），done 保留；池 <2 抛 CHALLENGE_POOL_TOO_SMALL（前端置灰兜底） */
export function swapChallengeDaily(date: string): ChallengeDailyView {
  const db = getDb()
  const cur = getDaily(date)
  if (!cur) throw new Error('CHALLENGE_NOT_SET')
  const pool = db.prepare('SELECT id FROM challenge_pool WHERE id != ?').all(cur.challengeId) as { id: number }[]
  if (pool.length === 0) throw new Error('CHALLENGE_POOL_TOO_SMALL')
  const pick = pool[Math.floor(Math.random() * pool.length)]
  db.prepare('UPDATE challenge_daily SET challenge_id = ? WHERE date = ?').run(pick.id, date)
  return getDaily(date) as ChallengeDailyView
}

/** 打卡/撤销（可逆，误点可救；热力图随实时记录一致） */
export function setChallengeDone(date: string, done: boolean): ChallengeDailyView {
  if (!getDaily(date)) throw new Error('CHALLENGE_NOT_SET')
  getDb().prepare('UPDATE challenge_daily SET done = ? WHERE date = ?').run(done ? 1 : 0, date)
  return getDaily(date) as ChallengeDailyView
}

export function listChallengePool(): ChallengePoolRow[] {
  return getDb()
    .prepare('SELECT id, content, created_at FROM challenge_pool ORDER BY id')
    .all() as unknown as ChallengePoolRow[]
}

export function addChallengePool(content: string): ChallengePoolRow {
  const c = content.trim()
  if (!c) throw new Error('CHALLENGE_EMPTY')
  const r = getDb()
    .prepare('INSERT INTO challenge_pool (content, created_at) VALUES (?, ?)')
    .run(c, nowIso())
  return { id: Number(r.lastInsertRowid), content: c, created_at: nowIso() }
}

export function updateChallengePool(id: number, content: string): boolean {
  const c = content.trim()
  if (!c) throw new Error('CHALLENGE_EMPTY')
  getDb().prepare('UPDATE challenge_pool SET content = ? WHERE id = ?').run(c, id)
  return true
}

export function removeChallengePool(id: number): boolean {
  getDb().prepare('DELETE FROM challenge_pool WHERE id = ?').run(id)
  return true
}
