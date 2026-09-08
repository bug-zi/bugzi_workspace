// 定时任务（主进程）：格言定时生成 + 回收站每日零点清理 + 信息源老文章正文清理
// 规则（总需求文档第 10 条）：App 未运行时错过即跳过，不补生成
import { getSetting, setSetting } from '../db/settings'
import { SettingsKeys } from '../../src/shared/types'
import { generateMottos } from '../ai/services'
import { cleanupExpired } from './recycle'
import { cleanupOldArticleBodies } from './feed'

let mottoTimer: NodeJS.Timeout | null = null
let midnightTimer: NodeJS.Timeout | null = null

/** 计算距下一个 HH:mm 的毫秒数 */
export function msUntilNext(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/)
  const h = m ? Number(m[1]) : 22
  const min = m ? Number(m[2]) : 0
  const now = new Date()
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime() - now.getTime()
}

/** 距下一个零点的毫秒数 */
function msUntilMidnight(): number {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0)
  return next.getTime() - now.getTime()
}

/** 今天是否已执行过定时生成（按本地日期记 last_motto_run） */
function alreadyRanToday(schedule: string): boolean {
  const last = getSetting(SettingsKeys.LastMottoRun)
  if (!last) return false
  const now = new Date()
  const lastDate = new Date(last)
  // 同一本地日且在排程时间之后跑过 → 已执行
  return (
    lastDate.getFullYear() === now.getFullYear() &&
    lastDate.getMonth() === now.getMonth() &&
    lastDate.getDate() === now.getDate()
  )
}

/** 排程下一次格言生成 */
export function scheduleMottoTask(): void {
  if (mottoTimer) clearTimeout(mottoTimer)
  const schedule = getSetting(SettingsKeys.MottoSchedule) ?? '22:00'
  const delay = msUntilNext(schedule)
  mottoTimer = setTimeout(() => {
    void runScheduledMottos()
    // 执行后重排（跨天）
    scheduleMottoTask()
  }, delay)
  mottoTimer.unref?.()
}

/** 到点执行：失败静默记录日志（格言库 specs §3.3），下次定时再试 */
async function runScheduledMottos(): Promise<void> {
  try {
    const schedule = getSetting(SettingsKeys.MottoSchedule) ?? '22:00'
    if (alreadyRanToday(schedule)) return
    await generateMottos()
    setSetting(SettingsKeys.LastMottoRun, new Date().toISOString())
    console.log(`[scheduler] 定时格言生成完成 ${new Date().toISOString()}`)
  } catch (e) {
    // LLM 未配置也静默（定时任务不弹窗）
    console.warn(`[scheduler] 定时格言生成失败：${(e as Error).message}`)
  }
}

/** 排程回收站零点清理（回收站 specs §4） */
export function scheduleMidnightCleanup(): void {
  if (midnightTimer) clearTimeout(midnightTimer)
  midnightTimer = setTimeout(() => {
    try {
      const n = cleanupExpired()
      if (n > 0) console.log(`[scheduler] 回收站零点清理 ${n} 条`)
      const a = cleanupOldArticleBodies()
      if (a > 0) console.log(`[scheduler] 信息源老文章正文清理 ${a} 条`)
    } catch (e) {
      console.warn(`[scheduler] 回收站清理失败：${(e as Error).message}`)
    }
    scheduleMidnightCleanup()
  }, msUntilMidnight())
  midnightTimer.unref?.()
}

/** main.ts 调用：启动时一次清理 + 两个排程 */
export function startSchedulers(): void {
  try {
    const n = cleanupExpired()
    if (n > 0) console.log(`[scheduler] 启动清理回收站 ${n} 条`)
    const a = cleanupOldArticleBodies()
    if (a > 0) console.log(`[scheduler] 启动清理信息源老文章正文 ${a} 条`)
  } catch (e) {
    console.warn(`[scheduler] 启动清理失败：${(e as Error).message}`)
  }
  scheduleMottoTask()
  scheduleMidnightCleanup()
}
