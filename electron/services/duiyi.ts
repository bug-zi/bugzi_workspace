// 对弈社服务（2026-09-26-对弈社-design.md §4/§5）：五种棋人机对弈留档——
// 开局（顶掉同棋种旧 playing 局）/快照回写（终态竞速丢弃）/终局落库/记录列表/战绩读时聚合。
// 纯本地零 LLM；删除走回收站（source 'duiyi'）；无 md 附属产物。
import { getDb, nowIso } from '../db/db'
import type { DuiyiGameKey, DuiyiGameRow, DuiyiStats } from '../../src/shared/types'

export type { DuiyiGameKey, DuiyiGameRow, DuiyiStats }

/** 开局：同棋种旧 playing 局先置 abandoned（被顶掉局无排名意义，记录列表不显）再插入新局 */
export function duiyiStart(
  game: DuiyiGameKey,
  difficulty: number,
  boardSpec: number | null,
  initialState: string
): DuiyiGameRow {
  const d = getDb()
  const now = nowIso()
  d.prepare("UPDATE duiyi_games SET status = 'abandoned', updated_at = ? WHERE game = ? AND status = 'playing'").run(
    now,
    game
  )
  const r = d
    .prepare(
      "INSERT INTO duiyi_games (game, status, difficulty, board_spec, state, started_at, updated_at) VALUES (?, 'playing', ?, ?, ?, ?, ?)"
    )
    .run(game, difficulty, boardSpec, initialState, now, now)
  return d.prepare('SELECT * FROM duiyi_games WHERE id = ?').get(r.lastInsertRowid) as unknown as DuiyiGameRow
}

/** 进行中局（进模块恢复用；每棋种至多一局） */
export function duiyiPlaying(game: DuiyiGameKey): DuiyiGameRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM duiyi_games WHERE game = ? AND status = 'playing' AND deleted_at IS NULL")
      .get(game) as DuiyiGameRow | undefined) ?? null
  )
}

/** 快照回写：仅 playing 生效（终局/顶掉竞速时静默丢弃，照 pokerSaveState 口径） */
export function duiyiSaveState(id: number, state: string, moveCount: number): void {
  const row = getDb().prepare("SELECT id FROM duiyi_games WHERE id = ? AND status = 'playing'").get(id)
  if (!row) return
  getDb()
    .prepare('UPDATE duiyi_games SET state = ?, move_count = ?, updated_at = ? WHERE id = ?')
    .run(state, moveCount, nowIso(), id)
}

/** 终局：playing → finished（result 我方视角；record 棋谱 JSON） */
export function duiyiFinish(
  id: number,
  result: 'win' | 'loss' | 'draw',
  reason: string,
  record: string,
  moveCount: number,
  durationMs: number
): DuiyiGameRow {
  const d = getDb()
  const row = d.prepare("SELECT * FROM duiyi_games WHERE id = ? AND status = 'playing'").get(id) as
    | DuiyiGameRow
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  const now = nowIso()
  d.prepare(
    "UPDATE duiyi_games SET status = 'finished', result = ?, reason = ?, record = ?, state = NULL, move_count = ?, ended_at = ?, duration_ms = ?, updated_at = ? WHERE id = ?"
  ).run(result, reason, record, moveCount, now, Math.max(0, durationMs), now, id)
  return d.prepare('SELECT * FROM duiyi_games WHERE id = ?').get(id) as unknown as DuiyiGameRow
}

/** 记录列表（仅 finished；abandoned 被顶掉局不显不入回收站） */
export function duiyiList(game?: DuiyiGameKey): DuiyiGameRow[] {
  const d = getDb()
  if (game) {
    return d
      .prepare("SELECT * FROM duiyi_games WHERE game = ? AND status = 'finished' AND deleted_at IS NULL ORDER BY id DESC")
      .all(game) as unknown as DuiyiGameRow[]
  }
  return d
    .prepare("SELECT * FROM duiyi_games WHERE status = 'finished' AND deleted_at IS NULL ORDER BY id DESC")
    .all() as unknown as DuiyiGameRow[]
}

/** 战绩读时聚合：五棋种分项 + total（design §4 不建汇总表） */
export function duiyiStats(): Record<DuiyiGameKey | 'total', DuiyiStats> {
  const rows = getDb()
    .prepare(
      "SELECT game, result, COUNT(*) AS n FROM duiyi_games WHERE status = 'finished' AND deleted_at IS NULL GROUP BY game, result"
    )
    .all() as { game: DuiyiGameKey; result: string; n: number }[]
  const out: Record<DuiyiGameKey | 'total', DuiyiStats> = {
    xiangqi: { win: 0, loss: 0, draw: 0 },
    chess: { win: 0, loss: 0, draw: 0 },
    shogi: { win: 0, loss: 0, draw: 0 },
    gomoku: { win: 0, loss: 0, draw: 0 },
    go: { win: 0, loss: 0, draw: 0 },
    total: { win: 0, loss: 0, draw: 0 }
  }
  for (const r of rows) {
    const s = out[r.game]
    if (!s) continue
    if (r.result === 'win') s.win += r.n
    else if (r.result === 'loss') s.loss += r.n
    else if (r.result === 'draw') s.draw += r.n
  }
  out.total = {
    win: out.xiangqi.win + out.chess.win + out.shogi.win + out.gomoku.win + out.go.win,
    loss: out.xiangqi.loss + out.chess.loss + out.shogi.loss + out.gomoku.loss + out.go.loss,
    draw: out.xiangqi.draw + out.chess.draw + out.shogi.draw + out.gomoku.draw + out.go.draw
  }
  return out
}
