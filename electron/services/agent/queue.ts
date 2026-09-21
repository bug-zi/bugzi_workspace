// 任务队列（超级工作台 2.0 总纲 §4.1）：task_runs 持久台账 + 内存执行池。
// 单飞行（同类型并发=1）、优先级、并发上限、失败退避重试、负载暂停让路、启动恢复终态化。
import { getDb, nowIso } from '../../db/db'
import { recordTaskTokens } from './budget'

export interface TaskDecl {
  type: string
  /** 小者先派 */
  priority: number
  /** 同类型并发 = 1 */
  singleton: boolean
  maxRetries: number
}

export interface TaskContext {
  refId: number | null
  signal: AbortSignal
  addTokens(n: number): void
  /** 进度消息（任务中心批次 C 消费，v1 预留） */
  progress(msg: string): void
}

/** 队列事件（随 agent:status 推送；渲染层据此增量刷新列表/详情） */
export interface QueueEvent {
  type: string
  status: 'enqueued' | 'done' | 'failed' | 'skipped'
}

type Trigger = 'scheduled' | 'manual' | 'auto'
type Runner = (ctx: TaskContext) => Promise<void>

const MAX_CONCURRENT = 2
const RETRY_BASE_MS = 5000

interface QueuedItem {
  runId: number
  type: string
  refId: number | null
  trigger: Trigger
  attempt: number
}

const decls = new Map<string, TaskDecl>()
const runners = new Map<string, Runner>()
const queue: QueuedItem[] = []
const running = new Map<number, { type: string; controller: AbortController }>()
let dispatchPaused = false
let stopped = false
let notify: ((ev?: QueueEvent) => void) | null = null

/** engine.ts 注入：入队/终态通知（带事件，供 agent:status 负载携带） */
export function onQueueChange(cb: (ev?: QueueEvent) => void): void {
  notify = cb
}

function changed(ev?: QueueEvent): void {
  notify?.(ev)
}

export function registerTask(decl: TaskDecl, runner: Runner): void {
  decls.set(decl.type, decl)
  runners.set(decl.type, runner)
}

function insertRun(type: string, refId: number | null, trigger: Trigger): number {
  const now = nowIso()
  const r = getDb()
    .prepare(
      "INSERT INTO task_runs (task_type, trigger, status, ref_id, started_at, created_at) VALUES (?, ?, 'running', ?, ?, ?)"
    )
    .run(type, trigger, refId, now, now)
  return Number(r.lastInsertRowid)
}

function finishRun(runId: number, status: 'done' | 'failed' | 'skipped', error: string | null): void {
  getDb()
    .prepare('UPDATE task_runs SET status = ?, finished_at = ?, error = COALESCE(?, error) WHERE id = ?')
    .run(status, nowIso(), error, runId)
}

export function enqueue(
  type: string,
  opts?: { refId?: number | null; trigger?: Trigger }
): number {
  const runId = insertRun(type, opts?.refId ?? null, opts?.trigger ?? 'manual')
  queue.push({ runId, type, refId: opts?.refId ?? null, trigger: opts?.trigger ?? 'manual', attempt: 0 })
  changed({ type, status: 'enqueued' })
  pump()
  return runId
}

/** priority 升序取第一个类型不忙的待跑项（singleton 语义 = 类型在跑即让位） */
function pickNext(): QueuedItem | null {
  const busyTypes = new Set([...running.values()].map((r) => r.type))
  const order = queue
    .map((it, i) => ({ it, i, p: decls.get(it.type)?.priority ?? 100 }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
  for (const o of order) {
    if (busyTypes.has(o.it.type)) continue
    return o.it
  }
  return null
}

function pump(): void {
  while (!stopped && !dispatchPaused && running.size < MAX_CONCURRENT) {
    const item = pickNext()
    if (!item) return
    queue.splice(queue.indexOf(item), 1)
    execute(item)
  }
}

function execute(item: QueuedItem): void {
  const controller = new AbortController()
  running.set(item.runId, { type: item.type, controller })
  changed()
  const runner = runners.get(item.type)
  const decl = decls.get(item.type)
  if (!runner) {
    running.delete(item.runId)
    finishRun(item.runId, 'failed', '任务类型未注册')
    changed()
    pump()
    return
  }
  const ctx: TaskContext = {
    refId: item.refId,
    signal: controller.signal,
    addTokens: (n) => {
      try {
        recordTaskTokens(item.runId, n)
      } catch {
        /* 台账失败不炸任务 */
      }
    },
    progress: () => {}
  }
  const settle = (status: 'done' | 'failed', error: string | null): void => {
    running.delete(item.runId)
    finishRun(item.runId, status, error)
    changed({ type: item.type, status })
    pump()
  }
  runner(ctx)
    .then(() => settle('done', null))
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      if (controller.signal.aborted) {
        settle('failed', '已取消')
        return
      }
      // 重试 = 本行终态化留痕，按次新开一行；退避 2^attempt × 5s
      const attempt = item.attempt + 1
      const maxRetries = decl?.maxRetries ?? 0
      running.delete(item.runId)
      finishRun(item.runId, 'failed', msg)
      if (attempt <= maxRetries) {
        const retryId = insertRun(item.type, item.refId, item.trigger)
        const retryItem: QueuedItem = { ...item, runId: retryId, attempt }
        const t = setTimeout(() => {
          if (stopped) {
            finishRun(retryId, 'skipped', '引擎已关闭')
            return
          }
          queue.push(retryItem)
          changed({ type: item.type, status: 'enqueued' })
          pump()
        }, RETRY_BASE_MS * 2 ** (attempt - 1))
        t.unref?.()
      }
      changed({ type: item.type, status: 'failed' })
      pump()
    })
}

/** 启动恢复：遗留 running 行终态化（幂等重跑交给引擎每日巡检的当日判重） */
export function recoverOnBoot(): void {
  const r = getDb()
    .prepare("UPDATE task_runs SET status = 'failed', finished_at = ?, error = 'app_restart' WHERE status = 'running'")
    .run(nowIso())
  const changes = (r as { changes?: number }).changes ?? 0
  if (changes > 0) console.info(`[agent] 启动恢复：${changes} 条中断任务已终态化`)
}

/** 负载卫兵调用：true=暂停派新（在跑的跑完即止） */
export function setDispatchPaused(paused: boolean): void {
  dispatchPaused = paused
  changed()
  if (!paused) pump()
}

/** 引擎关闭：清空待跑队列（行置 skipped），进行中跑完 */
export function stopDispatch(): void {
  stopped = true
  const pending = queue.splice(0, queue.length)
  for (const it of pending) finishRun(it.runId, 'skipped', '引擎已关闭')
  changed()
}

export function startDispatch(): void {
  stopped = false
  pump()
}

export function runningRuns(): { runId: number; type: string }[] {
  return [...running.entries()].map(([runId, r]) => ({ runId, type: r.type }))
}

/** 取消在跑任务（任务中心批次 C 用） */
export function cancelRun(runId: number): boolean {
  const r = running.get(runId)
  if (!r) return false
  r.controller.abort()
  return true
}
