// 定时任务（主进程）：格言启动生成（每日最多两次，260929 自每晚定时改为启动触发）+ 回收站每日零点清理 + 信息源 30 天已读文章清理
// 规则（总需求文档第 10 条）：App 未运行时错过即跳过，不补生成
import { getSetting, setSetting } from '../db/settings'
import { SettingsKeys } from '../../src/shared/types'
import { generateMottos } from '../ai/services'
import { cleanupExpired } from './recycle'
import { cleanupOldArticles } from './feed'
import { cleanupOldLogs, logInfo, logWarn } from './logger'
import { ensureDailyLearn } from './wikiStock'
import { ensureLearnStock } from './learnStock'
import { ensureInterviewDaily } from './interviewBank'
import { ensureFushiDaily } from './fushi'
import { ensureWhoamiDaily } from './whoami'
import { isLlmConfigured } from '../ai/services'
import { notifyToast } from './notify'

let midnightTimer: NodeJS.Timeout | null = null

/** 距下一个零点的毫秒数 */
function msUntilMidnight(): number {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0)
  return next.getTime() - now.getTime()
}

/** 每日启动生成次数上限（260929：同日多次重启不重复刷库） */
const MOTTO_RUNS_PER_DAY = 2

/** 本地日期键 YYYY-MM-DD */
function localDayKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 今天启动生成已执行次数（motto_run_mark = "YYYY-MM-DD|count"，跨日归零；仅成功计数，失败下次启动重试） */
function todayRunCount(): number {
  const mark = getSetting(SettingsKeys.MottoRunMark)
  if (!mark) return 0
  const [day, count] = mark.split('|')
  return day === localDayKey(new Date()) ? Number(count) || 0 : 0
}

/** 启动执行（每次启动触发，每日最多 MOTTO_RUNS_PER_DAY 次）：完成/失败经 notify:toast 轻提示
 *  （优化建议区第60轮：凡 AI 生成都要有轻提示）；LLM 未配置仍静默——后台生成不弹配置引导
 *  （原定时任务口径，格言库 specs §3.3） */
async function runStartupMottos(): Promise<void> {
  try {
    const ran = todayRunCount()
    if (ran >= MOTTO_RUNS_PER_DAY) {
      logInfo('scheduler', `[scheduler] 今日格言启动生成已达 ${ran} 次上限，跳过`)
      return
    }
    const r = await generateMottos()
    setSetting(SettingsKeys.MottoRunMark, `${localDayKey(new Date())}|${ran + 1}`)
    logInfo('scheduler', `[scheduler] 启动格言生成完成 ${new Date().toISOString()}`)
    notifyToast(`本次启动格言已生成：入库 ${r.inserted} 条（生成 ${r.generated}），已放草稿区`)
  } catch (e) {
    const msg = (e as Error).message
    logWarn('scheduler', `[scheduler] 启动格言生成失败：${msg}`)
    if (isLlmConfigured()) notifyToast(`启动格言生成失败：${msg.slice(0, 80)}`)
  }
}

/** 排程回收站零点清理（回收站 specs §4） */
export function scheduleMidnightCleanup(): void {
  if (midnightTimer) clearTimeout(midnightTimer)
  midnightTimer = setTimeout(() => {
    try {
      const n = cleanupExpired()
      if (n > 0) logInfo('scheduler', `[scheduler] 回收站零点清理 ${n} 条`)
      const a = cleanupOldArticles()
      if (a > 0) logInfo('scheduler', `[scheduler] 信息源 30 天已读文章清理 ${a} 条`)
      const l = cleanupOldLogs()
      if (l > 0) logInfo('scheduler', `[scheduler] 零点清理 7 天外日志 ${l} 条`)
    } catch (e) {
      logWarn('scheduler', `[scheduler] 回收站清理失败：${(e as Error).message}`)
    }
    // 万象库每日待学习批次（260910）：App 跨天常驻时零点也生成（内部幂等 + 静默失败）
    void ensureDailyLearn()
    // 学习库（260924 面经题库化）：零点定档面经每日要求 + 顺带触发知识树备学池泵（均幂等静默）
    ensureInterviewDaily()
    void ensureLearnStock()
    // 赋诗苑每日一令（260925）：零点定档关键字（零 LLM 幂等，打卡不依赖任何生成）
    ensureFushiDaily()
    // 我是谁每日问题（260921）：App 跨天常驻时零点也生成（内部幂等 + 静默失败）
    void ensureWhoamiDaily()
    scheduleMidnightCleanup()
  }, msUntilMidnight())
  midnightTimer.unref?.()
}

/** main.ts 调用：启动时一次清理 + 格言启动生成 + 零点排程 */
export function startSchedulers(): void {
  try {
    const n = cleanupExpired()
    if (n > 0) logInfo('scheduler', `[scheduler] 启动清理回收站 ${n} 条`)
    const a = cleanupOldArticles()
    if (a > 0) logInfo('scheduler', `[scheduler] 启动清理信息源 30 天已读文章 ${a} 条`)
    const l = cleanupOldLogs()
    if (l > 0) logInfo('scheduler', `[scheduler] 启动清理 7 天外日志 ${l} 条`)
  } catch (e) {
    logWarn('scheduler', `[scheduler] 启动清理失败：${(e as Error).message}`)
  }
  void runStartupMottos()
  scheduleMidnightCleanup()
}
