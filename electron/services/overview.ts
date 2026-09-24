// 总导览热力图（260916 新功能开发区）：读时聚合五源——学习每日要求 / 每日一题 / 每日挑战 /
// 飞花令打卡（260925 赋诗苑）/ 副本读毕（260925 副本库）。
// 不建汇总表（方案 A）：各源打卡各归其主表。
import { getDb } from '../db/db'
import type { HeatmapDay } from '../../src/shared/types'

/** 五源聚合（from/to 为本地 YYYY-MM-DD 闭区间）；只含有记录的天 */
export function heatmapOverview(from: string, to: string): HeatmapDay[] {
  const db = getDb()
  const learnRows = db
    .prepare('SELECT date, done FROM learn_daily WHERE date BETWEEN ? AND ?')
    .all(from, to) as { date: string; done: number }[]
  const wallRows = db
    .prepare("SELECT date FROM wall_puzzles WHERE date BETWEEN ? AND ? AND status != 'answering'")
    .all(from, to) as { date: string }[]
  const challengeRows = db
    .prepare('SELECT date, done FROM challenge_daily WHERE date BETWEEN ? AND ?')
    .all(from, to) as { date: string; done: number }[]
  const fushiRows = db
    .prepare('SELECT date, done FROM fushi_daily WHERE date BETWEEN ? AND ?')
    .all(from, to) as { date: string; done: number }[]
  const copyRows = db
    .prepare('SELECT date FROM copy_daily WHERE date BETWEEN ? AND ? AND finished_at IS NOT NULL')
    .all(from, to) as { date: string }[]
  const byDate = new Map<string, HeatmapDay>()
  const blank = (date: string): HeatmapDay => ({
    date,
    learn: false,
    wall: false,
    challenge: false,
    fushi: false,
    copies: false,
    level: 0
  })
  for (const r of learnRows) {
    if (r.done !== 1) continue
    const d = byDate.get(r.date) ?? blank(r.date)
    d.learn = true
    byDate.set(r.date, d)
  }
  for (const r of wallRows) {
    const d = byDate.get(r.date) ?? blank(r.date)
    d.wall = true
    byDate.set(r.date, d)
  }
  for (const r of challengeRows) {
    if (r.done !== 1) continue
    const d = byDate.get(r.date) ?? blank(r.date)
    d.challenge = true
    byDate.set(r.date, d)
  }
  for (const r of fushiRows) {
    if (r.done !== 1) continue
    const d = byDate.get(r.date) ?? blank(r.date)
    d.fushi = true
    byDate.set(r.date, d)
  }
  for (const r of copyRows) {
    const d = byDate.get(r.date) ?? blank(r.date)
    d.copies = true
    byDate.set(r.date, d)
  }
  const out = [...byDate.values()]
  for (const d of out)
    d.level =
      (d.learn ? 1 : 0) + (d.wall ? 1 : 0) + (d.challenge ? 1 : 0) + (d.fushi ? 1 : 0) + (d.copies ? 1 : 0)
  out.sort((a, b) => a.date.localeCompare(b.date))
  return out
}
