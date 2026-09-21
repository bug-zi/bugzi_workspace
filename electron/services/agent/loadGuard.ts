// 负载卫兵（超级工作台 2.0 总纲 §4.2）：5s 采样 CPU/内存；高负荷暂停后台任务派发，
// 迟滞防抖恢复（>暂停阈值连续 3 窗停、<恢复阈值连续 6 窗续）。状态迁移写任务台账可追溯。
import os from 'node:os'
import { getDb, nowIso } from '../../db/db'
import { getSetting } from '../../db/settings'
import { SettingsKeys } from '../../../src/shared/types'

const SAMPLE_MS = 5000
const PAUSE_WINDOWS = 3
const RESUME_WINDOWS = 6

export interface LoadSample {
  cpu: number
  memFreeBytes: number
  memTotalBytes: number
}

let timer: NodeJS.Timeout | null = null
let prevCpus: os.CpuInfo[] | null = null
let last: LoadSample = { cpu: 0, memFreeBytes: 0, memTotalBytes: 0 }
let paused = false
let pauseReason: string | null = null
let highStreak = 0
let lowStreak = 0
let notify: (() => void) | null = null

/** engine.ts 注入：状态迁移通知（触发 agent:status 广播） */
export function onLoadChange(cb: () => void): void {
  notify = cb
}

function thresholds(): { pause: number; resume: number } {
  const pause = Number(getSetting(SettingsKeys.AgentCpuPause) ?? 80)
  const resume = Number(getSetting(SettingsKeys.AgentCpuResume) ?? 50)
  return {
    pause: Number.isFinite(pause) && pause > 0 ? pause : 80,
    resume: Number.isFinite(resume) && resume > 0 ? resume : 50
  }
}

/** 两帧差分算全核平均占用；首帧只存基线（返回 NaN，上层沿用上次值） */
function sampleCpu(): number {
  const cur = os.cpus()
  if (!prevCpus) {
    prevCpus = cur
    return Number.NaN
  }
  let idle = 0
  let total = 0
  for (let i = 0; i < cur.length; i++) {
    const c = cur[i]
    const p = prevCpus[i] ?? c
    idle += c.times.idle - p.times.idle
    total +=
      c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq -
      (p.times.user + p.times.nice + p.times.sys + p.times.idle + p.times.irq)
  }
  prevCpus = cur
  if (total <= 0) return Number.NaN
  return Math.min(100, Math.max(0, (1 - idle / total) * 100))
}

/** 台账留痕（load_pause/load_resume，暂停原因可追溯）；失败不影响卫兵 */
function recordGuardEvent(taskType: string, note: string): void {
  try {
    const now = nowIso()
    getDb()
      .prepare(
        "INSERT INTO task_runs (task_type, trigger, status, started_at, finished_at, error, created_at) VALUES (?, 'auto', 'done', ?, ?, ?, ?)"
      )
      .run(taskType, now, now, note, now)
  } catch {
    /* 静默 */
  }
}

function tick(): void {
  const cpu = sampleCpu()
  if (!Number.isNaN(cpu)) last = { ...last, cpu }
  last = { ...last, memFreeBytes: os.freemem(), memTotalBytes: os.totalmem() }
  const { pause, resume } = thresholds()
  if (!paused) {
    if (!Number.isNaN(cpu) && cpu > pause) {
      highStreak++
      lowStreak = 0
    } else {
      highStreak = 0
    }
    if (highStreak >= PAUSE_WINDOWS) {
      paused = true
      pauseReason = `CPU 占用过高（${Math.round(last.cpu)}%），已暂停后台任务`
      highStreak = 0
      lowStreak = 0
      recordGuardEvent('load_pause', pauseReason)
      notify?.()
    }
  } else {
    if (!Number.isNaN(cpu) && cpu < resume) {
      lowStreak++
      highStreak = 0
    } else {
      lowStreak = 0
    }
    if (lowStreak >= RESUME_WINDOWS) {
      paused = false
      pauseReason = null
      lowStreak = 0
      recordGuardEvent('load_resume', '负载恢复，后台任务继续')
      notify?.()
    }
  }
}

export function startLoadGuard(): void {
  if (timer) return
  prevCpus = null
  timer = setInterval(tick, SAMPLE_MS)
  timer.unref?.()
  tick()
}

export function stopLoadGuard(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  prevCpus = null
  paused = false
  pauseReason = null
  highStreak = 0
  lowStreak = 0
}

export function isPaused(): boolean {
  return paused
}

export function pauseReasonText(): string | null {
  return pauseReason
}

export function lastSample(): LoadSample {
  return last
}
