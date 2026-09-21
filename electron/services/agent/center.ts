// 任务中心数据服务（超级工作台 2.0 批次C spec §2）：任务台账 + 日统计聚合。
// 本地日界换算同 budget.ts 口径（task_runs.started_at 为 UTC ISO，边界在 JS 侧换算）。
import { getDb, nowIso } from '../../db/db'
import { getSetting } from '../../db/settings'
import { SettingsKeys } from '../../../src/shared/types'
import type { TaskRunRow } from '../../../src/shared/types'
import { getStatus } from './engine'
import { agentTokensToday } from './budget'
import { pendingDiscoverCount } from './papers'

export function listRuns(limit = 100): TaskRunRow[] {
  return getDb()
    .prepare('SELECT * FROM task_runs ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown as TaskRunRow[]
}

function dayStartIso(offsetDays = 0): string {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - offsetDays).toISOString()
}

/** 按任务类型统计某日（本地）done 数 */
function doneCountSince(startIso: string, endIso: string, types: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of types) {
    const r = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM task_runs WHERE task_type = ? AND status = 'done' AND started_at >= ? AND started_at < ?"
      )
      .get(t, startIso, endIso) as { n: number }
    out[t] = Number(r.n) || 0
  }
  return out
}

const STAT_TYPES = ['collect_deep', 'make_digest', 'lecture', 'translate']

export interface AgentDayStats {
  enabled: boolean
  phase: 'idle' | 'working' | 'paused'
  pauseReason: string | null
  runningTypes: string[]
  pendingDiscover: number
  budgetToday: number
  today: Record<string, number>
  yesterday: Record<string, number>
  generatedAt: string
}

export function dayStats(): AgentDayStats {
  const todayStart = dayStartIso()
  const yStart = dayStartIso(1)
  const s = getStatus()
  return {
    enabled: getSetting(SettingsKeys.AgentEnabled) === '1',
    phase: s.phase,
    pauseReason: s.pauseReason,
    runningTypes: s.runningTypes,
    pendingDiscover: pendingDiscoverCount(),
    budgetToday: agentTokensToday(),
    today: doneCountSince(todayStart, nowIso(), STAT_TYPES),
    yesterday: doneCountSince(yStart, todayStart, STAT_TYPES),
    generatedAt: nowIso()
  }
}
