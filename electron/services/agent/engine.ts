// 引擎装配（超级工作台 2.0 总纲 §2）：应用运行中才存在的主动型后台引擎。
// startAgent 自判 agent_enabled（关闭态零副作用）；负载卫兵 + 任务队列 + 每日错峰巡检；
// 状态经 onEngineChange 单向通知 → 500ms 节流合并 → agent:status 推送。
import { BrowserWindow } from 'electron'
import { getSetting } from '../../db/settings'
import { SettingsKeys } from '../../../src/shared/types'
import type { AgentDomainRow, AgentPhase, AgentStatusSnapshot } from '../../../src/shared/types'
import {
  onLoadChange,
  startLoadGuard,
  stopLoadGuard,
  isPaused,
  pauseReasonText,
  lastSample
} from './loadGuard'
import {
  onQueueChange,
  recoverOnBoot,
  runningRuns,
  setDispatchPaused,
  startDispatch,
  stopDispatch,
  type QueueEvent
} from './queue'
import { agentTokensToday } from './budget'
import { dueDomains, markScanned } from './domains'

const STAGGER_MS = 90000
const FIRST_STAGGER_MS = 5000
const RESCAN_MS = 24 * 60 * 60 * 1000
const BROADCAST_THROTTLE_MS = 500

let started = false
let rescanTimer: NodeJS.Timeout | null = null
let broadcastTimer: NodeJS.Timeout | null = null
let collector: ((domain: AgentDomainRow) => void) | null = null
let lastQueueEvent: QueueEvent | null = null
const listeners = new Set<() => void>()

/** 批次 B 注册搜集器：巡检发现领域到期时回调（engine 不关心管道细节） */
export function registerCollector(fn: (domain: AgentDomainRow) => void): void {
  collector = fn
}

/** 渲染层/内部模块订阅引擎变化（当前仅驱动 agent:status 推送） */
export function onEngineChange(cb: () => void): void {
  listeners.add(cb)
}

function notifyChange(): void {
  for (const cb of listeners) cb()
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    try {
      BrowserWindow.getAllWindows()[0]?.webContents.send('agent:status', getStatus())
    } catch {
      /* 窗口不在 */
    }
  }, BROADCAST_THROTTLE_MS)
  broadcastTimer.unref?.()
}

/** 每日错峰巡检：到期领域按序 5s 起每 90s 一个；24h 后整体重排 */
function scheduleStagger(): void {
  const due = dueDomains()
  due.forEach((d, i) => {
    const t = setTimeout(() => {
      if (!started) return
      if (!dueDomains().some((x) => x.id === d.id)) return
      markScanned(d.id)
      try {
        collector?.(d)
      } catch (e) {
        console.warn('[agent] 巡检回调异常：', e)
      }
    }, FIRST_STAGGER_MS + i * STAGGER_MS)
    t.unref?.()
  })
  if (due.length > 0) console.info(`[agent] 今日巡检排程：${due.length} 个领域错峰执行`)
  if (rescanTimer) clearTimeout(rescanTimer)
  rescanTimer = setTimeout(() => {
    if (started) scheduleStagger()
  }, RESCAN_MS)
  rescanTimer.unref?.()
}

function startEngine(): void {
  if (started) return
  started = true
  recoverOnBoot()
  startLoadGuard()
  startDispatch()
  scheduleStagger()
  console.info('[agent] 引擎已启动')
  notifyChange()
}

function stopEngine(): void {
  if (rescanTimer) {
    clearTimeout(rescanTimer)
    rescanTimer = null
  }
  stopLoadGuard()
  stopDispatch()
  if (started) {
    started = false
    console.info('[agent] 引擎已关闭')
  }
  notifyChange()
}

/** 开关变化入口（boot 与 IPC 共用）：目标态驱动起/停 */
export function applyEnabledSwitch(on: boolean): void {
  if (on) startEngine()
  else stopEngine()
}

/** main.ts 启动调用：未启用时零副作用待命 */
export function startAgent(): void {
  // 负载迁移 → 队列停/续派发 + 广播；队列事件 → 记录最近事件 + 广播
  onLoadChange(() => {
    setDispatchPaused(isPaused())
    notifyChange()
  })
  onQueueChange((ev) => {
    if (ev) lastQueueEvent = ev
    notifyChange()
  })
  const enabled = getSetting(SettingsKeys.AgentEnabled) === '1'
  if (!enabled) {
    console.info('[agent] 引擎未启用，待命（个人档可开启）')
    return
  }
  startEngine()
}

export function isRunning(): boolean {
  return started
}

export function getStatus(): AgentStatusSnapshot {
  const running = runningRuns()
  const phase: AgentPhase = isPaused() ? 'paused' : running.length > 0 ? 'working' : 'idle'
  const s = lastSample()
  return {
    phase,
    pauseReason: pauseReasonText(),
    cpu: s.cpu,
    memFreeBytes: s.memFreeBytes,
    memTotalBytes: s.memTotalBytes,
    budgetUsedToday: agentTokensToday(),
    runningTypes: running.map((r) => r.type),
    lastEvent: lastQueueEvent
  }
}
