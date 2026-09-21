// 额度预算（超级工作台 2.0 总纲 §4.3）：每日软上限按 llm_usage 的 agent:* 场景汇总
// （chatCompletion 已按 scene 记账，直接读，无需自建计数）。只约束搜集类任务，
// 按需任务（用户主动点的精讲/精译等）不受限。
import { getDb } from '../../db/db'
import { getSetting } from '../../db/settings'
import { SettingsKeys } from '../../../src/shared/types'

/** 本地今日 00:00 的 UTC ISO（llm_usage.created_at 为 UTC ISO 串，本地日边界换算在 JS 侧完成） */
function todayStartIso(): string {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).toISOString()
}

export function agentTokensToday(): number {
  const r = getDb()
    .prepare(
      "SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS n FROM llm_usage WHERE scene LIKE 'agent:%' AND created_at >= ?"
    )
    .get(todayStartIso()) as { n: number }
  return Number(r.n) || 0
}

/** 某时刻以来指定 scene 前缀的 token 消耗（任务级记账：runner 起止差值累加进 task_runs） */
export function tokensSince(startIso: string, scenePrefix: string): number {
  const r = getDb()
    .prepare(
      'SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS n FROM llm_usage WHERE scene LIKE ? AND created_at >= ?'
    )
    .get(`${scenePrefix}%`, startIso) as { n: number }
  return Number(r.n) || 0
}

/** 每日软上限（token），0 = 不限 */
export function dailyBudget(): number {
  const v = Number(getSetting(SettingsKeys.AgentDailyBudget) ?? 0)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/** 搜集类任务派发前检查；按需任务不受限 */
export function collectionAllowed(): boolean {
  const budget = dailyBudget()
  return budget === 0 || agentTokensToday() < budget
}

/** runner 内累计任务 token（task_runs.tokens_used） */
export function recordTaskTokens(runId: number, n: number): void {
  if (!(n > 0)) return
  getDb()
    .prepare('UPDATE task_runs SET tokens_used = tokens_used + ? WHERE id = ?')
    .run(n, runId)
}
